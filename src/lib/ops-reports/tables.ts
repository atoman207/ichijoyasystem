import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

/** 作業日報の手入力・販促の記録の表 (読み込みは表がなくても空として続く。書き込みの前に確かめる) */
export const OPS_TABLES = ["work_report_days", "promotions"] as const;
export type OpsTable = (typeof OPS_TABLES)[number];

const NAME: Record<OpsTable, string> = { work_report_days: "作業日報の手入力", promotions: "販促の記録" };

/** 表が本番のデータベースにあるか (画面の注意書き用。ない間は書き込みを断る) */
export function opsTablesReady(tables: readonly OpsTable[] = OPS_TABLES): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => (tables as readonly string[]).includes(t));
}

/** ないテーブルの説明 (あれば)。書き込みの前に呼ぶ */
export async function opsTablesMissing(tables: readonly OpsTable[] = OPS_TABLES): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  const want = tables as readonly string[];
  if (!missingTables().some((t) => want.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => want.includes(t)) as OpsTable[];
  return still.length ? `${still.map((t) => NAME[t]).join("・")}のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
