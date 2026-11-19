import type { Database, Role, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { normTime } from "@/lib/calendar";

/**
 * 予定の計画のマスタ (settings に保存。画面は 予定表 →「仕事量と提案の設定」)
 * ------------------------------------------------------------
 * - 作業種別 (畳 表替え・襖 張替…): 現場の標準時間・人数・技能・車両・製造の工程と 1 枚あたりの時間・製造日数・材料
 * - 製造工程: 店舗 (作業場) ごとの 1 日の処理能力 (分)
 * - 技能: 社員ごとの熟練度 (1 = 見習い・2 = 一人前・3 = 熟練)
 * - 社員の勤務と技能: 勤務曜日・時間・休憩・1 日の最大作業時間・連続勤務・残業の上限・運転・応援できる店舗・同行の条件
 * - 車両・設備・工具: 店舗ごと。予約は resource_bookings
 * - 経路: 移動時間の求め方 (社内の計算 / Google の経路。お客様の住所を社外に送らない方針の確認つき)
 * - 最適化の重み: 何を重視するか (移動・早さ・負担の偏り・応援・お客様の希望・優先度…)。検証 (backtest.ts) で調整できる
 * 値は一畳屋の確認前の「暫定」(provisional) を初期値として持ち、画面で確認・変更すると「確認済み」になる
 */

export const MASTER_IDS = {
  workTypes: "scheduling_work_types",
  processes: "scheduling_processes",
  skills: "scheduling_skills",
  staff: "scheduling_staff",
  resources: "scheduling_resources",
  routing: "scheduling_routing",
  weights: "scheduling_weights",
  rules: "scheduling_rules",
} as const;

export type WorkCategory = "tatami" | "fusuma" | "shoji" | "amido" | "reform" | "other";
export const WORK_CATEGORY_LABEL: Record<WorkCategory, string> = { tatami: "畳", fusuma: "襖", shoji: "障子", amido: "網戸", reform: "リフォーム・施工", other: "その他" };

/** 現場の作業時間 = base + perUnit × 数量 (分) */
export type SiteMinutes = Partial<Record<ScheduleKind, [base: number, perUnit: number]>>;

export interface WorkType {
  id: string;
  name: string;
  category: WorkCategory;
  unit: string;
  /** 予定の件名・メモ・明細の品名で見分ける言葉 (例: 表替え) */
  keywords: string[];
  site: SiteMinutes;
  staffCount: number;
  skills: string[];
  /** 必要な車両・設備の種類 (Resource.type) */
  resourceKinds: string[];
  /** 製造の工程 (順番どおり)。processKey は Process.key */
  processes: { processKey: string; minutesPerUnit: number }[];
  /** 引き取りから納品までの最短の日数 (乾燥・材料の取り寄せを含む)。0 = 製造なし・当日 */
  leadDays: number;
  /** 1 単位あたりの材料 (管理会計の材料 materials の ID) */
  materials: { materialId: string; qtyPerUnit: number }[];
  provisional: boolean;
  active: boolean;
  sort: number;
}

export interface Process {
  id: string;
  /** 工程の種類 (WorkType.processes の processKey) */
  key: string;
  name: string;
  /** 作業場の店舗 */
  storeId: StoreId;
  /** この作業場が受け持つ店舗 (空 = 自店舗だけ) */
  servesStores: StoreId[];
  /** 1 日の処理能力 (分)。空 = 店舗の「畳の製造の枚数」の上限から計算 (畳の工程) */
  minutesPerDay?: number;
  /** 作業する曜日 (空 = 休業日以外) */
  workdays: number[];
  /** 製造の担当者 */
  staffIds: string[];
  provisional: boolean;
  active: boolean;
}

export interface Skill {
  id: string;
  name: string;
}

export type SkillLevel = 1 | 2 | 3;
export const SKILL_LEVEL_LABEL: Record<SkillLevel, string> = { 1: "見習い", 2: "一人前", 3: "熟練" };

export interface StaffProfile {
  userId: string;
  /** 技能と熟練度 */
  skills: Record<string, SkillLevel>;
  /** 勤務する曜日 (0 = 日〜6 = 土) */
  workDays: number[];
  workStart?: string;
  workEnd?: string;
  breakMinutes: number;
  /** 1 日の最大作業時間 (移動を含む。分) */
  maxMinutesPerDay: number;
  /** 1 日の最大件数 (空 = 店舗の設定) */
  maxEventsPerDay?: number;
  /** 連続して勤務できる日数 */
  maxConsecutiveDays: number;
  /** 月の残業の上限 (分)。所定の時間を超える予定の合計 */
  overtimeCapMonthly: number;
  canDrive: boolean;
  /** 現場に出る (現地調査・引き取り・納品・施工) */
  fieldWork: boolean;
  /** 製造の担当 */
  production: boolean;
  /** 応援に行ける店舗 */
  supportStores: StoreId[];
  /** 一人では行かない (新人など。同行する人が必要) */
  needsCompanion: boolean;
  /** 同行できる人 (空 = 熟練度 3 の人なら誰でも) */
  mentorIds: string[];
  note?: string;
  updatedAt?: string;
}

export type ResourceKind = "vehicle" | "machine" | "tool";
export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = { vehicle: "車両", machine: "機械・設備", tool: "工具" };

export interface Resource {
  id: string;
  name: string;
  kind: ResourceKind;
  /** 種類 (WorkType.resourceKinds で使う。例: truck = 畳を運べる車) */
  type: string;
  storeId: StoreId;
  /** 積める数 (畳の枚数など。空 = 制限なし) */
  capacityUnits?: number;
  /** 運転に必要な免許の説明 */
  license?: string;
  active: boolean;
  note?: string;
}

export const RESOURCE_TYPES: { type: string; label: string; kind: ResourceKind }[] = [
  { type: "truck", label: "トラック (畳・建具を運ぶ)", kind: "vehicle" },
  { type: "van", label: "バン・ワゴン", kind: "vehicle" },
  { type: "car", label: "営業車", kind: "vehicle" },
  { type: "tatami_machine", label: "畳の製造機", kind: "machine" },
  { type: "fusuma_bench", label: "襖・障子の作業台", kind: "machine" },
  { type: "tool_set", label: "施工の工具一式", kind: "tool" },
];

export type RoutingProvider = "local" | "google";

export interface RoutingSettings {
  provider: RoutingProvider;
  /** お客様の住所 (位置) を社外の経路サービスに送ることの社内の承認 */
  policy: { approved: boolean; by?: string; at?: string; note?: string };
  /** 送る位置の細かさ: area = 町名の中心 (個人の家は分からない) / exact = 地図で確かめた家の位置 */
  precision: "area" | "exact";
  /** 1 か月の経路の問い合わせ (出発地 × 到着地の組) の上限 */
  monthlyElementLimit: number;
  /** 時間帯の混雑を反映する (Google の交通状況) */
  trafficAware: boolean;
  /** 社内の計算: 熊本市内の朝夕の混雑で遅くなる割合 (1.25 = 25% 遅い) */
  rushFactor: number;
}

export interface Weights {
  /** 移動の効率 */
  route: number;
  /** 店舗の空き */
  capacity: number;
  /** 製造の空き */
  production: number;
  /** 担当者の負担の偏りの少なさ */
  staff: number;
  /** 早さ */
  earliness: number;
  /** 経験・熟練度 */
  experience: number;
  /** お客様の希望 */
  preference: number;
  /** 期限・優先度 (遅れの少なさ) */
  deadline: number;
  /** 他店舗の応援の少なさ (減点) */
  help: number;
  /** 残業の少なさ (減点) */
  overtime: number;
  /** 既存の予定を動かす (減点。全体の最適化で使う) */
  move: number;
}

export interface WeightSettings extends Weights {
  /** 最適化で最も重視する指標 (画面の説明と、検証の調整の目的) */
  focus: "balanced" | "travel" | "speed" | "deadline" | "revenue";
  tunedAt?: string;
  tunedBy?: string;
  tuneNote?: string;
}

export interface PlanRules {
  /** 引き取りの翌日から製造する (false = 引き取りの日から) */
  productionStartsNextDay: boolean;
  /** 製造が終わってから納品できるまでの日数 */
  deliveryGapDays: number;
  /** 仮押さえの有効な日数 */
  holdDays: number;
  /** 引き取りから納品までの標準の日数 (作業種別に製造日数がないとき) */
  standardTurnaroundDays: number;
  /** 緊急の案件: この日数以内の期限は「緊急」として扱う */
  urgentWithinDays: number;
  /** お客様の希望を優先する基準: 希望の日に入らないとき、希望から何日までなら提案するか (soft のとき) */
  preferenceToleranceDays: number;
}

export const DEFAULT_RULES: PlanRules = { productionStartsNextDay: true, deliveryGapDays: 0, holdDays: 3, standardTurnaroundDays: 2, urgentWithinDays: 3, preferenceToleranceDays: 7 };

export const DEFAULT_WEIGHTS: WeightSettings = {
  route: 0.25,
  capacity: 0.15,
  production: 0.1,
  staff: 0.12,
  earliness: 0.18,
  experience: 0.05,
  preference: 0.1,
  deadline: 0.05,
  help: 0.08,
  overtime: 0.06,
  move: 0.1,
  focus: "balanced",
};

export const WEIGHT_LABEL: Record<keyof Weights, string> = {
  route: "移動の効率",
  capacity: "店舗の空き",
  production: "製造の空き",
  staff: "担当者の負担の偏り",
  earliness: "早さ (お客様を待たせない)",
  experience: "経験・熟練度",
  preference: "お客様の希望",
  deadline: "期限・優先度",
  help: "他店舗の応援 (減点)",
  overtime: "残業 (減点)",
  move: "既存の予定の移動 (減点)",
};

export const DEFAULT_ROUTING: RoutingSettings = { provider: "local", policy: { approved: false }, precision: "area", monthlyElementLimit: 20000, trafficAware: false, rushFactor: 1.25 };

export const DEFAULT_SKILLS: Skill[] = [
  { id: "survey", name: "現地調査・見積" },
  { id: "tatami_make", name: "畳の製作" },
  { id: "tatami_lay", name: "畳の敷き込み" },
  { id: "fusuma", name: "襖の張替" },
  { id: "shoji", name: "障子の張替" },
  { id: "amido", name: "網戸の張替" },
  { id: "reform", name: "リフォームの施工" },
];

const W = (x: Omit<WorkType, "provisional" | "active" | "materials"> & Partial<Pick<WorkType, "materials">>): WorkType => ({ materials: [], provisional: true, active: true, ...x });

/** 作業種別の初期値 (暫定。一畳屋の標準工数を入れるまでの目安) */
export const DEFAULT_WORK_TYPES: WorkType[] = [
  W({ id: "tatami_omote", name: "畳 表替え", category: "tatami", unit: "枚", keywords: ["表替え", "表替", "おもてがえ", "表換"], site: { pickup: [20, 3], delivery: [30, 4], measure: [30, 2] }, staffCount: 1, skills: ["tatami_lay"], resourceKinds: ["truck"], processes: [{ processKey: "tatami", minutesPerUnit: 30 }], leadDays: 1, sort: 10 }),
  W({ id: "tatami_ura", name: "畳 裏返し", category: "tatami", unit: "枚", keywords: ["裏返し", "裏返"], site: { pickup: [20, 3], delivery: [30, 4] }, staffCount: 1, skills: ["tatami_lay"], resourceKinds: ["truck"], processes: [{ processKey: "tatami", minutesPerUnit: 25 }], leadDays: 1, sort: 20 }),
  W({ id: "tatami_new", name: "畳 新調", category: "tatami", unit: "枚", keywords: ["新調", "新床", "新畳"], site: { measure: [40, 3], pickup: [20, 3], delivery: [30, 5] }, staffCount: 1, skills: ["tatami_make", "tatami_lay"], resourceKinds: ["truck"], processes: [{ processKey: "tatami", minutesPerUnit: 60 }], leadDays: 3, sort: 30 }),
  W({ id: "fusuma", name: "襖 張替", category: "fusuma", unit: "枚", keywords: ["襖", "ふすま"], site: { pickup: [20, 3], delivery: [20, 4] }, staffCount: 1, skills: ["fusuma"], resourceKinds: ["truck"], processes: [{ processKey: "fusuma", minutesPerUnit: 40 }], leadDays: 2, sort: 40 }),
  W({ id: "shoji", name: "障子 張替", category: "shoji", unit: "枚", keywords: ["障子"], site: { pickup: [20, 2], delivery: [20, 3] }, staffCount: 1, skills: ["shoji"], resourceKinds: ["truck"], processes: [{ processKey: "fusuma", minutesPerUnit: 30 }], leadDays: 2, sort: 50 }),
  W({ id: "amido", name: "網戸 張替", category: "amido", unit: "枚", keywords: ["網戸"], site: { pickup: [15, 2], delivery: [15, 3], install: [30, 10] }, staffCount: 1, skills: ["amido"], resourceKinds: ["van"], processes: [{ processKey: "amido", minutesPerUnit: 20 }], leadDays: 1, sort: 60 }),
  W({ id: "reform", name: "リフォーム・施工", category: "reform", unit: "式", keywords: ["リフォーム", "フローリング", "クロス", "施工"], site: { install: [360, 0], survey: [60, 0] }, staffCount: 2, skills: ["reform"], resourceKinds: ["van"], processes: [], leadDays: 0, sort: 70 }),
];

export const PROCESS_KEYS: { key: string; name: string; perUnit: number }[] = [
  { key: "tatami", name: "畳の製造", perUnit: 30 },
  { key: "fusuma", name: "襖・障子の張替", perUnit: 35 },
  { key: "amido", name: "網戸の張替", perUnit: 20 },
];

/* ================================================================== */
/* 読み込み (壊れた値は使わず初期値)                                         */
/* ================================================================== */

type SettingsDb = Pick<Database, "settings" | "stores" | "users">;

const settingOf = (db: Pick<Database, "settings">, id: string): Record<string, unknown> | undefined => (db.settings ?? []).find((s) => s.id === id)?.value;
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, max = 80): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const numIn = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const strs = (v: unknown, max = 30): string[] => arr<unknown>(v).map((x) => str(x, 60)).filter((x): x is string => Boolean(x)).slice(0, max);
const days = (v: unknown): number[] => [...new Set(arr<unknown>(v).map((x) => numIn(x, 0, 6)).filter((x): x is number => x !== undefined).map(Math.round))].sort();

function readWorkType(raw: Record<string, unknown>, sort: number): WorkType | undefined {
  const id = str(raw.id, 40);
  const name = str(raw.name, 40);
  if (!id || !name) return undefined;
  const category = (Object.keys(WORK_CATEGORY_LABEL) as WorkCategory[]).find((c) => c === raw.category) ?? "other";
  const site: SiteMinutes = {};
  for (const [k, v] of Object.entries((raw.site as Record<string, unknown>) ?? {})) {
    if (!Array.isArray(v)) continue;
    const base = numIn(v[0], 0, 1440);
    const per = numIn(v[1], 0, 600);
    if (base !== undefined && per !== undefined) site[k as ScheduleKind] = [Math.round(base), per];
  }
  return {
    id,
    name,
    category,
    unit: str(raw.unit, 8) ?? "枚",
    keywords: strs(raw.keywords, 12),
    site,
    staffCount: Math.round(numIn(raw.staffCount, 1, 6) ?? 1),
    skills: strs(raw.skills),
    resourceKinds: strs(raw.resourceKinds),
    processes: arr<Record<string, unknown>>(raw.processes)
      .map((p) => ({ processKey: str(p.processKey, 40) ?? "", minutesPerUnit: numIn(p.minutesPerUnit, 0, 1440) ?? 0 }))
      .filter((p) => p.processKey && p.minutesPerUnit > 0),
    leadDays: Math.round(numIn(raw.leadDays, 0, 60) ?? 0),
    materials: arr<Record<string, unknown>>(raw.materials)
      .map((m) => ({ materialId: str(m.materialId, 60) ?? "", qtyPerUnit: numIn(m.qtyPerUnit, 0, 10000) ?? 0 }))
      .filter((m) => m.materialId && m.qtyPerUnit > 0),
    provisional: raw.provisional !== false,
    active: raw.active !== false,
    sort: Math.round(numIn(raw.sort, 0, 10000) ?? sort),
  };
}

export function readWorkTypes(db: Pick<Database, "settings">): WorkType[] {
  const v = settingOf(db, MASTER_IDS.workTypes);
  if (!v) return DEFAULT_WORK_TYPES;
  const list = arr<Record<string, unknown>>(v.items)
    .map((x, i) => readWorkType(x, i * 10))
    .filter((x): x is WorkType => Boolean(x));
  return (list.length ? list : DEFAULT_WORK_TYPES).sort((a, b) => a.sort - b.sort);
}

export function readSkills(db: Pick<Database, "settings">): Skill[] {
  const v = settingOf(db, MASTER_IDS.skills);
  const list = arr<Record<string, unknown>>(v?.items)
    .map((x) => ({ id: str(x.id, 40) ?? "", name: str(x.name, 40) ?? "" }))
    .filter((x) => x.id && x.name);
  return list.length ? list : DEFAULT_SKILLS;
}

/** 製造工程 (設定がなければ、店舗ごとに畳・襖障子・網戸の工程を暫定で持つ) */
export function readProcesses(db: Pick<Database, "settings" | "stores">): Process[] {
  const v = settingOf(db, MASTER_IDS.processes);
  const storeIds = new Set(db.stores.map((s) => s.id));
  const list = arr<Record<string, unknown>>(v?.items)
    .map((x): Process | undefined => {
      const id = str(x.id, 60);
      const key = str(x.key, 40);
      const storeId = str(x.storeId, 20) as StoreId | undefined;
      if (!id || !key || !storeId || !storeIds.has(storeId)) return undefined;
      const mpd = numIn(x.minutesPerDay, 0, 100000);
      return {
        id,
        key,
        name: str(x.name, 40) ?? key,
        storeId,
        servesStores: strs(x.servesStores).filter((s) => storeIds.has(s as StoreId)) as StoreId[],
        minutesPerDay: mpd === undefined ? undefined : Math.round(mpd),
        workdays: days(x.workdays),
        staffIds: strs(x.staffIds),
        provisional: x.provisional !== false,
        active: x.active !== false,
      };
    })
    .filter((x): x is Process => Boolean(x));
  if (list.length) return list;
  return db.stores
    .filter((s) => s.kind === "store" && !s.closedOn)
    .flatMap((s) => PROCESS_KEYS.map((p) => ({ id: `${s.id}_${p.key}`, key: p.key, name: p.name, storeId: s.id, servesStores: [], minutesPerDay: undefined, workdays: [], staffIds: [], provisional: true, active: true })));
}

/** 社員の勤務と技能の設定 (登録のない社員は undefined。defaultProfile で補う) */
export function readStaffProfiles(db: Pick<Database, "settings" | "users" | "stores">): Map<string, StaffProfile> {
  const v = settingOf(db, MASTER_IDS.staff);
  const raw = (v?.profiles ?? {}) as Record<string, Record<string, unknown>>;
  const out = new Map<string, StaffProfile>();
  const storeIds = new Set(db.stores.map((s) => s.id));
  for (const u of db.users) {
    const r = raw[u.id];
    if (!r) continue;
    const skills: Record<string, SkillLevel> = {};
    for (const [k, lv] of Object.entries((r.skills as Record<string, unknown>) ?? {})) {
      const n = numIn(lv, 1, 3);
      if (n) skills[k] = Math.round(n) as SkillLevel;
    }
    const wd = days(r.workDays);
    out.set(u.id, {
      userId: u.id,
      skills,
      workDays: wd.length ? wd : [1, 2, 3, 4, 5, 6],
      workStart: typeof r.workStart === "string" ? normTime(r.workStart) : undefined,
      workEnd: typeof r.workEnd === "string" ? normTime(r.workEnd) : undefined,
      breakMinutes: Math.round(numIn(r.breakMinutes, 0, 180) ?? 60),
      maxMinutesPerDay: Math.round(numIn(r.maxMinutesPerDay, 60, 960) ?? 480),
      maxEventsPerDay: numIn(r.maxEventsPerDay, 1, 20),
      maxConsecutiveDays: Math.round(numIn(r.maxConsecutiveDays, 1, 14) ?? 6),
      overtimeCapMonthly: Math.round(numIn(r.overtimeCapMonthly, 0, 10000) ?? 2700),
      canDrive: r.canDrive !== false,
      fieldWork: r.fieldWork !== false,
      production: r.production === true,
      supportStores: strs(r.supportStores).filter((s) => storeIds.has(s as StoreId)) as StoreId[],
      needsCompanion: r.needsCompanion === true,
      mentorIds: strs(r.mentorIds),
      note: str(r.note, 200),
      updatedAt: str(r.updatedAt, 40),
    });
  }
  return out;
}

const FIELD_ROLES: Role[] = ["store_staff", "store_manager"];

/** 設定のない社員の目安 (肩書きと役割から。暫定) */
export function defaultProfile(u: Pick<User, "id" | "role" | "title" | "storeId">): StaffProfile {
  const craft = /施工|職人/.test(u.title);
  const sales = /営業|店長|受付/.test(u.title) || u.role === "store_manager";
  const skills: Record<string, SkillLevel> = {};
  if (craft) for (const s of ["tatami_make", "tatami_lay", "fusuma", "shoji", "amido"]) skills[s] = 2;
  if (sales) skills.survey = 2;
  if (u.role === "store_manager") for (const s of ["tatami_lay", "fusuma", "shoji", "amido"]) skills[s] ??= 2;
  return {
    userId: u.id,
    skills,
    workDays: [1, 2, 3, 4, 5, 6],
    breakMinutes: 60,
    maxMinutesPerDay: 480,
    maxConsecutiveDays: 6,
    overtimeCapMonthly: 2700,
    canDrive: true,
    fieldWork: FIELD_ROLES.includes(u.role),
    production: craft,
    supportStores: [],
    needsCompanion: false,
    mentorIds: [],
  };
}

export function readResources(db: Pick<Database, "settings" | "stores">): Resource[] {
  const v = settingOf(db, MASTER_IDS.resources);
  const storeIds = new Set(db.stores.map((s) => s.id));
  return arr<Record<string, unknown>>(v?.items)
    .map((x): Resource | undefined => {
      const id = str(x.id, 60);
      const name = str(x.name, 60);
      const storeId = str(x.storeId, 20) as StoreId | undefined;
      const kind = (Object.keys(RESOURCE_KIND_LABEL) as ResourceKind[]).find((k) => k === x.kind);
      if (!id || !name || !storeId || !storeIds.has(storeId) || !kind) return undefined;
      const cap = numIn(x.capacityUnits, 1, 10000);
      return { id, name, kind, type: str(x.type, 40) ?? "car", storeId, capacityUnits: cap ? Math.round(cap) : undefined, license: str(x.license, 40), active: x.active !== false, note: str(x.note, 200) };
    })
    .filter((x): x is Resource => Boolean(x));
}

export function readRouting(db: Pick<Database, "settings">): RoutingSettings {
  const v = settingOf(db, MASTER_IDS.routing);
  if (!v) return DEFAULT_ROUTING;
  const policy = (v.policy ?? {}) as Record<string, unknown>;
  return {
    provider: v.provider === "google" ? "google" : "local",
    policy: { approved: policy.approved === true, by: str(policy.by, 60), at: str(policy.at, 40), note: str(policy.note, 300) },
    precision: v.precision === "exact" ? "exact" : "area",
    monthlyElementLimit: Math.round(numIn(v.monthlyElementLimit, 0, 1_000_000) ?? DEFAULT_ROUTING.monthlyElementLimit),
    trafficAware: v.trafficAware === true,
    rushFactor: numIn(v.rushFactor, 1, 2) ?? DEFAULT_ROUTING.rushFactor,
  };
}

export function readWeights(db: Pick<Database, "settings">): WeightSettings {
  const v = settingOf(db, MASTER_IDS.weights);
  if (!v) return DEFAULT_WEIGHTS;
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(WEIGHT_LABEL) as (keyof Weights)[]) {
    const n = numIn(v[k], 0, 1);
    if (n !== undefined) out[k] = n;
  }
  const focus = (["balanced", "travel", "speed", "deadline", "revenue"] as const).find((f) => f === v.focus);
  if (focus) out.focus = focus;
  out.tunedAt = str(v.tunedAt, 40);
  out.tunedBy = str(v.tunedBy, 60);
  out.tuneNote = str(v.tuneNote, 400);
  return out;
}

export function readRules(db: Pick<Database, "settings">): PlanRules {
  const v = settingOf(db, MASTER_IDS.rules);
  if (!v) return DEFAULT_RULES;
  return {
    productionStartsNextDay: v.productionStartsNextDay !== false,
    deliveryGapDays: Math.round(numIn(v.deliveryGapDays, 0, 14) ?? DEFAULT_RULES.deliveryGapDays),
    holdDays: Math.round(numIn(v.holdDays, 1, 30) ?? DEFAULT_RULES.holdDays),
    standardTurnaroundDays: Math.round(numIn(v.standardTurnaroundDays, 0, 30) ?? DEFAULT_RULES.standardTurnaroundDays),
    urgentWithinDays: Math.round(numIn(v.urgentWithinDays, 0, 30) ?? DEFAULT_RULES.urgentWithinDays),
    preferenceToleranceDays: Math.round(numIn(v.preferenceToleranceDays, 0, 60) ?? DEFAULT_RULES.preferenceToleranceDays),
  };
}

/** 計画に使うマスタ一式 (1 回の計算で 1 回だけ読む) */
export interface Masters {
  workTypes: WorkType[];
  workTypeById: Map<string, WorkType>;
  processes: Process[];
  skills: Skill[];
  profiles: Map<string, StaffProfile>;
  resources: Resource[];
  routing: RoutingSettings;
  weights: WeightSettings;
  rules: PlanRules;
  /** 設定された (暫定ではない) か */
  configured: { workTypes: boolean; processes: boolean; staff: boolean; resources: boolean; weights: boolean };
}

export function loadMasters(db: SettingsDb): Masters {
  const workTypes = readWorkTypes(db);
  return {
    workTypes,
    workTypeById: new Map(workTypes.map((w) => [w.id, w])),
    processes: readProcesses(db),
    skills: readSkills(db),
    profiles: readStaffProfiles(db),
    resources: readResources(db),
    routing: readRouting(db),
    weights: readWeights(db),
    rules: readRules(db),
    configured: {
      workTypes: Boolean(settingOf(db, MASTER_IDS.workTypes)),
      processes: Boolean(settingOf(db, MASTER_IDS.processes)),
      staff: Boolean(settingOf(db, MASTER_IDS.staff)),
      resources: Boolean(settingOf(db, MASTER_IDS.resources)),
      weights: Boolean(settingOf(db, MASTER_IDS.weights)),
    },
  };
}

/** 社員の設定 (なければ目安) */
export function profileOf(m: Masters, u: Pick<User, "id" | "role" | "title" | "storeId">): StaffProfile & { configured: boolean } {
  const p = m.profiles.get(u.id);
  return p ? { ...p, configured: true } : { ...defaultProfile(u), configured: false };
}

/** 文字 (件名・メモ・明細の品名) から作業種別を探す */
export function matchWorkType(m: Pick<Masters, "workTypes">, text: string, category?: WorkCategory): WorkType | undefined {
  const t = text.normalize("NFKC");
  const pool = m.workTypes.filter((w) => w.active && (!category || w.category === category));
  return pool.find((w) => w.keywords.some((k) => k && t.includes(k))) ?? (category ? pool[0] : undefined);
}
