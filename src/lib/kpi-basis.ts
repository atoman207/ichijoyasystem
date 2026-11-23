import type { Customer, Database, Order, ScheduleEvent, StoreId, SurveyResponse } from "@/lib/db/types";
import { countedOrder, deliveryOf, inPeriod, isCard, orderDate, surveyKpiDate, type Period } from "./kpi-core";

/**
 * KPI の分母と数え方 (スプレッドシート「お客様アンケート集計表」の KPI シートの集計基準に合わせる)
 * ------------------------------------------------------------
 * お客様のご要望 (2026-11-23「■9. KPI・インセンティブ集計」・2026-11-24「KPI・インセンティブ集計について」):
 *  - ハガキ返信率 = 戻ってきたハガキ件数 ÷ 個人件数 × 100。個人件数は年間チラシ計画「個人件数売上」の本年度実績の件数が基準。
 *    約 1 か月以内に同じお客様からリピート受注があったときは、最初の工事ではがきを渡し 2 回目は渡さないため、
 *    売上はそれぞれ数えるが返信率の分母は「1 件」(これまで手計算)。システムでは自動で数える:
 *    個人件数の自動の値 = 個人のお客様の案件 − リピート (同じお客様の、はがきを渡した案件から repeatDays 日以内の次の案件)。
 *    年間チラシ計画の値 (取込・手入力) がある月はその値 (手計算で調整済み) を使い、ない月 (新システムの月) は自動の値 (設定で いつも自動 にもできる)
 *  - クレーム・手直しポイント率 = (クレームポイント + 手直しポイント) ÷ 全案件数 × 100。全案件数は作業日報の納品件数をもとに手計算していた。
 *    システムでは 案件の件数 (売上台帳の現場名の行 + 新システムで完了した受注。KPI シートの分母と一致) を既定とし、
 *    作業日報の納品件数 (予定表の納品の予定) にも切り替えられる。事務は 4 店舗の合計
 *  - 平均点 = 合計点 ÷ 返信ハガキ枚数 (空欄の設問は 0 点として枚数に入る)。② は営業担当者、③ は担当職人ごとの行 (2 人目以降の担当の行を含む)
 *  - 担当の名前が一つでも未記入のはがきはノーカウント (返信にも平均にも入れない)
 * 月ごとの個人件数・全案件数の手入力・取込の値は設定 (settings の id = kpi_basis) に店舗 × 月で持つ。
 * 案件の件数 (caseUnits): 移行した売上台帳の受注は経過メモの「売上台帳より取込 (…#2025.12!27 …)」の行ごとに 1 件 (= シートの「現場名下の数字」)、
 * 新システムの受注は施工完了日 (売上計上日) に 1 件。販売管理ソフトから移行した伝票の受注は台帳と二重・諸経費のため数えない
 */

export const KPI_BASIS_ID = "kpi_basis";

export type DenominatorMode = "sheet" | "system";
export type AverageMode = "sheet" | "answered";
/** 返信率の分母 (個人件数) の決め方 */
export type IndividualSource = "plan" | "auto";
/** クレーム・手直し率の分母 (全案件数) の数え方 */
export type CasesSource = "cases" | "deliveries" | "system";

export interface KpiBasisRules {
  /** 返信率・クレーム手直しポイント率の分母: sheet = 月ごとの個人件数・全案件数 (シートの基準) / system = 期間内の受注 (システムの件数) */
  denominator: DenominatorMode;
  /** 担当 (営業担当・担当職人) の名前が一つでも未記入のはがきは数えない */
  requireStaffNames: boolean;
  /** ①〜④ の平均: sheet = 合計点 ÷ 返信はがきの枚数 (空欄は 0 点) / answered = 回答した枚数で割る (空欄を除く) */
  average: AverageMode;
  /** 個人件数: plan = 年間チラシ計画の値 (取込・手入力) がある月はその値、ない月は自動 / auto = いつも自動 (手入力した月は手入力の値) */
  individualSource: IndividualSource;
  /** 個人件数の自動の値で、同じお客様のこの日数以内の次の案件 (リピート) を 1 件にまとめる (0 = まとめない) */
  repeatDays: number;
  /** 全案件数: cases = 案件の件数 (売上台帳の行 + 新システムで完了した受注) / deliveries = 作業日報の納品件数 (予定表の納品) / system = 期間内の受注 */
  casesSource: CasesSource;
}

/** 店舗 × 月の値 (キーは `${店舗}|${YYYY-MM}`) */
export interface KpiMonthValue {
  /** 個人件数 (返信率の分母) */
  individual?: number;
  individualSrc?: "import" | "manual";
  /** 全案件数 (クレーム・手直しポイント率の分母)。手入力 (空 = 自動) */
  sites?: number;
  note?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface KpiBasis extends KpiBasisRules {
  months: Record<string, KpiMonthValue>;
  /** 取込に使う Google スプレッドシートのタブの URL (年間チラシ計画「個人件数売上」・アンケートハガキ（回答）「フォームの回答 1」) */
  sourceUrls: string[];
  lastImport?: { at: string; by: string; label: string; summary: string };
  /** 確認中の取込 (storage.ts の imports/kpi-basis/<hash>.json) */
  preview?: { hash: string; at: string; by: string; label: string };
}

/** リピートをまとめる日数の既定 (「約 1 か月以内」= 31 日以内) */
export const DEFAULT_REPEAT_DAYS = 31;
export const MAX_REPEAT_DAYS = 120;

export const DEFAULT_KPI_BASIS_RULES: KpiBasisRules = { denominator: "sheet", requireStaffNames: true, average: "sheet", individualSource: "plan", repeatDays: DEFAULT_REPEAT_DAYS, casesSource: "cases" };

export const DENOMINATOR_LABEL: Record<DenominatorMode, string> = {
  sheet: "シートの基準 (月ごとの個人件数・全案件数)",
  system: "期間内の受注 (システムの件数。リピートの調整なし)",
};
export const AVERAGE_LABEL: Record<AverageMode, string> = {
  sheet: "合計点 ÷ 返信はがきの枚数 (空欄の設問は 0 点。シートと同じ)",
  answered: "回答した枚数で割る (空欄の設問を除く)",
};
export const INDIVIDUAL_SOURCE_LABEL: Record<IndividualSource, string> = {
  plan: "年間チラシ計画の値 (取込・手入力) がある月はその値、ない月は自動",
  auto: "いつも自動 (個人のお客様の案件 − リピート。手入力した月は手入力の値)",
};
export const CASES_SOURCE_LABEL: Record<CasesSource, string> = {
  cases: "案件の件数 (売上台帳の現場名の行 + 新システムで完了した受注)",
  deliveries: "作業日報の納品件数 (予定表の納品の予定)",
  system: "期間内の受注 (契約日・完了日。伝票の受注も数える)",
};

export const monthKey = (storeId: string, month: string) => `${storeId}|${month}`;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

export function kpiBasis(db: Partial<Pick<Database, "settings">>): KpiBasis {
  const v = ((db.settings ?? []).find((s) => s.id === KPI_BASIS_ID)?.value ?? {}) as Record<string, unknown>;
  const d = DEFAULT_KPI_BASIS_RULES;
  const months: Record<string, KpiMonthValue> = {};
  const raw = v.months && typeof v.months === "object" && !Array.isArray(v.months) ? (v.months as Record<string, Record<string, unknown>>) : {};
  for (const [k, m] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]+\|\d{4}-\d{2}$/.test(k) || !m || typeof m !== "object") continue;
    const e: KpiMonthValue = {};
    if (num(m.individual) !== undefined) {
      e.individual = num(m.individual);
      e.individualSrc = m.individualSrc === "manual" ? "manual" : "import";
    }
    if (num(m.sites) !== undefined) e.sites = num(m.sites);
    if (typeof m.note === "string" && m.note) e.note = m.note.slice(0, 200);
    if (typeof m.updatedBy === "string") e.updatedBy = m.updatedBy;
    if (typeof m.updatedAt === "string") e.updatedAt = m.updatedAt;
    if (e.individual !== undefined || e.sites !== undefined || e.note) months[k] = e;
  }
  const repeat = typeof v.repeatDays === "number" && Number.isFinite(v.repeatDays) ? Math.round(v.repeatDays) : NaN;
  return {
    denominator: v.denominator === "system" ? "system" : d.denominator,
    requireStaffNames: typeof v.requireStaffNames === "boolean" ? v.requireStaffNames : d.requireStaffNames,
    average: v.average === "answered" ? "answered" : d.average,
    individualSource: v.individualSource === "auto" ? "auto" : d.individualSource,
    repeatDays: repeat >= 0 && repeat <= MAX_REPEAT_DAYS ? repeat : d.repeatDays,
    // 以前の設定 autoSites = false (施工件数を売上台帳から出さない) は「期間内の受注」
    casesSource: v.casesSource === "cases" || v.casesSource === "deliveries" || v.casesSource === "system" ? v.casesSource : v.autoSites === false ? "system" : d.casesSource,
    months,
    sourceUrls: Array.isArray(v.sourceUrls) ? v.sourceUrls.filter((x): x is string => typeof x === "string" && /^https:\/\/docs\.google\.com\//.test(x)).slice(0, 4) : [],
    lastImport: v.lastImport && typeof v.lastImport === "object" ? (v.lastImport as KpiBasis["lastImport"]) : undefined,
    preview: v.preview && typeof v.preview === "object" ? (v.preview as KpiBasis["preview"]) : undefined,
  };
}

/** 設定を書く (mutate の中で呼ぶ) */
export function writeKpiBasis(db: Pick<Database, "settings">, next: KpiBasis, by: string, now: string): void {
  const value = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  const row = db.settings.find((s) => s.id === KPI_BASIS_ID);
  if (row) Object.assign(row, { value, updatedBy: by, updatedAt: now });
  else db.settings.push({ id: KPI_BASIS_ID, value, updatedBy: by, updatedAt: now });
}

/* ------------------------------------------------------------------ */
/* 期間の月                                                              */
/* ------------------------------------------------------------------ */

const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
export const nextMonthKey = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** 期間に含まれる月 (full = 月の全部が期間に入る) */
export function periodMonths(p: Period): { month: string; full: boolean }[] {
  const out: { month: string; full: boolean }[] = [];
  for (let m = p.from.slice(0, 7); m <= p.to.slice(0, 7) && out.length < 600; m = nextMonthKey(m)) out.push({ month: m, full: p.from <= `${m}-01` && p.to >= lastDay(m) });
  return out;
}

/** 年度の 12 か月 (開始月から) */
export function fiscalMonths(fy: number, startMonth: number): string[] {
  const out: string[] = [];
  let m = startMonth === 1 ? `${fy}-01` : `${fy - 1}-${String(startMonth).padStart(2, "0")}`;
  for (let i = 0; i < 12; i++, m = nextMonthKey(m)) out.push(m);
  return out;
}

/* ------------------------------------------------------------------ */
/* 案件の件数 (売上台帳の行 + 新システムで完了した受注)・リピート          */
/* ------------------------------------------------------------------ */

const LEDGER_REF = /売上\.xlsx#(\d{4})\.(\d{1,2})!\d+/g;

/** 移行した売上台帳の受注か */
export const isLedgerOrder = (o: Pick<Order, "source" | "sourceRef">): boolean => o.source === "import" && Boolean(o.sourceRef) && /売上\.xlsx#/.test(o.sourceRef!);

/** 売上台帳の受注の行の月 (同じ日・同じお客様の行 = 追加工事分は 1 件の受注にまとめて取り込んだため、行の数は取込の経過メモから数える) */
function ledgerRowMonths(o: Pick<Order, "sourceRef" | "progressNotes">): string[] {
  const note = o.progressNotes?.find((n) => n.body?.startsWith("売上台帳より取込"));
  const refs = [...(note?.body ?? o.sourceRef ?? "").matchAll(LEDGER_REF)];
  if (!refs.length) refs.push(...(o.sourceRef ?? "").matchAll(LEDGER_REF));
  return refs.map((r) => `${r[1]}-${r[2].padStart(2, "0")}`);
}

export interface LedgerCounts {
  /** 店舗|月 → 現場名の行数 (売上台帳のその月のシートの行) */
  sites: Map<string, number>;
  /** 店舗 → 取り込んだ売上台帳の最後の売上日 */
  lastDate: Map<string, string>;
}

const ledgerCache = new WeakMap<object, { len: number; counts: LedgerCounts }>();

/** 移行した売上台帳の受注から、店舗 × 月の現場名の行数を数える (シートの施工件数 = 月のシートの D20 = COUNTA(現場名)) */
export function ledgerCounts(orders: Order[]): LedgerCounts {
  const hit = ledgerCache.get(orders);
  if (hit && hit.len === orders.length) return hit.counts;
  const sites = new Map<string, number>();
  const lastDate = new Map<string, string>();
  for (const o of orders) {
    if (!isLedgerOrder(o) || !countedOrder(o)) continue;
    for (const m of ledgerRowMonths(o)) {
      const k = monthKey(o.storeId, m);
      sites.set(k, (sites.get(k) ?? 0) + 1);
    }
    const d = orderDate(o);
    if (d > (lastDate.get(o.storeId) ?? "")) lastDate.set(o.storeId, d);
  }
  const counts = { sites, lastDate };
  ledgerCache.set(orders, { len: orders.length, counts });
  return counts;
}

/** 案件 1 件 (全案件数・個人件数の自動の値の単位) */
export interface CaseUnit {
  storeId: string;
  /** 案件の日 (売上計上日 = 施工完了日) */
  date: string;
  /** 数える月 (売上台帳の行はシートの月) */
  month: string;
  customerId: string;
  orderId: string;
  /** ledger = 移行した売上台帳の行 / system = 新システムで完了した受注 */
  origin: "ledger" | "system";
  /** 同じお客様の、はがきを渡した案件から repeatDays 日以内の次の案件 (返信率の分母で数えない) */
  repeat: boolean;
}

const unitCache = new WeakMap<object, { sig: string; byDays: Map<number, CaseUnit[]> }>();

/** 受注の一覧の印 (メモリの受注は書き換えられるため、件数だけでなく日付・状態の変化でも作り直す) */
function ordersSignature(orders: Order[]): string {
  let h = 2166136261;
  const mix = (v: string | undefined) => {
    const t = v ?? "";
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 124;
    h = Math.imul(h, 16777619);
  };
  for (const o of orders) {
    mix(o.id);
    mix(o.status);
    mix(o.storeId);
    mix(o.customerId);
    mix(o.salesDate);
    mix(o.completedAt);
    mix(o.contractDate);
    mix(o.source);
  }
  return `${orders.length}:${(h >>> 0).toString(36)}`;
}

const dayDiff = (from: string, to: string): number => (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000;

/**
 * 案件の一覧 (全案件数・個人件数の自動の値)。
 * - 移行した売上台帳の受注: 台帳の行ごとに 1 件 (= シートの現場名の下の数字)
 * - 新システムの受注: 施工完了日 (売上計上日) に 1 件。完了していない受注は数えない。
 *   その店舗の売上台帳の取込の最後の日までの受注は台帳の行で数える (二重にしない)
 * - 販売管理ソフトから移行した伝票の受注・キャンセルは数えない
 * リピート: お客様ごとに日付の順に並べ、はがきを渡した案件から repeatDays 日以内の次の案件を repeat にする
 * (その次は、はがきを渡した案件からの日数で決める。同じ日の追加工事の行もリピート)
 */
export function caseUnits(orders: Order[], repeatDays: number): CaseUnit[] {
  const sig = ordersSignature(orders);
  let hit = unitCache.get(orders);
  if (!hit || hit.sig !== sig) {
    hit = { sig, byDays: new Map() };
    unitCache.set(orders, hit);
  }
  const cached = hit.byDays.get(repeatDays);
  if (cached) return cached;
  const last = ledgerCounts(orders).lastDate;
  const units: CaseUnit[] = [];
  for (const o of orders) {
    if (!countedOrder(o)) continue;
    if (isLedgerOrder(o)) {
      const date = orderDate(o);
      for (const month of ledgerRowMonths(o)) units.push({ storeId: o.storeId, date, month, customerId: o.customerId ?? "", orderId: o.id, origin: "ledger", repeat: false });
      continue;
    }
    if (o.source === "import") continue;
    const date = (o.salesDate ?? o.completedAt ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ledgerEnd = last.get(o.storeId);
    if (ledgerEnd && date <= ledgerEnd) continue;
    units.push({ storeId: o.storeId, date, month: date.slice(0, 7), customerId: o.customerId ?? "", orderId: o.id, origin: "system", repeat: false });
  }
  if (repeatDays > 0) {
    const byCustomer = new Map<string, CaseUnit[]>();
    for (const u of units) if (u.customerId) byCustomer.set(u.customerId, [...(byCustomer.get(u.customerId) ?? []), u]);
    for (const list of byCustomer.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date) || a.orderId.localeCompare(b.orderId));
      let base: CaseUnit | undefined;
      for (const u of list) {
        if (base && dayDiff(base.date, u.date) <= repeatDays) u.repeat = true;
        else base = u;
      }
    }
  }
  hit.byDays.set(repeatDays, units);
  return units;
}

/* ------------------------------------------------------------------ */
/* 分母                                                                  */
/* ------------------------------------------------------------------ */

export type DenomSource = "import" | "manual" | "auto" | "cases" | "deliveries" | "system";

export const DENOM_SOURCE_LABEL: Record<DenomSource, string> = {
  import: "年間チラシ計画",
  manual: "手入力",
  auto: "自動 (リピートを 1 件)",
  cases: "案件の件数",
  deliveries: "作業日報の納品",
  system: "システムの受注",
};

export interface DenomPart {
  storeId: string;
  month: string;
  value: number;
  source: DenomSource;
  /** 期間が月の途中から・途中まで (月の値を使わず、期間内の案件) */
  partial?: boolean;
  /** 自動の個人件数: リピートをまとめる前の個人のお客様の案件 */
  raw?: number;
  /** 自動の個人件数: まとめたリピート */
  repeats?: number;
}

export interface Denom {
  value: number;
  parts: DenomPart[];
}

export interface Denominators {
  mode: DenominatorMode;
  /** 個人件数 (返信率の分母) */
  individual: Denom;
  /** 全案件数 (クレーム・手直しポイント率・発生率の分母) */
  sites: Denom;
}

type DenomDb = Pick<Database, "orders" | "customers"> & Partial<Pick<Database, "settings" | "stores" | "schedule">>;

/** 分母の内訳の要約 (例: 「年間チラシ計画 10 か月 + 自動 (リピートを 1 件) 2 か月 (リピート 3 件)」) */
export function denomSummary(d: Denom): string {
  const by = new Map<DenomSource, Set<string>>();
  for (const p of d.parts) by.set(p.source, (by.get(p.source) ?? new Set()).add(p.month));
  if (!by.size) return "対象の月なし";
  const repeats = d.parts.reduce((a, p) => a + (p.repeats ?? 0), 0);
  return [...by.entries()].map(([s, ms]) => (ms.has("*") ? DENOM_SOURCE_LABEL[s] : `${DENOM_SOURCE_LABEL[s]} ${ms.size} か月`)).join(" + ") + (repeats ? ` (リピート ${repeats} 件を除く)` : "");
}

/** 自動の個人件数でまとめたリピートの件数 */
export const denomRepeats = (d: Denom): number => d.parts.reduce((a, p) => a + (p.repeats ?? 0), 0);

/** 店舗 × 月の件数 (分母の材料。期間内だけ) */
export interface MonthFacts {
  /** 案件の件数 (売上台帳の行 + 新システムで完了した受注) */
  cases: number;
  /** そのうち個人のお客様 (リピートを含む) */
  individual: number;
  /** 個人のお客様のリピート (返信率の分母で数えない) */
  repeats: number;
  /** 作業日報の納品件数 (予定表の納品の予定) */
  deliveries: number;
  /** 期間内の受注 (契約日・完了日。キャンセルを除く。伝票の受注を含む) */
  systemAll: number;
  systemIndividual: number;
}

const emptyFacts = (): MonthFacts => ({ cases: 0, individual: 0, repeats: 0, deliveries: 0, systemAll: 0, systemIndividual: 0 });

/** 店舗|月 → 件数。月の全部が期間に入る月は月で、期間の端の欠けた月は日付で絞る */
export function monthFacts(db: DenomDb, p: Period | null, storeId: StoreId | undefined, opts: { customers?: Map<string, Customer>; basis?: KpiBasis } = {}): Map<string, MonthFacts> {
  const basis = opts.basis ?? kpiBasis(db);
  const cmap = opts.customers ?? new Map(db.customers.map((c) => [c.id, c]));
  const out = new Map<string, MonthFacts>();
  const at = (sid: string, month: string) => {
    const k = monthKey(sid, month);
    let f = out.get(k);
    if (!f) out.set(k, (f = emptyFacts()));
    return f;
  };
  const ms = p ? periodMonths(p) : [];
  const full = new Set(ms.filter((m) => m.full).map((m) => m.month));
  const any = new Set(ms.map((m) => m.month));
  const take = (month: string, date: string) => !p || full.has(month) || (any.has(month) && inPeriod(date, p));
  const individual = (cid: string) => cmap.get(cid)?.type !== "corporate";
  for (const u of caseUnits(db.orders, basis.repeatDays)) {
    if ((storeId && u.storeId !== storeId) || !take(u.month, u.date)) continue;
    const f = at(u.storeId, u.month);
    f.cases++;
    if (individual(u.customerId)) {
      f.individual++;
      if (u.repeat) f.repeats++;
    }
  }
  for (const o of db.orders) {
    if (!countedOrder(o) || (storeId && o.storeId !== storeId)) continue;
    const d = orderDate(o);
    if (!inPeriod(d, p)) continue;
    const f = at(o.storeId, d.slice(0, 7));
    f.systemAll++;
    if (individual(o.customerId)) f.systemIndividual++;
  }
  for (const e of (db.schedule ?? []) as ScheduleEvent[]) {
    if (e.kind !== "delivery" || (storeId && e.storeId !== storeId) || !inPeriod(e.date, p)) continue;
    at(e.storeId, e.date.slice(0, 7)).deliveries++;
  }
  return out;
}

/**
 * 返信率・ポイント率の分母。storeId を省くと全店舗の合計 (全社)。
 * シートの基準: 期間の月ごとに
 *  - 個人件数 = 年間チラシ計画の値 (取込・手入力。いつも自動の設定では手入力だけ) → なければ自動 (個人のお客様の案件 − リピート)
 *  - 全案件数 = 手入力 → 案件の件数 (設定で 作業日報の納品件数 / 期間内の受注)
 *  案件のない月 (移行前の古い月など) は期間内の受注。期間の端の欠けた月は月の値を使わず、期間内の件数
 */
export function kpiDenominators(db: DenomDb, p: Period | null, storeId?: StoreId, opts: { customers?: Map<string, Customer>; basis?: KpiBasis } = {}): Denominators {
  const basis = opts.basis ?? kpiBasis(db);
  const cmap = opts.customers ?? new Map(db.customers.map((c) => [c.id, c]));
  const facts = monthFacts(db, p, storeId, { customers: cmap, basis });
  if (basis.denominator === "system") {
    const all = [...facts.values()].reduce((a, e) => a + e.systemAll, 0);
    const ind = [...facts.values()].reduce((a, e) => a + e.systemIndividual, 0);
    const part = (value: number): DenomPart => ({ storeId: storeId ?? "all", month: "*", value, source: "system" });
    return { mode: "system", individual: { value: ind, parts: [part(ind)] }, sites: { value: all, parts: [part(all)] } };
  }
  // 月の範囲 (累計のときはデータのある月)
  let months: { month: string; full: boolean }[];
  if (p) months = periodMonths(p);
  else {
    const keys = [...facts.keys(), ...Object.keys(basis.months)].map((k) => k.split("|")[1]).sort();
    months = keys.length ? periodMonths({ from: `${keys[0]}-01`, to: lastDay(keys[keys.length - 1]) }) : [];
  }
  const stores = storeId ? [storeId] : [...new Set([...(db.stores ?? []).map((s) => s.id), ...[...facts.keys(), ...Object.keys(basis.months)].map((k) => k.split("|")[0])])];
  const individual: Denom = { value: 0, parts: [] };
  const sites: Denom = { value: 0, parts: [] };
  for (const sid of stores) {
    for (const { month, full } of months) {
      const k = monthKey(sid, month);
      const f = facts.get(k) ?? emptyFacts();
      const v = basis.months[k];
      const partial = !full || undefined;
      const usePlan = full && v?.individual !== undefined && (basis.individualSource === "plan" || v.individualSrc === "manual");
      const ip: DenomPart = usePlan
        ? { storeId: sid, month, value: v!.individual!, source: v!.individualSrc ?? "import" }
        : f.cases > 0
          ? { storeId: sid, month, value: f.individual - f.repeats, source: "auto", partial, raw: f.individual, repeats: f.repeats || undefined }
          : { storeId: sid, month, value: f.systemIndividual, source: "system", partial };
      const sp: DenomPart =
        full && v?.sites !== undefined
          ? { storeId: sid, month, value: v.sites, source: "manual" }
          : basis.casesSource === "deliveries"
            ? { storeId: sid, month, value: f.deliveries, source: "deliveries", partial }
            : basis.casesSource === "cases" && f.cases > 0
              ? { storeId: sid, month, value: f.cases, source: "cases", partial }
              : { storeId: sid, month, value: f.systemAll, source: "system", partial };
      // 値も件数もない月は内訳に出さない
      if (ip.value || ip.source !== "system") individual.parts.push(ip);
      if (sp.value || sp.source !== "system") sites.parts.push(sp);
      individual.value += ip.value;
      sites.value += sp.value;
    }
  }
  return { mode: "sheet", individual, sites };
}

/* ------------------------------------------------------------------ */
/* はがきの数え方・平均                                                   */
/* ------------------------------------------------------------------ */

/** 担当 (営業担当・担当職人) の名前が書かれているか (アカウントの選択か、はがきの名前の文字) */
export function staffNamed(s: Pick<SurveyResponse, "salesUserId" | "salesName" | "deliveryUserIds" | "craftsmanUserId" | "craftsmanName">): boolean {
  const sales = Boolean(s.salesUserId || s.salesName?.trim());
  const craft = deliveryOf(s).length > 0 || Boolean(s.craftsmanName?.trim());
  return sales && craft;
}

/** 集計に入るはがきか (はがき 1 枚分の回答 + 担当の名前の決まり) */
export function countsCard(s: SurveyResponse, rules: Pick<KpiBasisRules, "requireStaffNames">): boolean {
  return isCard(s) && (!rules.requireStaffNames || staffNamed(s));
}

/** 担当の名前がないため数えないはがきか */
export function unnamedCard(s: SurveyResponse, rules: Pick<KpiBasisRules, "requireStaffNames">): boolean {
  return rules.requireStaffNames && isCard(s) && !staffNamed(s);
}

/** 期間 (集計月) と店舗で絞った、集計に入るはがき */
export function kpiCards(surveys: SurveyResponse[], p: Period | null, rules: Pick<KpiBasisRules, "requireStaffNames">, storeId?: StoreId): SurveyResponse[] {
  return surveys.filter((s) => (!storeId || s.storeId === storeId) && inPeriod(surveyKpiDate(s), p) && countsCard(s, rules));
}

/** ②③ の個人評価に使う行 (はがき + 2 人目以降の担当の行。担当の名前がないため数えないはがきは除く) */
export function evaluationRows(surveys: SurveyResponse[], p: Period | null, rules: Pick<KpiBasisRules, "requireStaffNames">): SurveyResponse[] {
  return surveys.filter((s) => inPeriod(surveyKpiDate(s), p) && (!isCard(s) || countsCard(s, rules)));
}

export interface ScoreAvg {
  avg: number | null;
  /** 平均の分母 (sheet = 枚数・行数 / answered = 回答した数) */
  n: number;
  sum: number;
  /** 空欄の数 (sheet のときは 0 点として分母に入っている) */
  blank: number;
}

/** 平均点。sheet = 合計点 ÷ 枚数 (空欄は 0 点)、answered = 回答した数で割る */
export function scoreAverage(values: (number | undefined | null)[], mode: AverageMode): ScoreAvg {
  const answered = values.filter((x): x is number => typeof x === "number");
  const sum = answered.reduce((a, b) => a + b, 0);
  const n = mode === "sheet" ? values.length : answered.length;
  return { avg: n ? sum / n : null, n, sum, blank: values.length - answered.length };
}

export interface PersonScores {
  sales: ScoreAvg;
  craft: ScoreAvg;
}

/** 社員ごとの ② 営業対応・③ 職人対応 (シートのピボット: 担当者ごとの行の 合計点 ÷ 行数) */
export function personScores(surveys: SurveyResponse[], p: Period | null, rules: Pick<KpiBasisRules, "requireStaffNames" | "average">): Map<string, PersonScores> {
  const sales = new Map<string, (number | undefined)[]>();
  const craft = new Map<string, (number | undefined)[]>();
  for (const s of evaluationRows(surveys, p, rules)) {
    if (s.salesUserId) sales.set(s.salesUserId, [...(sales.get(s.salesUserId) ?? []), s.salesScore]);
    for (const id of new Set(deliveryOf(s))) craft.set(id, [...(craft.get(id) ?? []), s.craftsmanScore]);
  }
  const out = new Map<string, PersonScores>();
  const empty: ScoreAvg = { avg: null, n: 0, sum: 0, blank: 0 };
  for (const id of new Set([...sales.keys(), ...craft.keys()])) {
    out.set(id, {
      sales: sales.has(id) ? scoreAverage(sales.get(id)!, rules.average) : empty,
      craft: craft.has(id) ? scoreAverage(craft.get(id)!, rules.average) : empty,
    });
  }
  return out;
}

/** 画面に出す数え方の説明 (KPI の各画面の注記) */
export function basisNotes(b: KpiBasisRules): string[] {
  return [
    b.denominator === "sheet"
      ? `返信率 = はがきの枚数 ÷ 個人件数。個人件数 = ${b.individualSource === "plan" ? "年間チラシ計画の本年度実績の件数 (取込・手入力)。値のない月は自動" : "自動 (手入力した月は手入力の値)"}${b.repeatDays > 0 ? ` (自動 = 個人のお客様の案件。同じお客様の ${b.repeatDays} 日以内のリピートは 1 件。売上は 1 件ずつ数えます)` : " (自動 = 個人のお客様の案件。リピートもまとめない)"}`
      : "返信率 = はがきの枚数 ÷ 期間内の個人のお客様の受注の件数 (リピートの調整なし)",
    b.denominator === "sheet"
      ? `クレーム・手直しポイント率・発生率 = ÷ 全案件数。全案件数 = ${CASES_SOURCE_LABEL[b.casesSource]} (手入力した月は手入力の値。事務は 4 店舗の合計)`
      : "クレーム・手直しポイント率・発生率 = ÷ 期間内の受注の件数 (システムの件数。事務は 4 店舗の合計)",
    `①〜④ の平均 = ${AVERAGE_LABEL[b.average]}。② は営業担当者、③ は担当職人ごとの行 (2 人目以降の担当の行を含む)`,
    b.requireStaffNames ? "担当 (営業担当・担当職人) の名前が一つでも未記入のはがきは数えません (返信にも平均にも入れない)" : "担当の名前が未記入のはがきも数えます",
    "はがきは集計月 (スプレッドシートの「月」の列。なければ回答日) で期間を判定します",
  ];
}
