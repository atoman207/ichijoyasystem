import type { Database, Inquiry, Order, Quote, ScheduleEvent, StoreId } from "@/lib/db/types";
import { caseIndex, inquiryCase, orderCase, quoteCase, STAGE_LABEL, type CaseRow, type Stage } from "@/lib/case-status";

/**
 * 案件 (お客様のご要望 2026-11-26「■4 顧客と案件の定義・管理イメージ」)
 * ------------------------------------------------------------
 * 顧客
 * └ 案件 (複数)
 *     ├ 問い合わせ (複数)・対応履歴
 *     ├ 見積 (複数)・受注 (複数。追加工事を含む)
 *     ├ 予定 (複数) → 予定表
 *     ├ 請求・入金
 *     └ 写真・資料・アンケート
 * 案件の表は持たず、案件 = 最初の記録 (問い合わせ / 見積 / 受注) とし、その ID を案件の ID・番号を案件の番号にする。
 * 記録は次の順で案件を決める: caseId (ほかの案件に追加した記録) → 受注 ← 見積 (quoteId) → 見積 ← 問い合わせ (inquiryId) → 自分。
 * 今までの記録 (つながりだけ) はそのまま 1 つの案件になり、作り直さない。案件の画面は /cases/<案件の ID>。
 * 状態 (進行中・過去) は案件の一覧と同じ case-status.ts の行から決める (どれかの行が終わっていなければ進行中)
 */

type Db = Pick<Database, "inquiries" | "quotes" | "orders">;
export type CaseKind = "inquiry" | "quote" | "order";

export const kindOfId = (id: string | undefined): CaseKind | undefined => (!id ? undefined : id.startsWith("o_") ? "order" : id.startsWith("q_") ? "quote" : id.startsWith("inq_") ? "inquiry" : undefined);
export const caseHref = (caseId: string) => `/cases/${caseId}`;

export interface CaseMembers {
  id: string;
  kind: CaseKind;
  inquiries: Inquiry[];
  quotes: Quote[];
  orders: Order[];
}

export interface CaseMap {
  /** 記録の ID → 案件の ID */
  caseOf(id: string | undefined): string | undefined;
  /** 案件の ID → 案件の記録 */
  members(caseId: string): CaseMembers | undefined;
  all(): CaseMembers[];
}

/** すべての記録の案件を決める (1 回の画面で 1 回。数万件でも数ミリ秒) */
export function buildCaseMap(db: Db): CaseMap {
  const inq = new Map(db.inquiries.map((i) => [i.id, i]));
  const qs = new Map(db.quotes.map((q) => [q.id, q]));
  const os = new Map(db.orders.map((o) => [o.id, o]));
  const exists = (id: string) => inq.has(id) || qs.has(id) || os.has(id);
  const memo = new Map<string, string>();
  const root = (id: string, depth = 0): string => {
    const hit = memo.get(id);
    if (hit) return hit;
    let r = id;
    if (depth < 10) {
      const k = kindOfId(id);
      const rec = k === "order" ? os.get(id) : k === "quote" ? qs.get(id) : k === "inquiry" ? inq.get(id) : undefined;
      const viaCase = rec?.caseId && rec.caseId !== id && exists(rec.caseId) ? rec.caseId : undefined;
      if (viaCase) r = root(viaCase, depth + 1);
      else if (k === "order" && (rec as Order | undefined)?.quoteId && qs.has((rec as Order).quoteId!)) r = root((rec as Order).quoteId!, depth + 1);
      else if (k === "quote" && (rec as Quote | undefined)?.inquiryId && inq.has((rec as Quote).inquiryId!)) r = root((rec as Quote).inquiryId!, depth + 1);
    }
    memo.set(id, r);
    return r;
  };
  const groups = new Map<string, CaseMembers>();
  const group = (id: string) => {
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, kind: kindOfId(id) ?? "inquiry", inquiries: [], quotes: [], orders: [] }));
    return g;
  };
  for (const i of db.inquiries) if (!i.deleted) group(root(i.id)).inquiries.push(i);
  for (const q of db.quotes) group(root(q.id)).quotes.push(q);
  for (const o of db.orders) group(root(o.id)).orders.push(o);
  for (const g of groups.values()) {
    g.inquiries.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    g.quotes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    g.orders.sort((a, b) => (a.contractDate || a.createdAt).localeCompare(b.contractDate || b.createdAt));
  }
  return {
    caseOf: (id) => (id && exists(id) ? root(id) : undefined),
    members: (caseId) => groups.get(caseId),
    all: () => [...groups.values()],
  };
}

/** 記録 (問い合わせ・見積・受注) の案件の ID */
export function caseIdOf(db: Db, id: string | undefined): string | undefined {
  return buildCaseMap(db).caseOf(id);
}

/** 予定の案件の ID (受注 → 見積 → 問い合わせ) */
export function caseIdOfEvent(map: CaseMap, e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId">): string | undefined {
  return map.caseOf(e.orderId ?? e.quoteId ?? e.inquiryId);
}

export interface CaseSummary {
  id: string;
  number: string;
  href: string;
  title: string;
  customerId?: string;
  storeId: StoreId;
  open: boolean;
  stage: Stage;
  stageLabel: string;
  /** 細かな状態 (例: 見積済・TEL待ち / 完了・未入金) */
  detail: string;
  startedAt: string;
  lastAt: string;
  /** 受注の合計 (受注がなければ最新の見積の金額) */
  amount?: number;
  amountLabel: string;
  counts: { inquiries: number; quotes: number; orders: number };
  /** 行 (受注・受注になっていない見積・見積のない問い合わせ。case-status.ts) */
  rows: CaseRow[];
}

const RANK: Record<Stage, number> = { lost: 0, cancelled: 0, inquiry: 1, visit_planned: 2, quoted: 3, ordered: 4, in_progress: 5, completed: 6 };

/** 案件の状態と要約 */
export function summarizeCase(m: CaseMembers, ix: ReturnType<typeof caseIndex>, today: string): CaseSummary {
  const orders = m.orders;
  const ordered = new Set(orders.map((o) => o.quoteId).filter(Boolean) as string[]);
  const lastOrderAt = orders.reduce((a, o) => (o.createdAt > a ? o.createdAt : a), "");
  const rows: CaseRow[] = orders.map((o) => orderCase(o, ix, today));
  for (const q of m.quotes) {
    if (q.orderId || ordered.has(q.id)) continue;
    const r = quoteCase(q, ix);
    // 受注のある案件の、受注より前の見積 (受注にならなかった別の案) は履歴 (案件を進行中にしない)
    if (lastOrderAt && q.createdAt <= lastOrderAt && !r.closed) rows.push({ ...r, closed: true, detail: "受注にならなかった見積 (履歴)" });
    else rows.push(r);
  }
  const quotedInquiries = new Set(m.quotes.map((q) => q.inquiryId).filter(Boolean) as string[]);
  for (const i of m.inquiries) {
    if (i.quoteId || quotedInquiries.has(i.id)) continue;
    rows.push(inquiryCase(i, ix, today));
  }
  const openRows = rows.filter((r) => !r.closed);
  const pick = (list: CaseRow[]) => [...list].sort((a, b) => RANK[b.stage] - RANK[a.stage] || b.date.localeCompare(a.date))[0];
  const main = pick(openRows) ?? pick(rows);
  const first = m.kind === "order" ? orders.find((o) => o.id === m.id) : m.kind === "quote" ? m.quotes.find((q) => q.id === m.id) : m.inquiries.find((i) => i.id === m.id);
  const latestOrder = orders.filter((o) => o.status !== "cancelled").at(-1);
  const latestQuote = m.quotes.at(-1);
  const orderTotal = orders.filter((o) => o.status !== "cancelled").reduce((a, o) => a + o.total, 0);
  const dates = [...rows.map((r) => r.date), ...m.inquiries.map((i) => i.receivedAt.slice(0, 10))].filter(Boolean).sort();
  const title = latestOrder?.title ?? latestQuote?.title ?? m.inquiries.at(-1)?.summary ?? main?.title ?? "";
  return {
    id: m.id,
    number: first?.number ?? main?.number ?? m.id,
    href: caseHref(m.id),
    title,
    customerId: orders[0]?.customerId ?? m.quotes[0]?.customerId ?? m.inquiries.find((i) => i.customerId)?.customerId,
    storeId: latestOrder?.storeId ?? latestQuote?.storeId ?? m.inquiries.at(-1)?.storeId ?? main?.storeId ?? "",
    open: openRows.length > 0,
    stage: main?.stage ?? "inquiry",
    stageLabel: STAGE_LABEL[main?.stage ?? "inquiry"],
    detail: main?.detail ?? "",
    startedAt: dates[0] ?? "",
    lastAt: dates.at(-1) ?? "",
    amount: orders.length ? orderTotal : latestQuote?.total,
    amountLabel: orders.length ? (orders.length > 1 ? `受注 ${orders.length} 件の合計` : "受注") : latestQuote ? "見積" : "",
    counts: { inquiries: m.inquiries.length, quotes: m.quotes.length, orders: orders.length },
    rows,
  };
}

/** お客様の案件 (進行中 → 過去。どちらも新しい順) */
export function customerCaseSummaries(db: Database, customerId: string, today: string, map: CaseMap = buildCaseMap(db)): { open: CaseSummary[]; past: CaseSummary[] } {
  const ix = caseIndex(db);
  const ids = new Set<string>();
  for (const i of db.inquiries) if (i.customerId === customerId && !i.deleted) ids.add(map.caseOf(i.id)!);
  for (const q of db.quotes) if (q.customerId === customerId) ids.add(map.caseOf(q.id)!);
  for (const o of db.orders) if (o.customerId === customerId) ids.add(map.caseOf(o.id)!);
  const list = [...ids].map((id) => map.members(id)).filter((m): m is CaseMembers => Boolean(m)).map((m) => summarizeCase(m, ix, today));
  const byLast = (a: CaseSummary, b: CaseSummary) => b.lastAt.localeCompare(a.lastAt) || b.number.localeCompare(a.number);
  return { open: list.filter((c) => c.open).sort(byLast), past: list.filter((c) => !c.open).sort(byLast) };
}

/** 案件の要約 (案件の ID か、その案件のどれかの記録の ID) */
export function caseSummary(db: Database, id: string, today: string, map: CaseMap = buildCaseMap(db)): CaseSummary | undefined {
  const caseId = map.caseOf(id);
  const m = caseId ? map.members(caseId) : undefined;
  return m ? summarizeCase(m, caseIndex(db), today) : undefined;
}

/**
 * 案件に見積を足すときのつながり: 問い合わせのある案件は、その案件のいちばん新しい問い合わせ (inquiryId)、
 * 問い合わせのない案件 (見積・受注から始まった案件。移行した受注など) は caseId
 */
export function quoteLinkForCase(db: Database, caseId: string, map: CaseMap = buildCaseMap(db)): { inquiryId?: string; caseId?: string; customerId?: string; storeId?: StoreId } | undefined {
  const m = map.members(caseId);
  if (!m) return undefined;
  const s = summarizeCase(m, caseIndex(db), new Date().toISOString().slice(0, 10));
  const inquiry = [...m.inquiries].reverse().find((i) => !i.deleted);
  return inquiry ? { inquiryId: inquiry.id, customerId: s.customerId, storeId: s.storeId } : { caseId, customerId: s.customerId, storeId: s.storeId };
}
