import type { StoreId } from "@/lib/db/types";

/**
 * スプレッドシート「お客様アンケート集計表」のタブ (シート) の見分け方と、セルの読み方
 * ------------------------------------------------------------
 * 読み取るもの: タブごとの CSV (Google スプレッドシートの「ダウンロード → CSV」= ファイル名「お客様アンケート集計表 - <タブ>.csv」)・
 * .xlsx (全タブ)・Google スプレッドシート (サービスアカウント)。タブの名前が分からないとき (タブごとの共有リンクの CSV) は中身で見分ける。
 * 社員・お客様の名前はコードに書かない (担当者は アカウントの名前 と画面で決める対応表 で照合する。staff.ts)
 */

/** 1 枚のシート (タブ)。行 × 列の文字 */
export interface WorkbookTab {
  title: string;
  rows: string[][];
  /** どこから読んだか (ファイル名・Google スプレッドシートのシート) */
  source: string;
}

export type TabKind = "claims" | "reviews" | "kpi" | "history" | "compare" | "comments" | "operation" | "unknown";

export const TAB_KIND_LABEL: Record<TabKind, string> = {
  claims: "クレーム手直し内容 → クレーム・手直し (quality_issues)",
  reviews: "Google口コミ集計 → Google 口コミ (google_reviews)",
  kpi: "KPI → システムの集計との照合 (書き込まない)",
  history: "アンケート集計 (H26〜R4) → アンケートの過去の集計 (survey_history)",
  compare: "4年比較 → 取り込まない (過去の集計からシステムが作る)",
  comments: "コメント (お客様の声の分類) → 資料庫 (AI が検索)。データには取り込まない",
  operation: "クレーム手直し処理オペレーション → 社内資料 (定義・手順)。データには取り込まない",
  unknown: "見分けられないタブ (取り込まない)",
};

/** 文字をそろえる (全角英数 → 半角・前後の空白・連続の空白) */
export function nk(v: unknown): string {
  return String(v ?? "")
    .normalize("NFKC")
    .replace(/[ 　]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** 改行・空白をすべて除いた文字 (見出しの照合用) */
export function nkTight(v: unknown): string {
  return nk(v).replace(/\s+/g, "");
}

/** 「お客様アンケート集計表 - KPI.csv」→「KPI」(タブごとの CSV のファイル名からタブの名前) */
export function tabTitleFromFileName(name: string): string {
  const base = nk(name.split(/[\\/]/).pop() ?? name).replace(/\.(csv|tsv|txt)$/i, "");
  const m = base.match(/^.*?\s-\s(.+)$/);
  return (m ? m[1] : base).trim();
}

/** タブの種類 (名前で決め、名前が分からないときは中身で決める) */
export function detectTab(title: string, rows: string[][]): TabKind {
  const t = nkTight(title);
  if (t) {
    if (/クレーム手直し内容|クレーム・手直し内容/.test(t)) return "claims";
    if (/オペレーション/.test(t)) return "operation";
    if (/口コミ|クチコミ/.test(t)) return "reviews";
    if (/^KPI/i.test(t)) return "kpi";
    if (/比較/.test(t)) return "compare";
    if (/コメント/.test(t)) return "comments";
    if (/集計/.test(t)) return "history";
  }
  const head = rows.slice(0, 40).map((r) => r.map(nkTight));
  const has = (re: RegExp) => head.some((r) => r.some((c) => re.test(c)));
  if (has(/^クレームor手直し$|^クレーム(or|・|\/)手直し$/i)) return "claims";
  if (has(/^クレームの定義/)) return "operation";
  if (has(/ニックネーム/) && has(/^ポイント$/)) return "reviews";
  if (has(/^評価方法$/) && has(/^項目$/)) return "kpi";
  if (rows.some((r) => r.some((c) => /^アンケート集計/.test(nkTight(c))))) return "history";
  return "unknown";
}

/** シートの店舗の書き方 → 店舗 ID (事務は "office"。工場 = 合志店 (工場のある本店)) */
export function storeOfLabel(label: string): StoreId | "office" | undefined {
  const t = nkTight(label).replace(/店$/, "");
  if (/^(合志|工場)/.test(t)) return "koshi";
  if (/^中央/.test(t)) return "chuo";
  if (/^西/.test(t)) return "nishi";
  if (/^玉名/.test(t)) return "tamana";
  if (/^事務/.test(t)) return "office";
  if (/^本部/.test(t)) return "hq";
  return undefined;
}

/** 「2024年」「2024」→ 2024 */
export function parseYear(v: unknown): number | undefined {
  const m = nkTight(v).match(/^(20\d\d)年?$/);
  return m ? Number(m[1]) : undefined;
}

/** 「１月」「12月」→ 1〜12 */
export function parseMonth(v: unknown): number | undefined {
  const m = nkTight(v).match(/^(\d{1,2})月$/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 12 ? n : undefined;
}

/** 数 (「1,269」「49.2%」「-」を含む)。数でなければ undefined */
export function parseNum(v: unknown): number | undefined {
  const t = nkTight(v).replace(/,/g, "").replace(/%$/, "");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

/** 「同上」「〃」= 上の行と同じ */
export function isDitto(v: unknown): boolean {
  const t = nkTight(v);
  return t === "同上" || t === "〃" || t === "〃" || t === "''" || t === "\"";
}

export const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** YYYY-MM-DD として正しい日付か */
export function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
