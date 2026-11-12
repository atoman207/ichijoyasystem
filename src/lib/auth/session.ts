import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import type { User } from "@/lib/db/types";

/**
 * セッション管理
 * ------------------------------------------------------------
 * Cookie (httpOnly) に「ユーザーID.発行時刻.パスワード指紋.署名」を保存する。
 * - 署名鍵: SESSION_SECRET。未設定なら SUPABASE_SECRET_KEY から導出する (サーバー側の秘密情報のみ)。
 *   どちらもない場合 (ローカルのサンプルデータ) だけ固定のデモ用の鍵を使う
 * - 有効期限: 発行から 7 日 (サーバー側でも発行時刻を検証する)
 * - パスワード指紋: パスワードを変更・再設定すると、それまでのセッションは無効になる
 * - パスワードは scrypt でハッシュ化して保存する (src/lib/auth/password.ts)
 * 多要素認証・SSO は次の段階で認証基盤 (Supabase Auth など) とあわせて検討する。
 */

export const SESSION_COOKIE = "ichijoya_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

const SECRET =
  process.env.SESSION_SECRET ||
  (process.env.SUPABASE_SECRET_KEY
    ? createHash("sha256").update(`ichijoya-session:${process.env.SUPABASE_SECRET_KEY}`).digest("base64url")
    : "ichijoya-demo-secret");

type SessionSubject = Pick<User, "id" | "password" | "passwordHash">;

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

/** パスワード (ハッシュ) が変わるとセッションを無効にするための短い指紋 */
function fingerprint(user: SessionSubject): string {
  return sign(`pw:${user.passwordHash ?? user.password ?? ""}`).slice(0, 12);
}

export function createToken(user: SessionSubject, issuedAt = Date.now()): string {
  const body = `${user.id}.${Math.floor(issuedAt / 1000).toString(36)}.${fingerprint(user)}`;
  return `${body}.${sign(body)}`;
}

interface TokenPayload {
  userId: string;
  fp: string;
}

export function verifyToken(token: string | undefined): TokenPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 4) return null;
  const sig = parts.pop()!;
  const fp = parts.pop()!;
  const iat = parseInt(parts.pop()!, 36);
  const userId = parts.join(".");
  const expected = sign(`${userId}.${iat.toString(36)}.${fp}`);
  if (!userId || !Number.isFinite(iat) || sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const age = Date.now() / 1000 - iat;
  if (age > MAX_AGE_SEC || age < -300) return null;
  return { userId, fp };
}

/** 現在のログインユーザー (未ログイン・期限切れ・パスワード変更後なら null) */
export async function getSessionUser(): Promise<User | null> {
  const store = await cookies();
  const payload = verifyToken(store.get(SESSION_COOKIE)?.value);
  if (!payload) return null;
  const db = await syncDb();
  const user = db.users.find((u) => u.id === payload.userId && u.active);
  if (!user || fingerprint(user) !== payload.fp) return null;
  return user;
}

/** ログイン必須ページ用。未ログインなら /login へ */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function setSessionCookie(user: SessionSubject) {
  const store = await cookies();
  const proto = (await headers()).get("x-forwarded-proto");
  store.set(SESSION_COOKIE, createToken(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: proto === "https" || process.env.VERCEL === "1",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** ログイン後の移動先。同じサイト内のパスだけを許可する (//example.com などの外部 URL は拒否) */
export function safeNext(next: string | undefined | null): string {
  const v = String(next ?? "");
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || /[\r\n]/.test(v) || v.startsWith("/login")) return "/";
  return v;
}
