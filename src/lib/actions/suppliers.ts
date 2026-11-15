"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nowIso } from "@/lib/db/store";
import type { Supplier } from "@/lib/db/types";
import { canEditSuppliers } from "@/lib/auth/permissions";
import { SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { fieldLabel } from "@/lib/field-labels";
import { choice, fail, numField, requireActionUser, str, withMsg } from "./guards";

const FIELDS: (keyof Supplier)[] = ["name", "kana", "kind", "category", "contactName", "phone", "fax", "email", "postalCode", "address", "paymentTerms", "closingDay", "payMonthOffset", "payDay", "bankInfo", "registrationNumber", "lineId", "chatworkRoomId", "notes", "active"];

/** フォームの取引先の項目 */
function readSupplier(formData: FormData, back: string): Omit<Supplier, "id" | "createdAt" | "updatedAt"> {
  const name = str(formData, "name");
  if (!name) fail(back, "名前を入力してください。");
  const day = (key: string): number | undefined => {
    const raw = str(formData, key);
    if (!raw) return undefined;
    const n = Math.round(numField(formData, key));
    if (n < 1 || n > 31) fail(back, "締め日・支払日は 1〜31 (31 = 末日) で入力してください。");
    return n;
  };
  const offsetRaw = str(formData, "payMonthOffset");
  const payMonthOffset = offsetRaw === "" ? undefined : Number(offsetRaw);
  if (payMonthOffset !== undefined && ![0, 1, 2, 3].includes(payMonthOffset)) fail(back, "支払月を選んでください。");
  const payDay = day("payDay");
  if ((payMonthOffset === undefined) !== (payDay === undefined)) fail(back, "支払月と支払日は両方を入力してください (都度払いのときは両方を空欄にし、支払条件に「都度払い」と書きます)。");
  const reg = str(formData, "registrationNumber").normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
  if (reg && !/^T\d{13}$/.test(reg)) fail(back, "登録番号は T と 13 桁の数字で入力してください。");
  const lineId = str(formData, "lineId");
  if (lineId && !/^U[0-9a-f]{32}$/.test(lineId)) fail(back, "LINE のユーザー ID は U で始まる 33 文字です (Messaging API の Webhook で分かる ID)。");
  const room = str(formData, "chatworkRoomId");
  if (room && !/^\d+$/.test(room)) fail(back, "Chatwork のルーム ID は数字です (ルームの URL の rid の後ろの数字)。");
  return {
    name: name.slice(0, 100),
    kana: str(formData, "kana") || undefined,
    kind: choice(formData, "kind", SUPPLIER_KIND_LABEL, "supplier"),
    category: str(formData, "category") || "未分類",
    contactName: str(formData, "contactName") || undefined,
    phone: str(formData, "phone") || undefined,
    fax: str(formData, "fax") || undefined,
    email: str(formData, "email") || undefined,
    postalCode: str(formData, "postalCode") || undefined,
    address: str(formData, "address") || undefined,
    paymentTerms: str(formData, "paymentTerms"),
    closingDay: day("closingDay") ?? 31,
    payMonthOffset,
    payDay,
    bankInfo: str(formData, "bankInfo") || undefined,
    registrationNumber: reg || undefined,
    lineId: lineId || undefined,
    chatworkRoomId: room || undefined,
    notes: str(formData, "notes") || undefined,
    // チェックボックス (on) と、外したときの hidden (off) の両方が届く。on があれば取引中
    active: formData.has("active") ? formData.getAll("active").map(String).includes("on") : true,
  };
}

export async function createSupplier(formData: FormData) {
  const user = await requireActionUser();
  const back = "/suppliers";
  if (!canEditSuppliers(user)) fail(back, "仕入先・協力業者の登録は本部・管理者が行います。");
  const s0 = readSupplier(formData, back);
  const id = newId("sup");
  await mutate((db) => {
    if (db.suppliers.some((s) => s.name === s0.name)) fail(back, `「${s0.name}」はすでに登録されています。`);
    const now = nowIso();
    db.suppliers.push({ id, ...s0, createdAt: now, updatedAt: now });
    addAudit(db, { userId: user.id, action: "create", entity: "supplier", entityId: id, entityLabel: s0.name, summary: `${SUPPLIER_KIND_LABEL[s0.kind ?? "supplier"]}を登録 (${s0.name})`, storeId: "hq" });
  });
  revalidatePath("/suppliers");
  redirect(withMsg(`/suppliers/${id}`, `${SUPPLIER_KIND_LABEL[s0.kind ?? "supplier"]}を登録しました。`));
}

export async function updateSupplier(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/suppliers/${id}`;
  if (!canEditSuppliers(user)) fail(back, "仕入先・協力業者の変更は本部・管理者が行います。");
  const next = readSupplier(formData, back);
  await mutate((db) => {
    const s = db.suppliers.find((x) => x.id === id);
    if (!s) fail("/suppliers", "取引先が見つかりません。");
    if (db.suppliers.some((x) => x.id !== id && x.name === next.name)) fail(back, `「${next.name}」は別の取引先として登録されています。`);
    const before = { ...s };
    Object.assign(s, next);
    const changes = diffChanges(before, s, FIELDS);
    if (!changes.length) fail(back, "変更はありませんでした。");
    s.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "supplier", entityId: id, entityLabel: s.name, summary: `取引先の情報を変更 (${changes.map((c) => fieldLabel("supplier", c.field)).join("・")})`, storeId: "hq", changes });
  });
  revalidatePath("/suppliers");
  revalidatePath(back);
  redirect(withMsg(back, "取引先の情報を変更しました。"));
}
