"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, diffChanges, mutate, newId } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { DOCUMENT_SETTINGS_ID, documentSettings, validRegistrationNumber } from "@/lib/doc-settings";
import { testConnection } from "@/lib/ai/provider";
import { CUSTOMER_CREATOR_LABEL, OPS_SETTINGS_ID } from "@/lib/ops-settings";
import type { Role, StoreId } from "@/lib/db/types";
import { canManageSettings } from "@/lib/auth/permissions";
import { CATEGORY_LABEL, ROLE_LABEL } from "@/lib/constants";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { choice, fail, isKeyOf, numField, requireActionUser, safeReturn, str, withMsg } from "./guards";

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
  const back = safeReturn(str(formData, "returnTo"), "/settings?tab=users");
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
  const back = safeReturn(str(formData, "returnTo"), "/settings?tab=users");
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

export async function toggleUserActive(id: string, formData?: FormData) {
  const back = formData ? safeReturn(str(formData, "returnTo"), "/settings?tab=users") : "/settings?tab=users";
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

/** 氏名・フリガナ・ログイン ID・役職・電話の変更 (管理者のみ。個別のアカウント画面から) */
export async function updateUserProfile(id: string, formData: FormData) {
  const back = `/settings/users/${id}`;
  const admin = await requireAdmin(back);
  const name = str(formData, "name");
  const email = str(formData, "email").toLowerCase();
  if (!name || !email) fail(back, "氏名とログイン ID は必須です。");
  if (/\s/.test(email)) fail(back, "ログイン ID に空白は使えません。");
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) fail("/settings?tab=users", "ユーザーが見つかりません。");
    if (db.users.some((x) => x.id !== id && x.email.toLowerCase() === email)) fail(back, "同じログイン ID のユーザーが存在します。");
    const before = { ...u };
    u.name = name;
    u.kana = str(formData, "kana");
    u.email = email;
    u.title = str(formData, "title") || u.title;
    u.phone = str(formData, "phone") || undefined;
    const changes = diffChanges(before, u, ["name", "kana", "email", "title", "phone"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: admin.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: `アカウント情報を変更 (${changes.map((c) => ({ name: "氏名", kana: "フリガナ", email: "ログイン ID", title: "役職", phone: "電話" })[c.field as "name"] ?? c.field).join("・")})`, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "アカウント情報を変更しました。ログイン ID を変えた場合は、新しい ID を本人に伝えてください。"));
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

/* ------------------------------------------------------------------ */
/* 帳票 (見積書・請求書・領収書) の会社情報                               */
/* ------------------------------------------------------------------ */

export async function updateDocumentSettings(formData: FormData) {
  const back = "/settings?tab=documents";
  const admin = await requireAdmin(back);
  if (BACKEND === "supabase" && missingTables().includes("settings") && (await recheckMissingTables()).includes("settings")) {
    fail(back, "データベースに設定の表 (settings) がまだありません。開発担当が npm run db:migrate を実行すると保存できるようになります。");
  }
  const registrationNumber = str(formData, "registrationNumber").normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
  if (!validRegistrationNumber(registrationNumber)) fail(back, "登録番号は T と 13 桁の数字で入力してください (例: T1234567890123)。");
  const banks = [0, 1, 2]
    .map((i) => ({ bank: str(formData, `bank${i}`), branch: str(formData, `branch${i}`), type: str(formData, `type${i}`) || "普通", number: str(formData, `number${i}`).normalize("NFKC"), holder: str(formData, `holder${i}`) }))
    .filter((b) => b.bank || b.number);
  if (banks.some((b) => !b.bank || !b.number || !b.holder)) fail(back, "振込先は銀行名・口座番号・口座名義をすべて入力してください。");
  const value = {
    companyName: str(formData, "companyName"),
    postalCode: str(formData, "postalCode"),
    address: str(formData, "address"),
    tel: str(formData, "tel"),
    fax: str(formData, "fax"),
    email: str(formData, "email"),
    website: str(formData, "website"),
    registrationNumber,
    showStore: formData.get("showStore") === "on",
    bankAccounts: banks,
    quoteValidDays: numField(formData, "quoteValidDays") || 30,
    paymentDays: numField(formData, "paymentDays"),
    quoteNote: str(formData, "quoteNote"),
    invoiceNote: str(formData, "invoiceNote"),
  };
  await mutate((db) => {
    const now = new Date().toISOString();
    const row = db.settings.find((s) => s.id === DOCUMENT_SETTINGS_ID);
    const before = documentSettings(db);
    if (row) Object.assign(row, { value, updatedBy: admin.id, updatedAt: now });
    else db.settings.push({ id: DOCUMENT_SETTINGS_ID, value, updatedBy: admin.id, updatedAt: now });
    const after = documentSettings(db);
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    addAudit(db, { userId: admin.id, action: "update", entity: "settings", entityId: DOCUMENT_SETTINGS_ID, entityLabel: "帳票の会社情報", summary: `帳票の会社情報を更新${changed.length ? ` (${changed.length} 項目)` : ""}` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "帳票の会社情報を保存しました。見積書・請求書の PDF に反映されます。"));
}

/** AI の接続を確認する (設定 → 外部連携・AI)。結果は画面に表示し、変更履歴にも残す */
export async function checkAiConnection(): Promise<{ ok: boolean; message: string }> {
  const user = await requireActionUser();
  if (!canManageSettings(user)) return { ok: false, message: "この操作は管理者のみ実行できます。" };
  const r = await testConnection();
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: "ai", entityLabel: "AI 接続", summary: r.ok ? `AI の接続を確認 (成功: ${r.provider} / ${r.model} / ${(r.ms / 1000).toFixed(1)} 秒)` : `AI の接続を確認 (失敗: ${r.message})` });
  }).catch(() => undefined);
  if (r.ok) return { ok: true, message: `接続できました (${r.provider === "claude" ? "Claude" : "OpenAI"} / ${r.model} / ${(r.ms / 1000).toFixed(1)} 秒)。応答: ${r.reply}` };
  return { ok: false, message: `${r.message}${r.detail ? ` (詳細: ${r.detail})` : ""}` };
}

/** 運用の設定 (顧客の新規登録ができる人など) */
export async function updateOpsSettings(formData: FormData) {
  const back = "/settings?tab=ops";
  const admin = await requireAdmin(back);
  if (BACKEND === "supabase" && missingTables().includes("settings") && (await recheckMissingTables()).includes("settings")) fail(back, "データベースに設定の表がまだありません。");
  const mode = str(formData, "customerCreators");
  const customerCreators = mode === "office_and_managers" || mode === "all" ? mode : "office";
  await mutate((db) => {
    const now = new Date().toISOString();
    const row = db.settings.find((s) => s.id === OPS_SETTINGS_ID);
    const value = { ...(row?.value ?? {}), customerCreators };
    if (row) Object.assign(row, { value, updatedBy: admin.id, updatedAt: now });
    else db.settings.push({ id: OPS_SETTINGS_ID, value, updatedBy: admin.id, updatedAt: now });
    addAudit(db, { userId: admin.id, action: "update", entity: "settings", entityId: OPS_SETTINGS_ID, entityLabel: "運用の設定", summary: `顧客の新規登録ができる人: ${CUSTOMER_CREATOR_LABEL[customerCreators]}` });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "運用の設定を保存しました。"));
}
