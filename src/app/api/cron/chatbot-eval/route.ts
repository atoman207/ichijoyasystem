import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb, syncDb } from "@/lib/db/store";
import { aiStatus } from "@/lib/ai/provider";
import { seedEvalCases, startEvalRun } from "@/lib/chatbot/eval";
import { evalAsk, evalRunners } from "@/lib/chatbot/eval-runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI アシスタントの精度の定期評価 (正解付きの質問を実行して採点する。結果は「品質・費用」の画面)
 * サーバーの cron から呼ぶ (例: 毎週月曜 4:00):
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/cron/chatbot-eval
 * 裏で実行してすぐに戻る。AI の費用がかかるので、回数は週 1 回・月 1 回程度にする
 * デプロイのあと (AI アシスタントに関わるファイルが変わったとき。deploy/deploy.sh) は ?trigger=deploy&rev=<版> で呼ぶ (評価の名前に版を残す)
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = aiStatus();
  if (!status.enabled) return NextResponse.json({ ok: false, error: "AI is not configured" }, { status: 503 });
  await syncDb();
  const db = getDb();
  seedEvalCases(db);
  const url = new URL(req.url);
  const deploy = url.searchParams.get("trigger") === "deploy";
  const rev = (url.searchParams.get("rev") ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 12);
  const r = startEvalRun(db, evalAsk, { label: deploy ? `デプロイのあと${rev ? ` (${rev.slice(0, 7)})` : ""}` : "定期", by: deploy ? "deploy" : "cron", provider: `${status.label} ${status.model ?? ""}`.trim(), runners: evalRunners });
  return NextResponse.json(r, { status: r.ok ? 202 : 409 });
}
