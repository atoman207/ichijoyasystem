"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { CasePost, CasePostChannel, CasePostConsent, Database, Order, User } from "@/lib/db/types";
import { CATEGORY_LABEL } from "@/lib/constants";
import { canApproveCasePost, canCreateCasePost, canEditCasePost, canManageCasePostSettings, canViewCasePost } from "@/lib/auth/permissions";
import {
  CASE_POSTS_SETTING_ID,
  CASE_POST_CHANNELS,
  CASE_POST_CHANNEL_LABEL,
  CASE_POST_CONSENT_LABEL,
  CASE_POST_STATUS,
  CasePostError,
  casePostReviewerIds,
  casePostReviewers,
  createCasePost as createPost,
  editCasePost,
  orderPhotos,
  personalContext,
  recordCasePosting,
  scrubPersonal,
  transitionCasePost,
  type CasePostFields,
  type CasePostTransition,
  type PostDraftInput,
} from "@/lib/case-posts";
import { draftCasePostText } from "@/lib/ai/case-post";
import { postTablesMissing } from "@/lib/posts-tables";
import { sendAndRecord } from "@/lib/notify/send";
import { casePostResultNotices, casePostReviewNotices } from "@/lib/notify/events";
import { toDateKey } from "@/lib/format";
import { choice, fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 施工事例の投稿 (資料・写真 → 施工事例の投稿。src/lib/case-posts.ts)
 * 作成 (AI で下書き) → 修正 → 確認の依頼 → 確認する人の承認・差し戻し → 投稿の記録。SNS への自動の投稿はしない
 */

const LIST = "/materials?tab=cases";
const page = (id: string) => `/materials/cases/${id}`;

async function assertTable(back: string) {
  const missing = await postTablesMissing(["case_posts"]);
  if (missing) fail(back, missing);
}

function guarded<T>(back: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CasePostError) fail(back, e.message);
    throw e;
  }
}

function findPost(db: Database, user: User, id: string): CasePost {
  const p = (db.casePosts ?? []).find((x) => x.id === id);
  if (!p) fail(LIST, "施工事例の投稿が見つかりません。");
  if (!canViewCasePost(user, p, casePostReviewerIds(db))) fail(LIST, "この投稿を見る権限がありません。");
  return p;
}

const refresh = (p: { id: string; orderId: string }) => {
  revalidatePath("/materials");
  revalidatePath(page(p.id));
  revalidatePath(`/orders/${p.orderId}`);
};

/** フォームの内容 (写真は受注の写真だけ。選んだ順) */
function readFields(db: Database, formData: FormData, order: Pick<Order, "id">): CasePostFields {
  const allowed = new Set(orderPhotos(db, order.id).map((a) => a.id));
  const photoIds = formData.getAll("photoIds").map(String).filter((id) => allowed.has(id));
  const channels = formData.getAll("channels").map(String).filter((c): c is CasePostChannel => (CASE_POST_CHANNELS as string[]).includes(c));
  const f: CasePostFields = {
    title: str(formData, "title"),
    photoIds,
    products: str(formData, "products"),
    workContent: str(formData, "workContent"),
    area: str(formData, "area"),
    channels,
    consent: choice<CasePostConsent>(formData, "consent", CASE_POST_CONSENT_LABEL, "unconfirmed"),
  };
  if (formData.has("text")) f.text = String(formData.get("text") ?? "");
  if (formData.has("hashtags")) f.hashtags = str(formData, "hashtags");
  return f;
}

/** AI に渡す材料 (お客様の個人情報を除いたもの) */
function draftInput(db: Database, order: Order, f: CasePostFields, ctx: ReturnType<typeof personalContext>): PostDraftInput {
  const store = db.stores.find((s) => s.id === order.storeId);
  const date = order.completedAt || order.scheduledStart || order.contractDate;
  return {
    title: scrubPersonal(f.title ?? "", ctx),
    area: (f.area ?? "").replace(/\d.*$/, "").trim(),
    products: (f.products ?? "").split("\n").map((l) => l.trim()).filter(Boolean),
    workContent: scrubPersonal(f.workContent ?? "", ctx),
    categoryLabel: CATEGORY_LABEL[order.category] ?? "",
    storeName: store?.kind === "store" ? store.name : "",
    channels: f.channels ?? [],
    month: date ? `${Number(date.slice(5, 7))} 月` : undefined,
  };
}

/* ================================================================== */
/* 作成                                                                 */
/* ================================================================== */

/** 案件から投稿を作り、AI で投稿文の下書きを作る (AI がないときは定型文) */
export async function createCasePost(formData: FormData) {
  const user = await requireActionUser();
  const orderId = str(formData, "orderId");
  const back = `/materials/cases/new?order=${encodeURIComponent(orderId)}`;
  await assertTable(back);
  const db0 = getDb();
  const order = db0.orders.find((o) => o.id === orderId);
  if (!order) fail(LIST, "案件 (受注) が見つかりません。");
  if (!canCreateCasePost(user, order.storeId)) fail(back, "この案件の店舗の担当者・本部・管理者が作れます。");
  const fields = readFields(db0, formData, order);
  if (!fields.channels?.length) fields.channels = ["instagram"];
  const ctx = personalContext(db0.customers.find((c) => c.id === order.customerId), order);
  const draft = await draftCasePostText(draftInput(db0, order, fields, ctx), ctx, user.id);
  const id = await mutate((db) =>
    guarded(back, () => {
      const o = db.orders.find((x) => x.id === orderId);
      if (!o) throw new CasePostError("案件 (受注) が見つかりません。");
      const p = createPost(db, user, { id: newId("cp"), order: o, fields: { ...fields, text: draft.text, hashtags: draft.hashtags }, aiText: draft.text, provider: draft.provider }, nowIso());
      addAudit(db, { userId: user.id, action: "create", entity: "case_post", entityId: p.id, entityLabel: `${p.number} ${p.title}`, summary: `施工事例の投稿を作成 (受注 ${o.number} · 写真 ${p.photoIds.length} 枚 · 下書き: ${draft.provider === "rules" ? "定型文" : "AI"})`, storeId: p.storeId });
      return p.id;
    }),
  );
  revalidatePath("/materials");
  revalidatePath(`/orders/${orderId}`);
  redirect(withMsg(page(id), `下書きを作りました${draft.note ? ` (${draft.note})` : ""}。投稿文を確かめて直し、「確認を依頼する」を押してください。`));
}

/* ================================================================== */
/* 修正 (intent = ai のときは、保存した内容で投稿文を作り直す)                       */
/* ================================================================== */

export async function saveCasePost(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  await assertTable(back);
  const intent = str(formData, "intent") === "ai" ? "ai" : "save";
  const db0 = getDb();
  const p0 = findPost(db0, user, id);
  const ids0 = casePostReviewerIds(db0);
  if (!canEditCasePost(user, p0, ids0)) fail(back, p0.status === "review" ? "確認を依頼している間は、確認する人だけが直せます。" : "この投稿は直せません。");
  const order = db0.orders.find((o) => o.id === p0.orderId);
  if (!order) fail(back, "案件 (受注) が見つかりません。");
  const fields = readFields(db0, formData, order);
  let note = "";
  if (intent === "ai") {
    const ctx = personalContext(db0.customers.find((c) => c.id === order.customerId), order);
    const draft = await draftCasePostText(draftInput(db0, order, fields, ctx), ctx, user.id);
    fields.text = draft.text;
    fields.hashtags = draft.hashtags;
    note = draft.note ?? "";
    const r = await mutate((db) => {
      const p = findPost(db, user, id);
      return guarded(back, () => {
        const res = editCasePost(p, user, fields, casePostReviewerIds(db), nowIso(), "ai");
        p.aiText = draft.text;
        p.provider = draft.provider;
        addAudit(db, { userId: user.id, action: "update", entity: "case_post", entityId: p.id, entityLabel: `${p.number} ${p.title}`, summary: `施工事例の投稿文を${draft.provider === "rules" ? "定型文" : " AI "}で作り直す${res.reset ? " (承認はやり直し)" : ""}`, storeId: p.storeId, changes: res.changes.length ? res.changes : [{ field: "text", before: "", after: "作り直し" }] });
        return { reset: res.reset, p: { id: p.id, orderId: p.orderId } };
      });
    });
    refresh(r.p);
    redirect(withMsg(back, `投稿文を作り直しました${note ? ` (${note})` : ""}${r.reset ? "。承認のあとに直したため、下書きに戻りました" : ""}。`));
  }
  const r = await mutate((db) => {
    const p = findPost(db, user, id);
    return guarded(back, () => {
      const res = editCasePost(p, user, fields, casePostReviewerIds(db), nowIso());
      if (res.changed) addAudit(db, { userId: user.id, action: "update", entity: "case_post", entityId: p.id, entityLabel: `${p.number} ${p.title}`, summary: `施工事例の投稿を修正${res.reset ? " (承認はやり直し)" : ""}`, storeId: p.storeId, changes: res.changes });
      return { ...res, p: { id: p.id, orderId: p.orderId } };
    });
  });
  refresh(r.p);
  redirect(withMsg(back, !r.changed ? "変更はありませんでした。" : r.reset ? "保存しました。承認のあとに直したため下書きに戻りました (もう一度「確認を依頼する」が必要です)。" : "保存しました。"));
}

/* ================================================================== */
/* 状態の変更                                                            */
/* ================================================================== */

const DONE: Record<CasePostTransition, string> = {
  request: "確認を依頼しました。確認する人に知らせました。",
  approve: "承認しました。担当者が投稿できます。",
  return: "差し戻しました。作成者に知らせました。",
  withdraw: "確認の依頼を取り下げました (下書きに戻りました)。",
  discard: "取りやめにしました。",
  restore: "下書きに戻しました。",
};

export async function changeCasePostStatus(id: string, action: CasePostTransition, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  if (!(action in DONE)) fail(back, "操作が分かりません。");
  await assertTable(back);
  const comment = str(formData, "comment");
  const r = await mutate((db) => {
    const p = findPost(db, user, id);
    const ids = casePostReviewerIds(db);
    const order = db.orders.find((o) => o.id === p.orderId);
    const ctx = personalContext(order ? db.customers.find((c) => c.id === order.customerId) : undefined, order);
    return guarded(back, () => {
      const t = transitionCasePost(p, user, action, ids, ctx, comment, nowIso());
      addAudit(db, {
        userId: user.id,
        action: action === "approve" ? "approve" : action === "return" ? "reject" : action === "request" ? "submit" : "status",
        entity: "case_post",
        entityId: p.id,
        entityLabel: `${p.number} ${p.title}`,
        summary: `施工事例の投稿を「${CASE_POST_STATUS[t.to].label}」に (${CASE_POST_STATUS[t.from].label} → ${CASE_POST_STATUS[t.to].label}${comment ? `・${comment.slice(0, 60)}` : ""})`,
        storeId: p.storeId,
        changes: [{ field: "status", before: CASE_POST_STATUS[t.from].label, after: CASE_POST_STATUS[t.to].label }],
      });
      // 確認する人が自分で確認を依頼したときは、そのまま承認する (承認の記録は残す)
      let auto = false;
      if (action === "request" && canApproveCasePost(user, p, ids)) {
        transitionCasePost(p, user, "approve", ids, ctx, "確認する人が確認したため承認まで", nowIso());
        addAudit(db, { userId: user.id, action: "approve", entity: "case_post", entityId: p.id, entityLabel: `${p.number} ${p.title}`, summary: "施工事例の投稿を承認 (確認する人が確認したため承認まで)", storeId: p.storeId, changes: [{ field: "status", before: CASE_POST_STATUS.review.label, after: CASE_POST_STATUS.approved.label }] });
        auto = true;
      }
      return { p: { ...p }, auto };
    });
  });
  const db = getDb();
  if (action === "request" && !r.auto) await sendAndRecord(casePostReviewNotices(db, r.p, casePostReviewers(db)), user.id);
  if (action === "approve" || action === "return") await sendAndRecord(casePostResultNotices(db, r.p, user.id, action === "approve" ? "approved" : "returned", comment || undefined), user.id);
  refresh(r.p);
  redirect(withMsg(back, r.auto ? "確認して承認しました。文面をコピー・写真を保存して投稿し、投稿したら記録してください。" : DONE[action]));
}

/* ================================================================== */
/* 投稿の記録                                                            */
/* ================================================================== */

export async function recordCasePostPosting(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = page(id);
  await assertTable(back);
  const channel = choice<CasePostChannel>(formData, "channel", CASE_POST_CHANNEL_LABEL, "instagram");
  const on = str(formData, "on") || toDateKey(new Date());
  const url = str(formData, "url");
  const r = await mutate((db) => {
    const p = findPost(db, user, id);
    return guarded(back, () => {
      const t = recordCasePosting(p, user, { channel, on, url }, casePostReviewerIds(db), nowIso());
      addAudit(db, {
        userId: user.id,
        action: "status",
        entity: "case_post",
        entityId: p.id,
        entityLabel: `${p.number} ${p.title}`,
        summary: `施工事例を投稿 (${CASE_POST_CHANNEL_LABEL[channel]} ${on}${url ? ` ${url}` : ""})`,
        storeId: p.storeId,
        changes: [{ field: "postings", before: t.from === "posted" ? "投稿済み" : CASE_POST_STATUS[t.from].label, after: `${CASE_POST_CHANNEL_LABEL[channel]} ${on}${url ? ` ${url}` : ""}` }],
      });
      return { id: p.id, orderId: p.orderId };
    });
  });
  refresh(r);
  redirect(withMsg(back, `${CASE_POST_CHANNEL_LABEL[channel]} への投稿を記録しました。`));
}

/* ================================================================== */
/* 確認する人の設定 (管理者)                                                */
/* ================================================================== */

export async function saveCasePostReviewers(formData: FormData) {
  const user = await requireActionUser();
  const back = LIST;
  if (!canManageCasePostSettings(user)) fail(back, "確認する人を変えられるのは管理者です。");
  const db0 = getDb();
  const ids = [...new Set(formData.getAll("reviewerIds").map(String))].filter((x) => db0.users.some((u) => u.id === x && u.active));
  await mutate((db) => {
    const now = nowIso();
    const row = db.settings.find((s) => s.id === CASE_POSTS_SETTING_ID);
    const before = Array.isArray(row?.value?.reviewerIds) ? (row!.value.reviewerIds as string[]) : [];
    const value = { ...(row?.value ?? {}), reviewerIds: ids };
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
    else db.settings.push({ id: CASE_POSTS_SETTING_ID, value, updatedBy: user.id, updatedAt: now });
    const names = (list: string[]) => list.map((x) => db.users.find((u) => u.id === x)?.name ?? x).join("・") || "(既定: 本部の管理者)";
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: CASE_POSTS_SETTING_ID, entityLabel: "施工事例の投稿を確認する人", summary: `施工事例の投稿を確認する人を「${names(ids)}」に変更`, storeId: "hq", changes: [{ field: "reviewerIds", before: names(before), after: names(ids) }] });
  });
  revalidatePath("/materials");
  redirect(withMsg(back, ids.length ? "確認する人を保存しました。" : "確認する人を既定 (本部の管理者) に戻しました。"));
}
