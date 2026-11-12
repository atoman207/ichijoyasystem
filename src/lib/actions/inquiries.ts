"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nextNumber, nowIso, nextCustomerCode } from "@/lib/db/store";
import type { Channel, Inquiry, InquiryStatus, ServiceCategory } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import { assertStore, choice, fail, isKeyOf, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

export async function createInquiry(formData: FormData) {
  const user = await requireActionUser();
  const back = "/inquiries/new";
  const summary = str(formData, "summary");
  if (!summary) fail(back, "問い合わせ内容 (要約) は必須です。");
  const id = newId("inq");
  await mutate((db) => {
    const customer = db.customers.find((c) => c.id === str(formData, "customerId"));
    // 店舗のロールは自店舗のお客様だけを選べる
    if (customer) assertStore(user, customer.storeId, back);
    const storeId = resolveStoreId(user, str(formData, "storeId"), customer?.storeId);
    assertStore(user, storeId, back);
    const contactName = customer?.name ?? str(formData, "contactName");
    if (!contactName) fail(back, "お客様名を入力するか、既存顧客を選択してください。");
    const now = nowIso();
    const inq: Inquiry = {
      id,
      number: nextNumber(db, "INQ", db.inquiries, toDateKey(new Date())),
      customerId: customer?.id,
      contactName,
      contactPhone: customer?.phone ?? (str(formData, "contactPhone") || undefined),
      channel: choice(formData, "channel", CHANNEL_LABEL, "phone"),
      storeId,
      category: choice(formData, "category", CATEGORY_LABEL, "tatami"),
      summary,
      detail: str(formData, "detail"),
      status: "new",
      assignedUserId: str(formData, "assignedUserId") || user.id,
      receivedAt: now,
      nextAction: str(formData, "nextAction") || undefined,
      nextActionDue: str(formData, "nextActionDue") || undefined,
      createdBy: user.id,
      updatedAt: now,
    };
    db.inquiries.push(inq);
    addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `問い合わせを登録 (${contactName} / ${summary})`, storeId });
    if (customer) {
      db.commLogs.push({ id: newId("cl"), customerId: customer.id, channel: inq.channel, direction: "inbound", subject: summary, body: inq.detail || summary, at: now, userId: user.id, relatedType: "inquiry", relatedId: id });
      customer.updatedAt = now;
    }
  });
  revalidatePath("/inquiries");
  redirect(withMsg(`/inquiries/${id}`, "問い合わせを登録しました。"));
}

export async function updateInquiry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertStore(user, inq.storeId, back);
    const before = { ...inq };
    const status = str(formData, "status") as InquiryStatus;
    if (status && isKeyOf(INQUIRY_STATUS, status)) inq.status = status;
    inq.assignedUserId = str(formData, "assignedUserId") || inq.assignedUserId;
    inq.category = choice(formData, "category", CATEGORY_LABEL, inq.category);
    inq.nextAction = str(formData, "nextAction") || undefined;
    inq.nextActionDue = str(formData, "nextActionDue") || undefined;
    if (formData.has("detail")) inq.detail = str(formData, "detail");
    inq.updatedAt = nowIso();
    const changes = diffChanges(before, inq, ["status", "assignedUserId", "category", "nextAction", "nextActionDue", "detail"]);
    addAudit(db, { userId: user.id, action: changes.some((c) => c.field === "status") ? "status" : "update", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `問い合わせを更新 (${changes.map((c) => c.field).join(", ") || "変更なし"})`, storeId: inq.storeId, changes });
  });
  revalidatePath(back);
  redirect(withMsg(back, "問い合わせを更新しました。"));
}

export async function setInquiryStatus(id: string, status: InquiryStatus) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  if (!isKeyOf(INQUIRY_STATUS, status)) fail(back, "状態が正しくありません。");
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertStore(user, inq.storeId, back);
    const before = inq.status;
    inq.status = status;
    inq.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `問い合わせの状態を「${INQUIRY_STATUS[status].label}」に変更`, storeId: inq.storeId, changes: [{ field: "status", before, after: status }] });
  });
  revalidatePath(back);
  redirect(withMsg(back, `状態を「${INQUIRY_STATUS[status].label}」に変更しました。`));
}

/** 新規の連絡先を顧客として登録し、問い合わせに紐づける */
export async function registerCustomerFromInquiry(id: string) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  let customerId = "";
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertStore(user, inq.storeId, back);
    if (inq.customerId) fail(back, "すでに顧客に紐づいています。");
    const now = nowIso();
    customerId = newId("cust");
    db.customers.push({
      id: customerId,
      code: nextCustomerCode(db),
      name: inq.contactName,
      kana: "",
      type: "individual",
      phone: inq.contactPhone ?? "",
      postalCode: "",
      address: "",
      storeId: inq.storeId,
      assignedUserId: inq.assignedUserId ?? user.id,
      preferredChannel: inq.channel === "ai_phone" ? "phone" : inq.channel,
      firstContactChannel: inq.channel,
      tags: [],
      notes: `問い合わせ ${inq.number} から登録`,
      createdAt: now,
      updatedAt: now,
    });
    inq.customerId = customerId;
    inq.updatedAt = now;
    // すでに登録した案件の予定 (現地調査など) もお客様に紐づける
    for (const e of db.schedule) if (e.inquiryId === id && !e.customerId) e.customerId = customerId;
    db.commLogs.push({ id: newId("cl"), customerId, channel: inq.channel, direction: "inbound", subject: inq.summary, body: inq.detail || inq.summary, at: inq.receivedAt, userId: inq.createdBy, relatedType: "inquiry", relatedId: id });
    addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: customerId, entityLabel: inq.contactName, summary: `問い合わせ ${inq.number} から顧客を登録`, storeId: inq.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(`/customers/${customerId}/edit`, "顧客として登録しました。住所など不足している情報を補完してください。"));
}
