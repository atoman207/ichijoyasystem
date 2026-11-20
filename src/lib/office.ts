import type { Condolence, CondolenceCategory, Database, OfficeImprovement, User } from "@/lib/db/types";
import type { OfficeCtx } from "@/lib/auth/permissions";
import { kpiSettings } from "@/lib/kpi-settings";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { readXlsx, type XlsxSheet } from "@/lib/xlsx";
import { decodeCsv, parseCsv } from "@/lib/csv";

/**
 * 事務 (事務改善シート・慶弔リスト)
 * ------------------------------------------------------------
 * - クライアントがスプレッドシートで付けていた 2 つの表を画面で扱う (/office)。見出しは元のシートと同じ
 *   (事務改善シート: 年 | 月日 | 担当 | 項目 | 内容 | ⇒ | 原因 | 具体的改善策 / 慶弔リスト: 年月日 | 内容 | 名前 | 関係 | 金額 | 担当（参列者） | 備考)
 * - 取込は .xlsx・CSV のどちらも同じ手順: 見出しの行を探す → 行ごとに確かめる (planXxxImport) → 確定 (applyXxxImport)。
 *   確認と実行は同じ判定を使う (データ入出力 src/lib/data-io.ts の runImport と同じ考え方)。登録済みと同じ行は取り込まない
 * - 空欄の「年」「月日」は上の行を引き継ぐ (シートの書き方)。「〃」「同上」は上の行と同じ値
 * - 権限は src/lib/auth/permissions.ts (事務改善は全員が見る・事務担当/本部/管理者が登録、慶弔は事務担当/本部/管理者だけ)
 */

/** 事務の権限の判定に使う情報 (事務担当 = 設定 → KPI・インセンティブ の事務担当) */
export function officeCtx(db: Pick<Database, "settings" | "users">): OfficeCtx {
  return { clerkUserIds: kpiSettings(db).clerkUserIds };
}

export const CONDOLENCE_CATEGORY_LABEL: Record<CondolenceCategory, string> = { condolence: "弔事", celebration: "慶事", other: "その他" };

/* ================================================================== */
/* 文字・日付                                                             */
/* ================================================================== */

/** 見出し・検索の比較用 (全角半角・空白・括弧をそろえる) */
export const normKey = (s: string) => s.normalize("NFKC").replace(/[\s　()（）[\]［］「」『』・:：]/g, "").toLowerCase();
const clean = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
/** 長文の項目 (内容・原因など) は改行を残す */
const cleanText = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t　]+/g, " ").trim();
const DITTO = /^(〃+|同上|″|”)$/;

function validDate(y: number, m: number, d: number): string | undefined {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return undefined;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return new Date(`${iso}T00:00:00Z`).getUTCDate() === d ? iso : undefined;
}

/** Excel のシリアル値 (1900 年日付システム) → YYYY-MM-DD */
export function serialDate(n: number): string | undefined {
  if (!(n > 20000 && n < 80000)) return undefined;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

/**
 * 日付の文字 → YYYY-MM-DD。2024.1.15 / 2024/1/15 / 2024-01-15 / 2024年1月15日 / Excel のシリアル値、
 * 年のない 1/15・1月15日 は year を使う
 */
export function parseDay(raw: string, year?: number): string | undefined {
  const v = raw.normalize("NFKC").trim();
  if (!v) return undefined;
  if (/^\d{5}(\.\d+)?$/.test(v)) return serialDate(Number(v));
  let m = v.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = v.match(/^(\d{1,2})\s*[/.月]\s*(\d{1,2})\s*日?$/);
  if (m && year) return validDate(year, Number(m[1]), Number(m[2]));
  return undefined;
}

/** 金額の文字 (5,000円・￥16,500・50000) → 円。読めなければ undefined */
export function parseYen(raw: string): number | undefined {
  const v = raw.normalize("NFKC").replace(/[,¥\\円\s]/g, "").trim();
  if (!/^\d{1,9}$/.test(v)) return undefined;
  return Number(v);
}

/** 慶弔の区分を内容・関係から推定する (取込で区分の列がないとき) */
export function guessCondolenceCategory(text: string): CondolenceCategory {
  const t = text.normalize("NFKC");
  if (/通夜|葬|弔|法要|告別|お悔やみ|逝去|亡くな|香典|供花|四十九日|一周忌|喪/.test(t)) return "condolence";
  if (/結婚|婚礼|出産|誕生|祝|開店|開業|新築|入学|就任|竣工|落成|長寿|還暦|喜寿|米寿/.test(t)) return "celebration";
  return "other";
}

function categoryOf(raw: string): CondolenceCategory | undefined {
  const v = normKey(raw);
  if (!v) return undefined;
  if (/^(弔事|弔|condolence)$/.test(v)) return "condolence";
  if (/^(慶事|慶|celebration)$/.test(v)) return "celebration";
  if (/^(その他|other)$/.test(v)) return "other";
  return undefined;
}

/* ================================================================== */
/* 表 (.xlsx・CSV) の読み込み                                              */
/* ================================================================== */

const colIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** .xlsx のシート → 行 × 列の文字の表 (空の行は除く) */
export function sheetTable(sheet: XlsxSheet): string[][] {
  const out: string[][] = [];
  for (const [, cols] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
    const row: string[] = [];
    // Excel の整数は 410.0 のように入っていることがある (見た目どおり 410 にする)
    for (const [col, v] of cols) row[colIndex(col)] = /^-?\d+\.0+$/.test(v) ? v.replace(/\.0+$/, "") : v;
    const filled = Array.from(row, (x) => x ?? "");
    if (filled.some((x) => x.trim())) out.push(filled);
  }
  return out;
}

export interface ColumnDef {
  key: string;
  header: string;
  aliases: string[];
}

/** 見出しの行 → 項目の列の位置 (見つからない項目は -1)。見出しの名前が先、別名が後 */
export function mapColumns(header: string[], cols: ColumnDef[]): Record<string, number> {
  const idx: Record<string, number> = Object.fromEntries(cols.map((c) => [c.key, -1]));
  const used = new Set<number>();
  const norm = header.map((h) => normKey(h ?? ""));
  for (const pass of ["header", "alias"] as const) {
    for (const c of cols) {
      if (idx[c.key] >= 0) continue;
      const names = pass === "header" ? [normKey(c.header)] : c.aliases.map(normKey);
      const i = norm.findIndex((h, j) => !used.has(j) && h && names.includes(h));
      if (i >= 0) {
        idx[c.key] = i;
        used.add(i);
      }
    }
  }
  return idx;
}

/** 見出しの行を探す (先頭の 15 行のうち、必須の見出しを含み、項目が最も多く一致する行) */
export function findHeader(table: string[][], cols: ColumnDef[], required: string[]): { row: number; idx: Record<string, number> } | null {
  let best: { row: number; idx: Record<string, number>; score: number } | null = null;
  table.slice(0, 15).forEach((cells, row) => {
    const idx = mapColumns(cells, cols);
    if (required.some((k) => idx[k] < 0)) return;
    const score = Object.values(idx).filter((i) => i >= 0).length;
    if (!best || score > best.score) best = { row, idx, score };
  });
  const b = best as { row: number; idx: Record<string, number>; score: number } | null;
  return b ? { row: b.row, idx: b.idx } : null;
}

/** アップロードされたファイル (.xlsx か CSV) を表にする。.xlsx はシートごとの表を返す */
export function readUploadTables(buf: Buffer): { name: string; table: string[][] }[] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    return readXlsx(buf).map((s) => ({ name: s.name.trim(), table: sheetTable(s) }));
  }
  return [{ name: "CSV", table: parseCsv(decodeCsv(new Uint8Array(buf)).text) }];
}

/* ================================================================== */
/* 取込 (共通)                                                            */
/* ================================================================== */

export interface ImportLine {
  /** 元のファイルの行番号 (1 始まり。xlsx は空の行を除いた順) */
  row: number;
  status: "create" | "duplicate" | "error";
  label: string;
  message: string;
}

export interface OfficeImportPlan<T> {
  sheet?: string;
  rows: ImportLine[];
  records: (T & { row: number })[];
  counts: Record<ImportLine["status"], number>;
  /** 見出しが見つからないなど、取り込めない理由 */
  problem?: string;
}

function emptyPlan<T>(sheet?: string, problem?: string): OfficeImportPlan<T> {
  return { sheet, rows: [], records: [], counts: { create: 0, duplicate: 0, error: 0 }, problem };
}

function pickTable(tables: { name: string; table: string[][] }[], cols: ColumnDef[], required: string[]) {
  for (const t of tables) {
    const h = findHeader(t.table, cols, required);
    if (h) return { ...t, header: h };
  }
  return null;
}

/* ================================================================== */
/* 事務改善シート                                                          */
/* ================================================================== */

export const IMPROVEMENT_COLUMNS: ColumnDef[] = [
  { key: "year", header: "年", aliases: ["年度"] },
  { key: "date", header: "月日", aliases: ["日付", "年月日", "日"] },
  { key: "staff", header: "担当", aliases: ["担当者", "氏名", "名前"] },
  { key: "item", header: "項目", aliases: ["区分", "分類"] },
  { key: "content", header: "内容", aliases: ["ミスの内容", "事象", "起きたこと"] },
  { key: "cause", header: "原因", aliases: ["要因"] },
  { key: "measure", header: "具体的改善策", aliases: ["改善策", "対策", "改善内容", "具体的な改善策"] },
];

export type ImprovementDraft = Pick<OfficeImprovement, "year" | "date" | "staffName" | "staffId" | "item" | "content" | "cause" | "measure">;

/**
 * 担当の名前 → 社員 (氏名と同じ・姓だけ・名だけで、有効な社員の 1 人に決まるとき)。
 * 決まらないときは名前の文字だけを残す
 */
export function matchStaff(db: Pick<Database, "users">, name: string): string | undefined {
  const v = normKey(name);
  if (!v) return undefined;
  const users = (db.users ?? []).filter((u) => u.active);
  const exact = users.filter((u) => normKey(u.name) === v);
  if (exact.length === 1) return exact[0].id;
  if (v.length < 2) return undefined;
  const part = users.filter((u) => {
    const n = normKey(u.name);
    return n.startsWith(v) || n.endsWith(v);
  });
  return part.length === 1 ? part[0].id : undefined;
}

const improvementKey = (r: Pick<OfficeImprovement, "year" | "date" | "staffName" | "item" | "content">) => [r.date ?? String(r.year), normKey(r.staffName), normKey(r.item), normKey(r.content)].join("|");

/** 事務改善シートの取込の確認 (登録はしない) */
export function planImprovementImport(db: Pick<Database, "officeImprovements" | "users">, tables: { name: string; table: string[][] }[]): OfficeImportPlan<ImprovementDraft> {
  const t = pickTable(tables, IMPROVEMENT_COLUMNS, ["content"]);
  if (!t) return emptyPlan(undefined, "見出しの行 (年・月日・担当・項目・内容・原因・具体的改善策) が見つかりません。事務改善シートの .xlsx か、同じ見出しの CSV を選んでください。");
  const plan = emptyPlan<ImprovementDraft>(t.name);
  const { idx, row: headerRow } = t.header;
  const seen = new Set((db.officeImprovements ?? []).map(improvementKey));
  let year: number | undefined;
  let date: string | undefined;
  t.table.slice(headerRow + 1).forEach((cells, i) => {
    const row = headerRow + i + 2;
    const get = (k: string) => (idx[k] >= 0 ? (cells[idx[k]] ?? "") : "");
    const yRaw = clean(get("year"));
    if (yRaw) {
      const y = Number(yRaw.replace(/年$/, ""));
      if (y >= 1990 && y <= 2100) {
        if (y !== year) date = undefined;
        year = y;
      }
    }
    const dRaw = clean(get("date"));
    if (dRaw) {
      const d = parseDay(dRaw, year);
      if (d) {
        date = d;
        year = Number(d.slice(0, 4));
      } else if (/^\d/.test(dRaw)) {
        // 読めない日付は、その行だけ日付なしとして年で扱う
        date = undefined;
      }
    }
    const content = cleanText(get("content"));
    const item = clean(get("item"));
    const staffName = clean(get("staff"));
    if (!content && !item && !staffName) return;
    const label = [item, content.slice(0, 30)].filter(Boolean).join(" / ") || `${row} 行目`;
    const add = (status: ImportLine["status"], message: string) => {
      plan.rows.push({ row, status, label, message });
      plan.counts[status]++;
    };
    if (!content) return add("error", "内容が空欄です。");
    if (!year) return add("error", "年が分かりません (年の列か、年を含む日付を入れてください)。");
    const draft: ImprovementDraft = {
      year,
      date: date && Number(date.slice(0, 4)) === year ? date : undefined,
      staffName,
      staffId: matchStaff(db, staffName),
      item,
      content,
      cause: cleanText(get("cause")) || undefined,
      measure: cleanText(get("measure")) || undefined,
    };
    const key = improvementKey(draft);
    if (seen.has(key)) return add("duplicate", "同じ日付 (年)・担当・項目・内容の行が登録済みのため取り込みません。");
    seen.add(key);
    plan.records.push({ ...draft, row });
    add("create", `新規に登録します${draft.date ? "" : " (日付なし)"}。`);
  });
  return plan;
}

/** 事務改善シートの取込の実行 (mutate の中で呼ぶ)。登録した件数 */
export function applyImprovementImport(db: Database, user: User, plan: OfficeImportPlan<ImprovementDraft>, sourceLabel: string): number {
  const now = nowIso();
  for (const r of plan.records) {
    const { row, ...draft } = r;
    db.officeImprovements.push({ id: newId("oi"), ...draft, source: "import", sourceRef: `${sourceLabel} ${row} 行目`.slice(0, 160), createdBy: user.id, createdAt: now, updatedAt: now });
  }
  if (plan.records.length) {
    addAudit(db, { userId: user.id, action: "import", entity: "office_improvement", entityId: "import", entityLabel: "事務改善シート", summary: `事務改善シートを取込 (${sourceLabel}): 新規 ${plan.records.length} 件・登録済み ${plan.counts.duplicate} 件・取り込めない行 ${plan.counts.error} 件` });
  }
  return plan.records.length;
}

export interface ImprovementFilter {
  year?: number;
  staff?: string;
  item?: string;
  q?: string;
}

/** 新しい順 (日付 → 年 → 登録順) */
export function filterImprovements(rows: OfficeImprovement[], f: ImprovementFilter): OfficeImprovement[] {
  const q = f.q ? normKey(f.q) : "";
  return rows
    .filter((r) => (!f.year || r.year === f.year) && (!f.staff || r.staffName === f.staff) && (!f.item || r.item === f.item))
    .filter((r) => !q || normKey([r.staffName, r.item, r.content, r.cause ?? "", r.measure ?? ""].join(" ")).includes(q))
    .sort((a, b) => (b.date ?? `${b.year}-00-00`).localeCompare(a.date ?? `${a.year}-00-00`) || b.createdAt.localeCompare(a.createdAt));
}

export const IMPROVEMENT_CSV_HEADER = ["年", "日付", "担当", "項目", "内容", "原因", "具体的改善策"];

/** CSV の行 (見出し + 行)。同じ見出しでそのまま取り込める */
export function improvementCsvRows(rows: OfficeImprovement[]): (string | number)[][] {
  return [IMPROVEMENT_CSV_HEADER, ...rows.map((r) => [r.year, r.date ?? "", r.staffName, r.item, r.content, r.cause ?? "", r.measure ?? ""])];
}

/* ================================================================== */
/* 慶弔リスト                                                             */
/* ================================================================== */

export const CONDOLENCE_COLUMNS: ColumnDef[] = [
  { key: "date", header: "年月日", aliases: ["日付", "月日", "日"] },
  { key: "category", header: "区分", aliases: ["慶弔", "慶弔の区分"] },
  { key: "kind", header: "内容", aliases: ["種類", "用件"] },
  { key: "name", header: "名前", aliases: ["氏名", "お名前", "喪主", "相手"] },
  { key: "relation", header: "関係", aliases: ["続柄", "関係性", "ご関係"] },
  { key: "amount", header: "金額", aliases: ["香典", "金額円", "お祝い"] },
  { key: "attendee", header: "担当（参列者）", aliases: ["担当", "参列者", "担当者", "担当参列者"] },
  { key: "note", header: "備考", aliases: ["メモ", "その他"] },
];

export type CondolenceDraft = Pick<Condolence, "date" | "category" | "kind" | "name" | "relation" | "amount" | "attendee" | "note">;

const condolenceKey = (r: Pick<Condolence, "date" | "name" | "kind" | "amount">) => [r.date, normKey(r.name), normKey(r.kind), r.amount ?? ""].join("|");

/** 慶弔リストの取込の確認 (登録はしない)。見出しのない右側の列 (弔電・会場など) は備考に足す */
export function planCondolenceImport(db: Pick<Database, "condolences">, tables: { name: string; table: string[][] }[]): OfficeImportPlan<CondolenceDraft> {
  const t = pickTable(tables, CONDOLENCE_COLUMNS, ["date", "name"]);
  if (!t) return emptyPlan(undefined, "見出しの行 (年月日・内容・名前・関係・金額・担当（参列者）・備考) が見つかりません。慶弔リストの .xlsx か、同じ見出しの CSV を選んでください。");
  const plan = emptyPlan<CondolenceDraft>(t.name);
  const { idx, row: headerRow } = t.header;
  const header = t.table[headerRow] ?? [];
  const used = new Set(Object.values(idx).filter((i) => i >= 0));
  const seen = new Set((db.condolences ?? []).map(condolenceKey));
  const prev: Record<string, string> = {};
  t.table.slice(headerRow + 1).forEach((cells, i) => {
    const row = headerRow + i + 2;
    const get = (k: string) => {
      const raw = clean(idx[k] >= 0 ? cells[idx[k]] : "");
      if (DITTO.test(raw)) return prev[k] ?? "";
      return raw;
    };
    const values: Record<string, string> = Object.fromEntries(CONDOLENCE_COLUMNS.map((c) => [c.key, get(c.key)]));
    // 見出しのない列 (供花・弔電・会場など) は備考に足す
    const extra = cells.map((v, j) => (!used.has(j) && !clean(header[j]) ? clean(v) : "")).filter((v) => v && !DITTO.test(v));
    if (!Object.values(values).some(Boolean) && !extra.length) return;
    const dateRaw = values.date || prev.date || "";
    const date = parseDay(dateRaw);
    const label = [values.date, values.kind, values.name].filter(Boolean).join(" ") || `${row} 行目`;
    const add = (status: ImportLine["status"], message: string) => {
      plan.rows.push({ row, status, label, message });
      plan.counts[status]++;
    };
    for (const [k, v] of Object.entries(values)) if (v) prev[k] = v;
    if (!date) return add("error", dateRaw ? `年月日「${dateRaw}」を日付として読めません (例: 2024.1.15)。` : "年月日が空欄です。");
    if (!values.name && !values.relation) return add("error", "名前と関係が空欄です。");
    const amount = values.amount ? parseYen(values.amount) : undefined;
    const notes = [values.note, ...extra, values.amount && amount === undefined ? `金額: ${values.amount}` : ""].filter(Boolean);
    const draft: CondolenceDraft = {
      date,
      category: categoryOf(values.category) ?? guessCondolenceCategory([values.kind, values.relation, ...notes].join(" ")),
      kind: values.kind,
      name: values.name,
      relation: values.relation || undefined,
      amount,
      attendee: values.attendee || undefined,
      note: notes.join(" / ") || undefined,
    };
    const key = condolenceKey(draft);
    if (seen.has(key)) return add("duplicate", "同じ年月日・名前・内容・金額の行が登録済みのため取り込みません。");
    seen.add(key);
    plan.records.push({ ...draft, row });
    add("create", "新規に登録します。");
  });
  return plan;
}

/** 慶弔リストの取込の実行 (mutate の中で呼ぶ)。登録した件数 */
export function applyCondolenceImport(db: Database, user: User, plan: OfficeImportPlan<CondolenceDraft>, sourceLabel: string): number {
  const now = nowIso();
  for (const r of plan.records) {
    const { row, ...draft } = r;
    db.condolences.push({ id: newId("cd"), ...draft, source: "import", sourceRef: `${sourceLabel} ${row} 行目`.slice(0, 160), createdBy: user.id, createdAt: now, updatedAt: now });
  }
  if (plan.records.length) {
    addAudit(db, { userId: user.id, action: "import", entity: "condolence", entityId: "import", entityLabel: "慶弔リスト", summary: `慶弔リストを取込 (${sourceLabel}): 新規 ${plan.records.length} 件・登録済み ${plan.counts.duplicate} 件・取り込めない行 ${plan.counts.error} 件` });
  }
  return plan.records.length;
}

export interface CondolenceFilter {
  year?: number;
  category?: CondolenceCategory;
  q?: string;
}

export function filterCondolences(rows: Condolence[], f: CondolenceFilter): Condolence[] {
  const q = f.q ? normKey(f.q) : "";
  return rows
    .filter((r) => (!f.year || r.date.startsWith(String(f.year))) && (!f.category || r.category === f.category))
    .filter((r) => !q || normKey([r.kind, r.name, r.relation ?? "", r.attendee ?? "", r.note ?? ""].join(" ")).includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export const CONDOLENCE_CSV_HEADER = ["年月日", "区分", "内容", "名前", "関係", "金額", "担当（参列者）", "備考"];

export function condolenceCsvRows(rows: Condolence[]): (string | number)[][] {
  return [CONDOLENCE_CSV_HEADER, ...rows.map((r) => [r.date, CONDOLENCE_CATEGORY_LABEL[r.category], r.kind, r.name, r.relation ?? "", r.amount ?? "", r.attendee ?? "", r.note ?? ""])];
}

/** 一覧の年の選択肢 (新しい順) */
export function yearsOf(values: (number | string)[]): number[] {
  return [...new Set(values.map((v) => Number(String(v).slice(0, 4))).filter((y) => y >= 1990 && y <= 2100))].sort((a, b) => b - a);
}
