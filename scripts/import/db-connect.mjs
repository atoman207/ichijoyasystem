/**
 * Supabase のデータベース (PostgreSQL) への直接接続 (setup-database.mjs と migrate.mjs で共通)
 *
 * 接続情報 (.env.local または環境変数):
 *   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres   (Supabase の Connect → Session pooler)
 *   または SUPABASE_DB_PASSWORD=<データベースのパスワード>
 *     (NEXT_PUBLIC_SUPABASE_URL からプロジェクトを判定し、直接接続 → 接続プーラー (各リージョン) の順に試す。
 *      直接接続は IPv6 のみのため、Vercel など IPv6 で外に出られない環境では接続プーラーにつながる)
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const REGIONS = ["ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2", "ap-south-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "ca-central-1", "sa-east-1"];

/** 接続文字列のパスワードを伏せる (ログ用) */
export const mask = (s) => s.replace(/:\/\/([^:]+):[^@]+@/, "://$1:****@");

/** 接続情報が設定されているか */
export function hasDbCredentials() {
  return Boolean(process.env.SUPABASE_DB_URL || (process.env.SUPABASE_DB_PASSWORD && process.env.NEXT_PUBLIC_SUPABASE_URL));
}

function candidates() {
  if (process.env.SUPABASE_DB_URL) return { direct: [process.env.SUPABASE_DB_URL], poolers: [] };
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!pw || !url) throw new Error("SUPABASE_DB_URL または SUPABASE_DB_PASSWORD (+ NEXT_PUBLIC_SUPABASE_URL) を設定してください。");
  const ref = new URL(url).hostname.split(".")[0];
  const enc = encodeURIComponent(pw);
  const poolers = [];
  for (const prefix of ["aws-0", "aws-1"]) for (const r of REGIONS) poolers.push(`postgresql://postgres.${ref}:${enc}@${prefix}-${r}.pooler.supabase.com:5432/postgres`);
  return { direct: [`postgresql://postgres:${enc}@db.${ref}.supabase.co:5432/postgres`], poolers };
}

async function tryConnect(conn) {
  // Supabase は SSL 必須。接続文字列に sslmode=disable を書いたとき (手元の PostgreSQL での確認用) だけ SSL なしで接続する
  const ssl = /[?&]sslmode=disable\b/.test(conn) ? false : { rejectUnauthorized: false };
  const client = new Client({ connectionString: conn.replace(/[?&]sslmode=disable\b/, ""), ssl, connectionTimeoutMillis: 10000, keepAlive: true });
  try {
    await client.connect();
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    const msg = String(err.message);
    // パスワード誤りは他の接続先を試しても同じなので中止
    if (/password authentication failed|28P01|SASL/.test(msg) || err.code === "28P01") throw Object.assign(new Error(`パスワードが正しくありません (${mask(conn)})`), { fatal: true });
    throw new Error(`${mask(conn)}: ${msg.slice(0, 80)}`);
  }
}

/** データベースに接続する。{ client, conn } を返す (使い終わったら client.end()) */
export async function connectDatabase(log = console.log) {
  const { direct, poolers } = candidates();
  for (const conn of direct) {
    try {
      const client = await tryConnect(conn);
      return { client, conn };
    } catch (err) {
      if (err.fatal) throw err;
      log(`直接接続できないため接続プーラーを試します (${err.message})`);
    }
  }
  if (!poolers.length) throw new Error("データベースに接続できませんでした");
  // 接続プーラーはプロジェクトのリージョンでしか応答しないので、並列に試して最初につながったものを使う
  const attempts = poolers.map((conn) => tryConnect(conn).then((client) => ({ client, conn })));
  let winner;
  try {
    winner = await Promise.any(attempts);
  } catch (agg) {
    const fatal = agg.errors.find((e) => e.fatal);
    throw fatal ?? new Error("データベースに接続できませんでした (どのリージョンの接続プーラーにもつながりません)");
  }
  for (const a of attempts) a.then(({ client }) => client !== winner.client && client.end().catch(() => {})).catch(() => {});
  return winner;
}
