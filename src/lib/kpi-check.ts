import type { Database } from "@/lib/db/types";
import { putObject, readObject, removeObjects } from "@/lib/storage";
import type { BasisPreview } from "@/lib/kpi-basis-import";
import { parseKpiTab, reconcileKpi, type ReconYear } from "@/lib/survey-workbook/kpi-sheet";
import { staffMatcher } from "@/lib/survey-workbook/staff";
import { workbookSettings } from "@/lib/survey-workbook/plan";
import { detectTab, type WorkbookTab } from "@/lib/survey-workbook/tabs";

/**
 * 支給前の照合 (KPI → 分母・照合 → 支給前の照合)
 * ------------------------------------------------------------
 * スプレッドシート「お客様アンケート集計表」の KPI のタブ (手計算) を、年間インセンティブと同じ計算のシステムの値と並べる。
 * KPI のタブは最後に読んだもの (スプレッドシートの取込の「この内容で取り込む」、またはこの画面での読み込み) を
 * サーバーのディスク (storage.ts の imports/kpi-sheet/latest.json) に残して使う。書き込まない (照合だけ)
 */

const KEY = "imports/kpi-sheet/latest.json";

export interface SavedKpiSheet {
  tab: WorkbookTab;
  label: string;
  by: string;
  at: string;
}

export async function saveKpiSheet(s: SavedKpiSheet): Promise<void> {
  // ストレージは同じキーへの上書きを断るため、前のものを消してから書く
  await removeObjects([KEY]);
  await putObject(KEY, Buffer.from(JSON.stringify(s)));
}

export async function readKpiSheet(): Promise<SavedKpiSheet | null> {
  const buf = await readObject(KEY).catch(() => null);
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString("utf8")) as SavedKpiSheet;
    return v?.tab && Array.isArray(v.tab.rows) ? v : null;
  } catch {
    return null;
  }
}

/** スプレッドシートの取込 (お客様アンケート集計表) で KPI のタブを読んだときに、照合用に残す */
export async function keepKpiSheetFromTabs(tabs: WorkbookTab[], label: string, by: string, at: string): Promise<void> {
  const tab = tabs.find((t) => detectTab(t.title, t.rows) === "kpi");
  if (tab) await saveKpiSheet({ tab, label, by, at }).catch(() => undefined);
}

/* 分母の取込の確認 (読み取った内容。storage.ts の imports/kpi-basis/<hash>.json) */
export const basisPreviewKey = (hash: string) => `imports/kpi-basis/${hash}.json`;

export async function readBasisPreview(hash: string): Promise<BasisPreview | null> {
  if (!/^[0-9a-f]{24}$/.test(hash)) return null;
  const buf = await readObject(basisPreviewKey(hash)).catch(() => null);
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString("utf8")) as BasisPreview;
    return Array.isArray(v.individual) && Array.isArray(v.cardMonths) ? v : null;
  } catch {
    return null;
  }
}

/** KPI のタブ → 年度ごとの照合 (担当者の名前はスプレッドシートの取込と同じ対応表で社員にする) */
export function kpiCheck(db: Database, sheet: SavedKpiSheet): { years: ReconYear[]; problems: string[] } {
  const p = parseKpiTab(sheet.tab);
  const match = staffMatcher(db.users, workbookSettings(db).staffAliases);
  return { years: reconcileKpi(db, p.years, match), problems: p.problems };
}
