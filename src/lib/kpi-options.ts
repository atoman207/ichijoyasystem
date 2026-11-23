import type { Database, StoreId, User } from "@/lib/db/types";
import { scopeByStore } from "@/lib/auth/permissions";
import { compareStoreIds } from "@/lib/store-order";

/** 担当者の選択肢 (有効な社員。指定した店舗の社員を先に) */
export function staffOptions(db: Pick<Database, "users" | "stores">, storeId?: StoreId): { id: string; label: string }[] {
  const short = (id: string) => db.stores.find((s) => s.id === id)?.shortName ?? "";
  return db.users
    .filter((u) => u.active)
    .sort((a, b) => Number(b.storeId === storeId) - Number(a.storeId === storeId) || compareStoreIds(a.storeId, b.storeId) || a.kana.localeCompare(b.kana, "ja"))
    .map((u) => ({ id: u.id, label: `${u.name} (${short(u.storeId)})` }));
}

/** 案件の選択肢 (施工完了・請求済・入金済の最近の案件) */
export function recentOrderOptions(db: Database, user: User, limit = 60): { value: string; label: string }[] {
  const name = new Map(db.customers.map((c) => [c.id, c.name]));
  return scopeByStore(user, db.orders)
    .filter((o) => ["completed", "invoiced", "paid"].includes(o.status))
    .sort((a, b) => (b.salesDate ?? b.contractDate).localeCompare(a.salesDate ?? a.contractDate))
    .slice(0, limit)
    .map((o) => ({ value: o.number, label: `${name.get(o.customerId) ?? ""} 様 · ${o.title}${o.postcardNo ? ` · ハガキ ${o.postcardNo}` : ""}` }));
}

/** はがきの写真 (取込書類の元画像。案件に紐づけたときは案件の添付に移っている) */
export function surveyPhoto(db: Database, documentId: string | undefined, orderId: string | undefined) {
  if (!documentId) return undefined;
  const doc = db.documents.find((d) => d.id === documentId);
  if (!doc) return undefined;
  const onDoc = db.attachments.find((a) => a.parentType === "document" && a.parentId === doc.id);
  if (onDoc) return onDoc;
  return orderId ? db.attachments.find((a) => a.parentType === "order" && a.parentId === orderId && a.fileName === doc.fileName.slice(0, 200)) : undefined;
}
