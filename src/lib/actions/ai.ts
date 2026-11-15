"use server";

import { getDb, mutate, addAudit } from "@/lib/db/store";
import { answer, type AssistantReply, type ChatTurn } from "@/lib/ai/assistant";
import { requireActionUser } from "./guards";

export async function askAssistant(history: ChatTurn[], question: string): Promise<AssistantReply> {
  const user = await requireActionUser();
  const q = question.trim().slice(0, 2000);
  if (!q) return { answer: "質問を入力してください。", provider: "rules" };
  // 画面から送られた会話 (直近のみ・長さを制限)
  const turns: ChatTurn[] = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
  const reply = await answer(getDb(), user, turns, q);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "create", entity: "ai", entityId: user.id, entityLabel: "AIアシスタント", summary: `AI に質問 (${q.slice(0, 40)}${q.length > 40 ? "…" : ""})`, storeId: user.storeId });
  });
  return reply;
}
