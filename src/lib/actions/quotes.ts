"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import { categoryName, isItemCategory, syncInvoiceLineCategories } from "@/lib/mgmt/categories";
import { closedReason } from "@/lib/mgmt/close";
import type { Approval, Database, OrderHandover, Quote, QuoteItem, StoreId, User } from "@/lib/db/types";
import { AUTO_APPROVAL_NOTE, settleOwnApproval } from "@/lib/approval-decide";
import { addDays, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { approvalSettings, manYen } from "@/lib/approval-rules";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { syncOrderEvent } from "@/lib/db/schedule";
import { cleanHandovers, handoverSpan, hasHandoverItems, suggestHandovers } from "@/lib/handover";
import { quoteHandoverLines } from "@/lib/handover-save";
import { approverLabel, approverRole, canSeeAllStores } from "@/lib/auth/permissions";
import { relinkDocumentAttachments } from "@/lib/attachments";
import { documentSettings } from "@/lib/doc-settings";
import { parseTaxMode, quoteTotals, taxFields, taxModeOf, type TaxMode } from "@/lib/quote-calc";
import { siteInfoFromForm } from "@/lib/site-info";
import { plannedFromSiteInfo } from "@/lib/case-status";
import { syncHandoverMemo } from "@/lib/db/schedule";
import { assertCaseStore, choice, fail, requireActionUser, resolveStoreId, safeReturn, str, withMsg } from "./guards";
import { propagateOrderSite } from "@/lib/maps/store";
import { quoteCompletedLock, completedLockMessage } from "@/lib/case-access";
import { autoUnit } from "@/lib/line-kind";

function parseItems(formData: FormData, back: string): QuoteItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(str(formData, "items") || "[]");
  } catch {
    fail(back, "明細の形式が不正です。");
  }
  if (!Array.isArray(raw) || raw.length === 0) fail(back, "明細を 1 行以上入力してください。");
  const items: QuoteItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const qty = Number(r.qty);
    const unitPrice = Number(r.unitPrice);
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    if (!Number.isFinite(qty) || qty <= 0) fail(back, `「${name}」の数量が不正です。`);
    // 値引きの行は単価がマイナス
    if (!Number.isFinite(unitPrice)) fail(back, `「${name}」の単価が不正です。`);
    items.push({
      id: newId("qi"),
      productId: r.productId ? String(r.productId) : undefined,
      name,
      spec: r.spec ? String(r.spec) : undefined,
      qty,
      // 単位が空なら品名・仕様から (src/lib/line-kind.ts。なければ「式」)。画面 (QuoteEditor) は入力のたびに自動で選ぶ
      unit: String(r.unit ?? "").trim().slice(0, 10) || autoUnit(name, r.spec ? String(r.spec) : undefined, r.productId ? getDb().products.find((p) => p.id === String(r.productId))?.category : undefined) || "式",
      unitPrice,
      amount: Math.round(qty * unitPrice),
      // 管理会計の品目 (明細で選んだときだけ。空なら商品の品目 → 見積の種別から決める)
      itemCategory: isItemCategory(getDb(), String(r.itemCategory ?? "")) ? String(r.itemCategory) : undefined,
      // 畳床 (管理会計の材料マスタの畳床。選んだときだけ)
      dokoMaterialId: r.dokoMaterialId && getDb().materials.some((m) => m.id === String(r.dokoMaterialId) && m.kind === "doko") ? String(r.dokoMaterialId) : undefined,
    });
  }
  if (items.length === 0) fail(back, "明細を 1 行以上入力してください。");
  return items;
}

/** 明細の管理会計の項目 (品目・畳床) だけの違い (金額・品名・数量などは同じ前提) */
function categoryChanges(before: QuoteItem[], after: QuoteItem[]): { line: number; name: string; field: "itemCategory" | "dokoMaterialId"; before?: string; after?: string }[] {
  if (before.length !== after.length) return [];
  return after.flatMap((it, k) =>
    (["itemCategory", "dokoMaterialId"] as const).flatMap((f) => ((it[f] ?? "") !== (before[k][f] ?? "") ? [{ line: k + 1, name: it.name, field: f, before: before[k][f], after: it[f] }] : [])),
  );
}

/** 施工場所 (お客様の住所と違うとき) と領収書の宛名。フォームに欄がないときは undefined (変更しない) */
function siteFieldsOf(formData: FormData): { siteAddress?: string; receiptName?: string } | undefined {
  if (!formData.has("siteAddress") && !formData.has("receiptName")) return undefined;
  return { siteAddress: str(formData, "siteAddress").slice(0, 200) || undefined, receiptName: str(formData, "receiptName").slice(0, 100) || undefined };
}

/**
 * 施工場所・領収書の宛名を見積に反映する (金額に関わらないので承認は不要)。受注済みなら受注にも反映する。
 * 変更があった項目の監査ログを書き、変更の一覧を返す
 */
function applySiteFields(db: Database, q: Quote, next: { siteAddress?: string; receiptName?: string }, user: User): string[] {
  const before = { siteAddress: q.siteAddress, receiptName: q.receiptName };
  const changes = (["siteAddress", "receiptName"] as const).filter((f) => (before[f] ?? "") !== (next[f] ?? "")).map((f) => ({ field: f, before: before[f], after: next[f] }));
  if (!changes.length) return [];
  q.siteAddress = next.siteAddress;
  q.receiptName = next.receiptName;
  addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `${changes.map((c) => (c.field === "siteAddress" ? "施工場所" : "領収書の宛名")).join("・")}を変更`, storeId: q.storeId, changes });
  const o = q.orderId ? db.orders.find((x) => x.id === q.orderId && x.status !== "cancelled") : undefined;
  if (o) {
    const customer = db.customers.find((c) => c.id === q.customerId);
    const ob = { siteAddress: o.siteAddress, receiptName: o.receiptName };
    if (changes.some((c) => c.field === "siteAddress")) o.siteAddress = next.siteAddress || customer?.address || o.siteAddress;
    if (changes.some((c) => c.field === "receiptName")) o.receiptName = next.receiptName;
    const oc = (["siteAddress", "receiptName"] as const).filter((f) => (ob[f] ?? "") !== (o[f] ?? "")).map((f) => ({ field: f, before: ob[f], after: o[f] }));
    if (oc.length) {
      o.updatedAt = nowIso();
      if (oc.some((c) => c.field === "siteAddress") && db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
      if (oc.some((c) => c.field === "siteAddress")) propagateOrderSite(db, user, o, ob.siteAddress);
      addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `見積 ${q.number} の変更に合わせて${oc.map((c) => (c.field === "siteAddress" ? "施工場所" : "領収書の宛名")).join("・")}を変更`, storeId: o.storeId, changes: oc });
    }
  }
  return changes.map((c) => c.field);
}

function calc(items: QuoteItem[], discount: number, mode: TaxMode = "excluded") {
  return quoteTotals(items, discount, mode);
}

/** フォームの税の書き方 (内税・外税・非課税。src/lib/quote-calc.ts) */
const taxModeIn = (fd: FormData): TaxMode => parseTaxMode({ taxMode: str(fd, "taxMode"), taxIncluded: str(fd, "taxIncluded") });

/** 見積から作った受注に、有効な (無効化していない) 請求書があるか。あれば金額は変えられない */
function hasActiveInvoice(db: Database, quoteId: string): boolean {
  return db.orders.some((o) => o.quoteId === quoteId && o.status !== "cancelled" && db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void"));
}

/** 見積・受注の承認者 (金額が基準以上、本部の案件、店長の申請、承認できる店長がいない店舗は管理者) */
function requiredRole(db: Database, storeId: StoreId, amount: number, requesterId: string): "store_manager" | "admin" {
  return approverRole(db.users, storeId, amount >= approvalSettings(db).quoteAdminThreshold, requesterId);
}

/** 見積の承認の申請。管理者の申請は承認を省略して、その場で承認済みにする (auto = true) */
function requestApproval(db: Database, q: Quote, user: User, comment?: string): { role: "store_manager" | "admin"; auto: boolean } {
  const role = requiredRole(db, q.storeId, q.total, user.id);
  const approval: Approval = {
    id: newId("ap"),
    type: "quote",
    targetId: q.id,
    title: `${q.number} ${q.title}`,
    amount: q.total,
    storeId: q.storeId,
    requestedBy: user.id,
    requiredRole: role,
    status: "pending",
    requestComment: comment || undefined,
    createdAt: nowIso(),
  };
  db.approvals.push(approval);
  q.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の承認を申請 (${approverLabel(role, q.total >= approvalSettings(db).quoteAdminThreshold, manYen(approvalSettings(db).quoteAdminThreshold))})`, storeId: q.storeId });
  return { role, auto: settleOwnApproval(db, approval, user, `/quotes/${q.id}`) };
}

/** 申請のあとの案内 (管理者の申請は承認を省略して承認済み) */
const submittedText = (r: { role: string; auto: boolean }) => (r.auto ? `${AUTO_APPROVAL_NOTE}し、承認済みにしました。` : `${r.role === "admin" ? "管理者" : "店長"}へ承認を申請しました。`);

/**
 * 見積の作成の画面へ戻る先。取込書類・問い合わせ・お客様を付けて戻す
 * (付けないと、入力の誤りで戻ったときに手書き見積書の読取結果が消えて、空の画面になる)
 */
function newQuoteBack(formData: FormData): string {
  const qs = new URLSearchParams();
  for (const k of ["documentId", "inquiryId", "customerId", "returnTo"]) {
    const v = str(formData, k);
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/quotes/new?${s}` : "/quotes/new";
}

/** 取込書類から見積を作れるか (見積・受注などの登録先がまだない。顧客・問い合わせに添付しただけのものは作れる) */
const docBlocksQuote = (doc: { linkedType?: string; linkedId?: string; status: string }) =>
  doc.status === "discarded" || Boolean(doc.linkedId && doc.linkedType !== "customer" && doc.linkedType !== "inquiry");

export async function createQuote(formData: FormData) {
  const user = await requireActionUser();
  const back = newQuoteBack(formData);
  const customerId = str(formData, "customerId");
  const title = str(formData, "title");
  if (!customerId) fail(back, "お客様を選択してください。");
  if (!title) fail(back, "件名を入力してください。");
  const items = parseItems(formData, back);
  const intent = str(formData, "intent");
  const id = newId("q");
  let submitted = "";
  const approvalIds: string[] = [];
  await mutate((db) => {
    const documentId = str(formData, "documentId");
    const doc = documentId ? db.documents.find((d) => d.id === documentId) : undefined;
    if (doc && docBlocksQuote(doc)) fail("/capture?doc=" + doc.id, "この取込書類はすでに登録済み (または破棄済み) です。");
    const customer = db.customers.find((c) => c.id === customerId);
    if (!customer) fail(back, "お客様が見つかりません。");
    // 店舗のロールは自店舗のお客様だけ (一覧で見えないお客様の見積を作らない)。店長は全店舗のお客様 (permissions.ts の canEditCaseStore)
    assertCaseStore(user, customer.storeId, back);
    // 店舗のロールの見積は自店舗。ただし、ほかの店舗の問い合わせから作る見積 (店長) は、その問い合わせの店舗の見積にする
    const fromInquiry = db.inquiries.find((i) => i.id === str(formData, "inquiryId"));
    if (fromInquiry) assertCaseStore(user, fromInquiry.storeId, back);
    const storeId = fromInquiry && !canSeeAllStores(user) ? fromInquiry.storeId : resolveStoreId(user, str(formData, "storeId"), customer.storeId);
    assertCaseStore(user, storeId, back);
    const today = toDateKey(new Date());
    const now = nowIso();
    const taxMode = taxModeIn(formData);
    const t = calc(items, Number(str(formData, "discount")) || 0, taxMode);
    if (t.total <= 0) fail(back, "合計が 0 円以下です。明細を確認してください。");
    const estimator = str(formData, "estimatorId");
    const quoteDate = str(formData, "quoteDate");
    const handedOver = formData.get("handedOver") === "on";
    const q: Quote = {
      id,
      number: nextNumber(db, "Q", db.quotes, today),
      version: 1,
      customerId,
      inquiryId: str(formData, "inquiryId") || undefined,
      storeId,
      title,
      category: choice(formData, "category", CATEGORY_LABEL, "tatami"),
      items,
      ...t,
      status: "draft",
      validUntil: str(formData, "validUntil") || addDays(today, documentSettings(db).quoteValidDays),
      createdBy: user.id,
      notes: str(formData, "notes") || undefined,
      workDetails: str(formData, "workDetails") || undefined,
      source: choice(formData, "source", ["manual", "ocr", "ai_phone"] as const, "manual"),
      documentId: str(formData, "documentId") || undefined,
      ...taxFields(taxMode),
      siteInfo: siteInfoFromForm(formData),
      paperNo: str(formData, "paperNo") || undefined,
      estimatorId: estimator && db.users.some((u) => u.id === estimator) ? estimator : user.id,
      ...(siteFieldsOf(formData) ?? {}),
      handedOver: handedOver || undefined,
      issuedAt: handedOver && /^\d{4}-\d{2}-\d{2}$/.test(quoteDate) ? quoteDate : undefined,
      createdAt: now,
      updatedAt: now,
    };
    db.quotes.push(q);
    addAudit(db, { userId: user.id, action: "create", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積を作成 (${customer.name} 様 / ${title} / ${t.total.toLocaleString("ja-JP")}円)`, storeId });
    const inq = db.inquiries.find((i) => i.id === q.inquiryId);
    if (inq) {
      inq.quoteId = id;
      if (inq.status === "new" || inq.status === "in_progress") inq.status = "quoted";
      inq.updatedAt = now;
    }
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "quote";
      doc.linkedId = id;
      relinkDocumentAttachments(db, doc.id, { type: "quote", id, customerId: q.customerId, storeId });
    }
    if (intent === "submit") {
      submitted = submittedText(requestApproval(db, q, user));
      approvalIds.push(db.approvals[db.approvals.length - 1].id);
    }
  });
  await notifyNewApprovals(approvalIds, user.id);
  revalidatePath("/quotes");
  // 予定表の小さな画面から撮影して作った見積は、その画面に戻る (お客様のご要望 2026-11-25「②」)
  const ret = safeReturn(str(formData, "returnTo"), "");
  redirect(withMsg(ret || `/quotes/${id}`, intent === "submit" ? `見積を作成し、${submitted}` : ret ? "見積を下書き保存しました。続けて「受注にする」で受注と日程を登録できます。" : "見積を下書き保存しました。"));
}

export async function updateQuote(id: string, formData: FormData) {
  const user = await requireActionUser();
  // 予定表の小さな画面から明細を直したときは、その画面に戻る (returnTo。お客様のご要望 2026-11-25「③」)
  const ret = safeReturn(str(formData, "returnTo"), "");
  const back = ret || `/quotes/${id}/edit`;
  const items = parseItems(formData, back);
  const intent = str(formData, "intent");
  let message = "見積を更新しました。";
  const approvalIds: string[] = [];
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertCaseStore(user, q.storeId, back);
    const lock = quoteCompletedLock(db, user, q);
    if (lock.locked) fail(`/quotes/${id}`, completedLockMessage(lock.reason));
    const taxMode = taxModeIn(formData);
    const taxIncluded = taxMode === "included";
    const taxExempt = taxMode === "exempt";
    const t = calc(items, Number(str(formData, "discount")) || 0, taxMode);
    if (t.total <= 0) fail(back, "合計が 0 円以下です。明細を確認してください。");
    const now = nowIso();
    const site = siteFieldsOf(formData);
    if (q.status === "draft") {
      if (site) applySiteFields(db, q, site, user);
      q.taxIncluded = taxIncluded || undefined;
      q.taxExempt = taxExempt || undefined;
      const est = str(formData, "estimatorId");
      if (est && db.users.some((u) => u.id === est)) q.estimatorId = est;
      q.title = str(formData, "title") || q.title;
      q.category = choice(formData, "category", CATEGORY_LABEL, q.category);
      q.validUntil = str(formData, "validUntil") || q.validUntil;
      q.notes = str(formData, "notes") || undefined;
      q.workDetails = str(formData, "workDetails") || undefined;
      q.items = items;
      Object.assign(q, t);
      q.updatedAt = now;
      addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積 (下書き) を更新 (合計 ${t.total.toLocaleString("ja-JP")}円)`, storeId: q.storeId });
      if (intent === "submit") {
        const r = requestApproval(db, q, user);
        approvalIds.push(db.approvals[db.approvals.length - 1].id);
        message = `見積を更新し、${submittedText(r)}`;
      }
    } else if (q.status === "approved" || q.status === "sent" || q.status === "accepted") {
      if (q.pendingChange) fail(`/quotes/${id}`, "すでに承認待ちの変更があります。");
      const title = str(formData, "title") || q.title;
      const workDetails = str(formData, "workDetails");
      const notes = str(formData, "notes");
      const sameItems = JSON.stringify(items.map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice])) === JSON.stringify(q.items.map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice]));
      const sameContent = sameItems && t.discount === q.discount && taxMode === taxModeOf(q) && title === q.title && workDetails === (q.workDetails ?? "") && notes === (q.notes ?? "");
      const siteChanged = Boolean(site) && ((site!.siteAddress ?? "") !== (q.siteAddress ?? "") || (site!.receiptName ?? "") !== (q.receiptName ?? ""));
      const cats = sameItems ? categoryChanges(q.items, items) : [];
      // 施工場所・領収書の宛名・明細の品目 (管理会計の分類) だけの変更は、承認・変更理由なしで反映する (金額・契約内容に関わらない)
      if (sameContent && (siteChanged || cats.length)) {
        const done: string[] = [];
        if (siteChanged) done.push(...applySiteFields(db, q, site!, user).map((f) => (f === "siteAddress" ? "施工場所" : "領収書の宛名")));
        if (cats.length) {
          const ord = q.orderId ? db.orders.find((o) => o.id === q.orderId) : undefined;
          const closedCat = ord?.salesDate ? closedReason(db, ord.salesDate, "明細の品目・畳床の変更") : null;
          if (closedCat) fail(back, closedCat);
          cats.forEach((c) => (q.items[c.line - 1][c.field] = c.after));
          syncInvoiceLineCategories(db, q.orderId, q.items, now);
          const show = (c: (typeof cats)[number], v?: string) => (!v ? "自動" : c.field === "itemCategory" ? categoryName(db, v) : (db.materials.find((m) => m.id === v)?.name ?? v));
          addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: id, entityLabel: q.number, summary: `明細の${cats.some((c) => c.field === "dokoMaterialId") ? "品目・畳床" : "品目"} (管理会計) を変更: ${cats.map((c) => `${c.line} 行目 ${c.name} ${c.field === "dokoMaterialId" ? "畳床 " : ""}${show(c, c.before)} → ${show(c, c.after)}`).join(" / ")}`, storeId: q.storeId, changes: cats.map((c) => ({ field: `items.${c.line}.${c.field}`, before: c.before ?? null, after: c.after ?? null })) });
          done.push(cats.some((c) => c.field === "dokoMaterialId") ? "明細の品目・畳床" : "明細の品目");
        }
        q.updatedAt = now;
        message = `${done.join("・")}を変更しました${siteChanged && q.orderId ? " (受注にも反映しました)" : ""}。`;
        return;
      }
      if (sameContent) fail(back, "変更された内容がありません。");
      if (hasActiveInvoice(db, q.id)) fail(ret || `/quotes/${id}`, "請求書を発行済みの案件は金額を変更できません。入金前であれば、請求書を無効化してから変更を申請してください。");
      // 差額が少ない変更 (仕様・品名・数量だけで金額が同じものを含む) は承認なし・理由は省略可 (お客様のご要望 2026-11-25「⑥」。approval-decide.ts の smallAmountChange)
      const limit = approvalSettings(db).smallChangeLimit;
      const small = limit > 0 && Math.abs(t.total - q.total) <= limit;
      const reason = str(formData, "reason") || (small ? (t.total === q.total ? "仕様・内容の変更" : `金額の変更 (差額 ¥${Math.abs(t.total - q.total).toLocaleString("ja-JP")})`) : "");
      if (!reason) fail(back, `確定済みの見積の変更で、差額が${manYen(limit)}を超えるときは変更理由が必要です (承認者と変更履歴に記録されます)。`);
      if (siteChanged) applySiteFields(db, q, site!, user);
      q.pendingChange = { items, ...t, taxIncluded, taxExempt, title, workDetails, notes, reason, requestedBy: user.id, requestedAt: now };
      q.updatedAt = now;
      const role = requiredRole(db, q.storeId, Math.max(t.total, q.total), user.id);
      const amend: Approval = {
        id: newId("ap"),
        type: "quote_amend",
        targetId: q.id,
        title: `${q.number} ${q.title} (${t.total !== q.total ? "金額変更" : "内容変更"} 第${q.version + 1}版)`,
        amount: t.total,
        storeId: q.storeId,
        requestedBy: user.id,
        requiredRole: role,
        status: "pending",
        requestComment: `${t.total !== q.total ? `変更前 ¥${q.total.toLocaleString("ja-JP")} → 変更後 ¥${t.total.toLocaleString("ja-JP")}` : `金額の変更なし (¥${q.total.toLocaleString("ja-JP")})`}${title !== q.title ? ` / 件名: ${title}` : ""}${workDetails !== (q.workDetails ?? "") ? " / 施工内容を変更" : ""} / 理由: ${reason}`,
        createdAt: now,
      };
      db.approvals.push(amend);
      approvalIds.push(amend.id);
      addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: id, entityLabel: q.number, summary: `確定見積の金額変更を申請 (${q.total.toLocaleString("ja-JP")}円 → ${t.total.toLocaleString("ja-JP")}円)`, storeId: q.storeId, changes: [{ field: "total", before: q.total, after: t.total }] });
      message = settleOwnApproval(db, amend, user, `/quotes/${id}`)
        ? `${AUTO_APPROVAL_NOTE}し、変更を第${q.version}版として反映しました。`
        : `変更を申請しました。${role === "admin" ? "管理者" : "店長"}の承認後に第${q.version + 1}版として反映されます。`;
    } else {
      fail(`/quotes/${id}`, "この状態の見積は編集できません。");
    }
  });
  await notifyNewApprovals(approvalIds, user.id);
  revalidatePath("/quotes");
  if (ret) revalidatePath("/schedule");
  redirect(withMsg(ret || `/quotes/${id}`, message));
}

export async function submitQuote(id: string) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  let submitted = "";
  let approvalId = "";
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertCaseStore(user, q.storeId, back);
    if (q.status !== "draft") fail(back, "下書きの見積のみ申請できます。");
    submitted = submittedText(requestApproval(db, q, user));
    approvalId = db.approvals[db.approvals.length - 1].id;
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  redirect(withMsg(back, submitted));
}

export async function sendQuote(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  const channel = choice(formData, "channel", CHANNEL_LABEL, "email");
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertCaseStore(user, q.storeId, back);
    if (q.status !== "approved" && q.status !== "sent") fail(back, "承認済みの見積のみ送付できます。");
    const now = nowIso();
    q.status = "sent";
    q.issuedAt = q.issuedAt ?? toDateKey(new Date());
    q.sentVia = channel;
    q.updatedAt = now;
    db.commLogs.push({ id: newId("cl"), customerId: q.customerId, channel, direction: "outbound", subject: `お見積書 ${q.number} 送付`, body: `${q.title} のお見積書 (合計 ¥${q.total.toLocaleString("ja-JP")}) を${CHANNEL_LABEL[channel]}でお送りしました。`, at: now, userId: user.id, relatedType: "quote", relatedId: q.id });
    const inq = db.inquiries.find((i) => i.id === q.inquiryId);
    if (inq && inq.status !== "won") inq.status = "quoted";
    addAudit(db, { userId: user.id, action: "send", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積書を送付 (${CHANNEL_LABEL[channel]})`, storeId: q.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, `見積書を${CHANNEL_LABEL[channel]}で送付した記録を残しました。`));
}

/** お客様の承諾 → 受注 (契約承認待ち) を作成 */
/**
 * 見積から受注 (契約) を登録する。
 * onsite = 1 (予定表の小さな画面・見積の画面の「現場で受注」。お客様のご要望 2026-11-25「③」): 承認前 (下書き・承認待ち) の見積も受注にできる。
 *   下書きは見積の承認も申請し、受注 (契約) を承認すると見積も承認済みになる (approval-decide.ts)。店長・管理者は承認を省略。
 * handovers (JSON) があれば品目ごとの引取日・納品日 (施工日) をそのまま受注の日程にして予定表に載せる (「④」: 手書きの日時からの案を直したもの)。
 * returnTo があれば、登録のあとその画面 (予定表の小さな画面) に戻る
 */
export async function convertQuoteToOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const ret = safeReturn(str(formData, "returnTo"), "");
  const back = ret || `/quotes/${id}`;
  const onsite = str(formData, "onsite") === "1";
  let orderId = "";
  let role = "";
  let auto = false;
  let approvalId = "";
  let quoteNote = "";
  const approvalIds: string[] = [];
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertCaseStore(user, q.storeId, back);
    if (!["approved", "sent"].includes(q.status) && !(onsite && ["draft", "pending_approval"].includes(q.status))) fail(back, "承認済み・送付済みの見積のみ受注にできます (現場で受注が決まったときは「現場で受注」から、見積の承認とあわせて申請できます)。");
    if (q.orderId) fail(back, "この見積はすでに受注登録されています。");
    if (q.pendingChange) fail(back, "見積の変更が承認待ちです。承認・差戻しのあとに受注にしてください。");
    // 現場で受注: 下書きの見積は見積の承認も申請する (店長・管理者は承認を省略してその場で承認済み)
    if (onsite && q.status === "draft") {
      const r = requestApproval(db, q, user, "現場で受注が決まったため、受注 (契約) とあわせて申請");
      approvalIds.push(db.approvals[db.approvals.length - 1].id);
      quoteNote = r.auto ? "" : ` 見積の承認も${r.role === "admin" ? "管理者" : "店長"}へ申請しました (受注を承認すると見積も承認済みになります)。`;
    } else if (onsite && q.status === "pending_approval") {
      quoteNote = " 見積は承認待ちのままです (受注を承認すると見積も承認済みになります)。";
    }
    const customer = db.customers.find((c) => c.id === q.customerId);
    const now = nowIso();
    const today = toDateKey(new Date());
    orderId = newId("o");
    // 品目ごとの日程 (受注登録と同時に入れたとき)
    let plan: OrderHandover[] | undefined;
    if (formData.has("handovers")) {
      let raw: unknown = [];
      try {
        raw = JSON.parse(str(formData, "handovers") || "[]");
      } catch {
        fail(back, "日程を読めませんでした。もう一度入力してください。");
      }
      const c = cleanHandovers(raw);
      if (c.error) fail(back, c.error);
      plan = c.rows;
    }
    const span = plan ? handoverSpan(plan) : {};
    const scheduledStart = span.start ?? (str(formData, "scheduledStart") || undefined);
    const workerIds = formData.getAll("workerIds").map(String).filter(Boolean);
    db.orders.push({
      id: orderId,
      number: nextNumber(db, "O", db.orders, today),
      quoteId: q.id,
      customerId: q.customerId,
      storeId: q.storeId,
      title: q.title,
      category: q.category,
      contractDate: today,
      total: q.total,
      status: "pending_approval",
      scheduledStart,
      scheduledEnd: span.end ?? scheduledStart,
      workerIds,
      siteAddress: str(formData, "siteAddress") || q.siteAddress || customer?.address || "",
      receiptName: q.receiptName,
      workDetails: q.workDetails,
      siteInfo: q.siteInfo,
      // 見積で入れた畳の仕様 (部屋ごと) を受注へ (なければ受注の画面・畳製造予定は見積の明細から自動で作る)
      ...(q.tatamiRooms?.length ? { tatamiRooms: q.tatamiRooms } : {}),
      plannedPayment: plannedFromSiteInfo(q.siteInfo?.paymentMethod),
      progressNotes: [{ id: newId("pn"), at: now, userId: user.id, kind: "note", body: str(formData, "note") || "お客様よりご承諾をいただきました。契約承認を申請します。" }],
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    q.orderId = orderId;
    q.updatedAt = now;
    // 施工予定日を入れて受注登録した場合は、契約承認前でも予定表に施工予定を載せて日程を押さえる
    const created = db.orders[db.orders.length - 1];
    // 畳・襖・障子・網戸の見積: 入れた日を引取日にして品目ごとの日程を作る (表替え・裏返しは当日納品、ほかの納品日は手書きの日時か後で入れる。src/lib/handover.ts)
    const hvLines = quoteHandoverLines(db, q.items);
    if (plan?.length) created.handovers = plan;
    else if (scheduledStart && hasHandoverItems(hvLines, q.category)) {
      created.handovers = suggestHandovers({ lines: hvLines, category: q.category, pickupText: q.siteInfo?.pickupAt, deliveryText: q.siteInfo?.deliveryAt, pickupDate: scheduledStart, ref: today });
    }
    if (created.scheduledStart) syncOrderEvent(db, created, user.id);
    syncHandoverMemo(db, created);
    const r = requiredRole(db, q.storeId, q.total, user.id);
    role = r;
    approvalId = newId("ap");
    const contract: Approval = { id: approvalId, type: "order", targetId: orderId, title: `${db.orders[db.orders.length - 1].number} ${q.title}`, amount: q.total, storeId: q.storeId, requestedBy: user.id, requiredRole: r, status: "pending", requestComment: str(formData, "note") || undefined, createdAt: now };
    db.approvals.push(contract);
    addAudit(db, { userId: user.id, action: "create", entity: "order", entityId: orderId, entityLabel: db.orders[db.orders.length - 1].number, summary: `見積 ${q.number} から受注を登録し契約承認を申請${onsite ? " (現場で受注)" : ""}${plan?.length ? ` · 日程 ${plan.length} 品目` : ""}`, storeId: q.storeId });
    auto = settleOwnApproval(db, contract, user, back);
  });
  await notifyNewApprovals([...approvalIds, approvalId], user.id);
  revalidatePath("/orders");
  revalidatePath("/schedule");
  const msg = (auto ? `受注を登録しました。${AUTO_APPROVAL_NOTE}し、契約を確定しました。施工手配へ進めます。` : `受注を登録しました。${role === "admin" ? "管理者" : "店長"}の契約承認後に施工手配へ進めます。`) + quoteNote;
  redirect(withMsg(ret || `/orders/${orderId}`, msg));
}

export async function markQuoteLost(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertCaseStore(user, q.storeId, back);
    if (!["approved", "sent", "draft"].includes(q.status)) fail(back, "この状態の見積は失注にできません。");
    q.status = "rejected";
    q.updatedAt = nowIso();
    const inq = db.inquiries.find((i) => i.id === q.inquiryId);
    if (inq) inq.status = "lost";
    addAudit(db, { userId: user.id, action: "status", entity: "quote", entityId: id, entityLabel: q.number, summary: `失注として登録${str(formData, "reason") ? ` (${str(formData, "reason")})` : ""}`, storeId: q.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "失注として登録しました。"));
}

export async function deleteQuote(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const idx = db.quotes.findIndex((x) => x.id === id);
    if (idx < 0) fail("/quotes", "見積が見つかりません。");
    const q = db.quotes[idx];
    assertCaseStore(user, q.storeId, `/quotes/${id}`);
    if (q.status !== "draft") fail(`/quotes/${id}`, "下書きの見積のみ削除できます。");
    db.quotes.splice(idx, 1);
    // 取込書類から作った見積なら、書類を確認待ちに戻し、元の画像も書類に戻す
    const doc = q.documentId ? db.documents.find((d) => d.id === q.documentId && d.linkedType === "quote" && d.linkedId === id) : undefined;
    if (doc) {
      doc.status = "extracted";
      doc.linkedType = undefined;
      doc.linkedId = undefined;
      for (const a of db.attachments) {
        if (a.parentType === "quote" && a.parentId === id && a.fileName === doc.fileName.slice(0, 200)) {
          a.parentType = "document";
          a.parentId = doc.id;
          a.storeId = doc.storeId;
        }
      }
    }
    const inq = db.inquiries.find((i) => i.quoteId === id);
    if (inq) {
      inq.quoteId = undefined;
      if (inq.status === "quoted") inq.status = "in_progress";
    }
    addAudit(db, { userId: user.id, action: "delete", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積 (下書き) を削除`, storeId: q.storeId });
  });
  revalidatePath("/quotes");
  redirect(withMsg("/quotes", "下書きの見積を削除しました。"));
}
