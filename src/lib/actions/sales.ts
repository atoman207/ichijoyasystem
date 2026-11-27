"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import { canConfirmSales } from "@/lib/auth/permissions";
import { CHANNEL_LABEL } from "@/lib/constants";
import { isDateKey } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { closedReason } from "@/lib/mgmt/close";
import { liveInvoicesOfOrder, usesBatchBilling } from "@/lib/billing";
import { completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { buildOrderInvoice } from "@/lib/invoice-issue";
import { documentSettings } from "@/lib/doc-settings";
import { applyStaffAndPosting } from "@/lib/order-staff-save";
import { postingNeeded } from "@/lib/sales-ready";
import { amendMessage, amendOrderQuote, parseSalesItems, salesConfirmed } from "@/lib/sales-lines";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { choice, fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 売上確定・請求書発行 (お客様のご要望 2026-11-27「■1」。画面は /orders/<ID>/sales。予定表の小さな画面・受注の画面の帳票のボタンから)
 * ------------------------------------------------------------
 * 1 回の送信で: 施工内容 → 明細・金額 (見積の新しい版。src/lib/sales-lines.ts) → 作業の担当・ポスティング (src/lib/order-staff-save.ts) を保存し、
 * intent = confirm なら売上確定 (施工完了 = 売上計上日) と請求書の発行 (まとめ請求のお客様は締め日にまとめるので発行しない) をする。
 * intent = save は確定せずに保存 (確定のあとの修正もこれ)。確定のあとの明細・金額の修正は、一般社員は店長の承認、店長・管理者は承認なし
 * (承認されると受注・請求書 (入金前・案件ごと)・経営の集計に反映。作業の担当・ポスティングは作業日報・インセンティブに反映)
 */
export async function saveSales(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const ret = safeReturn(str(formData, "returnTo"), "");
  const page = `/orders/${orderId}/sales`;
  const back = ret ? `${page}?returnTo=${encodeURIComponent(ret)}` : page;
  // confirm = 売上確定 (と請求書の発行) / invoice = 売上確定済みで請求書がない受注の請求書の発行 / save = 確定せずに保存・確定のあとの修正
  const intentRaw = str(formData, "intent");
  const intent = intentRaw === "confirm" ? "confirm" : intentRaw === "invoice" ? "invoice" : "save";
  const approvalIds: string[] = [];
  let msg = "";
  let confirmedNow = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "受注が見つかりません。");
    if (!canConfirmSales(user, o.storeId)) fail(back, "この案件の売上確定・請求書の発行は、担当店舗の社員・本部・管理者が行えます。");
    if (o.status === "cancelled") fail(back, "キャンセルした受注は売上にできません。");
    const lock = completedCaseLock(db, user, o);
    if (lock.locked) fail(back, completedLockMessage(lock.reason));
    const wasConfirmed = salesConfirmed(o);
    if (intent === "confirm") {
      if (wasConfirmed) fail(back, "すでに売上確定済みです。直すときは内容を変えて「修正を保存」を押してください。");
      if (!["confirmed", "scheduled", "in_progress"].includes(o.status)) fail(back, o.status === "pending_approval" || o.status === "returned" ? "契約の承認のあとに売上確定できます。" : "この状態の案件は売上確定できません。");
    }
    const now = nowIso();
    const done: string[] = [];

    // 施工内容
    if (formData.has("workDetails")) {
      const next = str(formData, "workDetails").slice(0, 2000);
      const before = o.workDetails ?? "";
      if (next !== before) {
        o.workDetails = next || undefined;
        o.updatedAt = now;
        addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `施工内容を${wasConfirmed ? "修正 (売上確定のあと)" : "変更"} (売上確定・請求書発行の画面)`, storeId: o.storeId, changes: [{ field: "workDetails", before: before || null, after: next || null }] });
        done.push("施工内容");
      }
    }

    // 明細・金額 (見積から作った受注。見積の新しい版として残す)
    let pending = false;
    const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
    if (q && str(formData, "linesSent") === "1") {
      const items = parseSalesItems(db, str(formData, "items"), q, back);
      const discountRaw = str(formData, "discount").replace(/[,¥\s]/g, "");
      const discount = discountRaw ? Number(discountRaw) : q.discount;
      if (!Number.isFinite(discount) || discount < 0) fail(back, "値引きの金額を正しく入れてください。");
      const r = amendOrderQuote(db, user, o, q, { items, discount }, str(formData, "reason").slice(0, 200), back);
      if (r.state !== "same") {
        approvalIds.push(r.approvalId);
        if (r.state === "pending") pending = true;
        done.push(amendMessage(r));
      }
    }

    // 作業の担当・ポスティング (売上確定のときと、確定のあとの修正はそろっていなければ断る)
    applyStaffAndPosting(db, user, o, formData, back, { require: intent === "confirm" || wasConfirmed, confirm: true, note: "(売上確定・請求書発行の画面)" });
    // ポスティングは個人のお客様の案件だけ (お客様のご連絡 2026-11-27)
    const staffWord = postingNeeded(db, o) ? "担当者・ポスティング" : "担当者";

    if (intent === "invoice") {
      if (o.status !== "completed") fail(back, "売上確定済みで請求書のない案件の請求書を発行します。");
      if (liveInvoicesOfOrder(db.invoices, o).length) fail(back, "すでに請求書が発行されています。");
      if (pending) fail(back, "明細・金額の修正が承認待ちです。承認のあとに請求書を発行してください。");
      const customer = db.customers.find((c) => c.id === o.customerId);
      if (usesBatchBilling(customer)) fail(back, "まとめ請求のお客様です。この案件だけ請求書を発行するときは、受注の画面の「この案件だけ請求書を発行する」から発行してください。");
      const settings = documentSettings(db);
      const id = buildOrderInvoice(db, user, o, { issueDate: toDateKey(new Date()), dueDays: customer?.type === "corporate" ? Math.max(settings.paymentDays, 30) : 14, sentVia: choice(formData, "sentVia", CHANNEL_LABEL, "visit"), note: "売上確定・請求書発行の画面" });
      msg = `${done.length ? `${done.join(" ")} ` : ""}請求書 ${db.invoices.find((i) => i.id === id)?.number ?? ""} を発行しました。「請求書」から確認・印刷できます。`;
      confirmedNow = true;
      return;
    }

    if (intent === "confirm") {
      if (pending) {
        msg = `${done.join(" ")} 承認されたら、もう一度「売上確定・請求書発行」を押してください (${staffWord}・施工内容は保存しました)。`;
        return;
      }
      const date = str(formData, "completedAt") || toDateKey(new Date());
      if (!isDateKey(date)) fail(back, "施工完了日を正しく入れてください。");
      const closed = closedReason(db, date, "売上確定 (施工完了)");
      if (closed) fail(back, closed);
      const live = liveInvoicesOfOrder(db.invoices, o);
      o.status = live.length ? "invoiced" : "completed";
      o.completedAt = date;
      o.salesDate = date;
      o.updatedAt = now;
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "complete", body: str(formData, "body") || "施工完了。売上確定・請求書発行の画面で確定。" });
      addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: o.id, entityLabel: o.number, summary: `売上確定 (施工完了。売上計上日 ${date} / ¥${o.total.toLocaleString("ja-JP")})`, storeId: o.storeId });
      confirmedNow = true;
      const customer = db.customers.find((c) => c.id === o.customerId);
      if (usesBatchBilling(customer)) {
        msg = `売上を確定しました (売上計上日 ${date.slice(5).replace("-", "/")})。このお客様はまとめ請求のため、請求書は締め日にまとめて発行します。`;
      } else if (live.length) {
        msg = `売上を確定しました (売上計上日 ${date.slice(5).replace("-", "/")})。請求書 ${live[0].number} は発行済みです。「請求書」から確認・印刷できます。`;
      } else {
        const settings = documentSettings(db);
        const dueRaw = Number(str(formData, "dueDays"));
        const dueDays = Number.isFinite(dueRaw) && dueRaw > 0 && dueRaw <= 180 ? Math.round(dueRaw) : customer?.type === "corporate" ? Math.max(settings.paymentDays, 30) : 14;
        const sentVia = choice(formData, "sentVia", CHANNEL_LABEL, "visit");
        const id = buildOrderInvoice(db, user, o, { issueDate: toDateKey(new Date()), dueDays, sentVia, notes: str(formData, "notes").slice(0, 200) || undefined, note: "売上確定・請求書発行の画面" });
        const number = db.invoices.find((i) => i.id === id)?.number ?? "";
        msg = `売上を確定し、請求書 ${number} を発行しました (売上計上日 ${date.slice(5).replace("-", "/")})。「請求書」から確認・印刷できます。`;
      }
      if (done.length) msg = `${done.join(" ")} ${msg}`;
      return;
    }
    msg = [...done.map((d) => (d === "施工内容" ? "施工内容を保存しました。" : d)), `作業の${staffWord === "担当者" ? "担当" : "担当・ポスティング"}を保存しました。`].join(" ");
  });
  await notifyNewApprovals(approvalIds, user.id);
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(page);
  revalidatePath("/invoices");
  revalidatePath("/work-reports");
  revalidatePath("/kpi");
  revalidatePath("/schedule");
  // 予定表の小さな画面から開いたときは、確定のあとその画面に戻る (ボタンが「請求書」に変わる)
  redirect(withMsg(confirmedNow && ret ? ret : back, msg));
}
