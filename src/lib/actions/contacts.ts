"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Channel, CommLog, Database, RelatedType, StoreId, User } from "@/lib/db/types";
import { CHANNEL_LABEL, DELIVERY_STATUS } from "@/lib/constants";
import { canAccessStore, canEditCaseStore, canSeeAllStores, canViewPurchase } from "@/lib/auth/permissions";
import { isEmail, isLineTarget } from "@/lib/notify/channels";
import { lineGroupName, lineGroups } from "@/lib/line-groups";
import { sendAndRecord, type Outgoing } from "@/lib/notify/send";
import { choice, fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/** 案件として紐付けられる記録 */
export type CaseRef = { type: Extract<RelatedType, "inquiry" | "quote" | "order" | "invoice" | "purchase">; id: string; number: string; storeId: StoreId; customerId?: string; supplierId?: string };

/** 番号 (INQ-・Q-・O-・INV-・AP-) から案件を探す */
function findCase(db: Database, ref: string): CaseRef | undefined {
  const t = ref.normalize("NFKC").trim().toUpperCase();
  if (!t) return undefined;
  const q = db.quotes.find((x) => x.number.toUpperCase() === t);
  if (q) return { type: "quote", id: q.id, number: q.number, storeId: q.storeId, customerId: q.customerId };
  const o = db.orders.find((x) => x.number.toUpperCase() === t);
  if (o) return { type: "order", id: o.id, number: o.number, storeId: o.storeId, customerId: o.customerId };
  const i = db.inquiries.find((x) => x.number.toUpperCase() === t);
  if (i) return { type: "inquiry", id: i.id, number: i.number, storeId: i.storeId, customerId: i.customerId };
  const inv = db.invoices.find((x) => x.number.toUpperCase() === t);
  if (inv) return { type: "invoice", id: inv.id, number: inv.number, storeId: inv.storeId, customerId: inv.customerId };
  const p = db.purchases.find((x) => x.number.toUpperCase() === t);
  if (p) return { type: "purchase", id: p.id, number: p.number, storeId: p.storeId, supplierId: p.supplierId };
  return undefined;
}

/** 紐付ける案件を扱えるか: 問い合わせ・見積・受注は canEditCaseStore (店長は全店舗)、請求書は自店舗、仕入請求書は仕入の権限 */
function assertCaseAccess(user: User, c: CaseRef, back: string) {
  if (c.type === "purchase") {
    if (!canViewPurchase(user, { storeId: c.storeId })) fail(back, "この仕入請求書は閲覧できません。");
  } else if (c.type === "invoice") {
    if (!canAccessStore(user, c.storeId)) fail(back, "他店舗の案件には紐付けられません。");
  } else if (!canEditCaseStore(user, c.storeId)) fail(back, "他店舗の案件には紐付けられません。");
}

/** 送信できる宛先 (メール・LINE・Chatwork)。なければ理由 */
function destination(db: Database, channel: Channel, customerId?: string, supplierId?: string): { to: string; label: string } | { error: string } {
  const c = customerId ? db.customers.find((x) => x.id === customerId) : undefined;
  const s = supplierId ? db.suppliers.find((x) => x.id === supplierId) : undefined;
  const who = s ?? c;
  const label = who?.name ?? "";
  if (channel === "email") {
    const to = s?.email ?? c?.email;
    return isEmail(to) ? { to, label } : { error: `${label || "相手"}のメールアドレスが登録されていません。` };
  }
  if (channel === "line") {
    const to = s?.lineId ?? c?.lineId;
    return to && isLineTarget(to) ? { to, label } : { error: `${label || "相手"}の LINE ユーザー ID (U で始まる 33 文字) が登録されていません。` };
  }
  if (channel === "chatwork") {
    const to = s?.chatworkRoomId;
    return to ? { to, label } : { error: "Chatwork で送れるのは、ルーム ID を登録した協力業者・仕入先です。" };
  }
  return { error: `${CHANNEL_LABEL[channel]}はシステムから送信できません (記録のみ)。` };
}

/**
 * 連絡の記録 (お客様・協力業者・仕入先とのやりとり)。
 * send = on のときは、メール・LINE・Chatwork で相手に送ってから記録する (送信の結果は送信履歴にも残る)
 */
export async function createContactLog(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/contacts");
  const body = str(formData, "body");
  if (!body) fail(back, "内容を入力してください。");
  const channel = choice(formData, "channel", CHANNEL_LABEL, "phone");
  const direction = str(formData, "direction") === "inbound" ? "inbound" : "outbound";
  const send = str(formData, "send") === "on" && direction === "outbound";
  const subject = str(formData, "subject").slice(0, 100) || body.slice(0, 30);
  const atRaw = str(formData, "at");
  const at = atRaw ? new Date(`${atRaw.length === 16 ? `${atRaw}:00` : atRaw}+09:00`) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60 * 1000) fail(back, "日時を正しく入力してください (未来の日時は入力できません)。");

  // 相手と案件を確かめる
  const db0 = getDb();
  const caseRef = str(formData, "caseRef") ? findCase(db0, str(formData, "caseRef")) : undefined;
  if (str(formData, "caseRef") && !caseRef) fail(back, `案件番号「${str(formData, "caseRef")}」が見つかりません (INQ-・Q-・O-・INV-・AP- で始まる番号)。`);
  if (caseRef) assertCaseAccess(user, caseRef, back);
  const customerId = str(formData, "customerId") || caseRef?.customerId || undefined;
  const supplierId = str(formData, "supplierId") || caseRef?.supplierId || undefined;
  const customer = customerId ? db0.customers.find((c) => c.id === customerId) : undefined;
  const supplier = supplierId ? db0.suppliers.find((s) => s.id === supplierId) : undefined;
  if (customerId && !customer) fail(back, "お客様が見つかりません。");
  if (supplierId && !supplier) fail(back, "協力業者・仕入先が見つかりません。");
  if (!customer && !supplier) fail(back, "相手 (お客様、または協力業者・仕入先) を選んでください。");
  if (customer && !canEditCaseStore(user, customer.storeId)) fail(back, "他店舗のお客様のやりとりは記録できません。");
  if (caseRef?.customerId && customer && caseRef.customerId !== customer.id) fail(back, `案件 ${caseRef.number} は別のお客様の案件です。`);
  const storeId: StoreId = caseRef?.storeId ?? customer?.storeId ?? (canSeeAllStores(user) ? "hq" : user.storeId);

  let deliveryNote = "";
  let deliveryId: string | undefined;
  if (send) {
    // LINE グループを選んだときはグループへ、協力業者・仕入先を選んだときはそちらへ、お客様だけのときはお客様へ送る
    const groupId = channel === "line" ? str(formData, "lineGroupId") : "";
    const group = groupId ? lineGroups(db0).find((g) => g.id === groupId && g.status === "joined") : undefined;
    if (groupId && !group) fail(back, "LINE グループが見つかりません (公式アカウントがグループから退出した可能性があります)。");
    if (group && !((caseRef?.type === "order" && group.orderId === caseRef.id) || (supplier && group.supplierId === supplier.id))) fail(back, "この案件・協力業者にひも付いていない LINE グループには送れません。");
    const dest = group ? { to: group.id, label: `LINE グループ「${lineGroupName(group)}」` } : destination(db0, channel, customer?.id, supplier?.id);
    if ("error" in dest) fail(back, `${dest.error} 記録だけ残すときは「相手に送信する」のチェックを外してください。`);
    const out: Outgoing = { channel: channel as Outgoing["channel"], to: dest.to, toLabel: dest.label, subject: channel === "email" ? subject : undefined, body, purpose: "message", relatedType: caseRef?.type ?? (supplier ? "supplier" : "customer"), relatedId: caseRef?.id ?? supplier?.id ?? customer?.id };
    const [d] = await sendAndRecord([out], user.id);
    if (d.status === "failed") fail(back, `送信できませんでした: ${d.error ?? "原因不明"}。記録は残していません。`);
    deliveryId = d.id;
    deliveryNote = d.status === "sent" ? `${CHANNEL_LABEL[channel]}で送信しました。` : `${DELIVERY_STATUS.skipped.label}。`;
  }

  await mutate((db) => {
    const log: CommLog = {
      id: newId("cl"),
      customerId: customer?.id,
      supplierId: supplier?.id,
      storeId,
      channel,
      direction,
      subject,
      body,
      at: at.toISOString(),
      userId: user.id,
      relatedType: caseRef?.type,
      relatedId: caseRef?.id,
      contactName: str(formData, "contactName").slice(0, 60) || undefined,
      deliveryId,
    };
    db.commLogs.push(log);
    if (caseRef?.type === "order") {
      const o = db.orders.find((x) => x.id === caseRef.id);
      if (o) {
        o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "note", body: `${supplier ? `${supplier.name} と` : "お客様と"}やりとり (${CHANNEL_LABEL[channel]} / ${direction === "inbound" ? "受信" : "発信"}): ${subject}` });
        o.updatedAt = nowIso();
      }
    }
    addAudit(db, { userId: user.id, action: send ? "send" : "create", entity: "comm", entityId: log.id, entityLabel: supplier?.name ?? customer?.name ?? "", summary: `やりとりを記録 (${supplier ? `協力業者・仕入先: ${supplier.name}` : `お客様: ${customer?.name}`} / ${CHANNEL_LABEL[channel]}${caseRef ? ` / 案件 ${caseRef.number}` : ""}${send ? " / 送信" : ""})`, storeId });
  });
  revalidatePath("/contacts");
  if (customer) revalidatePath(`/customers/${customer.id}`);
  if (supplier) revalidatePath(`/suppliers/${supplier.id}`);
  redirect(withMsg(back, `やりとりを記録しました。${deliveryNote}`));
}

/** 記録済みのやりとりを案件に紐付ける (案件番号を入力) */
export async function linkContactLog(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/contacts");
  await mutate((db) => {
    const log = db.commLogs.find((x) => x.id === id);
    if (!log) fail(back, "やりとりの記録が見つかりません。");
    const customer = log.customerId ? db.customers.find((c) => c.id === log.customerId) : undefined;
    const logStore = log.storeId ?? customer?.storeId;
    // お客様とのやりとり (問い合わせ・見積・受注・お客様あて) は canEditCaseStore (店長は全店舗)。請求書・協力業者・仕入先とのやりとりは自店舗
    const customerLog = Boolean(log.customerId) && !log.supplierId && log.relatedType !== "invoice" && log.relatedType !== "purchase";
    if (logStore && !(customerLog ? canEditCaseStore(user, logStore) : canAccessStore(user, logStore))) fail(back, "この記録を変更する権限がありません。");
    const ref = str(formData, "caseRef");
    const c = ref ? findCase(db, ref) : undefined;
    if (ref && !c) fail(back, `案件番号「${ref}」が見つかりません。`);
    if (c) {
      assertCaseAccess(user, c, back);
      if (c.customerId && log.customerId && c.customerId !== log.customerId) fail(back, `案件 ${c.number} は別のお客様の案件です。`);
    }
    const before = log.relatedId ? `${log.relatedType}:${log.relatedId}` : "";
    log.relatedType = c?.type;
    log.relatedId = c?.id;
    if (c) log.storeId = c.storeId;
    addAudit(db, { userId: user.id, action: "update", entity: "comm", entityId: log.id, entityLabel: log.subject, summary: c ? `やりとりを案件 ${c.number} に紐付け` : "やりとりの案件の紐付けを外す", storeId: log.storeId ?? logStore, changes: [{ field: "relatedId", before, after: c ? `${c.type}:${c.id}` : "" }] });
  });
  revalidatePath("/contacts");
  redirect(withMsg(back, "案件の紐付けを変更しました。"));
}
