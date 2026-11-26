import { getDb } from "@/lib/db/store";
import { channelImageUrl, publicChannels, systemChannels } from "@/lib/chat/channels";
import { canViewChatChannel } from "@/lib/auth/permissions";
import { chatDb } from "@/lib/chat/db";
import { chatUser, json } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** チャンネルを探す: 自分が所属している全社・店舗・店長のチャンネルと公開のチャンネル。参加しているか・メンバーの数・最後の投稿 */
export async function GET() {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const db = getDb();
  const last = chatDb().prepare("select max(at) at, count(*) n from messages where channel_id = ? and deleted_at is null");
  const list = [...systemChannels(db).filter((c) => canViewChatChannel(user, c)), ...publicChannels(db)].map((c) => {
    const r = last.get(c.id);
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      topic: c.topic ?? "",
      color: c.color,
      image: channelImageUrl(c),
      visibility: c.visibility,
      memberCount: c.memberIds.length,
      joined: c.memberIds.includes(user.id),
      createdBy: c.createdBy,
      lastAt: (r?.at as string | null) ?? undefined,
      messages: Number(r?.n ?? 0),
    };
  });
  return json({ ok: true, channels: list });
}
