import { getDb, newId, nowIso } from "@/lib/db/store";
import { isChatLead } from "@/lib/auth/permissions";
import { detectType } from "@/lib/attachments";
import { putObject, removeObjects } from "@/lib/storage";
import { canView, findChannel } from "@/lib/chat/channels";
import { dropUploads, saveUpload, staleUploads, type StoredFile } from "@/lib/chat/repo";
import { chatUser, json, jsonError, sameOrigin } from "@/lib/chat/api";
import { CHAT_MAX_FILE_BYTES, type ChatFile, type ChatFileAccess } from "@/lib/chat/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 添付ファイル (src/lib/attachments.ts) と同じ種類 + 動画・zip */
const EXTRA: Record<string, { type: string; video?: boolean }> = {
  mp4: { type: "video/mp4", video: true },
  m4v: { type: "video/mp4", video: true },
  mov: { type: "video/quicktime", video: true },
  webm: { type: "video/webm", video: true },
  zip: { type: "application/zip" },
};
const MAX_THUMB = 512 * 1024;

const g = globalThis as typeof globalThis & { __ichijoyaChatPurgeAt?: number };

/** 送らなかった資料 (2 日より前) を片付ける (1 時間に 1 回まで) */
async function purge() {
  if (Date.now() - (g.__ichijoyaChatPurgeAt ?? 0) < 3600_000) return;
  g.__ichijoyaChatPurgeAt = Date.now();
  const old = staleUploads(new Date(Date.now() - 2 * 86400_000).toISOString());
  if (!old.ids.length) return;
  await removeObjects(old.keys).catch(() => undefined);
  dropUploads(old.ids);
}

/**
 * チャットの資料・写真を預かる (送る前。1 回の送信で 1 ファイル、9 MB まで。写真は画面で縮小してから送る)
 * multipart/form-data: channelId, file, thumb (縮小画像・任意), width, height, access (members / managers)
 * 返した id を、メッセージを送るときに uploadIds で渡す
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "この操作は受け付けられません。");
  const user = await chatUser();
  if (user instanceof Response) return user;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "ファイルを受け取れませんでした。ファイルが大きすぎる可能性があります (1 ファイル 9 MB まで)。");
  }
  const ch = findChannel(getDb(), String(form.get("channelId") ?? ""));
  if (!canView(user, ch)) return jsonError(403, "このチャンネルに送る権限がありません。");
  if (ch.archivedAt) return jsonError(400, "アーカイブしたチャンネルには送れません。");
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return jsonError(400, "ファイルを選んでください。");
  if (f.size > CHAT_MAX_FILE_BYTES) return jsonError(400, `「${f.name}」は ${(f.size / 1048576).toFixed(1)} MB です。1 ファイル 9 MB までにしてください (写真は自動で縮小します)。`);
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  const base = detectType(f.name, f.type);
  const extra = !base ? (EXTRA[ext] ?? Object.entries(EXTRA).map(([, v]) => v).find((v) => v.type === f.type)) : undefined;
  if (!base && !extra) return jsonError(400, `「${f.name}」は送れない種類のファイルです (写真・PDF・Excel・Word・PowerPoint・CSV・テキスト・動画 (MP4・MOV)・ZIP)。`);
  const access: ChatFileAccess = form.get("access") === "managers" ? "managers" : "members";
  if (access === "managers" && !isChatLead(user)) return jsonError(403, "「店長以上だけ」にできるのは管理者・本部・店長です。");
  const id = newId("cf");
  const month = nowIso().slice(0, 7);
  const fileExt = base?.ext ?? (EXTRA[ext] ? ext : "bin");
  const key = `chat/${month}/${id}.${fileExt}`;
  const t = form.get("thumb");
  const thumb = base?.photo && t instanceof File && t.size > 0 && t.size <= MAX_THUMB ? Buffer.from(await t.arrayBuffer()) : undefined;
  const thumbKey = thumb ? `chat/${month}/${id}_thumb.jpg` : undefined;
  try {
    await putObject(key, Buffer.from(await f.arrayBuffer()));
    if (thumb && thumbKey) await putObject(thumbKey, thumb);
  } catch (err) {
    console.error("[chat] upload store failed:", err);
    await removeObjects([key, thumbKey ?? ""].filter(Boolean)).catch(() => undefined);
    return jsonError(500, "ファイルを保存できませんでした。時間をおいてもう一度お試しください。");
  }
  const w = Number(form.get("width"));
  const h = Number(form.get("height"));
  const stored: StoredFile = {
    id,
    name: f.name.slice(0, 200) || `file.${fileExt}`,
    type: base?.contentType ?? extra!.type,
    size: f.size,
    photo: Boolean(base?.photo),
    video: Boolean(extra?.video) || undefined,
    width: w > 0 ? Math.round(w) : undefined,
    height: h > 0 ? Math.round(h) : undefined,
    access,
    key,
    thumbKey,
    uploadedBy: user.id,
  };
  saveUpload({ id, userId: user.id, channelId: ch.id, file: stored, at: nowIso() });
  void purge();
  const file: ChatFile = { id, name: stored.name, type: stored.type, size: stored.size, photo: stored.photo, video: stored.video, width: stored.width, height: stored.height, thumb: Boolean(thumbKey), access };
  return json({ ok: true, id, file });
}
