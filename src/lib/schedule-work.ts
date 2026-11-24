import type { Database, JobSpec, Order, Quote, ScheduleEvent } from "@/lib/db/types";
import { HANDOVER_ITEM, classifyLine, parseHandoverRef } from "@/lib/handover";
import { loadMasters, type Masters } from "@/lib/scheduling/masters";
import { specId } from "@/lib/scheduling/spec";
import { countsFromLines, countsFromText, emptyCounts, hasWork, mergeCounts, type WorkCounts, type WorkKey, type WorkLine } from "@/lib/work-summary";

/**
 * 予定表の予定ごとの仕事内容と数量 (お客様のご要望 2026-11-23「■2」。表示は src/lib/work-summary.ts の workTokens)
 * ------------------------------------------------------------
 * 優先順位:
 * 1. 予定の作業の内容 (job_specs の event。/schedule/spec で登録したもの)
 * 2. 受注の引取・納品の予定 (sourceRef = handover:…): その予定の品目 (畳・襖など) の見積の明細だけ
 * 3. 受注・見積にひも付く予定: 見積の明細 (移行した受注は経過メモの「明細 (税込): …」)
 * 4. 受注・見積・問い合わせの作業の内容 (job_specs)
 * 5. 予定の件名・メモ (移行した予定表の「畳 表替え12 / 襖 張替3」、手書きの「タ6フ1」「縁無半12」)
 * 6. 見積の予定 (現地調査・採寸) の問い合わせ: 内容の文と種別 (畳・襖・障子・網戸)
 * 施工 (リフォーム) と社内の予定は対象外 (これまでどおりの表示)
 */

const CASE_KINDS = new Set(["pickup", "delivery", "survey", "onsite_quote", "measure", "visit", "site"]);
const CATEGORY_KEY: Partial<Record<string, WorkKey>> = { tatami: "tatami", fusuma: "fusuma", shoji: "shoji", amido: "amido", curtain: "curtain" };

interface Lookup {
  orders: Map<string, Order>;
  quotes: Map<string, Quote>;
  products: Map<string, string>;
  specs: Map<string, JobSpec>;
  inquiries: Map<string, Database["inquiries"][number]>;
  masters?: Masters;
}

function lookup(db: Database): Lookup {
  const specs = new Map((db.jobSpecs ?? []).filter((s) => s.items?.length).map((s) => [s.id, s]));
  let masters: Masters | undefined;
  if (specs.size) {
    try {
      masters = loadMasters(db);
    } catch {
      masters = undefined;
    }
  }
  return {
    orders: new Map(db.orders.map((o) => [o.id, o])),
    quotes: new Map(db.quotes.map((q) => [q.id, q])),
    products: new Map((db.products ?? []).map((p) => [p.id, p.category as string])),
    specs,
    inquiries: new Map(db.inquiries.map((i) => [i.id, i])),
    masters,
  };
}

const quoteLines = (lk: Lookup, q: Quote | undefined): WorkLine[] =>
  (q?.items ?? []).map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, productCategory: i.productId ? lk.products.get(i.productId) : undefined }));

/** 移行した受注の経過メモ「明細 (税込): 畳 きずな 6×¥…」 */
function noteLines(o: Order): WorkLine[] {
  const out: WorkLine[] = [];
  for (const p of o.progressNotes ?? []) {
    const line = p.body.match(/明細 \((?:税込|税抜)\): (.*)/);
    if (!line) continue;
    for (const part of line[1].split(" / ")) {
      const r = part.match(/^(\S+) (.+?) (-?[\d.]+)×¥/);
      if (r) out.push({ name: `${r[1]} ${r[2]}`, qty: Number(r[3]) });
    }
  }
  return out;
}

function orderLines(lk: Lookup, o: Order): WorkLine[] {
  const q = o.quoteId ? lk.quotes.get(o.quoteId) : undefined;
  const lines = quoteLines(lk, q);
  return lines.length ? lines : noteLines(o);
}

/** 作業の内容 (job_specs) の数量 */
function specCounts(lk: Lookup, s: JobSpec | undefined): WorkCounts | undefined {
  if (!s || !lk.masters) return undefined;
  const c = emptyCounts();
  for (const it of s.items) {
    const wt: { name: string; category: string } | undefined = lk.masters.workTypeById.get(it.workTypeId);
    const key = wt ? CATEGORY_KEY[wt.category] : undefined;
    if (!wt || !key) continue;
    if (it.qty > 0) c[key] += it.qty;
    else c.seen[key] = true;
    if (key === "tatami" && /縁無|へり無|ヘリ無|琉球/.test(wt.name)) {
      c.herinashiSeen = true;
      c.herinashi += it.qty;
    }
  }
  return hasWork(c) ? c : undefined;
}

const specOf = (lk: Lookup, type: JobSpec["recordType"], id: string | undefined) => (id ? lk.specs.get(specId(type, id)) : undefined);

function eventCounts(lk: Lookup, e: ScheduleEvent): WorkCounts | undefined {
  const fromEventSpec = specCounts(lk, specOf(lk, "event", e.id));
  if (fromEventSpec) return fromEventSpec;

  const order = e.orderId ? lk.orders.get(e.orderId) : undefined;
  // 受注の引取・納品の予定: その予定に載せた品目の明細だけ (畳の引き取りと襖の引き取りが別の日でも、それぞれの数量)
  const ref = parseHandoverRef(e.sourceRef);
  if (order && ref) {
    const rows = (order.handovers ?? []).filter((r) => ref.rowIds.includes(r.id));
    const items = new Set(rows.map((r) => r.item));
    const lines = orderLines(lk, order).filter((l) => {
      const it = classifyLine(l.name, l.productCategory, l.spec);
      return it !== undefined && items.has(it);
    });
    let c = countsFromLines(lines);
    // 縁・引手などの行の印 (へり無し畳) は同じ品目の明細から
    if (!hasWork(c)) c = rows.reduce((acc, r) => mergeCounts(acc, countsFromText(r.label?.trim() || HANDOVER_ITEM[r.item].label)), emptyCounts());
    if (hasWork(c)) return c;
  }
  if (order) {
    const c = countsFromLines(orderLines(lk, order));
    if (hasWork(c)) return c;
  }
  const quote = e.quoteId ? lk.quotes.get(e.quoteId) : order?.quoteId ? lk.quotes.get(order.quoteId) : undefined;
  if (quote && !order) {
    const c = countsFromLines(quoteLines(lk, quote));
    if (hasWork(c)) return c;
  }
  const fromSpecs = specCounts(lk, specOf(lk, "order", e.orderId)) ?? specCounts(lk, specOf(lk, "quote", e.quoteId)) ?? specCounts(lk, specOf(lk, "inquiry", e.inquiryId));
  if (fromSpecs) return fromSpecs;

  // 件名・メモ: 「畳 表替え12 / 襖 張替3」(移行した予定表はメモの 1 行目が数量の欄。2 行目からは手書きのメモ)。
  // なければメモの手書きの省略「タ6フ1」。へり無し畳 (「縁無半12」) はメモのどこに書いてあっても見る
  const memoText = e.memo ?? "";
  const structuredText = e.source === "import" ? `${e.title}\n${memoText.split("\n")[0]}` : `${e.title}\n${memoText}`;
  const herinashi = countsFromText(memoText);
  const withHerinashi = (c: WorkCounts): WorkCounts => (herinashi.herinashiSeen ? { ...c, herinashi: Math.max(c.herinashi, herinashi.herinashi), herinashiSeen: true, herinashiHalf: c.herinashiHalf || herinashi.herinashiHalf, seen: { ...c.seen, ...(c.tatami ? {} : { tatami: true }) } } : c);
  const structured = countsFromText(structuredText);
  if (structured.tatami || structured.fusuma || structured.shoji || structured.amido || structured.curtain) return withHerinashi(structured);
  const memo = countsFromText(memoText, { shorthand: true });
  if (hasWork(memo)) return memo;

  // 見積の予定 (現地調査・採寸・顧客訪問): 問い合わせの内容と種別
  const inq = e.inquiryId ? lk.inquiries.get(e.inquiryId) : undefined;
  if (inq) {
    const c = countsFromText(`${inq.summary}\n${inq.detail}`);
    if (hasWork(c)) return c;
    const key = CATEGORY_KEY[inq.category];
    if (key) {
      const only = emptyCounts();
      only.seen[key] = true;
      return only;
    }
  }
  return hasWork(structured) ? withHerinashi(structured) : undefined;
}

/** 予定ごとの仕事内容と数量 (案件の予定だけ。仕事内容の分からない予定は入れない) */
export function scheduleWork(db: Database, events: ScheduleEvent[]): Map<string, WorkCounts> {
  const out = new Map<string, WorkCounts>();
  const targets = events.filter((e) => CASE_KINDS.has(e.kind));
  if (!targets.length) return out;
  const lk = lookup(db);
  for (const e of targets) {
    const c = eventCounts(lk, e);
    if (c && hasWork(c)) out.set(e.id, c);
  }
  return out;
}
