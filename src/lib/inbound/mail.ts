import "server-only";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { getDb, mutate, syncDb } from "@/lib/db/store";
import { inboundMailState, inboundSettings, setInboundMailState } from "@/lib/inbound/feed";
import { recordMail, type MailLike } from "@/lib/inbound/mail-record";

/**
 * 会社のメールボックス (例: Xserver の info@ichijoya.co.jp) に届いたメールを通知にする (お客様のご要望 2026-11-26)
 * ------------------------------------------------------------
 * - IMAP で読む (imapflow)。メールボックスは読み取り専用で開き (EXAMINE)、本文も BODY.PEEK で読むので、メールソフトの「未読」は変わらない。
 *   削除・移動もしない
 * - 接続先: INBOUND_MAIL_HOST・INBOUND_MAIL_PORT (993)・INBOUND_MAIL_USER・INBOUND_MAIL_PASSWORD・INBOUND_MAIL_MAILBOX (INBOX)。
 *   なければ送信と同じ SMTP_HOST・SMTP_USER・SMTP_PASSWORD (Xserver は同じアカウントで IMAP も使える。smtp.〜 は imap.〜 に読み替え)。
 *   INBOUND_MAIL=off で止める
 * - 管理者が 設定 → 外部連携・AI で「メールの受信を通知する」をオンにしたときだけ動く (settings の inbound_settings.mailEnabled)
 * - 動くきっかけ: 画面の 1 分ごとの /api/notifications/summary (2 分に 1 回まで・応答は待たない) と定期の /api/cron/inbound-mail
 * - 最初の 1 回は直近 24 時間 (20 通まで) を読み、そのあとは前回より新しい UID だけ。UIDVALIDITY が変わったら起点を作り直す
 * - 1 回に読むのは 30 通まで (残りは次の回)。1 通は 512 KB まで読む (それより後ろの添付ファイルは読まない)
 */

const env = (name: string) => (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");
const THROTTLE_MS = 2 * 60 * 1000;
const PER_RUN = 30;
const FIRST_RUN_MAX = 20;
const SOURCE_MAX = 512 * 1024;

export interface InboundMailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  /** どの環境変数を使っているか (画面の表示) */
  source: "INBOUND_MAIL_*" | "SMTP_*";
}

export function inboundMailConfig(): InboundMailConfig | null {
  if (/^(off|false|0|no)$/i.test(env("INBOUND_MAIL"))) return null;
  const own = env("INBOUND_MAIL_HOST");
  const host = own || env("SMTP_HOST").replace(/^smtp\./i, "imap.");
  const user = env("INBOUND_MAIL_USER") || env("SMTP_USER");
  const pass = env("INBOUND_MAIL_PASSWORD") || env("SMTP_PASSWORD");
  if (!host || !user || !pass) return null;
  const port = Number(env("INBOUND_MAIL_PORT")) || 993;
  // 暗号化: 993 は最初から TLS、143 はサーバーが対応していれば STARTTLS。INBOUND_MAIL_SECURE=false は試験用のサーバーだけ
  const secureEnv = env("INBOUND_MAIL_SECURE").toLowerCase();
  const secure = secureEnv ? !/^(false|0|no|off)$/.test(secureEnv) : port !== 143;
  return { host, port, secure, user, pass, mailbox: env("INBOUND_MAIL_MAILBOX") || "INBOX", source: own ? "INBOUND_MAIL_*" : "SMTP_*" };
}

/** このシステムが送るときのアドレス (自分の送信の控えを受信に数えない) */
function selfAddresses(cfg: InboundMailConfig): string[] {
  const from = env("MAIL_FROM");
  const m = from.match(/<([^>]+)>/);
  return [cfg.user, m ? m[1] : from].filter((a) => a.includes("@"));
}

function header(p: ParsedMail, name: string): string | undefined {
  const v = p.headers.get(name);
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : typeof v === "object" && "text" in (v as object) ? String((v as { text?: string }).text ?? "") : String(v);
}

function listHas(p: ParsedMail, key: string): boolean {
  const v = p.headers.get("list");
  return Boolean(v && typeof v === "object" && key in (v as object)) || p.headers.has(`list-${key}`);
}

/** mailparser の結果 → 記録に使う項目 */
export function toMailLike(p: ParsedMail): MailLike {
  const from = p.from?.value?.[0];
  const html = typeof p.html === "string" ? p.html : "";
  const text = p.text?.trim() || html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return {
    fromAddress: from?.address,
    fromName: from?.name,
    subject: p.subject,
    text,
    date: p.date && !Number.isNaN(p.date.getTime()) ? p.date.toISOString() : undefined,
    autoSubmitted: header(p, "auto-submitted"),
    precedence: header(p, "precedence"),
    // mailparser は List-Id・List-Unsubscribe などを 1 つの "list" (id・unsubscribe…) にまとめる
    listId: listHas(p, "id"),
    listUnsubscribe: listHas(p, "unsubscribe"),
  };
}

export interface MailPollResult {
  ok: boolean;
  skipped?: "disabled" | "not_configured" | "throttled" | "running";
  recorded?: number;
  baseline?: boolean;
  error?: string;
}

const g = globalThis as typeof globalThis & { __ichijoyaInboundMail?: { running: boolean; last: number } };
const state = (g.__ichijoyaInboundMail ??= { running: false, last: 0 });

/** 接続の誤りを社員に分かる言葉にする (パスワードなどは出さない) */
function mailError(err: unknown): string {
  const e = err as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string };
  if (e?.authenticationFailed) return "メールサーバーにログインできませんでした (ユーザー名・パスワードを確かめてください)";
  if (e?.code === "ENOTFOUND") return "メールサーバーが見つかりません (INBOUND_MAIL_HOST・SMTP_HOST を確かめてください)";
  if (e?.code === "ETIMEDOUT" || e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET") return `メールサーバーに接続できませんでした (${e.code})`;
  return `メールの受信に失敗しました: ${(e?.responseText || e?.message || String(err)).slice(0, 160)}`;
}

/**
 * 新しいメールを読んで記録する。force = 間隔の制限を無視する (設定の「今すぐ確認」・定期実行)
 */
export async function pollInboundMail(opts: { force?: boolean } = {}): Promise<MailPollResult> {
  const cfg = inboundMailConfig();
  if (!cfg) return { ok: false, skipped: "not_configured" };
  const db0 = await syncDb();
  if (!inboundSettings(db0).mailEnabled) return { ok: true, skipped: "disabled" };
  if (state.running) return { ok: true, skipped: "running" };
  const st = inboundMailState(db0);
  const now = Date.now();
  // ほかのサーバー (本番・テスト・開発) と重ならないように、保存した最後の実行の時刻でも間隔を守る
  if (!opts.force && st.lastRunAt && now - Date.parse(st.lastRunAt) < THROTTLE_MS) return { ok: true, skipped: "throttled" };
  state.running = true;
  state.last = now;
  const runAt = new Date(now).toISOString();
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false, disableAutoIdle: true, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 45_000 });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox, { readOnly: true });
    let recorded = 0;
    let baseline = false;
    try {
      const box = client.mailbox;
      if (!box) throw new Error("メールボックスを開けませんでした");
      const uidValidity = String(box.uidValidity);
      const top = Math.max(0, box.uidNext - 1);
      let uids: number[];
      if (st.uidValidity !== uidValidity || typeof st.lastUid !== "number") {
        // 最初の 1 回 (または起点の作り直し): 直近 24 時間の 20 通まで
        baseline = true;
        const since = new Date(now - 24 * 3600 * 1000);
        const found = (await client.search({ since }, { uid: true })) || [];
        uids = found.filter((u) => u <= top).sort((a, b) => a - b).slice(-FIRST_RUN_MAX);
      } else {
        const last = st.lastUid;
        if (top <= last) uids = [];
        else {
          const found = (await client.search({ uid: `${last + 1}:*` }, { uid: true })) || [];
          uids = found.filter((u) => u > last).sort((a, b) => a - b).slice(0, PER_RUN);
        }
      }
      const parsed: { uid: number; at: string; mail: MailLike }[] = [];
      if (uids.length) {
        for await (const m of client.fetch(uids.join(","), { uid: true, internalDate: true, source: { maxLength: SOURCE_MAX } }, { uid: true })) {
          if (!m.source) continue;
          try {
            const p = await simpleParser(m.source);
            const internal = m.internalDate ? new Date(m.internalDate) : undefined;
            const mail = toMailLike(p);
            parsed.push({ uid: m.uid, at: internal && !Number.isNaN(internal.getTime()) ? internal.toISOString() : mail.date ?? runAt, mail });
          } catch (err) {
            console.warn("[inbound-mail] parse failed:", m.uid, (err as Error).message);
          }
        }
      }
      // 読んだところまで進める (読めなかったメールで止まらないように)。最初の 1 回は今の最後まで
      const nextLast = baseline ? top : Math.max(st.lastUid ?? 0, ...uids);
      const self = selfAddresses(cfg);
      await mutate((db) => {
        for (const p of parsed.sort((a, b) => a.uid - b.uid)) if (recordMail(db, p.mail, { id: `mail_${uidValidity}_${p.uid}`, at: p.at, selfAddresses: self }) === "recorded") recorded++;
        const cur = inboundMailState(db);
        // ほかのサーバーが先に進めていたら戻さない
        const keep = cur.uidValidity === uidValidity && typeof cur.lastUid === "number" && cur.lastUid > nextLast ? cur.lastUid : nextLast;
        setInboundMailState(db, { uidValidity, lastUid: keep, lastRunAt: runAt, lastOkAt: runAt, lastError: undefined, received: (cur.received ?? 0) + recorded });
      });
    } finally {
      lock.release();
    }
    await client.logout().catch(() => undefined);
    return { ok: true, recorded, baseline };
  } catch (err) {
    const msg = mailError(err);
    console.warn("[inbound-mail]", msg);
    client.close();
    await mutate((db) => setInboundMailState(db, { lastRunAt: runAt, lastError: msg })).catch(() => undefined);
    return { ok: false, error: msg };
  } finally {
    state.running = false;
  }
}

/** 画面の読み込みから (2 分に 1 回まで。応答は待たない) */
export function triggerInboundMail(): void {
  const t = Date.now();
  if (state.running || t - state.last < THROTTLE_MS) return;
  if (!inboundMailConfig() || !inboundSettings(getDb()).mailEnabled) return;
  state.last = t;
  pollInboundMail().catch((err) => console.warn("[inbound-mail] failed:", (err as Error).message));
}
