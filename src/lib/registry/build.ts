import type { KnowledgeVisibility } from "@/lib/db/types";
import type { Section } from "./extract";
import { classificationKey, dateFromName, maxVisibility, piiSignals, piiVisibility, redactSecrets, sheetPolicy, type Classification } from "./classify";
import type { MaterialChunk, MaterialDoc } from "./materials-db";

/**
 * データ台帳: 読み取った節と分類から、資料庫の 1 件 (docs) と検索の単位 (chunks) を作る (処理の段階)
 * 外部のサービス・ファイルを使わない (画面の取込とスクリプトの両方が使う)
 */

/** 検索の単位の大きさ (文字)。AI に渡すのもこの単位 */
export const CHUNK_CHARS = 3500;
/** 1 つの資料で資料庫に入れる文字の上限 (大きな表の写し・様式の部品で資料庫がふくらまないように) */
export const DOC_MAX_CHARS = 250_000;
/** 分類の規則を変えたら上げる (読み直しの判定に使う) */
export const RULES_VERSION = "2026-11-20.2";

export interface BuildInput {
  id: string;
  origin: MaterialDoc["origin"];
  folder: string;
  folderLabel: string;
  path: string;
  name: string;
  ext: string;
  kind: string;
  bytes?: number;
  mtime?: string;
  sha1?: string;
  driveUrl?: string;
  storageKey?: string;
  /** null = 読めない形式 / [] = 文字なし */
  sections: Section[] | null;
  error?: string;
  /** シートの行数 (要約に使う) */
  sheetRows?: Record<string, number>;
  duplicateOf?: { id: string; path: string };
}

/** 長い文字を行の区切りで分ける */
export function splitText(text: string, size = CHUNK_CHARS): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    // 1 行が長すぎるときはそのまま切る
    const pieces = line.length > size ? line.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [line] : [line];
    for (const p of pieces) {
      if (cur && cur.length + p.length + 1 > size) {
        out.push(cur);
        cur = "";
      }
      cur += (cur ? "\n" : "") + p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 議事録: 日付を含む短い行 (会議の見出し) ごとに分ける */
export function splitByDateHeadings(section: Section): (Section & { recordDate?: string })[] {
  const lines = section.text.split("\n");
  const out: (Section & { recordDate?: string })[] = [];
  let cur: (Section & { recordDate?: string }) | undefined;
  let preamble = "";
  for (const line of lines) {
    const plain = line.replace(/^\|\s*/, "").trim();
    const date = !line.startsWith("|") && plain.length <= 60 ? dateFromName(plain) : undefined;
    if (date && /\d{4}[.\-/年]\d{1,2}[.\-/月]\d{1,2}|R\d{1,2}\.\d{1,2}\.\d{1,2}/.test(plain.normalize("NFKC"))) {
      if (cur) out.push(cur);
      cur = { title: plain.replace(/\s*\|.*$/, "").slice(0, 80), text: `${plain}\n`, recordDate: date };
      continue;
    }
    if (cur) cur.text += `${line}\n`;
    else preamble += `${line}\n`;
  }
  if (cur) out.push(cur);
  if (!out.length) return [section];
  const result = out.map((o) => ({ ...o, text: o.text.trim() }));
  if (preamble.trim().length > 20) result.unshift({ title: `${section.title} (はじめに)`, text: preamble.trim() });
  return result;
}

const compact = (t: string) => t.replace(/\s*\n\s*/g, " / ").slice(0, 240);

export function buildDoc(input: BuildInput, cls: Classification, now = new Date().toISOString()): { doc: Omit<MaterialDoc, "override" | "knowledgeIds">; chunks: Omit<MaterialChunk, "docId">[] } {
  const base = {
    id: input.id,
    origin: input.origin,
    folder: input.folder,
    folderLabel: input.folderLabel,
    path: input.path,
    name: input.name,
    ext: input.ext,
    kind: input.kind,
    bytes: input.bytes,
    mtime: input.mtime,
    sha1: input.sha1,
    driveUrl: input.driveUrl,
    storageKey: input.storageKey,
    ruleId: cls.ruleId,
    ruleKey: `${RULES_VERSION}|${classificationKey(cls)}`,
    action: cls.action,
    category: cls.category,
    visibility: cls.visibility,
    note: cls.note,
    importedTo: cls.importedTo,
    storeId: cls.storeId,
    recordDate: cls.recordDate,
    scannedAt: now,
  };
  const sheetNames = (input.sections ?? []).map((s) => ({ name: s.title, kept: false, rows: input.sheetRows?.[s.title] }));

  if (cls.action === "exclude") {
    return { doc: { ...base, status: "skipped", chars: 0, sections: input.sections?.length ?? 0, sheetNames, summary: undefined }, chunks: [] };
  }
  if (input.duplicateOf) {
    return {
      doc: { ...base, duplicateOf: input.duplicateOf.id, status: "ok", chars: 0, sections: input.sections?.length ?? 0, sheetNames, summary: `同じ内容のファイル: ${input.duplicateOf.path}` },
      chunks: [],
    };
  }
  if (input.sections === null || cls.action === "ledger") {
    return { doc: { ...base, status: input.error ? "error" : "empty", error: input.error, chars: 0, sections: 0, sheetNames, summary: undefined }, chunks: [] };
  }

  const chunks: Omit<MaterialChunk, "docId">[] = [];
  let total = 0;
  let seq = 0;
  const pii = { phones: 0, emails: 0, postal: 0, markers: [] as string[], reason: undefined as string | undefined, secrets: 0 };
  const baseName = input.name.replace(/\.[^.]+$/, "");
  const multi = (input.sections?.length ?? 0) > 1;

  // システムに取込済みのデータ: シートの名前と行数だけ (+ ルールなどのシート)
  if (cls.action === "structured") {
    const list = (input.sections ?? []).map((s) => `${s.title}${input.sheetRows?.[s.title] !== undefined ? ` (${input.sheetRows[s.title]} 行)` : ""}`);
    const body = [`この資料はシステムのデータに取り込み済みです: ${cls.importedTo ?? ""}`, cls.note, list.length ? `シート: ${list.slice(0, 200).join("、")}` : ""].filter(Boolean).join("\n");
    chunks.push({ id: `${input.id}:${seq}`, seq: seq++, section: "取込済みの内容", part: 1, parts: 1, visibility: cls.visibility, category: cls.category, knowledge: false, recordDate: cls.recordDate, head: `${input.name} 取込済みの内容`, body });
  }

  for (const [i, section] of (input.sections ?? []).entries()) {
    const policy = sheetPolicy(cls, section.title);
    const keep = cls.action === "structured" ? Boolean(cls.sheets?.only?.test(section.title.normalize("NFKC"))) : policy.keep;
    if (!keep || !section.text.trim()) continue;
    if (total >= DOC_MAX_CHARS) break;
    sheetNames[i].kept = true;
    const parts = cls.sheets?.splitByDate ? splitByDateHeadings(section) : [section];
    for (const raw of parts) {
      // ID・パスワード・暗証番号の値は資料庫に入れない (伏せたうえで、その節は本部以上)
      const red = redactSecrets(raw.text);
      const part = red.count ? { ...raw, text: red.text } : raw;
      pii.secrets += red.count;
      const sig = piiSignals(part.text);
      pii.phones += sig.phones;
      pii.emails += sig.emails;
      pii.postal += sig.postal;
      for (const m of sig.markers) if (!pii.markers.includes(m)) pii.markers.push(m);
      const vis = piiVisibility(sig, policy.visibility);
      if (red.count) {
        vis.visibility = maxVisibility(vis.visibility, "hq");
        vis.reason = `ID・パスワードなど ${red.count} か所を伏せ字にしました${vis.reason ? `・${vis.reason}` : ""}`;
      }
      if (vis.reason && !pii.reason) pii.reason = `${section.title}: ${vis.reason}`;
      const text = part.text.slice(0, Math.max(0, DOC_MAX_CHARS - total));
      total += text.length;
      const pieces = splitText(text);
      const sectionTitle = multi || raw !== section ? part.title : "";
      pieces.forEach((body, k) => {
        chunks.push({
          id: `${input.id}:${seq}`,
          seq: seq++,
          section: sectionTitle,
          part: k + 1,
          parts: pieces.length,
          visibility: vis.visibility,
          category: policy.category,
          knowledge: policy.knowledge && cls.action === "knowledge",
          recordDate: (raw as { recordDate?: string }).recordDate ?? cls.recordDate,
          head: `${baseName}${sectionTitle ? ` ${sectionTitle}` : ""}${pieces.length > 1 ? ` (${k + 1}/${pieces.length})` : ""}`,
          body,
        });
      });
    }
  }
  const first = chunks.find((c) => c.section !== "取込済みの内容") ?? chunks[0];
  return {
    doc: {
      ...base,
      status: chunks.length ? "ok" : input.error ? "error" : "empty",
      error: input.error,
      chars: total,
      sections: input.sections?.length ?? 0,
      sheetNames,
      pii: pii.phones || pii.emails || pii.postal || pii.markers.length || pii.secrets ? pii : undefined,
      summary: first ? compact(first.body) : undefined,
    },
    chunks,
  };
}

/** 資料の見られる人 (節の中で一番広い範囲。台帳の一覧に出す) */
export function widestVisibility(chunks: Pick<MaterialChunk, "visibility">[], fallback: KnowledgeVisibility): KnowledgeVisibility {
  if (!chunks.length) return fallback;
  const order: KnowledgeVisibility[] = ["all", "manager", "hq", "admin"];
  return order.find((v) => chunks.some((c) => c.visibility === v)) ?? fallback;
}
