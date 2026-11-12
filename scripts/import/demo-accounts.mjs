/**
 * デモ用アカウント (架空の 15 名) を本番データベース用の行にする
 * ------------------------------------------------------------
 * - 中身は src/lib/db/master.ts の USERS (ローカルのサンプルデータと同じ ID・氏名・ログイン ID・パスワード demo1234)
 * - users.password 列は check 制約で null だけなので、パスワードは scrypt のハッシュ (アプリの hashPassword と同じ形式) で保存する
 * - ログイン ID は @ichijoya.example (予約ドメイン)。社員のログイン ID (@ なし) とは重ならない
 * - 役職の先頭に【デモ用】を付け、社員の一覧で見分けられるようにする
 * - 承認先の判定では、デモ用アカウントの申請にはデモ用の店長、社員の申請には社員の店長だけを数える (permissions.ts の approverRole)
 *
 * 使う場所: seed-demo-accounts.mjs (Supabase に登録)、generate-data-sql.mjs / load-to-supabase.mjs (全データの入れ直しにも含める)
 */
import { randomBytes, scryptSync } from "node:crypto";
import { DEMO_PASSWORD, USERS } from "../../src/lib/db/master.ts";

export { DEMO_PASSWORD };
export const DEMO_TITLE_PREFIX = "【デモ用】";

/** src/lib/auth/password.ts の hashPassword と同じ形式 (scrypt$N$r$p$salt$key) */
export function hashPassword(input) {
  const salt = randomBytes(16);
  const key = scryptSync(input, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** src/lib/auth/password.ts の verifyPassword と同じ照合 (登録後の確認用) */
export function verifyHash(hash, input) {
  const [algo, n, r, p, salt, key] = String(hash ?? "").split("$");
  if (algo !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = scryptSync(input, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.equals(expected);
}

/** デモ用アカウントの行 (平文パスワードは持たない) */
export function demoAccounts() {
  return USERS.map(({ password, ...u }) => ({
    ...u,
    title: u.title.startsWith(DEMO_TITLE_PREFIX) ? u.title : `${DEMO_TITLE_PREFIX}${u.title}`,
    passwordHash: hashPassword(password ?? DEMO_PASSWORD),
    active: true,
  }));
}

/** 移行データ (client-data.json) の users にデモ用アカウントを加える。同じ ID・ログイン ID の行は置き換える */
export function withDemoAccounts(db) {
  const demo = demoAccounts();
  const ids = new Set(demo.map((u) => u.id));
  const emails = new Set(demo.map((u) => u.email.toLowerCase()));
  const users = (db.users ?? []).filter((u) => !ids.has(u.id) && !emails.has(String(u.email).toLowerCase()));
  return { ...db, users: [...users, ...demo] };
}
