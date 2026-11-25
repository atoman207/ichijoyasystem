import { getDb } from "@/lib/db/store";
import { dmName, visibleChannels } from "@/lib/chat/channels";
import { importantMessages, toViews } from "@/lib/chat/repo";
import { chatUser, json } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 重要メッセージの一覧 (見られるチャンネルの、新しい順に 100 件。確認の状態つき) */
export async function GET() {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const db = getDb();
  const defs = visibleChannels(db, user);
  const names = Object.fromEntries(defs.map((d) => [d.id, d.kind === "dm" ? dmName(db, d, user.id) : d.name]));
  const rows = importantMessages(defs.map((d) => d.id));
  return json({ ok: true, messages: toViews(user, rows, db).map((m) => ({ ...m, channelName: names[m.channelId] ?? "" })) });
}
