import { getDb } from "@/lib/db/store";
import { canAdministerChatChannels } from "@/lib/auth/permissions";
import { allCustomChannels, systemChannels } from "@/lib/chat/channels";
import { channelView } from "@/lib/chat/inbox";
import { channelUsage } from "@/lib/chat/repo";
import { chatUser, json, jsonError } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * チャンネルの管理 (管理者だけ。お客様のご要望 2026-11-26「管理者にチャンネルの削除・追加・修正の全権限」):
 * 全社・店舗・店長のチャンネルと、追加したチャンネルすべて (非公開・アーカイブしたものを含む) の名前・メンバー・作成者・メッセージの数。
 * メッセージの中身は返さない (メンバーでないチャンネルの内容は管理者も見られない)。DM は含めない
 */
export async function GET() {
  const user = await chatUser();
  if (user instanceof Response) return user;
  if (!canAdministerChatChannels(user)) return jsonError(403, "チャンネルの管理は管理者だけが使えます。");
  const db = getDb();
  const defs = [...systemChannels(db), ...allCustomChannels(db)];
  const usage = channelUsage(defs.map((d) => d.id));
  const channels = defs.map((d) => {
    const u = usage.get(d.id);
    return { ...channelView(db, user, d, { stat: { unread: 0, mentions: 0, lastAt: u?.lastAt } }), messages: u?.messages ?? 0, files: u?.files ?? 0 };
  });
  return json({ ok: true, channels });
}
