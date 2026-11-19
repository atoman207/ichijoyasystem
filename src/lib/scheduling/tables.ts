import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

export const PLAN_TABLES = ["job_specs", "production_jobs", "resource_bookings", "schedule_holds"];

/** 予定の計画の表が本番のデータベースにあるか (読み込みは空として続く)。ない間は書き込みを断る */
export function planTablesReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => PLAN_TABLES.includes(t));
}

/** ないテーブルの説明 (あれば)。書き込みの前に呼ぶ */
export async function planTablesMissing(): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  if (!missingTables().some((t) => PLAN_TABLES.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => PLAN_TABLES.includes(t));
  return still.length ? `予定の計画のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
