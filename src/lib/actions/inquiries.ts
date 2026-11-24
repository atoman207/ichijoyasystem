"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nextNumber, nowIso, nextCustomerCode } from "@/lib/db/store";
import { userCanCreateCustomer } from "@/lib/ops-settings";
import type { Inquiry, InquiryStatus } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import { canAccessStore, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import { candidateLabel, findDuplicateCustomers, needsConfirmation } from "@/lib/duplicates";
import { linkInquiryLogs } from "@/lib/ai-intake";
import { DUE_CHOICES, REQUEST_PURPOSE, dueAtFrom, dueLabel, type DueChoice } from "@/lib/inquiry-flow";
import { closeScheduleRequests, createInquiryRequest } from "@/lib/inquiry-requests";
import { addInquiryPhone, canLinkToCustomer, moveInquiryToCustomer, relinkBlocker } from "@/lib/customer-link";
import { taskNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { storeInquiryNotices, storeRequestNotices } from "@/lib/notify/store-line";
import { assertCaseStore, choice, fail, isKeyOf, requireActionUser, safeReturn, str, withMsg } from "./guards";
import { MEDIA_LABEL, isMediaKey, mapMediaText, readMediaRules } from "@/lib/media";
import { isCommonStaff } from "@/lib/staff-choices";
import { newCaseStore } from "@/lib/store-area";
import { withPostal } from "@/lib/postal/lookup";
import type { MediaKey } from "@/lib/db/types";

/** 媒体 (当社を知ったきっかけ) は必須。選択肢に「不明」がある */
const MEDIA_REQUIRED = "媒体 (当社を知ったきっかけ) を選んでください。お客様に聞けなかったときは「不明」を選びます。";

/** 媒体の値 (分類のコード。AI アシスタントなどから「チラシ」「紹介」のような言葉で届いたときは対応表で読み替える)。なければ断る */
function readMedia(formData: FormData, back: string): MediaKey {
  const v = str(formData, "media");
  if (isMediaKey(v)) return v;
  const mapped = v ? mapMediaText(readMediaRules(getDb()).rules, v) : null;
  if (!mapped) fail(back, MEDIA_REQUIRED);
  return mapped;
}

/** 店舗の LINE グループ (店舗別・問い合わせを知らせる) に新しい問い合わせを送る。送れなくても問い合わせの登録は取り消さない */
async function notifyStoreGroup(id: string, userId: string) {
  const db = getDb();
  const inq = db.inquiries.find((x) => x.id === id);
  if (!inq) return;
  await sendAndRecord(storeInquiryNotices(db, inq), userId).catch((err) => console.warn("[inquiry] store LINE notice failed:", (err as Error).message));
}

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
  const media = readMedia(formData, back);
  const promotionId = str(formData, "promotionId") || undefined;
  const id = newId("inq");
  let areaNote = "";
  await mutate((db) => {
    const customer = db.customers.find((c) => c.id === str(formData, "customerId"));
    // 店舗のロールは自店舗のお客様だけを選べる (店長は全店舗のお客様)
    if (customer) assertCaseStore(user, customer.storeId, back);
    // 担当店舗: 手で選んだ店舗 > 住所 (入力した住所 → お客様の住所) の担当エリア > お客様の店舗 > 自店舗 (お客様のご要望 2026-11-24「③」。src/lib/store-area.ts)
    const address = str(formData, "address").slice(0, 200);
    const pick = newCaseStore(db, user, { requested: str(formData, "storeId"), auto: str(formData, "storeAuto") === "1", address, customer });
    const storeId = pick.storeId;
    if (pick.byArea && pick.area && storeId !== user.storeId) areaNote = ` 住所の担当エリアのため${pick.area.storeName}の担当にしました (${pick.area.storeName}に知らせます)。`;
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
      media,
      // 新規のお客様の住所 (問い合わせ一覧の住所・「顧客として登録する」に使う)
      intake: address && !customer ? { address } : undefined,
    };
    if (promotionId) {
      const promo = (db.promotions ?? []).find((p) => p.id === promotionId);
      if (!promo || (promo.storeId !== "hq" && !canAccessStore(user, promo.storeId))) fail(back, "きっかけの販促が見つかりません。");
      inq.promotionId = promo.id;
    }
    db.inquiries.push(inq);
    addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `問い合わせを登録 (${contactName} / ${summary} / 媒体: ${MEDIA_LABEL[media]})`, storeId });
    if (customer) {
      db.commLogs.push({ id: newId("cl"), customerId: customer.id, channel: inq.channel, direction: "inbound", subject: summary, body: inq.detail || summary, at: inq.receivedAt, userId: user.id, relatedType: "inquiry", relatedId: id });
      customer.updatedAt = now;
    }
  });
  await notifyStoreGroup(id, user.id);
  revalidatePath("/inquiries");
  redirect(withMsg(`/inquiries/${id}`, `問い合わせを登録しました。${areaNote}届いた書類・写真は下の「資料・写真」から添付できます。`));
}

export async function updateInquiry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  let moved = false;
  let storeMovedTo = "";
  let storeName = "";
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    // 店長はほかの店舗の問い合わせも変更できる (permissions.ts の canEditCaseStore)
    assertCaseStore(user, inq.storeId, back);
    const before = { ...inq };
    const status = str(formData, "status") as InquiryStatus;
    if (status && isKeyOf(INQUIRY_STATUS, status)) inq.status = status;
    inq.assignedUserId = str(formData, "assignedUserId") || inq.assignedUserId;
    inq.category = choice(formData, "category", CATEGORY_LABEL, inq.category);
    inq.nextAction = str(formData, "nextAction") || undefined;
    inq.nextActionDue = str(formData, "nextActionDue") || undefined;
    if (formData.has("detail")) inq.detail = str(formData, "detail");
    // 媒体は必須 (更新の画面に欄がある。わからなければ「不明」)
    if (formData.has("media")) inq.media = readMedia(formData, back);
    if (formData.has("promotionId")) {
      const pid = str(formData, "promotionId");
      const promo = pid ? (db.promotions ?? []).find((p) => p.id === pid) : undefined;
      // 選べるのは全社 (本部)・自店舗・この問い合わせの店舗の販促
      if (pid && (!promo || (promo.storeId !== "hq" && promo.storeId !== inq.storeId && !canAccessStore(user, promo.storeId)))) fail(back, "きっかけの販促が見つかりません。");
      if (promo) inq.promotionId = promo.id;
      else delete inq.promotionId;
    }
    // 担当店舗の変更 (本部・他店舗で受けた問い合わせを担当の店舗へ回す)
    const storeId = str(formData, "storeId");
    if (storeId && storeId !== inq.storeId) {
      if (!db.stores.some((s) => s.id === storeId)) fail(back, "担当店舗が正しくありません。");
      inq.storeId = storeId as Inquiry["storeId"];
      const assignee = db.users.find((u) => u.id === inq.assignedUserId);
      // 担当者が回した先の店舗の人でなければ外す (回した先の店舗で担当を決める)
      if (assignee && assignee.storeId !== inq.storeId && !canSeeAllStores(assignee) && !isCommonStaff(db, assignee)) inq.assignedUserId = undefined;
      moved = !canEditCaseStore(user, inq.storeId);
    }
    inq.updatedAt = nowIso();
    const changes = diffChanges(before, inq, ["status", "assignedUserId", "category", "nextAction", "nextActionDue", "detail", "storeId", "media", "promotionId"]);
    storeName = db.stores.find((s) => s.id === inq.storeId)?.name ?? "";
    const storeMoved = changes.some((c) => c.field === "storeId");
    if (storeMoved) storeMovedTo = inq.storeId;
    addAudit(db, { userId: user.id, action: changes.some((c) => c.field === "status") ? "status" : "update", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: storeMoved ? `問い合わせを${storeName}へ回しました` : `問い合わせを更新 (${changes.map((c) => c.field).join(", ") || "変更なし"})`, storeId: inq.storeId, changes });
  });
  // 回した先の店舗の LINE グループに知らせる (店舗別グループ・問い合わせを知らせる)
  if (storeMovedTo) await notifyStoreGroup(id, user.id);
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
    assertCaseStore(user, inq.storeId, back);
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
  if (!userCanCreateCustomer(getDb(), user)) fail(back, "顧客の新規登録は事務担当が行います。既存のお客様なら「既存の顧客に紐づける」を使うか、事務担当に登録を依頼してください。");
  let customerId = "";
  const confirmed = formData ? str(formData, "confirmDuplicate") === "1" : false;
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    if (inq.customerId) fail(back, "すでに顧客に紐づいています。");
    // 既存顧客との重複確認 (同じお客様なら「この顧客に紐づける」を使う)
    // AI 受付で受け取った項目 (ふりがな・メール・住所) も登録と重複の確認に使う
    const ik = inq.intake;
    const dup = findDuplicateCustomers(db, { name: inq.contactName, phone: inq.contactPhone, otherPhones: [ik?.phone, ik?.callbackPhone].filter((x): x is string => Boolean(x)), email: ik?.email, postalCode: ik?.postalCode, address: ik?.address });
    if (needsConfirmation(dup) && !confirmed) fail(back, `既存の顧客と重複している可能性があります (${candidateLabel(dup)})。同じお客様なら「この顧客に紐づける」を、別のお客様なら確認のチェックを入れて登録してください。`);
    const now = nowIso();
    customerId = newId("cust");
    db.customers.push({
      id: customerId,
      code: nextCustomerCode(db),
      name: inq.contactName,
      kana: ik?.kana ?? "",
      type: "individual",
      phone: inq.contactPhone ?? ik?.callbackPhone ?? ik?.phone ?? "",
      ...(ik?.email ? { email: ik.email } : {}),
      postalCode: withPostal(ik?.address, ik?.postalCode),
      address: ik?.address ?? "",
      storeId: inq.storeId,
      assignedUserId: inq.assignedUserId ?? user.id,
      // AI 受付 (電話・テキスト・音声) から登録したお客様への連絡は電話にしておく (担当者が変更できる)
      preferredChannel: inq.channel === "ai_phone" || inq.channel === "ai_chat" || inq.channel === "ai_voice" ? "phone" : inq.channel,
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
    linkInquiryLogs(db, inq, customerId);
    addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: customerId, entityLabel: inq.contactName, summary: `問い合わせ ${inq.number} から顧客を登録${needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : ""}`, storeId: inq.storeId });
  });
  revalidatePath(back);
  // 住所・電話がそろっていれば問い合わせの画面に戻る (次にやること: 依頼・日程)。足りなければ顧客の編集へ
  const created = getDb().customers.find((c) => c.id === customerId);
  if (created?.address && created.phone) redirect(withMsg(back, `新しいお客様 (${created.code} ${created.name}) として登録し、この問い合わせに紐づけました。`));
  redirect(withMsg(`/customers/${customerId}/edit`, "顧客として登録しました。住所など不足している情報を補完してください。"));
}

/**
 * 問い合わせを既存の顧客に紐づける (付け替える)。問い合わせの画面 (重複の候補・検索) と顧客の画面 (この顧客にひも付ける) で共通。
 * 予定・資料・やりとりの記録も移し、予定表の取込で仮に作った顧客に何も残らなければ消す (src/lib/customer-link.ts)
 */
export async function linkInquiryToCustomer(id: string, customerId: string, returnTo?: string) {
  const user = await requireActionUser();
  const back = safeReturn(returnTo ?? "", `/inquiries/${id}`);
  if (!customerId) fail(back, "お客様を選んでください。");
  let message = "";
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail(back, "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail(back, "顧客が見つかりません。");
    if (inq.customerId === c.id) fail(back, `すでに ${c.name} 様に紐づいています。`);
    if (!canLinkToCustomer(db, user, c)) fail(back, "このお客様は閲覧の範囲の外のため紐づけられません。店舗または本部に依頼してください。");
    if (inq.customerId) {
      const blocker = relinkBlocker(db, inq);
      if (blocker) fail(back, blocker);
    }
    const before = inq.customerId ?? null;
    const r = moveInquiryToCustomer(db, inq, c, user.id);
    c.updatedAt = nowIso();
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "inquiry",
      entityId: id,
      entityLabel: inq.number,
      summary: `${r.from ? `顧客を付け替え (${r.from.code} ${r.from.name} → ${c.code} ${c.name})` : `既存の顧客 ${c.code} ${c.name} に紐づけ`}${r.events ? ` · 予定 ${r.events} 件も移す` : ""}${r.removed ? ` · 仮の顧客 ${r.removed.code} を削除` : ""}`,
      storeId: inq.storeId,
      changes: [{ field: "customerId", before, after: c.id }],
    });
    // 問い合わせで聞いた電話番号が登録にないなら「ほかの電話番号」に足す (次からその番号でも照合できる。お客様のご要望 2026-11-24「②」)
    const added = [inq.contactPhone, inq.intake?.phone, inq.intake?.callbackPhone].map((p) => addInquiryPhone(db, user, c, p, `問い合わせ ${inq.number} で聞いた番号`)).filter(Boolean);
    message = `問い合わせ ${inq.number} を ${c.name} 様に紐づけました。${added.length ? `電話番号 ${added.join("・")} をお客様の「ほかの電話番号」に追加しました。` : ""}${r.events ? `予定 ${r.events} 件もこのお客様の予定にしました。` : ""}${r.removed ? `予定表の取込で仮に作った顧客 (${r.removed.code}) は記録がなくなったため削除しました。` : ""}これまでの履歴とあわせて表示されます。`;
  });
  revalidatePath(`/inquiries/${id}`);
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/schedule");
  revalidatePath("/inquiries");
  redirect(withMsg(back, message));
}

/** 問い合わせ画面・顧客画面の検索から紐づける (inquiryId・customerId・returnTo。ボタンの value で選んだ方を送る) */
export async function linkInquiryFromForm(formData: FormData) {
  await linkInquiryToCustomer(str(formData, "inquiryId"), str(formData, "customerId"), str(formData, "returnTo") || undefined);
}

/** 問い合わせ画面の検索プルダウンから既存顧客へ紐づける */
export async function linkInquiryToSelectedCustomer(id: string, formData: FormData) {
  await linkInquiryToCustomer(id, str(formData, "customerId"));
}

/**
 * 担当店舗・担当者への依頼 (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー ①②」)
 * 依頼先 = 店舗 (担当者を選ばなければ店舗の店長・スタッフ全員にメンション) か担当者。依頼の種類 (訪問日程の打ち合わせ・お客様へ連絡・その他) と
 * 期限 (本日 12 時まで・本日中・明日中・日時を指定) を付けて「業務依頼」を作り、メンション・メール等・店舗の LINE グループで知らせる。
 * 期限を過ぎても日程の登録・返答がなければ自動で再通知する (src/lib/inquiry-followup.ts)。ほかの店舗へ依頼すると問い合わせの担当店舗も移す
 */
export async function requestInquiry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/inquiries/${id}`);
  const purpose = choice(formData, "purpose", REQUEST_PURPOSE, "schedule");
  const assigneeId = str(formData, "assigneeId");
  const urgent = str(formData, "urgent") === "1";
  const dueChoice = choice(formData, "due", Object.fromEntries(DUE_CHOICES.map((d) => [d.id, d.label])) as Record<DueChoice, string>, "today");
  const due = dueAtFrom(dueChoice, str(formData, "dueCustom"), new Date());
  if (due.error) fail(back, due.error);
  const note = (str(formData, "note") || REQUEST_PURPOSE[purpose].text).slice(0, 2000);
  if (!note) fail(back, "依頼の内容を入力してください。");
  let threadId = "";
  let storeLabel = "";
  let targetLabel = "";
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    const storeId = str(formData, "storeId") || inq.storeId;
    const store = db.stores.find((s) => s.id === storeId);
    if (!store) fail(back, "依頼先の店舗が見つかりません。");
    if (storeId !== inq.storeId && !canSeeAllStores(user) && !canEditCaseStore(user, storeId)) fail(back, "ほかの店舗への依頼は、本部・店長が行えます。");
    const assignee = assigneeId ? db.users.find((u) => u.id === assigneeId && u.active) : undefined;
    if (assigneeId && !assignee) fail(back, "依頼先の社員が見つかりません。");
    if (assignee && assignee.storeId !== storeId && assignee.role !== "admin" && assignee.role !== "hq_staff" && !canSeeAllStores(user)) fail(back, "依頼先は、選んだ店舗の社員か本部の社員から選んでください。");
    const now = nowIso();
    const changes: { field: string; before: unknown; after: unknown }[] = [];
    // ほかの店舗へ依頼したら、問い合わせの担当店舗もその店舗にする
    if (storeId !== inq.storeId) {
      changes.push({ field: "storeId", before: inq.storeId, after: storeId });
      inq.storeId = storeId;
    }
    if (assignee && assignee.id !== inq.assignedUserId) {
      changes.push({ field: "assignedUserId", before: inq.assignedUserId ?? null, after: assignee.id });
      inq.assignedUserId = assignee.id;
    }
    if (inq.status === "new") {
      changes.push({ field: "status", before: "new", after: "in_progress" });
      inq.status = "in_progress";
    }
    inq.updatedAt = now;
    targetLabel = assignee ? `${assignee.name} さん` : `${store.name}`;
    storeLabel = store.name;
    if (changes.length) addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `${REQUEST_PURPOSE[purpose].label}を依頼 (依頼先: ${targetLabel})`, storeId: inq.storeId, changes });
    const t = createInquiryRequest(db, { inquiry: inq, requestedBy: user.id, storeId, assignee, purpose, note, dueAt: due.dueAt, urgent });
    threadId = t.id;
  });
  const db = getDb();
  const t = db.threads.find((x) => x.id === threadId);
  const inq = db.inquiries.find((x) => x.id === id);
  if (t && inq) {
    const dueText = t.dueAt ? dueLabel(t.dueAt, new Date()) : undefined;
    await sendAndRecord(
      [
        ...taskNotices(db, t, user.id, "request", note),
        ...storeRequestNotices(db, inq, { storeId: t.storeId ?? inq.storeId, what: "request", purpose: REQUEST_PURPOSE[purpose].label, note, due: dueText, from: `${user.name} → ${targetLabel}` }),
      ],
      user.id,
    ).catch((err) => console.warn("[inquiry] request notice failed:", (err as Error).message));
  }
  revalidatePath(`/inquiries/${id}`);
  revalidatePath("/inquiries");
  revalidatePath("/messages");
  redirect(withMsg(back, `${targetLabel}${t?.assigneeStoreId ? " (店舗のメンバー全員)" : ""}に「${REQUEST_PURPOSE[purpose].label}」を依頼しました${t?.dueAt ? ` (期限: ${dueLabel(t.dueAt, new Date())})` : ""}。${t?.dueAt ? "期限までに日程の登録・返答がなければ自動で再通知します。" : ""}${storeLabel && t?.assigneeStoreId ? "" : ""}`));
}

/** 以前の「担当者への引き継ぎ」の入力 (assigneeId・note・dueDate) を新しい依頼として扱う */
export async function handoffInquiry(id: string, formData: FormData) {
  const fd = new FormData();
  for (const [k, v] of formData.entries()) fd.append(k, v);
  if (!fd.has("purpose")) fd.set("purpose", "other");
  const dueDate = str(formData, "dueDate");
  if (!fd.has("due")) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      fd.set("due", "custom");
      fd.set("dueCustom", `${dueDate}T23:59`);
    } else fd.set("due", "none");
  }
  await requestInquiry(id, fd);
}

/**
 * お客様都合で日程未定にする (お客様のご要望 2026-11-24「⑤」)。理由と次回の連絡予定日 (任意) を残し、日程の打ち合わせの依頼は完了にする。
 * 次回の連絡予定日の朝に担当者へ知らせる。予定 (日程) を登録すると自動で外れる
 */
export async function setInquiryScheduleHold(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/inquiries/${id}`);
  const reason = (str(formData, "reason") || "お客様都合により日程未定").slice(0, 200);
  const nextContact = str(formData, "nextContact");
  const today = toDateKey(new Date());
  if (nextContact && (!/^\d{4}-\d{2}-\d{2}$/.test(nextContact) || nextContact < today)) fail(back, "次回の連絡予定日は今日以降の日付にしてください。");
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    const before = inq.scheduleHold ?? null;
    inq.scheduleHold = { at: nowIso(), by: user.id, reason, ...(nextContact ? { nextContact } : {}) };
    const prevAction = { nextAction: inq.nextAction ?? null, nextActionDue: inq.nextActionDue ?? null };
    inq.nextAction = nextContact ? "お客様に日程の連絡" : "お客様からの日程の連絡待ち";
    inq.nextActionDue = nextContact || undefined;
    if (inq.status === "new") inq.status = "in_progress";
    inq.updatedAt = nowIso();
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "inquiry",
      entityId: inq.id,
      entityLabel: inq.number,
      summary: `日程未定にしました (${reason}${nextContact ? ` / 次回の連絡 ${nextContact}` : ""})`,
      storeId: inq.storeId,
      changes: [
        { field: "scheduleHold", before, after: inq.scheduleHold },
        { field: "nextActionDue", before: prevAction.nextActionDue, after: inq.nextActionDue ?? null },
      ],
    });
    closeScheduleRequests(db, inq.id, user.id, `${reason}${nextContact ? ` (次回の連絡 ${Number(nextContact.slice(5, 7))}/${Number(nextContact.slice(8, 10))})` : ""}`);
  });
  revalidatePath(`/inquiries/${id}`);
  revalidatePath("/inquiries");
  redirect(withMsg(back, `日程未定 (${reason}) にしました。${nextContact ? `次回の連絡予定日 (${nextContact}) の朝に担当者へ知らせます。` : ""}日程が決まったら「日程を登録」で予定に入れてください。`));
}

/** 日程未定を外す (日程の打ち合わせを再開する) */
export async function clearInquiryScheduleHold(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/inquiries/${id}`);
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    if (!inq.scheduleHold) fail(back, "日程未定ではありません。");
    const before = inq.scheduleHold;
    inq.scheduleHold = undefined;
    inq.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: "日程未定を外しました (日程の打ち合わせを再開)", storeId: inq.storeId, changes: [{ field: "scheduleHold", before, after: null }] });
  });
  revalidatePath(`/inquiries/${id}`);
  revalidatePath("/inquiries");
  redirect(withMsg(back, "日程未定を外しました。"));
}

/**
 * 既存の案件にまとめる (お客様のご要望 2026-11-24「追加 ④」: AI 相談などの問い合わせが、すでにある案件 (問い合わせ・見積・受注) の連絡だったとき)。
 * 問い合わせの内容を案件のやりとり (受注は経過メモにも) に残し、問い合わせの予定は案件の予定にして、問い合わせは「完了」(結果 = まとめた案件) にする。
 * 同じお客様の案件だけ。見積を作った問い合わせはまとめない
 */
export async function mergeInquiryIntoCase(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  const key = str(formData, "caseKey");
  const [type, targetId] = key.split(":");
  if (!targetId || (type !== "inquiry" && type !== "quote" && type !== "order")) fail(back, "まとめる案件を選んでください。");
  let href = back;
  let label = "";
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    if (!inq.customerId) fail(back, "先にお客様を紐づけてください (同じお客様の案件にまとめます)。");
    if (inq.quoteId) fail(back, "見積を作成した問い合わせは、ほかの案件にまとめられません。");
    if (type === "inquiry" && targetId === inq.id) fail(back, "同じ問い合わせです。");
    const target = type === "order" ? db.orders.find((x) => x.id === targetId) : type === "quote" ? db.quotes.find((x) => x.id === targetId) : db.inquiries.find((x) => x.id === targetId);
    if (!target) fail(back, "まとめる案件が見つかりません。");
    if (target.customerId !== inq.customerId) fail(back, "同じお客様の案件にだけまとめられます。");
    if (!canEditCaseStore(user, target.storeId)) fail(back, "この案件の店舗の記録を変更する権限がありません。");
    const now = nowIso();
    label = `${type === "order" ? "受注" : type === "quote" ? "見積" : "問い合わせ"} ${target.number}`;
    href = `/${type === "order" ? "orders" : type === "quote" ? "quotes" : "inquiries"}/${target.id}`;
    // 問い合わせの内容を案件のやりとりに残す
    db.commLogs.push({ id: newId("cl"), customerId: inq.customerId, storeId: target.storeId, channel: inq.channel, direction: "inbound", subject: `問い合わせ ${inq.number}: ${inq.summary}`.slice(0, 120), body: inq.detail || inq.summary, at: inq.receivedAt, userId: user.id, relatedType: type, relatedId: target.id, contactName: inq.contactName });
    if (type === "order") {
      const o = db.orders.find((x) => x.id === targetId)!;
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `問い合わせ ${inq.number} (${CHANNEL_LABEL[inq.channel] ?? inq.channel}) をこの案件にまとめました: ${inq.summary}${inq.detail && inq.detail !== inq.summary ? `\n${inq.detail.slice(0, 1500)}` : ""}` });
      o.updatedAt = now;
    }
    // 問い合わせの予定は、まとめた案件の予定にする
    const order = type === "order" ? db.orders.find((x) => x.id === targetId) : undefined;
    const quote = type === "quote" ? db.quotes.find((x) => x.id === targetId) : order?.quoteId ? db.quotes.find((x) => x.id === order.quoteId) : undefined;
    const caseIds = { orderId: order?.id, quoteId: quote?.id, inquiryId: type === "inquiry" ? targetId : quote?.inquiryId };
    for (const e of db.schedule) {
      if (e.inquiryId !== inq.id) continue;
      e.orderId = caseIds.orderId;
      e.quoteId = caseIds.quoteId;
      e.inquiryId = caseIds.inquiryId;
      e.updatedAt = now;
    }
    closeScheduleRequests(db, inq.id, user.id, `既存の案件 ${label} にまとめました`);
    const before = { status: inq.status, result: inq.result ?? null };
    inq.status = "closed";
    inq.result = `既存の案件 ${label} にまとめました`;
    inq.nextAction = undefined;
    inq.nextActionDue = undefined;
    inq.scheduleHold = undefined;
    inq.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `既存の案件 ${label} にまとめました`, storeId: inq.storeId, changes: [{ field: "status", before: before.status, after: "closed" }, { field: "result", before: before.result, after: inq.result }] });
  });
  revalidatePath(back);
  revalidatePath(href);
  revalidatePath("/inquiries");
  redirect(withMsg(href, `問い合わせを ${label} にまとめました (内容はこの案件のやりとりに残しました)。`));
}
