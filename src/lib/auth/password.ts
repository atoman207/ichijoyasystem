import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { User } from "@/lib/db/types";

/**
 * パスワードの照合
 * - 本番データ: scrypt のハッシュ (scrypt$N$r$p$salt$key、取込スクリプトと同じ形式) と照合
 * - ローカル検証用のサンプルデータ: 平文 (password) と照合
 */
export function verifyPassword(user: User, input: string): boolean {
  if (user.passwordHash) {
    const [algo, n, r, p, salt, key] = user.passwordHash.split("$");
    if (algo !== "scrypt" || !salt || !key) return false;
    const expected = Buffer.from(key, "base64url");
    const actual = scryptSync(input, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  return Boolean(user.password) && user.password === input;
}

/** パスワードを scrypt でハッシュ化する (scrypt$N$r$p$salt$key) */
export function hashPassword(input: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(input, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
