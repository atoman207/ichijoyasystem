"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, mutate, resetDb, addAudit, syncDb } from "@/lib/db/store";
import { clearSessionCookie, getSessionUser, safeNext, setSessionCookie } from "@/lib/auth/session";
import { headers } from "next/headers";
import { canResetData, DEMO_EMAIL_DOMAIN } from "@/lib/auth/permissions";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { hasReviewAccess, REVIEW_ACCOUNTS } from "@/lib/auth/review";
import { accountEditLocked, loginIdProblem, PASSWORD_AUDIT, PASSWORD_LOCK_MESSAGE, reservedLoginId } from "@/lib/account-rules";
import { ROLE_LABEL } from "@/lib/constants";
import type { Role, StoreId, User } from "@/lib/db/types";
import crypto from "node:crypto";
import { fail, isKeyOf, requireActionUser, str, withMsg } from "./guards";

export interface LoginState {
  error?: string;
}

/**
 * ログインの連続失敗を制限する (ログイン ID ごと)。15 分間に 10 回失敗すると 15 分間ロックする。
 * サーバーインスタンスごとのメモリで数える簡易版 (次の段階で認証基盤側の制限に置き換える)
 */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;
const g = globalThis as typeof globalThis & { __ichijoyaLoginFails?: Map<string, { count: number; first: number; lockedUntil?: number }> };
const loginFails = (g.__ichijoyaLoginFails ??= new Map());

/** ロック中なら残り分数を返す */
function lockedMinutes(key: string, now = Date.now()): number {
  const r = loginFails.get(key);
  return r?.lockedUntil && r.lockedUntil > now ? Math.ceil((r.lockedUntil - now) / 60000) : 0;
}

function recordFailure(key: string, now = Date.now()) {
  const record = loginFails.get(key);
  const r = record && now - record.first < FAIL_WINDOW_MS ? record : { count: 0, first: now };
  r.count += 1;
  r.lockedUntil = r.count >= FAIL_LIMIT ? now + FAIL_WINDOW_MS : undefined;
  loginFails.set(key, r);
  if (loginFails.size > 5000) loginFails.clear();
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? "/"));
  const min = lockedMinutes(email);
  if (min) {
    return { error: `ログインの失敗が続いたため、一時的にロックしています。${min} 分ほどしてから再度お試しください。` };
  }
  const db = await syncDb();
  const user = db.users.find((u) => u.email.toLowerCase() === email && u.active);
  if (!user || !verifyPassword(user, password)) {
    recordFailure(email);
    // 申請中のアカウントは、パスワードが合っているときだけ承認待ちと伝える (ID の有無を推測させない)
    const pendingUser = !user ? db.users.find((u) => u.email.toLowerCase() === email && u.signupStatus === "pending") : undefined;
    if (pendingUser && verifyPassword(pendingUser, password)) {
      return { error: "新規登録の申請は承認待ちです。管理者または店長が承認すると、このログイン ID とパスワードでログインできます。" };
    }
    return { error: "ログイン ID またはパスワードが正しくありません。" };
  }
  loginFails.delete(email);
  await setSessionCookie(user);
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "login", entity: "session", entityId: user.id, entityLabel: user.name, summary: "ログイン" });
  });
  redirect(next);
}

/**
 * 確認用ログイン: 確認用リンクを開いた端末で、ロールのボタンを押すとパスワードなしでログインする
 * - 確認用アカウントがなければ作る (パスワードは推測できない値にし、通常のログイン画面からは入れない)
 * - 管理者が確認用アカウントを無効化すると、そのボタンではログインできない
 */
export async function reviewLogin(accountId: string) {
  const account = REVIEW_ACCOUNTS.find((a) => a.id === accountId);
  if (!account || !(await hasReviewAccess())) {
    redirect(`/login?err=${encodeURIComponent("確認用リンクから開いてください。")}`);
  }
  await syncDb();
  let user: User | undefined;
  await mutate((d) => {
    let u = d.users.find((x) => x.id === account.id);
    if (!u) {
      if (d.users.some((x) => x.email.toLowerCase() === account.email)) fail("/login", "確認用アカウントのログイン ID が、ほかのユーザーと重複しています。");
      u = { id: account.id, name: account.name, kana: account.kana, email: account.email, passwordHash: hashPassword(crypto.randomBytes(24).toString("base64url")), role: account.role, storeId: account.storeId, title: "確認用アカウント", active: true };
      d.users.push(u);
      addAudit(d, { userId: u.id, action: "create", entity: "user", entityId: u.id, entityLabel: u.name, summary: "確認用アカウントを作成" });
    }
    if (!u.active) fail("/login", "この確認用アカウントは管理者によって無効化されています。");
    user = { ...u };
    addAudit(d, { userId: u.id, action: "login", entity: "session", entityId: u.id, entityLabel: u.name, summary: "確認用リンクからログイン" });
  });
  await setSessionCookie(user!);
  redirect("/");
}

export async function logout() {
  const user = await getSessionUser();
  if (user) {
    await mutate((d) => {
      addAudit(d, { userId: user.id, action: "logout", entity: "session", entityId: user.id, entityLabel: user.name, summary: "ログアウト" });
    });
  }
  await clearSessionCookie();
  redirect("/login");
}

/** 自分のパスワードを変更する (現在のパスワードの確認が必要) */
export async function changeOwnPassword(formData: FormData) {
  const user = await requireActionUser();
  const back = "/profile";
  if (accountEditLocked()) fail(back, PASSWORD_LOCK_MESSAGE);
  const current = String(formData.get("current") ?? "");
  const next = str(formData, "next");
  const key = `pwchange:${user.id}`;
  const min = lockedMinutes(key);
  if (min) fail(back, `失敗が続いたため、パスワードの変更を一時的にロックしています。${min} 分ほどしてから再度お試しください。`);
  if (!verifyPassword(user, current)) {
    recordFailure(key);
    fail(back, "現在のパスワードが正しくありません。");
  }
  loginFails.delete(key);
  if (next.length < 8) fail(back, "新しいパスワードは 8 文字以上にしてください。");
  if (next !== str(formData, "confirm")) fail(back, "確認用のパスワードが一致しません。");
  if (next === current) fail(back, "現在と異なるパスワードを入力してください。");
  const updated = await mutate((d) => {
    const u = d.users.find((x) => x.id === user.id);
    if (!u) fail(back, "ユーザーが見つかりません。");
    u.passwordHash = hashPassword(next);
    u.password = undefined;
    addAudit(d, { userId: user.id, action: "update", entity: "user", entityId: user.id, entityLabel: user.name, summary: PASSWORD_AUDIT.changed });
    return { id: u.id, passwordHash: u.passwordHash };
  });
  // 他の端末のセッションは無効になる。この端末は新しいパスワードでログインし直した扱いにする
  await setSessionCookie(updated);
  redirect(withMsg(back, "パスワードを変更しました。他の端末では再度ログインが必要です。"));
}

/** 自分のログイン ID (メールアドレス) を変更する (現在のパスワードの確認が必要) */
export async function changeOwnLoginId(formData: FormData) {
  const user = await requireActionUser();
  const back = "/profile";
  const email = str(formData, "email").toLowerCase();
  const key = `idchange:${user.id}`;
  const min = lockedMinutes(key);
  if (min) fail(back, `失敗が続いたため、ログイン ID の変更を一時的にロックしています。${min} 分ほどしてから再度お試しください。`);
  if (!verifyPassword(user, String(formData.get("current") ?? ""))) {
    recordFailure(key);
    fail(back, "現在のパスワードが正しくありません。");
  }
  loginFails.delete(key);
  const problem = loginIdProblem(email);
  if (problem) fail(back, problem);
  if (email === user.email.toLowerCase()) fail(back, "現在と異なるログイン ID を入力してください。");
  if (reservedLoginId(email)) fail(back, `${DEMO_EMAIL_DOMAIN} はデモ用アカウントのドメインのため使えません。`);
  await mutate((d) => {
    if (d.users.some((x) => x.id !== user.id && x.email.toLowerCase() === email)) fail(back, "このログイン ID はほかのアカウントで使われています。");
    const u = d.users.find((x) => x.id === user.id);
    if (!u) fail(back, "ユーザーが見つかりません。");
    const before = u.email;
    u.email = email;
    addAudit(d, { userId: user.id, action: "update", entity: "user", entityId: user.id, entityLabel: user.name, summary: "ログイン ID を変更", storeId: user.storeId, changes: [{ field: "email", before, after: email }] });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, "ログイン ID を変更しました。次回から新しいログイン ID でログインしてください。"));
}

/* ---------------- 新規登録 (申請) ---------------- */

export interface SignupState {
  error?: string;
  done?: { name: string; role: string; store: string };
}

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_PER_IP = 5;
const SIGNUP_PENDING_MAX = 30;
const gs = globalThis as typeof globalThis & { __ichijoyaSignups?: Map<string, number[]> };
const signups = (gs.__ichijoyaSignups ??= new Map());

/**
 * ログイン画面からの新規登録。希望するロール・所属を選んで申請し、承認されるまでログインできない。
 * 店舗スタッフの申請はその店舗の店長か管理者、それ以外のロールは管理者が承認する (accounts.ts の approveSignup)
 */
export async function signup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  // ロボットよけ (人には見えない欄)
  if (str(formData, "website")) return { error: "送信できませんでした。" };
  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "unknown").trim();
  const now = Date.now();
  const recent = (signups.get(ip) ?? []).filter((t: number) => now - t < SIGNUP_WINDOW_MS);
  if (recent.length >= SIGNUP_PER_IP) return { error: "短時間に申請が続いたため、受け付けを止めています。1 時間ほどしてから再度お試しください。" };

  const name = str(formData, "name").slice(0, 60);
  const kana = str(formData, "kana").slice(0, 60);
  const email = str(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = str(formData, "role");
  const storeId = str(formData, "storeId");
  const note = str(formData, "note").slice(0, 400);
  if (!name) return { error: "氏名を入力してください。" };
  const problem = loginIdProblem(email);
  if (problem) return { error: problem };
  if (reservedLoginId(email)) return { error: `${DEMO_EMAIL_DOMAIN} はデモ用アカウントのドメインのため使えません。` };
  if (password.length < 8) return { error: "パスワードは 8 文字以上にしてください。" };
  if (password !== String(formData.get("confirm") ?? "")) return { error: "確認用のパスワードが一致しません。" };
  if (!isKeyOf(ROLE_LABEL, role)) return { error: "希望する権限 (ロール) を選んでください。" };

  const db = await syncDb();
  if (!db.stores.some((s) => s.id === storeId)) return { error: "所属を選んでください。" };
  if ((role === "store_manager" || role === "store_staff") && storeId === "hq") return { error: "店長・店舗スタッフは、所属する店舗を選んでください。" };
  if (db.users.some((u) => u.email.toLowerCase() === email)) return { error: "このログイン ID はすでに使われています。別の ID にするか、ログインしてください。" };
  if (db.users.filter((u) => u.signupStatus === "pending").length >= SIGNUP_PENDING_MAX) return { error: "承認待ちの申請が多いため、受け付けを止めています。管理者にお問い合わせください。" };

  recent.push(now);
  signups.set(ip, recent);
  if (signups.size > 5000) signups.clear();

  const id = `u_${crypto.randomBytes(8).toString("hex")}`;
  try {
    await mutate((d) => {
      if (d.users.some((u) => u.email.toLowerCase() === email)) throw new Error("duplicate");
      d.users.push({
        id, name, kana, email, passwordHash: hashPassword(password),
        role: role as Role, storeId: storeId as StoreId, title: "申請中", active: false,
        signupStatus: "pending", signupRequestedAt: new Date().toISOString(), signupNote: note || undefined,
      });
      addAudit(d, { userId: id, action: "create", entity: "user", entityId: id, entityLabel: name, summary: `新規登録を申請 (希望: ${ROLE_LABEL[role as Role]} / ${d.stores.find((s) => s.id === storeId)?.name ?? storeId})`, storeId: storeId as StoreId });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "duplicate") return { error: "このログイン ID はすでに使われています。" };
    console.error("[signup] save failed:", err);
    return { error: "申請を保存できませんでした。時間をおいて再度お試しください。" };
  }
  return { done: { name, role: ROLE_LABEL[role as Role], store: db.stores.find((s) => s.id === storeId)?.name ?? storeId } };
}

/** サンプルデータを初期状態に戻す (管理者のみ) */
export async function resetSampleData() {
  const user = await getSessionUser();
  if (!user || !canResetData(user)) {
    redirect("/?err=" + encodeURIComponent("この操作は管理者のみ実行できます。"));
  }
  if (BACKEND !== "json") {
    redirect("/settings?tab=data&err=" + encodeURIComponent("本番データベースではサンプルデータへの初期化はできません。"));
  }
  resetDb();
  revalidatePath("/", "layout");
  redirect("/settings?msg=" + encodeURIComponent("サンプルデータを初期状態に戻しました。"));
}
