"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso, nextCustomerCode } from "@/lib/db/store";
import type { Channel, Customer, CustomerType, Database, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { candidateLabel, findDuplicateCustomers, needsConfirmation, type DuplicateInput, type DuplicateResult } from "@/lib/duplicates";
import { CHANNEL_LABEL } from "@/lib/constants";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, safeReturn, str, withMsg } from "./guards";

function parseTags(s: string): string[] {
  return s.split(/[,、\s]+/).map((t) => t.trim()).filter(Boolean);
}

/** 重複候補の表示用 (他店舗の顧客は、閲覧権限がなければリンクを付けない) */
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
    href: canAccessStore(user, m.storeId) ? `/customers/${m.id}` : undefined,
  });
  return { rows: [...r.high.map(row("high")), ...r.check.map(row("check")), ...r.sameName.map(row("name"))], blocking: needsConfirmation(r), sameNameTotal: r.sameNameTotal };
}

function duplicateInput(formData: FormData): DuplicateInput {
  return { name: str(formData, "name"), kana: str(formData, "kana"), phone: str(formData, "phone"), email: str(formData, "email"), postalCode: str(formData, "postalCode"), address: str(formData, "address") };
}

/** 顧客登録・編集の画面から呼ぶ: 入力中の内容と既存顧客 (全店舗) の重複候補 */
export async function checkCustomerDuplicates(input: DuplicateInput, excludeId?: string): Promise<DuplicateReport> {
  const user = await requireActionUser();
  const db = getDb();
  const clean = (v: unknown) => String(v ?? "").slice(0, 200);
  const r = findDuplicateCustomers(db, { name: clean(input.name), kana: clean(input.kana), phone: clean(input.phone), email: clean(input.email), postalCode: clean(input.postalCode), address: clean(input.address) }, excludeId);
  return toReport(db, user, r);
}

export async function createCustomer(formData: FormData) {
  const user = await requireActionUser();
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
    };
    db.customers.push(c);
    addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: id, entityLabel: `${c.code} ${c.name}`, summary: `顧客を登録 (${c.name})${dupNote}`, storeId });
  });
  revalidatePath("/customers");
  redirect(withMsg(`/customers/${id}`, "顧客を登録しました。関連する画面にも即時反映されます。"));
}

export async function updateCustomer(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/customers/${id}/edit`;
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === id);
    if (!c) fail("/customers", "顧客が見つかりません。");
    assertStore(user, c.storeId, back);
    const before = { ...c };
    c.name = str(formData, "name") || c.name;
    c.kana = str(formData, "kana");
    c.type = choice(formData, "type", ["individual", "corporate"] as const, c.type);
    c.phone = str(formData, "phone");
    c.email = str(formData, "email") || undefined;
    c.lineId = str(formData, "lineId") || undefined;
    c.postalCode = str(formData, "postalCode");
    c.address = str(formData, "address");
    c.storeId = resolveStoreId(user, str(formData, "storeId"), c.storeId);
    c.assignedUserId = str(formData, "assignedUserId") || c.assignedUserId;
    c.preferredChannel = choice(formData, "preferredChannel", CHANNEL_LABEL, c.preferredChannel);
    c.tags = parseTags(str(formData, "tags"));
    c.notes = str(formData, "notes");
    c.updatedAt = nowIso();
    const changes = diffChanges(before, c, ["name", "kana", "type", "phone", "email", "lineId", "postalCode", "address", "storeId", "assignedUserId", "preferredChannel", "tags", "notes"]);
    addAudit(db, { userId: user.id, action: "update", entity: "customer", entityId: id, entityLabel: `${c.code} ${c.name}`, summary: `顧客情報を更新 (${changes.map((x) => x.field).join(", ") || "変更なし"})`, storeId: c.storeId, changes });
  });
  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  redirect(withMsg(`/customers/${id}`, "顧客情報を更新しました。関連する問い合わせ・見積・案件にも反映されます。"));
}

export async function addCommLog(customerId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/customers/${customerId}`;
  const body = str(formData, "body");
  if (!body) fail(back, "対応内容を入力してください。");
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail("/customers", "顧客が見つかりません。");
    assertStore(user, c.storeId, back);
    db.commLogs.push({
      id: newId("cl"),
      customerId,
      channel: choice(formData, "channel", CHANNEL_LABEL, "phone"),
      direction: str(formData, "direction") === "inbound" ? "inbound" : "outbound",
      subject: str(formData, "subject") || body.slice(0, 20),
      body,
      at: nowIso(),
      userId: user.id,
      relatedType: (str(formData, "relatedType") || undefined) as never,
      relatedId: str(formData, "relatedId") || undefined,
    });
    c.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: customerId, entityLabel: `${c.code} ${c.name}`, summary: `対応履歴を記録 (${str(formData, "channel")})`, storeId: c.storeId });
  });
  revalidatePath(back);
  const returnTo = safeReturn(str(formData, "returnTo"), back);
  redirect(withMsg(returnTo, "対応履歴を記録しました。"));
}
