import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

export const HR_TABLES = ["leave_requests", "leave_grants", "holiday_works"];

/** 有給・休日出勤の表が本番のデータベースにあるか (読み込みは空として続く)。ない間は書き込みを断る */
export function hrTablesReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => HR_TABLES.includes(t));
}

/** ないテーブルの説明 (あれば)。書き込みの前に呼ぶ */
export async function hrTablesMissing(): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  if (!missingTables().some((t) => HR_TABLES.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => HR_TABLES.includes(t));
  return still.length ? `有給・休日出勤のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
