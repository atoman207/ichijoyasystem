import { getDb } from "@/lib/db/store";
import { canView, findChannel } from "@/lib/chat/channels";
import { getMessage, readsOf, replies, toViews } from "@/lib/chat/repo";
import { currentRev } from "@/lib/chat/db";
import { chatUser, json, jsonError } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** スレッド: ?id=<最初のメッセージ> → 最初のメッセージと返信 */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const db = getDb();
  const root = getMessage(id);
  if (!root || root.parentId) return jsonError(404, "スレッドが見つかりません。");
  if (!canView(user, findChannel(db, root.channelId))) return jsonError(404, "スレッドが見つからないか、見る権限がありません。");
  const rev = currentRev();
  return json({ ok: true, rev, root: toViews(user, [root], db)[0], replies: toViews(user, replies(root.id), db), lastRead: readsOf(user.id).get(`t:${root.id}`) ?? "" });
}
