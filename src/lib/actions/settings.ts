"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId } from "@/lib/db/store";
import type { Role, ServiceCategory, StoreId } from "@/lib/db/types";
import { canManageSettings } from "@/lib/auth/permissions";
import { CATEGORY_LABEL, ROLE_LABEL } from "@/lib/constants";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { choice, fail, isKeyOf, numField, requireActionUser, str, withMsg } from "./guards";

async function requireAdmin(back: string) {
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "この操作は管理者のみ実行できます。");
  return user;
}

export async function createUser(formData: FormData) {
  const back = "/settings?tab=users";
  const admin = await requireAdmin(back);
  const name = str(formData, "name");
  const email = str(formData, "email").toLowerCase();
  const password = str(formData, "password");
  if (!name || !email) fail(back, "氏名とログイン ID は必須です。");
  if (password.length < 8) fail(back, "初期パスワードは 8 文字以上で入力してください。");
  const role = str(formData, "role") || "store_staff";
  if (!isKeyOf(ROLE_LABEL, role)) fail(back, "ロールが正しくありません。");
  await mutate((db) => {
    if (db.users.some((u) => u.email.toLowerCase() === email)) fail(back, "同じログイン ID のユーザーが存在します。");
    const storeId = (str(formData, "storeId") || "koshi") as StoreId;
    if (!db.stores.some((s) => s.id === storeId)) fail(back, "所属が正しくありません。");
    const id = newId("u");
    db.users.push({ id, name, kana: str(formData, "kana"), email, passwordHash: hashPassword(password), role, storeId, title: str(formData, "title") || "スタッフ", active: true });
    addAudit(db, { userId: admin.id, action: "create", entity: "user", entityId: id, entityLabel: name, summary: `ユーザーを追加 (${name} / ${str(formData, "role")})` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "ユーザーを追加しました。ログイン ID と初期パスワードを本人に伝えてください。"));
}

/** パスワードの再設定 (管理者のみ。変更履歴にはパスワードを残さない) */
export async function resetUserPassword(formData: FormData) {
  const back = "/settings?tab=users";
  const admin = await requireAdmin(back);
  const id = str(formData, "userId");
  const password = str(formData, "password");
  if (password.length < 8) fail(back, "新しいパスワードは 8 文字以上で入力してください。");
  const updated = await mutate((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) fail(back, "ユーザーが見つかりません。");
    u.passwordHash = hashPassword(password);
    u.password = undefined;
    addAudit(db, { userId: admin.id, action: "update", entity: "user", entityId: id, entityLabel: u.name, summary: "パスワードを再設定" });
    return { id: u.id, passwordHash: u.passwordHash };
  });
  // 再設定した人のログイン中のセッションは無効になる (自分自身を再設定したときはこの端末だけ継続)
  if (id === admin.id) await setSessionCookie(updated);
  revalidatePath("/settings");
  redirect(withMsg(back, "パスワードを再設定しました。ログイン中の端末はログアウトされます。新しいパスワードは本人に直接伝えてください。"));
}

/** ロール・所属・役職の変更 (管理者のみ)。空欄の項目は変更しない */
export async function updateUserRole(formData: FormData) {
  const back = "/settings?tab=users";
  const admin = await requireAdmin(back);
  const id = str(formData, "userId");
  const role = str(formData, "role") as Role | "";
  const storeId = str(formData, "storeId") as StoreId | "";
  const title = str(formData, "title");
  if (role && !isKeyOf(ROLE_LABEL, role)) fail(back, "ロールが正しくありません。");
  if (!role && !storeId && !title) fail(back, "変更する項目を選んでください。");
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) fail(back, "ユーザーが見つかりません。");
    if (storeId && !db.stores.some((s) => s.id === storeId)) fail(back, "所属が正しくありません。");
    if (role && role !== "admin" && u.role === "admin") {
      if (u.id === admin.id) fail(back, "自分自身の管理者権限は外せません。他の管理者に依頼してください。");
      if (!db.users.some((x) => x.id !== u.id && x.active && x.role === "admin")) fail(back, "有効な管理者が 1 人もいなくなるため変更できません。");
    }
    const before = { ...u };
    if (role) u.role = role;
    if (storeId) u.storeId = storeId;
    if (title) u.title = title;
    const changes = diffChanges(before, u, ["role", "storeId", "title"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: admin.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: `ロール・所属を変更 (${ROLE_LABEL[u.role]} / ${db.stores.find((s) => s.id === u.storeId)?.name ?? u.storeId})`, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "ロール・所属を変更しました。本人の次の画面表示から反映されます。"));
}

export async function toggleUserActive(id: string) {
  const back = "/settings?tab=users";
  const admin = await requireAdmin(back);
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) fail(back, "ユーザーが見つかりません。");
    if (u.id === admin.id) fail(back, "自分自身は無効化できません。");
    u.active = !u.active;
    addAudit(db, { userId: admin.id, action: "update", entity: "user", entityId: id, entityLabel: u.name, summary: `ユーザーを${u.active ? "有効化" : "無効化"}`, changes: [{ field: "active", before: !u.active, after: u.active }] });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "ユーザーの状態を変更しました。"));
}

export async function updateProduct(id: string, formData: FormData) {
  const back = "/settings?tab=products";
  const admin = await requireAdmin(back);
  const price = numField(formData, "unitPrice");
  if (price < 0) fail(back, "単価は 0 円以上で入力してください。");
  await mutate((db) => {
    const p = db.products.find((x) => x.id === id);
    if (!p) fail(back, "商品が見つかりません。");
    const before = p.unitPrice;
    p.unitPrice = price;
    p.active = str(formData, "active") !== "off";
    addAudit(db, { userId: admin.id, action: "update", entity: "product", entityId: id, entityLabel: p.name, summary: `商品単価を変更 (${p.name}: ¥${before.toLocaleString("ja-JP")} → ¥${price.toLocaleString("ja-JP")})`, changes: [{ field: "unitPrice", before, after: price }] });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "商品を更新しました。今後作成する見積に反映されます (既存の見積は変わりません)。"));
}

export async function createProduct(formData: FormData) {
  const back = "/settings?tab=products";
  const admin = await requireAdmin(back);
  const name = str(formData, "name");
  if (!name) fail(back, "商品名は必須です。");
  if (numField(formData, "unitPrice") < 0) fail(back, "単価は 0 円以上で入力してください。");
  await mutate((db) => {
    const id = newId("p");
    db.products.push({ id, category: choice(formData, "category", CATEGORY_LABEL, "other"), name, grade: str(formData, "grade") || undefined, unit: str(formData, "unit") || "式", unitPrice: numField(formData, "unitPrice"), sizeLabel: str(formData, "sizeLabel") || undefined, active: true });
    addAudit(db, { userId: admin.id, action: "create", entity: "product", entityId: id, entityLabel: name, summary: `商品を追加 (${name})` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "商品を追加しました。"));
}

export async function updateStore(id: StoreId, formData: FormData) {
  const back = "/settings?tab=stores";
  const admin = await requireAdmin(back);
  await mutate((db) => {
    const s = db.stores.find((x) => x.id === id);
    if (!s) fail(back, "店舗が見つかりません。");
    s.phone = str(formData, "phone") || s.phone;
    s.address = str(formData, "address") || s.address;
    s.managerUserId = str(formData, "managerUserId") || s.managerUserId;
    addAudit(db, { userId: admin.id, action: "update", entity: "store", entityId: id, entityLabel: s.name, summary: `店舗情報を更新 (${s.name})` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "店舗情報を更新しました。"));
}
