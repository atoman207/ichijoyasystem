import "server-only";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canUseLineGroupPhotos } from "@/lib/auth/permissions";
import { lineGroupName, lineGroups, lineMessageRef, parseLineMessageRef, type LineGroup, type LineGroupPurpose, type PendingLineMessage } from "@/lib/line-groups";
import { readObject } from "@/lib/storage";
import { downloadLineContent } from "@/lib/notify/line-api";

/**
 * LINE の「施工事例写真」「整理整頓の確認」グループに届いた写真 (案件・整理整頓チェックに付ける前の置き場所)
 * ------------------------------------------------------------
 * - 受信のあと、写真の本体をこのサーバーに保存する (src/lib/notify/line-api.ts の saveHeldLinePhotos。キー line/<年月>/<メッセージ ID>.jpg)。
 *   保存できなかった写真は、付けるときに LINE からもう一度取得する (LINE のサーバーに残っている間だけ)
 * - 施工事例写真 → 受注 (案件) の写真・資料に写し、施工事例の投稿に使う (src/lib/actions/line-photos.ts)
 * - 整理整頓の確認 → 整理整頓チェックの写真に写す (src/lib/actions/tidy.ts)
 * - 付けた・対象外にした写真は「対応済み」(handledAt) にして一覧から外す (グループのメッセージは 300 件まで残る)
 * - 見る・付ける: グループの店舗のメンバー (店舗のないグループは全社員)。permissions.ts の canUseLineGroupPhotos
 */

export interface HeldLinePhoto {
  ref: string;
  group: LineGroup;
  message: PendingLineMessage;
  groupName: string;
  storeId?: StoreId;
  /** このサーバーに本体がある */
  held: boolean;
}

/** まだ付けていない写真 (新しい順)。storeId を渡すとその店舗のグループと店舗のないグループだけ */
export function pendingLinePhotos(db: Pick<Database, "settings">, user: User, purpose: Extract<LineGroupPurpose, "photos" | "tidy">, storeId?: StoreId): HeldLinePhoto[] {
  return lineGroups(db)
    .filter((g) => g.purpose === purpose && canUseLineGroupPhotos(user, g.storeId) && (!storeId || !g.storeId || g.storeId === storeId))
    .flatMap((g) => g.pending.filter((m) => m.type === "image" && !m.handledAt).map((message) => ({ ref: lineMessageRef(g.id, message.id), group: g, message, groupName: lineGroupName(g), storeId: g.storeId, held: Boolean(message.fileKey) })))
    .sort((a, b) => b.message.at.localeCompare(a.message.at));
}

/** 「グループ ID:メッセージ ID」から写真を探す (権限・種類・対応済みも確かめる) */
export function findLinePhoto(db: Pick<Database, "settings">, user: User, ref: string, purpose?: Extract<LineGroupPurpose, "photos" | "tidy">): { photo?: HeldLinePhoto; error?: string } {
  const p = parseLineMessageRef(ref);
  if (!p) return { error: "LINE の写真の指定が正しくありません。" };
  const g = lineGroups(db).find((x) => x.id === p.groupId);
  const m = g?.pending.find((x) => x.id === p.messageId);
  if (!g || !m || m.type !== "image") return { error: "LINE の写真が見つかりません (300 件を超えて消えた可能性があります)。" };
  if (purpose && g.purpose !== purpose) return { error: "この用途のグループの写真ではありません。" };
  if (!canUseLineGroupPhotos(user, g.storeId)) return { error: "このグループの写真を使う権限がありません。" };
  if (m.handledAt) return { error: "この写真はすでに付けたか、対象外にしています。" };
  return { photo: { ref, group: g, message: m, groupName: lineGroupName(g), storeId: g.storeId, held: Boolean(m.fileKey) } };
}

/** 写真の本体 (このサーバーに保存したもの、なければ LINE から取得) */
export async function linePhotoBytes(m: PendingLineMessage): Promise<{ bytes: Buffer; contentType: string } | { error: string }> {
  if (m.fileKey) {
    const b = await readObject(m.fileKey);
    if (b) return { bytes: b, contentType: m.contentType || "image/jpeg" };
  }
  const got = await downloadLineContent(m.id);
  if ("error" in got) return { error: `LINE から写真を取得できませんでした (${got.error})。LINE のアプリで写真を保存して、画面から登録してください。` };
  return { bytes: got.bytes, contentType: got.contentType || "image/jpeg" };
}

/** 写真のファイル名 (LINE_<日時>_<メッセージ ID>.jpg) */
export function linePhotoFileName(m: PendingLineMessage): string {
  const stamp = m.at.slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
  const ext = /png/.test(m.contentType ?? "") ? "png" : "jpg";
  return `LINE_${stamp}_${m.id}.${ext}`;
}
