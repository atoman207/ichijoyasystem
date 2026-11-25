import { getDb } from "@/lib/db/store";
import { dmName, visibleChannels } from "@/lib/chat/channels";
import { searchMessages, toViews } from "@/lib/chat/repo";
import { chatUser, json } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 検索: ?q=<言葉> (見られるチャンネル・DM の本文と資料の名前。新しい順に 60 件) */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  const db = getDb();
  const defs = visibleChannels(db, user);
  const names = Object.fromEntries(defs.map((d) => [d.id, d.kind === "dm" ? dmName(db, d, user.id) : d.name]));
  const rows = q ? searchMessages(defs.map((d) => d.id), q) : [];
  return json({ ok: true, q, results: toViews(user, rows, db).map((m) => ({ ...m, channelName: names[m.channelId] ?? "" })) });
}
