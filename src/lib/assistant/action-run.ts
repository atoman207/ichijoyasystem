import "server-only";
import type { InquiryStatus, User } from "@/lib/db/types";
import { chatbotDb } from "@/lib/chatbot/store";
import { createScheduleEvent, deleteScheduleEvent, updateScheduleEvent } from "@/lib/actions/schedule";
import { createInquiry, setInquiryStatus } from "@/lib/actions/inquiries";
import { addProgress } from "@/lib/actions/orders";
import { createThread } from "@/lib/actions/messages";
import { decideApproval } from "@/lib/actions/approvals";
import { ACTION_LABEL, verifyPayload, type ActionPayload } from "./actions";

/**
 * AI アシスタントの確認のカードの「実行する」(/api/assistant/action から呼ぶ)
 * - 署名・本人・期限を確かめ、1 枚につき 1 回だけ実行する (実行の記録はチャットボットの SQLite の assistant_actions。3000 番と 3001 番で共有)
 * - 画面のボタンと同じ Server Action を同じ入力で呼ぶ。Server Action の最後の転送 (redirect) から、結果の文と開く画面を読む
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 結果を見る画面 */
  href?: string;
}

function table() {
  const db = chatbotDb();
  db.exec(`
    create table if not exists assistant_actions (
      nonce text primary key,
      user_id text not null,
      kind text not null,
      summary text not null,
      status text not null,
      message text not null default '',
      href text,
      created_at text not null,
      finished_at text
    );
    create index if not exists assistant_actions_user on assistant_actions (user_id, created_at);
  `);
  return db;
}

/** 実行を始めてよいか (同じカードの 2 回目・同時の実行を断る)。失敗したカードはやり直せる */
function claim(p: ActionPayload): string | null {
  const db = table();
  const now = new Date().toISOString();
  const row = db.prepare("select status from assistant_actions where nonce = ?").get(p.n) as { status: string } | undefined;
  if (row?.status === "done") return "この操作はすでに実行しました。";
  if (row?.status === "running") return "この操作は実行中です。";
  // 別のプロセス (3000 番と 3001 番) と同時に押されたときも、書き込めた 1 つだけが実行する
  const changed = row
    ? db.prepare("update assistant_actions set status = 'running', created_at = ?, finished_at = null where nonce = ? and status = 'failed'").run(now, p.n).changes
    : db.prepare("insert or ignore into assistant_actions (nonce, user_id, kind, summary, status, created_at) values (?, ?, ?, ?, 'running', ?)").run(p.n, p.u, p.k, p.s, now).changes;
  return Number(changed) === 1 ? null : "この操作は実行中か、すでに実行しました。";
}

function finish(p: ActionPayload, r: ActionResult) {
  table()
    .prepare("update assistant_actions set status = ?, message = ?, href = ?, finished_at = ? where nonce = ?")
    .run(r.ok ? "done" : "failed", r.message.slice(0, 500), r.href ?? null, new Date().toISOString(), p.n);
}

/** Next.js の redirect() が投げるもの (digest = NEXT_REDIRECT;<種類>;<URL>;<状態>;) から URL を読む */
export function redirectTarget(err: unknown): string | null {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) return null;
  return digest.split(";").slice(2, -2).join(";");
}

/** 転送先の URL → 結果 (?err= は失敗・?msg= は成功の文) */
export function resultOf(url: string): ActionResult {
  let u: URL;
  try {
    u = new URL(url, "http://local");
  } catch {
    return { ok: true, message: "実行しました。" };
  }
  const err = u.searchParams.get("err");
  const msg = u.searchParams.get("msg");
  u.searchParams.delete("err");
  u.searchParams.delete("msg");
  const href = u.pathname.startsWith("/") && !u.pathname.startsWith("//") ? `${u.pathname}${u.search}` : undefined;
  if (err) return { ok: false, message: err, href: href === "/login" ? undefined : href };
  if (u.pathname === "/login") return { ok: false, message: "ログインの期限が切れています。もう一度ログインしてください。" };
  return { ok: true, message: msg || "実行しました。", href };
}

function formOf(p: ActionPayload): FormData {
  const fd = new FormData();
  for (const [k, v] of p.f) fd.append(k, v);
  return fd;
}

async function call(p: ActionPayload): Promise<unknown> {
  const fd = formOf(p);
  switch (p.k) {
    case "create_schedule_event":
      return createScheduleEvent(fd);
    case "update_schedule_event":
      return updateScheduleEvent(p.t!, fd);
    case "delete_schedule_event":
      return deleteScheduleEvent(p.t!, fd);
    case "create_inquiry":
      return createInquiry(fd);
    case "set_inquiry_status":
      return setInquiryStatus(p.t!, p.d as InquiryStatus);
    case "add_order_progress":
      return addProgress(p.t!, fd);
    case "create_message":
      return createThread(fd);
    case "decide_approval":
      return decideApproval(p.t!, p.d as "approved" | "returned" | "rejected", fd);
  }
}

/** 確認のカードの実行 (ログインしている本人。権限・入力の確かめは呼んだ Server Action が画面と同じく行う) */
export async function runAction(token: string, user: User, now = Date.now()): Promise<ActionResult> {
  const v = verifyPayload(token, user.id, now);
  if (!v.ok) return { ok: false, message: v.error };
  const p = v.payload;
  const busy = claim(p);
  if (busy) return { ok: false, message: busy };
  let result: ActionResult;
  try {
    await call(p);
    result = { ok: true, message: `${ACTION_LABEL[p.k]}を実行しました。` };
  } catch (err) {
    const url = redirectTarget(err);
    if (url) result = resultOf(url);
    else {
      console.error("[assistant-action] failed:", p.k, (err as Error).message);
      result = { ok: false, message: `実行できませんでした (${(err as Error).message.slice(0, 120)})。画面から操作してください。` };
    }
  }
  finish(p, result);
  return result;
}

/** 最近 AI アシスタントから実行した操作 (本人の分) */
export function recentActions(userId: string, limit = 20): { kind: string; summary: string; status: string; message: string; href: string | null; at: string }[] {
  return table()
    .prepare("select kind, summary, status, message, href, coalesce(finished_at, created_at) as at from assistant_actions where user_id = ? order by created_at desc limit ?")
    .all(userId, limit) as { kind: string; summary: string; status: string; message: string; href: string | null; at: string }[];
}
