import { getSessionUser } from "@/lib/auth/session";
import { canManageChatbot } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/store";
import { casesToCsv, CSV_HEADER, listEvalCases } from "@/lib/chatbot/eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 正解付きの質問を CSV で保存する (AI アシスタント →「品質・費用」→「CSV で保存」。管理者だけ)。
 * 質問がなければ書式の見本 (見出しと例の 1 行) を返す。表計算ソフトで編集して「取り込む」で戻す
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user || !canManageChatbot(user)) return new Response("forbidden", { status: 403 });
  const cases = listEvalCases();
  const body = cases.length
    ? casesToCsv(cases, getDb().stores)
    : `﻿${CSV_HEADER.join(",")}\r\n操作方法,見積書はどこで作りますか？,店舗スタッフ,合志店,見積,,,,,search_guides,/quotes,,,,見積の画面の「新規」から,使い方: 見積,はい\r\n`;
  const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ai-eval-cases-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(`AIの評価の質問-${stamp}.csv`)}`,
      "Cache-Control": "no-store",
    },
  });
}
