import { Camera } from "lucide-react";
import type { AttachmentParent, Database, User } from "@/lib/db/types";
import { ATTACHMENT_ACCEPT, attachmentsOf, canAddToParent, canViewAttachment, resolveParent, toView } from "@/lib/attachments";
import { deleteAttachment } from "@/lib/actions/attachments";
import { Card, CardHeader } from "@/components/ui";
import { AttachmentGallery } from "./AttachmentGallery";
import { AttachmentUploader } from "./AttachmentUploader";

/**
 * 資料・写真のカード
 * - parent: その記録の添付を表示し、権限があれば登録できる
 * - customerId を渡すと、その顧客に関係する添付 (問い合わせ・見積・受注などに登録したもの) もまとめて表示する (顧客 360)
 */
export function AttachmentsCard({
  db,
  user,
  parent,
  customerId,
  returnTo,
  title = "資料・写真",
  description,
}: {
  db: Database;
  user: User;
  parent: { type: AttachmentParent; id: string };
  customerId?: string;
  returnTo: string;
  title?: string;
  description?: string;
}) {
  const p = resolveParent(db, parent.type, parent.id);
  if (!p) return null;
  const rows = customerId
    ? db.attachments.filter((a) => a.customerId === customerId || (a.parentType === parent.type && a.parentId === parent.id)).sort((a, b) => (b.takenAt ?? b.uploadedAt).localeCompare(a.takenAt ?? a.uploadedAt))
    : attachmentsOf(db, parent.type, parent.id);
  const items = rows.filter((a) => canViewAttachment(user, db, a)).map((a) => toView(db, user, a));
  const canAdd = canAddToParent(user, db, p);
  const photos = items.filter((i) => i.kind === "photo").length;
  return (
    <Card>
      <CardHeader
        title={title}
        icon={<Camera />}
        description={description ?? (customerId ? "この顧客と、問い合わせ・見積・受注に登録した写真・資料をまとめて表示します" : "スマートフォン・タブレットのカメラで撮った写真や、PDF などの資料を登録できます")}
        action={items.length > 0 ? <span className="text-xs text-ink-3">写真 {photos} 枚 · 資料 {items.length - photos} 件</span> : undefined}
      />
      <div className="space-y-4">
        {canAdd && <AttachmentUploader parentType={p.type} parentId={p.id} accept={ATTACHMENT_ACCEPT} />}
        {items.length > 0 ? (
          <AttachmentGallery items={items} deleteAction={deleteAttachment} returnTo={returnTo} showParent={Boolean(customerId)} />
        ) : (
          <p className="text-xs text-ink-3">まだ登録されていません。</p>
        )}
      </div>
    </Card>
  );
}
