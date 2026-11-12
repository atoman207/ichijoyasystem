import "server-only";
import type { Database, User } from "@/lib/db/types";
import { scopeByStore } from "@/lib/auth/permissions";
import { caseValue, selectableCases, type CaseRef } from "@/lib/db/schedule";
import type { FormCase, FormCustomer } from "./EventForm";
import type { FormStore, FormUser } from "./form-parts";

/** 予定の入力フォームに渡す選択肢 (クライアントへ渡すため必要な項目だけに絞る) */

export function formUsers(db: Database): FormUser[] {
  return db.users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, title: u.title, storeId: u.storeId }));
}

export function formStores(db: Database): FormStore[] {
  return db.stores.map((s) => ({ id: s.id, name: s.name, shortName: s.shortName, color: s.color }));
}

export function toFormCase(db: Database, c: CaseRef): FormCase {
  const store = db.stores.find((s) => s.id === c.storeId);
  return {
    value: caseValue(c),
    label: `${c.stage} ${c.number} ${c.customerName ? `${c.customerName} 様 ` : ""}${c.title}${store ? ` (${store.shortName})` : ""}${c.pending ? " ・契約承認待ち" : ""}`,
    stage: c.stage,
    number: c.number,
    storeId: c.storeId,
    customerId: c.customerId,
    customerName: c.customerName,
    location: c.location,
    assigneeIds: c.assigneeIds,
    href: c.href,
  };
}

export function formCases(db: Database, user: User): FormCase[] {
  return selectableCases(db, user).map((c) => toFormCase(db, c));
}

export function formCustomers(db: Database, user: User): FormCustomer[] {
  return scopeByStore(user, db.customers)
    .slice()
    .sort((a, b) => a.kana.localeCompare(b.kana, "ja"))
    .map((c) => ({ id: c.id, name: c.name, storeId: c.storeId, address: c.address || undefined }));
}
