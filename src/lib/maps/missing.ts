import "server-only";
import type { Database } from "@/lib/db/types";
import { toCsv } from "@/lib/csv";
import { mapIndex, placeOfCustomer, placeOfOrder } from "./resolve";

/**
 * 住宅地図が未登録の一覧 (お客様のご要望 2026-11-24「② 既存顧客の住宅地図の一括登録」)
 * ------------------------------------------------------------
 * ゼンリン GIS には API がなく、地図はご契約部署の方がゼンリン GIS で出力する (システムから自動で取得しない)。
 * 出力する順番を決めやすいよう、住宅地図のない お客様の住所・施工場所 を 優先度の順に並べる:
 *   1 = 今後の予定がある / 2 = 進行中の案件がある / 3 = そのほか (最後の取引が新しい順)
 * 「登録用のファイル名」(C-01234.pdf = 顧客 / O-2026-0012.pdf = 施工場所がお客様の住所と別の受注) で保存して取込フォルダーに置くと、
 * 一括取込 (batch.ts の pdf_import) がそのまま記録に結び付ける。番地のない住所は地図の場所を決められないので一覧に入れない
 */

const OPEN_ORDER = new Set(["pending_approval", "returned", "confirmed", "scheduled", "in_progress"]);
const OPEN_QUOTE = new Set(["draft", "pending_approval", "approved", "sent", "accepted"]);
const OPEN_INQUIRY = new Set(["new", "in_progress", "quoted"]);

export interface MissingMapRow {
  priority: 1 | 2 | 3;
  fileName: string;
  kind: "customer" | "order";
  customerCode: string;
  customerName: string;
  address: string;
  storeId: string;
  nextDate?: string;
  nextTitle?: string;
  openCase?: string;
  lastTrade?: string;
  /** 照合キー (同じ番地 = 同じ場所。1 枚の地図で足りる) */
  key: string;
}

export function missingMapRows(db: Database, today: string, opts: { scope?: "priority" | "all" } = {}): MissingMapRow[] {
  const idx = mapIndex(db);
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const inquiries = new Map(db.inquiries.map((i) => [i.id, i]));
  const customerOf = (e: { customerId?: string; orderId?: string; quoteId?: string; inquiryId?: string }) =>
    e.customerId || (e.orderId && orders.get(e.orderId)?.customerId) || (e.quoteId && quotes.get(e.quoteId)?.customerId) || (e.inquiryId && inquiries.get(e.inquiryId)?.customerId) || undefined;

  // 今後の予定 (お客様ごと・受注ごとにいちばん近い日)
  const nextByCustomer = new Map<string, { date: string; title: string }>();
  const nextByOrder = new Map<string, { date: string; title: string }>();
  for (const e of db.schedule) {
    if (!e.date || e.date < today) continue;
    const v = { date: e.date, title: e.title };
    const cid = customerOf(e);
    if (cid && (nextByCustomer.get(cid)?.date ?? "9999") > e.date) nextByCustomer.set(cid, v);
    if (e.orderId && (nextByOrder.get(e.orderId)?.date ?? "9999") > e.date) nextByOrder.set(e.orderId, v);
  }
  // 進行中の案件 (受注 → 見積 → 問い合わせ の番号)
  const openByCustomer = new Map<string, string>();
  for (const o of db.orders) if (OPEN_ORDER.has(o.status) && o.customerId && !openByCustomer.has(o.customerId)) openByCustomer.set(o.customerId, o.number);
  for (const q of db.quotes) if (OPEN_QUOTE.has(q.status) && q.customerId && !q.orderId && !openByCustomer.has(q.customerId)) openByCustomer.set(q.customerId, q.number);
  for (const i of db.inquiries) if (OPEN_INQUIRY.has(i.status) && i.customerId && !openByCustomer.has(i.customerId)) openByCustomer.set(i.customerId, i.number);
  // 最後の取引 (受注の売上計上日・契約日)
  const lastByCustomer = new Map<string, string>();
  for (const o of db.orders) {
    const d = (o.salesDate || o.contractDate || o.createdAt || "").slice(0, 10);
    if (o.customerId && d && (lastByCustomer.get(o.customerId) ?? "") < d) lastByCustomer.set(o.customerId, d);
  }

  const rows: MissingMapRow[] = [];
  for (const c of db.customers) {
    if (c.tradeStopped) continue;
    const place = placeOfCustomer(db, c, idx);
    if (place.norm.precision !== "house" || place.documents.length) continue;
    const next = nextByCustomer.get(c.id);
    const open = openByCustomer.get(c.id);
    const priority = next ? 1 : open ? 2 : 3;
    if (opts.scope === "priority" && priority === 3) continue;
    rows.push({ key: place.norm.key, priority, fileName: `${c.code}.pdf`, kind: "customer", customerCode: c.code, customerName: c.name, address: place.addressText, storeId: c.storeId, nextDate: next?.date, nextTitle: next?.title, openCase: open, lastTrade: lastByCustomer.get(c.id) });
  }
  // 施工場所がお客様の住所と別の、進行中の受注
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  for (const o of db.orders) {
    if (!OPEN_ORDER.has(o.status) || !o.siteAddress) continue;
    const place = placeOfOrder(db, o, idx);
    if (place.sameAsCustomer !== false || place.norm.precision !== "house" || place.documents.length) continue;
    const c = customers.get(o.customerId);
    const next = nextByOrder.get(o.id);
    rows.push({ key: place.norm.key, priority: next ? 1 : 2, fileName: `${o.number}.pdf`, kind: "order", customerCode: c?.code ?? "", customerName: c?.name ?? "", address: place.addressText, storeId: o.storeId, nextDate: next?.date, nextTitle: next?.title, openCase: o.number, lastTrade: lastByCustomer.get(o.customerId) });
  }
  rows.sort((a, b) => a.priority - b.priority || (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999") || (b.lastTrade ?? "").localeCompare(a.lastTrade ?? "") || a.fileName.localeCompare(b.fileName));
  // 同じ番地 (同じ家のご家族・同じ現場) は 1 枚の地図で足りる (場所は番地で共有する): 並べたあとで優先度の高い行だけを残す
  const keys = new Set<string>();
  return rows.filter((r) => (keys.has(r.key) ? false : (keys.add(r.key), true)));
}

const PRIORITY_LABEL = { 1: "1 今後の予定あり", 2: "2 進行中の案件あり", 3: "3 そのほか" } as const;

export function missingMapCsv(db: Database, rows: MissingMapRow[]): string {
  const stores = new Map(db.stores.map((s) => [s.id, s.shortName || s.name]));
  return toCsv([
    ["優先度", "登録用のファイル名", "種類", "顧客コード", "お客様", "住所 (ゼンリン GIS の地点検索に貼り付け)", "店舗", "次の予定日", "次の予定", "進行中の案件", "最後の取引日"],
    ...rows.map((r) => [PRIORITY_LABEL[r.priority], r.fileName, r.kind === "order" ? "施工場所 (受注)" : "お客様の住所", r.customerCode, r.customerName, r.address, stores.get(r.storeId) ?? r.storeId, r.nextDate ?? "", r.nextTitle ?? "", r.openCase ?? "", r.lastTrade ?? ""]),
  ]);
}
