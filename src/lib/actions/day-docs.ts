"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, nowIso } from "@/lib/db/store";
import { canAccessStore, canEditCaseStore, canIssueInvoice } from "@/lib/auth/permissions";
import { isDateKey } from "@/lib/calendar";
import { liveInvoicesOfOrder } from "@/lib/billing";
import { buildOrderInvoice, canIssueFor } from "@/lib/invoice-issue";
import { makeReceipt } from "@/lib/receipt-issue";
import { activeReceipts, isReceiptMethod, receiptDraft } from "@/lib/receipts";
import { documentSettings } from "@/lib/doc-settings";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { fail, requireActionUser, safeReturn, str, withErr, withMsg } from "./guards";
import { toDateKey } from "@/lib/format";

/**
 * 予定表の「帳票をまとめて印刷」(お客様のご要望 2026-11-25「⑦」): 選んだ案件の 請求書 (なければ発行)・領収書 (なければ発行)・見積書 を
 * まとめた PDF のリンクを作る。書き込み (請求書・領収書の発行・案件ごとの領収書の設定) をしてから、/schedule/print の画面に PDF のリンク (docs) を出す。
 * PDF の出力の記録は PDF を開いたとき (/api/pdf/batch) に残す
 */
export async function prepareDayDocs(formData: FormData) {
  const user = await requireActionUser();
  const date = str(formData, "date");
  const store = str(formData, "store") || "all";
  const base = `/schedule/print?date=${encodeURIComponent(date)}&store=${encodeURIComponent(store)}`;
  if (!isDateKey(date)) redirect(withErr("/schedule/print", "日付を選んでください。"));
  const keys = formData.getAll("case").map(String);
  if (!keys.length) redirect(withErr(base, "印刷する案件を選んでください。"));
  if (BACKEND === "supabase" && missingTables().some((t) => t === "receipts" || t === "doc_outputs") && (await recheckMissingTables()).some((t) => t === "receipts" || t === "doc_outputs")) {
    redirect(withErr(base, "領収書・帳票の出力記録のテーブルがまだデータベースにありません。開発担当がデプロイ (npm run deploy) すると使えるようになります。"));
  }
  const docs: string[] = [];
  const notes: string[] = [];
  let issuedInvoices = 0;
  let issuedReceipts = 0;
  await mutate((db) => {
    const settings = documentSettings(db);
    for (const key of keys) {
      const want = (k: string) => formData.get(`${k}:${key}`) === "1";
      const quoteId = str(formData, `quoteId:${key}`);
      const orderId = str(formData, `orderId:${key}`);
      const o = orderId ? db.orders.find((x) => x.id === orderId) : undefined;
      const label = o ? `${o.number}` : key;
      // 領収書を発行する・しない (既定と違えば案件の設定として残す)
      if (o && formData.has(`rwDefault:${key}`)) {
        const wanted = want("receipt");
        const def = formData.get(`rwDefault:${key}`) === "1";
        if (wanted !== def && o.receiptWanted !== wanted && (canEditCaseStore(user, o.storeId) || canAccessStore(user, o.storeId))) {
          o.receiptWanted = wanted;
          o.updatedAt = nowIso();
          addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `領収書を${wanted ? "発行する" : "発行しない"}に設定 (帳票をまとめて印刷)`, storeId: o.storeId, changes: [{ field: "receiptWanted", before: "自動", after: wanted ? "発行する" : "発行しない" }] });
        }
      }
      if (want("quote") && quoteId) docs.push(`q:${quoteId}`);
      let inv = o ? liveInvoicesOfOrder(db.invoices, o)[0] : undefined;
      if (o && (want("invoice") || want("receipt")) && !inv) {
        const can = canIssueFor(db, o);
        if (!can.ok) notes.push(`${label}: ${can.reason}`);
        else if (!canIssueInvoice(user) || !canAccessStore(user, o.storeId)) notes.push(`${label}: 請求書の発行は店長・本部・管理者 (その店舗) が行えます`);
        else {
          const customer = db.customers.find((c) => c.id === o.customerId);
          const id = buildOrderInvoice(db, user, o, { issueDate: date, dueDays: customer?.type === "corporate" ? Math.max(settings.paymentDays, 30) : 14, sentVia: "visit", note: "帳票をまとめて印刷" });
          inv = db.invoices.find((i) => i.id === id);
          issuedInvoices += 1;
        }
      }
      if (want("invoice") && inv) docs.push(`i:${inv.id}`);
      if (want("receipt") && inv) {
        const left = receiptDraft(db, inv, o);
        if (left.remaining > 0) {
          const m = str(formData, `method:${key}`);
          const method = isReceiptMethod(m) && m !== "other" ? m : (left.parts[0]?.method ?? "cash");
          const res = makeReceipt(db, user, { invoiceId: inv.id, amount: left.remaining, parts: [{ method, amount: left.remaining }], issueDate: date, via: "帳票をまとめて印刷" });
          if (res.error) notes.push(`${label}: ${res.error}`);
          else {
            docs.push(`r:${res.receipt!.id}`);
            issuedReceipts += 1;
          }
        } else {
          // 発行済み: 再印刷 (2 回目からは「再発行」と印字)
          for (const r of activeReceipts(db, inv.id)) docs.push(`r:${r.id}`);
        }
      }
    }
  });
  revalidatePath("/schedule/print");
  const sp = new URLSearchParams({ date, store });
  if (docs.length) sp.set("docs", docs.join(","));
  const msg = docs.length ? `${docs.length} 枚の帳票をまとめました${issuedInvoices ? ` (請求書を ${issuedInvoices} 件発行)` : ""}${issuedReceipts ? ` (領収書を ${issuedReceipts} 件発行)` : ""}。「まとめて印刷 (PDF)」を押してください。` : "印刷する帳票がありません。";
  const path = `/schedule/print?${sp.toString()}`;
  if (notes.length) redirect(withErr(docs.length ? withMsg(path, msg) : path, `印刷できなかった帳票: ${notes.slice(0, 6).join(" / ")}${notes.length > 6 ? ` ほか ${notes.length - 6} 件` : ""}`));
  redirect(withMsg(path, msg));
}


/**
 * 案件の請求書を発行する (予定表の小さな画面の「帳票」。お客様のご要望 2026-11-25「⑥」)。施工完了の前でも納品・施工の日にお渡しする請求書として発行できる
 * (受注の状態は変えず、売上・売掛は施工完了から。src/lib/invoice-issue.ts)。店長・本部・管理者 (その店舗)
 */
export async function issueCaseInvoice(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/orders/${orderId}`);
  if (!canIssueInvoice(user)) redirect(withErr(back, "請求書の発行は店長・本部・管理者が行えます。"));
  let number = "";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail(back, "受注が見つかりません。");
    if (!canAccessStore(user, o.storeId)) fail(back, "その店舗の請求書は発行できません (請求書は担当店舗の社員・本部・管理者が発行します)。");
    const can = canIssueFor(db, o);
    if (!can.ok) fail(back, can.reason ?? "請求書を発行できません。");
    const settings = documentSettings(db);
    const customer = db.customers.find((c) => c.id === o.customerId);
    const id = buildOrderInvoice(db, user, o, { issueDate: toDateKey(new Date()), dueDays: customer?.type === "corporate" ? Math.max(settings.paymentDays, 30) : 14, sentVia: "visit", note: "予定表から発行" });
    number = db.invoices.find((i) => i.id === id)?.number ?? "";
  });
  revalidatePath("/invoices");
  redirect(withMsg(back, `請求書 ${number} を発行しました。「請求書 (PDF)」で印刷できます。`));
}
