import { createHash } from "node:crypto";
import type { Database, KnowledgeEntry, KnowledgeVisibility, User } from "@/lib/db/types";
import { KNOWLEDGE_HEAD, splitTags, type KnowledgeSheetSource } from "@/lib/knowledge";
import { initialReview, reviewSettings, todayKey } from "@/lib/knowledge-review";

/**
 * 社内資料と Google スプレッドシートの同期の計画 (一方向: シート → システム)
 * ------------------------------------------------------------
 * - シートの表 (1 行目が見出し) を 1 行ずつ確かめ、取り込む前に「追加・更新・変更なし・取り込まない」と理由を出す (確認の画面)。
 *   同期はこの計画のとおりに行う。システムからシートへは書かない (読み取り専用の権限で読む)
 * - 取り込めない行 (内容が空・同じタイトルの 2 行目以降・見られる人の値の誤り・日付の誤り) は取り込まず、
 *   その行にあたる登録済みの資料は前の内容のまま残す (消さない)
 * - シートから消えた行の資料は削除する。ただし登録済みの半分以上 (5 件以上) を消す計画は「大量の削除」として、
 *   定期の同期では止めて知らせ、画面で確かめてから実行する
 * - 見出し: タイトル (質問・項目)・内容 (回答・説明)・分類・タグ・見られる人 (公開範囲)・担当者・次回確認日 (確認期限)・日付 (会議・決定の日)。
 *   ほかの列は「見出し: 値」で内容に足す
 * - hash はシートの中身の SHA-256 (確認したあとにシートが変わっていないかを、同期のときに確かめる)
 * AI・外部サービスを使わない (テストからも読む)。シートの取得は knowledge-sync.ts
 */

export const SHEET_MAX_ROWS = 2000;
const TITLE_MAX = 200;
const BODY_MAX = 20000;
/** これ以上の割合を消す計画は「大量の削除」 */
export const MASS_DELETE_RATIO = 0.5;
export const MASS_DELETE_MIN = 5;

const HEAD = KNOWLEDGE_HEAD;

const VIS_WORDS: [RegExp, KnowledgeVisibility][] = [
  [/^(全員|すべて|全社員|all|everyone)$/i, "all"],
  [/^(店長|店長以上|店長・本部・管理者|店長本部管理者|manager)$/i, "manager"],
  [/^(本部|本部以上|本部・管理者|本部スタッフ|hq)$/i, "hq"],
  [/^(管理者|管理者のみ|社長|admin)$/i, "admin"],
];
export function parseVisibility(v: string): KnowledgeVisibility | undefined {
  const t = v.normalize("NFKC").replace(/\s+/g, "");
  return VIS_WORDS.find(([re]) => re.test(t))?.[1];
}

/** 日付の値 (2026-11-20・2026/11/20・2026年11月20日) → YYYY-MM-DD */
export function parseSheetDate(v: string): string | undefined {
  const m = v.normalize("NFKC").trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 担当者の値 (氏名・メールアドレス・メールの @ の前) → 社員 */
export function matchUser(users: Pick<User, "id" | "name" | "email" | "active">[], v: string): Pick<User, "id" | "name"> | undefined {
  const t = v.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
  if (!t) return undefined;
  const active = users.filter((u) => u.active);
  return (
    active.find((u) => u.email.toLowerCase() === t) ??
    active.find((u) => u.name.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase() === t) ??
    active.find((u) => u.email.toLowerCase().split("@")[0] === t)
  );
}

export const keyOf = (title: string) => title.normalize("NFKC").replace(/\s+/g, "").toLowerCase().slice(0, 100);
export const sheetPrefix = (sourceId: string) => `sheet:${sourceId}:`;
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");

export interface SheetDraft {
  title: string;
  body: string;
  category: string;
  tags: string[];
  visibility?: KnowledgeVisibility;
  ownerId?: string;
  reviewDue?: string;
  recordDate?: string;
}

export interface RowIssue {
  level: "error" | "warn";
  message: string;
}

export type RowAction = "add" | "update" | "unchanged" | "skip";
export const ROW_ACTION_LABEL: Record<RowAction, { label: string; tone: "good" | "info" | "neutral" | "critical" }> = {
  add: { label: "追加", tone: "good" },
  update: { label: "更新", tone: "info" },
  unchanged: { label: "変更なし", tone: "neutral" },
  skip: { label: "取り込まない", tone: "critical" },
};

export interface SheetRowPlan {
  /** シートの行番号 (1 = 見出し) */
  line: number;
  title: string;
  key: string;
  action: RowAction;
  issues: RowIssue[];
  /** 登録済みの資料 (更新・変更なし・取り込まないで残すもの) */
  entryId?: string;
  /** 変わる項目 (更新のとき) */
  changes?: string[];
  draft?: SheetDraft;
}

export interface SheetPlan {
  hash: string;
  headerFound: boolean;
  /** 読み取った見出し (役割 → 列の見出し) */
  columns: Partial<Record<keyof typeof HEAD, string>> & { extra: string[] };
  /** シート全体の誤り (あると同期しない) */
  sheetErrors: string[];
  rows: SheetRowPlan[];
  remove: { id: string; title: string }[];
  /** 取り込めない行のため前の内容のまま残す資料 */
  kept: { id: string; title: string }[];
  massDelete: boolean;
  truncated: boolean;
  counts: { add: number; update: number; unchanged: number; skip: number; remove: number; errors: number; warnings: number };
}

const FIELD_JA: Record<string, string> = { title: "タイトル", body: "内容", category: "分類", tags: "タグ", visibility: "見られる人", ownerId: "担当者", reviewDue: "次回確認日", recordDate: "日付" };

/** シートの表を、登録済みの資料と比べた同期の計画にする */
export function planSheetSync(db: Pick<Database, "knowledge" | "users">, src: Pick<KnowledgeSheetSource, "id" | "category">, csvText: string, rows: string[][], now = new Date()): SheetPlan {
  const hash = contentHash(csvText);
  const prefix = sheetPrefix(src.id);
  const existing = new Map(db.knowledge.filter((k) => k.sourceRef?.startsWith(prefix)).map((k) => [k.sourceRef!.slice(prefix.length), k]));
  const clean = rows.map((r) => r.map((c) => (c ?? "").trim()));
  const sheetErrors: string[] = [];
  const head = clean[0] ?? [];
  const idx = Object.fromEntries(Object.entries(HEAD).map(([k, re]) => [k, head.findIndex((h) => re.test(h.normalize("NFKC")))])) as Record<keyof typeof HEAD, number>;
  const headerFound = idx.title >= 0 && idx.body >= 0;
  if (!clean.some((r) => r.some(Boolean))) sheetErrors.push("シートが空です。");
  else if (!headerFound) sheetErrors.push(`1 行目に「タイトル」(または 質問・項目) と「内容」(または 回答・説明) の見出しがありません${idx.title >= 0 ? " (内容の列がありません)" : idx.body >= 0 ? " (タイトルの列がありません)" : ""}。見出しの行を入れてください。`);
  const special = new Set(Object.values(idx).filter((i) => i >= 0));
  const extra = head.map((_, i) => i).filter((i) => !special.has(i) && head[i]);
  const columns = { ...Object.fromEntries(Object.entries(idx).filter(([, i]) => i >= 0).map(([k, i]) => [k, head[i]])), extra: extra.map((i) => head[i]) } as SheetPlan["columns"];
  const out: SheetRowPlan[] = [];
  const firstLine = new Map<string, number>();
  const kept: SheetPlan["kept"] = [];
  const seen = new Set<string>();
  let truncated = false;
  const today = todayKey(now);
  if (headerFound) {
    const body = clean.slice(1);
    let n = 0;
    body.forEach((r, i) => {
      const line = i + 2;
      if (!r.some(Boolean)) return;
      if (++n > SHEET_MAX_ROWS) {
        truncated = true;
        return;
      }
      const issues: RowIssue[] = [];
      let title = r[idx.title] ?? "";
      const extras = extra.filter((c) => r[c]).map((c) => `${head[c]}: ${r[c]}`);
      let text = [r[idx.body] ?? "", ...extras].filter(Boolean).join("\n");
      if (!title && !text) return;
      if (!(r[idx.body] ?? "").trim() && !extras.length) issues.push({ level: "error", message: "内容が空です" });
      if (!title) {
        title = text.split("\n")[0].slice(0, 40);
        issues.push({ level: "warn", message: "タイトルが空のため、内容の書き出しをタイトルにします" });
      }
      if (title.length > TITLE_MAX) {
        issues.push({ level: "warn", message: `タイトルが長いため ${TITLE_MAX} 文字までにします` });
        title = title.slice(0, TITLE_MAX);
      }
      if (text.length > BODY_MAX) {
        issues.push({ level: "warn", message: `内容が長いため ${BODY_MAX.toLocaleString()} 文字までにします (${text.length.toLocaleString()} 文字)` });
        text = text.slice(0, BODY_MAX);
      }
      const key = keyOf(title);
      if (firstLine.has(key)) issues.push({ level: "error", message: `同じタイトルが ${firstLine.get(key)} 行目にあります (後の行は取り込みません。タイトルを分けてください)` });
      else firstLine.set(key, line);
      const draft: SheetDraft = { title, body: text, category: (idx.category >= 0 ? r[idx.category] : "") || src.category || "その他", tags: idx.tags >= 0 ? splitTags(r[idx.tags] ?? "") : [] };
      if (idx.category >= 0 && !(r[idx.category] ?? "")) issues.push({ level: "warn", message: `分類が空のため「${draft.category}」にします` });
      if (idx.visibility >= 0 && r[idx.visibility]) {
        const v = parseVisibility(r[idx.visibility]);
        if (v) draft.visibility = v;
        else issues.push({ level: "error", message: `見られる人「${r[idx.visibility]}」が分かりません (全員・店長以上・本部以上・管理者のみ)` });
      }
      if (idx.owner >= 0 && r[idx.owner]) {
        const u = matchUser(db.users, r[idx.owner]);
        if (u) draft.ownerId = u.id;
        else issues.push({ level: "warn", message: `担当者「${r[idx.owner]}」が社員に見つかりません (取込元の既定の担当者にします)` });
      }
      if (idx.reviewDue >= 0 && r[idx.reviewDue]) {
        const d = parseSheetDate(r[idx.reviewDue]);
        if (!d) issues.push({ level: "error", message: `次回確認日「${r[idx.reviewDue]}」を日付として読めません (例: 2026-12-01)` });
        else {
          draft.reviewDue = d;
          if (d < today) issues.push({ level: "warn", message: `次回確認日 ${d} を過ぎています (確認期限切れとして登録します)` });
        }
      }
      if (idx.recordDate >= 0 && r[idx.recordDate]) {
        const d = parseSheetDate(r[idx.recordDate]);
        if (d) draft.recordDate = d;
        else issues.push({ level: "warn", message: `日付「${r[idx.recordDate]}」を日付として読めないため、日付なしにします` });
      }
      const cur = existing.get(key);
      const hasError = issues.some((x) => x.level === "error");
      if (hasError) {
        // 取り込めない行: 登録済みならそのまま残す
        if (cur && !seen.has(key)) {
          seen.add(key);
          kept.push({ id: cur.id, title: cur.title });
        }
        out.push({ line, title, key, action: "skip", issues, entryId: cur?.id });
        return;
      }
      seen.add(key);
      if (!cur) {
        out.push({ line, title, key, action: "add", issues, draft });
        return;
      }
      const changes = diffFields(cur, draft);
      out.push({ line, title, key, action: changes.length ? "update" : "unchanged", issues, entryId: cur.id, changes: changes.map((f) => FIELD_JA[f] ?? f), draft });
    });
  }
  const valid = out.filter((r) => r.action !== "skip").length;
  if (headerFound && !valid && existing.size) sheetErrors.push("取り込める行が 1 行もありません。登録済みの資料を消さないよう、同期を止めました。");
  const remove = sheetErrors.length ? [] : [...existing.entries()].filter(([k]) => !seen.has(k)).map(([, e]) => ({ id: e.id, title: e.title }));
  const massDelete = remove.length >= MASS_DELETE_MIN && remove.length >= existing.size * MASS_DELETE_RATIO;
  const count = (a: RowAction) => out.filter((r) => r.action === a).length;
  return {
    hash,
    headerFound,
    columns,
    sheetErrors,
    rows: out,
    remove,
    kept,
    massDelete,
    truncated,
    counts: {
      add: count("add"),
      update: count("update"),
      unchanged: count("unchanged"),
      skip: count("skip"),
      remove: remove.length,
      errors: out.filter((r) => r.issues.some((i) => i.level === "error")).length,
      warnings: out.filter((r) => r.issues.some((i) => i.level === "warn")).length,
    },
  };
}

/** シートの値と登録済みの資料の違い (見られる人・担当者・次回確認日はシートに値があるときだけ比べる) */
function diffFields(cur: KnowledgeEntry, d: SheetDraft): string[] {
  const out: string[] = [];
  if (cur.title !== d.title) out.push("title");
  if (cur.body !== d.body) out.push("body");
  if (cur.category !== d.category) out.push("category");
  if (cur.tags.join(",") !== d.tags.join(",")) out.push("tags");
  if (d.visibility && (cur.visibility ?? "all") !== d.visibility) out.push("visibility");
  if (d.ownerId && cur.ownerId !== d.ownerId) out.push("ownerId");
  if (d.reviewDue && cur.reviewDue !== d.reviewDue) out.push("reviewDue");
  if ((d.recordDate ?? "") !== (cur.recordDate ?? "")) out.push("recordDate");
  return out;
}

export interface ApplyResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  skipped: number;
}

/**
 * 計画のとおりに書く (mutate の中で呼ぶ)。新しい資料の担当者・見られる人・間隔は シートの値 → 取込元の既定 → 確認のルールの既定。
 * 登録済みの資料の「AI に使う」・確かめた記録はシステム側の値を残す (シートで変えるのは内容と、シートに列のある項目だけ)
 */
export function applySheetPlan(db: Pick<Database, "knowledge" | "settings">, src: Pick<KnowledgeSheetSource, "id" | "ownerId" | "visibility" | "reviewIntervalDays">, plan: SheetPlan, userId: string, newId: () => string, now = new Date()): ApplyResult {
  const prefix = sheetPrefix(src.id);
  const iso = now.toISOString();
  const s = reviewSettings(db);
  let added = 0;
  let updated = 0;
  for (const r of plan.rows) {
    if (!r.draft || (r.action !== "add" && r.action !== "update")) continue;
    const d = r.draft;
    if (r.action === "add") {
      const review = initialReview(s, d.category, { ownerId: d.ownerId ?? src.ownerId, intervalDays: src.reviewIntervalDays, now });
      db.knowledge.push({
        id: newId(),
        title: d.title,
        body: d.body,
        category: d.category,
        tags: d.tags,
        source: "sheet",
        sourceRef: `${prefix}${r.key}`,
        active: true,
        createdBy: userId,
        createdAt: iso,
        updatedAt: iso,
        visibility: d.visibility ?? src.visibility ?? "all",
        recordDate: d.recordDate,
        ...review,
        ...(d.reviewDue ? { reviewDue: d.reviewDue } : {}),
      });
      added++;
      continue;
    }
    const cur = db.knowledge.find((k) => k.id === r.entryId);
    if (!cur) continue;
    Object.assign(cur, {
      title: d.title,
      body: d.body,
      category: d.category,
      tags: d.tags,
      recordDate: d.recordDate,
      ...(d.visibility ? { visibility: d.visibility } : {}),
      ...(d.ownerId ? { ownerId: d.ownerId } : {}),
      ...(d.reviewDue ? { reviewDue: d.reviewDue } : {}),
      updatedBy: userId,
      updatedAt: iso,
    });
    updated++;
  }
  if (plan.remove.length) {
    const drop = new Set(plan.remove.map((x) => x.id));
    db.knowledge = db.knowledge.filter((k) => !drop.has(k.id));
  }
  return { added, updated, removed: plan.remove.length, unchanged: plan.counts.unchanged, skipped: plan.counts.skip };
}

/** 計画の結果の短い文 */
export const planSummary = (c: SheetPlan["counts"] | ApplyResult) =>
  `追加 ${"add" in c ? c.add : c.added}・更新 ${"update" in c ? c.update : c.updated}・削除 ${"remove" in c ? c.remove : c.removed}${(("skip" in c ? c.skip : c.skipped) ?? 0) ? `・取り込まない行 ${"skip" in c ? c.skip : c.skipped}` : ""}`;
