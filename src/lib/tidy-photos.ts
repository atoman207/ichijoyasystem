import "server-only";
import type { TidyPhoto, User } from "@/lib/db/types";
import { MAX_ATTACHMENT_BYTES, MAX_THUMB_BYTES, UserError, detectType, type IncomingFile } from "@/lib/attachments";
import { newId, nowIso } from "@/lib/db/store";
import { putObject, removeObjects } from "@/lib/storage";

/**
 * 整理整頓チェックの写真の本体 (VPS のディスク。storage.ts の tidy/<年月>/<ID>.<拡張子>)。
 * 台帳はチェックの photos (tidy_checks.photos)。表示は /api/tidy/photos/<チェックの ID>/<写真の ID> (チェックを見られる人だけ)
 */

export async function storeTidyPhoto(opts: { user: User; file: IncomingFile; thumb?: IncomingFile | null; width?: number; height?: number; takenAt?: string; caption?: string; itemKey?: string; lineRef?: string }): Promise<TidyPhoto> {
  const { file } = opts;
  const t = detectType(file.name, file.type);
  if (!t || !t.photo) throw new UserError(`「${file.name}」は写真ではありません (JPEG・PNG・WebP)。`);
  if (!file.bytes.length) throw new UserError(`「${file.name}」が空のファイルです。`);
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new UserError(`「${file.name}」は ${(file.bytes.length / 1048576).toFixed(1)} MB です。1 枚 4 MB までにしてください (画面から登録すると自動で縮小します)。`);
  const id = newId("tp");
  const month = nowIso().slice(0, 7);
  const key = `tidy/${month}/${id}.${t.ext}`;
  const useThumb = opts.thumb && opts.thumb.bytes.length > 0 && opts.thumb.bytes.length <= MAX_THUMB_BYTES;
  const thumbKey = useThumb ? `tidy/${month}/${id}_thumb.jpg` : undefined;
  await putObject(key, file.bytes);
  if (thumbKey) {
    try {
      await putObject(thumbKey, opts.thumb!.bytes);
    } catch (err) {
      await removeObjects([key]).catch(() => undefined);
      throw err;
    }
  }
  const takenAt = opts.takenAt && !Number.isNaN(Date.parse(opts.takenAt)) ? new Date(opts.takenAt).toISOString() : undefined;
  return {
    id,
    key,
    thumbKey,
    fileName: file.name.slice(0, 200),
    contentType: t.contentType,
    size: file.bytes.length,
    width: opts.width && opts.width > 0 ? Math.round(opts.width) : undefined,
    height: opts.height && opts.height > 0 ? Math.round(opts.height) : undefined,
    takenAt,
    caption: opts.caption?.trim().slice(0, 200) || undefined,
    itemKey: opts.itemKey || undefined,
    lineRef: opts.lineRef,
    uploadedBy: opts.user.id,
    uploadedAt: nowIso(),
  };
}

export async function discardTidyPhotos(list: Pick<TidyPhoto, "key" | "thumbKey">[]): Promise<void> {
  await removeObjects(list.flatMap((p) => [p.key, p.thumbKey ?? ""])).catch((err) => console.warn("[tidy] cleanup failed:", (err as Error).message));
}

export const tidyPhotoUrl = (checkId: string, photoId: string, thumb = false) => `/api/tidy/photos/${encodeURIComponent(checkId)}/${encodeURIComponent(photoId)}${thumb ? "?size=thumb" : ""}`;
