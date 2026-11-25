import { getDb } from "@/lib/db/store";
import { canView, findChannel } from "@/lib/chat/channels";
import { channelFiles } from "@/lib/chat/repo";
import { canViewChatFile } from "@/lib/auth/permissions";
import { chatUser, json, jsonError } from "@/lib/chat/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** チャンネルの資料・写真の一覧: ?c=<チャンネル> (見られるものだけ。新しい順) */
export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const db = getDb();
  const ch = findChannel(db, new URL(req.url).searchParams.get("c") ?? "");
  if (!canView(user, ch)) return jsonError(404, "チャンネルが見つからないか、見る権限がありません。");
  const files = channelFiles(ch.id)
    .filter((x) => canViewChatFile(user, x.file.access))
    .map(({ message, file }) => ({ messageId: message.id, parentId: message.parentId, userId: message.userId, at: message.at, file: { id: file.id, name: file.name, type: file.type, size: file.size, photo: file.photo, video: file.video, width: file.width, height: file.height, thumb: Boolean(file.thumbKey), access: file.access } }));
  return json({ ok: true, files });
}
