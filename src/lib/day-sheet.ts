import type { Database, ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { compareInDay, isMultiDay, lastDay, occursOn } from "@/lib/calendar";
import { addDays, daysBetween } from "@/lib/format";
import { workNoteOf, type WorkCounts } from "@/lib/work-summary";

/**
 * 日ごとの予定表 (スプレッドシートの形) と 1 日の作業量 (お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」)
 * ------------------------------------------------------------
 * - 店舗ごとに 左 = 引取・見積・現調・会議など / 右 = 納品、上 = 午前 / 下 = 午後 (時刻も午前・午後もない予定は「時間指定なし」)
 * - 1 行 = 時間・地名・現場 (お客様)・内容・畳 / 襖 / 障子 / 網戸 の 表 (表替え・裏返し・張替え) と 新 (新調)・備考・担当者
 * - 作業量に数える予定 = 引き取り・現見 (現場見積)・施工・採寸 (+ 設定で納品) の枚数。スプレッドシートの「上限」の行が
 *   ハギ (引き取り) の欄だけを合計していたのと同じ。採寸の枚数は「新」(新調。お客様のご要望 2026-11-25 の補足「②」)
 * - 見積・現調・現場管理の予定は 1 件 = 3 枚 (設定 perEvent・perEventKinds)。スプレッドシートの見積の行の「襖 3」は
 *   実際の枚数ではなく 1 件の仕事量の目安だったため (お客様のご説明 2026-11-25 の補足「①」)。枚数の欄には出さない
 * - 換算作業量 = 畳 + 襖 + 障子 × 0.5 + 網戸 × 0.5 + 見積など 件数 × 3 (重みは設定。新調も表替え・張替えと同じ)
 * - 前日繰越 = 前日の (換算作業量 + 前日繰越 − 対応可能枚数) の超えた分 (スプレッドシートの「繰り越し」の行 = 前日の
 *   「翌日持越」。お客様のご要望 2026-11-25 の補足「③」)。数え始める日 carryFrom から。休業日は対応可能 0 枚 = そのまま翌営業日へ。
 *   店舗・日ごとに手で直せる (settings の id = schedule_day_carry。スプレッドシートで繰り越しの欄を書き直していたのと同じ)
 * - 1 日の対応可能枚数 = 対象人数 × 11 枚。対象人数 = 店舗の有効な社員 − 対象から外した社員 (設定) − その日の休暇
 *   (終日 1 人・午前 / 午後 0.5 人)。人数を手で決めた店舗はその人数から休暇を引く
 * 設定は settings の id = schedule_day_load (予定表 → 仕事量と提案の設定 →「1 日の対応可能枚数」。管理者)
 * ブラウザーとサーバーの両方から使う (データベースは引数で受け取る)
 */

export const DAY_LOAD_ID = "schedule_day_load";
/** 手で直した前日繰越 (店舗 → 日付 → 枚数) */
export const DAY_CARRY_ID = "schedule_day_carry";
/** 繰り越しをさかのぼって数える最大の日数 (それより前の超過は数えない。スプレッドシートでは 1 週間ほどで書き直していた) */
export const CARRY_MAX_DAYS = 92;
/** 繰り越しを数え始める日の既定 (お客様のご要望 2026-11-25 の補足「③」の翌日) */
export const CARRY_FROM_DEFAULT = "2026-11-26";

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
  /** 1 件 = perEvent 枚で数える予定の種類 (既定 = 見積・現調・現場管理。枚数の欄には出さない) */
  perEventKinds: ScheduleKind[];
  /** 見積などの予定 1 件の換算枚数 (既定 3 = スプレッドシートの「襖 3」) */
  perEvent: number;
  /** 休暇の人を対象人数から引く */
  subtractLeave: boolean;
  /** 前日の超過分を翌日の作業量に繰り越す */
  carry: boolean;
  /** 繰り越しを数え始める日 (この日の前日繰越は 0。手で直した値があればその値) */
  carryFrom: string;
  /** 手で直した前日繰越 (店舗 → 日付 → 枚数。settings の id = schedule_day_carry) */
  carryFix: Partial<Record<StoreId, Record<string, number>>>;
  stores: Partial<Record<StoreId, DayLoadStore>>;
  updatedAt?: string;
}

/** 1 件で数える予定に選べる種類 (設定の画面) */
export const PER_EVENT_OPTIONS: ScheduleKind[] = ["survey", "site_survey", "site", "visit", "meeting"];

export const DAY_LOAD_DEFAULTS: Omit<DayLoadSettings, "stores" | "carryFix"> = {
  perPerson: 11,
  weights: { tatami: 1, fusuma: 1, shoji: 0.5, amido: 0.5 },
  countDelivery: false,
  perEventKinds: ["survey", "site_survey", "site"],
  perEvent: 3,
  subtractLeave: true,
  carry: true,
  carryFrom: CARRY_FROM_DEFAULT,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const numIn = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : undefined;
};

/** 手で直した前日繰越の読み込み (壊れた値・知らない店舗は除く) */
export function readCarryFix(db: Pick<Database, "settings" | "stores">): DayLoadSettings["carryFix"] {
  const raw = ((db.settings ?? []).find((s) => s.id === DAY_CARRY_ID)?.value ?? {}) as Record<string, Record<string, unknown>>;
  const out: DayLoadSettings["carryFix"] = {};
  for (const s of db.stores) {
    const r = raw[s.id];
    if (!r || typeof r !== "object") continue;
    const days: Record<string, number> = {};
    for (const [d, v] of Object.entries(r)) {
      const n = numIn(v, 0, 9999);
      if (DATE_RE.test(d) && n !== undefined) days[d] = n;
    }
    if (Object.keys(days).length) out[s.id] = days;
  }
  return out;
}

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
  const kinds = Array.isArray(v.perEventKinds) ? v.perEventKinds.filter((k): k is ScheduleKind => typeof k === "string" && k in SCHEDULE_KIND && k !== "leave") : undefined;
  return {
    perPerson: numIn(v.perPerson, 1, 99) ?? DAY_LOAD_DEFAULTS.perPerson,
    weights: Object.fromEntries(SHEET_ITEMS.map((k) => [k, numIn(w[k], 0, 10) ?? DAY_LOAD_DEFAULTS.weights[k]])) as LoadWeights,
    countDelivery: typeof v.countDelivery === "boolean" ? v.countDelivery : DAY_LOAD_DEFAULTS.countDelivery,
    perEventKinds: kinds ? [...new Set(kinds)] : [...DAY_LOAD_DEFAULTS.perEventKinds],
    perEvent: numIn(v.perEvent, 0, 99) ?? DAY_LOAD_DEFAULTS.perEvent,
    subtractLeave: typeof v.subtractLeave === "boolean" ? v.subtractLeave : DAY_LOAD_DEFAULTS.subtractLeave,
    carry: typeof v.carry === "boolean" ? v.carry : DAY_LOAD_DEFAULTS.carry,
    carryFrom: typeof v.carryFrom === "string" && DATE_RE.test(v.carryFrom) ? v.carryFrom : DAY_LOAD_DEFAULTS.carryFrom,
    carryFix: readCarryFix(db),
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

/** 枚数を作業量に数える種類 (左の欄)。採寸は新調の枚数 (「新」の欄) */
const COUNT_LEFT = new Set<ScheduleKind>(["pickup", "onsite_quote", "install", "measure"]);

/**
 * 行の数え方: count = 枚数を出して数える / fixed = 1 件 = 設定の枚数 (見積・現調・現場管理。枚数の欄には出さない) /
 * info = 数えない (訪問・会議・社内の予定。枚数の欄には出さない)。納品 (右の欄) は枚数を出し、設定で数える。
 * 仮押さえは数えない (枚数・1 件の換算は灰色で出す)
 */
export type RowMode = "count" | "fixed" | "info";

export function rowMode(kind: ScheduleKind, set: Pick<DayLoadSettings, "perEventKinds">): RowMode {
  if (kind === "delivery" || COUNT_LEFT.has(kind)) return "count";
  if (set.perEventKinds.includes(kind)) return "fixed";
  return "info";
}

export function countsToward(e: Pick<ScheduleEvent, "id" | "kind">, set: Pick<DayLoadSettings, "countDelivery" | "perEventKinds">): boolean {
  if (e.id.startsWith("hold:")) return false;
  if (e.kind === "delivery") return set.countDelivery;
  return rowMode(e.kind, set) !== "info";
}

/** 採寸の枚数 = 新調。明細などで 表 と 新 が分かっていれば 新 だけ (表替えは引き取りの日に数える)、分からなければすべて 新 */
export function measureCols(c: SheetCols): SheetCols {
  const anyFresh = SHEET_ITEMS.some((k) => c[k].fresh > 0);
  const out = emptyCols();
  for (const k of SHEET_ITEMS) out[k] = { omote: 0, fresh: anyFresh ? c[k].fresh : r1(c[k].omote + c[k].fresh) };
  return out;
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
  mode: RowMode;
  /** 枚数の欄 (mode = count のときだけ。fixed・info は空) */
  cols: SheetCols;
  /** 1 件で数える予定の換算枚数 (mode = fixed) */
  fixed?: number;
  /** 作業量に数える */
  counted: boolean;
  remark: string;
  hold: boolean;
}

/** 前日繰越 (manual = 手で直した値) */
export interface CarryIn {
  value: number;
  manual: boolean;
}

export interface StoreSheet {
  storeId: StoreId;
  rows: SheetRow[];
  /** 欄ごとの合計 (左は作業量に数える行、右は納品の行すべて) */
  totals: Record<SheetSide, SheetCols>;
  /** 作業量に数える枚数 (左の合計 + 設定で右) */
  counted: SheetCols;
  /** 1 件で数える予定 (見積・現調・現場管理) の件数と換算枚数 */
  fixed: { events: number; load: number };
  /** その日の換算作業量 (枚数の換算 + 見積などの件数 × 3)。前日繰越を含まない */
  dayWorkload: number;
  /** 前日繰越 (繰り越しを数えない設定・本部・数え始める日より前は undefined) */
  carry?: CarryIn;
  /** 作業量の合計 = その日の換算作業量 + 前日繰越 */
  workload: number;
  capacity?: StoreCapacity;
  /** 対応可能枚数を超えた枚数 (超えていなければ 0) = 翌日への繰越 */
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
  /** 前日繰越 (carrySeries) */
  carry?: CarryIn;
}

const MEMO_MAX = 80;

/** 移行した予定表のメモの 1 行目 (枚数の欄「畳 表替え6・新調2 / 襖 張替3」) */
const COUNT_LINE_RE = /^(畳|襖|障子|網戸) (表替え|張替|新調|新)\d/;

/** メモの本文 (移行した予定表は 1 行目の枚数の欄を除く) */
export function memoBody(e: Pick<ScheduleEvent, "memo" | "source">): string {
  const lines = (e.memo ?? "").split("\n");
  return (e.source === "import" && COUNT_LINE_RE.test(lines[0] ?? "") ? lines.slice(1) : lines).join(" ").replace(/\s+/g, " ").trim();
}

/** 枚数の短い文 (畳6・襖2)。数えない予定の備考に出す */
function countsNote(c: SheetCols): string {
  return SHEET_ITEMS.filter((k) => itemTotal(c, k) > 0)
    .map((k) => `${SHEET_ITEM_LABEL[k]}${c[k].fresh && !c[k].omote ? "新" : ""}${sheetNum(itemTotal(c, k))}`)
    .join("・");
}

/** 備考: メモ (移行した予定表は 1 行目の枚数の欄を除く)・リフォームなどの施工・へり無し畳・カーテン・仮押さえ・見積などの内容 */
export function remarkOf(e: ScheduleEvent, c: WorkCounts | undefined, contentNote?: string): string {
  const parts: string[] = [];
  if (e.id.startsWith("hold:")) parts.push("仮押さえ");
  if (e.kind === "install" || e.kind === "site") parts.push(`${SCHEDULE_KIND[e.kind].short}: ${e.title.replace(/^\[[^\]]*\]\s*/, "")}`);
  if (contentNote) parts.push(`内容 ${contentNote}`);
  if (c?.herinashiSeen) parts.push(`縁無${c.herinashiHalf ? "半" : ""}${c.herinashi > 0 ? c.herinashi : ""}`);
  if (c && (c.curtain > 0 || c.seen.curtain)) parts.push(`カーテン${c.curtain > 0 ? c.curtain : ""}`);
  const memo = memoBody(e);
  if (memo) parts.push(memo);
  const text = parts.join(" / ");
  return text.length > MEMO_MAX ? `${text.slice(0, MEMO_MAX - 1)}…` : text;
}

const BAND_ORDER: Record<SheetBand, number> = { am: 0, pm: 1, none: 2 };

function sheetRow(e: ScheduleEvent, day: string, input: Pick<SheetInput, "work" | "label" | "set">): SheetRow {
  const c = input.work.get(e.id);
  const lb = input.label(e);
  const hold = e.id.startsWith("hold:");
  const mode = rowMode(e.kind, input.set);
  const raw = colsOf(c);
  const cols = mode !== "count" ? emptyCols() : e.kind === "measure" ? measureCols(raw) : raw;
  // 見積などの予定に枚数が分かっていれば、作業量の枚数とは別に備考に (移行した予定表のメモはそのまま備考に出るので足さない)
  // 予定表で手入力した自由な作業内容 (「養生、廃材撤去」など) はそのまま備考の「内容」に
  const contentNote = workNoteOf(e) ?? (mode !== "count" && e.source !== "import" ? countsNote(raw) : undefined);
  return {
    event: e,
    side: sideOf(e.kind),
    band: bandOf(e),
    time: sheetTime(e, day),
    town: lb.area,
    site: lb.name,
    mode,
    cols,
    ...(mode === "fixed" ? { fixed: input.set.perEvent } : {}),
    counted: countsToward(e, input.set),
    remark: remarkOf(e, c, contentNote || undefined),
    hold,
  };
}

export function buildStoreSheet(input: SheetInput): StoreSheet {
  const { day, storeId, set } = input;
  const dayEvents = input.events.filter((e) => occursOn(e, day));
  const leaves = dayEvents.filter((e) => e.kind === "leave");
  const rows: SheetRow[] = dayEvents
    .filter((e) => e.kind !== "leave")
    .map((e) => sheetRow(e, day, input))
    .sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || compareInDay(a.event, b.event));
  const totals: Record<SheetSide, SheetCols> = { left: emptyCols(), right: emptyCols() };
  let counted = emptyCols();
  const fixed = { events: 0, load: 0 };
  for (const r of rows) {
    if (r.side === "left" ? r.counted : !r.hold) totals[r.side] = addCols(totals[r.side], r.cols);
    if (!r.counted) continue;
    if (r.mode === "fixed") {
      fixed.events += 1;
      fixed.load = r1(fixed.load + (r.fixed ?? 0));
    } else counted = addCols(counted, r.cols);
  }
  const dayWorkload = r1(workload(counted, set.weights) + fixed.load);
  const capacity = storeCapacity(input.db, set, storeId, day, input.capacityEvents ?? input.events, input.closed);
  const carry = capacity && input.carry ? input.carry : undefined;
  const total = r1(dayWorkload + (carry?.value ?? 0));
  const over = capacity ? Math.max(0, r1(total - capacity.capacity)) : 0;
  return { storeId, rows, totals, counted, fixed, dayWorkload, carry, workload: total, capacity, over, leaves };
}

/** 週・月の表示の日ごとの作業量の目安 (店舗を選んだときの見出しの「作業 18/22」)。workload = その日の分 + 前日繰越 */
export interface DayLoad {
  /** その日の換算作業量 (前日繰越を含まない) */
  dayWorkload: number;
  carry: number;
  workload: number;
  capacity: number;
  over: number;
}

export function dayLoad(input: Omit<SheetInput, "label">): DayLoad | undefined {
  const s = buildStoreSheet({ ...input, label: () => ({ name: "" }) });
  if (!s.capacity) return undefined;
  return { dayWorkload: s.dayWorkload, carry: s.carry?.value ?? 0, workload: s.workload, capacity: s.capacity.capacity, over: s.over };
}

/* ---------------- 前日繰越 ---------------- */

/**
 * 繰り越しを数え始める日 (この日の前日繰越は 0 か手で直した値)。day 以前で一番近い 手で直した日 → 数え始める日 (設定)。
 * 最大 CARRY_MAX_DAYS 日前まで。繰り越さない設定・数え始める日より前は undefined
 */
export function carryStart(set: Pick<DayLoadSettings, "carry" | "carryFrom" | "carryFix">, storeId: StoreId, day: string): string | undefined {
  if (!set.carry || day < set.carryFrom) return undefined;
  const fixes = Object.keys(set.carryFix[storeId] ?? {})
    .filter((d) => d <= day && d >= set.carryFrom)
    .sort();
  const start = fixes.at(-1) ?? set.carryFrom;
  const floor = addDays(day, -CARRY_MAX_DAYS);
  return start < floor ? floor : start;
}

/**
 * from 〜 to の日ごとの前日繰越。loadOf(d) = その日の換算作業量 (前日繰越を含まない) と対応可能枚数 (本部は undefined)。
 * 繰越 (d + 1) = 手で直した値、なければ max(0, 換算作業量 (d) + 繰越 (d) − 対応可能枚数 (d))
 */
export function carrySeries(input: {
  set: Pick<DayLoadSettings, "carry" | "carryFrom" | "carryFix">;
  storeId: StoreId;
  from: string;
  to: string;
  loadOf: (d: string) => Pick<DayLoad, "dayWorkload" | "capacity"> | undefined;
}): Map<string, CarryIn> {
  const { set, storeId, from, to } = input;
  const out = new Map<string, CarryIn>();
  if (!set.carry || to < set.carryFrom) return out;
  const fix = set.carryFix[storeId] ?? {};
  let d = from < set.carryFrom ? set.carryFrom : carryStart(set, storeId, from)!;
  let carry = 0;
  for (; d <= to; d = addDays(d, 1)) {
    const manual = fix[d] !== undefined;
    if (manual) carry = fix[d];
    if (d >= from) out.set(d, { value: r1(carry), manual });
    if (d === to) break;
    const l = input.loadOf(d);
    if (!l) return new Map();
    carry = Math.max(0, r1(l.dayWorkload + carry - l.capacity));
  }
  return out;
}

/** 店舗の日ごとのその日の換算作業量 (前日繰越の計算用。events = その店舗の予定、leaves = 休暇の予定。日ごとに覚える) */
export function storeLoadOf(input: {
  db: Pick<Database, "users" | "stores">;
  set: DayLoadSettings;
  storeId: StoreId;
  events: ScheduleEvent[];
  leaves: ScheduleEvent[];
  work: Map<string, WorkCounts>;
  closed: (d: string) => boolean;
}): (d: string) => DayLoad | undefined {
  const cache = new Map<string, DayLoad | undefined>();
  return (d) => {
    if (!cache.has(d))
      cache.set(d, dayLoad({ day: d, storeId: input.storeId, events: input.events.filter((e) => occursOn(e, d)), capacityEvents: input.leaves, work: input.work, set: input.set, db: input.db, closed: input.closed(d) }));
    return cache.get(d);
  };
}

/** 数の表示 (0 は空。小数は 1 桁) */
export const sheetNum = (n: number): string => (n ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : "");

/** 換算作業量の式「畳 8 + 襖 3 + 障子 4×0.5 + 網戸 2×0.5 + 見積など 2件×3」 */
export function workloadFormula(c: SheetCols, w: LoadWeights, fixed?: { events: number; per: number }): string {
  const parts = SHEET_ITEMS.filter((k) => itemTotal(c, k) > 0).map((k) => `${SHEET_ITEM_LABEL[k]} ${sheetNum(itemTotal(c, k))}${w[k] !== 1 ? `×${w[k]}` : ""}`);
  if (fixed && fixed.events > 0) parts.push(`見積など ${fixed.events}件×${sheetNum(fixed.per) || "0"}`);
  return parts.join(" + ") || "0";
}

/** 1 件で数える予定の種類の名前 (見積・現調・現場管理) */
export const perEventKindsLabel = (kinds: ScheduleKind[]): string => kinds.map((k) => SCHEDULE_KIND[k]?.short ?? k).join("・") || "なし";

/* ---------------- 設定の保存 (画面の操作と運用の手直しで共通) ---------------- */

/** 保存する値 (人数の上書き・対象外は店舗ごと。空の店舗は書かない) */
export function dayLoadValue(set: DayLoadSettings): Record<string, unknown> {
  const stores: Record<string, unknown> = {};
  for (const [id, st] of Object.entries(set.stores)) {
    if (!st) continue;
    if (!st.excludeUserIds.length && st.people === undefined) continue;
    stores[id] = { excludeUserIds: st.excludeUserIds, ...(st.people !== undefined ? { people: st.people } : {}) };
  }
  return {
    perPerson: set.perPerson,
    weights: set.weights,
    countDelivery: set.countDelivery,
    perEventKinds: set.perEventKinds,
    perEvent: set.perEvent,
    subtractLeave: set.subtractLeave,
    carry: set.carry,
    carryFrom: set.carryFrom,
    stores,
  };
}

/** 変更履歴の項目 (変更前 → 変更後)。社員は名前で書く */
export function dayLoadChanges(db: Pick<Database, "users" | "stores">, before: DayLoadSettings, after: DayLoadSettings): { field: string; before: unknown; after: unknown }[] {
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;
  const flat = (s: DayLoadSettings): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      "1 人の対応可能枚数": s.perPerson,
      納品も数える: s.countDelivery ? "数える" : "数えない",
      "1 件で数える予定": perEventKindsLabel(s.perEventKinds),
      "見積など 1 件の換算": s.perEvent,
      休暇を引く: s.subtractLeave ? "引く" : "引かない",
      前日繰越: s.carry ? "繰り越す" : "繰り越さない",
      繰り越しを数え始める日: s.carryFrom,
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

/** 手で直した前日繰越を書く (value = undefined で自動に戻す。mutate の中で呼ぶ)。CARRY_MAX_DAYS より古い手直しは消す */
export function writeCarryFix(db: Pick<Database, "settings" | "stores">, storeId: StoreId, day: string, value: number | undefined, userId: string, now: string, today: string) {
  const all = readCarryFix(db);
  const days = { ...(all[storeId] ?? {}) };
  if (value === undefined) delete days[day];
  else days[day] = Math.round(value * 10) / 10;
  all[storeId] = days;
  const floor = addDays(today, -CARRY_MAX_DAYS * 2);
  const out: Record<string, Record<string, number>> = {};
  for (const [id, m] of Object.entries(all)) {
    const kept = Object.fromEntries(Object.entries(m ?? {}).filter(([d]) => d >= floor));
    if (Object.keys(kept).length) out[id] = kept;
  }
  const row = db.settings.find((s) => s.id === DAY_CARRY_ID);
  if (row) Object.assign(row, { value: out, updatedBy: userId, updatedAt: now });
  else db.settings.push({ id: DAY_CARRY_ID, value: out, updatedBy: userId, updatedAt: now });
}
