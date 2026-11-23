import { createHash } from "node:crypto";
import type { Database, StoreId, SurveyResponse } from "@/lib/db/types";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { readXlsx } from "@/lib/xlsx";
import { xlsxRows } from "@/lib/survey-workbook/read";
import { nk, nkTight, parseMonth, parseNum, parseYear, storeOfLabel } from "@/lib/survey-workbook/tabs";
import { normPostcardNo } from "@/lib/survey";
import { kpiBasis, monthKey, type KpiBasis } from "./kpi-basis";
import { compareStoreIds } from "@/lib/store-order";

/**
 * KPI の分母・集計月の取込 (確認 → 取り込む)
 * ------------------------------------------------------------
 * 1. 年間チラシ計画 (Google スプレッドシート) の「個人件数売上」タブ → 店舗 × 月の個人件数 (返信率の分母)
 *    表「個人売上目標・実績（2025年度）」(年度 = 7 月〜翌 6 月) の店舗ごとの「本年度実績」の「件数」の列。空欄の月 (まだ記入していない月) は読まない
 * 2. アンケートハガキ（回答）の「フォームの回答 1」タブ → 移行したはがき (sourceRef = …#フォームの回答 1!<行>) の集計月 (「年」「月」の列)。
 *    「年」が空欄の行 (2024 年) は入力日 (タイムスタンプ) から決める (前月のはがきを月初に入力していたため、月が入力日の月より後なら前年)
 * 一方向 (シート → システム)。手入力した個人件数は取り込みで上書きしない。読み取った内容は storage.ts の imports/kpi-basis/ に一時保存する
 */

export type BasisSourceKind = "individual" | "cardMonths";

export const BASIS_SOURCE_LABEL: Record<BasisSourceKind, string> = {
  individual: "年間チラシ計画「個人件数売上」→ 個人件数",
  cardMonths: "アンケートハガキ（回答）「フォームの回答 1」→ はがきの集計月",
};

export interface IndividualValue {
  storeId: StoreId;
  month: string;
  value: number;
  /** シートの場所 (例: 個人件数売上!H53) */
  ref: string;
}

export interface CardMonthRow {
  /** シートの行 (1 から) */
  row: number;
  month: string;
  postcardNo?: string;
  /** 入力日時 (ISO。照合用) */
  at?: string;
  /** タイムスタンプも ハガキ№ もない行 (2 人目以降の担当を手で書き足した行) の内容 */
  attached?: { at?: string; salesName?: string; salesScore?: number; craftsmanName?: string; craftsmanScore?: number };
}

export interface BasisPreview {
  label: string;
  individual: IndividualValue[];
  cardMonths: CardMonthRow[];
  /** カードの行のシート名 (sourceRef の # の後ろ) */
  cardSheet?: string;
  problems: string[];
  by: string;
  at: string;
}

const colName = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/* ------------------------------------------------------------------ */
/* 年間チラシ計画「個人件数売上」                                         */
/* ------------------------------------------------------------------ */

const STORE_HEAD = /^(合志|中央|西|玉名)\s*[（(]/;

/** 「個人件数売上」のタブ → 店舗 × 月の個人件数 (本年度実績の件数) */
export function parseIndividualSheet(rows: string[][], sheetName = "個人件数売上"): { values: IndividualValue[]; problems: string[] } {
  const values: IndividualValue[] = [];
  const problems: string[] = [];
  // 年度の表の見出し「個人売上目標・実績（2025年度）」
  const blocks: { r: number; fy: number }[] = [];
  rows.forEach((row, r) => row.forEach((c) => {
    const m = nk(c).match(/個人売上目標.*実績.*?(20\d\d)\s*年度/);
    if (m) blocks.push({ r, fy: Number(m[1]) });
  }));
  if (!blocks.length) problems.push(`${sheetName}: 「個人売上目標・実績（○○年度）」の表が見つかりません`);
  blocks.forEach((b, bi) => {
    const end = bi + 1 < blocks.length ? blocks[bi + 1].r : rows.length;
    for (let r = b.r; r < end; r++) {
      rows[r]?.forEach((cell, c) => {
        const head = nk(cell).match(STORE_HEAD);
        if (!head) return;
        const storeId = storeOfLabel(head[1]) as StoreId;
        // 「本年度実績」の列 (店舗の見出しのすぐ下の行。右へ 14 列まで)
        let col = -1;
        let headRow = -1;
        for (let k = r; k <= Math.min(end - 1, r + 3) && col < 0; k++) {
          for (let j = c; j < Math.min((rows[k] ?? []).length, c + 14); j++) {
            if (/^本年度実績$/.test(nkTight(rows[k][j]))) {
              col = j;
              headRow = k;
              break;
            }
          }
        }
        if (col < 0) {
          problems.push(`${sheetName} ${b.fy}年度 ${head[1]}: 「本年度実績」の列が見つかりません`);
          return;
        }
        // 月の行 (「7月」〜「6月」。月の名前は左の列にある)。「累計」の行で終わり
        for (let k = headRow + 1; k < Math.min(end, headRow + 20); k++) {
          const row = rows[k] ?? [];
          if (row.slice(0, col).some((v) => /^累計$/.test(nkTight(v)))) break;
          let mo: number | undefined;
          for (let j = col - 1; j >= 0 && mo === undefined; j--) mo = parseMonth(row[j]);
          if (mo === undefined) continue;
          const v = parseNum(row[col]);
          if (v === undefined) continue;
          if (v < 0 || v > 5000 || !Number.isInteger(v)) {
            problems.push(`${sheetName}!${colName(col)}${k + 1}: 件数として読めない値 (${row[col]})`);
            continue;
          }
          // 年度 = 7 月〜翌 6 月 (2025年度 = 2025-07〜2026-06)
          const y = mo >= 7 ? b.fy : b.fy + 1;
          values.push({ storeId, month: `${y}-${String(mo).padStart(2, "0")}`, value: v, ref: `${sheetName}!${colName(col)}${k + 1}` });
        }
      });
    }
  });
  // 同じ店舗・月が 2 回 (年度の表の重なり) あれば後の表 (新しい年度) を使う
  const byKey = new Map<string, IndividualValue>();
  for (const v of values) byKey.set(monthKey(v.storeId, v.month), v);
  return { values: [...byKey.values()].sort((a, b) => a.month.localeCompare(b.month) || compareStoreIds(a.storeId, b.storeId)), problems };
}

/* ------------------------------------------------------------------ */
/* アンケートハガキ（回答）「フォームの回答 1」                            */
/* ------------------------------------------------------------------ */

/** タイムスタンプ (CSV の「12/9/2025 10:47:28」/ .xlsx の日付の数値) → ISO (日本時間) */
export function parseStamp(v: string): string | undefined {
  const t = nk(v);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}+09:00`).toISOString();
  const y = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (y) return new Date(`${y[1]}-${y[2].padStart(2, "0")}-${y[3].padStart(2, "0")}T${y[4].padStart(2, "0")}:${y[5]}:00+09:00`).toISOString();
  const n = Number(t);
  // .xlsx の日付 (1900 年からの日数。日本時間のまま入っている)
  if (Number.isFinite(n) && n > 40000 && n < 80000) return new Date(Math.round((n - 25569) * 86400000) - 9 * 3600000).toISOString();
  return undefined;
}

/** 「フォームの回答 1」→ 行ごとの集計月 */
export function parseCardMonthSheet(rows: string[][], sheetName = "フォームの回答 1"): { rows: CardMonthRow[]; problems: string[] } {
  const problems: string[] = [];
  const head = rows[0]?.map(nkTight) ?? [];
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const c = { ts: col(/タイムスタンプ/), month: col(/^月$/), year: col(/^年$/), store: col(/^店舗$/), salesP: col(/^営業担当者$/), sales: col(/^営業対応$/), craftP: col(/^担当職人$/), craft: col(/^職人対応$/) };
  if (c.ts < 0 || c.month < 0) return { rows: [], problems: [`${sheetName}: 見出し (タイムスタンプ・月) が見つかりません`] };
  // ハガキ№ の列 (見出しが空欄のことがある): タイムスタンプの次の列
  const noCol = head.findIndex((h) => /ハガキ/.test(h)) >= 0 ? head.findIndex((h) => /ハガキ/.test(h)) : c.ts + 1;
  const out: CardMonthRow[] = [];
  let noMonth = 0;
  let prev: { y: number; at?: string } | undefined;
  const score = (v: unknown) => {
    const n = parseNum(v);
    return n !== undefined && n >= 1 && n <= 5 ? n : undefined;
  };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || nkTight(r[c.ts]) === "タイムスタンプ") {
      prev = undefined;
      continue;
    }
    const at = parseStamp(r[c.ts] ?? "");
    const mo = parseMonth(r[c.month]);
    if (!at && mo === undefined) continue;
    if (mo === undefined) {
      noMonth++;
      continue;
    }
    let y = c.year >= 0 ? parseYear(r[c.year]) : undefined;
    if (!y && at) {
      // 年が空欄: 入力日 (日本時間) の年。月が入力日の月より後 (12 月分を 1 月に入力) なら前年
      const jst = new Date(Date.parse(at) + 9 * 3600000);
      y = jst.getUTCFullYear() - (mo > jst.getUTCMonth() + 1 ? 1 : 0);
    }
    // タイムスタンプも年もない行 (上のはがきの 2 人目以降の担当を手で書き足した行) は上の行の年
    if (!y && prev) y = prev.y;
    if (!y) continue;
    // .xlsx の数値のセルは「14144.0」と読めることがある
    const no = normPostcardNo(nk(r[noCol]).replace(/^(\d+)\.0+$/, "$1"));
    const row: CardMonthRow = { row: i + 1, month: `${y}-${String(mo).padStart(2, "0")}`, postcardNo: no || undefined, at };
    if (!at && !no) {
      // 書き足した行: 移行 (タイムスタンプのある行だけを読んだ) で漏れているため、②③ の評価の行として足せるように内容も残す
      row.attached = {
        at: prev?.at,
        salesName: c.salesP >= 0 ? nk(r[c.salesP]) || undefined : undefined,
        salesScore: c.sales >= 0 ? score(r[c.sales]) : undefined,
        craftsmanName: c.craftP >= 0 ? nk(r[c.craftP]) || undefined : undefined,
        craftsmanScore: c.craft >= 0 ? score(r[c.craft]) : undefined,
      };
    }
    out.push(row);
    prev = { y, at: at ?? prev?.at };
  }
  if (noMonth) problems.push(`${sheetName}: 「月」が空欄の行が ${noMonth} 行あります (集計月を決められないため、入力日の月のままにします)`);
  return { rows: out, problems };
}

/* ------------------------------------------------------------------ */
/* ファイル・シート → 読み取り                                            */
/* ------------------------------------------------------------------ */

export const MAX_BASIS_BYTES = 4 * 1024 * 1024;

/** 中身で見分ける */
export function detectBasisSheet(rows: string[][]): BasisSourceKind | null {
  const top = rows.slice(0, 80);
  if (top.some((r) => r.some((c) => /個人売上目標.*実績.*年度/.test(nk(c))))) return "individual";
  const head = (rows[0] ?? []).map(nkTight);
  if (head.some((h) => /タイムスタンプ/.test(h)) && head.includes("月") && head.includes("店舗")) return "cardMonths";
  return null;
}

/** 読み取ったシート (行 × 列) を種類ごとに集める */
export function readBasisSheets(sheets: { name: string; rows: string[][]; source: string }[]): Pick<BasisPreview, "individual" | "cardMonths" | "cardSheet" | "problems"> {
  const individual: IndividualValue[] = [];
  const cardMonths: CardMonthRow[] = [];
  const problems: string[] = [];
  let cardSheet: string | undefined;
  for (const sh of sheets) {
    const kind = detectBasisSheet(sh.rows);
    if (kind === "individual") {
      const r = parseIndividualSheet(sh.rows, sh.name || "個人件数売上");
      individual.push(...r.values);
      problems.push(...r.problems);
    } else if (kind === "cardMonths") {
      if (cardSheet) {
        problems.push(`${sh.source}: はがきの回答のシートが 2 つあります。最初のシートだけを読みます`);
        continue;
      }
      const r = parseCardMonthSheet(sh.rows, sh.name || "フォームの回答 1");
      cardMonths.push(...r.rows);
      problems.push(...r.problems);
      cardSheet = sh.name || "フォームの回答 1";
    }
  }
  if (!individual.length && !cardMonths.length) problems.push("読み取れるシートがありません (年間チラシ計画の「個人件数売上」、アンケートハガキ（回答）の「フォームの回答 1」)");
  return { individual, cardMonths, cardSheet, problems };
}

/** アップロードしたファイル (.xlsx・タブの CSV) → シート */
export function basisSheetsFromFiles(files: { name: string; bytes: Uint8Array }[]): { sheets: { name: string; rows: string[][]; source: string }[]; problems: string[] } {
  const sheets: { name: string; rows: string[][]; source: string }[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const name = f.name.normalize("NFKC");
    try {
      if (/\.(xlsx|xlsm)$/i.test(name)) {
        for (const sh of readXlsx(Buffer.from(f.bytes), { sheet: (n) => /個人件数売上|フォームの回答\s*1$/.test(n.normalize("NFKC").trim()) })) sheets.push({ name: sh.name.trim(), rows: xlsxRows(sh.rows), source: `${name} のシート「${sh.name.trim()}」` });
      } else if (/\.(csv|tsv|txt)$/i.test(name)) {
        const { text } = decodeCsv(f.bytes);
        const rows = /\.tsv$/i.test(name) ? text.split(/\r?\n/).map((l) => l.split("\t")) : parseCsv(text);
        const tab = name.replace(/\.(csv|tsv|txt)$/i, "").match(/\s-\s(.+)$/)?.[1]?.trim();
        sheets.push({ name: tab ?? "", rows, source: name });
      } else problems.push(`${name}: CSV か .xlsx のファイルを選んでください`);
    } catch (e) {
      problems.push(`${name}: 読み取れませんでした (${(e as Error).message})`);
    }
  }
  return { sheets, problems };
}

export function basisHash(p: Pick<BasisPreview, "individual" | "cardMonths">): string {
  return createHash("sha256").update(JSON.stringify([p.individual, p.cardMonths])).digest("hex").slice(0, 24);
}

/* ------------------------------------------------------------------ */
/* 計画 (確認) と取込                                                    */
/* ------------------------------------------------------------------ */

export type ValueAction = "create" | "update" | "unchanged" | "manual";

export interface IndividualPlanItem extends IndividualValue {
  action: ValueAction;
  current?: number;
}

export interface CardMonthPlan {
  /** 集計月を書く (新しく・変わる) */
  changes: { surveyId: string; row: number; from?: string; to: string; storeId: StoreId }[];
  unchanged: number;
  /** システムに同じ行のはがきがない (移行のあとに入力した行など) */
  notInSystem: number;
  /** 行の番号は合うが、はがき No.・入力日時が違う (シートの行が並べ替えられた) */
  mismatch: number;
  /** 集計月ごとの はがきの枚数 (取込後) と、入力日で数えたときの枚数 */
  byMonth: { month: string; after: number; before: number }[];
  /** 移行で漏れた 2 人目以降の担当の行 (タイムスタンプのない行)。②③ の評価の行として足す */
  adds: AttachedAdd[];
  /** 書き足した行のうち、担当者が社員のアカウントに決まらない行 (足さない) */
  unresolved: number;
}

export interface AttachedAdd {
  row: number;
  month: string;
  at?: string;
  salesName?: string;
  salesUserId?: string;
  salesScore?: number;
  craftsmanName?: string;
  craftsmanUserId?: string;
  craftsmanScore?: number;
}

export interface BasisPlan {
  individual: IndividualPlanItem[];
  cards: CardMonthPlan;
  counts: { individual: Record<ValueAction, number> };
}

type PlanDb = Pick<Database, "surveys" | "settings"> & Partial<Pick<Database, "users">>;

/** はがきの行番号 (sourceRef = …アンケートハガキ（回答）.xlsx#フォームの回答 1!<行>) */
function surveyRow(s: Pick<SurveyResponse, "sourceRef">, sheet: string): number | undefined {
  const m = s.sourceRef?.match(/アンケートハガキ.*#(.+?)!(\d+)$/);
  if (!m || m[1].normalize("NFKC").trim() !== sheet.normalize("NFKC").trim()) return undefined;
  return Number(m[2]);
}

export function planBasisImport(db: PlanDb, p: Pick<BasisPreview, "individual" | "cardMonths" | "cardSheet">, basisIn?: KpiBasis): BasisPlan {
  const basis = basisIn ?? kpiBasis(db);
  const counts: BasisPlan["counts"] = { individual: { create: 0, update: 0, unchanged: 0, manual: 0 } };
  const individual: IndividualPlanItem[] = p.individual.map((v) => {
    const cur = basis.months[monthKey(v.storeId, v.month)];
    const action: ValueAction = cur?.individual === undefined ? "create" : cur.individualSrc === "manual" ? (cur.individual === v.value ? "unchanged" : "manual") : cur.individual === v.value ? "unchanged" : "update";
    counts.individual[action]++;
    return { ...v, action, current: cur?.individual };
  });
  const cards: CardMonthPlan = { changes: [], unchanged: 0, notInSystem: 0, mismatch: 0, byMonth: [], adds: [], unresolved: 0 };
  if (p.cardMonths.length) {
    const sheet = p.cardSheet ?? "フォームの回答 1";
    const byRow = new Map<number, SurveyResponse>();
    // 担当者の名前 → 社員 (移行のときに決めた対応をそのまま使う)
    const salesBy = new Map<string, string>();
    const craftBy = new Map<string, string>();
    for (const s of db.surveys) {
      const r = surveyRow(s, sheet);
      if (r) byRow.set(r, s);
      if (s.salesName && s.salesUserId) salesBy.set(nkTight(s.salesName), s.salesUserId);
      if (s.craftsmanName && s.craftsmanUserId) craftBy.set(nkTight(s.craftsmanName), s.craftsmanUserId);
    }
    const after = new Map<string, number>();
    const before = new Map<string, number>();
    for (const row of p.cardMonths) {
      const s = byRow.get(row.row);
      if (!s) {
        const a = row.attached;
        if (a && ((a.craftsmanName && a.craftsmanScore !== undefined) || (a.salesName && a.salesScore !== undefined))) {
          const salesUserId = a.salesName ? salesBy.get(nkTight(a.salesName)) : undefined;
          const craftsmanUserId = a.craftsmanName ? craftBy.get(nkTight(a.craftsmanName)) : undefined;
          if ((a.craftsmanName && !craftsmanUserId) || (a.salesName && !salesUserId)) cards.unresolved++;
          else cards.adds.push({ row: row.row, month: row.month, at: a.at, salesName: a.salesName, salesUserId, salesScore: a.salesScore, craftsmanName: a.craftsmanName, craftsmanUserId, craftsmanScore: a.craftsmanScore });
          continue;
        }
        cards.notInSystem++;
        continue;
      }
      // 同じ行か: はがき No. が同じ、No. がなければ入力日時が 2 分以内
      const sameNo = row.postcardNo && s.postcardNo ? normPostcardNo(s.postcardNo) === row.postcardNo : undefined;
      // 移行の登録日時は日本時間をそのまま世界時として読んだもの (9 時間ずれる) があるため、どちらでも同じ行とみる
      const diff = row.at && s.receivedAt ? Math.abs(Date.parse(row.at) - Date.parse(s.receivedAt)) : NaN;
      const sameAt = Number.isNaN(diff) ? undefined : diff <= 120000 || Math.abs(diff - 9 * 3600000) <= 120000;
      if (sameNo === false || (sameNo === undefined && sameAt === false)) {
        cards.mismatch++;
        continue;
      }
      if (s.postcardNo) {
        after.set(row.month, (after.get(row.month) ?? 0) + 1);
        const m0 = (s.answeredOn ?? s.receivedAt).slice(0, 7);
        before.set(m0, (before.get(m0) ?? 0) + 1);
      }
      if (s.countMonth === row.month) {
        cards.unchanged++;
        continue;
      }
      cards.changes.push({ surveyId: s.id, row: row.row, from: s.countMonth, to: row.month, storeId: s.storeId });
    }
    cards.byMonth = [...new Set([...after.keys(), ...before.keys()])].sort().map((month) => ({ month, after: after.get(month) ?? 0, before: before.get(month) ?? 0 }));
  }
  return { individual, cards, counts };
}

export interface BasisApplyResult {
  individual: number;
  cardMonths: number;
  added: number;
  summary: string;
  changedMonths: { field: string; before: number | null; after: number }[];
}

/** 取り込む (mutate の中で呼ぶ)。計画はここで作り直す */
export function applyBasisImport(db: Pick<Database, "surveys" | "settings">, p: Pick<BasisPreview, "individual" | "cardMonths" | "cardSheet" | "label">, opts: { userId: string; now: string }): { basis: KpiBasis; result: BasisApplyResult } {
  const basis = kpiBasis(db);
  const plan = planBasisImport(db, p, basis);
  const changedMonths: BasisApplyResult["changedMonths"] = [];
  let individual = 0;
  for (const v of plan.individual) {
    if (v.action !== "create" && v.action !== "update") continue;
    const k = monthKey(v.storeId, v.month);
    const cur = basis.months[k] ?? {};
    basis.months[k] = { ...cur, individual: v.value, individualSrc: "import", updatedBy: opts.userId, updatedAt: opts.now };
    changedMonths.push({ field: `individual.${v.storeId}.${v.month}`, before: v.current ?? null, after: v.value });
    individual++;
  }
  const byId = new Map(db.surveys.map((s) => [s.id, s]));
  let cardMonths = 0;
  for (const c of plan.cards.changes) {
    const s = byId.get(c.surveyId);
    if (!s) continue;
    s.countMonth = c.to;
    s.updatedAt = opts.now;
    cardMonths++;
  }
  // 移行で漏れた 2 人目以降の担当の行 (②③ の評価だけに使う。はがきの枚数には入らない)
  const sheet = p.cardSheet ?? "フォームの回答 1";
  const prefix = db.surveys.map((s) => s.sourceRef?.match(/^(.*アンケートハガキ[^#]*)#/)?.[1]).find(Boolean) ?? "アンケートハガキ（回答）.xlsx";
  let added = 0;
  for (const a of plan.cards.adds) {
    const sourceRef = `${prefix}#${sheet}!${a.row}`;
    db.surveys.push({
      id: `sv_${createHash("sha256").update(sourceRef).digest("hex").slice(0, 12)}`,
      receivedAt: a.at ?? `${a.month}-01T00:00:00.000Z`,
      storeId: "hq",
      countMonth: a.month,
      salesName: a.salesName,
      salesUserId: a.salesUserId,
      salesScore: a.salesScore,
      craftsmanName: a.craftsmanName,
      craftsmanUserId: a.craftsmanUserId,
      craftsmanScore: a.craftsmanScore,
      sourceRef,
      source: "import",
      createdBy: opts.userId,
      createdAt: opts.now,
      updatedAt: opts.now,
    });
    added++;
  }
  const parts = [
    p.individual.length ? `個人件数 ${individual} か月分 (変更なし ${plan.counts.individual.unchanged}・手入力のため取り込まない ${plan.counts.individual.manual})` : "",
    p.cardMonths.length ? `はがきの集計月 ${cardMonths} 行 (変更なし ${plan.cards.unchanged}・システムにない行 ${plan.cards.notInSystem}・行が合わない ${plan.cards.mismatch})${added ? `・移行で漏れた 2 人目以降の担当の行を追加 ${added} 行` : ""}` : "",
  ].filter(Boolean);
  const summary = parts.join(" / ") || "変更はありませんでした";
  basis.lastImport = { at: opts.now, by: opts.userId, label: p.label, summary };
  return { basis, result: { individual, cardMonths, added, summary, changedMonths } };
}
