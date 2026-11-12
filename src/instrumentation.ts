/**
 * サーバー起動時の処理
 * - タイムゾーンを日本時間にそろえる。Vercel のサーバーは UTC で動き、TZ は環境変数で指定できないため、
 *   ここで設定する (日付の「今日」・月の区切り・番号の年・画面の時刻表示がサーバーの時刻に依存するため)
 * - 本番データベース (Supabase) を最初のリクエストより前に読み込んでおく
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  process.env.TZ = process.env.APP_TIME_ZONE || "Asia/Tokyo";
  const { BACKEND, syncDb } = await import("./lib/db/store");
  if (BACKEND !== "supabase") {
    if (process.env.VERCEL === "1" && process.env.DATA_BACKEND !== "json") {
      console.error("[db] Supabase の環境変数 (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY) が未設定です。サンプルデータで動作しています。");
    }
    return;
  }
  try {
    await syncDb();
  } catch (err) {
    console.error("[db] initial load failed:", err);
  }
}
