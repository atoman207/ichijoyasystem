import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

const FAX_TABLES = ["purchase_orders", "fax_messages", "fax_numbers"];

/**
 * 発注書・FAX のテーブルが本番のデータベースにあるか (デプロイの npm run build・npm run db:migrate で作る)。
 * ない間は書き込みを断る (読み込みは空として続く)。ないテーブルの説明を返す (あれば null)
 */
export async function faxTablesMissing(): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  if (!missingTables().some((t) => FAX_TABLES.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => FAX_TABLES.includes(t));
  return still.length ? `発注書・FAX のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
