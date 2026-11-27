import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

/** 材料発注の表 (読み込みは表がなくても空として続く。書き込みの前に確かめる) */
export const MATERIAL_TABLE = "material_orders";

export function materialTableReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().includes(MATERIAL_TABLE);
}

/** ないときの説明 (あれば)。書き込みの前に呼ぶ */
export async function materialTableMissing(): Promise<string | null> {
  if (BACKEND !== "supabase" || !missingTables().includes(MATERIAL_TABLE)) return null;
  const still = (await recheckMissingTables()).includes(MATERIAL_TABLE);
  return still ? `材料発注のテーブル (${MATERIAL_TABLE}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
