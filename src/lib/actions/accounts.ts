"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, Role, StoreId, User } from "@/lib/db/types";
import { assignableRoles, assignableStore, canApproveSignup, canChangeUserRole, canManageUser, canManageUserAvatar, canManageUsers, roleStoreProblem } from "@/lib/auth/permissions";
import { ROLE_LABEL } from "@/lib/constants";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { putObject } from "@/lib/storage";
import { addAvatarPhoto, avatarPhotoId, findAvatarPhoto, restoreAvatarPhoto, setAvatarHidden, validAvatarPhotoId } from "@/lib/avatar-photos";
import { loginIdProblem, PASSWORD_AUDIT, ACCOUNT_LOCK_MESSAGE, PASSWORD_LOCK_MESSAGE, accountEditLocked } from "@/lib/account-rules";
import { fail, isKeyOf, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * アカウント管理
 * ------------------------------------------------------------
 * - 管理者はすべてのアカウント、店長は自店舗の店舗スタッフを追加・変更・削除できる (permissions.ts の canManageUser)
 * - 新規登録 (ログイン画面から) は申請として受け付け、管理者が承認するまでログインできない (signupStatus = pending・active = false)
 * - ロール・所属・役職の変更 (updateUserRole) は、管理者ならテスト期間中のアカウントの変更の停止の対象外 (お客様のご要望 2026-11-26)
 * - 画面は 設定 → ユーザーと権限 と 社員管理 (/staff) の 2 か所。フォームの returnTo (アカウント画面の削除は listTo) で操作した画面に戻る
 * - 顔写真は本人が プロフィール から登録する (VPS の保存先の avatars/<ユーザー ID>/<時刻>.jpg)。管理者はアカウントの画面でほかの社員の顔写真も。
 *   顔写真は削除しない (お客様のご要望 2026-11-26): 「表示しない」で隠し、写真を変えても前の写真を残す (src/lib/avatar-photos.ts)。
 *   アカウントを削除しても写真のファイルは残す
 */

const USERS = "/settings?tab=users";

/** テスト期間中はアカウントの変更を断る (account-rules.ts の accountEditLocked) */
function assertUnlocked(back: string) {
  if (accountEditLocked()) fail(back, ACCOUNT_LOCK_MESSAGE);
}

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
  const problem = roleStoreProblem(role, db.stores.find((s) => s.id === storeId));
  if (problem) fail(back, problem);
  return { role, storeId };
}

export async function createUser(formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  assertUnlocked(back);
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
  if (accountEditLocked()) fail(back, PASSWORD_LOCK_MESSAGE);
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

/**
 * ロール・所属・役職の変更。空欄の項目は変更しない (店長は役職のみ。ロール・所属は自店舗の店舗スタッフに固定)。
 * 管理者の変更はテスト期間中のアカウントの変更の停止の対象外 (canChangeUserRole。各社員を店長・店舗スタッフなどにできるように)
 */
export async function updateUserRole(formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  if (!canChangeUserRole(actor)) assertUnlocked(back);
  const id = str(formData, "userId");
  const title = str(formData, "title");
  if (!id) fail(back, "変更する社員を選んでください。");
  if (!str(formData, "role") && !str(formData, "storeId") && !title) fail(back, "変更する項目を選んでください。");
  let name = "";
  let label = "";
  await mutate((db) => {
    const u = findManaged(db, actor, id, back);
    const { role, storeId } = pickRoleStore(db, actor, formData, back, { role: u.role, storeId: u.storeId });
    if (role !== "admin" && u.role === "admin") {
      if (u.id === actor.id) fail(back, "自分自身の管理者権限は外せません。他の管理者に依頼してください。");
      if (!db.users.some((x) => x.id !== u.id && x.active && x.role === "admin")) fail(back, "有効な管理者が 1 人もいなくなるため変更できません。");
    }
    if (u.signupStatus === "pending") fail(back, "新規登録の申請中のアカウントです。「承認する」でロール・所属を決めてください。");
    const before = { ...u };
    u.role = role;
    u.storeId = storeId;
    if (title) u.title = title.slice(0, 60);
    const changes = diffChanges(before, u, ["role", "storeId", "title"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    name = u.name;
    label = `${ROLE_LABEL[u.role]} / ${storeLabel(db, u.storeId)}`;
    addAudit(db, { userId: actor.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: `ロール・所属を変更 (${label})`, storeId: u.storeId, changes });
  });
  revalidatePath("/settings");
  revalidatePath("/staff");
  revalidatePath("/", "layout");
  redirect(withMsg(back, `${name} さんを ${label} に変更しました。本人の次の画面表示から反映されます。`));
}

export async function toggleUserActive(id: string, formData?: FormData) {
  const back = formData ? safeReturn(str(formData, "returnTo"), USERS) : USERS;
  const actor = await requireManager(back);
  assertUnlocked(back);
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
  const back = safeReturn(str(formData, "returnTo"), `/settings/users/${id}`);
  const actor = await requireManager(back);
  assertUnlocked(back);
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
  assertUnlocked(back);
  if (str(formData, "confirm") !== "1") fail(back, "削除の確認にチェックを入れてください。");
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
    label = u.name;
    db.users = db.users.filter((x) => x.id !== u.id);
    addAudit(db, { userId: actor.id, action: "delete", entity: "user", entityId: u.id, entityLabel: u.name, summary: `アカウントを削除 (${u.name} / ${ROLE_LABEL[u.role]} / ${storeLabel(db, u.storeId)} / ${u.email})`, storeId: u.storeId });
  });
  // 顔写真のファイルは消さない (お客様のご要望 2026-11-26「元の写真データは削除できない」)
  revalidatePath("/settings");
  // 削除したアカウントの画面には戻れないので、開いた一覧 (社員管理・設定) に戻る
  redirect(withMsg(safeReturn(str(formData, "listTo"), USERS), `${label} さんのアカウントを削除しました。`));
}

/**
 * 新規登録の申請を承認する (管理者だけ。ロール・所属・役職は承認するときに決める)。承認するとすぐに、本人が登録したログイン ID とパスワードでログインできる。
 * テスト期間中のアカウントの変更の停止 (accountEditLocked) の対象外: 止めると申請した社員がログインできないため
 */
export async function approveSignup(id: string, formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  let name = "";
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id && x.signupStatus === "pending");
    if (!u) fail(back, "申請が見つかりません (すでに承認・却下されています)。");
    if (!canApproveSignup(actor)) fail(back, "新規登録の申請を承認できるのは管理者です。");
    if (db.users.some((x) => x.id !== u.id && x.email.toLowerCase() === u.email.toLowerCase())) fail(back, "同じログイン ID のアカウントがほかにあるため承認できません。却下して、別のログイン ID で申請し直してもらってください。");
    const { role, storeId } = pickRoleStore(db, actor, formData, back, { role: u.role, storeId: u.storeId });
    const title = str(formData, "title").slice(0, 60);
    const before = { ...u };
    u.role = role;
    u.storeId = storeId;
    u.active = true;
    if (title) u.title = title;
    else if (u.title === "申請中") u.title = role === "store_manager" ? "店長" : "スタッフ";
    u.signupStatus = undefined;
    u.signupRequestedAt = undefined;
    name = u.name;
    const changes = diffChanges(before, u, ["role", "storeId", "title", "active", "signupStatus"]);
    addAudit(db, { userId: actor.id, action: "approve", entity: "user", entityId: u.id, entityLabel: u.name, summary: `新規登録の申請を承認 (${ROLE_LABEL[role]} / ${storeLabel(db, storeId)})`, storeId, changes });
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  redirect(withMsg(back, `${name} さんの新規登録を承認しました。登録したログイン ID とパスワードでログインできることを本人に伝えてください。`));
}

/** 新規登録の申請を却下する (申請の記録は消える。変更履歴には残る)。承認と同じく、アカウントの変更の停止の対象外 */
export async function rejectSignup(id: string, formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), USERS);
  const actor = await requireManager(back);
  let name = "";
  await mutate((db) => {
    const u = db.users.find((x) => x.id === id && x.signupStatus === "pending");
    if (!u) fail(back, "申請が見つかりません (すでに承認・却下されています)。");
    if (!canApproveSignup(actor)) fail(back, "新規登録の申請を却下できるのは管理者です。");
    name = u.name;
    db.users = db.users.filter((x) => x.id !== u.id);
    addAudit(db, { userId: actor.id, action: "reject", entity: "user", entityId: u.id, entityLabel: u.name, summary: `新規登録の申請を却下 (${u.email} / 希望: ${ROLE_LABEL[u.role]} / ${storeLabel(db, u.storeId)})`, storeId: u.storeId });
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  redirect(withMsg(back, `${name} さんの新規登録の申請を却下しました。`));
}

/* ---------------- 本人の顔写真 ---------------- */

const AVATAR_MAX_BYTES = 512 * 1024;

function imageType(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/** 顔写真の操作の戻り先 (本人 = プロフィール、管理者がほかの社員 = アカウントの画面) */
function avatarBack(actor: User, targetId: string, fd?: FormData): string {
  if (targetId === actor.id) return "/profile";
  return safeReturn(fd ? str(fd, "returnTo") : "", `/settings/users/${encodeURIComponent(targetId)}`);
}

/** 顔写真を操作できる社員 (本人・管理者)。テスト期間中のアカウントの変更の停止の対象外 (本人の顔写真と同じ) */
function avatarTarget(db: Database, actor: User, targetId: string, back: string): User {
  const u = db.users.find((x) => x.id === targetId);
  if (!u) fail(back, "ユーザーが見つかりません。");
  if (!canManageUserAvatar(actor, u)) fail(back, "ほかの社員の顔写真を変えられるのは管理者です。");
  return u;
}

function avatarAuditLabel(actor: User, u: User, what: string): string {
  return actor.id === u.id ? what : `${what} (${actor.name} さんが変更)`;
}

/**
 * 顔写真を登録・変更する (ブラウザで正方形 256px の JPEG に縮小してから送る)。
 * userId = 変える社員 (なければ本人。ほかの社員は管理者だけ)。前の写真は以前の写真として残し、ファイルは消さない
 */
export async function updateOwnAvatar(formData: FormData) {
  const user = await requireActionUser();
  const targetId = str(formData, "userId") || user.id;
  const back = avatarBack(user, targetId, formData);
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) fail(back, "写真を選んでください。");
  if (file.size > AVATAR_MAX_BYTES) fail(back, "写真が大きすぎます (512 KB まで)。別の写真を選んでください。");
  avatarTarget(getDb(), user, targetId, back);
  const body = Buffer.from(await file.arrayBuffer());
  const type = imageType(body);
  if (!type) fail(back, "JPEG・PNG・WebP の写真を選んでください。");
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const key = `avatars/${targetId.replace(/[^\w-]/g, "")}/${Date.now()}.${ext}`;
  try {
    await putObject(key, body);
  } catch (err) {
    console.error("[accounts] avatar upload failed:", err);
    fail(back, "写真を保存できませんでした。時間をおいて再度お試しください。");
  }
  let name = "";
  await mutate((db) => {
    const u = avatarTarget(db, user, targetId, back);
    const had = Boolean(u.avatarKey);
    const before: Pick<User, "avatarHidden"> = { avatarHidden: u.avatarHidden };
    addAvatarPhoto(u, { key, at: nowIso(), by: user.id });
    name = u.name;
    addAudit(db, { userId: user.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: avatarAuditLabel(user, u, had ? "顔写真を変更 (前の写真は以前の写真に残す)" : "顔写真を登録"), storeId: u.storeId, changes: diffChanges(before, u, ["avatarHidden"]) });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, targetId === user.id ? "顔写真を保存しました。" : `${name} さんの顔写真を保存しました。`));
}

/**
 * 顔写真を「表示しない」/「表示する」(写真のファイルと記録は消さない。お客様のご要望 2026-11-26)。
 * 表示しない間は、ヘッダー・予定表・チャットなどは名前の 1 文字の丸になる
 */
export async function setAvatarVisible(userId: string, visible: boolean) {
  const user = await requireActionUser();
  const back = avatarBack(user, userId);
  let name = "";
  await mutate((db) => {
    const u = avatarTarget(db, user, userId, back);
    if (!u.avatarKey) fail(back, "顔写真は登録されていません。");
    if (Boolean(u.avatarHidden) === !visible) fail(back, visible ? "顔写真はすでに表示しています。" : "顔写真はすでに表示しないにしています。");
    const before: Pick<User, "avatarHidden"> = { avatarHidden: u.avatarHidden };
    setAvatarHidden(u, !visible);
    name = u.name;
    addAudit(db, { userId: user.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: avatarAuditLabel(user, u, visible ? "顔写真を表示する" : "顔写真を表示しない (写真は残す)"), storeId: u.storeId, changes: diffChanges(before, u, ["avatarHidden"]) });
  });
  revalidatePath("/", "layout");
  const who = userId === user.id ? "" : `${name} さんの`;
  redirect(withMsg(back, visible ? `${who}顔写真を表示に戻しました。` : `${who}顔写真を表示しないにしました。写真は残っているので、「表示する」でいつでも戻せます。`));
}

/** 以前の顔写真に戻す (今の写真も以前の写真として残る)。表示しないにしていたら表示に戻す */
export async function restoreAvatar(userId: string, photoId: string) {
  const user = await requireActionUser();
  const back = avatarBack(user, userId);
  if (!validAvatarPhotoId(photoId)) fail(back, "写真が見つかりません。");
  let name = "";
  await mutate((db) => {
    const u = avatarTarget(db, user, userId, back);
    const photo = findAvatarPhoto(u, photoId);
    if (!photo) fail(back, "写真が見つかりません。");
    if (u.avatarKey === photo.key && !u.avatarHidden) fail(back, "この写真はいま表示している写真です。");
    const before: Pick<User, "avatarHidden"> = { avatarHidden: u.avatarHidden };
    const from = u.avatarKey ? avatarPhotoId(u.avatarKey) : "なし";
    restoreAvatarPhoto(u, photo.key, nowIso());
    name = u.name;
    addAudit(db, { userId: user.id, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: avatarAuditLabel(user, u, `顔写真を以前の写真に戻す (${from} → ${photoId})`), storeId: u.storeId, changes: diffChanges(before, u, ["avatarHidden"]) });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, userId === user.id ? "顔写真を以前の写真に戻しました。" : `${name} さんの顔写真を以前の写真に戻しました。`));
}
