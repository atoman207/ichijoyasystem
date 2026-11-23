"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { canAccessStore, canManageKpi, canManageSettings } from "@/lib/auth/permissions";
import type { QualityKind, StoreId, SurveyResponse } from "@/lib/db/types";
import { KPI_SETTINGS_ID, QUALITY_CATEGORIES, QUALITY_KIND_LABEL, kpiSettings, parseTiers } from "@/lib/kpi-settings";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, normPostcardNo, tagComment } from "@/lib/survey";
import { findOrderByPostcard, findSurveyByPostcard, storeFromPostcard, surveyFromExtracted } from "@/lib/survey-link";
import { analyzeVoices } from "@/lib/ai/voice";
import { findLineGroup, markLineMessageHandled, parseLineMessageRef } from "@/lib/line-groups";
import { assertStore, choice, fail, numField, requireActionUser, safeReturn, str, withMsg } from "./guards";

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** 新しい表 (反映前の本番) に書き込む前の確認 */
async function assertTable(table: string, back: string) {
  if (BACKEND === "supabase" && missingTables().includes(table) && (await recheckMissingTables()).includes(table)) {
    fail(back, "データベースにこの機能の表がまだありません。開発担当が npm run db:migrate を実行すると使えるようになります。");
  }
}

/* ================================================================== */
/* クレーム・手直し (案件から登録)                                        */
/* ================================================================== */

const QUALITY_KINDS = ["rework", "claim", "claim_rework"] as const;

export async function createQualityIssue(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/orders/${orderId}`);
  await assertTable("quality_issues", back);
  const kind = choice(formData, "kind", QUALITY_KINDS, "rework") as QualityKind;
  const occurredOn = str(formData, "occurredOn");
  const description = str(formData, "description");
  if (!isDate(occurredOn)) fail(back, "発生日を入力してください。");
  if (!description) fail(back, "内容を入力してください。");
  let number = "";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "案件が見つかりません。");
    assertStore(user, o.storeId, back);
    const users = new Set(db.users.map((u) => u.id));
    const responsible = [...new Set(formData.getAll("responsibleUserIds").map(String).filter((v) => users.has(v)))];
    if (!responsible.length) fail(back, "対象の担当者を 1 人以上選んでください。");
    const points = kpiSettings(db).qualityPoints[kind];
    const now = nowIso();
    number = nextNumber(db, "QC", db.qualityIssues, occurredOn);
    const id = newId("qc");
    db.qualityIssues.push({
      id,
      number,
      orderId: o.id,
      customerId: o.customerId,
      storeId: o.storeId,
      kind,
      points,
      occurredOn,
      responsibleUserIds: responsible,
      description,
      cause: str(formData, "cause") || undefined,
      countermeasure: str(formData, "countermeasure") || undefined,
      attribution: str(formData, "attribution") === "office" ? "office" : "store",
      category: (QUALITY_CATEGORIES as readonly string[]).includes(str(formData, "category")) ? str(formData, "category") : undefined,
      counted: formData.get("notCounted") !== "on",
      status: str(formData, "cause") && str(formData, "countermeasure") && formData.get("resolved") === "on" ? "resolved" : "open",
      resolvedOn: formData.get("resolved") === "on" ? occurredOn : undefined,
      reportedBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    const names = responsible.map((r) => db.users.find((u) => u.id === r)?.name ?? r).join("・");
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `${QUALITY_KIND_LABEL[kind]}を登録 (${number} / ${points} 点 / 担当: ${names})\n${description}` });
    o.updatedAt = now;
    addAudit(db, { userId: user.id, action: "create", entity: "quality", entityId: id, entityLabel: o.number, summary: `${QUALITY_KIND_LABEL[kind]}を登録 (${number} / ${points} 点 / 担当: ${names})`, storeId: o.storeId });
  });
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/kpi");
  redirect(withMsg(back, `${QUALITY_KIND_LABEL[kind]} ${number} を登録しました。KPI に反映されます。原因・対策は「クレーム・手直し」の画面で追記できます。`));
}

/**
 * 案件の画面を通らずに登録する (LINE の「クレーム・手直し報告」グループの報告から・電話で受けたクレームなど)。
 * 受注番号が分かればひも付け、分からなければ現場名で残して、あとから詳細の画面でひも付ける
 */
export async function registerQualityIssue(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/kpi/quality/new");
  await assertTable("quality_issues", back);
  const kind = choice(formData, "kind", QUALITY_KINDS, "rework") as QualityKind;
  const occurredOn = str(formData, "occurredOn");
  const description = str(formData, "description");
  const siteName = str(formData, "siteName").slice(0, 120);
  const orderRef = str(formData, "orderRef").normalize("NFKC").trim().toUpperCase();
  const lineRef = str(formData, "lineRef");
  if (!isDate(occurredOn)) fail(back, "発生日を入力してください。");
  if (!description) fail(back, "内容を入力してください。");
  if (!orderRef && !siteName) fail(back, "受注番号か現場名のどちらかを入力してください。");
  let id = "";
  let number = "";
  await mutate((db) => {
    const o = orderRef ? db.orders.find((x) => x.number.toUpperCase() === orderRef) : undefined;
    if (orderRef && !o) fail(back, `受注番号「${orderRef}」が見つかりません (分からなければ空欄にして現場名を入れてください)。`);
    const storeId = (o?.storeId ?? str(formData, "storeId")) as StoreId;
    if (!db.stores.some((s) => s.id === storeId)) fail(back, "店舗を選んでください。");
    assertStore(user, storeId, back);
    const users = new Set(db.users.map((u) => u.id));
    const responsible = [...new Set(formData.getAll("responsibleUserIds").map(String).filter((v) => users.has(v)))];
    if (lineRef) {
      const p = parseLineMessageRef(lineRef);
      const g = p ? findLineGroup(db, p.groupId) : undefined;
      if (!g || g.purpose !== "quality" || (g.storeId ? !canAccessStore(user, g.storeId) : !canManageKpi(user))) fail(back, "LINE の報告が見つかりません。");
    }
    const points = kpiSettings(db).qualityPoints[kind];
    const now = nowIso();
    number = nextNumber(db, "QC", db.qualityIssues, occurredOn);
    id = newId("qc");
    const cause = str(formData, "cause") || undefined;
    const countermeasure = str(formData, "countermeasure") || undefined;
    const resolved = formData.get("resolved") === "on" && Boolean(cause && countermeasure);
    db.qualityIssues.push({
      id,
      number,
      orderId: o?.id,
      customerId: o?.customerId,
      siteName: siteName || undefined,
      origin: str(formData, "origin").slice(0, 40) || (lineRef ? "LINE" : undefined),
      storeId,
      kind,
      points,
      occurredOn,
      responsibleUserIds: responsible,
      description,
      cause,
      countermeasure,
      attribution: str(formData, "attribution") === "office" ? "office" : "store",
      category: (QUALITY_CATEGORIES as readonly string[]).includes(str(formData, "category")) ? str(formData, "category") : undefined,
      counted: formData.get("notCounted") !== "on",
      status: resolved ? "resolved" : "open",
      resolvedOn: resolved ? occurredOn : undefined,
      reportedBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    if (o) {
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `${QUALITY_KIND_LABEL[kind]}を登録 (${number} / ${points} 点)\n${description}` });
      o.updatedAt = now;
    }
    if (lineRef) markLineMessageHandled(db, lineRef, user.id, `quality:${id}`);
    addAudit(db, { userId: user.id, action: "create", entity: "quality", entityId: id, entityLabel: o?.number ?? (siteName || number), summary: `${QUALITY_KIND_LABEL[kind]}を登録 (${number} / ${points} 点${o ? "" : ` / 現場: ${siteName}`}${lineRef ? " / LINE の報告から" : ""})`, storeId });
  });
  revalidatePath("/kpi");
  redirect(withMsg(`/kpi/quality/${id}`, `${QUALITY_KIND_LABEL[kind]} ${number} を登録しました。KPI に反映されます。${orderRef ? "" : "案件が分かったら、この画面の「案件 (受注番号)」でひも付けてください。"}`));
}

/** LINE の報告を「記録にしない」で対応済みにする (クレーム・手直しではなかった・重複の報告など) */
export async function dismissLineReport(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/kpi/quality");
  const ref = str(formData, "lineRef");
  const reason = str(formData, "reason").slice(0, 80);
  await mutate((db) => {
    const p = parseLineMessageRef(ref);
    const g = p ? findLineGroup(db, p.groupId) : undefined;
    if (!g || g.purpose !== "quality") fail(back, "LINE の報告が見つかりません。");
    if (g.storeId ? !canAccessStore(user, g.storeId) : !canManageKpi(user)) fail(back, "この報告を対応済みにする権限がありません。");
    if (!markLineMessageHandled(db, ref, user.id, reason ? `dismissed:${reason}` : "dismissed")) fail(back, "LINE の報告が見つかりません。");
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: g.id, entityLabel: g.label || g.name || g.id, summary: `LINE のクレーム・手直し報告を記録にせず対応済みにしました${reason ? ` (${reason})` : ""}`, storeId: g.storeId ?? "hq" });
  });
  revalidatePath("/kpi/quality");
  redirect(withMsg(back, "LINE の報告を対応済みにしました。"));
}

export async function updateQualityIssue(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/kpi/quality/${id}`);
  await mutate((db) => {
    const q = db.qualityIssues.find((x) => x.id === id);
    if (!q) fail("/kpi/quality", "記録が見つかりません。");
    assertStore(user, q.storeId, back);
    const canEdit = canManageKpi(user) || q.reportedBy === user.id || q.responsibleUserIds.includes(user.id);
    if (!canEdit) fail(back, "この記録を変更できるのは、登録者・対象の担当者・店長・本部・管理者です。");
    const snap = () => ({ kind: q.kind, points: q.points, occurredOn: q.occurredOn, description: q.description, cause: q.cause ?? "", countermeasure: q.countermeasure ?? "", status: q.status, responsible: q.responsibleUserIds.join(","), attribution: q.attribution ?? "store", category: q.category ?? "", counted: q.counted !== false, order: q.orderId ?? "", siteName: q.siteName ?? "", origin: q.origin ?? "" });
    const before = snap();
    const kind = choice(formData, "kind", QUALITY_KINDS, q.kind) as QualityKind;
    // 区分を変えたときだけ、今のルールで点数を付け直す (区分が同じなら登録時の点数のまま)
    if (kind !== q.kind) {
      if (!canManageKpi(user)) fail(back, "区分 (手直し・クレーム) の変更は店長・本部・管理者が行います。");
      q.kind = kind;
      q.points = kpiSettings(db).qualityPoints[kind];
    }
    const occurredOn = str(formData, "occurredOn");
    if (occurredOn && isDate(occurredOn)) q.occurredOn = occurredOn;
    q.description = str(formData, "description") || q.description;
    q.cause = str(formData, "cause") || undefined;
    q.countermeasure = str(formData, "countermeasure") || undefined;
    if (formData.has("siteName")) q.siteName = str(formData, "siteName").slice(0, 120) || undefined;
    if (formData.has("origin")) q.origin = str(formData, "origin").slice(0, 40) || undefined;
    // 案件 (受注番号) へのひも付け: スプレッドシートから取り込んだ記録・LINE の報告から登録した記録を、あとから案件に付ける
    if (formData.has("orderRef")) {
      const ref = str(formData, "orderRef").normalize("NFKC").trim().toUpperCase();
      if (!ref) {
        if (q.orderId && !canManageKpi(user)) fail(back, "案件のひも付けを外せるのは店長・本部・管理者です。");
        q.orderId = undefined;
      } else {
        const o = db.orders.find((x) => x.number.toUpperCase() === ref);
        if (!o) fail(back, `受注番号「${ref}」が見つかりません。`);
        assertStore(user, o.storeId, back);
        if (o.id !== q.orderId) {
          q.orderId = o.id;
          q.customerId = o.customerId;
          o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `${QUALITY_KIND_LABEL[q.kind]} ${q.number} をこの案件にひも付けました\n${q.description}` });
          o.updatedAt = nowIso();
        }
      }
    }
    if (formData.has("attribution") && canManageKpi(user)) q.attribution = str(formData, "attribution") === "office" ? "office" : "store";
    if (formData.has("category")) q.category = (QUALITY_CATEGORIES as readonly string[]).includes(str(formData, "category")) ? str(formData, "category") : undefined;
    if (formData.has("countedField") && canManageKpi(user)) q.counted = formData.get("notCounted") !== "on";
    const users = new Set(db.users.map((u) => u.id));
    const responsible = formData.getAll("responsibleUserIds").map(String).filter((v) => users.has(v));
    if (formData.has("responsibleUserIds") && canManageKpi(user)) q.responsibleUserIds = [...new Set(responsible)];
    const resolved = formData.get("resolved") === "on";
    if (resolved && q.status !== "resolved") {
      if (!q.cause || !q.countermeasure) fail(back, "解決済みにするには、原因と対策を入力してください。");
      q.status = "resolved";
      q.resolvedOn = new Date().toISOString().slice(0, 10);
    } else if (!resolved && q.status === "resolved") {
      q.status = "open";
      q.resolvedOn = undefined;
    }
    const after = snap();
    const orderNo = (id: string) => (id ? (db.orders.find((x) => x.id === id)?.number ?? id) : "");
    const changes = (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]).map((k) => (k === "order" ? { field: k, before: orderNo(before.order), after: orderNo(after.order) } : { field: k, before: before[k], after: after[k] }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    q.updatedAt = nowIso();
    const o = db.orders.find((x) => x.id === q.orderId);
    const LABEL: Record<string, string> = { kind: "区分", points: "点数", occurredOn: "発生日", description: "内容", cause: "原因", countermeasure: "対策", status: "状態", responsible: "担当者", attribution: "ポイントの単位", category: "カテゴリー", counted: "集計の対象", order: "案件", siteName: "現場名", origin: "発生のきっかけ" };
    addAudit(db, { userId: user.id, action: "update", entity: "quality", entityId: q.id, entityLabel: o?.number ?? q.number, summary: `${QUALITY_KIND_LABEL[q.kind]} ${q.number} を更新 (${changes.map((c) => LABEL[c.field]).join("・")})`, storeId: q.storeId, changes });
    if (o && changes.some((c) => c.field === "status") && q.status === "resolved") {
      o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `${QUALITY_KIND_LABEL[q.kind]} ${q.number} を解決済みにしました\n原因: ${q.cause}\n対策: ${q.countermeasure}` });
    }
  });
  revalidatePath("/kpi");
  redirect(withMsg(back, "クレーム・手直しの記録を更新しました。"));
}

export async function deleteQualityIssue(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/kpi/quality");
  if (!canManageKpi(user)) fail(back, "削除は店長・本部スタッフ・管理者が行えます。");
  let orderId = "";
  await mutate((db) => {
    const idx = db.qualityIssues.findIndex((x) => x.id === id);
    if (idx < 0) fail("/kpi/quality", "記録が見つかりません。");
    const q = db.qualityIssues[idx];
    assertStore(user, q.storeId, back);
    orderId = q.orderId ?? "";
    db.qualityIssues.splice(idx, 1);
    const o = db.orders.find((x) => x.id === q.orderId);
    addAudit(db, { userId: user.id, action: "delete", entity: "quality", entityId: q.id, entityLabel: o?.number ?? q.number, summary: `${QUALITY_KIND_LABEL[q.kind]} ${q.number} を削除 (${str(formData, "reason") || "理由未記入"})`, storeId: q.storeId });
  });
  revalidatePath("/kpi");
  redirect(withMsg(back.startsWith(`/kpi/quality/${id}`) ? (orderId ? `/orders/${orderId}` : "/kpi/quality") : back, "記録を削除しました。"));
}

/* ================================================================== */
/* Google 口コミ                                                        */
/* ================================================================== */

export async function createReview(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/kpi/reviews");
  await assertTable("google_reviews", back);
  const postedOn = str(formData, "postedOn");
  const userId = str(formData, "userId");
  if (!isDate(postedOn)) fail(back, "口コミの投稿日を入力してください。");
  if (!userId) fail(back, "ポイントの対象の担当者を選んでください。");
  await mutate((db) => {
    const staff = db.users.find((u) => u.id === userId);
    if (!staff) fail(back, "担当者が見つかりません。");
    const orderRef = str(formData, "orderRef").normalize("NFKC").trim().toUpperCase();
    const order = orderRef ? db.orders.find((o) => o.number.toUpperCase() === orderRef) : undefined;
    if (orderRef && !order) fail(back, `受注番号「${orderRef}」が見つかりません。`);
    const storeId = (str(formData, "storeId") || order?.storeId || staff.storeId) as StoreId;
    if (!db.stores.some((s) => s.id === storeId)) fail(back, "店舗が正しくありません。");
    assertStore(user, storeId, back);
    const rating = numField(formData, "rating");
    const now = nowIso();
    const id = newId("rv");
    const comment = str(formData, "comment");
    const hasPhoto = formData.get("hasPhoto") === "on";
    // 星の評価・コメント・写真で 1 点ずつ (集計表の Google 口コミのルール)。手で入れた点数があればそれを使う
    const auto = (rating >= 1 ? 1 : 0) + (comment || formData.get("hasComment") === "on" ? 1 : 0) + (hasPhoto ? 1 : 0);
    const points = str(formData, "points") !== "" ? Math.max(0, numField(formData, "points")) : Math.max(1, auto);
    db.reviews.push({
      id,
      postedOn,
      storeId,
      userId,
      reviewerName: str(formData, "reviewerName") || undefined,
      rating: rating >= 1 && rating <= 5 ? Math.round(rating) : undefined,
      comment: comment || undefined,
      hasPhoto,
      points,
      orderId: order?.id,
      customerId: order?.customerId,
      note: str(formData, "note") || undefined,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    addAudit(db, { userId: user.id, action: "create", entity: "review", entityId: id, entityLabel: `Google 口コミ ${postedOn}`, summary: `Google 口コミを登録 (${staff.name} / ${points} 点${order ? ` / 受注 ${order.number}` : ""})`, storeId });
  });
  revalidatePath("/kpi");
  redirect(withMsg(back, "Google 口コミを登録しました。月ごとのポイント・支給額に反映されます。"));
}

export async function deleteReview(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/kpi/reviews");
  await mutate((db) => {
    const idx = db.reviews.findIndex((x) => x.id === id);
    if (idx < 0) fail(back, "口コミが見つかりません。");
    const r = db.reviews[idx];
    assertStore(user, r.storeId, back);
    if (!canManageKpi(user) && r.createdBy !== user.id) fail(back, "削除は登録した本人・店長・本部・管理者が行えます。");
    db.reviews.splice(idx, 1);
    addAudit(db, { userId: user.id, action: "delete", entity: "review", entityId: r.id, entityLabel: `Google 口コミ ${r.postedOn}`, summary: `Google 口コミを削除 (${db.users.find((u) => u.id === r.userId)?.name ?? r.userId} / ${r.points} 点)`, storeId: r.storeId });
  });
  revalidatePath("/kpi");
  redirect(withMsg(back, "口コミを削除しました。"));
}

/* ================================================================== */
/* お客様アンケート (画面での入力・修正・削除)                             */
/* ================================================================== */

function surveyFields(formData: FormData) {
  const score = (k: string) => {
    const v = Number(str(formData, k));
    return Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
  };
  return {
    postcardNo: str(formData, "postcardNo"),
    answeredOn: str(formData, "answeredOn"),
    countMonth: str(formData, "countMonth"),
    phoneScore: score("phoneScore"),
    salesScore: score("salesScore"),
    craftsmanScore: score("craftsmanScore"),
    finishScore: score("finishScore"),
    priorityList: formData.getAll("priorityList").map(String).filter((v) => (PRIORITY_OPTIONS as readonly string[]).includes(v)),
    priorityOther: str(formData, "priorityOther"),
    mediaList: formData.getAll("mediaList").map(String).filter((v) => (MEDIA_OPTIONS as readonly string[]).includes(v)),
    mediaOther: str(formData, "mediaOther"),
    wouldUseAgain: str(formData, "wouldUseAgain"),
    comment: str(formData, "comment"),
    salesName: str(formData, "salesName"),
    craftsmanName: str(formData, "craftsmanName"),
  };
}

function staffLinks(formData: FormData, userIds: Set<string>) {
  const pick = (v: string) => (v && userIds.has(v) ? v : undefined);
  return {
    clerkUserId: pick(str(formData, "clerkUserId")),
    salesUserId: pick(str(formData, "salesUserId")),
    deliveryUserIds: [...new Set(formData.getAll("deliveryUserIds").map(String).filter((v) => userIds.has(v)))],
  };
}

/** 手入力でアンケートを登録 (はがきの写真がないとき) */
export async function createSurvey(formData: FormData) {
  const user = await requireActionUser();
  const back = "/kpi/surveys/new";
  await assertTable("survey_responses", back);
  const f = surveyFields(formData);
  if (f.answeredOn && !isDate(f.answeredOn)) fail(back, "回答日の形式が正しくありません。");
  if (f.countMonth && !isMonth(f.countMonth)) fail(back, "集計月の形式が正しくありません (例: 2026-11)。");
  let id = "";
  await mutate((db) => {
    const ref = str(formData, "orderRef").normalize("NFKC").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    const order = ref ? db.orders.find((o) => o.number.toUpperCase() === ref) : findOrderByPostcard(db, f.postcardNo, { storeId: storeFromPostcard(f.postcardNo) ?? ((str(formData, "storeId") || undefined) as StoreId | undefined), date: f.answeredOn || undefined });
    if (ref && !order) fail(back, `受注番号「${ref}」が見つかりません。`);
    const storeId = (order?.storeId ?? (str(formData, "storeId") || storeFromPostcard(f.postcardNo) || user.storeId)) as StoreId;
    assertStore(user, storeId, back);
    const links = staffLinks(formData, new Set(db.users.map((u) => u.id)));
    const r = surveyFromExtracted(db, { extracted: f, order, storeId, ...links, userId: user.id, source: "manual" });
    if ("error" in r) fail(back, r.error);
    if (f.countMonth) r.survey.countMonth = f.countMonth;
    db.surveys.push(r.survey);
    id = r.survey.id;
    if (order) {
      if (!order.postcardNo && r.survey.postcardNo) order.postcardNo = r.survey.postcardNo;
      order.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "note", body: `お客様アンケートを登録 (はがき No.${r.survey.postcardNo ?? "-"})` });
      order.updatedAt = nowIso();
    }
    addAudit(db, { userId: user.id, action: "create", entity: "survey", entityId: id, entityLabel: `はがき No.${r.survey.postcardNo ?? "-"}`, summary: `お客様アンケートを登録 (手入力${order ? ` / 受注 ${order.number}` : ""})`, storeId });
  });
  revalidatePath("/kpi");
  redirect(withMsg(`/kpi/surveys/${id}`, "アンケートを登録しました。"));
}

export async function updateSurvey(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/kpi/surveys/${id}`;
  const f = surveyFields(formData);
  if (f.answeredOn && !isDate(f.answeredOn)) fail(back, "回答日の形式が正しくありません。");
  if (f.countMonth && !isMonth(f.countMonth)) fail(back, "集計月の形式が正しくありません (例: 2026-11)。");
  await mutate((db) => {
    const sv = db.surveys.find((x) => x.id === id);
    if (!sv) fail("/kpi/surveys", "アンケートが見つかりません。");
    assertStore(user, sv.storeId, back);
    if (!canManageKpi(user) && sv.createdBy !== user.id) fail(back, "修正は登録した本人・店長・本部・管理者が行えます。");
    const ref = str(formData, "orderRef").normalize("NFKC").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    const order = ref ? db.orders.find((o) => o.number.toUpperCase() === ref) : undefined;
    if (ref && !order) fail(back, `受注番号「${ref}」が見つかりません。`);
    if (order) assertStore(user, order.storeId, back);
    const postcardNo = normPostcardNo(f.postcardNo) || undefined;
    if (postcardNo && findSurveyByPostcard(db, postcardNo, { exceptId: sv.id, storeId: order?.storeId ?? sv.storeId, date: f.answeredOn || sv.answeredOn })) fail(back, `はがき No.${postcardNo} (同じ店舗・1 年以内) は別のアンケートで登録されています。`);
    const links = staffLinks(formData, new Set(db.users.map((u) => u.id)));
    const r = surveyFromExtracted({ surveys: [] }, { extracted: { ...f, postcardNo }, order: order ?? db.orders.find((o) => o.id === sv.orderId), storeId: order?.storeId ?? sv.storeId, ...links, userId: user.id, source: sv.source });
    if ("error" in r) fail(back, r.error);
    // 集計月の欄がないフォーム (古い画面) からの修正では、いまの集計月を残す
    const countMonth = formData.has("countMonth") ? f.countMonth || undefined : sv.countMonth;
    const next: SurveyResponse = { ...r.survey, id: sv.id, receivedAt: sv.receivedAt, countMonth, documentId: sv.documentId, sourceRef: sv.sourceRef, createdBy: sv.createdBy, createdAt: sv.createdAt, updatedAt: nowIso(), orderId: ref ? order?.id : sv.orderId, customerId: ref ? order?.customerId : sv.customerId };
    if (!ref && formData.get("unlinkOrder") === "on") {
      next.orderId = undefined;
      next.customerId = undefined;
    }
    const fields: (keyof SurveyResponse)[] = ["postcardNo", "answeredOn", "countMonth", "phoneScore", "salesScore", "craftsmanScore", "finishScore", "priorities", "media", "wouldUseAgain", "comment", "clerkUserId", "salesUserId", "orderId", "storeId"];
    const changes = fields.filter((k) => JSON.stringify(sv[k] ?? null) !== JSON.stringify(next[k] ?? null)).map((k) => ({ field: k, before: sv[k] ?? null, after: next[k] ?? null }));
    const deliveryChanged = JSON.stringify(sv.deliveryUserIds ?? []) !== JSON.stringify(next.deliveryUserIds ?? []);
    if (!changes.length && !deliveryChanged) fail(back, "変更はありませんでした。");
    Object.assign(sv, next);
    addAudit(db, { userId: user.id, action: "update", entity: "survey", entityId: sv.id, entityLabel: `はがき No.${sv.postcardNo ?? "-"}`, summary: `お客様アンケートを修正 (${[...changes.map((c) => String(c.field)), ...(deliveryChanged ? ["deliveryUserIds"] : [])].join("・")})`, storeId: sv.storeId, changes });
  });
  revalidatePath("/kpi");
  redirect(withMsg(back, "アンケートを修正しました。集計に反映されています。"));
}

export async function deleteSurvey(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/kpi/surveys/${id}`;
  if (!canManageKpi(user)) fail(back, "削除は店長・本部スタッフ・管理者が行えます。");
  await mutate((db) => {
    const idx = db.surveys.findIndex((x) => x.id === id);
    if (idx < 0) fail("/kpi/surveys", "アンケートが見つかりません。");
    const sv = db.surveys[idx];
    assertStore(user, sv.storeId, back);
    db.surveys.splice(idx, 1);
    const doc = sv.documentId ? db.documents.find((d) => d.id === sv.documentId && d.linkedType === "survey") : undefined;
    if (doc) {
      doc.status = "extracted";
      doc.linkedType = undefined;
      doc.linkedId = undefined;
    }
    addAudit(db, { userId: user.id, action: "delete", entity: "survey", entityId: sv.id, entityLabel: `はがき No.${sv.postcardNo ?? "-"}`, summary: `お客様アンケートを削除 (${str(formData, "reason") || "理由未記入"})`, storeId: sv.storeId });
  });
  revalidatePath("/kpi");
  redirect(withMsg("/kpi/surveys", "アンケートを削除しました。"));
}

/** ⑧ 自由記述の分類を付け直す (移行データ・手入力のアンケートに、簡易ルールで分類を付ける) */
export async function retagSurveyComments() {
  const user = await requireActionUser();
  const back = "/kpi/voice";
  if (!canManageKpi(user)) fail(back, "店長・本部スタッフ・管理者が実行できます。");
  let n = 0;
  await mutate((db) => {
    for (const sv of db.surveys) {
      if (!sv.comment || (sv.commentTags && sv.commentTags.length)) continue;
      if (!canAccessStore(user, sv.storeId)) continue;
      const t = tagComment(sv.comment);
      sv.commentTags = t.tags;
      sv.commentTone = sv.commentTone ?? t.tone;
      n++;
    }
    if (n) addAudit(db, { userId: user.id, action: "update", entity: "survey", entityId: "bulk", entityLabel: "お客様の声", summary: `自由記述の分類を付けました (${n} 件)` });
  });
  revalidatePath(back);
  redirect(withMsg(back, n ? `${n} 件に分類を付けました。` : "分類が必要な記述はありませんでした。"));
}

/** お客様の声 (⑧) を AI で分析し、結果を保存する (AI の API キーがないときは集計のみ) */
export async function analyzeCustomerVoices(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/kpi/voice");
  if (!canManageKpi(user)) fail(back, "店長・本部スタッフ・管理者が実行できます。");
  const db = getDb();
  const from = str(formData, "from");
  const store = str(formData, "store");
  const list = db.surveys
    .filter((s) => s.comment && canAccessStore(user, s.storeId) && (!store || s.storeId === store) && (!from || (s.answeredOn ?? s.receivedAt.slice(0, 10)) >= from))
    .sort((a, b) => (b.answeredOn ?? b.receivedAt).localeCompare(a.answeredOn ?? a.receivedAt))
    .slice(0, 300);
  if (!list.length) fail(back, "分析できる自由記述がありません。");
  const result = await analyzeVoices(list.map((s) => ({ id: s.id, text: s.comment!, store: db.stores.find((x) => x.id === s.storeId)?.shortName ?? "", scores: [s.phoneScore, s.salesScore, s.craftsmanScore, s.finishScore] })));
  if (!result.ok) fail(back, result.message);
  await mutate((d) => {
    const key = `voice_${store || "all"}`;
    const value = { ...result.data, count: list.length, from: from || null, store: store || null, provider: result.provider, model: result.model };
    const row = d.settings.find((s) => s.id === key);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: nowIso() });
    else d.settings.push({ id: key, value, updatedBy: user.id, updatedAt: nowIso() });
    addAudit(d, { userId: user.id, action: "update", entity: "survey", entityId: key, entityLabel: "お客様の声", summary: `お客様の声を AI で分析 (${list.length} 件)` });
  });
  revalidatePath(back);
  redirect(withMsg(back, `お客様の声 ${list.length} 件を分析しました。`));
}

/* ================================================================== */
/* KPI・インセンティブの設定                                              */
/* ================================================================== */

export async function updateKpiSettings(formData: FormData) {
  const user = await requireActionUser();
  const back = "/settings?tab=kpi";
  if (!canManageSettings(user)) fail(back, "この操作は管理者のみ実行できます。");
  await assertTable("settings", back);
  const tierField = (key: string, label: string) => {
    const t = parseTiers(str(formData, key));
    if (!t) fail(back, `「${label}」の形が正しくありません。「しきい値:金額」をカンマで区切って入力してください (例: 60:70000, 50:30000)。`);
    return t;
  };
  const amountList = (key: string, label: string) => {
    const v = str(formData, key).normalize("NFKC").split(/[,、\s]+/).filter(Boolean).map(Number);
    if (!v.length || v.some((x) => !Number.isFinite(x))) fail(back, `「${label}」は金額をカンマで区切って入力してください (例: 15000, 10000, 5000)。`);
    return v;
  };
  const incentive = {
    replyRate: tierField("t_replyRate", "はがき返信率"),
    replyGate: numField(formData, "replyGate"),
    phone: tierField("t_phone", "① 電話対応"),
    score: tierField("t_score", "②③④ の評価"),
    storeQuality: tierField("t_storeQuality", "店舗のクレーム・手直し率"),
    officeQuality: tierField("t_officeQuality", "事務のクレーム・手直し率"),
    mvp: {
      sales: amountList("m_sales", "② 営業対応 MVP"),
      craftsman: amountList("m_craftsman", "③ 職人対応 MVP"),
      replyTop: numField(formData, "m_replyTop"),
      finishTop: numField(formData, "m_finishTop"),
      reviews: amountList("m_reviews", "口コミ件数 MVP"),
      fewestQuality: numField(formData, "m_fewestQuality"),
      lowestQualityRate: numField(formData, "m_lowestQualityRate"),
    },
  };
  await mutate((db) => {
    const cur = kpiSettings(db);
    const userIds = new Set(db.users.map((u) => u.id));
    const clerkByStore: Record<string, string> = {};
    for (const s of db.stores) {
      const v = str(formData, `clerk_${s.id}`);
      if (v && userIds.has(v)) clerkByStore[s.id] = v;
    }
    const value = {
      clerkUserIds: [...new Set(formData.getAll("clerkUserIds").map(String).filter((v) => userIds.has(v)))],
      excludedUserIds: [...new Set(formData.getAll("excludedUserIds").map(String).filter((v) => userIds.has(v)))],
      clerkByStore,
      qualityPoints: { rework: numField(formData, "qp_rework"), claim: numField(formData, "qp_claim"), claim_rework: numField(formData, "qp_claim_rework") },
      reviewYenPerPoint: numField(formData, "reviewYenPerPoint"),
      fiscalStartMonth: numField(formData, "fiscalStartMonth") || cur.fiscalStartMonth,
      incentive,
    };
    const row = db.settings.find((s) => s.id === KPI_SETTINGS_ID);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: nowIso() });
    else db.settings.push({ id: KPI_SETTINGS_ID, value, updatedBy: user.id, updatedAt: nowIso() });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: KPI_SETTINGS_ID, entityLabel: "KPI・インセンティブ", summary: "KPI・インセンティブの設定を更新" });
  });
  revalidatePath("/settings");
  revalidatePath("/kpi");
  redirect(withMsg(back, "KPI・インセンティブの設定を保存しました。"));
}

/** 年間インセンティブの調整額 (年度の途中で店舗を移った社員の月割りなど)。管理者のみ */
export async function saveIncentiveAdjustments(fy: number, formData: FormData) {
  const user = await requireActionUser();
  const back = `/kpi/incentives?fy=${fy}`;
  if (!canManageSettings(user)) fail(back, "調整額の入力は管理者のみ行えます。");
  await assertTable("settings", back);
  await mutate((db) => {
    const adjust: Record<string, { amount: number; note?: string }> = {};
    for (const u of db.users) {
      const raw = str(formData, `adj_${u.id}`).normalize("NFKC").replace(/[,円\s]/g, "");
      const note = str(formData, `note_${u.id}`);
      if (!raw && !note) continue;
      const amount = Number(raw || 0);
      if (!Number.isFinite(amount)) fail(back, `${u.name} の調整額が数値ではありません。`);
      adjust[u.id] = { amount: Math.round(amount), note: note || undefined };
    }
    const id = `incentive_${fy}`;
    const row = db.settings.find((s) => s.id === id);
    const value = { adjust };
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: nowIso() });
    else db.settings.push({ id, value, updatedBy: user.id, updatedAt: nowIso() });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: id, entityLabel: `${fy}年度 インセンティブ`, summary: `インセンティブの調整額を保存 (${Object.keys(adjust).length} 人)` });
  });
  revalidatePath("/kpi/incentives");
  redirect(withMsg(back, "調整額を保存しました。"));
}
