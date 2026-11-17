"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, Role, StoreId, User } from "@/lib/db/types";
import { assignableRoles, assignableStore, canApproveSignup, canManageUser, canManageUsers } from "@/lib/auth/permissions";
import { ROLE_LABEL } from "@/lib/constants";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { putObject, removeObjects } from "@/lib/storage";
import { loginIdProblem, PASSWORD_AUDIT } from "@/lib/account-rules";
import { fail, isKeyOf, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * アカウント管理
 * ------------------------------------------------------------
 * - 管理者はすべてのアカウント、店長は自店舗の店舗スタッフを追加・変更・削除できる (permissions.ts の canManageUser)
 * - 新規登録 (ログイン画面から) は申請として受け付け、承認されるまでログインできない (signupStatus = pending・active = false)
 * - 顔写真は本人が プロフィール から登録する (VPS の保存先の avatars/<ユーザー ID>/<時刻>.jpg)
 */

const USERS = "/settings?tab=users";

async function requireManager(back: string): Promise<User> {
  const user = await requireActionUser();
  if (!canManageUsers(user)) fail(back, "アカウントの管理は管理者と店長が行えます。");
  return user;
}

function findManaged(db: Database, actor: User, id: string, back: string): User {
  const u = db.users.find((x) => x.id === id);
  if (!u) fail(USERS, "ユーザーが見つかりません。");
  if (!canManageUser(actor, u)) fail(back, actor.role === "store_manager" ? "店長が管理できるのは、自店舗の店舗スタッフのアカウントです。" : "このアカウントを管理する権限がありません。");
  return u;
}

function storeLabel(db: Database, id: StoreId): string {
  return db.stores.find((s) => s.id === id)?.name ?? id;
}

/** ロール・所属をフォームから受け取り、操作する人の権限の範囲か確かめる */
function pickRoleStore(db: Database, actor: User, fd: FormData, back: string, fallback: { role: Role; storeId: StoreId }): { role: Role; storeId: StoreId } {
  const rawRole = str(fd, "role") || fallback.role;
  const rawStore = str(fd, "storeId") || (actor.role === "store_manager" ? actor.storeId : fallback.storeId);
  if (!isKeyOf(ROLE_LABEL, rawRole)) fail(back, "ロールが正しくありません。");
  if (!db.stores.some((s) => s.id === rawStore)) fail(back, "所属が正しくありません。");
  const role = rawRole as Role;
  const storeId = rawStore as StoreId;
  if (!assignableRoles(actor).includes(role)) fail(back, `${ROLE_LABEL[role]} のロールを付ける権限がありません (店長は店舗スタッフのみ)。`);
  if (!assignableStore(actor, storeId)) fail(back, "自店舗以外の所属にする権限がありません。");
  return { role, storeId };
}

export async function createUser(formData: FormData) {
  const back = USERS;
  const actor = await requireManager(back);
  const name = str(formData, "name").slice(0, 60);
  const email = str(formData, "email").toLowerCase();
  const password = str(formData, "password");
  if (!name) fail(back, "氏名を入力してください。");
  const idProblem = loginIdProblem(email);
  if (idProblem) fail(back, idProblem);
  if (password.length < 8) fail(back, "初期パスワードは 8 文字以上で入力してください。");
  await mutate((db) => {
    if (db.users.some((u) => u.email.toLowerCase() === email)) fail(back, "同じログイン ID のユーザーが存在します。");
    const { role, storeId } = pickRoleStore(db, actor, formData, back, { role: "store_staff", storeId: actor.storeId });
    const id = newId("u");
    db.users.push({ id, name, kana: str(formData, "kana"), email, passwordHash: hashPassword(password), role, storeId, title: str(formData, "title") || "スタッフ", active: true });
    addAudit(db, { userId: actor.id, action: "create", entity: "user", entityId: id, entityLabel: name, summary: `ユーザーを追加 (${name} / ${ROLE_LABEL[role]} / ${storeLabel(db, storeId)})`, storeId });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "ユーザーを追加しました。ログイン ID と初期パスワードを本人に伝えてください。"));
}

/** パスワードの再設定 (変更履歴にはパスワードを残さない) */
export async function resetUserPassword(formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  const id = str(formData, "userId");
  const password = str(formData, "password");
  if (password.length < 8) fail(back, "新しいパスワードは 8 文字以上で入力してください。");
  const updated = await mutate((db) => {
    const u = findManaged(db, actor, id, back);
    u.passwordHash = hashPassword(password);
    u.password = undefined;
    addAudit(db, { userId: actor.id, action: "update", entity: "user", entityId: id, entityLabel: u.name, summary: PASSWORD_AUDIT.reset, storeId: u.storeId });
    return { id: u.id, passwordHash: u.passwordHash };
  });
  // 再設定した人のログイン中のセッションは無効になる (自分自身を再設定したときはこの端末だけ継続)
  if (id === actor.id) await setSessionCookie(updated);
  revalidatePath("/settings");
  redirect(withMsg(back, "パスワードを再設定しました。ログイン中の端末はログアウトされます。新しいパスワードは本人に直接伝えてください。"));
}

/** ロール・所属・役職の変更。空欄の項目は変更しない (店長は役職のみ。ロール・所属は自店舗の店舗スタッフに固定) */
export async function updateUserRole(formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  const id = str(formData, "userId");
  const title = str(formData, "title");
  if (!str(formData, "role") && !str(formData, "storeId") && !title) fail(back, "変更する項目を選んでください。");
  await mutate((db) => {
    const u = findManaged(db, actor, id, back);
    const { role, storeId } = pickRoleStore(db, actor, formData, back, { role: u.role, storeId: u.storeId });
    if (role !== "admin" && u.role === "admin") {
      if (u.id === actor.id) fail(back, "自分自身の管理者権限は外せません。他の管理者に依頼してください。");
      if (!db.users.some((x) => x.id !== u.id && x.active && x.role === "admin")) fail(back, "有効な管理者が 1 人もいなくなるため変更できません。");
    }
    const before = { ...u };
    u.role = role;
    u.storeId = storeId;
    if (title) u.title = title;
    const changes = diffChanges(before, u, ["role", "storeId", "title"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: actor.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: `ロール・所属を変更 (${ROLE_LABEL[u.role]} / ${storeLabel(db, u.storeId)})`, storeId: u.storeId, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "ロール・所属を変更しました。本人の次の画面表示から反映されます。"));
}

export async function toggleUserActive(id: string, formData?: FormData) {
  const back = formData ? safeReturn(str(formData, "returnTo"), USERS) : USERS;
  const actor = await requireManager(back);
  await mutate((db) => {
    const u = findManaged(db, actor, id, back);
    if (u.id === actor.id) fail(back, "自分自身は無効化できません。");
    if (u.signupStatus === "pending") fail(back, "新規登録の申請中のアカウントです。「承認」または「却下」を選んでください。");
    if (u.active && u.role === "admin" && !db.users.some((x) => x.id !== u.id && x.active && x.role === "admin")) fail(back, "有効な管理者が 1 人もいなくなるため無効化できません。");
    u.active = !u.active;
    addAudit(db, { userId: actor.id, action: "update", entity: "user", entityId: id, entityLabel: u.name, summary: `ユーザーを${u.active ? "有効化" : "無効化"}`, storeId: u.storeId, changes: [{ field: "active", before: !u.active, after: u.active }] });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "ユーザーの状態を変更しました。"));
}

/** 氏名・フリガナ・ログイン ID・役職・電話の変更 (個別のアカウント画面から) */
export async function updateUserProfile(id: string, formData: FormData) {
  const back = `/settings/users/${id}`;
  const actor = await requireManager(back);
  const name = str(formData, "name").slice(0, 60);
  const email = str(formData, "email").toLowerCase();
  if (!name) fail(back, "氏名を入力してください。");
  const idProblem = loginIdProblem(email);
  if (idProblem) fail(back, idProblem);
  await mutate((db) => {
    const u = findManaged(db, actor, id, back);
    if (db.users.some((x) => x.id !== id && x.email.toLowerCase() === email)) fail(back, "同じログイン ID のユーザーが存在します。");
    const before = { ...u };
    u.name = name;
    u.kana = str(formData, "kana");
    u.email = email;
    u.title = str(formData, "title") || u.title;
    u.phone = str(formData, "phone") || undefined;
    const changes = diffChanges(before, u, ["name", "kana", "email", "title", "phone"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: actor.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: `アカウント情報を変更 (${changes.map((c) => ({ name: "氏名", kana: "フリガナ", email: "ログイン ID", title: "役職", phone: "電話" })[c.field as "name"] ?? c.field).join("・")})`, storeId: u.storeId, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "アカウント情報を変更しました。ログイン ID を変えた場合は、新しい ID を本人に伝えてください。"));
}

/**
 * アカウントの削除。過去の記録 (案件の登録者・変更履歴など) の名前は「-」の表示になる。
 * 資料・写真を登録した社員は、登録者の記録を残すため削除できない (無効化する)
 */
export async function deleteUser(id: string, formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  if (str(formData, "confirm") !== "1") fail(back, "削除の確認にチェックを入れてください。");
  let removedKey: string | undefined;
  let label = "";
  await mutate((db) => {
    const u = findManaged(db, actor, id, back);
    if (u.id === actor.id) fail(back, "自分自身は削除できません。");
    if (u.role === "admin" && u.active && !db.users.some((x) => x.id !== u.id && x.active && x.role === "admin")) fail(back, "有効な管理者が 1 人もいなくなるため削除できません。");
    const uploads = db.attachments.filter((a) => a.uploadedBy === u.id).length;
    if (uploads > 0) fail(back, `${u.name} さんは資料・写真を ${uploads} 件登録しているため、登録者の記録を残すために削除できません。「無効にする」でログインを止めてください。`);
    // データベースの外部キー (on delete set null) と同じ扱いを手元のデータにもする
    for (const c of db.customers) if (c.assignedUserId === u.id) c.assignedUserId = undefined;
    for (const i of db.inquiries) if (i.assignedUserId === u.id) i.assignedUserId = undefined;
    removedKey = u.avatarKey;
    label = u.name;
    db.users = db.users.filter((x) => x.id !== u.id);
    addAudit(db, { userId: actor.id, action: "delete", entity: "user", entityId: u.id, entityLabel: u.name, summary: `アカウントを削除 (${u.name} / ${ROLE_LABEL[u.role]} / ${storeLabel(db, u.storeId)} / ${u.email})`, storeId: u.storeId });
  });
  if (removedKey) await removeObjects([removedKey]).catch((err) => console.error("[accounts] avatar remove failed:", err));
  revalidatePath("/settings");
  redirect(withMsg(USERS, `${label} さんのアカウントを削除しました。`));
}

/** 新規登録の申請を承認する (ロール・所属は承認する人の権限の範囲で変えられる) */
export async function approveSignup(id: string, formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  let name = "";
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id && x.signupStatus === "pending");
    if (!u) fail(back, "申請が見つかりません (すでに承認・却下されています)。");
    if (!canApproveSignup(actor, u)) fail(back, "この申請を承認する権限がありません (店長は自店舗の店舗スタッフの申請のみ)。");
    const { role, storeId } = pickRoleStore(db, actor, formData, back, { role: u.role, storeId: u.storeId });
    const before = { ...u };
    u.role = role;
    u.storeId = storeId;
    u.active = true;
    if (u.title === "申請中") u.title = "スタッフ";
    u.signupStatus = undefined;
    u.signupRequestedAt = undefined;
    name = u.name;
    const changes = diffChanges(before, u, ["role", "storeId", "title", "active", "signupStatus"]);
    addAudit(db, { userId: actor.id, action: "approve", entity: "user", entityId: u.id, entityLabel: u.name, summary: `新規登録の申請を承認 (${ROLE_LABEL[role]} / ${storeLabel(db, storeId)})`, storeId, changes });
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  redirect(withMsg(USERS, `${name} さんの新規登録を承認しました。登録したログイン ID とパスワードでログインできることを本人に伝えてください。`));
}

/** 新規登録の申請を却下する (申請の記録は消える。変更履歴には残る) */
export async function rejectSignup(id: string, formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  let name = "";
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id && x.signupStatus === "pending");
    if (!u) fail(back, "申請が見つかりません (すでに承認・却下されています)。");
    if (!canApproveSignup(actor, u)) fail(back, "この申請を却下する権限がありません (店長は自店舗の店舗スタッフの申請のみ)。");
    name = u.name;
    db.users = db.users.filter((x) => x.id !== u.id);
    addAudit(db, { userId: actor.id, action: "reject", entity: "user", entityId: u.id, entityLabel: u.name, summary: `新規登録の申請を却下 (${u.email} / 希望: ${ROLE_LABEL[u.role]} / ${storeLabel(db, u.storeId)})`, storeId: u.storeId });
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  redirect(withMsg(USERS, `${name} さんの新規登録の申請を却下しました。`));
}

/* ---------------- 本人の顔写真 ---------------- */

const AVATAR_MAX_BYTES = 512 * 1024;

function imageType(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/** 顔写真を登録・変更する (ブラウザで正方形 256px の JPEG に縮小してから送る) */
export async function updateOwnAvatar(formData: FormData) {
  const back = "/profile";
  const user = await requireActionUser();
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) fail(back, "写真を選んでください。");
  if (file.size > AVATAR_MAX_BYTES) fail(back, "写真が大きすぎます (512 KB まで)。別の写真を選んでください。");
  const body = Buffer.from(await file.arrayBuffer());
  const type = imageType(body);
  if (!type) fail(back, "JPEG・PNG・WebP の写真を選んでください。");
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const key = `avatars/${user.id.replace(/[^\w-]/g, "")}/${Date.now()}.${ext}`;
  try {
    await putObject(key, body);
  } catch (err) {
    console.error("[accounts] avatar upload failed:", err);
    fail(back, "写真を保存できませんでした。時間をおいて再度お試しください。");
  }
  const old = getDb().users.find((u) => u.id === user.id)?.avatarKey;
  await mutate((db) => {
    const u = db.users.find((x) => x.id === user.id);
    if (!u) fail(back, "ユーザーが見つかりません。");
    u.avatarKey = key;
    u.avatarUpdatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "user", entityId: user.id, entityLabel: user.name, summary: old ? "顔写真を変更" : "顔写真を登録", storeId: user.storeId });
  });
  if (old && old !== key) await removeObjects([old]).catch((err) => console.error("[accounts] old avatar remove failed:", err));
  revalidatePath("/", "layout");
  redirect(withMsg(back, "顔写真を保存しました。"));
}

export async function removeOwnAvatar() {
  const back = "/profile";
  const user = await requireActionUser();
  let old: string | undefined;
  await mutate((db) => {
    const u = db.users.find((x) => x.id === user.id);
    if (!u?.avatarKey) fail(back, "顔写真は登録されていません。");
    old = u.avatarKey;
    u.avatarKey = undefined;
    u.avatarUpdatedAt = undefined;
    addAudit(db, { userId: user.id, action: "update", entity: "user", entityId: user.id, entityLabel: user.name, summary: "顔写真を削除", storeId: user.storeId });
  });
  if (old) await removeObjects([old]).catch((err) => console.error("[accounts] avatar remove failed:", err));
  revalidatePath("/", "layout");
  redirect(withMsg(back, "顔写真を削除しました。"));
}
