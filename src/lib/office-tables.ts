import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

/**
 * 事務 (事務改善シート・慶弔リスト) と縁在庫 (管理会計の材料マスタ・在庫の移動) の表が本番のデータベースにあるか。
 * デプロイ (npm run build の prebuild)・npm run db:migrate で作るまでは、読み込みは空として続き、書き込みは断る
 */

export const OFFICE_TABLES = ["office_improvements", "condolences"];
export const HERI_TABLES = ["materials", "stock_moves"];

async function missingOf(tables: string[], what: string): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  if (!missingTables().some((t) => tables.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => tables.includes(t));
  return still.length ? `${what}のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}

/** 事務の表がないときの説明 (書き込みの前に呼ぶ) */
export function officeTablesMissing(): Promise<string | null> {
  return missingOf(OFFICE_TABLES, "事務 (事務改善シート・慶弔リスト) ");
}

/** 縁在庫の表 (材料マスタ・在庫の移動) がないときの説明 */
export function heriTablesMissing(): Promise<string | null> {
  return missingOf(HERI_TABLES, "縁在庫 (材料マスタ・在庫の移動) ");
}

/** 読み込みの画面で「まだ表がない」を知らせる (書き込みは断る) */
export function officeTablesReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => OFFICE_TABLES.includes(t));
}

export function heriTablesReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => HERI_TABLES.includes(t));
}
