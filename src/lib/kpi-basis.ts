import type { Customer, Database, Order, StoreId, SurveyResponse } from "@/lib/db/types";
import { countedOrder, deliveryOf, inPeriod, isCard, orderDate, surveyKpiDate, type Period } from "./kpi-core";

/**
 * KPI の分母と数え方 (スプレッドシート「お客様アンケート集計表」の KPI シートの集計基準に合わせる)
 * ------------------------------------------------------------
 * お客様のご要望 (2026-11-23「■9. KPI・インセンティブ集計」): 返信率・クレーム率の分母は従来のスプレッドシートの集計基準に合わせる。
 * シートの基準 (KPI のタブの「評価方法」と式):
 *  - ハガキ返信率 = 戻ってきたハガキ件数 ÷ 個人件数 × 100。個人件数 = 年間チラシ計画「個人件数売上」の本年度実績の件数
 *    (店長が月ごとに記入。網戸祭りを除く・内部受注は店長は無視して記入し事務が直す)。はがきは集計月 (はがきの「月」の列) で数える
 *  - クレーム・手直しポイント率 = (クレームポイント + 手直しポイント) ÷ 施工件数 × 100。施工件数 = 各店の売上台帳の月のシートの
 *    「現場名」の下の数字 (現場名の行数)。事務は 4 店舗の合計 (全件施工件数)
 *  - 平均点 = 合計点 ÷ 返信ハガキ枚数 (空欄の設問は 0 点として枚数に入る)。② は営業担当者、③ は担当職人ごとの行 (2 人目以降の担当の行を含む)
 *  - 担当の名前が一つでも未記入のはがきはノーカウント (返信にも平均にも入れない)
 * 月ごとの個人件数・施工件数は設定 (settings の id = kpi_basis) に店舗 × 月で持つ (年間チラシ計画の取込・手入力)。
 * 施工件数は、移行した売上台帳の受注 (経過メモの「売上台帳より取込 (…#2025.12!27 …)」の行の数) から自動で出す (= シートの「現場名下の数字」と同じ)。
 * 値のない月はシステムの件数 (期間内の案件) を使い、どの月がどちらかを画面に出す
 */

export const KPI_BASIS_ID = "kpi_basis";

export type DenominatorMode = "sheet" | "system";
export type AverageMode = "sheet" | "answered";

export interface KpiBasisRules {
  /** 返信率・クレーム手直しポイント率の分母: sheet = 月ごとの個人件数・施工件数 (シートの基準) / system = 期間内の案件 (システムの件数) */
  denominator: DenominatorMode;
  /** 担当 (営業担当・担当職人) の名前が一つでも未記入のはがきは数えない */
  requireStaffNames: boolean;
  /** ①〜④ の平均: sheet = 合計点 ÷ 返信はがきの枚数 (空欄は 0 点) / answered = 回答した枚数で割る (空欄を除く) */
  average: AverageMode;
  /** 施工件数の自動の値 (移行した売上台帳の現場名の行数) を使う */
  autoSites: boolean;
}

/** 店舗 × 月の値 (キーは `${店舗}|${YYYY-MM}`) */
export interface KpiMonthValue {
  /** 個人件数 (返信率の分母) */
  individual?: number;
  individualSrc?: "import" | "manual";
  /** 施工件数 (クレーム・手直しポイント率の分母)。手入力 (空 = 売上台帳の取込から自動) */
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

export const DEFAULT_KPI_BASIS_RULES: KpiBasisRules = { denominator: "sheet", requireStaffNames: true, average: "sheet", autoSites: true };

export const DENOMINATOR_LABEL: Record<DenominatorMode, string> = {
  sheet: "シートの基準 (月ごとの個人件数・施工件数)",
  system: "システムの件数 (期間内の案件)",
};
export const AVERAGE_LABEL: Record<AverageMode, string> = {
  sheet: "合計点 ÷ 返信はがきの枚数 (空欄の設問は 0 点。シートと同じ)",
  answered: "回答した枚数で割る (空欄の設問を除く)",
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
  return {
    denominator: v.denominator === "system" ? "system" : d.denominator,
    requireStaffNames: typeof v.requireStaffNames === "boolean" ? v.requireStaffNames : d.requireStaffNames,
    average: v.average === "answered" ? "answered" : d.average,
    autoSites: typeof v.autoSites === "boolean" ? v.autoSites : d.autoSites,
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
/* 売上台帳の取込 (施工件数の自動の値)                                    */
/* ------------------------------------------------------------------ */

const LEDGER_REF = /売上\.xlsx#(\d{4})\.(\d{1,2})!\d+/g;

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
    if (o.source !== "import" || !o.sourceRef || !/売上\.xlsx#/.test(o.sourceRef) || !countedOrder(o)) continue;
    // 同じ日・同じお客様の行 (追加工事分) は 1 件の受注にまとめて取り込んだため、行の数は取込の経過メモから数える
    const note = o.progressNotes?.find((n) => n.body?.startsWith("売上台帳より取込"));
    const refs = [...(note?.body ?? o.sourceRef).matchAll(LEDGER_REF)];
    if (!refs.length) refs.push(...o.sourceRef.matchAll(LEDGER_REF));
    for (const r of refs) {
      const k = monthKey(o.storeId, `${r[1]}-${r[2].padStart(2, "0")}`);
      sites.set(k, (sites.get(k) ?? 0) + 1);
    }
    const d = orderDate(o);
    if (d > (lastDate.get(o.storeId) ?? "")) lastDate.set(o.storeId, d);
  }
  const counts = { sites, lastDate };
  ledgerCache.set(orders, { len: orders.length, counts });
  return counts;
}

/* ------------------------------------------------------------------ */
/* 分母                                                                  */
/* ------------------------------------------------------------------ */

export type DenomSource = "import" | "manual" | "ledger" | "system";

export const DENOM_SOURCE_LABEL: Record<DenomSource, string> = {
  import: "年間チラシ計画",
  manual: "手入力",
  ledger: "売上台帳",
  system: "システムの案件",
};

export interface DenomPart {
  storeId: string;
  month: string;
  value: number;
  source: DenomSource;
  /** 期間が月の途中から・途中まで (月の値を使わず、期間内のシステムの案件) */
  partial?: boolean;
}

export interface Denom {
  value: number;
  parts: DenomPart[];
}

export interface Denominators {
  mode: DenominatorMode;
  /** 個人件数 (返信率の分母) */
  individual: Denom;
  /** 施工件数 (クレーム・手直しポイント率・発生率の分母) */
  sites: Denom;
}

type DenomDb = Pick<Database, "orders" | "customers"> & Partial<Pick<Database, "settings" | "stores">>;

/** 分母の内訳の要約 (例: 「年間チラシ計画 10 か月 + システムの案件 2 か月」) */
export function denomSummary(d: Denom): string {
  const by = new Map<DenomSource, Set<string>>();
  for (const p of d.parts) by.set(p.source, (by.get(p.source) ?? new Set()).add(p.month));
  if (!by.size) return "対象の月なし";
  return [...by.entries()].map(([s, ms]) => (ms.has("*") ? DENOM_SOURCE_LABEL[s] : `${DENOM_SOURCE_LABEL[s]} ${ms.size} か月`)).join(" + ");
}

/**
 * 返信率・ポイント率の分母。storeId を省くと全店舗の合計 (全社)。
 * シートの基準: 期間の月ごとに 個人件数 = 登録した値 (取込・手入力)、施工件数 = 手入力 → 売上台帳の取込 の順。値のない月・期間の端の欠けた月はシステムの案件
 */
export function kpiDenominators(db: DenomDb, p: Period | null, storeId?: StoreId, opts: { customers?: Map<string, Customer>; basis?: KpiBasis } = {}): Denominators {
  const basis = opts.basis ?? kpiBasis(db);
  const cmap = opts.customers ?? new Map(db.customers.map((c) => [c.id, c]));
  // システムの案件を 店舗|月 ごとに数える (期間内だけ)
  const sys = new Map<string, { all: number; individual: number }>();
  for (const o of db.orders) {
    if (!countedOrder(o) || (storeId && o.storeId !== storeId)) continue;
    const d = orderDate(o);
    if (!inPeriod(d, p)) continue;
    const k = monthKey(o.storeId, d.slice(0, 7));
    const e = sys.get(k) ?? { all: 0, individual: 0 };
    e.all++;
    if (cmap.get(o.customerId)?.type !== "corporate") e.individual++;
    sys.set(k, e);
  }
  if (basis.denominator === "system") {
    const all = [...sys.values()].reduce((a, e) => a + e.all, 0);
    const ind = [...sys.values()].reduce((a, e) => a + e.individual, 0);
    const part = (value: number): DenomPart => ({ storeId: storeId ?? "all", month: "*", value, source: "system" });
    return { mode: "system", individual: { value: ind, parts: [part(ind)] }, sites: { value: all, parts: [part(all)] } };
  }
  const ledger = basis.autoSites ? ledgerCounts(db.orders) : { sites: new Map<string, number>(), lastDate: new Map<string, string>() };
  // 月の範囲 (累計のときはデータのある月)
  let months: { month: string; full: boolean }[];
  if (p) months = periodMonths(p);
  else {
    const keys = [...sys.keys(), ...Object.keys(basis.months), ...ledger.sites.keys()].map((k) => k.split("|")[1]).sort();
    months = keys.length ? periodMonths({ from: `${keys[0]}-01`, to: lastDay(keys[keys.length - 1]) }) : [];
  }
  const stores = storeId ? [storeId] : [...new Set([...(db.stores ?? []).map((s) => s.id), ...[...sys.keys(), ...Object.keys(basis.months), ...ledger.sites.keys()].map((k) => k.split("|")[0])])];
  const individual: Denom = { value: 0, parts: [] };
  const sites: Denom = { value: 0, parts: [] };
  for (const sid of stores) {
    for (const { month, full } of months) {
      const k = monthKey(sid, month);
      const s = sys.get(k) ?? { all: 0, individual: 0 };
      const v = basis.months[k];
      const ip: DenomPart = full && v?.individual !== undefined ? { storeId: sid, month, value: v.individual, source: v.individualSrc ?? "import" } : { storeId: sid, month, value: s.individual, source: "system", partial: !full || undefined };
      const lv = ledger.sites.get(k);
      const sp: DenomPart =
        full && v?.sites !== undefined
          ? { storeId: sid, month, value: v.sites, source: "manual" }
          : full && lv !== undefined
            ? { storeId: sid, month, value: lv, source: "ledger" }
            : { storeId: sid, month, value: s.all, source: "system", partial: !full || undefined };
      // 値も案件もない月は内訳に出さない
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
      ? "返信率 = はがきの枚数 ÷ 個人件数 (年間チラシ計画の本年度実績の件数)。クレーム・手直しポイント率 = ポイント ÷ 施工件数 (売上台帳の現場名の行数。事務は 4 店舗の合計)。値のない月はシステムの案件の件数"
      : "返信率 = はがきの枚数 ÷ 期間内の個人のお客様の案件数。クレーム・手直しポイント率 = ポイント ÷ 期間内の総案件数 (システムの件数)",
    `①〜④ の平均 = ${AVERAGE_LABEL[b.average]}。② は営業担当者、③ は担当職人ごとの行 (2 人目以降の担当の行を含む)`,
    b.requireStaffNames ? "担当 (営業担当・担当職人) の名前が一つでも未記入のはがきは数えません (返信にも平均にも入れない)" : "担当の名前が未記入のはがきも数えます",
    "はがきは集計月 (スプレッドシートの「月」の列。なければ回答日) で期間を判定します",
  ];
}
