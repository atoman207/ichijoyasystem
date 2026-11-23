import type { Database, Order, StoreId } from "@/lib/db/types";
import { isLedgerOnly, isSlipOrder, planReconcile } from "@/lib/sales-reconcile";
import { compareStoreIds } from "@/lib/store-order";

/**
 * 売上の照合 (お客様のご要望 2026-11-23「■2. 売上データの移行と整合性」・「■5」の 12 月の旧システムとの照合)
 * ------------------------------------------------------------
 * 店舗別・月別に、旧システム (売上台帳・販売管理ソフト) から移行した売上と、新システムの売上を並べて確かめる。
 * - 売上台帳: 店舗別の売上台帳から移行した受注 (台帳の行 = 受注 1 件。台帳の月の集計と一致する)
 * - 伝票だけ: 販売管理ソフトの売上明細の伝票で、台帳にひも付かなかった受注 (二重計上の候補を除く)
 * - 二重計上: 同じ売上が台帳の受注と伝票の受注の 2 件になっているもの (src/lib/sales-reconcile.ts。まとめると伝票の受注を消す)
 * - 新システム: システムで登録した受注 (問い合わせ → 見積 → 受注。12/1 から)
 * - システムの売上 (まとめたあと) = 売上台帳 + 伝票だけ + 新システム (= 経営ダッシュボードの売上から二重計上を除いた値)
 * - 旧システムの数字: 照合の相手の数字を画面で入れたもの (settings の id = sales_reference。12 月は旧システムの月次の売上)
 * 売上の月は売上計上日 (施工完了日)。キャンセルを除く。金額は受注の金額 (税込)
 */

export const SALES_REFERENCE_ID = "sales_reference";

export interface SalesReferenceRow {
  month: string;
  storeId: StoreId;
  amount: number;
  note?: string;
}

export function salesReference(db: Pick<Database, "settings">): { rows: SalesReferenceRow[]; label: string } {
  const v = (db.settings ?? []).find((s) => s.id === SALES_REFERENCE_ID)?.value ?? {};
  const rows = Array.isArray(v.rows) ? (v.rows as SalesReferenceRow[]).filter((r) => /^\d{4}-\d{2}$/.test(r.month) && typeof r.amount === "number") : [];
  return { rows, label: typeof v.label === "string" && v.label ? v.label : "旧システム" };
}

export interface SalesCheckCell {
  ledger: number;
  ledgerCount: number;
  slipOnly: number;
  slipOnlyCount: number;
  duplicate: number;
  duplicateCount: number;
  system: number;
  systemCount: number;
  /** いまのシステムの売上 (二重計上を含む = 経営ダッシュボードの売上) */
  current: number;
  /** 二重計上をまとめたあとの売上 */
  after: number;
  /** 旧システムの数字 (入力がなければ null) */
  reference: number | null;
  /** まとめたあと − 旧システムの数字 */
  diff: number | null;
}

export interface SalesCheckRow extends SalesCheckCell {
  month: string;
  byStore: Record<string, SalesCheckCell>;
}

const emptyCell = (): SalesCheckCell => ({ ledger: 0, ledgerCount: 0, slipOnly: 0, slipOnlyCount: 0, duplicate: 0, duplicateCount: 0, system: 0, systemCount: 0, current: 0, after: 0, reference: null, diff: null });

export interface SalesCheck {
  months: SalesCheckRow[];
  totals: SalesCheckCell;
  storeTotals: Record<string, SalesCheckCell>;
  /** 二重計上の候補 (まとめる前) の組の数 */
  pairs: number;
  /** 台帳だけにある (伝票とひも付かない) 受注。二重計上の候補を除く */
  ledgerOnly: Order[];
  referenceLabel: string;
}

function add(c: SalesCheckCell, kind: "ledger" | "slipOnly" | "duplicate" | "system", amount: number) {
  c[kind] += amount;
  c[`${kind}Count` as const]++;
  c.current += amount;
  if (kind !== "duplicate") c.after += amount;
}

/** 期間 (月 from〜to、YYYY-MM) と店舗で照合の表を作る */
export function salesCheck(db: Database, opts: { from: string; to: string; stores: StoreId[] }): SalesCheck {
  const pairs = planReconcile(db);
  const dupIds = new Set(pairs.flatMap((p) => p.slipOrderIds));
  const pairedLedger = new Set(pairs.flatMap((p) => p.ledgerIds));
  const stores = new Set(opts.stores);
  const monthMap = new Map<string, SalesCheckRow>();
  const row = (m: string) => monthMap.get(m) ?? monthMap.set(m, { month: m, ...emptyCell(), byStore: {} }).get(m)!;
  const totals = emptyCell();
  const storeTotals: Record<string, SalesCheckCell> = Object.fromEntries(opts.stores.map((s) => [s, emptyCell()]));
  const ledgerOnly: Order[] = [];
  for (const o of db.orders) {
    if (o.status === "cancelled" || !o.salesDate || !stores.has(o.storeId)) continue;
    const m = o.salesDate.slice(0, 7);
    if (m < opts.from || m > opts.to) continue;
    const kind = o.source !== "import" ? "system" : isSlipOrder(o) ? (dupIds.has(o.id) ? "duplicate" : "slipOnly") : "ledger";
    const r = row(m);
    add(r, kind, o.total);
    add((r.byStore[o.storeId] ??= emptyCell()), kind, o.total);
    add(totals, kind, o.total);
    add((storeTotals[o.storeId] ??= emptyCell()), kind, o.total);
    if (kind === "ledger" && isLedgerOnly(o) && !pairedLedger.has(o.id) && o.total !== 0) ledgerOnly.push(o);
  }
  // 旧システムの数字
  const ref = salesReference(db);
  for (const x of ref.rows) {
    if (x.month < opts.from || x.month > opts.to || !stores.has(x.storeId)) continue;
    const r = row(x.month);
    const c = (r.byStore[x.storeId] ??= emptyCell());
    c.reference = (c.reference ?? 0) + x.amount;
    r.reference = (r.reference ?? 0) + x.amount;
    totals.reference = (totals.reference ?? 0) + x.amount;
    const st = (storeTotals[x.storeId] ??= emptyCell());
    st.reference = (st.reference ?? 0) + x.amount;
  }
  const fillDiff = (c: SalesCheckCell) => (c.diff = c.reference === null ? null : c.after - c.reference);
  const months = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const r of months) {
    fillDiff(r);
    for (const c of Object.values(r.byStore)) fillDiff(c);
  }
  fillDiff(totals);
  for (const c of Object.values(storeTotals)) fillDiff(c);
  ledgerOnly.sort((a, b) => (a.salesDate ?? "").localeCompare(b.salesDate ?? "") || compareStoreIds(a.storeId, b.storeId));
  return { months, totals, storeTotals, pairs: pairs.length, ledgerOnly, referenceLabel: ref.label };
}

/** 旧システムの数字の入力 (1 行 = 月,店舗,金額[,メモ]。店舗は名前・短い名前・ID) を読む。読めない行は理由を返す */
export function parseSalesReference(text: string, stores: { id: StoreId; name: string; shortName?: string }[]): { rows: SalesReferenceRow[]; errors: string[] } {
  const rows: SalesReferenceRow[] = [];
  const errors: string[] = [];
  const findStore = (s: string) => {
    const k = s.replace(/\s/g, "");
    return stores.find((x) => x.id === k || x.name.replace(/\s/g, "") === k || (x.shortName && x.shortName.replace(/\s/g, "") === k) || x.name.replace(/\s/g, "").replace(/店$/, "") === k.replace(/店$/, ""));
  };
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    // タブ区切り (Excel からの貼り付け) はタブで、ほかはカンマで分ける。カンマ区切りの金額の「1,234,567」は 3 桁の続きをつなげる
    const tab = t.includes("\t");
    const cols = (tab ? t.split("\t") : t.split(",")).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && /月/.test(cols[0] ?? "") && !/\d/.test(cols[0] ?? "")) return; // 見出し
    const [mRaw, sRaw, ...tail] = cols;
    let aRaw = tail.shift() ?? "";
    if (!tab) while (tail.length && /^\d{3}$/.test(tail[0]) && /\d$/.test(aRaw)) aRaw += tail.shift();
    const rest = tail;
    const mm = /^(\d{4})[-/年.](\d{1,2})/.exec(mRaw ?? "");
    if (!mm || Number(mm[2]) < 1 || Number(mm[2]) > 12) return void errors.push(`${i + 1} 行目: 月を読めません (${mRaw ?? ""})`);
    const store = findStore(sRaw ?? "");
    if (!store) return void errors.push(`${i + 1} 行目: 店舗を読めません (${sRaw ?? ""})`);
    const amount = Number(String(aRaw ?? "").replace(/[,¥円\s]/g, ""));
    if (!Number.isFinite(amount)) return void errors.push(`${i + 1} 行目: 金額を読めません (${aRaw ?? ""})`);
    rows.push({ month: `${mm[1]}-${mm[2].padStart(2, "0")}`, storeId: store.id, amount: Math.round(amount), ...(rest.join(" ").trim() ? { note: rest.join(" ").trim().slice(0, 200) } : {}) });
  });
  // 同じ月・店舗は最後の行
  const uniq = new Map(rows.map((r) => [`${r.month}:${r.storeId}`, r]));
  return { rows: [...uniq.values()].sort((a, b) => a.month.localeCompare(b.month) || compareStoreIds(a.storeId, b.storeId)), errors };
}

export type SalesCheckCsvKind = "months" | "stores" | "ledger-only";

/** 照合の表の CSV (画面と同じ数字)。months = 月 × 店舗の行、stores = 店舗の合計、ledger-only = 台帳だけの受注の一覧 */
export function salesCheckCsv(c: SalesCheck, kind: SalesCheckCsvKind, db: Pick<Database, "stores" | "customers">, storeIds: StoreId[]): (string | number)[][] {
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const head = ["売上台帳", "売上台帳の件数", "伝票だけ", "伝票だけの件数", "新システム", "新システムの件数", "システムの売上 (二重計上をまとめたあと)", "二重計上 (まとめると消える伝票の受注)", "二重計上の件数", "いまの売上 (経営ダッシュボード)", c.referenceLabel, "差 (まとめたあと − " + c.referenceLabel + ")"];
  const cells = (x: SalesCheckCell) => [x.ledger, x.ledgerCount, x.slipOnly, x.slipOnlyCount, x.system, x.systemCount, x.after, x.duplicate, x.duplicateCount, x.current, x.reference ?? "", x.diff ?? ""];
  if (kind === "stores") return [["店舗", ...head], ...storeIds.map((s) => [storeName(s), ...cells(c.storeTotals[s] ?? emptyCell())]), ["合計", ...cells(c.totals)]];
  if (kind === "ledger-only") {
    const cust = new Map(db.customers.map((x) => [x.id, x.name]));
    return [["売上日", "店舗", "お客様 (現場名)", "金額 (税込)", "受注番号", "売上台帳の場所"], ...c.ledgerOnly.map((o) => [o.salesDate ?? "", storeName(o.storeId), cust.get(o.customerId) ?? "", o.total, o.number, o.sourceRef ?? ""])];
  }
  const rows: (string | number)[][] = [["月", "店舗", ...head]];
  for (const m of c.months) {
    for (const s of storeIds) if (m.byStore[s]) rows.push([m.month, storeName(s), ...cells(m.byStore[s])]);
    rows.push([m.month, "合計", ...cells(m)]);
  }
  return rows;
}

/** 画面と CSV の期間 (?from=YYYY-MM&to=YYYY-MM か ?year=YYYY。既定は今月までの 12 か月) */
export function salesCheckPeriod(sp: { from?: string; to?: string; year?: string }, now = new Date()): { from: string; to: string; label: string } {
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (sp.year && /^\d{4}$/.test(sp.year)) return { from: `${sp.year}-01`, to: `${sp.year}-12`, label: `${sp.year} 年` };
  const okM = (s?: string) => Boolean(s && /^\d{4}-\d{2}$/.test(s));
  if (okM(sp.from) || okM(sp.to)) {
    const from = okM(sp.from) ? sp.from! : "2000-01";
    const to = okM(sp.to) ? sp.to! : ym(now);
    return from <= to ? { from, to, label: `${from.replace("-", "/")} 〜 ${to.replace("-", "/")}` } : { from: to, to: from, label: `${to.replace("-", "/")} 〜 ${from.replace("-", "/")}` };
  }
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  return { from: ym(start), to: ym(now), label: `${ym(start).replace("-", "/")} 〜 ${ym(now).replace("-", "/")} (12 か月)` };
}
