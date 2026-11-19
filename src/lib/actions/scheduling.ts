"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { CommLog, Database, JobItem, JobSpec, PlanSlot, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { canAccessStore, canAckHold, canEditStaffProfile, canManageScheduling, canPlanSchedule, canRunScheduleBacktest } from "@/lib/auth/permissions";
import { isDateKey, normTime, shortDate } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import { sendAndRecord, deliverySummary, type Outgoing } from "@/lib/notify/send";
import { scheduleHoldNotices } from "@/lib/notify/events";
import { isEmail } from "@/lib/notify/channels";
import { MASTER_IDS, PROCESS_KEYS, RESOURCE_TYPES, WEIGHT_LABEL, readStaffProfiles, readWeights, type Weights } from "@/lib/scheduling/masters";
import { planTablesMissing } from "@/lib/scheduling/tables";
import { ackHold, confirmHold, createHolds, expireHolds, holdConflicts, offerText, releaseHold, type HoldBase } from "@/lib/scheduling/holds";
import type { Candidate } from "@/lib/scheduling/engine";
import { optimizePlan, waitingJobs, type OptimizeJob, type OptimizeResult } from "@/lib/scheduling/optimize";
import { createPlanContext } from "@/lib/scheduling/context";
import { storeDayRoutes, type DayRoute } from "@/lib/scheduling/route";
import { pullForwardInto, type PullForwardOption } from "@/lib/scheduling/replan";
import { runBacktest, type BacktestResult } from "@/lib/scheduling/backtest";
import { buildProductionJob } from "@/lib/scheduling/production";
import { prefetchForStore } from "@/lib/scheduling/prefetch";
import { specId } from "@/lib/scheduling/spec";
import { offerLink } from "@/lib/scheduling/offer-link";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 予定の計画の業務ロジック (仮押さえ・確定・お客様への案内・作業の内容・マスタ・全体の最適化・巡回順・検証・製造の予定)
 * 計算は src/lib/scheduling/。書き込みは必ず mutate の中で行い、変更履歴を残す
 */

const BASE = "/schedule/planning";

function done(back: string, msg: string): never {
  revalidatePath("/schedule", "layout");
  redirect(withMsg(back, msg));
}

async function ready(back: string) {
  const missing = await planTablesMissing();
  if (missing) fail(back, missing);
}

function saveSetting(db: Database, user: User, id: string, value: Record<string, unknown>, label: string) {
  const now = nowIso();
  const row = db.settings.find((s) => s.id === id);
  const before = row ? JSON.stringify(row.value) : "";
  if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
  else db.settings.push({ id, value, updatedBy: user.id, updatedAt: now });
  addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: id, entityLabel: label, summary: before === JSON.stringify(value) ? `${label}を保存 (変更なし)` : `${label}を変更`, changes: before === JSON.stringify(value) ? [] : [{ field: "value", before: before.slice(0, 400) || "(初期値)", after: JSON.stringify(value).slice(0, 400) }] });
}

const nums = (v: string, min: number, max: number): number | undefined => {
  if (!v) return undefined;
  const n = Number(v.normalize("NFKC").replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const list = (fd: FormData, key: string, max = 30) => [...new Set(fd.getAll(key).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
const csv = (v: string, max = 20) => [...new Set(v.normalize("NFKC").split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean))].slice(0, max);
const idOk = (v: string) => /^[a-z0-9_-]{1,40}$/i.test(v);

/* ================================================================== */
/* 仮押さえ                                                              */
/* ================================================================== */

export interface HoldRequest {
  base: { storeId: string; kind: string; title?: string; customerId?: string; inquiryId?: string; quoteId?: string; orderId?: string; location?: string; memo?: string; chainId?: string };
  candidates: Candidate[];
  notify?: boolean;
}

/** 候補を仮押さえする (第 1〜3 候補)。担当者に確認の依頼を送る */
export async function holdCandidatesAction(q: HoldRequest): Promise<{ ok: boolean; message: string; groupId?: string }> {
  const user = await requireActionUser();
  const missing = await planTablesMissing();
  if (missing) return { ok: false, message: missing };
  const db = getDb();
  const storeId = q?.base?.storeId as StoreId;
  if (!db.stores.some((s) => s.id === storeId) || !canPlanSchedule(user, storeId)) return { ok: false, message: "この店舗の予定を仮押さえする権限がありません。" };
  const kind = q.base.kind as ScheduleKind;
  if (!SUGGEST_KINDS.includes(kind)) return { ok: false, message: "仮押さえできる予定の種類ではありません。" };
  const users = new Set(db.users.filter((u) => u.active).map((u) => u.id));
  const resources = new Set(readResourcesIds(db));
  const clean = (Array.isArray(q.candidates) ? q.candidates : [])
    .slice(0, 3)
    .filter((c) => isDateKey(c?.date) && c.date >= toDateKey(new Date()))
    .map((c): Candidate => ({
      date: c.date,
      endDate: isDateKey(c.endDate) ? c.endDate : undefined,
      slot: c.slot === "am" || c.slot === "pm" || c.slot === "day" ? c.slot : undefined,
      startTime: normTime(c.startTime),
      endTime: c.startTime ? normTime(c.endTime) : undefined,
      assigneeIds: (Array.isArray(c.assigneeIds) ? c.assigneeIds : []).filter((id) => users.has(id)).slice(0, 6),
      resourceIds: (Array.isArray(c.resourceIds) ? c.resourceIds : []).filter((id) => resources.has(id)).slice(0, 4),
      score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
      reasons: (Array.isArray(c.reasons) ? c.reasons : []).map((x) => String(x).slice(0, 200)).slice(0, 8),
      warnings: (Array.isArray(c.warnings) ? c.warnings : []).map((x) => String(x).slice(0, 200)).slice(0, 8),
    }));
  if (!clean.length) return { ok: false, message: "仮押さえする候補がありません。" };
  const visible = <T extends { storeId: StoreId }>(x: T | undefined) => (x && canAccessStore(user, x.storeId) ? x : undefined);
  const order = visible(q.base.orderId ? db.orders.find((o) => o.id === q.base.orderId) : undefined);
  const quote = visible(q.base.quoteId ? db.quotes.find((x) => x.id === q.base.quoteId) : undefined);
  const inquiry = visible(q.base.inquiryId ? db.inquiries.find((x) => x.id === q.base.inquiryId) : undefined);
  const customer = visible(q.base.customerId ? db.customers.find((c) => c.id === q.base.customerId) : undefined);
  const base: HoldBase = {
    storeId,
    kind,
    title: (q.base.title?.trim() || `${SCHEDULE_KIND[kind].label}${customer ? ` ${customer.name}様` : ""}`).slice(0, 80),
    orderId: order?.id,
    quoteId: quote?.id ?? order?.quoteId,
    inquiryId: inquiry?.id,
    customerId: customer?.id ?? order?.customerId ?? quote?.customerId ?? inquiry?.customerId,
    location: q.base.location?.slice(0, 200),
    memo: q.base.memo?.slice(0, 1000),
    chainId: q.base.chainId?.slice(0, 40),
  };
  let groupId = "";
  let holds: ReturnType<typeof createHolds> = [];
  let replaced = 0;
  await mutate((db) => {
    expireHolds(db);
    // 同じ案件・同じ種類の前の仮押さえは解除して押さえ直す (候補が二重に押さえられないように)
    if (base.orderId || base.quoteId || base.inquiryId) {
      const t = nowIso();
      for (const h of db.scheduleHolds) {
        if (h.status !== "held" || h.kind !== base.kind) continue;
        const same = (base.orderId && h.orderId === base.orderId) || (!base.orderId && base.quoteId && h.quoteId === base.quoteId) || (!base.orderId && !base.quoteId && base.inquiryId && h.inquiryId === base.inquiryId);
        if (!same) continue;
        Object.assign(h, { status: "released", updatedBy: user.id, updatedAt: t });
        replaced++;
      }
    }
    holds = createHolds(db, user, base, clean);
    groupId = holds[0]?.groupId ?? "";
    addAudit(db, { userId: user.id, action: "create", entity: "schedule_hold", entityId: groupId, entityLabel: base.title, summary: `予定を仮押さえ (${holds.map((h) => `第 ${h.rank} 候補 ${h.date}`).join("・")})`, storeId });
  });
  let sent = "";
  if (q.notify !== false) {
    const d = await sendAndRecord(scheduleHoldNotices(getDb(), holds, user.id, "request"), user.id);
    if (d.length) sent = ` 担当者への確認の依頼: ${deliverySummary(d)}`;
  }
  // 画面の再読み込みはしない (押したボタンの結果の文を残す。予定表・計画の画面は開くたびに最新を読む)
  return { ok: true, groupId, message: `${holds.length} 件の候補を仮押さえしました (期限 ${shortDate(holds[0].expiresAt.slice(0, 10))})。${replaced ? `同じ案件の前の仮押さえ ${replaced} 件は解除しました。` : ""}予定表 →「計画」の「仮押さえ」で確定します。${sent}` };
}

function readResourcesIds(db: Database): string[] {
  const v = db.settings.find((s) => s.id === MASTER_IDS.resources)?.value;
  return Array.isArray(v?.items) ? (v.items as { id?: string }[]).map((x) => String(x.id ?? "")).filter(Boolean) : [];
}

export async function confirmHoldForm(holdId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=holds`);
  await ready(back);
  const db0 = getDb();
  const h = db0.scheduleHolds.find((x) => x.id === holdId);
  if (!h) fail(back, "仮押さえが見つかりません。");
  if (!canPlanSchedule(user, h.storeId)) fail(back, "この店舗の予定を確定する権限がありません。");
  const conflicts = holdConflicts(db0, h);
  if (conflicts.length && str(fd, "allowOverlap") !== "on") fail(back, `担当者の予定と重なっています: ${conflicts.slice(0, 3).join("・")}。確かめてから「重なりを承知で確定」にチェックしてください。`);
  let result: ReturnType<typeof confirmHold> = "";
  await mutate((db) => {
    result = confirmHold(db, user, holdId);
    if (typeof result === "string") return;
    addAudit(db, { userId: user.id, action: "create", entity: "schedule", entityId: result.event.id, entityLabel: result.event.title, summary: `仮押さえから予定を確定 (${result.event.date} ${SCHEDULE_KIND[result.event.kind].label}${result.released.length ? ` / ほかの候補 ${result.released.length} 件を解除` : ""}${result.productionJobId ? " / 製造の予定を作成" : ""})`, storeId: result.event.storeId });
  });
  if (typeof result === "string") fail(back, result);
  const r = result as Exclude<ReturnType<typeof confirmHold>, string>;
  done(`/schedule/${r.event.id}`, ["予定を確定しました。", ...r.notes, conflicts.length ? "担当者の予定と重なっているため、予定表で調整してください。" : ""].join(""));
}

export async function releaseHoldForm(holdId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=holds`);
  await ready(back);
  const h = getDb().scheduleHolds.find((x) => x.id === holdId);
  if (!h) fail(back, "仮押さえが見つかりません。");
  if (!canPlanSchedule(user, h.storeId)) fail(back, "この仮押さえを解除する権限がありません。");
  const scope = str(fd, "scope") === "one" ? "one" : "group";
  let n = 0;
  await mutate((db) => {
    n = releaseHold(db, user, holdId, scope).length;
    addAudit(db, { userId: user.id, action: "delete", entity: "schedule_hold", entityId: h.groupId, entityLabel: h.title, summary: `仮押さえを解除 (${n} 件)`, storeId: h.storeId });
  });
  done(back, `仮押さえを ${n} 件解除しました。`);
}

export async function ackHoldForm(holdId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=holds`);
  await ready(back);
  const h = getDb().scheduleHolds.find((x) => x.id === holdId);
  if (!h) fail(back, "仮押さえが見つかりません。");
  if (!canAckHold(user, h)) fail(back, "この仮押さえに返事する権限がありません。");
  const ok = str(fd, "ok") === "yes";
  await mutate((db) => {
    ackHold(db, user, holdId, ok, str(fd, "note"));
    addAudit(db, { userId: user.id, action: "update", entity: "schedule_hold", entityId: h.groupId, entityLabel: h.title, summary: `仮押さえ (第 ${h.rank} 候補 ${h.date}) に「${ok ? "行ける" : "行けない"}」と返事`, storeId: h.storeId });
  });
  done(back, ok ? "「行ける」と返事しました。" : "「行けない」と返事しました。予定を決める人に伝わります。");
}

/** お客様が選んだ候補を記録する (電話で聞いたとき) */
export async function customerChoiceForm(holdId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=holds`);
  await ready(back);
  const h = getDb().scheduleHolds.find((x) => x.id === holdId);
  if (!h || h.status !== "held") fail(back, "仮押さえが見つかりません。");
  if (!canPlanSchedule(user, h.storeId)) fail(back, "この仮押さえを変更する権限がありません。");
  await mutate((db) => {
    const x = db.scheduleHolds.find((y) => y.id === holdId);
    if (!x) return;
    x.customerChoiceAt = nowIso();
    x.customerChoiceNote = str(fd, "note").slice(0, 300) || "お客様が選んだ (担当者が記録)";
    x.updatedBy = user.id;
    x.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "schedule_hold", entityId: x.groupId, entityLabel: x.title, summary: `お客様が第 ${x.rank} 候補 (${x.date}) を選択`, storeId: x.storeId });
  });
  done(back, "お客様の選んだ候補を記録しました。確定するときは「予定にする」を押してください。");
}

/** お客様へ候補を案内する (メール・LINE。リンクから選べる)。copy は文を作るだけ (送らない) */
export async function offerHoldsForm(groupId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=holds`);
  await ready(back);
  const db = getDb();
  const holds = db.scheduleHolds.filter((h) => h.groupId === groupId && h.status === "held").sort((a, b) => a.rank - b.rank);
  if (!holds.length) fail(back, "案内できる仮押さえがありません。");
  if (!canPlanSchedule(user, holds[0].storeId)) fail(back, "この仮押さえを案内する権限がありません。");
  const customer = holds[0].customerId ? db.customers.find((c) => c.id === holds[0].customerId) : undefined;
  if (!customer) fail(back, "お客様がひも付いていないため、案内できません。");
  const channel = str(fd, "channel");
  const link = offerLink(groupId, 7);
  const text = offerText(db, holds, { link });
  const items: Outgoing[] = [];
  if (channel === "email") {
    if (!customer.email || !isEmail(customer.email)) fail(back, "お客様のメールアドレスが登録されていません。");
    items.push({ channel: "email", to: customer.email, toLabel: customer.name, subject: text.subject, body: text.body, purpose: "schedule_offer", relatedType: holds[0].orderId ? "order" : holds[0].inquiryId ? "inquiry" : "customer", relatedId: holds[0].orderId ?? holds[0].inquiryId ?? customer.id });
  } else if (channel === "line") {
    if (!customer.lineId) fail(back, "お客様の LINE が登録されていません。");
    items.push({ channel: "line", to: customer.lineId, toLabel: customer.name, body: `${text.subject}\n\n${text.body}`, purpose: "schedule_offer", relatedType: "customer", relatedId: customer.id });
  } else if (channel !== "phone") fail(back, "案内の方法を選んでください。");
  const deliveries = items.length ? await sendAndRecord(items, user.id) : [];
  const sent = deliveries.some((d) => d.status === "sent");
  await mutate((db) => {
    const t = nowIso();
    for (const h of db.scheduleHolds) if (h.groupId === groupId && h.status === "held") Object.assign(h, { offeredAt: t, offeredVia: channel, updatedBy: user.id, updatedAt: t });
    const log: CommLog = { id: newId("cl"), customerId: customer.id, channel: channel === "email" ? "email" : channel === "line" ? "line" : "phone", direction: "outbound", subject: text.subject, body: channel === "phone" ? `電話で日程の候補を案内: ${holds.map((h) => `第 ${h.rank} 候補 ${h.date}`).join("・")}` : text.body, at: t, userId: user.id, relatedType: holds[0].orderId ? "order" : holds[0].inquiryId ? "inquiry" : undefined, relatedId: holds[0].orderId ?? holds[0].inquiryId, storeId: holds[0].storeId, deliveryId: deliveries[0]?.id };
    db.commLogs.push(log);
    addAudit(db, { userId: user.id, action: "update", entity: "schedule_hold", entityId: groupId, entityLabel: holds[0].title, summary: `お客様に日程の候補を案内 (${channel === "phone" ? "電話" : channel === "email" ? "メール" : "LINE"})`, storeId: holds[0].storeId });
  });
  done(back, channel === "phone" ? "電話で案内したことを記録しました。" : sent ? `お客様に候補を送りました。${deliverySummary(deliveries)}` : `送信できませんでした: ${deliverySummary(deliveries)}`);
}

/* ================================================================== */
/* 作業の内容 (job_specs)                                                */
/* ================================================================== */

export async function saveJobSpecForm(fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), "/schedule");
  await ready(back);
  const db = getDb();
  const recordType = str(fd, "recordType") as JobSpec["recordType"];
  const recordId = str(fd, "recordId");
  const rec =
    recordType === "order" ? db.orders.find((x) => x.id === recordId) : recordType === "quote" ? db.quotes.find((x) => x.id === recordId) : recordType === "inquiry" ? db.inquiries.find((x) => x.id === recordId) : recordType === "event" ? db.schedule.find((x) => x.id === recordId) : undefined;
  if (!rec) fail(back, "作業の内容を登録する記録が見つかりません。");
  if (!canPlanSchedule(user, rec.storeId)) fail(back, "この記録の作業の内容を登録する権限がありません。");
  const items: JobItem[] = [];
  for (let i = 0; i < 12; i++) {
    const wt = str(fd, `it.${i}.workTypeId`);
    const qty = nums(str(fd, `it.${i}.qty`), 0, 999);
    if (wt && qty) items.push({ workTypeId: wt.slice(0, 40), qty: Math.round(qty * 10) / 10 });
  }
  const dates = (key: string) => [...new Set(fd.getAll(key).map(String).flatMap((v) => v.split(/[,\s]+/)).filter((d) => isDateKey(d)))].sort().slice(0, 10);
  const slot = str(fd, "preferredSlot");
  const strength = str(fd, "preferenceStrength");
  const priority = str(fd, "priority");
  const spec: JobSpec = {
    id: specId(recordType, recordId),
    recordType,
    recordId,
    storeId: rec.storeId,
    items,
    minutes: nums(str(fd, "minutes"), 15, 1440),
    staffCount: nums(str(fd, "staffCount"), 1, 6),
    skills: list(fd, "skills"),
    resourceKinds: list(fd, "resourceKinds"),
    productionDays: nums(str(fd, "productionDays"), 0, 60),
    pickupFrom: isDateKey(str(fd, "pickupFrom")) ? str(fd, "pickupFrom") : undefined,
    deadline: isDateKey(str(fd, "deadline")) ? str(fd, "deadline") : undefined,
    preferredDates: dates("preferredDates"),
    preferredWeekdays: list(fd, "preferredWeekdays").map(Number).filter((n) => n >= 0 && n <= 6),
    preferredSlot: (["am", "pm", "day"] as PlanSlot[]).find((s) => s === slot),
    preferredTime: normTime(str(fd, "preferredTime")),
    avoidDates: dates("avoidDates"),
    preferenceStrength: strength === "hard" || strength === "soft" ? strength : "none",
    priority: priority === "urgent" || priority === "high" || priority === "low" ? priority : "normal",
    note: str(fd, "note").slice(0, 500) || undefined,
    updatedBy: user.id,
    updatedAt: nowIso(),
  };
  const remove = str(fd, "remove") === "on";
  await mutate((db) => {
    const i = db.jobSpecs.findIndex((s) => s.id === spec.id);
    const before = i >= 0 ? db.jobSpecs[i] : undefined;
    if (remove) {
      if (i >= 0) db.jobSpecs.splice(i, 1);
    } else if (i >= 0) db.jobSpecs[i] = spec;
    else db.jobSpecs.push(spec);
    addAudit(db, {
      userId: user.id,
      action: remove ? "delete" : before ? "update" : "create",
      entity: "job_spec",
      entityId: spec.id,
      entityLabel: `${recordType} ${"number" in rec ? rec.number : "title" in rec ? rec.title : recordId}`,
      summary: remove ? "作業の内容を削除" : `作業の内容を${before ? "変更" : "登録"} (${items.length} 品目${spec.deadline ? ` / 期限 ${spec.deadline}` : ""}${spec.preferenceStrength !== "none" ? ` / 希望 ${spec.preferenceStrength === "hard" ? "必ず" : "できれば"}` : ""})`,
      storeId: rec.storeId,
      changes: before ? [{ field: "spec", before: JSON.stringify({ ...before, updatedAt: undefined }).slice(0, 400), after: remove ? "削除" : JSON.stringify({ ...spec, updatedAt: undefined }).slice(0, 400) }] : [],
    });
  });
  done(back, remove ? "作業の内容を削除しました。" : "作業の内容を保存しました。次の候補日の提案から使われます。");
}

/* ================================================================== */
/* マスタ                                                                */
/* ================================================================== */

async function masterUser(back: string): Promise<User> {
  const user = await requireActionUser();
  if (!canManageScheduling(user)) fail(back, "計画のマスタの変更は管理者が行います。");
  return user;
}

export async function saveWorkTypesForm(fd: FormData) {
  const back = `/schedule/capacity?tab=work`;
  const user = await masterUser(back);
  const items: Record<string, unknown>[] = [];
  const kinds: ScheduleKind[] = ["survey", "measure", "pickup", "delivery", "install"];
  for (let i = 0; i < 40; i++) {
    const name = str(fd, `wt.${i}.name`);
    if (!name) continue;
    const id = str(fd, `wt.${i}.id`) || `wt_${newId("x").slice(-8)}`;
    if (!idOk(id)) fail(back, `作業種別の ID「${id}」は英数字で入力してください。`);
    const site: Record<string, [number, number]> = {};
    for (const k of kinds) {
      const b = nums(str(fd, `wt.${i}.site.${k}.base`), 0, 1440);
      const p = nums(str(fd, `wt.${i}.site.${k}.per`), 0, 600);
      if (b !== undefined || p !== undefined) site[k] = [b ?? 0, p ?? 0];
    }
    const processes = [0, 1]
      .map((j) => ({ processKey: str(fd, `wt.${i}.proc.${j}.key`), minutesPerUnit: nums(str(fd, `wt.${i}.proc.${j}.min`), 0, 1440) ?? 0 }))
      .filter((p) => p.processKey && p.minutesPerUnit > 0);
    const materials = [0, 1, 2]
      .map((j) => ({ materialId: str(fd, `wt.${i}.mat.${j}.id`), qtyPerUnit: nums(str(fd, `wt.${i}.mat.${j}.qty`), 0, 10000) ?? 0 }))
      .filter((m) => m.materialId && m.qtyPerUnit > 0);
    items.push({
      id,
      name: name.slice(0, 40),
      category: str(fd, `wt.${i}.category`) || "other",
      unit: str(fd, `wt.${i}.unit`).slice(0, 8) || "枚",
      keywords: csv(str(fd, `wt.${i}.keywords`)),
      site,
      staffCount: nums(str(fd, `wt.${i}.staffCount`), 1, 6) ?? 1,
      skills: list(fd, `wt.${i}.skills`),
      resourceKinds: list(fd, `wt.${i}.resourceKinds`),
      processes,
      leadDays: nums(str(fd, `wt.${i}.leadDays`), 0, 60) ?? 0,
      materials,
      provisional: str(fd, `wt.${i}.provisional`) === "on",
      active: str(fd, `wt.${i}.active`) === "on",
      sort: i * 10,
    });
  }
  if (!items.length) fail(back, "作業種別を 1 つ以上入力してください。");
  await mutate((db) => saveSetting(db, user, MASTER_IDS.workTypes, { items }, "作業種別 (標準工数・製造の工程)"));
  done(back, "作業種別を保存しました。");
}

export async function saveSkillsForm(fd: FormData) {
  const back = `/schedule/capacity?tab=staff`;
  const user = await masterUser(back);
  const items: { id: string; name: string }[] = [];
  for (let i = 0; i < 30; i++) {
    const name = str(fd, `sk.${i}.name`);
    if (!name) continue;
    const id = str(fd, `sk.${i}.id`) || `sk_${newId("x").slice(-8)}`;
    if (!idOk(id)) fail(back, `技能の ID「${id}」は英数字で入力してください。`);
    items.push({ id, name: name.slice(0, 40) });
  }
  await mutate((db) => saveSetting(db, user, MASTER_IDS.skills, { items }, "技能の一覧"));
  done(back, "技能の一覧を保存しました。");
}

export async function saveProcessesForm(fd: FormData) {
  const back = `/schedule/capacity?tab=production`;
  const user = await masterUser(back);
  const db0 = getDb();
  const storeIds = new Set(db0.stores.map((s) => s.id));
  const keys = new Set(PROCESS_KEYS.map((p) => p.key));
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    const key = str(fd, `pr.${i}.key`);
    const storeId = str(fd, `pr.${i}.storeId`) as StoreId;
    if (!key || !storeId) continue;
    if (!storeIds.has(storeId)) fail(back, "作業場の店舗を選んでください。");
    if (!keys.has(key) && !idOk(key)) fail(back, `工程の種類「${key}」は英数字で入力してください。`);
    items.push({
      id: str(fd, `pr.${i}.id`) || `${storeId}_${key}`,
      key,
      name: str(fd, `pr.${i}.name`).slice(0, 40) || PROCESS_KEYS.find((p) => p.key === key)?.name || key,
      storeId,
      servesStores: list(fd, `pr.${i}.servesStores`).filter((s) => storeIds.has(s as StoreId)),
      minutesPerDay: nums(str(fd, `pr.${i}.hoursPerDay`), 0, 200) !== undefined ? Math.round(nums(str(fd, `pr.${i}.hoursPerDay`), 0, 200)! * 60) : undefined,
      workdays: list(fd, `pr.${i}.workdays`).map(Number).filter((n) => n >= 0 && n <= 6),
      staffIds: list(fd, `pr.${i}.staffIds`),
      provisional: str(fd, `pr.${i}.provisional`) === "on",
      active: str(fd, `pr.${i}.active`) === "on",
    });
  }
  await mutate((db) => saveSetting(db, user, MASTER_IDS.processes, { items }, "製造の工程 (作業場の 1 日の能力)"));
  done(back, "製造の工程を保存しました。");
}

export async function saveResourcesForm(fd: FormData) {
  const back = `/schedule/capacity?tab=resources`;
  const user = await masterUser(back);
  const db0 = getDb();
  const storeIds = new Set(db0.stores.map((s) => s.id));
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < 60; i++) {
    const name = str(fd, `rs.${i}.name`);
    if (!name) continue;
    const storeId = str(fd, `rs.${i}.storeId`) as StoreId;
    if (!storeIds.has(storeId)) fail(back, `「${name}」の店舗を選んでください。`);
    const type = str(fd, `rs.${i}.type`) || "car";
    items.push({
      id: str(fd, `rs.${i}.id`) || `rs_${newId("x").slice(-8)}`,
      name: name.slice(0, 60),
      kind: RESOURCE_TYPES.find((t) => t.type === type)?.kind ?? (str(fd, `rs.${i}.kind`) || "vehicle"),
      type,
      storeId,
      capacityUnits: nums(str(fd, `rs.${i}.capacityUnits`), 1, 10000),
      license: str(fd, `rs.${i}.license`).slice(0, 40) || undefined,
      active: str(fd, `rs.${i}.active`) === "on",
      note: str(fd, `rs.${i}.note`).slice(0, 200) || undefined,
    });
  }
  await mutate((db) => saveSetting(db, user, MASTER_IDS.resources, { items }, "車両・設備・工具"));
  done(back, "車両・設備を保存しました。");
}

export async function saveStaffProfileForm(userId: string, fd: FormData) {
  const back = safeReturn(str(fd, "back"), `/schedule/capacity?tab=staff`);
  const user = await requireActionUser();
  const db0 = getDb();
  const target = db0.users.find((u) => u.id === userId);
  if (!target) fail(back, "社員が見つかりません。");
  if (!canEditStaffProfile(user, target)) fail(back, "この社員の勤務と技能を変更する権限がありません (管理者・その店舗の店長)。");
  const skills: Record<string, number> = {};
  for (const [k, v] of fd.entries()) {
    const m = k.match(/^skill\.(.+)$/);
    const n = Number(v);
    if (m && n >= 1 && n <= 3) skills[m[1]] = Math.round(n);
  }
  const hours = (k: string, max: number) => {
    const n = nums(str(fd, k), 0, max);
    return n === undefined ? undefined : Math.round(n * 60);
  };
  const profile = {
    skills,
    workDays: list(fd, "workDays").map(Number).filter((n) => n >= 0 && n <= 6),
    workStart: normTime(str(fd, "workStart")),
    workEnd: normTime(str(fd, "workEnd")),
    breakMinutes: nums(str(fd, "breakMinutes"), 0, 180) ?? 60,
    maxMinutesPerDay: hours("maxHoursPerDay", 16) ?? 480,
    maxEventsPerDay: nums(str(fd, "maxEventsPerDay"), 1, 20),
    maxConsecutiveDays: nums(str(fd, "maxConsecutiveDays"), 1, 14) ?? 6,
    overtimeCapMonthly: hours("overtimeCapHours", 160) ?? 2700,
    canDrive: str(fd, "canDrive") === "on",
    fieldWork: str(fd, "fieldWork") === "on",
    production: str(fd, "production") === "on",
    supportStores: list(fd, "supportStores"),
    needsCompanion: str(fd, "needsCompanion") === "on",
    mentorIds: list(fd, "mentorIds").filter((id) => id !== userId),
    note: str(fd, "note").slice(0, 200) || undefined,
    updatedAt: nowIso(),
  };
  const remove = str(fd, "remove") === "on";
  await mutate((db) => {
    const row = db.settings.find((s) => s.id === MASTER_IDS.staff);
    const profiles = { ...((row?.value.profiles as Record<string, unknown>) ?? {}) };
    if (remove) delete profiles[userId];
    else profiles[userId] = profile;
    saveSetting(db, user, MASTER_IDS.staff, { profiles }, `社員の勤務と技能 (${target.name})`);
  });
  done(back, remove ? `${target.name}の設定を消しました (肩書きからの推定に戻ります)。` : `${target.name}の勤務と技能を保存しました。`);
}

export async function saveRoutingForm(fd: FormData) {
  const back = `/schedule/capacity?tab=routing`;
  const user = await masterUser(back);
  const db0 = getDb();
  const cur = db0.settings.find((s) => s.id === MASTER_IDS.routing)?.value as Record<string, unknown> | undefined;
  const approved = str(fd, "approved") === "on";
  const curPolicy = (cur?.policy ?? {}) as Record<string, unknown>;
  const provider = str(fd, "provider") === "google" ? "google" : "local";
  if (provider === "google" && !approved) fail(back, "Google の経路を使うには、お客様の位置を社外に送ることの社内の承認にチェックしてください。");
  const value = {
    provider,
    policy: approved ? { approved: true, by: curPolicy.approved ? curPolicy.by : user.name, at: curPolicy.approved ? curPolicy.at : nowIso(), note: str(fd, "policyNote").slice(0, 300) || undefined } : { approved: false },
    precision: str(fd, "precision") === "exact" ? "exact" : "area",
    monthlyElementLimit: nums(str(fd, "monthlyElementLimit"), 0, 1_000_000) ?? 20000,
    trafficAware: str(fd, "trafficAware") === "on",
    rushFactor: nums(str(fd, "rushFactor"), 1, 2) ?? 1.25,
  };
  await mutate((db) => saveSetting(db, user, MASTER_IDS.routing, value, "経路 (移動時間の求め方)"));
  done(back, provider === "google" ? "経路の設定を保存しました。GOOGLE_MAPS_API_KEY があれば、次の提案から Google の経路を使います。" : "経路の設定を保存しました (社内の計算)。");
}

export async function saveWeightsForm(fd: FormData) {
  const back = `/schedule/capacity?tab=weights`;
  const user = await masterUser(back);
  const value: Record<string, unknown> = {};
  for (const k of Object.keys(WEIGHT_LABEL) as (keyof Weights)[]) {
    const n = nums(str(fd, k), 0, 100);
    if (n !== undefined) value[k] = Math.round(n * 10) / 1000;
  }
  const focus = str(fd, "focus");
  value.focus = ["balanced", "travel", "speed", "deadline", "revenue"].includes(focus) ? focus : "balanced";
  const cur = readWeights(getDb());
  if (cur.tunedAt) Object.assign(value, { tunedAt: cur.tunedAt, tunedBy: cur.tunedBy, tuneNote: cur.tuneNote });
  await mutate((db) => saveSetting(db, user, MASTER_IDS.weights, value, "最適化の重み"));
  done(back, "最適化の重みを保存しました。");
}

export async function applyTunedWeightsForm(fd: FormData) {
  const back = `/schedule/capacity?tab=backtest`;
  const user = await masterUser(back);
  let w: Record<string, unknown>;
  try {
    w = JSON.parse(str(fd, "weights")) as Record<string, unknown>;
  } catch {
    fail(back, "重みを読み取れませんでした。");
  }
  const cur = readWeights(getDb());
  const value: Record<string, unknown> = { focus: cur.focus, tunedAt: nowIso(), tunedBy: user.name, tuneNote: str(fd, "note").slice(0, 400) };
  for (const k of Object.keys(WEIGHT_LABEL) as (keyof Weights)[]) {
    const n = Number(w[k]);
    value[k] = Number.isFinite(n) && n >= 0 && n <= 1 ? n : cur[k];
  }
  await mutate((db) => saveSetting(db, user, MASTER_IDS.weights, value, "最適化の重み (検証から適用)"));
  done(back, "検証で見つけた重みを適用しました。");
}

export async function saveRulesForm(fd: FormData) {
  const back = `/schedule/capacity?tab=rules`;
  const user = await masterUser(back);
  const value = {
    productionStartsNextDay: str(fd, "productionStartsNextDay") === "on",
    deliveryGapDays: nums(str(fd, "deliveryGapDays"), 0, 14) ?? 0,
    holdDays: nums(str(fd, "holdDays"), 1, 30) ?? 3,
    standardTurnaroundDays: nums(str(fd, "standardTurnaroundDays"), 0, 30) ?? 2,
    urgentWithinDays: nums(str(fd, "urgentWithinDays"), 0, 30) ?? 3,
    preferenceToleranceDays: nums(str(fd, "preferenceToleranceDays"), 0, 60) ?? 7,
  };
  await mutate((db) => saveSetting(db, user, MASTER_IDS.rules, value, "計画の基準 (製造・仮押さえ・希望・緊急)"));
  done(back, "計画の基準を保存しました。");
}

/* ================================================================== */
/* 全体の最適化・巡回順・空いた枠                                             */
/* ================================================================== */

export interface OptimizeQuery {
  storeIds: string[];
  from?: string;
  to?: string;
  mode: "keep" | "rearrange";
  jobKeys: string[];
  maxMoves?: number;
}

export async function optimizeScheduleAction(q: OptimizeQuery): Promise<OptimizeResult | { error: string }> {
  const user = await requireActionUser();
  const db = getDb();
  const storeIds = (Array.isArray(q?.storeIds) ? q.storeIds : []).filter((s) => db.stores.some((x) => x.id === s) && canPlanSchedule(user, s as StoreId)) as StoreId[];
  if (!storeIds.length) return { error: "店舗を選んでください。" };
  const keys = new Set((Array.isArray(q.jobKeys) ? q.jobKeys : []).map(String).slice(0, 40));
  const jobs: OptimizeJob[] = waitingJobs(db, user, { storeIds, limit: 200 }).filter((j) => keys.has(j.key));
  if (!jobs.length && q.mode === "keep") return { error: "配置する案件を選んでください。" };
  for (const s of storeIds) await prefetchForStore(db, user, { storeId: s, from: q.from, days: 30 }).catch(() => {});
  return optimizePlan(db, user, { jobs, mode: q.mode === "rearrange" ? "rearrange" : "keep", storeIds, from: isDateKey(q.from) ? q.from : undefined, to: isDateKey(q.to) ? q.to : undefined, maxMoves: typeof q.maxMoves === "number" ? q.maxMoves : 5 });
}

export async function dayRoutesAction(q: { storeId: string; date: string }): Promise<DayRoute[]> {
  const user = await requireActionUser();
  const db = getDb();
  if (!db.stores.some((s) => s.id === q?.storeId) || !isDateKey(q.date)) return [];
  await prefetchForStore(db, user, { storeId: q.storeId as StoreId, dayOnly: q.date }).catch(() => {});
  const ctx = createPlanContext(db, user, { from: q.date, to: q.date });
  return storeDayRoutes(ctx, q.storeId as StoreId, q.date);
}

export async function pullForwardAction(q: { storeId: string; date: string }): Promise<PullForwardOption[]> {
  const user = await requireActionUser();
  const db = getDb();
  if (!db.stores.some((s) => s.id === q?.storeId) || !isDateKey(q.date) || !canPlanSchedule(user, q.storeId as StoreId)) return [];
  return pullForwardInto(db, user, { storeId: q.storeId as StoreId, date: q.date });
}

/* ================================================================== */
/* 検証                                                                  */
/* ================================================================== */

export async function runBacktestAction(q: { months?: number; storeIds?: string[]; maxSamples?: number; tune?: boolean }): Promise<BacktestResult | { error: string }> {
  const user = await requireActionUser();
  if (!canRunScheduleBacktest(user)) return { error: "提案の検証は管理者・本部が行います。" };
  const db = getDb();
  const storeIds = (Array.isArray(q?.storeIds) ? q.storeIds : []).filter((s) => db.stores.some((x) => x.id === s)) as StoreId[];
  const r = runBacktest(db, user, { months: q?.months, storeIds, maxSamples: q?.maxSamples, tune: q?.tune !== false });
  await mutate((db) => {
    const value = { ranAt: r.ranAt, by: user.name, from: r.from, to: r.to, storeIds: r.storeIds, metrics: r.metrics, tuned: r.tuned, notes: r.notes, ms: r.ms } as unknown as Record<string, unknown>;
    const row = db.settings.find((s) => s.id === "scheduling_backtest");
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: nowIso() });
    else db.settings.push({ id: "scheduling_backtest", value, updatedBy: user.id, updatedAt: nowIso() });
  }).catch(() => {});
  return { ...r, samples: r.samples.slice(0, 120) };
}

/* ================================================================== */
/* 製造の予定                                                            */
/* ================================================================== */

export async function createProductionJobForm(eventId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=production`);
  await ready(back);
  const ev = getDb().schedule.find((e) => e.id === eventId);
  if (!ev) fail(back, "引き取りの予定が見つかりません。");
  if (!canPlanSchedule(user, ev.storeId)) fail(back, "この予定の製造の予定を作る権限がありません。");
  if ((getDb().productionJobs ?? []).some((j) => j.pickupEventId === eventId && j.status !== "cancelled")) fail(back, "この引き取りの製造の予定はすでにあります。");
  let msg = "";
  await mutate((db) => {
    const pj = buildProductionJob(db, user, { event: db.schedule.find((e) => e.id === eventId) });
    if (!pj) {
      msg = "製造のある作業 (畳・襖・障子・網戸) が分からないため、製造の予定を作れませんでした。作業の内容を登録してください。";
      return;
    }
    db.productionJobs.push(pj);
    addAudit(db, { userId: user.id, action: "create", entity: "production_job", entityId: pj.id, entityLabel: pj.title, summary: `製造の予定を作成 (${pj.startDate}〜${pj.endDate})`, storeId: pj.storeId });
    msg = `製造の予定を作りました (${shortDate(pj.startDate)}〜${shortDate(pj.endDate)})。${pj.materialCheck && !pj.materialCheck.ok ? "材料の在庫が足りません。" : ""}`;
  });
  done(back, msg);
}

export async function updateProductionJobForm(jobId: string, fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=production`);
  await ready(back);
  const j = getDb().productionJobs.find((x) => x.id === jobId);
  if (!j) fail(back, "製造の予定が見つかりません。");
  if (!canPlanSchedule(user, j.storeId)) fail(back, "この製造の予定を変更する権限がありません。");
  const status = str(fd, "status");
  const step = str(fd, "stepDone");
  await mutate((db) => {
    const x = db.productionJobs.find((y) => y.id === jobId);
    if (!x) return;
    const before = x.status;
    if (step) {
      const [processId, date] = step.split("|");
      for (const s of x.steps) if (s.processId === processId && s.date === date) s.status = "done";
      if (x.steps.every((s) => s.status === "done")) x.status = "done";
      else x.status = "in_progress";
    } else if (["planned", "in_progress", "done", "cancelled"].includes(status)) x.status = status as typeof x.status;
    x.updatedBy = user.id;
    x.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "production_job", entityId: x.id, entityLabel: x.title, summary: step ? `製造の工程を完了 (${step.split("|")[1]})` : `製造の予定の状態を変更 (${before} → ${x.status})`, storeId: x.storeId, changes: [{ field: "status", before, after: x.status }] });
  });
  done(back, "製造の予定を更新しました。");
}

/** 画面を開いたとき: 期限切れの仮押さえを解除する (あるときだけ書く) */
export async function expireHoldsNow(): Promise<number> {
  const db = getDb();
  const iso = new Date().toISOString();
  if (!(db.scheduleHolds ?? []).some((h) => h.status === "held" && h.expiresAt <= iso)) return 0;
  if (await planTablesMissing()) return 0;
  let n = 0;
  await mutate((db) => {
    n = expireHolds(db);
  });
  return n;
}

export async function staffProfilesFor(): Promise<Record<string, unknown>> {
  const user = await requireActionUser();
  const db = getDb();
  const p = readStaffProfiles(db);
  return Object.fromEntries([...p].filter(([id]) => canEditStaffProfile(user, db.users.find((u) => u.id === id) ?? user)));
}
