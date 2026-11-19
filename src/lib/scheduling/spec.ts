import type { Database, JobItem, JobPriority, JobSpec, Order, PlanSlot, PreferenceStrength, Quote, ScheduleEvent, ScheduleKind, ServiceCategory } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { workOf, type Work } from "@/lib/schedule-capacity";
import { matchWorkType, type Masters, type WorkCategory, type WorkType } from "./masters";

/**
 * 作業の内容を決める (予定の候補日の提案・製造計画・最適化の入力)
 * ------------------------------------------------------------
 * 優先順位: 予定の作業の内容 (job_specs の event) > 受注 > 見積 > 問い合わせ の作業の内容 >
 *           予定の件名・メモ (「畳 表替え6」) > 受注の明細 (経過メモ「明細 (税込): …」) > 見積の明細
 * 専用の項目 (job_specs) に入れたものが最も確か。件名・メモからの読み取りは「推定」と表示する
 */

export type SpecSource = "spec" | "memo" | "order" | "quote" | "input" | "none";
export const SPEC_SOURCE_LABEL: Record<SpecSource, string> = {
  spec: "作業の内容 (登録済み)",
  memo: "予定の件名・メモから推定",
  order: "受注の明細から推定",
  quote: "見積の明細から推定",
  input: "入力された値",
  none: "作業の内容なし",
};

export interface ResolvedItem {
  workType: WorkType;
  qty: number;
}

export interface ResolvedJob {
  items: ResolvedItem[];
  /** 種類ごとの数量 (畳・襖・障子・網戸) */
  units: Work;
  /** 引き取り・製造の対象の数 (畳 + 襖 + 障子 + 網戸) */
  totalUnits: number;
  staffCount?: number;
  skills: string[];
  resourceKinds: string[];
  /** 工程ごとの製造時間 (分) */
  production: Map<string, number>;
  /** 引き取りから納品までの最短の日数 */
  leadDays: number;
  pickupFrom?: string;
  deadline?: string;
  preferredDates: string[];
  preferredWeekdays: number[];
  preferredSlot?: PlanSlot;
  preferredTime?: string;
  avoidDates: string[];
  strength: PreferenceStrength;
  priority: JobPriority;
  source: SpecSource;
  /** 使った作業の内容の行 */
  specIds: string[];
  /** 現場の作業時間の明示 (job_specs.minutes) */
  minutesOverride?: number;
  note?: string;
}

export const specId = (recordType: JobSpec["recordType"], recordId: string) => `js_${recordType}_${recordId}`;

export function findSpec(db: Pick<Database, "jobSpecs">, recordType: JobSpec["recordType"], recordId: string | undefined): JobSpec | undefined {
  if (!recordId) return undefined;
  const id = specId(recordType, recordId);
  return (db.jobSpecs ?? []).find((s) => s.id === id);
}

const CATEGORY_OF: Record<keyof Work, WorkCategory> = { tatami: "tatami", fusuma: "fusuma", shoji: "shoji", amido: "amido" };
const ACCESSORY = /縁|ヘリ|へり|乾燥|処分|運搬|値引|防虫|シート|配送|諸経費|交換手数料/;

function emptyWork(): Work {
  return { tatami: 0, fusuma: 0, shoji: 0, amido: 0 };
}

/** 文字から作業の明細を推定する (「畳 表替え6 / 襖 張替3」) */
export function itemsFromText(m: Masters, text: string): JobItem[] {
  const w = workOf({ title: text, memo: "" });
  const out: JobItem[] = [];
  for (const k of Object.keys(w) as (keyof Work)[]) {
    if (!w[k]) continue;
    // 「畳」の近くの言葉 (表替え・新調・裏返し) で種別を決める。見つからなければその種類の最初の種別
    const near = text.normalize("NFKC").match(new RegExp(`${k === "tatami" ? "畳" : k === "fusuma" ? "襖" : k === "shoji" ? "障子" : "網戸"}[^\\d]{0,8}`))?.[0] ?? "";
    const wt = matchWorkType(m, near, CATEGORY_OF[k]) ?? matchWorkType(m, text, CATEGORY_OF[k]);
    if (wt) out.push({ workTypeId: wt.id, qty: w[k] });
  }
  return out;
}

/** 受注の明細 (経過メモ「明細 (税込): 畳 きずな 6×¥…」) から */
export function itemsFromOrder(m: Masters, o: Order | undefined): JobItem[] {
  if (!o) return [];
  const byType = new Map<string, number>();
  for (const p of o.progressNotes ?? []) {
    const line = p.body.match(/明細 \((?:税込|税抜)\): (.*)/);
    if (!line) continue;
    for (const part of line[1].split(" / ")) {
      const r = part.match(/^(畳|襖|障子|網戸) (.+?) (-?[\d.]+)×¥/);
      if (!r || ACCESSORY.test(r[2])) continue;
      const cat: WorkCategory = r[1] === "畳" ? "tatami" : r[1] === "襖" ? "fusuma" : r[1] === "障子" ? "shoji" : "amido";
      const wt = matchWorkType(m, r[2], cat);
      const n = Math.max(0, Math.round(Number(r[3])));
      if (wt && n) byType.set(wt.id, Math.min(200, (byType.get(wt.id) ?? 0) + n));
    }
  }
  return [...byType].map(([workTypeId, qty]) => ({ workTypeId, qty }));
}

const SERVICE_TO_WORK: Partial<Record<ServiceCategory, WorkCategory>> = { tatami: "tatami", fusuma: "fusuma", shoji: "shoji", amido: "amido" };

/** 見積の明細から (商品の分類・品名・単位が枚/畳/帖のもの) */
export function itemsFromQuote(m: Masters, db: Pick<Database, "products">, q: Quote | undefined): JobItem[] {
  if (!q) return [];
  const byType = new Map<string, number>();
  for (const it of q.items ?? []) {
    if (ACCESSORY.test(it.name) || !/枚|畳|帖|本|式/.test(it.unit)) continue;
    const prod = it.productId ? db.products.find((p) => p.id === it.productId) : undefined;
    const cat = (prod ? SERVICE_TO_WORK[prod.category as ServiceCategory] : undefined) ?? (/畳/.test(it.name) ? "tatami" : /襖/.test(it.name) ? "fusuma" : /障子/.test(it.name) ? "shoji" : /網戸/.test(it.name) ? "amido" : undefined);
    if (!cat) continue;
    const wt = matchWorkType(m, `${it.name} ${it.spec ?? ""}`, cat);
    const n = Math.max(0, Math.round(it.qty));
    if (wt && n) byType.set(wt.id, Math.min(200, (byType.get(wt.id) ?? 0) + n));
  }
  return [...byType].map(([workTypeId, qty]) => ({ workTypeId, qty }));
}

export interface ResolveInput {
  kind?: ScheduleKind;
  eventId?: string;
  orderId?: string;
  quoteId?: string;
  inquiryId?: string;
  /** 予定の件名・メモ (まだ保存していない入力も含む) */
  text?: string;
  /** 利用者が入れた畳の枚数 (古い入力欄。作業の内容がないときだけ使う) */
  tatamiCount?: number;
  /** 呼び出し側がすでに読んだ受注・見積 (閲覧の権限を確かめたもの) */
  order?: Order;
  quote?: Quote;
  /** 案件の予定 (件名・メモの枚数を読む) */
  caseEvents?: Pick<ScheduleEvent, "title" | "memo">[];
}

/** 作業の内容を 1 つにまとめる */
export function resolveJob(db: Pick<Database, "jobSpecs" | "products">, m: Masters, input: ResolveInput): ResolvedJob {
  const specs = [
    findSpec(db, "event", input.eventId),
    findSpec(db, "order", input.orderId ?? input.order?.id),
    findSpec(db, "quote", input.quoteId ?? input.quote?.id),
    findSpec(db, "inquiry", input.inquiryId),
  ].filter((s): s is JobSpec => Boolean(s));

  let items: JobItem[] = [];
  let source: SpecSource = "none";
  const withItems = specs.find((s) => s.items.length);
  if (withItems) {
    items = withItems.items;
    source = "spec";
  } else {
    const fromText = itemsFromText(m, input.text ?? "");
    const fromCase = (input.caseEvents ?? []).map((e) => itemsFromText(m, `${e.title}\n${e.memo ?? ""}`)).sort((a, b) => sumQty(b) - sumQty(a))[0] ?? [];
    const fromOrder = itemsFromOrder(m, input.order);
    const fromQuote = itemsFromQuote(m, db, input.quote);
    if (input.tatamiCount !== undefined && input.tatamiCount > 0) {
      const base = fromText.length ? fromText : fromCase.length ? fromCase : fromOrder.length ? fromOrder : fromQuote;
      const tat = base.find((x) => m.workTypeById.get(x.workTypeId)?.category === "tatami");
      const other = base.filter((x) => m.workTypeById.get(x.workTypeId)?.category !== "tatami");
      const wt = tat ? m.workTypeById.get(tat.workTypeId) : matchWorkType(m, input.text ?? "", "tatami");
      items = wt ? [{ workTypeId: wt.id, qty: Math.round(input.tatamiCount) }, ...other] : other;
      source = "input";
    } else if (fromText.length) [items, source] = [fromText, "memo"];
    else if (fromCase.length) [items, source] = [fromCase, "memo"];
    else if (fromOrder.length) [items, source] = [fromOrder, "order"];
    else if (fromQuote.length) [items, source] = [fromQuote, "quote"];
  }

  const resolved: ResolvedItem[] = items.map((i) => ({ workType: m.workTypeById.get(i.workTypeId)!, qty: i.qty })).filter((i) => i.workType && i.qty > 0);
  const units = emptyWork();
  for (const i of resolved) {
    const k = (Object.keys(CATEGORY_OF) as (keyof Work)[]).find((x) => CATEGORY_OF[x] === i.workType.category);
    if (k) units[k] += i.qty;
  }
  const production = new Map<string, number>();
  for (const i of resolved) for (const p of i.workType.processes) production.set(p.processKey, (production.get(p.processKey) ?? 0) + p.minutesPerUnit * i.qty);

  const pick = <K extends keyof JobSpec>(k: K): JobSpec[K] | undefined => specs.map((s) => s[k]).find((v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "");
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const prodDays = pick("productionDays");
  return {
    items: resolved,
    units,
    totalUnits: units.tatami + units.fusuma + units.shoji + units.amido,
    staffCount: pick("staffCount") ?? (resolved.length ? Math.max(...resolved.map((i) => i.workType.staffCount)) : undefined),
    skills: uniq([...(specs.flatMap((s) => s.skills) ?? []), ...resolved.flatMap((i) => i.workType.skills)]),
    resourceKinds: uniq([...specs.flatMap((s) => s.resourceKinds), ...resolved.flatMap((i) => i.workType.resourceKinds)]),
    production,
    leadDays: prodDays ?? Math.max(0, ...resolved.map((i) => i.workType.leadDays)),
    pickupFrom: pick("pickupFrom"),
    deadline: pick("deadline"),
    preferredDates: pick("preferredDates") ?? [],
    preferredWeekdays: (pick("preferredWeekdays") as number[] | undefined) ?? [],
    preferredSlot: pick("preferredSlot"),
    preferredTime: pick("preferredTime"),
    avoidDates: uniq(specs.flatMap((s) => s.avoidDates ?? [])),
    strength: pick("preferenceStrength") ?? "none",
    priority: pick("priority") ?? "normal",
    source,
    specIds: specs.map((s) => s.id),
    minutesOverride: pick("minutes"),
    note: pick("note"),
  };
}

function sumQty(xs: JobItem[]) {
  return xs.reduce((a, x) => a + x.qty, 0);
}

/** 現場の作業時間 (分): 作業の内容の指定 > 作業種別の標準 (base + 1 枚あたり) > 予定の種類の標準 */
export function siteMinutes(job: ResolvedJob, kind: ScheduleKind): { minutes: number; from: "spec" | "workType" | "kind" } {
  if (job.minutesOverride) return { minutes: job.minutesOverride, from: "spec" };
  let total = 0;
  let found = false;
  for (const i of job.items) {
    const s = i.workType.site[kind];
    if (!s) continue;
    found = true;
    total += s[0] + s[1] * i.qty;
  }
  if (found) return { minutes: Math.max(15, Math.round(total / 5) * 5), from: "workType" };
  return { minutes: SCHEDULE_KIND[kind].minutes || 60, from: "kind" };
}

/** 作業の内容の短い説明 (例: 畳 表替え 6 枚・襖 張替 3 枚) */
export function describeItems(job: Pick<ResolvedJob, "items">): string {
  return job.items.map((i) => `${i.workType.name} ${i.qty} ${i.workType.unit}`).join("・");
}
