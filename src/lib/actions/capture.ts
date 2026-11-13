"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { discardStored, storeFile } from "@/lib/attachments";
import type { Attachment, DocumentKind } from "@/lib/db/types";
import { extractDocument } from "@/lib/ai/ocr";
import { DOCUMENT_KIND_LABEL } from "@/lib/constants";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

// 写真は画面側で縮小してから送る。PDF などは 4 MB まで (Vercel の 1 回の送信の上限 4.5 MB)
const MAX_BYTES = 4 * 1024 * 1024;

export async function uploadDocument(formData: FormData) {
  const user = await requireActionUser();
  const back = "/capture";
  const kind = choice(formData, "kind", DOCUMENT_KIND_LABEL, "other");
  if (!DOCUMENT_KIND_LABEL[kind]) fail(back, "書類の種類が不正です。");
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  assertStore(user, storeId, back);
  const file = formData.get("file");
  const sampleName = str(formData, "sampleName");
  let fileName = sampleName || "sample.jpg";
  let mimeType = "image/jpeg";
  let base64: string | undefined;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) fail(back, "ファイルサイズは 4MB 以下にしてください (写真は自動で縮小されます)。");
    fileName = file.name;
    mimeType = file.type || "application/octet-stream";
    base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  }
  const db = getDb();
  const result = await extractDocument({ kind, fileName, mimeType, base64, products: db.products, storeId });
  const id = newId("doc");
  // 元の画像・PDF を保存する (登録した見積・経費・仕入請求書の画面で表示する)。保存できなくても読取結果は登録する
  let original: Attachment | undefined;
  const noTable = BACKEND === "supabase" && missingTables().includes("attachments") && (await recheckMissingTables()).includes("attachments");
  if (base64 && !noTable) {
    try {
      const thumb = formData.get("thumb");
      original = await storeFile({
        user,
        parent: { type: "document", id, storeId, label: `取込書類 ${fileName}`, href: `/capture?doc=${id}`, entity: "document" },
        file: { name: fileName, type: mimeType, bytes: Buffer.from(base64, "base64") },
        thumb: thumb instanceof File && thumb.size > 0 ? { name: "thumb.jpg", type: "image/jpeg", bytes: Buffer.from(await thumb.arrayBuffer()) } : undefined,
        takenAt: str(formData, "takenAt") || undefined,
      });
    } catch (err) {
      console.warn("[capture] original not stored:", (err as Error).message);
      original = undefined;
    }
  }
  await mutate((d) => {
    if (original) d.attachments.push(original!);
    d.documents.push({ id, kind, fileName, uploadedBy: user.id, storeId, uploadedAt: nowIso(), status: "extracted", extracted: { ...result.extracted, _provider: result.provider, _warnings: result.warnings }, confidence: result.confidence });
    addAudit(d, { userId: user.id, action: "create", entity: "document", entityId: id, entityLabel: fileName, summary: `書類を取込・AI読取 (${DOCUMENT_KIND_LABEL[kind]} / ${result.provider === "claude" ? "Claude" : "サンプル"})`, storeId });
  }).catch(async (err) => {
    if (original) await discardStored(original);
    throw err;
  });
  revalidatePath(back);
  redirect(withMsg(`${back}?doc=${id}`, `読み取りが完了しました (確度 ${Math.round(result.confidence * 100)}%)。内容を確認して登録してください。`));
}

export async function discardDocument(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const doc = db.documents.find((d) => d.id === id);
    if (!doc) fail("/capture", "書類が見つかりません。");
    assertStore(user, doc.storeId, "/capture");
    if (doc.status === "confirmed") fail(`/capture?doc=${id}`, "登録済みの書類は破棄できません。");
    doc.status = "discarded";
    addAudit(db, { userId: user.id, action: "status", entity: "document", entityId: id, entityLabel: doc.fileName, summary: "取込書類を破棄", storeId: doc.storeId });
  });
  revalidatePath("/capture");
  redirect(withMsg("/capture", "書類を破棄しました。"));
}

/** 図面など、データ化のみ行い案件メモとして保存 */
export async function confirmDocument(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const doc = db.documents.find((d) => d.id === id);
    if (!doc) fail("/capture", "書類が見つかりません。");
    assertStore(user, doc.storeId, "/capture");
    if (doc.status === "discarded") fail("/capture", "破棄した書類は確定できません。もう一度取り込んでください。");
    doc.status = "confirmed";
    addAudit(db, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: "取込書類の読取内容を確定", storeId: doc.storeId });
  });
  revalidatePath("/capture");
  redirect(withMsg(`/capture?doc=${id}`, "読取内容を確定しました。"));
}
