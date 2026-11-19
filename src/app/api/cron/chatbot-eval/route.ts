import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb, syncDb } from "@/lib/db/store";
import { askChatbot } from "@/lib/chatbot/answer";
import { aiStatus } from "@/lib/ai/provider";
import { seedEvalCases, startEvalRun, type AskFn } from "@/lib/chatbot/eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI アシスタントの精度の定期評価 (正解付きの質問を実行して採点する。結果は「品質・費用」の画面)
 * サーバーの cron から呼ぶ (例: 毎週月曜 4:00):
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/cron/chatbot-eval
 * 裏で実行してすぐに戻る。AI の費用がかかるので、回数は週 1 回・月 1 回程度にする
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
  const ask: AskFn = async (d, user, history, question) => {
    const r = await askChatbot(d, user, history.map((h) => ({ role: h.role, content: h.content, specs: h.specs as never })), question, { evaluation: true });
    return { answer: r.answer, tools: r.tools, sources: r.sources, source: r.source, checks: r.checks, tables: r.tables };
  };
  const r = startEvalRun(db, ask, { label: "定期", by: "cron", provider: `${status.label} ${status.model ?? ""}`.trim() });
  return NextResponse.json(r, { status: r.ok ? 202 : 409 });
}
