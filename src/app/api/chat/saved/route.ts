import { getDb } from "@/lib/db/store";
import { canView, dmName, findChannel } from "@/lib/chat/channels";
import { savedMessages, toViews } from "@/lib/chat/repo";
import { chatUser, json } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 自分の「後で見る」(いまも見られるチャンネルのものだけ) */
export async function GET() {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const db = getDb();
  const names = new Map<string, string>();
  const rows = savedMessages(user.id).filter((m) => {
    if (!names.has(m.channelId)) {
      const ch = findChannel(db, m.channelId);
      names.set(m.channelId, canView(user, ch) ? (ch.kind === "dm" ? dmName(db, ch, user.id) : ch.name) : "");
    }
    return Boolean(names.get(m.channelId));
  });
  return json({ ok: true, messages: toViews(user, rows, db).map((m) => ({ ...m, channelName: names.get(m.channelId) ?? "" })) });
}
