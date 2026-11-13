"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate } from "@/lib/db/store";
import { canDeleteAttachment } from "@/lib/auth/permissions";
import { canViewAttachment, discardStored, resolveParent, PARENT_LABEL } from "@/lib/attachments";
import type { Attachment } from "@/lib/db/types";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/** 添付ファイルの削除 (登録した本人・管理者・その店舗の店長)。変更履歴に残す */
export async function deleteAttachment(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/");
  let removed: Attachment | undefined;
  let href = back;
  await mutate((db) => {
    const a = db.attachments.find((x) => x.id === id);
    if (!a) fail(back, "ファイルが見つかりません (すでに削除されています)。");
    const p = resolveParent(db, a.parentType, a.parentId);
    if (!canViewAttachment(user, db, a) || !canDeleteAttachment(user, { uploadedBy: a.uploadedBy, storeId: p?.storeId ?? a.storeId })) fail(back, "このファイルを削除できるのは、登録した本人・その店舗の店長・管理者です。");
    db.attachments = db.attachments.filter((x) => x.id !== id);
    removed = a;
    href = p?.href ?? back;
    addAudit(db, {
      userId: user.id,
      action: "delete",
      entity: p?.entity ?? a.parentType,
      entityId: a.parentId,
      entityLabel: p?.label ?? PARENT_LABEL[a.parentType],
      summary: `${a.kind === "photo" ? "写真" : "資料"}を削除 (${a.fileName})`,
      storeId: a.storeId,
      changes: [{ field: "attachment", before: a.fileName, after: null }],
    });
  });
  if (removed) await discardStored(removed);
  revalidatePath(href.split("?")[0]);
  if (removed?.customerId) revalidatePath(`/customers/${removed.customerId}`);
  redirect(withMsg(back, `「${removed?.fileName}」を削除しました。`));
}
