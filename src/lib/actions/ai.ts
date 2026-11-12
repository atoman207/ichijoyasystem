"use server";

import { getDb, mutate, addAudit } from "@/lib/db/store";
import { answer, type AssistantReply, type ChatTurn } from "@/lib/ai/assistant";
import { requireActionUser } from "./guards";

export async function askAssistant(history: ChatTurn[], question: string): Promise<AssistantReply> {
  const user = await requireActionUser();
  const q = question.trim().slice(0, 2000);
  if (!q) return { answer: "質問を入力してください。", provider: "rules" };
  const reply = await answer(getDb(), user, history, q);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "create", entity: "ai", entityId: user.id, entityLabel: "AIアシスタント", summary: `AI に質問 (${q.slice(0, 40)}${q.length > 40 ? "…" : ""})`, storeId: user.storeId });
  });
  return reply;
}
