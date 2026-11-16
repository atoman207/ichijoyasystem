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

/** 見積・受注・経費・顧客・問い合わせの要約 (画面の「AI で要約」)。閲覧できない記録は要約しない */
export async function summarizeRecord(kind: string, id: string): Promise<{ ok: boolean; text: string; provider: string; message?: string }> {
  const user = await requireActionUser();
  const { recordFacts, summarizeFacts, SUMMARY_KIND_LABEL } = await import("@/lib/ai/summary");
  if (!(kind in SUMMARY_KIND_LABEL)) return { ok: false, text: "", provider: "rules", message: "要約できない種類です。" };
  const f = recordFacts(getDb(), user, kind as keyof typeof SUMMARY_KIND_LABEL, String(id));
  if (!f) return { ok: false, text: "", provider: "rules", message: "記録が見つからないか、閲覧する権限がありません。" };
  const r = await summarizeFacts(f);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "create", entity: "ai", entityId: user.id, entityLabel: "AIアシスタント", summary: `AI で要約 (${f.label})`, storeId: user.storeId });
  });
  return r;
}

/** 資料・報告文の下書き (画面の「文書を作成」)。useActionState から呼ぶ */
export async function draftDocumentAction(_prev: unknown, formData: FormData): Promise<{ ok: boolean; text: string; provider: string; message?: string; used?: { label: string; href: string } }> {
  const user = await requireActionUser();
  const { DRAFT_TEMPLATES, DRAFT_FORMAT_LABEL, draftDocument } = await import("@/lib/ai/draft");
  const template = String(formData.get("template") ?? "free");
  const format = String(formData.get("format") ?? "email");
  if (!(template in DRAFT_TEMPLATES) || !(format in DRAFT_FORMAT_LABEL)) return { ok: false, text: "", provider: "rules", message: "ひな形と形式を選んでください。" };
  const ref = String(formData.get("ref") ?? "").trim().slice(0, 40);
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 3000);
  if (template === "free" && !notes) return { ok: false, text: "", provider: "rules", message: "「自由に作成」は、要点・依頼の欄に作りたい内容を書いてください。" };
  const r = await draftDocument(getDb(), user, { template: template as keyof typeof DRAFT_TEMPLATES, format: format as keyof typeof DRAFT_FORMAT_LABEL, ref: ref || undefined, notes: notes || undefined });
  if (r.ok) {
    await mutate((db) => {
      addAudit(db, { userId: user.id, action: "create", entity: "ai", entityId: user.id, entityLabel: "AIアシスタント", summary: `AI で文書を作成 (${DRAFT_TEMPLATES[template as keyof typeof DRAFT_TEMPLATES].label}${r.used ? ` / ${r.used.label}` : ""})`, storeId: user.storeId });
    });
  }
  return r;
}
