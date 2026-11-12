"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, mutate, resetDb, addAudit, syncDb } from "@/lib/db/store";
import { clearSessionCookie, getSessionUser, safeNext, setSessionCookie } from "@/lib/auth/session";
import { canResetData } from "@/lib/auth/permissions";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { fail, requireActionUser, str, withMsg } from "./guards";

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
    return { error: "ログイン ID またはパスワードが正しくありません。" };
  }
  loginFails.delete(email);
  await setSessionCookie(user);
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "login", entity: "session", entityId: user.id, entityLabel: user.name, summary: "ログイン" });
  });
  redirect(next);
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
    addAudit(d, { userId: user.id, action: "update", entity: "user", entityId: user.id, entityLabel: user.name, summary: "パスワードを変更" });
    return { id: u.id, passwordHash: u.passwordHash };
  });
  // 他の端末のセッションは無効になる。この端末は新しいパスワードでログインし直した扱いにする
  await setSessionCookie(updated);
  redirect(withMsg(back, "パスワードを変更しました。他の端末では再度ログインが必要です。"));
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
