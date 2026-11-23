import { decodeCsv, parseCsv } from "@/lib/csv";
import { readXlsx } from "@/lib/xlsx";
import { fetchSheetCsv, parseSheetLink } from "@/lib/data-io";
import { readSheetsValues, serviceAccount } from "@/lib/google/sheets";
import { detectTab, nkTight, tabTitleFromFileName, type WorkbookTab } from "./tabs";

/**
 * 取込のもと → タブ (WorkbookTab)
 * - ファイル: タブごとの CSV (ファイル名「お客様アンケート集計表 - <タブ>.csv」) / .xlsx (全タブ)
 * - Google スプレッドシート: サービスアカウントがあれば全タブを読む (取り込むタブだけ)。なければタブごとの共有リンクの CSV (中身で見分ける)
 */

export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

/** 取り込むタブか (名前で。コメント・オペレーションは資料庫で扱うので読まない) */
export const WANTED_TAB = (title: string) => {
  const t = nkTight(title);
  return /クレーム手直し内容|口コミ|クチコミ|^KPI|集計/.test(t) && !/比較/.test(t);
};

/** .xlsx のセル (A1 形式) → 行 × 列 (KPI の分母の取込 src/lib/kpi-basis-import.ts も使う) */
export function xlsxRows(rows: Map<number, Map<string, string>>): string[][] {
  const colIndex = (col: string) => col.split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const max = Math.max(0, ...rows.keys());
  const out: string[][] = [];
  for (let r = 1; r <= max; r++) {
    const m = rows.get(r);
    const row: string[] = [];
    if (m) for (const [col, v] of m) row[colIndex(col)] = v;
    out.push(Array.from({ length: row.length }, (_, i) => row[i] ?? ""));
  }
  return out;
}

/** アップロードしたファイル → タブ */
export function tabsFromFiles(files: { name: string; bytes: Uint8Array }[]): { tabs: WorkbookTab[]; problems: string[] } {
  const tabs: WorkbookTab[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const name = f.name.normalize("NFKC");
    try {
      if (/\.(xlsx|xlsm)$/i.test(name)) {
        for (const sh of readXlsx(Buffer.from(f.bytes), { sheet: WANTED_TAB })) tabs.push({ title: sh.name.trim(), rows: xlsxRows(sh.rows), source: `${name} のシート「${sh.name.trim()}」` });
      } else if (/\.(csv|tsv|txt)$/i.test(name)) {
        const { text } = decodeCsv(f.bytes);
        const rows = /\.tsv$/i.test(name) ? text.split(/\r?\n/).map((l) => l.split("\t")) : parseCsv(text);
        tabs.push({ title: tabTitleFromFileName(name), rows, source: name });
      } else problems.push(`${name}: CSV か .xlsx のファイルを選んでください`);
    } catch (e) {
      problems.push(`${name}: 読み取れませんでした (${(e as Error).message})`);
    }
  }
  return { tabs, problems };
}

/** Google スプレッドシート → タブ。sheetUrl = スプレッドシート (サービスアカウント)、tabUrls = タブごとの共有リンク */
export async function tabsFromGoogle(sheetUrl: string | undefined, tabUrls: string[]): Promise<{ tabs: WorkbookTab[]; problems: string[]; label: string }> {
  const problems: string[] = [];
  const tabs: WorkbookTab[] = [];
  const sa = serviceAccount();
  const link = sheetUrl ? parseSheetLink(sheetUrl) : null;
  if (sheetUrl && !link) throw new Error("Google スプレッドシートの URL ではありません (https://docs.google.com/spreadsheets/d/… の形式)。");
  if (link && sa.account) {
    for (const t of await readSheetsValues(link.id, WANTED_TAB)) tabs.push({ title: t.title.trim(), rows: t.rows, source: t.label });
    if (!tabs.length) problems.push("スプレッドシートに取り込むタブ (クレーム手直し内容・Google口コミ集計・KPI・集計) が見つかりません。");
    return { tabs, problems, label: `Google スプレッドシート (${link.id.slice(0, 8)}…・${tabs.length} タブ)` };
  }
  // サービスアカウントがないとき: タブごとの共有リンク (リンクを知っている全員が閲覧できる設定)
  const urls = tabUrls.length ? tabUrls : sheetUrl ? [sheetUrl] : [];
  if (!urls.length) throw new Error("スプレッドシートの URL が設定されていません。");
  if (!sa.account && link && !tabUrls.length) problems.push(`サービスアカウントが設定されていないため、URL のタブ (gid=${link.gid ?? "0"}) だけを読みました。全タブを読むには、サービスアカウントを設定してスプレッドシートを共有するか、タブごとの共有リンクを登録してください。`);
  for (const u of urls) {
    try {
      const r = await fetchSheetCsv(u);
      const rows = parseCsv(r.text);
      const kind = detectTab("", rows);
      tabs.push({ title: kind === "claims" ? `クレーム手直し内容 (${parseSheetLink(u)?.gid ?? "?"})` : kind === "reviews" ? "Google口コミ集計" : kind === "kpi" ? "KPI" : kind === "history" ? `集計 (${parseSheetLink(u)?.gid ?? "?"})` : `タブ (${parseSheetLink(u)?.gid ?? "?"})`, rows, source: r.label });
    } catch (e) {
      problems.push(`${u.slice(0, 80)}: ${(e as Error).message}`);
    }
  }
  return { tabs, problems, label: `Google スプレッドシート (共有リンク ${urls.length} 件)` };
}
