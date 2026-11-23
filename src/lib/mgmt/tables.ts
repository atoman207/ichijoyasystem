import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

export const MGMT_TABLES = ["mgmt_rules", "item_categories", "sales_areas", "order_attributions", "sales_adjustments", "materials", "material_costs", "boms", "material_usages", "stock_moves", "material_transfers", "purchase_line_allocs", "expense_classes", "mgmt_entries", "allocation_runs", "period_closes"];

/**
 * 管理会計の表が本番のデータベースにあるか (デプロイの npm run build・npm run db:migrate で作る)。
 * ない間は書き込みを断る (読み込みは空として続く)。ないテーブルの説明を返す (あれば null)
 */
export async function mgmtTablesMissing(): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  if (!missingTables().some((t) => MGMT_TABLES.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => MGMT_TABLES.includes(t));
  return still.length ? `管理会計のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
