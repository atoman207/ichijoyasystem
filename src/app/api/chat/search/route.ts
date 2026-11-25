import { getDb } from "@/lib/db/store";
import { dmName, visibleChannels } from "@/lib/chat/channels";
import { searchMessages, toViews } from "@/lib/chat/repo";
import { chatUser, json } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 検索: ?q=<言葉> &in=<チャンネル> &from=<社員> (見られるチャンネル・DM の本文と資料の名前。新しい順に 80 件) */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  // 絞り込み: in = チャンネル・DM / from = 送った人
  const inId = url.searchParams.get("in") ?? "";
  const fromId = url.searchParams.get("from") || undefined;
  const db = getDb();
  const defs = visibleChannels(db, user);
  const names = Object.fromEntries(defs.map((d) => [d.id, d.kind === "dm" ? dmName(db, d, user.id) : d.name]));
  const ids = inId ? defs.filter((d) => d.id === inId).map((d) => d.id) : defs.map((d) => d.id);
  const rows = q || fromId ? searchMessages(ids, q, 80, fromId) : [];
  return json({ ok: true, q, results: toViews(user, rows, db).map((m) => ({ ...m, channelName: names[m.channelId] ?? "" })) });
}
