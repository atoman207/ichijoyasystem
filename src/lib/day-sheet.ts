import type { Database, ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { compareInDay, isMultiDay, lastDay, occursOn } from "@/lib/calendar";
import { daysBetween } from "@/lib/format";
import type { WorkCounts } from "@/lib/work-summary";

/**
 * 日ごとの予定表 (スプレッドシートの形) と 1 日の作業量 (お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」)
 * ------------------------------------------------------------
 * - 店舗ごとに 左 = 引取・見積・現調・会議など / 右 = 納品、上 = 午前 / 下 = 午後 (時刻も午前・午後もない予定は「時間指定なし」)
 * - 1 行 = 時間・地名・現場 (お客様)・内容・畳 / 襖 / 障子 / 網戸 の 表 (表替え・裏返し・張替え) と 新 (新調)・備考・担当者
 * - 作業量に数える予定 = 引き取り・現見 (現場見積)・施工 (+ 設定で納品)。スプレッドシートの「上限」の行が
 *   ハギ (引き取り) の欄だけを合計していたのと同じ。見積・現調・訪問の枚数は見込みとして灰色で出し、合計に入れない
 * - 換算作業量 = 畳 + 襖 + 障子 × 0.5 + 網戸 × 0.5 (重みは設定)
 * - 1 日の対応可能枚数 = 対象人数 × 11 枚。対象人数 = 店舗の有効な社員 − 対象から外した社員 (設定) − その日の休暇
 *   (終日 1 人・午前 / 午後 0.5 人)。人数を手で決めた店舗はその人数から休暇を引く
 * 設定は settings の id = schedule_day_load (予定表 → 仕事量と提案の設定 →「1 日の対応可能枚数」。管理者)
 * ブラウザーとサーバーの両方から使う (データベースは引数で受け取る)
 */

export const DAY_LOAD_ID = "schedule_day_load";

export type SheetItem = "tatami" | "fusuma" | "shoji" | "amido";
export const SHEET_ITEMS: SheetItem[] = ["tatami", "fusuma", "shoji", "amido"];
export const SHEET_ITEM_LABEL: Record<SheetItem, string> = { tatami: "畳", fusuma: "襖", shoji: "障子", amido: "網戸" };

export type LoadWeights = Record<SheetItem, number>;

export interface DayLoadStore {
  /** 対象人数から外す社員 (例: 社長・パート) */
  excludeUserIds: string[];
  /** 人数を手で決める (空 = 社員の数から) */
  people?: number;
}

export interface DayLoadSettings {
  /** 1 人の 1 日の対応可能枚数 */
  perPerson: number;
  /** 換算の重み (1 枚あたり) */
  weights: LoadWeights;
  /** 納品の枚数も作業量に数える (既定 = 数えない。スプレッドシートと同じ) */
  countDelivery: boolean;
  /** 見積・現調・採寸の予定の枚数 (見込み) も数える (既定 = 数えない。スプレッドシートは見積の行に書いた枚数も合計していた) */
  countEstimates: boolean;
  /** 休暇の人を対象人数から引く */
  subtractLeave: boolean;
  stores: Partial<Record<StoreId, DayLoadStore>>;
  updatedAt?: string;
}

export const DAY_LOAD_DEFAULTS: Omit<DayLoadSettings, "stores"> = {
  perPerson: 11,
  weights: { tatami: 1, fusuma: 1, shoji: 0.5, amido: 0.5 },
  countDelivery: false,
  countEstimates: false,
  subtractLeave: true,
};

const numIn = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : undefined;
};

/** 設定の読み込み (壊れた値は既定値) */
export function readDayLoadSettings(db: Pick<Database, "settings" | "stores">): DayLoadSettings {
  const row = (db.settings ?? []).find((s) => s.id === DAY_LOAD_ID);
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const w = (v.weights ?? {}) as Record<string, unknown>;
  const raw = (v.stores ?? {}) as Record<string, Record<string, unknown>>;
  const stores: DayLoadSettings["stores"] = {};
  for (const s of db.stores) {
    const r = raw[s.id];
    if (!r) continue;
    const ex = Array.isArray(r.excludeUserIds) ? r.excludeUserIds.filter((x): x is string => typeof x === "string" && Boolean(x)) : [];
    stores[s.id] = { excludeUserIds: [...new Set(ex)], people: numIn(r.people, 0, 99) };
  }
  return {
    perPerson: numIn(v.perPerson, 1, 99) ?? DAY_LOAD_DEFAULTS.perPerson,
    weights: Object.fromEntries(SHEET_ITEMS.map((k) => [k, numIn(w[k], 0, 10) ?? DAY_LOAD_DEFAULTS.weights[k]])) as LoadWeights,
    countDelivery: typeof v.countDelivery === "boolean" ? v.countDelivery : DAY_LOAD_DEFAULTS.countDelivery,
    countEstimates: typeof v.countEstimates === "boolean" ? v.countEstimates : DAY_LOAD_DEFAULTS.countEstimates,
    subtractLeave: typeof v.subtractLeave === "boolean" ? v.subtractLeave : DAY_LOAD_DEFAULTS.subtractLeave,
    stores,
    updatedAt: row?.updatedAt,
  };
}

/* ---------------- 欄の数 ---------------- */

/** 品目ごとの 表 (表替え・裏返し・張替え) と 新 (新調) */
export type SheetCols = Record<SheetItem, { omote: number; fresh: number }>;

const r1 = (n: number) => Math.round(n * 10) / 10;

export function emptyCols(): SheetCols {
  return { tatami: { omote: 0, fresh: 0 }, fusuma: { omote: 0, fresh: 0 }, shoji: { omote: 0, fresh: 0 }, amido: { omote: 0, fresh: 0 } };
}

/** 予定の仕事内容 (src/lib/schedule-work.ts) → 欄の数 */
export function colsOf(c: WorkCounts | undefined): SheetCols {
  const out = emptyCols();
  if (!c) return out;
  for (const k of SHEET_ITEMS) {
    // へり無し畳の枚数だけが分かっているとき (「縁無半12」) は、その枚数を畳の数にする (予定表の「タ12(縁無)」と同じ)
    const total = k === "tatami" ? Math.max(c.tatami, c.herinashi) : c[k];
    const fresh = Math.min(total, c.fresh?.[k] ?? 0);
    out[k] = { omote: r1(total - fresh), fresh: r1(fresh) };
  }
  return out;
}

export function addCols(a: SheetCols, b: SheetCols): SheetCols {
  const out = emptyCols();
  for (const k of SHEET_ITEMS) out[k] = { omote: r1(a[k].omote + b[k].omote), fresh: r1(a[k].fresh + b[k].fresh) };
  return out;
}

export const itemTotal = (c: SheetCols, k: SheetItem): number => r1(c[k].omote + c[k].fresh);
export const hasCols = (c: SheetCols): boolean => SHEET_ITEMS.some((k) => c[k].omote > 0 || c[k].fresh > 0);

/** 換算作業量 = 畳 + 襖 + 障子 × 0.5 + 網戸 × 0.5 (重みは設定) */
export function workload(c: SheetCols, w: LoadWeights): number {
  return r1(SHEET_ITEMS.reduce((sum, k) => sum + itemTotal(c, k) * w[k], 0));
}

/* ---------------- 欄・時間帯 ---------------- */

export type SheetSide = "left" | "right";
export type SheetBand = "am" | "pm" | "none";

/** 右 = 納品、左 = 引き取り・見積・現調・会議などそのほか (休暇は行にせず、対象人数から引く) */
export const sideOf = (kind: ScheduleKind): SheetSide => (kind === "delivery" ? "right" : "left");

/** 午前 = 午前の指定・12 時より前に始まる / 午後 = 午後の指定・12 時から / 時刻も午前・午後もない = 時間指定なし */
export function bandOf(e: Pick<ScheduleEvent, "startTime" | "slot">): SheetBand {
  if (e.slot === "am" || e.slot === "pm") return e.slot;
  if (e.startTime) return e.startTime < "12:00" ? "am" : "pm";
  return "none";
}

/** 作業量に数える種類 (左の欄)。見積・現調・採寸の枚数は見込み (設定で数える)、訪問・社内の予定は数えない */
const COUNT_LEFT = new Set<ScheduleKind>(["pickup", "onsite_quote", "install"]);
export const ESTIMATE_KINDS = new Set<ScheduleKind>(["survey", "site_survey", "measure"]);

export function countsToward(e: Pick<ScheduleEvent, "id" | "kind">, set: Pick<DayLoadSettings, "countDelivery" | "countEstimates">): boolean {
  if (e.id.startsWith("hold:")) return false;
  if (e.kind === "delivery") return set.countDelivery;
  if (ESTIMATE_KINDS.has(e.kind)) return set.countEstimates;
  return COUNT_LEFT.has(e.kind);
}

/** 時間の欄 (10:00 / AM / PM / 空)。複数日の予定は「2/3日目」 */
export function sheetTime(e: Pick<ScheduleEvent, "date" | "endDate" | "startTime" | "endTime" | "slot">, day: string): string {
  const t = e.startTime ?? (e.slot === "am" ? "AM" : e.slot === "pm" ? "PM" : "");
  if (!isMultiDay(e)) return t;
  return `${t}${t ? " " : ""}${daysBetween(e.date, day) + 1}/${daysBetween(e.date, lastDay(e)) + 1}日目`;
}

/* ---------------- 対象人数と対応可能枚数 ---------------- */

export interface CapacityMember {
  id: string;
  name: string;
  /** 対象人数に入る */
  counted: boolean;
  /** その日の休暇 (1 = 終日・0.5 = 午前 / 午後・時間) */
  leave?: number;
  leaveLabel?: string;
}

export interface StoreCapacity {
  members: CapacityMember[];
  /** 社員の数 (対象から外した人を除く) か、手で決めた人数 */
  base: number;
  manual: boolean;
  /** 休暇で引いた人数 */
  leave: number;
  people: number;
  perPerson: number;
  capacity: number;
  closed: boolean;
}

/** 休暇の予定の重さ (終日 1・午前 / 午後 0.5・時刻 4 時間以上 0.5) */
function leaveWeight(e: Pick<ScheduleEvent, "startTime" | "endTime" | "slot" | "date" | "endDate">): { w: number; label: string } {
  if (e.slot === "am") return { w: 0.5, label: "午前" };
  if (e.slot === "pm") return { w: 0.5, label: "午後" };
  if (e.startTime) {
    const [h1, m1] = e.startTime.split(":").map(Number);
    const [h2, m2] = (e.endTime ?? e.startTime).split(":").map(Number);
    const min = h2 * 60 + m2 - (h1 * 60 + m1);
    return min >= 240 ? { w: 0.5, label: `${e.startTime}〜${e.endTime ?? ""}` } : { w: 0, label: `${e.startTime}〜${e.endTime ?? ""}` };
  }
  return { w: 1, label: "終日" };
}

/** 店舗のその日の対象人数と対応可能枚数 (本部などの店舗の種類 hq は対象外 = undefined) */
export function storeCapacity(
  db: Pick<Database, "users" | "stores">,
  set: DayLoadSettings,
  storeId: StoreId,
  day: string,
  dayEvents: Pick<ScheduleEvent, "kind" | "assigneeIds" | "startTime" | "endTime" | "slot" | "date" | "endDate">[],
  closed = false,
): StoreCapacity | undefined {
  const store = db.stores.find((s) => s.id === storeId);
  if (!store || store.kind === "hq") return undefined;
  const st = set.stores[storeId];
  const exclude = new Set(st?.excludeUserIds ?? []);
  const leaves = new Map<string, { w: number; label: string }>();
  for (const e of dayEvents) {
    if (e.kind !== "leave" || !occursOn(e, day)) continue;
    const lw = leaveWeight(e);
    for (const id of e.assigneeIds) if ((leaves.get(id)?.w ?? -1) < lw.w) leaves.set(id, lw);
  }
  const members: CapacityMember[] = db.users
    .filter((u) => u.active && u.storeId === storeId)
    .map((u) => {
      const l = leaves.get(u.id);
      return { id: u.id, name: u.name, counted: !exclude.has(u.id), ...(l ? { leave: l.w, leaveLabel: l.label } : {}) };
    });
  const manual = st?.people !== undefined;
  const base = manual ? st!.people! : members.filter((m) => m.counted).length;
  const leave = set.subtractLeave ? Math.min(base, members.filter((m) => m.counted).reduce((s, m) => s + (m.leave ?? 0), 0)) : 0;
  const people = closed ? 0 : Math.max(0, r1(base - leave));
  return { members, base, manual, leave: r1(leave), people, perPerson: set.perPerson, capacity: r1(people * set.perPerson), closed };
}

/* ---------------- 日ごとの予定表 ---------------- */

export interface SheetRow {
  event: ScheduleEvent;
  side: SheetSide;
  band: SheetBand;
  time: string;
  town?: string;
  site: string;
  cols: SheetCols;
  /** 作業量に数える */
  counted: boolean;
  remark: string;
  hold: boolean;
}

export interface StoreSheet {
  storeId: StoreId;
  rows: SheetRow[];
  /** 欄ごとの合計 (左は作業量に数える行、右は納品の行すべて) */
  totals: Record<SheetSide, SheetCols>;
  /** 作業量に数える枚数 (左の合計 + 設定で右) */
  counted: SheetCols;
  workload: number;
  capacity?: StoreCapacity;
  /** 対応可能枚数を超えた枚数 (超えていなければ 0) */
  over: number;
  /** その日の休暇 (行には出さない) */
  leaves: ScheduleEvent[];
}

export interface SheetInput {
  day: string;
  storeId: StoreId;
  /** その店舗のその日の予定 (仮押さえを含めてよい) */
  events: ScheduleEvent[];
  /** 対象人数から引く休暇の予定 (店舗・絞り込みに関係なく。なければ events の休暇) */
  capacityEvents?: ScheduleEvent[];
  work: Map<string, WorkCounts>;
  label: (e: ScheduleEvent) => { area?: string; name: string };
  set: DayLoadSettings;
  db: Pick<Database, "users" | "stores">;
  closed?: boolean;
}

const MEMO_MAX = 80;

/** 備考: メモ (移行した予定表は 1 行目の枚数の欄を除く)・リフォームなどの施工・へり無し畳・カーテン・仮押さえ */
export function remarkOf(e: ScheduleEvent, c: WorkCounts | undefined): string {
  const parts: string[] = [];
  if (e.id.startsWith("hold:")) parts.push("仮押さえ");
  if (e.kind === "install" || e.kind === "site") parts.push(`${SCHEDULE_KIND[e.kind].short}: ${e.title.replace(/^\[[^\]]*\]\s*/, "")}`);
  if (c?.herinashiSeen) parts.push(`縁無${c.herinashiHalf ? "半" : ""}${c.herinashi > 0 ? c.herinashi : ""}`);
  if (c && (c.curtain > 0 || c.seen.curtain)) parts.push(`カーテン${c.curtain > 0 ? c.curtain : ""}`);
  const lines = (e.memo ?? "").split("\n");
  const memo = (e.source === "import" ? lines.slice(1) : lines).join(" ").replace(/\s+/g, " ").trim();
  if (memo) parts.push(memo);
  const text = parts.join(" / ");
  return text.length > MEMO_MAX ? `${text.slice(0, MEMO_MAX - 1)}…` : text;
}

const BAND_ORDER: Record<SheetBand, number> = { am: 0, pm: 1, none: 2 };

export function buildStoreSheet(input: SheetInput): StoreSheet {
  const { day, storeId, set } = input;
  const dayEvents = input.events.filter((e) => occursOn(e, day));
  const leaves = dayEvents.filter((e) => e.kind === "leave");
  const rows: SheetRow[] = dayEvents
    .filter((e) => e.kind !== "leave")
    .map((e) => {
      const c = input.work.get(e.id);
      const lb = input.label(e);
      return {
        event: e,
        side: sideOf(e.kind),
        band: bandOf(e),
        time: sheetTime(e, day),
        town: lb.area,
        site: lb.name,
        cols: colsOf(c),
        counted: countsToward(e, set),
        remark: remarkOf(e, c),
        hold: e.id.startsWith("hold:"),
      };
    })
    .sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || compareInDay(a.event, b.event));
  const totals: Record<SheetSide, SheetCols> = { left: emptyCols(), right: emptyCols() };
  let counted = emptyCols();
  for (const r of rows) {
    if (r.side === "left" ? r.counted : !r.hold) totals[r.side] = addCols(totals[r.side], r.cols);
    if (r.counted) counted = addCols(counted, r.cols);
  }
  const load = workload(counted, set.weights);
  const capacity = storeCapacity(input.db, set, storeId, day, input.capacityEvents ?? input.events, input.closed);
  const over = capacity ? Math.max(0, r1(load - capacity.capacity)) : 0;
  return { storeId, rows, totals, counted, workload: load, capacity, over, leaves };
}

/** 週・月の表示の日ごとの作業量の目安 (店舗を選んだときの見出しの「作業 18/22」) */
export interface DayLoad {
  workload: number;
  capacity: number;
  over: number;
}

export function dayLoad(input: Omit<SheetInput, "label">): DayLoad | undefined {
  const s = buildStoreSheet({ ...input, label: () => ({ name: "" }) });
  if (!s.capacity) return undefined;
  return { workload: s.workload, capacity: s.capacity.capacity, over: s.over };
}

/** 数の表示 (0 は空。小数は 1 桁) */
export const sheetNum = (n: number): string => (n ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : "");

/** 換算作業量の式「畳 8 + 襖 3 + 障子 4×0.5 + 網戸 2×0.5」 */
export function workloadFormula(c: SheetCols, w: LoadWeights): string {
  const parts = SHEET_ITEMS.filter((k) => itemTotal(c, k) > 0).map((k) => `${SHEET_ITEM_LABEL[k]} ${sheetNum(itemTotal(c, k))}${w[k] !== 1 ? `×${w[k]}` : ""}`);
  return parts.join(" + ") || "0";
}

/* ---------------- 設定の保存 (画面の操作と運用の手直しで共通) ---------------- */

/** 保存する値 (人数の上書き・対象外は店舗ごと。空の店舗は書かない) */
export function dayLoadValue(set: DayLoadSettings): Record<string, unknown> {
  const stores: Record<string, unknown> = {};
  for (const [id, st] of Object.entries(set.stores)) {
    if (!st) continue;
    if (!st.excludeUserIds.length && st.people === undefined) continue;
    stores[id] = { excludeUserIds: st.excludeUserIds, ...(st.people !== undefined ? { people: st.people } : {}) };
  }
  return { perPerson: set.perPerson, weights: set.weights, countDelivery: set.countDelivery, countEstimates: set.countEstimates, subtractLeave: set.subtractLeave, stores };
}

/** 変更履歴の項目 (変更前 → 変更後)。社員は名前で書く */
export function dayLoadChanges(db: Pick<Database, "users" | "stores">, before: DayLoadSettings, after: DayLoadSettings): { field: string; before: unknown; after: unknown }[] {
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;
  const flat = (s: DayLoadSettings): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      "1 人の対応可能枚数": s.perPerson,
      納品も数える: s.countDelivery ? "数える" : "数えない",
      "見積・現調・採寸の枚数も数える": s.countEstimates ? "数える" : "数えない",
      休暇を引く: s.subtractLeave ? "引く" : "引かない",
    };
    for (const k of SHEET_ITEMS) out[`換算 ${SHEET_ITEM_LABEL[k]}`] = s.weights[k];
    for (const st of db.stores) {
      const v = s.stores[st.id];
      out[`${st.shortName} 対象外`] = (v?.excludeUserIds ?? []).map(name).join("・") || "なし";
      out[`${st.shortName} 人数`] = v?.people ?? "社員の数";
    }
    return out;
  };
  const b = flat(before);
  const a = flat(after);
  return Object.keys(a)
    .filter((k) => String(b[k]) !== String(a[k]))
    .map((field) => ({ field, before: b[field], after: a[field] }));
}

/** db.settings に書く (mutate の中で呼ぶ) */
export function writeDayLoadSettings(db: Pick<Database, "settings">, set: DayLoadSettings, userId: string, now: string) {
  const value = dayLoadValue(set);
  const row = db.settings.find((s) => s.id === DAY_LOAD_ID);
  if (row) Object.assign(row, { value, updatedBy: userId, updatedAt: now });
  else db.settings.push({ id: DAY_LOAD_ID, value, updatedBy: userId, updatedAt: now });
}
