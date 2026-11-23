"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import type { Attachment } from "@/lib/db/types";
import { discardStored, resolveParent, storeFile, UserError } from "@/lib/attachments";
import { canAccessStore, canEditCasePost, isCasePostReviewer } from "@/lib/auth/permissions";
import { CASE_POST_MAX_PHOTOS, casePostReviewerIds } from "@/lib/case-posts";
import { findLinePhoto, linePhotoBytes, linePhotoFileName } from "@/lib/line-photos";
import { markLineMessageHandled, touchLineGroups } from "@/lib/line-groups";
import { removeObjects } from "@/lib/storage";
import { postTablesMissing } from "@/lib/posts-tables";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * LINE の「施工事例写真」グループの写真を受注 (案件) の写真・資料に付ける / 写真を対象外にする (src/lib/line-photos.ts)
 * - 付けた写真は受注の添付ファイルになり (撮影日時 = LINE で受け取った日時)、施工事例の投稿で選べる。postId があればその投稿の写真にも足す
 * - 付けた・対象外にした写真は対応済み (一覧から外す)。このサーバーに置いていた写真の本体は消す (受注の側に写したため)
 */

const MAX_AT_ONCE = 20;

export async function attachLinePhotosToOrder(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/materials/cases/line");
  const refs = [...new Set(formData.getAll("refs").map(String))].slice(0, MAX_AT_ONCE);
  if (!refs.length) fail(back, "付ける写真を選んでください。");
  const db0 = getDb();
  const postId = str(formData, "postId");
  const post = postId ? (db0.casePosts ?? []).find((p) => p.id === postId) : undefined;
  if (postId && !post) fail(back, "施工事例の投稿が見つかりません。");
  const orderRef = str(formData, "orderRef").normalize("NFKC").trim();
  const order = post ? db0.orders.find((o) => o.id === post.orderId) : db0.orders.find((o) => o.number.toUpperCase() === orderRef.toUpperCase() || o.id === orderRef);
  if (!order) fail(back, orderRef ? `受注番号「${orderRef}」が見つかりません。` : "受注番号を入れてください。");
  if (!canAccessStore(user, order.storeId)) fail(back, "この案件の店舗の担当者・本部・管理者が写真を付けられます。");
  if (post) {
    if (await postTablesMissing(["case_posts"])) fail(back, "施工事例の投稿の表がまだデータベースにありません。");
    if (!canEditCasePost(user, post, casePostReviewerIds(db0))) fail(back, "この投稿は今は直せません (確認依頼中は確認する人だけ)。");
  }
  const parent = resolveParent(db0, "order", order.id)!;

  const stored: { ref: string; att: Attachment; fileKey?: string }[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const found = findLinePhoto(db0, user, ref, "photos");
    if (!found.photo) {
      errors.push(found.error!);
      continue;
    }
    const m = found.photo.message;
    const got = await linePhotoBytes(m);
    if ("error" in got) {
      errors.push(got.error);
      continue;
    }
    try {
      const att = await storeFile({ user, parent, file: { name: linePhotoFileName(m), type: got.contentType, bytes: got.bytes }, takenAt: m.at, caption: `LINE「${found.photo.groupName}」の施工事例写真`.slice(0, 200) });
      stored.push({ ref, att, fileKey: m.fileKey });
    } catch (err) {
      errors.push(err instanceof UserError ? err.message : "写真の保存に失敗しました。");
    }
  }
  if (!stored.length) fail(back, errors[0] ?? "写真を付けられませんでした。");
  try {
    await mutate((db) => {
      for (const s of stored) {
        db.attachments.push(s.att);
        markLineMessageHandled(db, s.ref, user.id, `order:${order.id}`);
      }
      const p = post ? db.casePosts.find((x) => x.id === post.id) : undefined;
      let added = 0;
      if (p) {
        const before = p.photoIds.length;
        p.photoIds = [...new Set([...p.photoIds, ...stored.map((s) => s.att.id)])].slice(0, CASE_POST_MAX_PHOTOS);
        added = p.photoIds.length - before;
        // 承認のあとに確認する人以外が写真を足したら、承認はやり直し (承認した内容だけを投稿する)
        const reset = added > 0 && p.status === "approved" && !isCasePostReviewer(user, casePostReviewerIds(db));
        if (reset) Object.assign(p, { status: "draft", approvedBy: undefined, approvedAt: undefined });
        p.events.push({ at: new Date().toISOString(), by: user.id, action: "photos", comment: `LINE の写真 ${added} 枚`, ...(reset ? { from: "approved" as const, to: "draft" as const } : {}) });
        p.updatedBy = user.id;
        p.updatedAt = new Date().toISOString();
      }
      touchLineGroups(db, user.id);
      addAudit(db, {
        userId: user.id,
        action: "create",
        entity: "order",
        entityId: order.id,
        entityLabel: parent.label,
        summary: `LINE の施工事例写真 ${stored.length} 枚を案件の写真に追加${p ? ` (施工事例の投稿 ${p.number} にも ${added} 枚)` : ""}`,
        storeId: order.storeId,
      });
    });
  } catch (err) {
    for (const s of stored) await discardStored(s.att);
    throw err;
  }
  await removeObjects(stored.map((s) => s.fileKey ?? "")).catch(() => undefined);
  revalidatePath(`/orders/${order.id}`);
  revalidatePath("/materials");
  if (post) revalidatePath(`/materials/cases/${post.id}`);
  redirect(withMsg(back, `LINE の写真 ${stored.length} 枚を受注 ${order.number} の写真に付けました${post ? " (投稿の写真にも追加)" : ""}。${errors.length ? ` 付けられなかった写真: ${errors.length} 枚 (${errors[0]})` : ""}`));
}

/** LINE の写真を対象外にする (施工事例写真・整理整頓の確認のグループ。一覧から外す) */
export async function dismissLinePhotos(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/materials/cases/line");
  const refs = [...new Set(formData.getAll("refs").map(String))].slice(0, 100);
  if (!refs.length) fail(back, "対象外にする写真を選んでください。");
  const db0 = getDb();
  const ok = refs.filter((ref) => findLinePhoto(db0, user, ref).photo);
  if (!ok.length) fail(back, findLinePhoto(db0, user, refs[0]).error ?? "写真が見つかりません。");
  const keys: string[] = [];
  await mutate((db) => {
    for (const ref of ok) {
      const f = findLinePhoto(db, user, ref);
      if (f.photo?.message.fileKey) keys.push(f.photo.message.fileKey);
      if (f.photo) {
        delete f.photo.message.fileKey;
        markLineMessageHandled(db, ref, user.id, "dismissed");
      }
    }
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: "line_groups", entityLabel: "LINE グループの写真", summary: `LINE の写真 ${ok.length} 枚を対象外にした${str(formData, "reason") ? ` (${str(formData, "reason").slice(0, 60)})` : ""}`, storeId: user.storeId, changes: [{ field: "linePhotos", before: `${ok.length} 枚 (未対応)`, after: "対象外" }] });
  });
  await removeObjects(keys).catch(() => undefined);
  revalidatePath("/materials");
  revalidatePath("/kpi/tidy");
  redirect(withMsg(back, `LINE の写真 ${ok.length} 枚を対象外にしました。`));
}
