import type { Database, Order, OrderHandover, ScheduleEvent, StoreId, TatamiProduction, TatamiRoom } from "@/lib/db/types";
import { cleanRooms, roomTotals, roomsFromSheetMemo, fmtQty, type TatamiWork } from "@/lib/tatami-spec";
import { orderRooms } from "@/lib/tatami-rooms";
import { classifyLine, HANDOVER_ITEM } from "@/lib/handover";
import { lineKind } from "@/lib/line-kind";
import { countsFromLines, countsFromText, stripKindWords, type WorkLine } from "@/lib/work-summary";
import { addDays } from "@/lib/format";
import { isClosedDay } from "@/lib/schedule-capacity";
import { shortDate } from "@/lib/calendar";
import { compareStoreIds } from "@/lib/store-order";

/**
 * 畳製造予定 (お客様のご要望 2026-11-23「■3. 畳製造予定表」)
 * ------------------------------------------------------------
 * いつ・どの店舗の・どの案件 (仕様) で・何畳の製造が必要か。予定そのものは毎回計算し、人が決めたこと (製造日の変更・繰り越し・
 * 製造日未定・製造済み) だけを表 tatami_production に持つ (types-ops.ts の TatamiProduction)。
 *
 * 元の日 (製造日の初期値):
 * - 受注の引取・納品の日程 (畳の品目の行): 表替え・裏返しは引取日、新調は採寸の予定の日 (なければ引取日)。引取日が同じ行は 1 行にまとめる
 * - 日程の行がない受注 (以前の形): 採寸 (新調)・引き取りの予定の日 → 施工予定の開始日
 * - 予定表の引き取りの予定 (移行した予定表・受注にひも付かない予定): 予定の日。畳の数量は「畳 表替え12」と「縁無半9」から
 * - 手で足した行
 * 日付がなければ「製造日未定」。製造日を変えても、引取日・納品日の予定は変えない (予定表の予定には触れない)。
 * 元の日 (引取日) があとで変わったとき、製造日を手で決めていない行は新しい引取日に動き、手で決めた行はそのまま (注意を出す)。
 *
 * 部屋ごとの仕様 (畳表・畳縁・畳床・寸法。src/lib/tatami-spec.ts): 受注の行は受注の仕様 (受注 → 見積で入れた仕様 → 見積の明細から自動) の
 * うちこの行の作業 (表替え・裏返し・新調) の部屋、移行した予定表の引き取りは工場の製造の表の行 (メモの「製造: …」)、
 * 手で足した行・受注のない行で人が入れた仕様は TatamiProduction.rooms。人が入れた仕様があれば畳数は部屋の合計
 *
 * 済みの扱い: 製造済みにした行のほか、受注が施工完了以降・納品の日が過ぎた予定は製造済みとみなす。
 * この画面を使い始める前の予定 (PRODUCTION_START より前) は製造済みとみなす (移行した予定表の過去の引き取りを未完了として出さない)。
 */

/** この画面を使い始めた日 (これより前の引き取りは製造済みとみなす) */
export const PRODUCTION_START = "2026-11-24";
/** 未完了として出す期間 (今日より前の日数) */
export const OVERDUE_DAYS = 14;

export type ProductionMode = "auto" | "manual" | "undecided";
export type ProductionStatus = "planned" | "done" | "cancelled";

export interface ProductionRow {
  /** 元の印 (TatamiProduction.sourceKey) */
  key: string;
  record?: TatamiProduction;
  source: "order" | "schedule" | "manual";
  storeId: StoreId;
  orderId?: string;
  orderNumber?: string;
  eventId?: string;
  customerId?: string;
  /** お客様・現場 (例: 倉本 様 / (清水万石) 谷本) */
  name: string;
  /** 仕様 (例: 畳 表替え さくら 12畳 / 縁 マス菊) */
  spec: string;
  /** 作業 (表替え・裏返し・新調) */
  work: string;
  /** 畳数 (分からなければ 0) */
  qty: number;
  herinashi: number;
  herinashiSeen: boolean;
  herinashiHalf: boolean;
  /** 元の日 (引取日・採寸日) */
  baseDate?: string;
  baseLabel: string;
  /** 製造日 (未定なら空) */
  date?: string;
  mode: ProductionMode;
  status: ProductionStatus;
  /** 受注の施工完了・納品済みで、製造済みとみなした */
  autoDone: boolean;
  deliveryDate?: string;
  href?: string;
  /** 注意 (引取日が変わった・製造日が納品日より後) */
  warnings: string[];
  /** 部屋ごとの仕様 (畳表・畳縁・畳床・寸法) */
  rooms: TatamiRoom[];
  /** 仕様の出どころ: order / quote / record = 人が入れた、auto = 見積の明細から自動、sheet = 予定表の製造の表、count = 畳数だけ */
  roomsSource: "order" | "quote" | "auto" | "sheet" | "record" | "count";
  /** 仕様を保存する先 (受注の行はその受注の、この行の作業の部屋) */
  roomsTarget: { kind: "order"; orderId: string; works: TatamiWork[] } | { kind: "record" };
}

const DONE_ORDER = new Set(["completed", "invoiced", "paid"]);

const lineText = (l: WorkLine) => `${l.name}${l.spec ? ` ${l.spec}` : ""}${l.qty ? ` ${Number.isInteger(l.qty) ? l.qty : l.qty.toFixed(1)}${l.unit ?? ""}` : ""}`.replace(/\s+/g, " ").trim();
const WORK_NAME = { omote: "表替え", ura: "裏返し", new: "新調" } as const;

function uniqJoin(xs: string[], sep = "・"): string {
  return [...new Set(xs.filter(Boolean))].join(sep);
}

interface Index {
  quotes: Map<string, Database["quotes"][number]>;
  productCategory: Map<string, string>;
}

function orderLines(ix: Index, o: Order): WorkLine[] {
  const q = o.quoteId ? ix.quotes.get(o.quoteId) : undefined;
  return (q?.items ?? []).map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, productCategory: i.productId ? ix.productCategory.get(i.productId) : undefined }));
}

interface Candidate extends Omit<ProductionRow, "record" | "date" | "mode" | "status" | "warnings"> {
  autoDone: boolean;
  /** 仕様の注意 (部屋の畳数の合計が見積と違う など) */
  specWarnings?: string[];
}

const ITEM_WORK: Record<string, TatamiWork> = { tatami_omote: "omote", tatami_ura: "ura", tatami_new: "new" };
/** 作業の言葉 (表替え・新調・裏返し) → 作業 */
const workOf = (text: string): TatamiWork => (/新調|新/.test(text) ? "new" : /裏返/.test(text) ? "ura" : "omote");
/** 仕様の入っていない行の部屋 (畳数だけ) */
function countRoom(work: TatamiWork, qty: number, herinashi: number, key: string): TatamiRoom {
  return { id: `tr_${key.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-20) || "row"}`, work, qty: qty > 0 ? qty : 0, ...(herinashi > 0 && herinashi >= qty ? { herinashi: true } : {}) };
}

/** 受注の候補 (畳の明細・畳の品目の日程がある受注) */
function orderCandidates(db: Database, events: ScheduleEvent[], today: string): Candidate[] {
  const out: Candidate[] = [];
  const ix: Index = { quotes: new Map(db.quotes.map((q) => [q.id, q])), productCategory: new Map((db.products ?? []).map((p) => [p.id, p.category as string])) };
  const customers = new Map(db.customers.map((c) => [c.id, c.name]));
  const byOrder = new Map<string, ScheduleEvent[]>();
  for (const e of events) if (e.orderId) byOrder.set(e.orderId, [...(byOrder.get(e.orderId) ?? []), e]);
  for (const o of db.orders) {
    if (o.source === "import" || o.status === "cancelled") continue;
    const lines = orderLines(ix, o);
    const kinds = lines.map((l) => ({ l, k: lineKind(l.name, l.spec, l.productCategory) }));
    const tatamiLines = kinds.filter((x) => x.k?.kind === "tatami");
    const heriLines = kinds.filter((x) => x.k?.kind === "heri");
    const tatamiRows = (o.handovers ?? []).filter((r) => r.item.startsWith("tatami_"));
    if (!tatamiLines.length && !tatamiRows.length) continue;
    const evs = (byOrder.get(o.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const measure = evs.find((e) => e.kind === "measure")?.date;
    const name = `${customers.get(o.customerId) ?? o.title} 様`;
    const autoDone = DONE_ORDER.has(o.status);
    const base = { source: "order" as const, storeId: o.storeId, orderId: o.id, orderNumber: o.number, customerId: o.customerId, name, href: `/orders/${o.id}`, autoDone };
    const heriSpec = heriLines.map((x) => lineText(x.l));
    const spec = orderRooms(db, o);
    const explicitSpec = spec.source === "order" || spec.source === "quote";

    if (tatamiRows.length) {
      // 引取日 (新調は採寸の日) が同じ畳の行を 1 行にまとめる
      const baseOf = (r: OrderHandover) => (r.item === "tatami_new" && measure ? measure : r.pickupDate);
      const groups = new Map<string, OrderHandover[]>();
      for (const r of tatamiRows) {
        const k = baseOf(r) ?? "";
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      const itemsInGroups = [...groups.values()].flatMap((rs) => [...new Set(rs.map((r) => r.item))]);
      const sharedItem = new Set(itemsInGroups.filter((it, i) => itemsInGroups.indexOf(it) !== i));
      for (const [b, rows] of groups) {
        const items = new Set(rows.map((r) => r.item));
        const mine = tatamiLines.filter((x) => items.has(classifyLine(x.l.name, x.l.productCategory, x.l.spec) ?? "other"));
        // 同じ品目 (例: 表替え) を別の日に分けたときは、明細では分けられないので日程の行の名前 (「畳 表替え 6枚」) の数量
        const counts = rows.some((r) => sharedItem.has(r.item)) || !mine.length ? countsFromText(rows.map((r) => r.label?.trim() || HANDOVER_ITEM[r.item].label).join(" / ")) : countsFromLines(mine.map((x) => x.l));
        const herinashi = countsFromLines(mine.map((x) => x.l));
        const deliveries = rows.map((r) => r.deliveryDate).filter((d): d is string => Boolean(d)).sort();
        // 部屋ごとの仕様: この行の作業 (表替え・裏返し・新調) の部屋
        const works = [...new Set(rows.map((r) => ITEM_WORK[r.item]))];
        const shared = rows.some((r) => sharedItem.has(r.item));
        let rooms = spec.rooms.filter((r) => works.includes(r.work));
        let roomsSource: ProductionRow["roomsSource"] = spec.source;
        if (!rooms.length) {
          rooms = [countRoom(works[0], Math.max(counts.tatami, herinashi.herinashi), herinashi.herinashi, rows[0].id)];
          roomsSource = "count";
        }
        const t = roomTotals(rooms);
        const lineQty = Math.max(counts.tatami, herinashi.herinashi);
        const useRooms = explicitSpec && roomsSource !== "count" && !shared && t.qty > 0;
        const specWarnings: string[] = [];
        if (useRooms && lineQty > 0 && Math.abs(t.qty - lineQty) > 0.01) specWarnings.push(`部屋ごとの畳数の合計 (${fmtQty(t.qty)}畳) が見積の畳数 (${fmtQty(lineQty)}畳) と違います。仕様を確かめてください`);
        if (shared && roomsSource !== "count") specWarnings.push("同じ作業を別の日に分けているため、部屋の仕様は両方の日に出しています");
        out.push({
          ...base,
          rooms,
          roomsSource,
          roomsTarget: { kind: "order", orderId: o.id, works },
          specWarnings,
          key: `ho:${rows[0].id}`,
          spec: uniqJoin([...(mine.length ? mine.map((x) => lineText(x.l)) : rows.map((r) => r.label?.trim() || HANDOVER_ITEM[r.item].label)), ...heriSpec], " / "),
          work: uniqJoin(rows.map((r) => HANDOVER_ITEM[r.item].label.replace(/^畳\s*/, ""))),
          qty: useRooms ? t.qty : lineQty,
          herinashi: useRooms ? t.herinashi : herinashi.herinashi,
          herinashiSeen: useRooms ? t.herinashiSeen : herinashi.herinashiSeen,
          herinashiHalf: herinashi.herinashiHalf,
          baseDate: b || undefined,
          baseLabel: rows.some((r) => r.item === "tatami_new") && measure && b === measure ? "採寸日" : "引取日",
          deliveryDate: deliveries[0],
          // 納品が済んだ (納品の日が過ぎた) 品目は製造済みとみなす
          autoDone: autoDone || Boolean(deliveries.length === rows.length && deliveries[deliveries.length - 1] < today),
        });
      }
      continue;
    }
    // 日程の行がない受注 (以前の形): 採寸 (新調) → 引き取りの予定 → 施工予定の開始日
    const isNew = tatamiLines.some((x) => x.k?.tatami === "new");
    const pickup = evs.find((e) => e.kind === "pickup")?.date;
    const delivery = evs.filter((e) => e.kind === "delivery").map((e) => e.date)[0];
    const b = (isNew && measure) || pickup || o.scheduledStart;
    const c = countsFromLines(tatamiLines.map((x) => x.l));
    const allWorks = [...new Set(tatamiLines.map((x) => x.k?.tatami ?? "omote"))] as TatamiWork[];
    let rooms = spec.rooms;
    let roomsSource: ProductionRow["roomsSource"] = spec.source;
    if (!rooms.length) {
      rooms = [countRoom(allWorks[0] ?? "omote", c.tatami, c.herinashi, o.id)];
      roomsSource = "count";
    }
    const t = roomTotals(rooms);
    const useRooms = explicitSpec && roomsSource !== "count" && t.qty > 0;
    out.push({
      ...base,
      rooms,
      roomsSource,
      roomsTarget: { kind: "order", orderId: o.id, works: allWorks.length ? allWorks : ["omote", "ura", "new"] },
      specWarnings: useRooms && c.tatami > 0 && Math.abs(t.qty - c.tatami) > 0.01 ? [`部屋ごとの畳数の合計 (${fmtQty(t.qty)}畳) が見積の畳数 (${fmtQty(c.tatami)}畳) と違います。仕様を確かめてください`] : [],
      key: `ord:${o.id}`,
      spec: uniqJoin([...tatamiLines.map((x) => lineText(x.l)), ...heriSpec], " / "),
      work: uniqJoin(tatamiLines.map((x) => WORK_NAME[x.k?.tatami ?? "omote"])),
      qty: useRooms ? t.qty : c.tatami,
      herinashi: useRooms ? t.herinashi : c.herinashi,
      herinashiSeen: useRooms ? t.herinashiSeen : c.herinashiSeen,
      herinashiHalf: c.herinashiHalf,
      baseDate: b || undefined,
      baseLabel: isNew && measure && b === measure ? "採寸日" : pickup && b === pickup ? "引取日" : "施工予定",
      deliveryDate: delivery ?? (o.scheduledEnd && o.scheduledEnd !== b ? o.scheduledEnd : undefined),
      autoDone: autoDone || Boolean(delivery && delivery < today),
    });
  }
  return out;
}

/** 予定表の引き取りの予定 (受注にひも付かないもの: 移行した予定表・手で登録した予定) の候補 */
function eventCandidates(db: Database, events: ScheduleEvent[], coveredOrders: Set<string>, today: string): Candidate[] {
  const out: Candidate[] = [];
  if (!events.length) return out;
  // 納品の予定の索引 (店舗 + 件名から種類の言葉を除いたもの)。引き取りの日から 60 日以内
  const first = events.reduce((m, e) => (e.date < m ? e.date : m), events[0].date);
  const last = addDays(events.reduce((m, e) => (e.date > m ? e.date : m), events[0].date), 60);
  const deliveryIndex = new Map<string, string[]>();
  for (const d of db.schedule) {
    if (d.kind !== "delivery" || d.date < first || d.date > last) continue;
    const k = `${d.storeId}|${stripKindWords(d.title, "delivery")}`;
    deliveryIndex.set(k, [...(deliveryIndex.get(k) ?? []), d.date]);
  }
  for (const e of events) {
    if (e.kind !== "pickup" || e.source === "order" || (e.orderId && coveredOrders.has(e.orderId))) continue;
    const memo = e.memo ?? "";
    const first = e.source === "import" ? memo.split("\n")[0] : memo;
    const c = countsFromText(`${e.title}\n${first}`);
    const h = countsFromText(memo);
    const qty = Math.max(c.tatami, h.herinashi);
    if (!qty && !h.herinashiSeen && !c.seen.tatami) continue;
    const segs = first.split(/\s\/\s/).filter((s) => /畳/.test(s));
    const herinashiWords = [...memo.normalize("NFKC").matchAll(/(?:縁|へり|ヘリ)\s*(?:無し?|なし|ナシ)(?!から)半?\d{0,3}/g)].map((m) => m[0]);
    const name = stripKindWords(e.title, "pickup");
    const limit = addDays(e.date, 60);
    const delivery = (deliveryIndex.get(`${e.storeId}|${name}`) ?? []).filter((d) => d >= e.date && d <= limit).sort()[0];
    // 部屋ごとの仕様: 予定表の工場の製造の表の行 (メモの「製造: …」)。なければ畳数だけ
    const work = uniqJoin(segs.map((s) => (/新調/.test(s) ? "新調" : /裏返/.test(s) ? "裏返し" : "表替え"))) || (h.herinashiSeen ? "へり無し" : "");
    const sheetRooms = roomsFromSheetMemo(memo);
    const sheetQty = roomTotals(sheetRooms).qty;
    out.push({
      rooms: sheetRooms.length ? sheetRooms : [countRoom(workOf(work), qty, h.herinashi, e.id)],
      roomsSource: sheetRooms.length ? "sheet" : "count",
      roomsTarget: { kind: "record" },
      specWarnings: sheetRooms.length && qty > 0 && sheetQty > 0 && Math.abs(sheetQty - qty) > 0.01 ? [`予定表の製造の表の枚数 (${fmtQty(sheetQty)}畳) と引き取りの畳数 (${fmtQty(qty)}畳) が違います。仕様を確かめてください`] : [],
      key: `ev:${e.id}`,
      source: "schedule",
      storeId: e.storeId,
      orderId: e.orderId,
      eventId: e.id,
      customerId: e.customerId,
      name,
      spec: uniqJoin([...segs, ...herinashiWords], " / ") || (h.herinashiSeen ? "へり無し畳" : "畳"),
      work,
      qty,
      herinashi: h.herinashi,
      herinashiSeen: h.herinashiSeen,
      herinashiHalf: h.herinashiHalf,
      baseDate: e.date,
      baseLabel: "引取日",
      deliveryDate: delivery,
      href: `/schedule/${e.id}`,
      autoDone: e.date < PRODUCTION_START || Boolean(delivery && delivery < today),
    });
  }
  return out;
}

export interface ProductionQuery {
  /** 表示する期間 (製造日) */
  from: string;
  to: string;
  today: string;
}

/**
 * 畳製造予定の行 (期間の行・前日までの未完了・製造日未定)。店舗の絞り込みは呼び出し側で
 */
export function productionRows(db: Database, q: ProductionQuery): ProductionRow[] {
  const records = db.tatamiProduction ?? [];
  const byKey = new Map(records.map((r) => [r.sourceKey, r]));
  const overdueFrom = [addDays(q.today, -OVERDUE_DAYS), PRODUCTION_START].sort()[1];
  const windowFrom = [q.from, overdueFrom].sort()[0];
  const recordEvents = new Set(records.map((r) => r.eventId).filter(Boolean) as string[]);
  // 予定表の予定: 期間・未完了の期間の引き取りと、人が日付を変えた行の元の予定。受注の採寸・引き取り・納品の予定 (全期間)
  const liveOrders = new Set(db.orders.filter((o) => o.source !== "import" && o.status !== "cancelled").map((o) => o.id));
  const events = db.schedule.filter((e) => (e.date >= windowFrom && e.date <= q.to) || recordEvents.has(e.id) || (e.orderId && liveOrders.has(e.orderId) && (e.kind === "measure" || e.kind === "pickup" || e.kind === "delivery")));
  const orders = orderCandidates(db, events, q.today);
  const covered = new Set(orders.map((c) => c.orderId!).filter(Boolean));
  const candidates: Candidate[] = [...orders, ...eventCandidates(db, events.filter((e) => e.kind === "pickup"), covered, q.today)];
  // 手で足した行
  for (const r of records) {
    if (!r.sourceKey.startsWith("man:")) continue;
    const c = countsFromText(r.spec ?? "");
    candidates.push({
      key: r.sourceKey,
      source: "manual",
      storeId: r.storeId,
      orderId: r.orderId,
      orderNumber: r.orderId ? db.orders.find((o) => o.id === r.orderId)?.number : undefined,
      customerId: r.customerId,
      name: r.title || "製造の予定",
      spec: r.spec ?? "",
      work: "",
      qty: r.qty ?? 0,
      herinashi: r.herinashi ?? 0,
      herinashiSeen: Boolean(r.herinashi) || c.herinashiSeen,
      herinashiHalf: c.herinashiHalf,
      baseDate: undefined,
      baseLabel: "手で追加",
      href: r.orderId ? `/orders/${r.orderId}` : undefined,
      autoDone: false,
      rooms: [countRoom(workOf(r.spec ?? ""), r.qty ?? 0, r.herinashi ?? 0, r.sourceKey)],
      roomsSource: "count",
      roomsTarget: { kind: "record" },
    });
  }

  const out: ProductionRow[] = [];
  for (const c of candidates) {
    const record = byKey.get(c.key);
    const status: ProductionStatus = record?.status === "cancelled" ? "cancelled" : record?.status === "done" || c.autoDone ? "done" : "planned";
    const undecided = Boolean(record?.undecided) || (!record?.date && !c.baseDate);
    const date = undecided ? undefined : (record?.date ?? c.baseDate);
    const mode: ProductionMode = undecided ? "undecided" : record?.date ? "manual" : "auto";
    const warnings: string[] = [];
    if (record?.date && record.baseDate && c.baseDate && record.baseDate !== c.baseDate) warnings.push(`${c.baseLabel}が変わりました (${shortDate(record.baseDate)} → ${shortDate(c.baseDate)})。製造日を確かめてください`);
    if (date && c.deliveryDate && date > c.deliveryDate && status === "planned") warnings.push(`製造日が納品日 (${shortDate(c.deliveryDate)}) より後です`);
    const { specWarnings, ...cand } = c;
    warnings.push(...(specWarnings ?? []));
    // 受注のない行で人が入れた仕様 (部屋ごと) があれば、畳数も部屋の合計
    const saved = cand.roomsTarget.kind === "record" ? cleanRooms(record?.rooms ?? []).rooms : [];
    if (saved.length) {
      const t = roomTotals(saved);
      Object.assign(cand, { rooms: saved, roomsSource: "record" as const }, t.qty > 0 ? { qty: t.qty, herinashi: t.herinashi, herinashiSeen: t.herinashiSeen } : {});
    }
    out.push({ ...cand, record, date, mode, status, warnings });
  }
  return out;
}

export interface ProductionView {
  /** 期間の行 (製造日の順。取り消した行は除く) */
  inRange: ProductionRow[];
  /** 前日までの未完了 (製造日が過ぎて、製造済みでない) */
  overdue: ProductionRow[];
  /** 製造日未定 */
  undecided: ProductionRow[];
}

const byDateThenStore = (a: ProductionRow, b: ProductionRow) => (a.date ?? "").localeCompare(b.date ?? "") || compareStoreIds(a.storeId, b.storeId) || a.name.localeCompare(b.name, "ja");

/** 画面の区分 (店舗で絞った行) */
export function productionView(rows: ProductionRow[], q: ProductionQuery): ProductionView {
  const overdueFrom = [addDays(q.today, -OVERDUE_DAYS), PRODUCTION_START].sort()[1];
  const live = rows.filter((r) => r.status !== "cancelled");
  return {
    inRange: live.filter((r) => r.date && r.date >= q.from && r.date <= q.to).sort(byDateThenStore),
    overdue: live.filter((r) => r.status === "planned" && r.date && r.date < q.today && r.date >= overdueFrom && r.date < q.from).sort(byDateThenStore),
    undecided: live.filter((r) => r.mode === "undecided" && r.status === "planned").sort((a, b) => (a.deliveryDate ?? "9999").localeCompare(b.deliveryDate ?? "9999") || a.name.localeCompare(b.name, "ja")),
  };
}

export interface DayTotal {
  count: number;
  qty: number;
  herinashi: number;
  herinashiSeen: boolean;
  /** 製造済みでない行 */
  open: number;
}

/** 日ごとの合計 (予定表の日のリンク用) */
export function productionByDay(rows: ProductionRow[]): Map<string, DayTotal> {
  const out = new Map<string, DayTotal>();
  for (const r of rows) {
    if (!r.date || r.status === "cancelled") continue;
    const t = out.get(r.date) ?? { count: 0, qty: 0, herinashi: 0, herinashiSeen: false, open: 0 };
    t.count += 1;
    t.qty += r.qty;
    t.herinashi += r.herinashi;
    t.herinashiSeen ||= r.herinashiSeen;
    if (r.status === "planned") t.open += 1;
    out.set(r.date, t);
  }
  return out;
}

/** 使う材料の合計 (畳製造予定の日ごと・期間。お客様のご質問 2026-11-23「その日に使う材料や減りが分かるところある？」) */
export interface MaterialTotals {
  /** 畳表 (表替え・新調。裏返しは今の表を使う) */
  omote: { name: string; qty: number }[];
  /** 畳縁 (縁無を除く) */
  heri: { name: string; qty: number }[];
  /** 縁無 (へり無し畳) の畳数 */
  herinashi: number;
  /** 畳床 (新調だけ。表替え・裏返しは今の床) */
  doko: { name: string; qty: number }[];
  /** 仕様が未確認 (部屋ごとの仕様がない) の畳数 */
  unknown: number;
}

/**
 * 製造の予定の行から、使う材料 (畳表・畳縁・畳床) を畳数で合計する。部屋ごとの仕様 (rooms) の品名ごと。
 * 品名が空の部屋は「未確認」、仕様のない行は unknown に数える。取り消した行は数えない
 */
export function productionMaterials(rows: Pick<ProductionRow, "rooms" | "qty" | "status" | "roomsSource">[]): MaterialTotals {
  const omote = new Map<string, number>();
  const heri = new Map<string, number>();
  const doko = new Map<string, number>();
  let herinashi = 0;
  let unknown = 0;
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of rows) {
    if (r.status === "cancelled") continue;
    const rooms = r.roomsSource === "count" ? [] : r.rooms.filter((x) => x.qty > 0);
    if (!rooms.length) {
      unknown += r.qty;
      continue;
    }
    for (const x of rooms) {
      if (x.work !== "ura") add(omote, x.omote?.trim() || "畳表 未確認", x.qty);
      if (x.herinashi) herinashi += x.qty;
      else add(heri, x.heri?.trim() || "縁 未確認", x.qty);
      if (x.work === "new") add(doko, `${x.doko?.trim() || "畳床 未確認"}${x.dokoThickness ? ` ${x.dokoThickness}` : ""}`, x.qty);
    }
  }
  // 未確認は最後、ほかは畳数の多い順
  const list = (m: Map<string, number>) => [...m].map(([name, qty]) => ({ name, qty })).sort((a, b) => Number(a.name.includes("未確認")) - Number(b.name.includes("未確認")) || b.qty - a.qty || a.name.localeCompare(b.name, "ja"));
  return { omote: list(omote), heri: list(heri), herinashi, doko: list(doko), unknown };
}

/** 次の営業日 (休日カレンダーの休業日を飛ばす) */
export function nextWorkDay(db: Pick<Database, "holidays">, from: string): string {
  let d = addDays(from, 1);
  for (let i = 0; i < 14 && isClosedDay(db, d); i++) d = addDays(d, 1);
  return d;
}

/**
 * 繰り越し先: 製造日の翌営業日。前日までの未完了は今日 (今日が休業日なら次の営業日)
 */
export function carryTarget(db: Pick<Database, "holidays">, date: string | undefined, today: string): string {
  if (!date || date < today) return isClosedDay(db, today) ? nextWorkDay(db, today) : today;
  return nextWorkDay(db, date);
}

/** 行の ID (元の印ごとに 1 行) */
export function productionId(sourceKey: string): string {
  return `tp_${sourceKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** 畳数の表示 (例: 12畳 (縁無半 6)) */
export function qtyLabel(r: Pick<ProductionRow, "qty" | "herinashi" | "herinashiSeen" | "herinashiHalf">): string {
  const n = r.qty ? `${Number.isInteger(r.qty) ? r.qty : r.qty.toFixed(1)}畳` : "畳数不明";
  if (!r.herinashiSeen) return n;
  const h = r.herinashi && r.herinashi < r.qty ? ` ${r.herinashi}` : "";
  return `${n} (縁無${r.herinashiHalf ? "半" : ""}${h})`;
}

/** 元の印 1 つの行 (操作のときに使う。予定表の予定の行は、その予定の日を含めて計算する) */
export function findProductionRow(db: Database, key: string, today: string): ProductionRow | undefined {
  const rec = (db.tatamiProduction ?? []).find((r) => r.sourceKey === key);
  const ev = key.startsWith("ev:") ? db.schedule.find((e) => e.id === key.slice(3)) : undefined;
  const dates = [today, rec?.date, rec?.baseDate, ev?.date].filter((d): d is string => Boolean(d)).sort();
  return productionRows(db, { from: dates[0], to: dates[dates.length - 1], today }).find((r) => r.key === key);
}
