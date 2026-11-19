import { getSessionUser } from "@/lib/auth/session";
import { getDb, syncDb } from "@/lib/db/store";
import { askChatbot, type BotReply } from "@/lib/chatbot/answer";
import { cleanTurns } from "@/lib/chatbot/ask-input";
import type { AgentProgress } from "@/lib/assistant/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 「質問する」の質問 (回答を作っている途中の知らせを順に送る)
 * ------------------------------------------------------------
 * 中身は Server Action の askChatbotAction と同じ (askChatbot)。違いは、AI が道具を使うたびに
 * { type: "progress", ... } を 1 行ずつ送り、最後に { type: "done", reply } を送ること (NDJSON)。
 * 画面 (AssistantChat.tsx) はこれで「いま何を調べているか」と経過時間を出す。使えないときは Server Action に戻る。
 * ログイン前 (公開ページ) も使える (答える範囲は askChatbot が決める)。nginx が溜めずに送るよう X-Accel-Buffering: no
 */
export async function POST(req: Request) {
  let body: { history?: unknown; question?: unknown; convId?: unknown; voice?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const user = await getSessionUser();
  const db = user ? getDb() : await syncDb();
  const q = String(body.question ?? "").trim().slice(0, 1000);
  const turns = cleanTurns(body.history, Boolean(user));
  const convId = typeof body.convId === "string" ? body.convId.slice(0, 64) : undefined;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          closed = true;
        }
      };
      const t0 = Date.now();
      send({ type: "progress", event: { type: "phase", phase: "thinking", label: "質問を受け付けました" }, ms: 0 });
      let reply: BotReply;
      if (!q) reply = { answer: "質問を入力してください。", links: [], source: "none", suggestions: [] };
      else {
        try {
          reply = await askChatbot(db, user, turns, q, { convId, voice: body.voice === true, onProgress: (event: AgentProgress) => send({ type: "progress", event, ms: Date.now() - t0 }) });
        } catch (err) {
          console.error("[chatbot] failed:", err);
          reply = { answer: "ごめんなさい、いま回答を用意できませんでした。少し時間をおいてもう一度お試しください。", links: [], source: "none", suggestions: [] };
        }
      }
      send({ type: "done", reply, ms: Date.now() - t0 });
      closed = true;
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform: 圧縮で溜められないように。X-Accel-Buffering: nginx が溜めずに送るように
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
