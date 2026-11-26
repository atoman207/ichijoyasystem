import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getDb, nowIso } from "@/lib/db/store";
import { canAdministerChatChannels } from "@/lib/auth/permissions";
import { putObject, readObject, removeObjects } from "@/lib/storage";
import { canEditImage, canView, findChannel, type ChannelDef } from "@/lib/chat/channels";
import { setChannelImage } from "@/lib/chat/repo";
import { chatUser, json, jsonError, sameOrigin } from "@/lib/chat/api";
import { CHAT_CHANNEL_IMAGE_BYTES } from "@/lib/chat/types";
import type { User } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * チャンネルの画像 (お客様のご要望 2026-11-26: チャンネルの作成時に画像・店舗のチャンネルはその店舗の画像・店長のチャンネルは本部の画像)
 * GET    ?c=<チャンネル>  … 画像 (見られるチャンネルと、管理者はチャンネルの管理の一覧のために全部。店長のチャンネルに画像がなければ本部の画像)
 * POST   multipart: channelId, file (PNG・JPEG・WebP・GIF。画面で 512 px に縮小してから送る。2 MB まで) … 入れ替える
 * DELETE ?c=<チャンネル>  … 外す (アイコンに戻す)
 * 変えられる人は permissions.ts の canEditChatChannelImage (管理者・作成した人・店舗の店長・本部の店長)。本体は storage.ts の chat/channel-images/
 */

const TYPES: { type: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { type: "image/png", ext: "png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/jpeg", ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", ext: "webp", test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { type: "image/gif", ext: "gif", test: (b) => b.length > 6 && b.toString("ascii", 0, 4) === "GIF8" },
];

function canSeeImage(user: User, ch: ChannelDef | undefined): ch is ChannelDef {
  if (!ch || ch.kind === "dm") return false;
  return canView(user, ch) || canAdministerChatChannels(user);
}

export async function GET(req: Request) {
  const user = await chatUser();
  if (user instanceof Response) return user;
  const ch = findChannel(getDb(), new URL(req.url).searchParams.get("c") ?? "");
  if (!canSeeImage(user, ch)) return new NextResponse("画像を見る権限がありません。", { status: 403 });
  if (!ch.image) return new NextResponse("画像がありません。", { status: 404 });
  const body = await readObject(ch.image.key);
  if (!body) return new NextResponse("画像の本体が見つかりません。", { status: 404 });
  // URL に画像の印 (v=) が入るので、同じ URL は同じ画像 (長めに控えてよい)
  return new NextResponse(new Uint8Array(body), {
    headers: { "Content-Type": ch.image.type, "Content-Length": String(body.length), "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "この操作は受け付けられません。");
  const user = await chatUser();
  if (user instanceof Response) return user;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "画像を受け取れませんでした。画像が大きすぎる可能性があります。");
  }
  const ch = findChannel(getDb(), String(form.get("channelId") ?? ""));
  if (!ch || !canEditImage(user, ch)) return jsonError(403, "このチャンネルの画像を変える権限がありません。");
  if (ch.archivedAt) return jsonError(400, "アーカイブしたチャンネルです。");
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return jsonError(400, "画像を選んでください。");
  if (f.size > CHAT_CHANNEL_IMAGE_BYTES) return jsonError(400, "画像が大きすぎます (2 MB まで)。");
  const body = Buffer.from(await f.arrayBuffer());
  const kind = TYPES.find((t) => t.test(body));
  if (!kind) return jsonError(400, "画像 (PNG・JPEG・WebP・GIF) を選んでください。");
  const safe = ch.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const key = `chat/channel-images/${safe}-${Date.now().toString(36)}${randomBytes(4).toString("hex")}.${kind.ext}`;
  try {
    await putObject(key, body);
  } catch (err) {
    console.error("[chat] channel image store failed:", err);
    return jsonError(500, "画像を保存できませんでした。時間をおいてもう一度お試しください。");
  }
  const prev = setChannelImage(ch.id, { key, type: kind.type }, user.id, nowIso());
  if (prev) await removeObjects([prev]).catch(() => undefined);
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, "この操作は受け付けられません。");
  const user = await chatUser();
  if (user instanceof Response) return user;
  const ch = findChannel(getDb(), new URL(req.url).searchParams.get("c") ?? "");
  if (!ch || !canEditImage(user, ch)) return jsonError(403, "このチャンネルの画像を変える権限がありません。");
  const prev = setChannelImage(ch.id, undefined, user.id, nowIso());
  if (prev) await removeObjects([prev]).catch(() => undefined);
  return json({ ok: true });
}
