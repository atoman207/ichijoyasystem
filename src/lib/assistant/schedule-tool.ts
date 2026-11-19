import "server-only";
import type { Database, ScheduleKind, StoreId, User } from "@/lib/db/types";
import type { ToolDef } from "@/lib/ai/provider";
import { canAccessStore } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, fmtDate, toDateKey } from "@/lib/format";
import { isDateKey, shortDate } from "@/lib/calendar";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import { suggestScheduleDates, type SuggestCandidate, type SuggestSlot } from "@/lib/schedule-suggest";
import { createPlanContext, activeHolds } from "@/lib/scheduling/context";
import { optimizePlan, waitingJobs, describePlacement } from "@/lib/scheduling/optimize";
import { dayRoute, storeDayRoutes } from "@/lib/scheduling/route";
import { readiness } from "@/lib/scheduling/readiness";

/**
 * AI アシスタントの道具 (予定の計画)。計算は src/lib/scheduling/ (AI は使わない決定的な計算)。どの道具も予定を書き換えない
 * - suggest_schedule: 1 件の予定の候補日 (店舗の受け入れ量・製造・担当者の空きと技能・車両・移動・お客様の希望・期限)
 * - plan_schedule: 日程のない案件をまとめて配置 (いまの予定を変えない案 / 一部を動かす案)
 * - day_route: 1 日の巡回順 (担当者ごと。時刻未定の予定の回る順と移動)
 * - schedule_holds: 仮押さえの一覧 (担当者の返事・お客様の選択)
 * - schedule_setup: 提案の精度に必要な情報の準備の状況
 * 候補の日時は、予定の入力の画面へのリンク (日時・担当を入れて開く) を付けて返す。登録は利用者が画面で行う
 */
export interface ScheduleSuggestTool {
  def: ToolDef;
  run: (db: Database, user: User, args: Record<string, unknown>, now: Date) => { text: string; summary: string; href?: string };
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const slotLabel = (s?: SuggestSlot) => (s === "am" ? "午前" : s === "pm" ? "午後" : "終日");

function storeOf(db: Database, user: User, arg: unknown): StoreId | undefined {
  const s = str(arg);
  if (!s) return undefined;
  return db.stores.find((x) => x.id === s || x.name.includes(s) || s.includes(x.shortName))?.id;
}

/** 予定の入力の画面 (日時・担当・案件を入れて開く) */
export function newEventHref(kind: ScheduleKind, c: Pick<SuggestCandidate, "date" | "startTime" | "assigneeIds">, ref: { orderId?: string; quoteId?: string; inquiryId?: string; customerId?: string; storeId?: string }): string {
  const q = new URLSearchParams({ kind, date: c.date });
  if (c.startTime) q.set("start", c.startTime);
  if (c.assigneeIds.length) q.set("user", c.assigneeIds.join(","));
  if (ref.orderId) q.set("orderId", ref.orderId);
  else if (ref.quoteId) q.set("quoteId", ref.quoteId);
  else if (ref.inquiryId) q.set("inquiryId", ref.inquiryId);
  else if (ref.customerId) q.set("customerId", ref.customerId);
  if (ref.storeId && !ref.orderId && !ref.quoteId && !ref.inquiryId) q.set("store", ref.storeId);
  return `/schedule/new?${q.toString()}`;
}

export const scheduleSuggestTool: ScheduleSuggestTool | null = {
  def: {
    name: "suggest_schedule",
    description: `新しい案件・訪問の予定の候補日を提案する (会社全体の生産性が高くなる日)。店舗の 1 日の受け入れ量・製造の工程の空き (完成の日)・担当者の空きと勤務と技能・車両・近くの現場 (移動時間)・お客様の希望と期限を考えて点数をつける。種類: ${SUGGEST_KINDS.map((k) => `${k}=${SCHEDULE_KIND[k].label}`).join(", ")}。受注番号 (order) や顧客 (customer) が分かれば渡す (現場の住所・作業の内容を読み取る)。結果の「入力」のリンクで、その日時の予定の入力画面を開ける。`,
    parameters: {
      type: "object",
      properties: {
        store: { type: "string", description: "店舗 (id または名前。省略 = 質問した人の店舗)" },
        kind: { type: "string", enum: SUGGEST_KINDS },
        order: { type: "string", description: "受注の ID または番号 (O-2026-0012)" },
        customer: { type: "string", description: "顧客の ID またはコード" },
        address: { type: "string", description: "現場の住所・地名" },
        tatami_count: { type: "integer", description: "畳の枚数" },
        staff_count: { type: "integer", description: "必要な人数" },
        days: { type: "integer", description: "日数 (複数日の施工)" },
        slot: { type: "string", enum: ["am", "pm", "day"] },
        from: { type: "string", description: "探す期間の始まり YYYY-MM-DD" },
        to: { type: "string", description: "探す期間の終わり YYYY-MM-DD" },
        limit: { type: "integer", description: "候補の数 (既定 5)" },
      },
      required: ["kind"],
    },
  },
  run(db, user, a, now) {
    const kind = (SUGGEST_KINDS as string[]).includes(String(a.kind)) ? (a.kind as ScheduleKind) : undefined;
    if (!kind) return { text: `予定の種類を ${SUGGEST_KINDS.join("・")} から選んでください。`, summary: "種類が不明" };
    const orderRef = str(a.order);
    const order = orderRef ? db.orders.find((o) => o.id === orderRef || o.number.toUpperCase() === orderRef.toUpperCase()) : undefined;
    const custRef = str(a.customer);
    const customer = custRef ? db.customers.find((c) => c.id === custRef || c.code.toUpperCase() === custRef.toUpperCase()) : undefined;
    const storeId: StoreId = storeOf(db, user, a.store) ?? order?.storeId ?? customer?.storeId ?? user.storeId;
    const r = suggestScheduleDates(
      db,
      user,
      {
        storeId,
        kind,
        orderId: order?.id,
        customerId: customer?.id ?? order?.customerId,
        address: str(a.address),
        tatamiCount: num(a.tatami_count),
        staffCount: num(a.staff_count),
        durationDays: num(a.days),
        slot: (["am", "pm", "day"] as const).find((s) => s === a.slot) as SuggestSlot | undefined,
        from: str(a.from, 10),
        to: str(a.to, 10),
        limit: Math.min(10, num(a.limit) ?? 5),
      },
      now,
    );
    const storeName = db.stores.find((s) => s.id === storeId)?.name ?? storeId;
    const visibleOrder = order && canAccessStore(user, order.storeId) ? order : undefined;
    const visibleCustomer = customer && canAccessStore(user, customer.storeId) ? customer : undefined;
    const ref = { orderId: visibleOrder?.id, customerId: visibleCustomer?.id ?? visibleOrder?.customerId, storeId };
    const lines = [
      `${storeName} の ${SCHEDULE_KIND[kind].label} の候補日 (${r.candidates.length} 件${r.window ? ` / 探した期間 ${r.window.from}〜${r.window.to}` : ""}${r.site ? ` / 現場 ${r.site.label}` : ""}${r.work ? ` / 作業 ${r.work.label}` : r.tatamiCount ? ` / 畳 ${r.tatamiCount} 枚` : ""})`,
      ...r.candidates.map(
        (c, i) =>
          `${i + 1}. ${fmtDate(c.date, { weekday: true })}${c.endDate && c.endDate !== c.date ? `〜${fmtDate(c.endDate)}` : ""} ${c.startTime ? `${c.startTime}${c.endTime ? `-${c.endTime}` : ""}` : slotLabel(c.slot)} 点数 ${c.score} 担当 ${(c.assigneeNames ?? c.assigneeIds).join("・") || "未定"}${c.travelMin !== undefined ? ` 移動 約${c.travelMin}分` : ""}${c.resourceNames?.length ? ` 車両 ${c.resourceNames.join("・")}` : ""}${c.readyDate ? ` 製造の完成 ${c.readyDate}` : ""}\n   理由: ${c.reasons.join(" / ")}${c.warnings.length ? `\n   注意: ${c.warnings.join(" / ")}` : ""}\n   入力: [この日時で予定を入力](${newEventHref(kind, c, ref)})`,
      ),
      ...(r.notes.length ? [`注記: ${r.notes.join(" / ")}`] : []),
      "予定の登録は、候補の「入力」のリンク (日時・担当が入った入力画面) で利用者が行う。候補を押さえておくときは 予定の入力画面の「仮押さえ」、まとめての計画は [予定の計画](/schedule/planning)。この AI は登録しない。",
    ];
    const first = r.candidates[0];
    return { text: lines.join("\n"), summary: `${storeName} ${SCHEDULE_KIND[kind].label} → ${r.candidates.length} 件`, href: first ? newEventHref(kind, first, ref) : "/schedule" };
  },
};

const planTool: ScheduleSuggestTool = {
  def: {
    name: "plan_schedule",
    description: "日程がまだない案件 (問い合わせの現地調査・受注の引き取り/施工/納品) をまとめて配置する計画を作る。mode=keep はいまの予定を変えない案、rearrange は既存の予定を一部動かすと良くなる案も出す (動かす予定・点数の差)。移動・応援・残業・遅れの合計も比べる。予定は書き換えない。",
    parameters: {
      type: "object",
      properties: {
        store: { type: "string", description: "店舗 (id または名前。省略 = 質問した人の店舗)" },
        mode: { type: "string", enum: ["keep", "rearrange"] },
        from: { type: "string", description: "期間の始まり YYYY-MM-DD" },
        days: { type: "integer", description: "期間の日数 (既定 21)" },
        limit: { type: "integer", description: "配置する案件の数 (既定 10・最大 20)" },
      },
      required: [],
    },
  },
  run(db, user, a, now) {
    const storeId = storeOf(db, user, a.store) ?? user.storeId;
    if (!canAccessStore(user, storeId)) return { text: "この店舗の計画は作れません (閲覧の範囲外)。", summary: "範囲外" };
    const from = isDateKey(str(a.from, 10)) ? str(a.from, 10)! : toDateKey(now);
    const to = addDays(from, Math.max(7, Math.min(62, num(a.days) ?? 21)));
    const jobs = waitingJobs(db, user, { storeIds: [storeId], now, limit: Math.max(1, Math.min(20, num(a.limit) ?? 10)) });
    const storeName = db.stores.find((s) => s.id === storeId)?.name ?? storeId;
    if (!jobs.length && a.mode !== "rearrange") return { text: `${storeName} に日程のない案件はありません。`, summary: `${storeName} 0 件`, href: "/schedule/planning" };
    const r = optimizePlan(db, user, { jobs, mode: a.mode === "rearrange" ? "rearrange" : "keep", storeIds: [storeId], from, to, now, maxMoves: 5 });
    const s = r.summary;
    const k = r.keepSummary;
    const lines = [
      `${storeName} の計画 (${from}〜${to}・日程のない案件 ${jobs.length} 件)`,
      ...r.placements.map((p) => `- ${describePlacement(p)}${p.candidate ? ` [入力](${newEventHref(p.kind, p.candidate, { ...p.request, storeId: p.storeId })})` : ""}`),
      r.moves.length ? "動かすと良くなる既存の予定 (お客様・担当者に連絡してから):" : "",
      ...r.moves.map((m) => `- ${m.title}: ${m.from.date} → ${m.to.date} ${m.to.startTime ?? slotLabel(m.to.slot)} (+${m.gain} 点) [変更](/schedule/${m.eventId}/edit?date=${m.to.date}${m.to.startTime ? `&start=${m.to.startTime}` : ""})`),
      `比べた指標: 平均点 ${k.avgScore}${r.moves.length ? ` → ${s.avgScore}` : ""} / 移動の合計 ${k.travelMin} 分${r.moves.length ? ` → ${s.travelMin} 分` : ""} / 応援 ${k.helpCount} 件 / 残業 ${k.overtimeMin} 分 / 期限に遅れる ${k.lateCount} 件 / 配置できない ${k.unplaced} 件`,
      ...r.notes,
      "仮押さえ・まとめての確定は [予定の計画](/schedule/planning) で行う。",
    ].filter(Boolean);
    return { text: lines.join("\n"), summary: `${storeName} 計画 ${s.placed}/${jobs.length} 件${r.moves.length ? `・動かす ${r.moves.length} 件` : ""}`, href: "/schedule/planning" };
  },
};

const routeTool: ScheduleSuggestTool = {
  def: {
    name: "day_route",
    description: "1 日の巡回順 (担当者ごとに、その日の現場を回る順番・到着と開始の時刻・移動・遅れ・残業の見込み)。時刻の決まった予定は動かさず、時刻未定の予定を移動が短くなる順に並べる。staff を省略すると店舗の全員。",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "日 YYYY-MM-DD (省略 = 今日)" },
        store: { type: "string", description: "店舗 (省略 = 質問した人の店舗)" },
        staff: { type: "string", description: "社員の名前 (省略 = 店舗の全員)" },
      },
      required: [],
    },
  },
  run(db, user, a, now) {
    const date = isDateKey(str(a.date, 10)) ? str(a.date, 10)! : toDateKey(now);
    const storeId = storeOf(db, user, a.store) ?? user.storeId;
    const staffName = str(a.staff, 40)?.replace(/\s/g, "");
    const ctx = createPlanContext(db, user, { now, from: date, to: date });
    const staff = staffName ? db.users.find((u) => u.active && u.name.replace(/\s/g, "").includes(staffName)) : undefined;
    const routes = staff ? [dayRoute(ctx, staff, date)].filter((x): x is NonNullable<typeof x> => Boolean(x)) : storeDayRoutes(ctx, storeId, date);
    if (!routes.length) return { text: `${date} に担当者が決まっている現場の予定はありません${staff ? ` (${staff.name})` : ""}。`, summary: `${date} 0 人`, href: `/schedule?view=day&date=${date}` };
    const lines = routes.map(
      (r) =>
        `${r.name} (${r.day}) 出発 ${r.startAt} → 帰着 ${r.endAt} 移動 合計 ${r.totalTravel} 分${r.reordered && r.currentTravel > r.totalTravel ? ` (時刻の順だと ${r.currentTravel} 分。順番を変えると ${r.currentTravel - r.totalTravel} 分短い)` : ""}${r.overtimeMin > 0 ? ` 残業の見込み 約${Math.round(r.overtimeMin / 15) * 15}分` : ""}\n${r.stops.map((s, i) => `  ${i + 1}. ${s.start}-${s.end} ${s.title} (${s.place ?? "場所不明"}・移動 ${s.travelMin} 分${s.fixed ? "・時刻固定" : "・この順を提案"}${s.lateMin ? `・約束に ${s.lateMin} 分遅れ` : ""})`).join("\n")}`,
    );
    return { text: [...lines, `移動は${routes.some((r) => r.source === "google") ? "道路の経路" : "距離からの目安"}。[予定の計画 → 巡回順](/schedule/planning?tab=routes)`].join("\n"), summary: `${date} ${routes.length} 人の巡回順`, href: `/schedule?view=day&date=${date}` };
  },
};

const holdsTool: ScheduleSuggestTool = {
  def: {
    name: "schedule_holds",
    description: "仮押さえ中の予定の候補 (第 1〜3 候補・担当者の「行ける/行けない」の返事・お客様への案内と選択・期限) の一覧。自分が担当の仮押さえだけにするときは mine=true。",
    parameters: { type: "object", properties: { mine: { type: "boolean" } }, required: [] },
  },
  run(db, user, a, now) {
    const holds = activeHolds(db, now).filter((h) => (a.mine === true ? h.assigneeIds.includes(user.id) : canAccessStore(user, h.storeId) || h.assigneeIds.includes(user.id)));
    if (!holds.length) return { text: "仮押さえ中の予定はありません。", summary: "0 件", href: "/schedule/planning?tab=holds" };
    const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;
    const lines = holds
      .sort((x, y) => x.date.localeCompare(y.date))
      .slice(0, 30)
      .map((h) => `- ${h.title} 第${h.rank}候補 ${shortDate(h.date)} ${h.startTime ?? (h.slot === "am" ? "午前" : h.slot === "pm" ? "午後" : "終日")} 担当 ${h.assigneeIds.map(name).join("・") || "未定"}${h.acks.length ? ` 返事: ${h.acks.map((x) => `${name(x.userId)}${x.ok ? "○" : "×"}`).join("・")}` : " 返事なし"}${h.offeredAt ? " お客様に案内済み" : ""}${h.customerChoiceAt ? " ★お客様が選択" : ""} 期限 ${h.expiresAt.slice(0, 10)}`);
    return { text: [`仮押さえ ${holds.length} 件`, ...lines, "確定・解除・お客様への案内は [予定の計画 → 仮押さえ](/schedule/planning?tab=holds)。"].join("\n"), summary: `仮押さえ ${holds.length} 件`, href: "/schedule/planning?tab=holds" };
  },
};

const setupTool: ScheduleSuggestTool = {
  def: {
    name: "schedule_setup",
    description: "予定の候補日の提案・最適化の精度に必要な情報 (店舗の上限・作業の標準工数・製造能力・社員の技能と勤務・車両・経路・重み・作業の内容の登録率・過去の実績) の準備の状況と、足りないもの。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  run(db, _user, _a, now) {
    const items = readiness(db, now);
    const mark = { done: "○", provisional: "△", missing: "×" } as const;
    return {
      text: [...items.map((i) => `${mark[i.status]} ${i.label}: ${i.detail}`), "設定は [仕事量と提案の設定 → 準備の状況](/schedule/capacity?tab=ready)。○ = 登録済み・△ = 暫定・一部・× = 未登録"].join("\n"),
      summary: `準備 ${items.filter((i) => i.status === "done").length}/${items.length}`,
      href: "/schedule/capacity?tab=ready",
    };
  },
};

/** AI アシスタントに渡す予定の計画の道具 (agent.ts が def を渡し、名前で呼ぶ) */
export const scheduleTools: ScheduleSuggestTool[] = [scheduleSuggestTool!, planTool, routeTool, holdsTool, setupTool];
