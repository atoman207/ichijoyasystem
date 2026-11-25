import { getDb } from "@/lib/db/store";
import { canView, findChannel } from "@/lib/chat/channels";
import { channelMessages, getMessage, messagesAround, toViews } from "@/lib/chat/repo";
import { currentRev } from "@/lib/chat/db";
import { readsOf } from "@/lib/chat/repo";
import { chatUser, json, jsonError } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** チャンネルのメッセージ: ?c=<チャンネル> (&before=<日時> で前の 50 件、&around=<メッセージ> でその前後) */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const db = getDb();
  const ch = findChannel(db, url.searchParams.get("c") ?? "");
  if (!canView(user, ch)) return jsonError(404, "チャンネルが見つからないか、見る権限がありません。");
  const rev = currentRev();
  const around = url.searchParams.get("around");
  const before = url.searchParams.get("before") ?? undefined;
  let page;
  if (around) {
    const m = getMessage(around);
    const target = m && m.channelId === ch.id ? (m.parentId ? getMessage(m.parentId) : m) : undefined;
    page = target ? messagesAround(ch.id, target.at) : channelMessages(ch.id);
  } else page = channelMessages(ch.id, { before });
  return json({ ok: true, rev, messages: toViews(user, page.rows, db), hasMore: page.hasMore, lastRead: readsOf(user.id).get(ch.id) ?? "" });
}
