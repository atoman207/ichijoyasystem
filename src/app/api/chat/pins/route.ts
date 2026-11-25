import { getDb } from "@/lib/db/store";
import { canView, findChannel } from "@/lib/chat/channels";
import { pinnedMessages, toViews } from "@/lib/chat/repo";
import { chatUser, json, jsonError } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** チャンネルのピン留め: ?c=<チャンネル> (新しくピン留めした順) */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const db = getDb();
  const ch = findChannel(db, new URL(req.url).searchParams.get("c") ?? "");
  if (!canView(user, ch)) return jsonError(404, "チャンネルが見つからないか、見る権限がありません。");
  return json({ ok: true, messages: toViews(user, pinnedMessages(ch.id), db) });
}
