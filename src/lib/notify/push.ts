import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { serverDataDir, str, type SqliteDb } from "@/lib/chat/db";
import { prefsOf } from "@/lib/chat/repo";
import { appBaseUrl } from "./config";
import { encryptPayload, generateVapidKeys, validVapid, vapidAuthorization, type VapidKeys } from "./push-crypto";

/**
 * プッシュ通知 (Web Push) の送信
 * ------------------------------------------------------------
 * お客様のご要望 2026-11-25「■1 スマートフォンでシステムを閉じているときも LINE と同じように通知音・ロック画面に通知」:
 * - 端末の登録: 画面の「この端末で通知を受け取る」でブラウザーの許可を取り、配信先 (endpoint・p256dh・auth) を push.sqlite の push_subs に残す (pushDb)。
 *   iPhone はホーム画面に追加したアプリ (iOS 16.4 以降)、Android・パソコンはブラウザーでも受け取れる
 * - 送るもの: チャットのメッセージ (DM・メンション・重要・「すべて通知」のチャンネル)、業務依頼・社内連絡のメンション (notify/events.ts の build)
 * - 本人の設定 (prefs.push) がオフなら送らない。配信先が無効になった (404・410) 端末の登録は消す
 * - 送信履歴 (deliveries) には残さない: DM の本文を管理者が見られる記録に残さないため。端末ごとの最後の成功・失敗の回数だけを残す
 * - 送り主の鍵 (VAPID): 環境変数 PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY。なければ PUSH_VAPID_FILE
 *   (既定は本番サーバーの /srv/ichijoya/data/push-vapid.json) を初めて使うときに作る。3000 番・3001 番・試験期間のテスト用のサーバーで同じ鍵を使う
 *   (鍵が変わると、登録済みの端末に届かなくなるため)
 */

export interface PushPayload {
  title: string;
  body: string;
  /** 押したときに開く画面 (同じサイトの中のパス) */
  url: string;
  /** 同じ印の通知は新しいもので置き換える */
  tag?: string;
  /** 自分あて (メンション・重要・業務依頼)。端末によっては画面に残し、音を鳴らし直す */
  priority?: boolean;
}

/**
 * 送り主の鍵のファイル (端末の登録 push.sqlite も同じフォルダー)。
 * PUSH_VAPID_FILE → 試しのサーバー・テスト (CHATBOT_DB_PATH が /srv/ichijoya の外) はそのフォルダー →
 * 本番・3001 番・試験期間のテスト用のサーバーは /srv/ichijoya/data (同じ鍵と端末の登録を使う) → 手元は data/
 */
function vapidFile(): string {
  const env = process.env.PUSH_VAPID_FILE?.trim();
  if (env) return env;
  const bot = process.env.CHATBOT_DB_PATH?.trim();
  if (bot && !path.resolve(bot).startsWith("/srv/ichijoya/")) return path.join(path.dirname(path.resolve(bot)), "push-vapid.json");
  const dir = serverDataDir();
  if (dir) return path.join(dir, "push-vapid.json");
  return path.join(process.cwd(), "data", "push-vapid.json");
}

const g = globalThis as typeof globalThis & { __ichijoyaVapid?: VapidKeys | null; __ichijoyaPushDb?: { file: string; db: SqliteDb } };

/**
 * 端末の登録の置き場所 (PUSH_DB_PATH。なければ送り主の鍵と同じフォルダーの push.sqlite)。
 * チャットのデータとは分け、試験期間のテスト用のサーバーと本番で同じものを使う (12/1 に本番に戻しても、端末の登録をし直さなくてよいように)
 */
function pushDb(): SqliteDb {
  const file = process.env.PUSH_DB_PATH?.trim() || path.join(path.dirname(vapidFile()), "push.sqlite");
  if (g.__ichijoyaPushDb?.file === file) return g.__ichijoyaPushDb.db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (f: string) => SqliteDb } }).getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    create table if not exists push_subs (
      id text primary key,
      user_id text not null,
      endpoint text not null,
      p256dh text not null,
      auth text not null,
      ua text not null default '',
      created_at text not null,
      last_ok_at text,
      fail_count integer not null default 0,
      last_error text
    );
    create index if not exists push_subs_user on push_subs (user_id);
  `);
  g.__ichijoyaPushDb = { file, db };
  return db;
}

/** テスト用: 接続を閉じる */
export function closePushDb() {
  g.__ichijoyaPushDb?.db.close();
  g.__ichijoyaPushDb = undefined;
}

/** 送り主の鍵 (使えないときは null) */
export function vapidKeys(): VapidKeys | null {
  if (g.__ichijoyaVapid !== undefined) return g.__ichijoyaVapid;
  const fromEnv = { publicKey: process.env.PUSH_VAPID_PUBLIC_KEY?.trim() ?? "", privateKey: process.env.PUSH_VAPID_PRIVATE_KEY?.trim() ?? "" };
  if (fromEnv.publicKey || fromEnv.privateKey) {
    g.__ichijoyaVapid = validVapid(fromEnv) ? fromEnv : null;
    if (!g.__ichijoyaVapid) console.warn("[push] PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY の形が正しくありません。プッシュ通知を止めます");
    return g.__ichijoyaVapid;
  }
  const file = vapidFile();
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8")) as VapidKeys;
    g.__ichijoyaVapid = validVapid(k) ? k : null;
    if (!g.__ichijoyaVapid) console.warn(`[push] ${file} の鍵の形が正しくありません。プッシュ通知を止めます`);
    return g.__ichijoyaVapid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[push] could not read VAPID keys:", (err as Error).message);
      g.__ichijoyaVapid = null;
      return null;
    }
  }
  // 初めて: 鍵を作る (ほかのサーバーと同時に作っても、先に書いた方を使う)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const k = generateVapidKeys();
    fs.writeFileSync(file, JSON.stringify(k), { flag: "wx", mode: 0o600 });
    console.info(`[push] created VAPID keys at ${file}`);
    g.__ichijoyaVapid = k;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const k = JSON.parse(fs.readFileSync(file, "utf8")) as VapidKeys;
        g.__ichijoyaVapid = validVapid(k) ? k : null;
      } catch {
        g.__ichijoyaVapid = null;
      }
    } else {
      console.warn("[push] could not create VAPID keys:", (err as Error).message);
      g.__ichijoyaVapid = null;
    }
  }
  return g.__ichijoyaVapid ?? null;
}

/** VAPID の sub (配信サービスが問い合わせ先にする。https の URL か mailto:) */
function subject(): string {
  const env = process.env.PUSH_VAPID_SUBJECT?.trim();
  if (env) return env;
  const base = appBaseUrl();
  if (base.startsWith("https://")) return base;
  const from = process.env.MAIL_FROM?.match(/[^\s<>]+@[^\s<>]+/)?.[0];
  return from ? `mailto:${from}` : "https://localhost";
}

export interface PushSub {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string;
  createdAt: string;
  lastOkAt?: string;
  failCount: number;
  lastError?: string;
}

const subId = (endpoint: string) => createHash("sha256").update(endpoint).digest("base64url").slice(0, 32);

/** 配信先として受け付ける URL (https の配信サービスだけ。社内のサーバーなどへ送らせない) */
export function allowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (process.env.PUSH_ALLOW_ANY_ENDPOINT === "1") return u.protocol === "http:" || u.protocol === "https:";
    return u.protocol === "https:" && /(^|\.)(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function saveSubscription(userId: string, sub: { endpoint: string; p256dh: string; auth: string; ua: string }): string {
  const id = subId(sub.endpoint);
  pushDb()
    .prepare(
      `insert into push_subs (id, user_id, endpoint, p256dh, auth, ua, created_at, fail_count) values (?, ?, ?, ?, ?, ?, ?, 0)
       on conflict (id) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, fail_count = 0, last_error = null`,
    )
    .run(id, userId, sub.endpoint, sub.p256dh, sub.auth, sub.ua.slice(0, 200), new Date().toISOString());
  return id;
}

export function removeSubscription(userId: string, endpoint: string): void {
  pushDb().prepare("delete from push_subs where id = ? and user_id = ?").run(subId(endpoint), userId);
}

export function subscriptionsOf(userId: string): PushSub[] {
  return pushDb()
    .prepare("select * from push_subs where user_id = ? order by created_at")
    .all(userId)
    .map((r) => ({ id: String(r.id), userId: String(r.user_id), endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth), ua: String(r.ua ?? ""), createdAt: String(r.created_at), lastOkAt: str(r.last_ok_at), failCount: Number(r.fail_count ?? 0), lastError: str(r.last_error) }));
}

export function hasSubscription(userId: string, endpoint: string): boolean {
  return Boolean(pushDb().prepare("select 1 from push_subs where id = ? and user_id = ?").get(subId(endpoint), userId));
}

export type PushResult = "sent" | "gone" | "failed" | "skipped";

/** 1 つの端末に送る */
export async function sendPush(sub: Pick<PushSub, "id" | "endpoint" | "p256dh" | "auth">, payload: PushPayload): Promise<{ result: PushResult; status?: number; error?: string }> {
  const keys = vapidKeys();
  if (!keys) return { result: "skipped", error: "プッシュ通知の鍵がありません" };
  const json = Buffer.from(JSON.stringify(trimPayload(payload)));
  let body: Buffer;
  try {
    body = encryptPayload(json, sub.p256dh, sub.auth);
  } catch (err) {
    return { result: "gone", error: (err as Error).message };
  }
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: payload.priority ? "86400" : "21600",
        Urgency: payload.priority ? "high" : "normal",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: vapidAuthorization(sub.endpoint, keys, subject()),
        ...(payload.tag ? { Topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (res.status >= 200 && res.status < 300) return { result: "sent", status: res.status };
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 404 || res.status === 410) return { result: "gone", status: res.status, error: text };
    return { result: "failed", status: res.status, error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (err) {
    return { result: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** 本文が配信サービスの上限 (4 KB) に収まるように縮める */
function trimPayload(p: PushPayload): PushPayload {
  const title = p.title.slice(0, 80);
  let body = p.body.replace(/\s+/g, " ").trim();
  if (body.length > 180) body = `${body.slice(0, 179)}…`;
  return { title, body, url: p.url.slice(0, 500), tag: p.tag?.slice(0, 64), priority: p.priority || undefined };
}

function record(sub: PushSub, r: { result: PushResult; error?: string }) {
  const db = pushDb();
  if (r.result === "sent") db.prepare("update push_subs set last_ok_at = ?, fail_count = 0, last_error = null where id = ?").run(new Date().toISOString(), sub.id);
  else if (r.result === "gone") db.prepare("delete from push_subs where id = ?").run(sub.id);
  else if (r.result === "failed") {
    // 20 回続けて失敗した端末は登録を消す (機種変更・ブラウザーの削除など)
    if (sub.failCount + 1 >= 20) db.prepare("delete from push_subs where id = ?").run(sub.id);
    else db.prepare("update push_subs set fail_count = fail_count + 1, last_error = ? where id = ?").run((r.error ?? "").slice(0, 300), sub.id);
  }
}

/** 社員に送る (本人がプッシュ通知をオフにしていれば送らない)。結果の数を返す */
export async function pushToUsers(userIds: string[], payload: PushPayload): Promise<{ sent: number; failed: number; devices: number }> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length || !vapidKeys()) return { sent: 0, failed: 0, devices: 0 };
  const subs = ids.filter((id) => prefsOf(id).push).flatMap((id) => subscriptionsOf(id));
  let sent = 0;
  let failed = 0;
  // 同時に送るのは 8 件まで
  for (let i = 0; i < subs.length; i += 8) {
    const batch = subs.slice(i, i + 8);
    const results = await Promise.all(batch.map((s) => sendPush(s, payload)));
    batch.forEach((s, j) => {
      record(s, results[j]);
      if (results[j].result === "sent") sent++;
      else if (results[j].result === "failed") failed++;
    });
  }
  if (failed) console.warn(`[push] ${failed}/${subs.length} pushes failed (${payload.tag ?? payload.url})`);
  return { sent, failed, devices: subs.length };
}

/** 応答を返したあとに送る (画面の操作を待たせない)。リクエストの外 (テスト・定期実行) ではその場で始める */
export function pushLater(items: { userIds: string[]; payload: PushPayload }[]): void {
  const list = items.filter((x) => x.userIds.length);
  if (!list.length) return;
  const run = async () => {
    for (const x of list) await pushToUsers(x.userIds, x.payload).catch((err) => console.warn("[push] send failed:", (err as Error).message));
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
