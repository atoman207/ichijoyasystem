"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nextNumber, nowIso, nextCustomerCode } from "@/lib/db/store";
import type { Channel, Inquiry, InquiryStatus, ServiceCategory } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { candidateLabel, findDuplicateCustomers, needsConfirmation } from "@/lib/duplicates";
import { assertStore, choice, fail, isKeyOf, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

export async function createInquiry(formData: FormData) {
  const user = await requireActionUser();
  const back = "/inquiries/new";
  const summary = str(formData, "summary");
  if (!summary) fail(back, "問い合わせ内容 (要約) は必須です。");
  // 受付日時 (郵送で届いた日・後から入力する電話の時刻など)。省略時は現在
  const atRaw = str(formData, "receivedAt");
  const receivedAt = atRaw ? new Date(`${atRaw.length === 16 ? `${atRaw}:00` : atRaw}+09:00`) : new Date();
  if (Number.isNaN(receivedAt.getTime())) fail(back, "受付日時を正しく入力してください。");
  if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) fail(back, "受付日時に未来の日時は入力できません。");
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
      number: nextNumber(db, "INQ", db.inquiries, toDateKey(receivedAt)),
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
      receivedAt: receivedAt.toISOString(),
      nextAction: str(formData, "nextAction") || undefined,
      nextActionDue: str(formData, "nextActionDue") || undefined,
      createdBy: user.id,
      updatedAt: now,
    };
    db.inquiries.push(inq);
    addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `問い合わせを登録 (${contactName} / ${summary})`, storeId });
    if (customer) {
      db.commLogs.push({ id: newId("cl"), customerId: customer.id, channel: inq.channel, direction: "inbound", subject: summary, body: inq.detail || summary, at: inq.receivedAt, userId: user.id, relatedType: "inquiry", relatedId: id });
      customer.updatedAt = now;
    }
  });
  revalidatePath("/inquiries");
  redirect(withMsg(`/inquiries/${id}`, "問い合わせを登録しました。届いた書類・写真は下の「資料・写真」から添付できます。"));
}

export async function updateInquiry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  let moved = false;
  let storeName = "";
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
    // 担当店舗の変更 (本社・他店舗で受けた問い合わせを担当の店舗へ回す)
    const storeId = str(formData, "storeId");
    if (storeId && storeId !== inq.storeId) {
      if (!db.stores.some((s) => s.id === storeId)) fail(back, "担当店舗が正しくありません。");
      inq.storeId = storeId as Inquiry["storeId"];
      const assignee = db.users.find((u) => u.id === inq.assignedUserId);
      // 担当者が回した先の店舗の人でなければ外す (回した先の店舗で担当を決める)
      if (assignee && assignee.storeId !== inq.storeId && !canSeeAllStores(assignee)) inq.assignedUserId = undefined;
      moved = !canAccessStore(user, inq.storeId);
    }
    inq.updatedAt = nowIso();
    const changes = diffChanges(before, inq, ["status", "assignedUserId", "category", "nextAction", "nextActionDue", "detail", "storeId"]);
    storeName = db.stores.find((s) => s.id === inq.storeId)?.name ?? "";
    const storeMoved = changes.some((c) => c.field === "storeId");
    addAudit(db, { userId: user.id, action: changes.some((c) => c.field === "status") ? "status" : "update", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: storeMoved ? `問い合わせを${storeName}へ回しました` : `問い合わせを更新 (${changes.map((c) => c.field).join(", ") || "変更なし"})`, storeId: inq.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/inquiries");
  // 自分の閲覧範囲の外へ回したときは一覧へ戻る
  if (moved) redirect(withMsg("/inquiries", `問い合わせを${storeName}へ回しました。以後は${storeName}で対応します。`));
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
export async function registerCustomerFromInquiry(id: string, formData?: FormData) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  let customerId = "";
  const confirmed = formData ? str(formData, "confirmDuplicate") === "1" : false;
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertStore(user, inq.storeId, back);
    if (inq.customerId) fail(back, "すでに顧客に紐づいています。");
    // 既存顧客との重複確認 (同じお客様なら「この顧客に紐づける」を使う)
    const dup = findDuplicateCustomers(db, { name: inq.contactName, phone: inq.contactPhone });
    if (needsConfirmation(dup) && !confirmed) fail(back, `既存の顧客と重複している可能性があります (${candidateLabel(dup)})。同じお客様なら「この顧客に紐づける」を、別のお客様なら確認のチェックを入れて登録してください。`);
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
    for (const a of db.attachments) if (a.parentType === "inquiry" && a.parentId === id && !a.customerId) a.customerId = customerId;
    db.commLogs.push({ id: newId("cl"), customerId, channel: inq.channel, direction: "inbound", subject: inq.summary, body: inq.detail || inq.summary, at: inq.receivedAt, userId: inq.createdBy, relatedType: "inquiry", relatedId: id });
    addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: customerId, entityLabel: inq.contactName, summary: `問い合わせ ${inq.number} から顧客を登録${needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : ""}`, storeId: inq.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(`/customers/${customerId}/edit`, "顧客として登録しました。住所など不足している情報を補完してください。"));
}

/** 問い合わせを既存の顧客に紐づける (重複確認で同じお客様と分かったとき) */
export async function linkInquiryToCustomer(id: string, customerId: string) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertStore(user, inq.storeId, back);
    if (inq.customerId) fail(back, "すでに顧客に紐づいています。");
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail(back, "顧客が見つかりません。");
    if (!canAccessStore(user, c.storeId)) fail(back, "他店舗の顧客には紐づけられません。店舗または本部に依頼してください。");
    inq.customerId = c.id;
    inq.updatedAt = nowIso();
    for (const e of db.schedule) if (e.inquiryId === id && !e.customerId) e.customerId = c.id;
    // 問い合わせ・見積に登録済みの資料・写真も顧客にまとめる
    for (const a of db.attachments) if (a.parentType === "inquiry" && a.parentId === id && !a.customerId) a.customerId = c.id;
    db.commLogs.push({ id: newId("cl"), customerId: c.id, channel: inq.channel, direction: "inbound", subject: inq.summary, body: inq.detail || inq.summary, at: inq.receivedAt, userId: inq.createdBy, relatedType: "inquiry", relatedId: id });
    c.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `既存の顧客 ${c.code} ${c.name} に紐づけ`, storeId: inq.storeId, changes: [{ field: "customerId", before: null, after: c.id }] });
  });
  revalidatePath(back);
  redirect(withMsg(back, "既存の顧客に紐づけました。これまでの履歴とあわせて表示されます。"));
}
