"use server";

import { getDb, mutate, addAudit } from "@/lib/db/store";
import { requireActionUser } from "./guards";

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
