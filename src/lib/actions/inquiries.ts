"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nextNumber, nowIso, nextCustomerCode } from "@/lib/db/store";
import type { Inquiry, InquiryStatus } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import { approverRole, canAccessStore, canDeleteInquiryDirect, canEditCaseStore, canRequestInquiryDelete, canRestoreInquiry, canSeeAllStores } from "@/lib/auth/permissions";
import { applyInquiryDelete, inquiryDeleteBlocker, pendingInquiryDelete, restoreInquiry } from "@/lib/inquiry-delete";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { candidateLabel, findDuplicateCustomers, needsConfirmation } from "@/lib/duplicates";
import { linkInquiryLogs } from "@/lib/ai-intake";
import { DUE_CHOICES, REQUEST_PURPOSE, dueAtFrom, dueLabel, type DueChoice } from "@/lib/inquiry-flow";
import { closeScheduleRequests, createInquiryRequest } from "@/lib/inquiry-requests";
import { addInquiryPhone, canLinkToCustomer, detachFromOtherCustomerCase, moveCaseToCustomer, moveInquiryToCustomer, relinkBlocker } from "@/lib/customer-link";
import { caseChainOf } from "@/lib/case-store";
import { addChangeNotice, caseTarget, noticeLines } from "@/lib/change-notices";
import { completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { taskNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { storeInquiryNotices, storeRequestNotices } from "@/lib/notify/store-line";
import { assertCaseStore, choice, fail, isKeyOf, requireActionUser, safeReturn, str, withMsg } from "./guards";
import { MEDIA_LABEL, isMediaKey, mapMediaText, readMediaRules } from "@/lib/media";
import { isCommonStaff } from "@/lib/staff-choices";
import { newCaseStore } from "@/lib/store-area";
import { caseForAdd, caseOptionsForCustomer, noteInquiryOnCase, type CaseAdd, type CaseOption } from "@/lib/case-choice";
import { buildCaseMap } from "@/lib/case-group";
import { withPostal } from "@/lib/postal/lookup";
import type { MediaKey } from "@/lib/db/types";

/** 媒体 (当社を知ったきっかけ) は必須。選択肢に「不明」がある */
const MEDIA_REQUIRED = "媒体 (当社を知ったきっかけ) を選んでください。お客様に聞けなかったときは「不明」を選びます。";

/** 媒体の値 (分類のコード。AI アシスタントなどから「チラシ」「紹介」のような言葉で届いたときは対応表で読み替える)。なければ fallback (既存の案件の媒体)、それもなければ断る */
function readMedia(formData: FormData, back: string, fallback?: MediaKey): MediaKey {
  const v = str(formData, "media");
  if (isMediaKey(v)) return v;
  const mapped = (v ? mapMediaText(readMediaRules(getDb()).rules, v) : null) ?? fallback;
  if (!mapped) fail(back, MEDIA_REQUIRED);
  return mapped;
}

/**
 * 手入力の問い合わせの画面で選んだお客様の案件 (進行中・最近の完了。「新規案件 / この案件に問い合わせを追加」の候補。お客様のご要望 2026-11-26「■5」)。
 * 見られないお客様は null
 */
export async function loadCustomerCases(customerId: string): Promise<{ open: CaseOption[]; past: CaseOption[]; pastTotal: number } | null> {
  const user = await requireActionUser();
  const db = getDb();
  const c = db.customers.find((x) => x.id === String(customerId ?? ""));
  if (!c || !canLinkToCustomer(db, user, c)) return null;
  return caseOptionsForCustomer(db, user, c.id, toDateKey(new Date()));
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
  const caseChoice = str(formData, "caseId");
  const addTo = caseChoice && caseChoice !== "new" ? caseChoice : "";
  const back = `/inquiries/new${str(formData, "customerId") ? `?customerId=${encodeURIComponent(str(formData, "customerId"))}${addTo ? `&caseId=${encodeURIComponent(addTo)}` : ""}` : ""}`;
  const summary = str(formData, "summary");
  if (!summary) fail(back, "問い合わせ内容 (要約) は必須です。");
  // 受付日時 (郵送で届いた日・後から入力する電話の時刻など)。省略時は現在
  const atRaw = str(formData, "receivedAt");
  const receivedAt = atRaw ? new Date(`${atRaw.length === 16 ? `${atRaw}:00` : atRaw}+09:00`) : new Date();
  if (Number.isNaN(receivedAt.getTime())) fail(back, "受付日時を正しく入力してください。");
  if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) fail(back, "受付日時に未来の日時は入力できません。");
  // 既存の案件に問い合わせを追加する (お客様のご要望 2026-11-26「■5」。問い合わせは必ず作り、caseId = 案件)
  const add0 = addTo ? caseForAdd(getDb(), user, addTo) : undefined;
  if (add0 && "error" in add0) fail(back, add0.error);
  const media = readMedia(formData, back, add0?.media);
  const promotionId = str(formData, "promotionId") || undefined;
  const id = newId("inq");
  let areaNote = "";
  let createdCode = "";
  let caseDone: { href: string; number: string; customer: string; open: boolean } | undefined;
  await mutate((db) => {
    let customer = db.customers.find((c) => c.id === str(formData, "customerId"));
    const found = addTo ? caseForAdd(db, user, addTo) : undefined;
    if (found && "error" in found) fail(back, found.error);
    const add: CaseAdd | undefined = found;
    if (add && !customer) fail(back, "既存の案件に追加するときは、その案件のお客様を「既存顧客を選択」で選んでください。");
    if (add && customer && add.customerId && add.customerId !== customer.id) fail(back, `案件 ${add.number} は、選んだお客様の案件ではありません。案件を選び直してください。`);
    // 紐付けられるお客様 = 顧客の一覧で見られるお客様 (ほかの店舗・本部で登録したお客様も。src/lib/customer-link.ts)
    if (customer && !canLinkToCustomer(db, user, customer)) fail(back, "このお客様は閲覧の範囲の外のため選べません。店舗または本部に依頼してください。");
    // 既存のお客様を選ばなかったときは、新規顧客として登録する (問い合わせは必ずお客様に紐付けて保存する。お客様のご要望 2026-11-25「問い合わせ登録時の顧客登録・紐付け」③)
    if (!customer) {
      const name = str(formData, "contactName").slice(0, 60);
      if (!name) fail(back, "お客様名を入力するか、既存顧客を選択してください。");
      const phone = str(formData, "contactPhone").slice(0, 40);
      const addr = str(formData, "address").slice(0, 200);
      const dup = findDuplicateCustomers(db, { name, phone, address: addr });
      if (needsConfirmation(dup) && str(formData, "confirmDuplicate") !== "1") fail(back, `同じお客様の可能性がある顧客があります (${candidateLabel(dup)})。同じお客様なら「既存顧客を選択」で選び、別のお客様なら「確認したうえで新規に登録する」にチェックして登録してください。`);
      const now0 = nowIso();
      const cStore = newCaseStore(db, user, { requested: str(formData, "storeId"), auto: str(formData, "storeAuto") === "1", address: addr, customer: undefined }).storeId;
      const c = {
        id: newId("cust"),
        code: nextCustomerCode(db),
        name,
        kana: "",
        type: "individual" as const,
        phone,
        postalCode: withPostal(addr, ""),
        address: addr,
        storeId: cStore,
        assignedUserId: str(formData, "assignedUserId") || user.id,
        preferredChannel: "phone" as const,
        firstContactChannel: choice(formData, "channel", CHANNEL_LABEL, "phone"),
        tags: [],
        notes: "問い合わせの登録から登録",
        createdAt: now0,
        updatedAt: now0,
      };
      db.customers.push(c);
      customer = c;
      createdCode = `${c.code} ${c.name}`;
      addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `問い合わせの登録から顧客を登録${needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : ""}`, storeId: cStore });
    }
    // 担当店舗: 手で選んだ店舗 > 住所 (入力した住所 → お客様の住所) の担当エリア > お客様の店舗 > 自店舗 (お客様のご要望 2026-11-24「③」。src/lib/store-area.ts)
    const address = str(formData, "address").slice(0, 200);
    // 施工現場の住所 (依頼主の住所と違うとき)。担当店舗の担当エリアは現場の住所で決める
    const siteAddress = str(formData, "siteAddress").replace(/\s+/g, " ").trim().slice(0, 200);
    // 既存の案件に追加: 案件の店舗 (手で選んだときは、その店舗の記録を変更できれば選んだ店舗)
    const requested = str(formData, "storeId");
    const auto = str(formData, "storeAuto") === "1";
    const pick = add ? undefined : newCaseStore(db, user, { requested, auto, address: siteAddress || address, customer });
    const storeId: Inquiry["storeId"] = add ? (!auto && requested && db.stores.some((s) => s.id === requested) && canEditCaseStore(user, requested) ? requested : add.storeId) : pick!.storeId;
    if (pick?.byArea && pick.area && storeId !== user.storeId) areaNote = ` 住所の担当エリアのため${pick.area.storeName}の担当にしました (${pick.area.storeName}に知らせます)。`;
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
      siteAddress: siteAddress && siteAddress !== (customer?.address ?? address) ? siteAddress : undefined,
      // 既存の案件に追加した問い合わせ (src/lib/case-group.ts)。問い合わせ一覧・案件の画面のどちらにも出る
      ...(add ? { caseId: add.caseId } : {}),
    };
    if (promotionId) {
      const promo = (db.promotions ?? []).find((p) => p.id === promotionId);
      if (!promo || (promo.storeId !== "hq" && !canAccessStore(user, promo.storeId))) fail(back, "きっかけの販促が見つかりません。");
      inq.promotionId = promo.id;
    }
    db.inquiries.push(inq);
    addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `問い合わせを登録 (${contactName} / ${summary} / 媒体: ${MEDIA_LABEL[media]}${add ? ` / 既存の案件 ${add.number} に追加` : ""})`, storeId });
    if (customer) {
      db.commLogs.push({ id: newId("cl"), customerId: customer.id, channel: inq.channel, direction: "inbound", subject: summary, body: inq.detail || summary, at: inq.receivedAt, userId: user.id, relatedType: "inquiry", relatedId: id });
      customer.updatedAt = now;
    }
    if (add) {
      noteInquiryOnCase(db, user.id, add, inq, { body: inq.detail, via: "手入力の問い合わせ" });
      caseDone = { href: add.href, number: add.number, customer: customer?.name ?? contactName, open: add.open };
    }
  });
  await notifyStoreGroup(id, user.id);
  revalidatePath("/inquiries");
  const inqNo = getDb().inquiries.find((x) => x.id === id)?.number ?? "";
  // 既存の案件に追加したときは案件の画面へ (案件の問い合わせ・見積・受注・予定がまとめて見える)
  if (caseDone) {
    revalidatePath(caseDone.href);
    redirect(withMsg(caseDone.href, `問い合わせ ${inqNo} を ${caseDone.customer} 様の案件 ${caseDone.number}${caseDone.open ? "" : " (完了した案件)"} に追加しました。`));
  }
  redirect(withMsg(`/inquiries/${id}`, `問い合わせを登録しました${createdCode ? ` (新規顧客 ${createdCode} も登録し、このお客様の履歴として保存しました)` : ""}。${areaNote}届いた書類・写真は下の「資料・写真」から添付できます。`));
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
    if (formData.has("siteAddress")) inq.siteAddress = str(formData, "siteAddress").replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
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
    const changes = diffChanges(before, inq, ["status", "assignedUserId", "category", "nextAction", "nextActionDue", "detail", "storeId", "media", "promotionId", "siteAddress"]);
    // 内容・施工現場の住所の変更は担当店舗・本部・管理者に知らせる (お客様のご要望 2026-11-25「⑥」)
    const noticeFields = changes.filter((c) => ["detail", "category", "siteAddress", "storeId"].includes(c.field));
    if (noticeFields.length) addChangeNotice(db, user.id, caseTarget(db, inq.id), "問い合わせの内容の変更", noticeLines(db, "inquiry", noticeFields), { alsoStores: changes.some((c) => c.field === "storeId") ? [before.storeId] : [] });
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
  // 問い合わせのお客様の登録は誰でも (問い合わせは必ずお客様に紐付けて残す。お客様のご要望 2026-11-25)。二重登録は下の重複の確認で防ぐ
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
export async function linkInquiryToCustomer(id: string, customerId: string, returnTo?: string, scope: "case" | "inquiry" = "case") {
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
    // ほかのお客様の案件に追加してあった問い合わせは、その案件から外す (付け替え先のお客様の案件ではないため。src/lib/customer-link.ts)
    const caseBefore = inq.caseId ?? null;
    const detached = detachFromOtherCustomerCase(db, inq, c.id);
    const detachNote = detached ? `既存の案件 ${detached} (前のお客様の案件) からは外しました。` : "";
    // 見積・受注のあとの案件: 見積・受注・予定もまとめて付け替える (お客様のご要望 2026-11-25「⑤」)
    // scope = inquiry: 問い合わせだけを付け替える (見積・受注は今のお客様のまま。お客様のご要望 2026-11-25「④ 問い合わせ内容だけを正しい顧客へ」)
    const chain = inq.quoteId && scope === "case" ? caseChainOf(db, inq.id) : undefined;
    if (chain && (chain.quote || chain.order)) {
      if (chain.order) {
        const lock = completedCaseLock(db, user, chain.order);
        if (lock.locked) fail(back, completedLockMessage(lock.reason));
      }
      const fromC = db.customers.find((x) => x.id === inq.customerId);
      const rc = moveCaseToCustomer(db, chain, c, user.id);
      addChangeNotice(db, user.id, caseTarget(db, inq.id), "お客様の付け替え", [{ label: "お客様", before: fromC ? `${fromC.name} 様 (${fromC.code})` : "(未登録)", after: `${c.name} 様 (${c.code})` }]);
      if (detached) addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `お客様の付け替えで既存の案件 ${detached} から外しました`, storeId: inq.storeId, changes: [{ field: "caseId", before: caseBefore, after: null }] });
      message = `案件 ${chain.head.number} (問い合わせ・見積・受注) を ${c.name} 様に付け替えました。${rc.events ? `予定 ${rc.events} 件も移しました。` : ""}${rc.removed ? `仮の顧客 (${rc.removed.code}) は記録がなくなったため削除しました。` : ""}${detachNote}`;
      return;
    }
    const before = inq.customerId ?? null;
    const fromBefore = before ? db.customers.find((x) => x.id === before) : undefined;
    const r = moveInquiryToCustomer(db, inq, c, user.id);
    c.updatedAt = nowIso();
    if (before) addChangeNotice(db, user.id, caseTarget(db, inq.id), "お客様の付け替え", [{ label: "お客様", before: fromBefore ? `${fromBefore.name} 様 (${fromBefore.code})` : "(仮の顧客)", after: `${c.name} 様 (${c.code})` }]);
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "inquiry",
      entityId: id,
      entityLabel: inq.number,
      summary: `${r.from ? `顧客を付け替え (${r.from.code} ${r.from.name} → ${c.code} ${c.name})` : `既存の顧客 ${c.code} ${c.name} に紐づけ`}${r.events ? ` · 予定 ${r.events} 件も移す` : ""}${r.removed ? ` · 仮の顧客 ${r.removed.code} を削除` : ""}`,
      storeId: inq.storeId,
      changes: [{ field: "customerId", before, after: c.id }, ...(detached ? [{ field: "caseId", before: caseBefore, after: null }] : [])],
    });
    // 問い合わせで聞いた電話番号が登録にないなら「ほかの電話番号」に足す (次からその番号でも照合できる。お客様のご要望 2026-11-24「②」)
    const added = [inq.contactPhone, inq.intake?.phone, inq.intake?.callbackPhone].map((p) => addInquiryPhone(db, user, c, p, `問い合わせ ${inq.number} で聞いた番号`)).filter(Boolean);
    message = `問い合わせ ${inq.number} を ${c.name} 様に紐づけました。${added.length ? `電話番号 ${added.join("・")} をお客様の「ほかの電話番号」に追加しました。` : ""}${r.events ? `予定 ${r.events} 件もこのお客様の予定にしました。` : ""}${r.removed ? `予定表の取込で仮に作った顧客 (${r.removed.code}) は記録がなくなったため削除しました。` : ""}これまでの履歴とあわせて表示されます。${detachNote}`;
  });
  revalidatePath(`/inquiries/${id}`);
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/schedule");
  revalidatePath("/inquiries");
  redirect(withMsg(back, message));
}

/** 問い合わせ画面・顧客画面の検索から紐づける (inquiryId・customerId・returnTo。ボタンの value で選んだ方を送る) */
export async function linkInquiryFromForm(formData: FormData) {
  await linkInquiryToCustomer(str(formData, "inquiryId"), str(formData, "customerId"), str(formData, "returnTo") || undefined, str(formData, "scope") === "inquiry" ? "inquiry" : "case");
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
 * 既存の案件に追加する (お客様のご要望 2026-11-24「追加 ④」: AI 相談などの問い合わせが、すでにある案件 (問い合わせ・見積・受注) の連絡だったとき)。
 * 2026-11-26「■4」「■5」から: 問い合わせは消さず (完了にもせず) 案件の問い合わせにする (Inquiry.caseId = 案件の ID。src/lib/case-group.ts)。
 * 問い合わせ一覧と案件の画面のどちらにも出る。内容は案件のやりとり (受注は経過メモにも) に残し、問い合わせの予定は案件の受注・見積の予定にもする (問い合わせのつながりは残す)。
 * 同じお客様の案件だけ。見積を作った問い合わせ・ほかの記録が追加されている案件の最初の問い合わせは追加しない。
 * caseKey = <種類>:<ID> (以前の形) か caseId = 案件の ID (どちらもその案件のどれかの記録の ID でよい)
 */
export async function mergeInquiryIntoCase(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  const key = str(formData, "caseKey");
  const targetRef = str(formData, "caseId") || key.split(":")[1] || "";
  if (!targetRef) fail(back, "追加する案件を選んでください。");
  let href = back;
  let label = "";
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail("/inquiries", "問い合わせが見つかりません。");
    assertCaseStore(user, inq.storeId, back);
    if (!inq.customerId) fail(back, "先にお客様を紐づけてください (同じお客様の案件に追加します)。");
    if (inq.quoteId) fail(back, "見積を作成した問い合わせは、ほかの案件に追加できません。");
    const map = buildCaseMap(db);
    const own = map.caseOf(inq.id);
    // caseKey (<種類>:<ID>) で記録を選んだときは、その記録に内容を書き残す
    const found = caseForAdd(db, user, targetRef, map, { record: !str(formData, "caseId") && key.includes(":") });
    if ("error" in found) fail(back, found.error);
    const add: CaseAdd = found;
    if (add.caseId === own) fail(back, "この問い合わせの案件です。");
    if (add.customerId !== inq.customerId) fail(back, "同じお客様の案件にだけ追加できます。");
    // この問い合わせから始まった案件にほかの記録 (追加した問い合わせ・見積・受注) があるときは、案件ごと動いてしまうので断る
    const ownMembers = own === inq.id ? map.members(own) : undefined;
    if (ownMembers && ownMembers.inquiries.length + ownMembers.quotes.length + ownMembers.orders.length > 1) fail(back, "この問い合わせの案件には、ほかの問い合わせ・見積・受注があるため、別の案件に追加できません。");
    const now = nowIso();
    label = `案件 ${add.number}`;
    href = add.href;
    // 問い合わせの内容を案件のやりとりに残す (案件のいちばん進んだ記録)
    const target = add.target;
    if (target) db.commLogs.push({ id: newId("cl"), customerId: inq.customerId, storeId: target.storeId, channel: inq.channel, direction: "inbound", subject: `問い合わせ ${inq.number}: ${inq.summary}`.slice(0, 120), body: inq.detail || inq.summary, at: inq.receivedAt, userId: user.id, relatedType: target.type, relatedId: target.id, contactName: inq.contactName });
    if (target?.type === "order") {
      const o = db.orders.find((x) => x.id === target.id)!;
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `問い合わせ ${inq.number} (${CHANNEL_LABEL[inq.channel] ?? inq.channel}) をこの案件に追加しました: ${inq.summary}${inq.detail && inq.detail !== inq.summary ? `\n${inq.detail.slice(0, 1500)}` : ""}` });
      o.updatedAt = now;
    }
    // 問い合わせの予定は、案件の受注・見積の予定にもする (受注・見積の画面に出す。問い合わせのつながり inquiryId は残す)
    const order = target?.type === "order" ? db.orders.find((x) => x.id === target.id) : undefined;
    const quote = target?.type === "quote" ? db.quotes.find((x) => x.id === target.id) : order?.quoteId ? db.quotes.find((x) => x.id === order.quoteId) : undefined;
    for (const e of db.schedule) {
      if (e.inquiryId !== inq.id || e.orderId || e.quoteId) continue;
      if (order) e.orderId = order.id;
      if (quote) e.quoteId = quote.id;
      if (order || quote) e.updatedAt = now;
    }
    const before = { caseId: inq.caseId ?? null, status: inq.status };
    inq.caseId = add.caseId;
    // 案件に入れたので「対応中」(新規のままにしない)。完了・失注は変えない
    if (inq.status === "new") inq.status = "in_progress";
    inq.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `既存の${label} (${add.title}) に追加しました`, storeId: inq.storeId, changes: [{ field: "caseId", before: before.caseId, after: add.caseId }, ...(before.status !== inq.status ? [{ field: "status", before: before.status, after: inq.status }] : [])] });
    if (target) addChangeNotice(db, user.id, caseTarget(db, target.id), "問い合わせの追加", [{ label: "問い合わせ", before: "(なし)", after: `${inq.number} ${inq.summary}`.slice(0, 200) }]);
  });
  revalidatePath(back);
  revalidatePath(href);
  revalidatePath("/inquiries");
  revalidatePath("/schedule");
  redirect(withMsg(href, `問い合わせを${label}に追加しました (問い合わせは一覧にも案件の画面にも残ります。内容はこの案件のやりとりにも残しました)。`));
}

/**
 * 問い合わせの削除 (誤って登録したもの。お客様のご要望 2026-11-25。src/lib/inquiry-delete.ts)。確認の画面 (「本当に削除しますか？」) から呼ぶ。
 * 店長以上 (店長・本部・管理者) はすぐに削除、店舗スタッフは所属店舗の店長へ削除の申請 (承認で削除)。記録は残し、通常の一覧・集計には出さない
 */
export async function deleteInquiry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const ret = safeReturn(str(formData, "returnTo"), "/inquiries");
  const reason = [str(formData, "reasonChoice"), str(formData, "reason")].filter(Boolean).join(" / ").slice(0, 200);
  const db0 = getDb();
  const inq0 = db0.inquiries.find((x) => x.id === id);
  if (!inq0) fail(ret, "問い合わせが見つかりません。");
  const direct = canDeleteInquiryDirect(user, inq0.storeId);
  if (!direct && !canRequestInquiryDelete(user, inq0.storeId)) fail(ret, "この問い合わせを削除する権限がありません (その店舗の社員・店長・本部・管理者が削除できます)。");
  if (!reason) fail(ret, "削除の理由を選んでください (例: 誤って登録)。");
  let approvalId = "";
  let role = "";
  let events = 0;
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq) fail(ret, "問い合わせが見つかりません。");
    const blocker = inquiryDeleteBlocker(db, inq);
    if (blocker) fail(ret, blocker);
    const now = nowIso();
    if (direct) {
      events = applyInquiryDelete(db, inq, { by: user.id, at: now, reason });
      addAudit(db, { userId: user.id, action: "delete", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `問い合わせを削除 (${inq.summary.slice(0, 40)} · 理由: ${reason}${events ? ` · 予定 ${events} 件もあわせて削除` : ""})`, storeId: inq.storeId, changes: [{ field: "status", before: INQUIRY_STATUS[inq.deleted!.prevStatus].label, after: "削除済み" }] });
      return;
    }
    if (pendingInquiryDelete(db, inq.id)) fail(ret, "この問い合わせはすでに削除を申請しています (店長の承認待ち)。");
    const r = approverRole(db.users, inq.storeId, false, user.id);
    role = r;
    approvalId = newId("ap");
    db.approvals.push({ id: approvalId, type: "inquiry_delete", targetId: inq.id, title: `${inq.number} ${inq.summary.slice(0, 40)}`, amount: 0, storeId: inq.storeId, requestedBy: user.id, requiredRole: r, status: "pending", requestComment: reason, createdAt: now });
    addAudit(db, { userId: user.id, action: "submit", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `問い合わせの削除を申請 (理由: ${reason})`, storeId: inq.storeId });
  });
  revalidatePath("/inquiries");
  revalidatePath("/schedule");
  if (approvalId) {
    await notifyNewApprovals([approvalId], user.id);
    redirect(withMsg(`/inquiries/${id}`, `${inq0.number} の削除を${role === "admin" ? "管理者" : "店長"}へ申請しました。承認されると削除されます。`));
  }
  redirect(withMsg(ret.startsWith(`/inquiries/${id}`) ? "/inquiries" : ret, `${inq0.number} を削除しました${events ? ` (予定 ${events} 件もあわせて削除)` : ""}。一覧には出ませんが、検索すると「削除済み」として確認できます。`));
}

/** 削除した問い合わせを元に戻す (管理者。消した予定は戻さない) */
export async function restoreDeletedInquiry(id: string) {
  const user = await requireActionUser();
  const back = `/inquiries/${id}`;
  if (!canRestoreInquiry(user)) fail(back, "削除した問い合わせを元に戻せるのは管理者です。");
  await mutate((db) => {
    const inq = db.inquiries.find((x) => x.id === id);
    if (!inq?.deleted) fail(back, "削除されていない問い合わせです。");
    const prev = inq.deleted.prevStatus;
    restoreInquiry(inq, nowIso());
    addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: "削除した問い合わせを元に戻しました", storeId: inq.storeId, changes: [{ field: "status", before: "削除済み", after: INQUIRY_STATUS[prev].label }] });
  });
  revalidatePath("/inquiries");
  redirect(withMsg(back, "問い合わせを元に戻しました (あわせて削除した予定は戻りません)。"));
}
