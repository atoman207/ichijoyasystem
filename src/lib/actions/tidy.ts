"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, StoreId, TidyCheck, TidyPhoto, User } from "@/lib/db/types";
import { canDeleteTidyCheck, canEditTidyCheck, canManageTidyItems, canRecordTidyCheck, canViewTidyCheck } from "@/lib/auth/permissions";
import { TIDY_ITEMS_SETTING_ID, TIDY_MAX_PHOTOS, buildTidyItems, nextTidyNumber, parseTidyItemsText, tidyChanges, tidyScore, tidySettings, type TidyInputItem } from "@/lib/tidy";
import { discardTidyPhotos, storeTidyPhoto } from "@/lib/tidy-photos";
import { findLinePhoto, linePhotoBytes, linePhotoFileName } from "@/lib/line-photos";
import { markLineMessageHandled, touchLineGroups } from "@/lib/line-groups";
import { UserError } from "@/lib/attachments";
import { removeObjects } from "@/lib/storage";
import { postTablesMissing } from "@/lib/posts-tables";
import { toDateKey } from "@/lib/format";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 整理整頓チェック (KPI → 整理整頓。src/lib/tidy.ts)
 * 記録 (店舗・日・項目ごとの 良い / 要改善 / 対象外・写真) → 要改善の対応 (期限・直した) / チェック項目の差し替え (管理者)
 */

const LIST = "/kpi/tidy";
const page = (id: string) => `${LIST}/${id}`;

async function assertTable(back: string) {
  const missing = await postTablesMissing(["tidy_checks"]);
  if (missing) fail(back, missing);
}

function findCheck(db: Database, user: User, id: string): TidyCheck {
  const c = (db.tidyChecks ?? []).find((x) => x.id === id);
  if (!c) fail(LIST, "整理整頓チェックが見つかりません。");
  if (!canViewTidyCheck(user, c)) fail(LIST, "このチェックを見る権限がありません。");
  return c;
}

const refresh = (id?: string) => {
  revalidatePath(LIST);
  if (id) revalidatePath(page(id));
};

/** 画面の入力 (項目ごとの r_<キー>・n_<キー>・d_<キー>) */
function readItems(formData: FormData, keys: string[]): TidyInputItem[] {
  return keys.map((key) => ({ key, result: str(formData, `r_${key}`), note: str(formData, `n_${key}`), dueDate: str(formData, `d_${key}`) }));
}

function readHeader(db: Database, user: User, formData: FormData, back: string, fallback?: TidyCheck) {
  const storeId = str(formData, "storeId") || fallback?.storeId || user.storeId;
  if (!db.stores.some((s) => s.id === storeId)) fail(back, "店舗を選んでください。");
  if (!canRecordTidyCheck(user, storeId as StoreId)) fail(back, "この店舗のチェックを記録する権限がありません (所属店舗のメンバー・本部・管理者)。");
  const date = str(formData, "date") || toDateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "チェックした日を入れてください。");
  if (date > toDateKey(new Date())) fail(back, "チェックした日に未来の日付は入れられません。");
  const checkedBy = str(formData, "checkedBy") || fallback?.checkedBy || user.id;
  if (!db.users.some((u) => u.id === checkedBy)) fail(back, "チェックした人を選んでください。");
  return { storeId: storeId as StoreId, date, checkedBy, place: str(formData, "place").slice(0, 60) || undefined, comment: str(formData, "comment").slice(0, 2000) || undefined };
}

/** LINE の「整理整頓の確認」グループの写真をチェックの写真として写す (保存した写真と、付けられなかった理由) */
async function copyLinePhotos(user: User, refs: string[], room: number): Promise<{ photos: { photo: TidyPhoto; ref: string; fileKey?: string }[]; errors: string[] }> {
  const db0 = getDb();
  const out: { photo: TidyPhoto; ref: string; fileKey?: string }[] = [];
  const errors: string[] = [];
  for (const ref of refs.slice(0, Math.max(0, room))) {
    const f = findLinePhoto(db0, user, ref, "tidy");
    if (!f.photo) {
      errors.push(f.error!);
      continue;
    }
    const got = await linePhotoBytes(f.photo.message);
    if ("error" in got) {
      errors.push(got.error);
      continue;
    }
    try {
      const photo = await storeTidyPhoto({ user, file: { name: linePhotoFileName(f.photo.message), type: got.contentType, bytes: got.bytes }, takenAt: f.photo.message.at, caption: `LINE「${f.photo.groupName}」`, lineRef: ref });
      out.push({ photo, ref, fileKey: f.photo.message.fileKey });
    } catch (err) {
      errors.push(err instanceof UserError ? err.message : "写真の保存に失敗しました。");
    }
  }
  return { photos: out, errors };
}

/* ================================================================== */
/* 記録・修正・削除                                                        */
/* ================================================================== */

export async function createTidyCheck(formData: FormData) {
  const user = await requireActionUser();
  const back = "/kpi/tidy/new";
  await assertTable(back);
  const db0 = getDb();
  const head = readHeader(db0, user, formData, back);
  const settings = tidySettings(db0);
  const items = buildTidyItems(settings.items, readItems(formData, settings.items.map((i) => i.key)));
  if (!items.some((i) => i.result !== "na")) fail(back, "項目ごとに「良い」「要改善」を選んでください (すべて対象外になっています)。");
  const refs = [...new Set(formData.getAll("lineRefs").map(String))];
  const copied = await copyLinePhotos(user, refs, TIDY_MAX_PHOTOS);
  let id = "";
  try {
    id = await mutate((db) => {
      const now = nowIso();
      const c: TidyCheck = {
        id: newId("tc"),
        number: nextTidyNumber(db.tidyChecks, head.date),
        ...head,
        items,
        ...tidyScore(items),
        photos: copied.photos.map((p) => p.photo),
        provisional: settings.provisional || undefined,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      };
      db.tidyChecks.push(c);
      for (const p of copied.photos) markLineMessageHandled(db, p.ref, user.id, `tidy:${c.id}`);
      if (copied.photos.length) touchLineGroups(db, user.id);
      const store = db.stores.find((s) => s.id === c.storeId)?.name ?? c.storeId;
      addAudit(db, { userId: user.id, action: "create", entity: "tidy_check", entityId: c.id, entityLabel: `${c.number} ${store} ${c.date}`, summary: `整理整頓チェックを記録 (${store} ${c.date} · ${c.score === undefined ? "点数なし" : `${c.score} 点`} · 要改善 ${c.ngCount} 件${c.photos.length ? ` · 写真 ${c.photos.length} 枚` : ""})`, storeId: c.storeId });
      return c.id;
    });
  } catch (err) {
    await discardTidyPhotos(copied.photos.map((p) => p.photo));
    throw err;
  }
  await removeObjects(copied.photos.map((p) => p.fileKey ?? "")).catch(() => undefined);
  refresh(id);
  revalidatePath("/materials");
  redirect(withMsg(page(id), `記録しました。${copied.errors.length ? `LINE の写真 ${copied.errors.length} 枚は付けられませんでした (${copied.errors[0]})。` : ""}写真はこの画面の「写真」から追加できます。`));
}

export async function updateTidyCheck(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `${page(id)}?edit=1`;
  await assertTable(back);
  const db0 = getDb();
  const c0 = findCheck(db0, user, id);
  if (!canEditTidyCheck(user, c0)) fail(page(id), "このチェックを直す権限がありません。");
  const head = readHeader(db0, user, formData, back, c0);
  const settings = tidySettings(db0);
  const keys = [...new Set([...settings.items.map((i) => i.key), ...c0.items.map((i) => i.key)])];
  const r = await mutate((db) => {
    const c = findCheck(db, user, id);
    const items = buildTidyItems(settings.items, readItems(formData, keys), c.items);
    const changes = tidyChanges(c, { ...head, items });
    if (!changes.length) return { changed: false };
    Object.assign(c, head, { items, ...tidyScore(items), updatedBy: user.id, updatedAt: nowIso() });
    addAudit(db, { userId: user.id, action: "update", entity: "tidy_check", entityId: c.id, entityLabel: `${c.number} ${c.date}`, summary: `整理整頓チェックを修正 (${c.score === undefined ? "点数なし" : `${c.score} 点`} · 要改善 ${c.ngCount} 件)`, storeId: c.storeId, changes });
    return { changed: true };
  });
  refresh(id);
  redirect(withMsg(page(id), r.changed ? "保存しました。" : "変更はありませんでした。"));
}

export async function deleteTidyCheck(id: string) {
  const user = await requireActionUser();
  await assertTable(page(id));
  const removed = await mutate((db) => {
    const c = findCheck(db, user, id);
    if (!canDeleteTidyCheck(user, c)) fail(page(id), "このチェックを削除できるのは、チェックした人・その店舗の店長・本部・管理者です。");
    db.tidyChecks = db.tidyChecks.filter((x) => x.id !== id);
    addAudit(db, { userId: user.id, action: "delete", entity: "tidy_check", entityId: c.id, entityLabel: `${c.number} ${c.date}`, summary: `整理整頓チェックを削除 (${c.number} ${c.date}${c.photos.length ? ` · 写真 ${c.photos.length} 枚` : ""})`, storeId: c.storeId });
    return c.photos;
  });
  await discardTidyPhotos(removed);
  refresh();
  redirect(withMsg(LIST, "削除しました。"));
}

/* ================================================================== */
/* 要改善の対応                                                          */
/* ================================================================== */

/** 要改善の項目を「直した」/ 未対応に戻す / 期限を変える */
export async function setTidyFollowUp(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `${page(id)}#followups`;
  await assertTable(back);
  const key = str(formData, "key");
  const op = str(formData, "op");
  const r = await mutate((db) => {
    const c = findCheck(db, user, id);
    if (!canEditTidyCheck(user, c)) fail(back, "このチェックの対応を記録する権限がありません。");
    const it = c.items.find((x) => x.key === key && x.result === "ng");
    if (!it) fail(back, "要改善の項目が見つかりません。");
    const before = { fixStatus: it.fixStatus ?? "open", dueDate: it.dueDate ?? "" };
    if (op === "fix") Object.assign(it, { fixStatus: "fixed", fixedAt: nowIso(), fixedBy: user.id, fixNote: str(formData, "fixNote").slice(0, 300) || undefined });
    else if (op === "reopen") Object.assign(it, { fixStatus: "open", fixedAt: undefined, fixedBy: undefined });
    else if (op === "due") {
      const due = str(formData, "dueDate");
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(back, "期限の日付が正しくありません。");
      it.dueDate = due || undefined;
    } else fail(back, "操作が分かりません。");
    c.updatedBy = user.id;
    c.updatedAt = nowIso();
    const label = op === "fix" ? "直した" : op === "reopen" ? "未対応に戻す" : `期限 ${it.dueDate ?? "なし"}`;
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "tidy_check",
      entityId: c.id,
      entityLabel: `${c.number} ${c.date}`,
      summary: `整理整頓チェックの要改善「${it.label}」: ${label}`,
      storeId: c.storeId,
      changes: op === "due" ? [{ field: "dueDate", before: before.dueDate, after: it.dueDate ?? "" }] : [{ field: "fixStatus", before: before.fixStatus === "fixed" ? "直した" : "未対応", after: it.fixStatus === "fixed" ? "直した" : "未対応" }],
    });
    return label;
  });
  refresh(id);
  redirect(withMsg(back, `「${r}」を記録しました。`));
}

/* ================================================================== */
/* 写真                                                                 */
/* ================================================================== */

export async function deleteTidyPhoto(id: string, photoId: string) {
  const user = await requireActionUser();
  const back = `${page(id)}#photos`;
  await assertTable(back);
  const removed = await mutate((db) => {
    const c = findCheck(db, user, id);
    const p = c.photos.find((x) => x.id === photoId);
    if (!p) fail(back, "写真が見つかりません。");
    if (!(p.uploadedBy === user.id || canDeleteTidyCheck(user, c))) fail(back, "写真を削除できるのは、登録した本人・その店舗の店長・本部・管理者です。");
    c.photos = c.photos.filter((x) => x.id !== photoId);
    c.updatedBy = user.id;
    c.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "tidy_check", entityId: c.id, entityLabel: `${c.number} ${c.date}`, summary: `整理整頓チェックの写真を削除 (${p.fileName})`, storeId: c.storeId, changes: [{ field: "photos", before: `${c.photos.length + 1} 枚`, after: `${c.photos.length} 枚` }] });
    return p;
  });
  await discardTidyPhotos([removed]);
  refresh(id);
  redirect(withMsg(back, "写真を削除しました。"));
}

/** LINE の「整理整頓の確認」グループの写真をこのチェックに付ける */
export async function addLinePhotosToTidy(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `${page(id)}#photos`;
  await assertTable(back);
  const db0 = getDb();
  const c0 = findCheck(db0, user, id);
  if (!canEditTidyCheck(user, c0)) fail(back, "このチェックに写真を付ける権限がありません。");
  const refs = [...new Set(formData.getAll("lineRefs").map(String))];
  if (!refs.length) fail(back, "付ける写真を選んでください。");
  const copied = await copyLinePhotos(user, refs, TIDY_MAX_PHOTOS - c0.photos.length);
  if (!copied.photos.length) fail(back, copied.errors[0] ?? `写真は 1 つのチェックに ${TIDY_MAX_PHOTOS} 枚までです。`);
  try {
    await mutate((db) => {
      const c = findCheck(db, user, id);
      c.photos = [...c.photos, ...copied.photos.map((p) => p.photo)];
      for (const p of copied.photos) markLineMessageHandled(db, p.ref, user.id, `tidy:${c.id}`);
      touchLineGroups(db, user.id);
      c.updatedBy = user.id;
      c.updatedAt = nowIso();
      addAudit(db, { userId: user.id, action: "update", entity: "tidy_check", entityId: c.id, entityLabel: `${c.number} ${c.date}`, summary: `LINE の写真 ${copied.photos.length} 枚を整理整頓チェックに追加`, storeId: c.storeId, changes: [{ field: "photos", before: `${c.photos.length - copied.photos.length} 枚`, after: `${c.photos.length} 枚` }] });
    });
  } catch (err) {
    await discardTidyPhotos(copied.photos.map((p) => p.photo));
    throw err;
  }
  await removeObjects(copied.photos.map((p) => p.fileKey ?? "")).catch(() => undefined);
  refresh(id);
  redirect(withMsg(back, `LINE の写真 ${copied.photos.length} 枚を付けました。${copied.errors.length ? ` 付けられなかった写真: ${copied.errors.length} 枚 (${copied.errors[0]})` : ""}`));
}

/* ================================================================== */
/* チェック項目 (管理者)                                                   */
/* ================================================================== */

/** チェック項目をまとめて差し替える (1 行 1 項目。■ で始まる行は見出し)。過去のチェックは項目の写しを持つので変わらない */
export async function saveTidyItems(formData: FormData) {
  const user = await requireActionUser();
  const back = "/kpi/tidy/items";
  if (!canManageTidyItems(user)) fail(back, "チェック項目を変えられるのは管理者です。");
  const parsed = parseTidyItemsText(str(formData, "text"));
  if (!parsed.items.length) fail(back, "項目が 1 つもありません。1 行に 1 項目ずつ入れてください。");
  const provisional = formData.get("provisional") === "on";
  const r = await mutate((db) => {
    const before = tidySettings(db);
    const now = nowIso();
    const value = { items: parsed.items, provisional };
    const row = db.settings.find((s) => s.id === TIDY_ITEMS_SETTING_ID);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
    else db.settings.push({ id: TIDY_ITEMS_SETTING_ID, value, updatedBy: user.id, updatedAt: now });
    const keep = new Set(before.items.map((i) => i.key));
    const added = parsed.items.filter((i) => !keep.has(i.key)).length;
    const removed = before.items.filter((i) => !parsed.items.some((x) => x.key === i.key)).length;
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: TIDY_ITEMS_SETTING_ID,
      entityLabel: "整理整頓チェックの項目",
      summary: `整理整頓チェックの項目を更新 (${parsed.items.length} 項目 · 追加 ${added} · 外した ${removed}${provisional ? " · 暫定" : ""})`,
      storeId: "hq",
      changes: [
        { field: "tidyItems", before: `${before.items.length} 項目${before.provisional ? " (暫定)" : ""}`, after: `${parsed.items.length} 項目${provisional ? " (暫定)" : ""}` },
      ],
    });
    return { added, removed };
  });
  revalidatePath(LIST);
  revalidatePath(back);
  redirect(withMsg(back, `チェック項目を保存しました (${parsed.items.length} 項目 · 追加 ${r.added} · 外した ${r.removed}${parsed.skipped.length ? ` · 重複 ${parsed.skipped.length} 行は 1 つにしました` : ""})。これからのチェックはこの項目で記録します (過去の記録は変わりません)。`));
}
