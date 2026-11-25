import { getDb } from "@/lib/db/store";
import { chatState } from "@/lib/chat/inbox";
import { canView, findChannel } from "@/lib/chat/channels";
import { changedSince, getMessage, taskInfo, toViews } from "@/lib/chat/repo";
import { chatDb, currentRev } from "@/lib/chat/db";
import { chatUser, json } from "@/lib/chat/api";
import type { ChatSyncResponse, ChatTaskInfo } from "@/lib/chat/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * チャットの画面の更新 (数秒ごと): チャンネルの一覧・要対応・開いているチャンネルとスレッドの変わったメッセージ
 * ?c=<チャンネル>&t=<スレッドの最初のメッセージ>&rev=<前回の rev>
 */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const db = getDb();
  const rev = currentRev();
  const since = Number(url.searchParams.get("rev") ?? "0") || 0;
  const c = url.searchParams.get("c") ?? "";
  const t = url.searchParams.get("t") ?? "";
  const state = chatState(db, user);
  const ch = c ? findChannel(db, c) : undefined;
  const out: ChatSyncResponse = { rev, channels: state.channels, counts: state.counts, inbox: state.inbox, waiting: state.waiting, messages: [], replies: [], tasks: {} };
  if (ch && canView(user, ch)) {
    const root = t ? getMessage(t) : undefined;
    const thread = root && root.channelId === ch.id ? root.id : undefined;
    const changed = since > 0 ? changedSince(ch.id, since, thread) : { messages: [], replies: [] };
    out.messages = toViews(user, changed.messages, db);
    out.replies = toViews(user, changed.replies, db);
    // 業務依頼の状態 (チャットの外で進む) をメッセージの印に反映する
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const rows = chatDb().prepare("select task_thread_id from messages where channel_id = ? and task_thread_id is not null order by at desc limit 100").all(ch.id);
    const tasks: Record<string, ChatTaskInfo> = {};
    for (const r of rows) {
      const info = taskInfo(db, String(r.task_thread_id), today);
      if (info) tasks[info.threadId] = info;
    }
    out.tasks = tasks;
  }
  return json(out);
}
