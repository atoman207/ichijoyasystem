"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso, nextCustomerCode } from "@/lib/db/store";
import type { Customer, Database, User } from "@/lib/db/types";
import { approverRole, canApplyCustomerChange, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import { candidateLabel, findDuplicateCustomers, needsConfirmation, type DuplicateInput, type DuplicateResult } from "@/lib/duplicates";
import { userCanCreateCustomer } from "@/lib/ops-settings";
import { CHANNEL_LABEL } from "@/lib/constants";
import { approvalSettings, CUSTOMER_IMPORTANT_FIELDS } from "@/lib/approval-rules";
import { fieldLabel } from "@/lib/field-labels";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { contactLine, parseContacts } from "@/lib/customer-contacts";
import { assertCaseStore, assertStore, choice, fail, requireActionUser, resolveStoreId, safeReturn, str, withMsg } from "./guards";
import { propagateCustomerAddress } from "@/lib/maps/store";

function parseTags(s: string): string[] {
  return s.split(/[,、\s]+/).map((t) => t.trim()).filter(Boolean);
}

/** 重複候補の表示用 (他店舗の顧客は、変更できる店舗でなければリンクを付けない。店長は全店舗) */
export interface DuplicateRow {
  id: string;
  code: string;
  name: string;
  storeName: string;
  area?: string;
  reasons: string[];
  level: "high" | "check" | "name";
  href?: string;
}
export interface DuplicateReport {
  rows: DuplicateRow[];
  /** 確認のうえで登録する必要があるか */
  blocking: boolean;
  sameNameTotal: number;
}

function toReport(db: Database, user: User, r: DuplicateResult): DuplicateReport {
  const store = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const row = (level: DuplicateRow["level"]) => (m: DuplicateResult["high"][number]): DuplicateRow => ({
    id: m.id,
    code: m.code,
    name: m.name,
    storeName: store(m.storeId),
    area: m.area,
    reasons: m.reasons,
    level,
    href: canEditCaseStore(user, m.storeId) ? `/customers/${m.id}` : undefined,
  });
  return { rows: [...r.high.map(row("high")), ...r.check.map(row("check")), ...r.sameName.map(row("name"))], blocking: needsConfirmation(r), sameNameTotal: r.sameNameTotal };
}

function duplicateInput(formData: FormData): DuplicateInput {
  return { name: str(formData, "name"), kana: str(formData, "kana"), phone: str(formData, "phone"), email: str(formData, "email"), postalCode: str(formData, "postalCode"), address: str(formData, "address"), otherPhones: parseContacts(str(formData, "contacts"), () => "x").map((c) => c.phone) };
}

const contactsOf = (formData: FormData) => parseContacts(str(formData, "contacts"), () => newId("cc"));
/** 変更履歴用 (連絡先は 1 件 1 行の文字にする) */
const contactLines = (c: Pick<Customer, "contacts">) => (c.contacts ?? []).map(contactLine);

/** 顧客登録・編集の画面から呼ぶ: 入力中の内容と既存顧客 (全店舗) の重複候補 */
export async function checkCustomerDuplicates(input: DuplicateInput, excludeId?: string): Promise<DuplicateReport> {
  const user = await requireActionUser();
  const db = getDb();
  const clean = (v: unknown) => String(v ?? "").slice(0, 200);
  const r = findDuplicateCustomers(db, { name: clean(input.name), kana: clean(input.kana), phone: clean(input.phone), email: clean(input.email), postalCode: clean(input.postalCode), address: clean(input.address), otherPhones: Array.isArray(input.otherPhones) ? input.otherPhones.slice(0, 20).map(clean) : [] }, excludeId);
  return toReport(db, user, r);
}

export async function createCustomer(formData: FormData) {
  const user = await requireActionUser();
  if (!userCanCreateCustomer(getDb(), user)) fail("/customers/new", "顧客の新規登録は事務担当が行います (設定で店長にも許可できます)。事務担当に登録を依頼してください。");
  const name = str(formData, "name");
  if (!name) fail("/customers/new", "氏名・会社名は必須です。");
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  assertStore(user, storeId, "/customers/new");
  const id = newId("cust");
  const confirmed = str(formData, "confirmDuplicate") === "1";
  await mutate((db) => {
    // 既存顧客との重複確認 (画面で確認済みでなければ登録しない)
    const dup = findDuplicateCustomers(db, duplicateInput(formData));
    if (needsConfirmation(dup) && !confirmed) {
      fail("/customers/new", `既存の顧客と重複している可能性があります (${candidateLabel(dup)})。同じお客様でないことを確認し、「確認したうえで新規に登録する」にチェックしてください。`);
    }
    const dupNote = needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : "";
    const code = nextCustomerCode(db);
    const now = nowIso();
    const c: Customer = {
      id,
      code,
      name,
      kana: str(formData, "kana"),
      type: choice(formData, "type", ["individual", "corporate"] as const, "individual"),
      phone: str(formData, "phone"),
      email: str(formData, "email") || undefined,
      lineId: str(formData, "lineId") || undefined,
      postalCode: str(formData, "postalCode"),
      address: str(formData, "address"),
      storeId,
      assignedUserId: str(formData, "assignedUserId") || user.id,
      preferredChannel: choice(formData, "preferredChannel", CHANNEL_LABEL, "phone"),
      firstContactChannel: choice(formData, "firstContactChannel", CHANNEL_LABEL, "phone"),
      tags: parseTags(str(formData, "tags")),
      notes: str(formData, "notes"),
      createdAt: now,
      updatedAt: now,
      contacts: contactsOf(formData),
      tradeStopped: str(formData, "tradeStopped") === "1" || undefined,
      tradeStopNote: str(formData, "tradeStopNote") || undefined,
    };
    if (!c.contacts?.length) delete c.contacts;
    db.customers.push(c);
    addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: id, entityLabel: `${c.code} ${c.name}`, summary: `顧客を登録 (${c.name})${dupNote}`, storeId });
  });
  revalidatePath("/customers");
  const returnTo = safeReturn(str(formData, "returnTo"), "");
  if (returnTo) redirect(withMsg(`${returnTo}${returnTo.includes("?") ? "&" : "?"}customerId=${id}`, "顧客を登録しました。"));
  redirect(withMsg(`/customers/${id}`, "顧客を登録しました。関連する画面にも即時反映されます。"));
}

/**
 * 顧客情報の更新。
 * 重要な情報 (氏名・フリガナ・区分・電話・メール・郵便番号・住所) の変更は、設定 → 承認ルール で承認が必要なとき、
 * その店舗の店長・管理者以外の変更を「顧客の重要情報の変更」の承認依頼にする (承認されたら反映)。ほかの項目はすぐに反映する
 */
export async function updateCustomer(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/customers/${id}/edit`;
  let message = "顧客情報を更新しました。関連する問い合わせ・見積・案件にも反映されます。";
  let approvalId = "";
  let propagated = { orders: 0, events: 0 };
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === id);
    if (!c) fail("/customers", "顧客が見つかりません。");
    // 店長はほかの店舗のお客様も変更できる (permissions.ts の canEditCaseStore)
    assertCaseStore(user, c.storeId, back);
    const before = { ...c };
    const next: Customer = {
      ...c,
      name: str(formData, "name") || c.name,
      kana: str(formData, "kana"),
      type: choice(formData, "type", ["individual", "corporate"] as const, c.type),
      phone: str(formData, "phone"),
      email: str(formData, "email") || undefined,
      lineId: str(formData, "lineId") || undefined,
      postalCode: str(formData, "postalCode"),
      address: str(formData, "address"),
      // 担当店舗の変更は全店舗ロールだけ (店長がほかの店舗のお客様を変更しても、お客様の店舗は変えない)
      storeId: canSeeAllStores(user) ? resolveStoreId(user, str(formData, "storeId"), c.storeId) : c.storeId,
      assignedUserId: str(formData, "assignedUserId") || c.assignedUserId,
      preferredChannel: choice(formData, "preferredChannel", CHANNEL_LABEL, c.preferredChannel),
      tags: parseTags(str(formData, "tags")),
      notes: str(formData, "notes"),
      contacts: formData.has("contacts") ? contactsOf(formData) : c.contacts,
      tradeStopped: str(formData, "tradeStopped") === "1" || undefined,
      tradeStopNote: str(formData, "tradeStopNote") || undefined,
    };
    if (!next.contacts?.length) next.contacts = undefined;
    const important = diffChanges(before, next, [...CUSTOMER_IMPORTANT_FIELDS]);
    const needsApproval = important.length > 0 && approvalSettings(db).customerChange && !canApplyCustomerChange(user, c.storeId);
    if (needsApproval && db.approvals.some((a) => a.type === "customer_change" && a.targetId === c.id && a.status === "pending")) {
      fail(back, "このお客様には承認待ちの変更があります。承認・差戻しの後にもう一度変更してください。");
    }
    // 承認が必要な項目は元の値のまま残し、ほかの項目だけをすぐに反映する
    const applied: Customer = needsApproval ? { ...next, ...Object.fromEntries(CUSTOMER_IMPORTANT_FIELDS.map((f) => [f, before[f]])) } : next;
    Object.assign(c, applied);
    // 住所が変わったら、施工場所がお客様の住所と同じ進行中の受注と、お客様の場所に合わせている今後の予定にも反映する
    if (before.address !== c.address) propagated = propagateCustomerAddress(db, user, c, before.address);
    const changes = diffChanges(before, c, ["name", "kana", "type", "phone", "email", "lineId", "postalCode", "address", "storeId", "assignedUserId", "preferredChannel", "tags", "notes", "tradeStopped", "tradeStopNote"]);
    const contactsBefore = contactLines(before);
    const contactsAfter = contactLines(c);
    if (JSON.stringify(contactsBefore) !== JSON.stringify(contactsAfter)) changes.push({ field: "contacts", before: contactsBefore, after: contactsAfter });
    if (changes.length) {
      c.updatedAt = nowIso();
      addAudit(db, { userId: user.id, action: "update", entity: "customer", entityId: id, entityLabel: `${c.code} ${c.name}`, summary: `顧客情報を更新 (${changes.map((x) => fieldLabel("customer", x.field)).join("・")})`, storeId: c.storeId, changes });
    }
    if (needsApproval) {
      const role = approverRole(db.users, c.storeId, false, user.id);
      approvalId = newId("ap");
      db.approvals.push({
        id: approvalId,
        type: "customer_change",
        targetId: c.id,
        title: `${c.code} ${before.name} 様`,
        amount: 0,
        storeId: c.storeId,
        requestedBy: user.id,
        requiredRole: role,
        status: "pending",
        requestComment: str(formData, "changeReason") || undefined,
        changes: important,
        createdAt: nowIso(),
      });
      addAudit(db, { userId: user.id, action: "submit", entity: "customer", entityId: id, entityLabel: `${c.code} ${before.name}`, summary: `顧客の重要情報の変更を申請 (${important.map((x) => fieldLabel("customer", x.field)).join("・")} / ${role === "admin" ? "管理者" : "店長"}承認)`, storeId: c.storeId, changes: important });
      message = `${important.map((x) => fieldLabel("customer", x.field)).join("・")} の変更を${role === "admin" ? "管理者" : "店長"}へ申請しました。承認後に反映されます。${changes.length ? "そのほかの項目は反映しました。" : ""}`;
    } else if (!changes.length) {
      fail(back, "変更はありませんでした。");
    }
  });
  await notifyNewApprovals(approvalId ? [approvalId] : [], user.id);
  if (propagated.orders || propagated.events) message += ` 新しい住所を進行中の案件 ${propagated.orders} 件・今後の予定 ${propagated.events} 件にも反映しました (個別に場所を指定した予定は変えていません)。`;
  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  if (propagated.orders || propagated.events) revalidatePath("/", "layout");
  redirect(withMsg(`/customers/${id}`, message));
}

const RELATED_TYPES = ["inquiry", "quote", "order", "invoice"] as const;

export async function addCommLog(customerId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/customers/${customerId}`;
  const body = str(formData, "body");
  if (!body) fail(back, "対応内容を入力してください。");
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail("/customers", "顧客が見つかりません。");
    assertCaseStore(user, c.storeId, back);
    const relatedType = choice(formData, "relatedType", [...RELATED_TYPES, ""] as const, "") || undefined;
    const relatedId = relatedType ? str(formData, "relatedId") || undefined : undefined;
    const channel = choice(formData, "channel", CHANNEL_LABEL, "phone");
    db.commLogs.push({
      id: newId("cl"),
      customerId,
      storeId: c.storeId,
      channel,
      direction: str(formData, "direction") === "inbound" ? "inbound" : "outbound",
      subject: str(formData, "subject") || body.slice(0, 20),
      body,
      at: nowIso(),
      userId: user.id,
      relatedType,
      relatedId,
      contactName: str(formData, "contactName") || undefined,
    });
    c.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "create", entity: "comm", entityId: customerId, entityLabel: `${c.code} ${c.name}`, summary: `やりとりを記録 (${CHANNEL_LABEL[channel]} / ${str(formData, "subject") || body.slice(0, 20)})`, storeId: c.storeId });
  });
  revalidatePath(back);
  const returnTo = safeReturn(str(formData, "returnTo"), back);
  redirect(withMsg(returnTo, "対応履歴を記録しました。"));
}
