/**
 * サーバー起動時の処理
 * - タイムゾーンを日本時間にそろえる。Vercel のサーバーは UTC で動き、TZ は環境変数で指定できないため、
 *   ここで設定する (日付の「今日」・月の区切り・番号の年・画面の時刻表示がサーバーの時刻に依存するため)
 * - 本番データベース (Supabase) を最初のリクエストより前に読み込んでおく
 * - VPS のデータベース (システムの全データの写し。src/lib/datastore/mirror.ts) を突き合わせ、以後の変更を書き込み続ける
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  process.env.TZ = process.env.APP_TIME_ZONE || "Asia/Tokyo";
  const { BACKEND, syncDb } = await import("./lib/db/store");
  const startMirror = async () => {
    try {
      (await import("./lib/datastore/mirror")).startMirror();
    } catch (err) {
      console.error("[mirror] start failed:", err);
    }
  };
  if (BACKEND !== "supabase") {
    if ((process.env.VERCEL === "1" || process.env.NODE_ENV === "production") && process.env.DATA_BACKEND !== "json") {
      console.error("[db] Supabase の環境変数 (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY) が未設定です。サンプルデータで動作しています。");
    }
    await startMirror();
    return;
  }
  try {
    await syncDb();
  } catch (err) {
    console.error("[db] initial load failed:", err);
  }
  // 読み込みに失敗していても始める (突き合わせの中で読み込みを待つ)
  await startMirror();
}
