"use server";

import { getDb, mutate, addAudit } from "@/lib/db/store";
import { requireActionUser } from "./guards";
import type { SummaryResult } from "@/lib/ai/summary-sections";

/**
 * 見積・受注・経費・顧客・問い合わせの要約 (画面の「AI で要約」)。閲覧できない記録は要約しない。
 * opts: 期間 (from・to = YYYY-MM-DD) と内容の区分 (進捗・予定・請求・やりとり など)。長い履歴は区分ごと・期間ごとに要約してから全体をまとめる
 */
export async function summarizeRecord(kind: string, id: string, opts: { from?: string; to?: string; sections?: string[] } = {}): Promise<SummaryResult> {
  const user = await requireActionUser();
  const { recordDigest, summarizeDigest } = await import("@/lib/ai/summary");
  const { SECTIONS_BY_KIND, SUMMARY_KIND_LABEL } = await import("@/lib/ai/summary-sections");
  const empty = (message: string): SummaryResult => ({ ok: false, provider: "rules", overview: "", sections: [], sources: [], text: "", scope: "", message });
  if (!(kind in SUMMARY_KIND_LABEL)) return empty("要約できない種類です。");
  const k = kind as keyof typeof SUMMARY_KIND_LABEL;
  const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const from = day(opts.from);
  const to = day(opts.to);
  if (from && to && from > to) return empty("期間の始まりが終わりより後になっています。");
  const sections = (opts.sections ?? []).filter((s): s is (typeof SECTIONS_BY_KIND)[typeof k][number] => (SECTIONS_BY_KIND[k] as string[]).includes(s));
  const d = recordDigest(getDb(), user, k, String(id), { from, to, sections });
  if (!d) return empty("記録が見つからないか、閲覧する権限がありません。");
  const r = await summarizeDigest(d);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "create", entity: "ai", entityId: user.id, entityLabel: "AIアシスタント", summary: `AI で要約 (${d.label} / ${d.scope}${r.calls ? ` / AI ${r.calls} 回` : ""})`, storeId: user.storeId });
  });
  return r;
}

/** 資料・報告文の下書き (画面の「文書を作成」)。useActionState から呼ぶ */
/** 「文書の作成」の結果。input は作ったときの入力 (「下書きとして保存」で使う) */
export type DraftActionState = { ok: boolean; text: string; provider: string; message?: string; used?: { label: string; href: string }; input?: { template: string; format: string; ref: string; notes: string } } | null;

export async function draftDocumentAction(_prev: unknown, formData: FormData): Promise<NonNullable<DraftActionState>> {
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
  return { ...r, input: { template, format, ref, notes } };
}
