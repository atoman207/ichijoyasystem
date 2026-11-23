import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

/** 畳製造予定の表 (読み込みは表がなくても空として続く。書き込みの前に確かめる) */
export const PRODUCTION_TABLE = "tatami_production";

/** 表が本番のデータベースにあるか (画面の注意書き用。ない間は書き込みを断る) */
export function productionTableReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().includes(PRODUCTION_TABLE);
}

/** ないときの説明 (あれば)。書き込みの前に呼ぶ */
export async function productionTableMissing(): Promise<string | null> {
  if (BACKEND !== "supabase" || !missingTables().includes(PRODUCTION_TABLE)) return null;
  const still = (await recheckMissingTables()).includes(PRODUCTION_TABLE);
  return still ? `畳製造予定のテーブル (${PRODUCTION_TABLE}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
