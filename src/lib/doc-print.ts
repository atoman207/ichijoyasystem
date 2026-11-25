import "server-only";
import { PDFDocument } from "pdf-lib";
import type { Database, User } from "@/lib/db/types";
import { mutate, newId } from "@/lib/db/store";
import { canOutputDocument } from "@/lib/auth/permissions";
import { invoiceAccessInfo, orderAccessInfo, quoteAccessInfo } from "@/lib/case-access";
import { deliveryPdfData, invoicePdfData, quotePdfData, receiptRecordPdfData } from "@/lib/pdf/data";
import { toDateKey } from "@/lib/format";
import { renderInvoicePdf, renderQuotePdf, renderReceiptPdf } from "@/lib/pdf/render";
import { outputsOf, recordOutput, type OutputInput } from "@/lib/doc-outputs";
import type { DocOutput, DocOutputKind } from "@/lib/db/types";

/**
 * 帳票の出力 (見積書・請求書・領収書の PDF) と出力の記録 (お客様のご要望 2026-11-25「⑥」「⑦」)
 * 出力できるのは記録を見られる社員 (permissions.ts の canOutputDocument)。出力するたびに doc_outputs に 1 行 (src/lib/doc-outputs.ts)。
 * 領収書は 2 回目の出力から「再発行」と印字する。PDF の画面 (/api/pdf/*) とまとめて印刷 (/api/pdf/batch) が使う
 */

export interface PrintTarget {
  /** delivery = 納品書 (id = 受注の ID。請求書と同じ内容で表題が「納品書」) */
  kind: DocOutputKind | "delivery";
  id: string;
  /** 見積の版 */
  version?: number;
}

export type Rendered = { ok: true; bytes: Uint8Array; fileName: string; input: OutputInput } | { ok: false; status: number; error: string };

/** 次の出力が何回目になるか (同じ人の 3 分以内の出力は同じ回。recordOutput と同じ決め方) */
function nextReissue(db: Database, user: User, kind: DocOutputKind, refId: string, version: number | undefined, via: DocOutput["via"], now: Date): number {
  const past = outputsOf(db, kind, refId, kind === "quote" ? version : undefined);
  const last = past.at(-1);
  if (last && last.userId === user.id && now.getTime() - Date.parse(last.at) < 3 * 60 * 1000 && last.via !== "batch" && via !== "batch") return last.reissue;
  return past.length;
}

/** 1 枚の帳票を作る (権限を確かめる。記録はまだ書かない) */
export async function renderTarget(db: Database, user: User, t: PrintTarget, via: DocOutput["via"], now = new Date()): Promise<Rendered> {
  if (t.kind === "quote") {
    const q = db.quotes.find((x) => x.id === t.id);
    if (!q) return { ok: false, status: 404, error: "見積が見つかりません。" };
    if (!canOutputDocument(user, quoteAccessInfo(db, user, q).access)) return { ok: false, status: 403, error: "この見積を表示する権限がありません。" };
    const data = quotePdfData(db, q, t.version);
    if (!data) return { ok: false, status: 404, error: "指定した版が見つかりません。" };
    const order = db.orders.find((o) => o.quoteId === q.id && o.status !== "cancelled");
    const bytes = await renderQuotePdf(data);
    return { ok: true, bytes, fileName: `御見積書_${q.number}${data.version > 1 ? `_第${data.version}版` : ""}.pdf`, input: { kind: "quote", refId: q.id, number: q.number, version: data.version, storeId: q.storeId, customerId: q.customerId, orderId: order?.id, via } };
  }
  if (t.kind === "delivery") {
    const o = db.orders.find((x) => x.id === t.id);
    if (!o || o.status === "cancelled") return { ok: false, status: 404, error: "受注が見つかりません。" };
    if (!canOutputDocument(user, orderAccessInfo(db, user, o).access)) return { ok: false, status: 403, error: "この受注の納品書を表示する権限がありません。" };
    const bytes = await renderInvoicePdf(deliveryPdfData(db, o, toDateKey(now)));
    return { ok: true, bytes, fileName: `納品書_${o.number}.pdf`, input: { kind: "invoice", doc: "delivery", refId: o.id, number: o.number, storeId: o.storeId, customerId: o.customerId, orderId: o.id, via } };
  }
  if (t.kind === "invoice") {
    const inv = db.invoices.find((x) => x.id === t.id);
    if (!inv) return { ok: false, status: 404, error: "請求書が見つかりません。" };
    if (!canOutputDocument(user, invoiceAccessInfo(db, user, inv).access)) return { ok: false, status: 403, error: "この請求書を表示する権限がありません。" };
    const bytes = await renderInvoicePdf(invoicePdfData(db, inv));
    return { ok: true, bytes, fileName: `請求書_${inv.number}.pdf`, input: { kind: "invoice", refId: inv.id, number: inv.number, storeId: inv.storeId, customerId: inv.customerId, orderId: inv.orderId, via } };
  }
  const r = (db.receipts ?? []).find((x) => x.id === t.id);
  if (!r) return { ok: false, status: 404, error: "領収書が見つかりません。" };
  const inv = db.invoices.find((x) => x.id === r.invoiceId);
  if (!inv || !canOutputDocument(user, invoiceAccessInfo(db, user, inv).access)) return { ok: false, status: 403, error: "この領収書を表示する権限がありません。" };
  if (r.status === "void") return { ok: false, status: 409, error: `この領収書 (${r.number}) は取り消し済みです${r.voidReason ? ` (理由: ${r.voidReason})` : ""}。` };
  const reissue = nextReissue(db, user, "receipt", r.id, undefined, via, now);
  const bytes = await renderReceiptPdf(receiptRecordPdfData(db, r, reissue));
  return { ok: true, bytes, fileName: `領収書_${r.number}${reissue ? `_再発行${reissue}` : ""}.pdf`, input: { kind: "receipt", refId: r.id, number: r.number, storeId: r.storeId, customerId: r.customerId, orderId: r.orderId, via } };
}

/** 出力を記録する (作った帳票の数だけ) */
export async function recordOutputs(user: User, inputs: OutputInput[]): Promise<void> {
  if (!inputs.length) return;
  const now = new Date();
  await mutate((db) => {
    for (const input of inputs) recordOutput(db, user.id, input, now, () => newId("out"));
  }).catch((err) => console.error("[doc-print] output log failed:", err));
}

/** 複数の PDF を 1 つにまとめる (まとめて印刷) */
export async function mergePdfs(list: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return out.save();
}
