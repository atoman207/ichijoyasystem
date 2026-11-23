import "server-only";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";

/** 施工事例の投稿・整理整頓チェックの表 (読み込みは表がなくても空として続く。書き込みの前に確かめる) */
export const POST_TABLES = ["case_posts", "tidy_checks"] as const;
export type PostTable = (typeof POST_TABLES)[number];

const NAME: Record<PostTable, string> = { case_posts: "施工事例の投稿", tidy_checks: "整理整頓チェック" };

/** 表が本番のデータベースにあるか (画面の注意書き用。ない間は書き込みを断る) */
export function postTablesReady(tables: readonly PostTable[] = POST_TABLES): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => (tables as readonly string[]).includes(t));
}

/** ないテーブルの説明 (あれば)。書き込みの前に呼ぶ */
export async function postTablesMissing(tables: readonly PostTable[]): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  const want = tables as readonly string[];
  if (!missingTables().some((t) => want.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => want.includes(t)) as PostTable[];
  return still.length ? `${still.map((t) => NAME[t]).join("・")}のテーブル (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}
