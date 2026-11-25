import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canViewChatFile } from "@/lib/auth/permissions";
import { readObject } from "@/lib/storage";
import { canView, findChannel } from "@/lib/chat/channels";
import { getMessage } from "@/lib/chat/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * チャットの資料・写真: /api/chat/files/<メッセージ>/<ファイル>?size=thumb (縮小画像) &download=1 (保存)
 * チャンネル・DM を見られる人だけ (公開範囲が「店長以上だけ」の資料は店長以上)。動画は部分の読み込み (Range) に答える (iPhone の再生)
 */
export async function GET(req: Request, { params }: { params: Promise<{ messageId: string; fileId: string }> }) {
  const { messageId, fileId } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const m = getMessage(messageId);
  const f = m && !m.deletedAt ? m.files.find((x) => x.id === fileId) : undefined;
  if (!m || !f) return new NextResponse("ファイルが見つかりません。", { status: 404 });
  if (!canView(user, findChannel(db, m.channelId)) || !canViewChatFile(user, f.access)) return new NextResponse("このファイルを開く権限がありません。", { status: 403 });
  const url = new URL(req.url);
  const thumb = url.searchParams.get("size") === "thumb" && f.thumbKey;
  const download = url.searchParams.get("download") === "1";
  const body = await readObject(thumb ? f.thumbKey! : f.key);
  if (!body) return new NextResponse("ファイルの本体が見つかりません。", { status: 404 });
  const type = thumb ? "image/jpeg" : f.type === "image/svg+xml" ? "application/octet-stream" : f.type;
  const inline = !download && (type.startsWith("image/") || type.startsWith("video/") || type === "application/pdf");
  const headers: Record<string, string> = {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && !thumb) {
    const size = body.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2] || 0);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (!range[1]) end = size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const part = body.subarray(start, end + 1);
    return new NextResponse(new Uint8Array(part), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(part.length) } });
  }
  return new NextResponse(new Uint8Array(body), { headers: { ...headers, "Content-Length": String(body.length) } });
}
