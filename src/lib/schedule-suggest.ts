import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { isDateKey, shortDate } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import type { GeoPoint } from "@/lib/geo/kumamoto";
import { SUGGEST_KINDS, type EffectiveCapacity } from "@/lib/schedule-capacity";
import { createPlanContext } from "@/lib/scheduling/context";
import { evaluateJob, pickDiverse, type Candidate } from "@/lib/scheduling/engine";
import { buildRequest, type SuggestInput } from "@/lib/scheduling/request";
import type { TravelFn } from "@/lib/geo/routing";
import { PROCESS_KEYS, RESOURCE_TYPES } from "@/lib/scheduling/masters";

/**
 * 予定の候補日の提案 (AI 予定候補日)
 * ------------------------------------------------------------
 * 新しい案件の予定 (現地調査・顧客訪問・採寸・引き取り・納品・施工) を入れる日を、会社全体の生産性が高くなる順に複数提案する。
 * 計算は src/lib/scheduling/ (AI は使わない決定的な計算):
 *  - context.ts: 予定・仮押さえ・車両の予約・製造の予定の索引
 *  - spec.ts: 作業の内容 (作業種別 × 数量・標準工数・人数・技能・車両・製造日数・期限・お客様の希望・優先度)
 *  - engine.ts: 日 × 時間帯の評価 (守ること・比べること)
 *  - masters.ts: 作業種別・製造工程・技能・社員の勤務・車両と設備・経路・重みの設定
 * 距離と移動時間は src/lib/geo/routing.ts (社内の計算。設定と承認があれば Google の経路)
 * 結果の項目名 (assigneeNames・startTime・endTime・travelMin・reasons・warnings・notes) は AI アシスタントの道具が使うので変えない
 */

export type { SuggestSlot } from "@/lib/scheduling/engine";
export type { SuggestInput } from "@/lib/scheduling/request";

export type SuggestCandidate = Candidate;

export interface SuggestResult {
  candidates: SuggestCandidate[];
  notes: string[];
  /** 現場の位置の推定 */
  site?: { label: string; precision: GeoPoint["precision"] };
  window?: { from: string; to: string };
  tatamiCount?: number;
  staffCount?: number;
  minutes?: number;
  capacity?: Pick<EffectiveCapacity, "jobsPerDay" | "visitsPerDay" | "tatamiPerDay" | "source" | "staffEventsPerDay">;
  /** 作業の内容 (表示用) */
  work?: { label: string; source: string };
  /** 移動時間の求め方 */
  travel?: "local" | "google";
}

const SOURCE_LABEL = { setting: "設定値", auto: "過去 1 年の実績から自動", default: "標準値" } as const;

/**
 * 候補日を提案する。user の閲覧範囲で案件 (お客様・受注) を読む。
 * 予定表は全社共有のため、担当者の予定・ほかの店舗の予定は全員分を使う
 */
export function suggestScheduleDates(db: Database, user: User, input: SuggestInput, now = new Date(), opts: { travel?: TravelFn } = {}): SuggestResult {
  const store = db.stores.find((s) => s.id === input.storeId);
  if (!store) return { candidates: [], notes: ["店舗が見つかりません。"] };
  const kind = input.kind;
  if (!SUGGEST_KINDS.includes(kind)) return { candidates: [], notes: [`「${SCHEDULE_KIND[kind]?.label ?? kind}」は候補日の提案の対象外です (現地調査・顧客訪問・採寸・引き取り・納品・施工が対象)。`] };
  const notes: string[] = [];
  if (!canAccessStore(user, store.id)) notes.push(`${store.name}の予定の登録は、${store.shortName}のメンバーと本部・管理者が行います (候補の確認だけできます)。`);

  const today = toDateKey(now);
  const from0 = isDateKey(input.from) && input.from > today ? input.from : today;
  const to0 = isDateKey(input.to) && input.to > from0 ? input.to : addDays(from0, 75);
  const ctx = createPlanContext(db, user, { now, from: from0, to: addDays(to0, 10), exclude: input.eventId ? [input.eventId] : [], travel: opts.travel });
  const built = buildRequest(ctx, input);
  if ("error" in built) return { candidates: [], notes: [built.error] };
  const { req } = built;
  notes.push(...built.notes);
  const cap = ctx.capOf(store.id);

  const r = evaluateJob(ctx, req);
  const limit = Math.max(1, Math.min(10, input.limit ?? 5));
  const candidates = pickDiverse(r.candidates, limit);
  const soonest = [...r.candidates].sort((a, b) => a.date.localeCompare(b.date) || b.score - a.score)[0];
  if (soonest && !candidates.some((c) => c.date === soonest.date)) notes.push(`最も早く入れられるのは ${shortDate(soonest.date)} (${soonest.slot === "am" ? "午前" : soonest.slot === "pm" ? "午後" : "終日"}・${soonest.score} 点) です。`);

  const src = cap.source;
  notes.push(
    `1 日の上限 (${store.shortName}): 現場作業 ${cap.jobsPerDay} 件 (${SOURCE_LABEL[src.jobsPerDay]})・営業の訪問 ${cap.visitsPerDay} 件 (${SOURCE_LABEL[src.visitsPerDay]})・引き取る畳 ${cap.tatamiPerDay} 枚 (${SOURCE_LABEL[src.tatamiPerDay]})・1 人 ${cap.staffEventsPerDay} 件。予定表 → 「仕事量と提案の設定」で変更できます。`,
  );
  const windowCase = [...ctx.byStoreDay.entries()]
    .filter(([k]) => k.startsWith(`${store.id}|`) && k.slice(store.id.length + 1) >= req.earliest && k.slice(store.id.length + 1) <= req.latest)
    .flatMap(([, items]) => items.filter((e) => SCHEDULE_KIND[e.kind]?.group === "case"));
  const uniqCase = [...new Map(windowCase.map((e) => [e.id, e])).values()];
  const unassigned = uniqCase.filter((e) => !e.assigneeIds.length).length;
  if (!req.fixed.length && uniqCase.length && unassigned / uniqCase.length >= 0.5)
    notes.push(`この期間の${store.shortName}の案件の予定 ${uniqCase.length} 件のうち ${unassigned} 件は担当者が未設定のため、担当者の空きは担当者が登録された予定だけで判断しています (店舗の件数の上限には含めています)。`);
  const rj = r.rejected;
  const parts = [
    rj.closed && `休業日 ${rj.closed} 日`,
    rj.full && `店舗の上限に達している日 ${rj.full} 日`,
    rj.noStaff && `担当者の空きがない日 ${rj.noStaff} 日`,
    rj.noResource && `車両・設備の空きがない日 ${rj.noResource} 日`,
    rj.production && `製造が期限に間に合わない日 ${rj.production} 日`,
    rj.deadline && `期限を過ぎる日 ${rj.deadline} 日`,
    rj.preference && `お客様の都合・希望に合わない日 ${rj.preference} 日`,
  ].filter(Boolean);
  if (parts.length) notes.push(`${shortDate(req.earliest)}〜${shortDate(req.latest)} のうち、${parts.join("・")}を除きました。`);
  if (!candidates.length) {
    notes.push("条件に合う日がありませんでした。探す期間を広げる、担当者・人数を変える、または上限の設定を見直してください。");
    const reasons = [...r.staffReasons.values()].slice(0, 4);
    if (reasons.length) notes.push(`担当者が入れない主な理由: ${reasons.join(" / ")}`);
  }
  if (r.missingProcesses.length) notes.push(`製造の工程 (${r.missingProcesses.map((k) => PROCESS_KEYS.find((p) => p.key === k)?.name ?? k).join("・")}) が${store.shortName}に登録されていないため、製造の能力は確かめていません。`);
  if (r.unregisteredResources.length) notes.push(`${store.shortName}に車両・設備 (${r.unregisteredResources.map((t) => RESOURCE_TYPES.find((x) => x.type === t)?.label ?? t).join("・")}) が登録されていないため、空きは確かめていません。`);
  if (r.skillsEnforced) notes.push("社員の技能・熟練度の設定から、必要な技能を持つ人を選んでいます。");
  if (req.job.units.tatami > 0 && kind !== "pickup") notes.push(`畳 ${req.job.units.tatami} 枚の案件です (製造の能力は引き取りの日で確かめます)。`);
  const travelSource = candidates.some((c) => c.travelSource === "google") ? "google" : "local";
  notes.push(travelSource === "google" ? "移動時間は実際の道路の経路 (Google) から求めました。" : "移動時間は距離からの目安です (渋滞・有料道路・駐車は含みません)。");

  return {
    candidates,
    notes,
    site: built.site ? { label: built.site.label, precision: built.site.precision } : undefined,
    window: { from: req.earliest, to: req.latest },
    tatamiCount: req.job.units.tatami,
    staffCount: req.staffCount,
    minutes: req.minutes,
    capacity: { jobsPerDay: cap.jobsPerDay, visitsPerDay: cap.visitsPerDay, tatamiPerDay: cap.tatamiPerDay, source: cap.source, staffEventsPerDay: cap.staffEventsPerDay },
    work: req.job.items.length ? { label: req.job.items.map((i) => `${i.workType.name} ${i.qty} ${i.workType.unit}`).join("・"), source: req.job.source } : undefined,
    travel: travelSource,
  };
}
