import type { Database, Order, Quote, ScheduleEvent, ScheduleKind, StoreId, WorkReportDay, WorkReportFlyer } from "@/lib/db/types";
import { compareEvents, dateRange, dayOfWeek, isDateKey, monthEnd } from "@/lib/calendar";
import { isClosedDay } from "@/lib/schedule-capacity";
import { loadMasters, type WorkType } from "@/lib/scheduling/masters";
import { resolveJob, type SpecSource } from "@/lib/scheduling/spec";

/**
 * 作業日報 (F-11) の自動集計
 * ------------------------------------------------------------
 * 店舗ごとの月別の作業日報 (表計算) と同じ内容を、予定表から作る (二重の記入をなくす)。
 * - 件数: 予定表の 引き取り (pickup)・納品 (delivery)・施工 (install)・現地調査と採寸 (survey・measure = 見積) の予定。
 *   予定の開始日で数える (予定表の引取・納品の件数と必ず一致する)。予定の店舗 (どの店舗のカレンダーに載るか) で分ける
 * - 枚数: 予定の計画と同じ読み取り (src/lib/scheduling/spec.ts の resolveJob。作業の内容 > 件名・メモ「畳 表替え6」>
 *   同じ案件の予定の件名・メモ > 受注の明細 > 見積の明細)。表替え・裏返しは「表」、新調は「新」。
 *   襖・障子・網戸の「新」は作業種別の名前か、件名・メモ・明細の「襖 新調」のような書き方で見分ける
 * - 担当: 予定の担当者
 * - 予定からわからない項目 (チラシの配布人・枚数・地域、来店数) は手入力 (work_report_days)
 * - 見出しの集計: 畳 総数 (引取の畳の表 + 新) と 襖類 (係数後 = 襖 + 障子 × 0.5 + 網戸 × 0.4。係数は設定) を
 *   人 (引取・納品の担当者の人数)・日 (引取・納品のあった日数)・人日 (日ごとの担当者の人数の合計) で割った値
 * このファイルは画面・CSV・印刷・テストで共通に使う (サーバー専用の import をしない)
 */

export const WORK_REPORT_SETTINGS_ID = "work_report";

export interface WorkReportFactors {
  fusuma: number;
  shoji: number;
  amido: number;
}

/** 襖類 (係数後) の係数の既定値 (作業日報の表計算の値: 障子 0.5・網戸 0.4) */
export const DEFAULT_FACTORS: WorkReportFactors = { fusuma: 1, shoji: 0.5, amido: 0.4 };

const factorOf = (v: unknown, d: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 100) / 100 : d;
};

export function readWorkReportSettings(db: Pick<Database, "settings">): { factors: WorkReportFactors; configured: boolean; updatedAt?: string; updatedBy?: string } {
  const s = (db.settings ?? []).find((x) => x.id === WORK_REPORT_SETTINGS_ID);
  const f = (s?.value?.factors ?? {}) as Record<string, unknown>;
  return {
    factors: { fusuma: factorOf(f.fusuma, DEFAULT_FACTORS.fusuma), shoji: factorOf(f.shoji, DEFAULT_FACTORS.shoji), amido: factorOf(f.amido, DEFAULT_FACTORS.amido) },
    configured: Boolean(s),
    updatedAt: s?.updatedAt,
    updatedBy: s?.updatedBy,
  };
}

export const UNIT_KEYS = ["tatamiOmote", "tatamiNew", "fusumaRe", "fusumaNew", "shojiRe", "shojiNew", "amidoRe", "amidoNew", "other"] as const;
export type UnitKey = (typeof UNIT_KEYS)[number];
export type Units = Record<UnitKey, number>;
export const UNIT_LABEL: Record<UnitKey, string> = {
  tatamiOmote: "畳 表",
  tatamiNew: "畳 新",
  fusumaRe: "襖 張替",
  fusumaNew: "襖 新",
  shojiRe: "障子 張替",
  shojiNew: "障子 新",
  amidoRe: "網戸 張替",
  amidoNew: "網戸 新",
  other: "その他",
};

export const emptyUnits = (): Units => ({ tatamiOmote: 0, tatamiNew: 0, fusumaRe: 0, fusumaNew: 0, shojiRe: 0, shojiNew: 0, amidoRe: 0, amidoNew: 0, other: 0 });

/** 作業日報の欄: 引取 / 納品 / 見積 (現地調査・採寸) / 施工 */
export type LineKind = "pickup" | "delivery" | "survey" | "install";
export const LINE_KIND_LABEL: Record<LineKind, string> = { pickup: "引取", delivery: "納品", survey: "見積", install: "施工" };
export const LINE_KIND_OF: Partial<Record<ScheduleKind, LineKind>> = { pickup: "pickup", delivery: "delivery", survey: "survey", onsite_quote: "survey", measure: "survey", install: "install" };

export interface WorkLine {
  eventId: string;
  kind: ScheduleKind;
  line: LineKind;
  date: string;
  /** 時刻 (09:00) / 午前 / 午後 / 空 (終日) */
  time: string;
  /** 現場名 (お客様の名前。お客様のない予定は件名) */
  site: string;
  title: string;
  customerId?: string;
  orderId?: string;
  orderNumber?: string;
  units: Units;
  /** その他の内容 (例: リフォーム・施工 1 式) */
  otherNote: string;
  assigneeIds: string[];
  assignees: string[];
  /** 枚数をどこから読んだか */
  source: SpecSource;
  /** 枚数がわからない (作業の内容・件名・メモ・受注・見積のどれにもない) */
  noQty: boolean;
}

export interface WorkDay {
  date: string;
  weekday: number;
  closed: boolean;
  pickups: WorkLine[];
  deliveries: WorkLine[];
  surveys: WorkLine[];
  installs: WorkLine[];
  flyers: WorkReportFlyer[];
  visitors?: number;
  note?: string;
  entryId?: string;
}

export interface SideTotals {
  count: number;
  units: Units;
  /** 畳 (表 + 新) */
  tatami: number;
  /** 襖類 (係数後) */
  fusumaWeighted: number;
}

export interface Productivity {
  total: number;
  perPerson: number | null;
  perDay: number | null;
  perPersonDay: number | null;
}

export interface WorkReport {
  storeId: StoreId;
  month: string;
  from: string;
  to: string;
  days: WorkDay[];
  totals: { pickup: SideTotals; delivery: SideTotals; survey: number; install: number; flyerCopies: number; flyerLines: number; visitors: number; visitorDays: number };
  /** 引取・納品の担当者の人数 */
  people: number;
  /** 引取・納品のあった日数 */
  workDays: number;
  /** 日ごとの引取・納品の担当者の人数の合計 */
  personDays: number;
  /** 引取の畳の枚数 (表 + 新) の総数・1 人あたり・1 日あたり・1 人日あたり */
  tatami: Productivity;
  /** 引取の襖類 (係数後) */
  fusumaWeighted: Productivity;
  factors: WorkReportFactors;
  /** 枚数がわからない引取・納品 */
  noQty: WorkLine[];
  /** 予定表の件数 (照合用。店舗・開始日が月内の引き取り・納品の予定) */
  scheduleCounts: { pickup: number; delivery: number };
}

export const workReportDayId = (storeId: StoreId, date: string) => `wr_${storeId}_${date}`;

/** YYYY-MM か */
export function isMonthKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

const CAT_WORD = { tatami: "畳", fusuma: "襖", shoji: "障子", amido: "網戸" } as const;

/** 「新」(新調・新規) の作業か。作業種別の名前・ID、または件名・メモ・明細の「襖 新調」のような書き方 */
export function isNewWork(wt: Pick<WorkType, "id" | "name" | "category">, hint: string): boolean {
  if (/新/.test(wt.name) || /(^|_)new($|_)/.test(wt.id)) return true;
  if (wt.category === "tatami" || !(wt.category in CAT_WORD)) return false;
  const word = CAT_WORD[wt.category as keyof typeof CAT_WORD];
  for (const m of hint.normalize("NFKC").matchAll(new RegExp(`${word}[^\\d\\n/、]{0,8}`, "g"))) if (/新/.test(m[0].slice(word.length))) return true;
  return false;
}

const fusumaWeighted = (u: Units, f: WorkReportFactors) => (u.fusumaRe + u.fusumaNew) * f.fusuma + (u.shojiRe + u.shojiNew) * f.shoji + (u.amidoRe + u.amidoNew) * f.amido;
const round1 = (n: number) => Math.round(n * 10) / 10;
const per = (total: number, n: number): number | null => (n > 0 ? round1(total / n) : null);

function side(lines: WorkLine[], f: WorkReportFactors): SideTotals {
  const units = emptyUnits();
  for (const l of lines) for (const k of UNIT_KEYS) units[k] += l.units[k];
  return { count: lines.length, units, tatami: units.tatamiOmote + units.tatamiNew, fusumaWeighted: round1(fusumaWeighted(units, f)) };
}

const caseKey = (e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId">) => (e.orderId ? `o:${e.orderId}` : e.quoteId ? `q:${e.quoteId}` : e.inquiryId ? `i:${e.inquiryId}` : "");

type ReportDb = Pick<Database, "schedule" | "orders" | "quotes" | "customers" | "users" | "settings" | "stores" | "jobSpecs" | "products" | "holidays" | "workReportDays">;

/** 店舗・月の作業日報 */
export function buildWorkReport(db: ReportDb, storeId: StoreId, month: string): WorkReport {
  const from = `${month}-01`;
  const to = monthEnd(from);
  const masters = loadMasters(db);
  const { factors } = readWorkReportSettings(db);
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const users = new Map(db.users.map((u) => [u.id, u.name]));

  const events = db.schedule.filter((e) => e.storeId === storeId && e.date >= from && e.date <= to && LINE_KIND_OF[e.kind]).sort(compareEvents);
  // 同じ案件の予定 (納品の予定に枚数がなければ、引き取りの予定の件名・メモから読む)
  const byCase = new Map<string, ScheduleEvent[]>();
  const keys = new Set(events.map(caseKey).filter(Boolean));
  for (const e of db.schedule) {
    const k = caseKey(e);
    if (k && keys.has(k) && (e.kind === "pickup" || e.kind === "delivery" || e.kind === "install" || e.kind === "measure")) byCase.set(k, [...(byCase.get(k) ?? []), e]);
  }

  const toLine = (e: ScheduleEvent): WorkLine => {
    const order: Order | undefined = e.orderId ? orders.get(e.orderId) : undefined;
    const quote: Quote | undefined = (e.quoteId ? quotes.get(e.quoteId) : undefined) ?? (order?.quoteId ? quotes.get(order.quoteId) : undefined);
    const text = `${e.title ?? ""}\n${e.memo ?? ""}`;
    const caseEvents = (byCase.get(caseKey(e)) ?? []).filter((x) => x.id !== e.id);
    const job = resolveJob(db, masters, { kind: e.kind, eventId: e.id, orderId: order?.id, quoteId: quote?.id, inquiryId: e.inquiryId, text, order, quote, caseEvents });
    const hint = [
      text,
      ...caseEvents.map((x) => `${x.title}\n${x.memo ?? ""}`),
      order?.title,
      order?.workDetails,
      ...(order?.progressNotes ?? []).filter((p) => /明細/.test(p.body)).map((p) => p.body),
      quote?.title,
      ...(quote?.items ?? []).map((i) => `${i.name} ${i.spec ?? ""}`),
    ]
      .filter(Boolean)
      .join("\n");
    const units = emptyUnits();
    const other: string[] = [];
    for (const it of job.items) {
      const wt = it.workType;
      const isNew = isNewWork(wt, hint);
      if (wt.category === "tatami") units[isNew ? "tatamiNew" : "tatamiOmote"] += it.qty;
      else if (wt.category === "fusuma") units[isNew ? "fusumaNew" : "fusumaRe"] += it.qty;
      else if (wt.category === "shoji") units[isNew ? "shojiNew" : "shojiRe"] += it.qty;
      else if (wt.category === "amido") units[isNew ? "amidoNew" : "amidoRe"] += it.qty;
      else {
        units.other += it.qty;
        other.push(`${wt.name} ${it.qty}${wt.unit}`);
      }
    }
    const customer = e.customerId ? customers.get(e.customerId) : order ? customers.get(order.customerId) : undefined;
    return {
      eventId: e.id,
      kind: e.kind,
      line: LINE_KIND_OF[e.kind]!,
      date: e.date,
      time: e.startTime ?? (e.slot === "am" ? "午前" : e.slot === "pm" ? "午後" : ""),
      site: customer ? `${customer.name} 様` : e.title,
      title: e.title,
      customerId: customer?.id,
      orderId: order?.id,
      orderNumber: order?.number,
      units,
      otherNote: other.join("・"),
      assigneeIds: e.assigneeIds ?? [],
      assignees: (e.assigneeIds ?? []).map((id) => users.get(id) ?? id),
      source: job.source,
      noQty: job.items.length === 0,
    };
  };

  const lines = events.map(toLine);
  const entries = new Map<string, WorkReportDay>();
  for (const w of db.workReportDays ?? []) if (w.storeId === storeId && w.date >= from && w.date <= to) entries.set(w.date, w);

  const days: WorkDay[] = dateRange(from, to).map((date) => {
    const of = (k: LineKind) => lines.filter((l) => l.date === date && l.line === k);
    const w = entries.get(date);
    return {
      date,
      weekday: dayOfWeek(date),
      closed: isClosedDay(db, date),
      pickups: of("pickup"),
      deliveries: of("delivery"),
      surveys: of("survey"),
      installs: of("install"),
      flyers: w?.flyers ?? [],
      visitors: w?.visitors,
      note: w?.note,
      entryId: w?.id,
    };
  });

  const pickups = lines.filter((l) => l.line === "pickup");
  const deliveries = lines.filter((l) => l.line === "delivery");
  const field = [...pickups, ...deliveries];
  const people = new Set(field.flatMap((l) => l.assigneeIds)).size;
  const workDays = new Set(field.map((l) => l.date)).size;
  let personDays = 0;
  for (const d of days) personDays += new Set([...d.pickups, ...d.deliveries].flatMap((l) => l.assigneeIds)).size;
  const pickup = side(pickups, factors);
  const delivery = side(deliveries, factors);
  const prod = (total: number): Productivity => ({ total: round1(total), perPerson: per(total, people), perDay: per(total, workDays), perPersonDay: per(total, personDays) });

  return {
    storeId,
    month,
    from,
    to,
    days,
    totals: {
      pickup,
      delivery,
      survey: lines.filter((l) => l.line === "survey").length,
      install: lines.filter((l) => l.line === "install").length,
      flyerCopies: days.reduce((a, d) => a + d.flyers.reduce((b, f) => b + (f.copies || 0), 0), 0),
      flyerLines: days.reduce((a, d) => a + d.flyers.length, 0),
      visitors: days.reduce((a, d) => a + (d.visitors ?? 0), 0),
      visitorDays: days.filter((d) => d.visitors !== undefined).length,
    },
    people,
    workDays,
    personDays,
    tatami: prod(pickup.tatami),
    fusumaWeighted: prod(fusumaWeighted(pickup.units, factors)),
    factors,
    noQty: field.filter((l) => l.noQty),
    scheduleCounts: {
      pickup: db.schedule.filter((e) => e.storeId === storeId && e.kind === "pickup" && e.date >= from && e.date <= to).length,
      delivery: db.schedule.filter((e) => e.storeId === storeId && e.kind === "delivery" && e.date >= from && e.date <= to).length,
    },
  };
}

/* ---------------- 表の行 (画面・印刷・CSV で同じ並び) ---------------- */

/** 作業日報の表の 1 行 (1 日に複数の行。引取・納品・見積・施工・チラシの多い方の行数) */
export interface SheetRow {
  day: WorkDay;
  /** その日の最初の行 (日付・来店数を出す) */
  first: boolean;
  /** その日の行数 */
  span: number;
  pickup?: WorkLine;
  delivery?: WorkLine;
  survey?: WorkLine;
  install?: WorkLine;
  flyer?: WorkReportFlyer;
}

export function sheetRows(report: Pick<WorkReport, "days">): SheetRow[] {
  const out: SheetRow[] = [];
  for (const day of report.days) {
    const span = Math.max(1, day.pickups.length, day.deliveries.length, day.surveys.length, day.installs.length, day.flyers.length);
    for (let i = 0; i < span; i++) out.push({ day, first: i === 0, span, pickup: day.pickups[i], delivery: day.deliveries[i], survey: day.surveys[i], install: day.installs[i], flyer: day.flyers[i] });
  }
  return out;
}

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
export const weekdayLabel = (d: number) => WEEKDAY[d] ?? "";
const n0 = (v: number) => (v ? v : "");
const lineSite = (l?: WorkLine) => (l ? `${l.time ? `${l.time} ` : ""}${l.site}` : "");

/** 表の見出し (CSV) */
export const SHEET_HEADER = [
  "日",
  "曜日",
  "引取 現場名",
  "畳 表",
  "畳 新",
  "襖 張替",
  "襖 新",
  "障子 張替",
  "障子 新",
  "網戸 張替",
  "網戸 新",
  "その他",
  "引取 担当",
  "見積 (現地調査・採寸)",
  "見積 担当",
  "施工",
  "施工 担当",
  "配布人",
  "枚数",
  "配布地域",
  "納品 現場名",
  "畳 表",
  "畳 新",
  "襖",
  "障子",
  "網戸",
  "その他",
  "納品 担当",
  "来店数",
  "メモ",
];

/** 作業日報の CSV (表計算と同じ並び。1 行目に店舗・月、合計と見出しの集計を最後に付ける) */
export function workReportCsvRows(r: WorkReport, storeName: string): (string | number)[][] {
  const rows: (string | number)[][] = [[`作業日報 ${storeName} ${r.month.replace("-", "年")}月`], SHEET_HEADER];
  for (const s of sheetRows(r)) {
    const p = s.pickup;
    const d = s.delivery;
    rows.push([
      s.first ? Number(s.day.date.slice(8)) : "",
      s.first ? weekdayLabel(s.day.weekday) + (s.day.closed ? " (休)" : "") : "",
      lineSite(p),
      n0(p?.units.tatamiOmote ?? 0),
      n0(p?.units.tatamiNew ?? 0),
      n0(p?.units.fusumaRe ?? 0),
      n0(p?.units.fusumaNew ?? 0),
      n0(p?.units.shojiRe ?? 0),
      n0(p?.units.shojiNew ?? 0),
      n0(p?.units.amidoRe ?? 0),
      n0(p?.units.amidoNew ?? 0),
      p ? p.otherNote || n0(p.units.other) : "",
      p?.assignees.join("・") ?? "",
      lineSite(s.survey),
      s.survey?.assignees.join("・") ?? "",
      lineSite(s.install),
      s.install?.assignees.join("・") ?? "",
      s.flyer?.distributor ?? "",
      s.flyer ? s.flyer.copies : "",
      s.flyer?.area ?? "",
      lineSite(d),
      n0(d?.units.tatamiOmote ?? 0),
      n0(d?.units.tatamiNew ?? 0),
      n0((d?.units.fusumaRe ?? 0) + (d?.units.fusumaNew ?? 0)),
      n0((d?.units.shojiRe ?? 0) + (d?.units.shojiNew ?? 0)),
      n0((d?.units.amidoRe ?? 0) + (d?.units.amidoNew ?? 0)),
      d ? d.otherNote || n0(d.units.other) : "",
      d?.assignees.join("・") ?? "",
      s.first && s.day.visitors !== undefined ? s.day.visitors : "",
      s.first ? (s.day.note ?? "") : "",
    ]);
  }
  const pu = r.totals.pickup.units;
  const du = r.totals.delivery.units;
  rows.push([]);
  rows.push(["合計", "", `引取 ${r.totals.pickup.count} 件`, pu.tatamiOmote, pu.tatamiNew, pu.fusumaRe, pu.fusumaNew, pu.shojiRe, pu.shojiNew, pu.amidoRe, pu.amidoNew, pu.other, "", `見積 ${r.totals.survey} 件`, "", `施工 ${r.totals.install} 件`, "", "", r.totals.flyerCopies, "", `納品 ${r.totals.delivery.count} 件`, du.tatamiOmote, du.tatamiNew, du.fusumaRe + du.fusumaNew, du.shojiRe + du.shojiNew, du.amidoRe + du.amidoNew, du.other, "", r.totals.visitors, ""]);
  rows.push([]);
  rows.push(["見出しの集計 (引取)", "", "総数", "／人", "／日", "／人日"]);
  rows.push(["畳", "", r.tatami.total, r.tatami.perPerson ?? "", r.tatami.perDay ?? "", r.tatami.perPersonDay ?? ""]);
  rows.push([`襖類 (係数後: 障子 ${r.factors.shoji}・網戸 ${r.factors.amido})`, "", r.fusumaWeighted.total, r.fusumaWeighted.perPerson ?? "", r.fusumaWeighted.perDay ?? "", r.fusumaWeighted.perPersonDay ?? ""]);
  rows.push(["人・日・人日", "", `${r.people} 人`, `${r.workDays} 日`, `${r.personDays} 人日`]);
  return rows;
}

/** 明細の CSV (1 行 = 予定 1 件。区分ごとの行数が予定表の件数と一致する) */
export function workLinesCsvRows(r: WorkReport): (string | number)[][] {
  const rows: (string | number)[][] = [["日付", "曜日", "区分", "時刻", "現場名", "件名", ...UNIT_KEYS.map((k) => UNIT_LABEL[k]), "その他の内容", "担当", "枚数の出どころ", "受注番号", "予定 ID"]];
  const SOURCE: Record<SpecSource, string> = { spec: "作業の内容", memo: "件名・メモ", order: "受注の明細", quote: "見積の明細", input: "入力", none: "なし" };
  for (const d of r.days)
    for (const l of [...d.pickups, ...d.deliveries, ...d.surveys, ...d.installs])
      rows.push([l.date, weekdayLabel(d.weekday), LINE_KIND_LABEL[l.line], l.time, l.site, l.title, ...UNIT_KEYS.map((k) => l.units[k]), l.otherNote, l.assignees.join("・"), SOURCE[l.source], l.orderNumber ?? "", l.eventId]);
  for (const d of r.days) {
    for (const f of d.flyers) rows.push([d.date, weekdayLabel(d.weekday), "チラシ", "", f.distributor, f.area ?? "", ...UNIT_KEYS.map(() => ""), `${f.copies} 枚`, "", "手入力", "", ""]);
    if (d.visitors !== undefined) rows.push([d.date, weekdayLabel(d.weekday), "来店", "", "", "", ...UNIT_KEYS.map(() => ""), `${d.visitors} 人`, "", "手入力", "", ""]);
  }
  return rows;
}

/* ---------------- 手入力の読み取り (画面のフォーム) ---------------- */

export interface DayInput {
  date: string;
  visitors?: number;
  flyers: WorkReportFlyer[];
  note?: string;
}

/** 名前から社員を探す (空白を除いて一致)。配布人の欄は「田中・佐藤」のように複数を書ける */
export function matchStaff(users: { id: string; name: string; active?: boolean }[], text: string): string[] {
  const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "");
  const parts = text.split(/[、,・/／]/).map(norm).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const u = users.find((x) => norm(x.name) === p) ?? users.find((x) => x.active !== false && p.length >= 2 && norm(x.name).startsWith(p));
    if (u && !out.includes(u.id)) out.push(u.id);
  }
  return out;
}

/** 入力の値をそろえる (空・不正な値は落とす)。日付が月の外なら null */
export function cleanDayInput(month: string, raw: { date: string; visitors?: string; note?: string; flyers: { distributor?: string; copies?: string; area?: string }[] }, users: { id: string; name: string; active?: boolean }[]): DayInput | { error: string } | null {
  if (!isDateKey(raw.date) || !raw.date.startsWith(month)) return null;
  const int = (v: string | undefined, label: string): number | undefined | { error: string } => {
    const s = (v ?? "").replace(/[,\s枚人]/g, "").normalize("NFKC");
    if (!s) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { error: `${raw.date.slice(5).replace("-", "/")} の${label}は 0 以上の整数で入力してください。` };
    return n;
  };
  const visitors = int(raw.visitors, "来店数");
  if (typeof visitors === "object") return visitors;
  const flyers: WorkReportFlyer[] = [];
  for (const f of raw.flyers) {
    const distributor = (f.distributor ?? "").trim().slice(0, 60);
    const area = (f.area ?? "").trim().slice(0, 60);
    const copies = int(f.copies, "チラシの枚数");
    if (typeof copies === "object") return copies;
    if (!distributor && !area && copies === undefined) continue;
    if (copies === undefined) return { error: `${raw.date.slice(5).replace("-", "/")} のチラシの枚数を入力してください (配布人・地域だけでは登録できません)。` };
    flyers.push({ distributor, userIds: matchStaff(users, distributor), copies, ...(area ? { area } : {}) });
  }
  const note = (raw.note ?? "").trim().slice(0, 300);
  return { date: raw.date, visitors, flyers, note: note || undefined };
}
