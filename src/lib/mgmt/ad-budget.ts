import type { Database, MgmtEntry, StoreId } from "@/lib/db/types";
import { basisFromExTax } from "./ledger";
import { linesExTax } from "./purchase-lines";
import { defaultExpenseClass } from "./expense-class";
import { monthRange } from "./allocation";
import { closedReason } from "./close";

/**
 * 広告宣伝費の店舗の予算と超過分 (お客様のご説明 2026-11-23 ■2)
 * ------------------------------------------------------------
 * 広告予算は全社で管理し、広告宣伝費は案分経費にする。店舗の判断で予算を超えてチラシを配ったときなどは、その超過分を店舗独自経費にする。
 * - 予算: 手入力の「予算」で指標 = ad (広告宣伝費) を店舗 × 月で登録する。予算を登録していない店舗は判定しない
 * - 店舗の広告宣伝費: 勘定科目が広告・宣伝・販促の経費 (店舗の経費) と、仕入明細の振り分けでその店舗に振り分けた分 (案分経費・店舗独自経費)。
 *   本部で仕入れた全社の広告は店舗の分に入れない (振り分けで店舗を選んだ分だけ)
 * - 超過分 = 店舗の広告宣伝費 − 予算 (0 未満は 0)。そのうち、すでに店舗独自経費にしている分を除いた残りを、
 *   「店舗独自経費 +」と「案分経費 −」の 2 行 (手入力・metric = ad_over:<月>) で移す。全社の経費の合計は変わらない
 * - 何度実行しても、移した額が超過分と同じになるように差額だけを登録する (取消しは逆の行)
 */

export const AD_ACCOUNTS = /広告|宣伝|販促|販売促進/;
export const adOverKey = (month: string) => `ad_over:${month}`;

export interface AdBudgetRow {
  storeId: StoreId;
  /** 予算 (登録がなければ null = 判定しない) */
  budget: number | null;
  /** 店舗の広告宣伝費 (表示の金額。既定は税抜) */
  spend: number;
  /** うち、すでに店舗独自経費にしている分 */
  ownAlready: number;
  /** 超過分 */
  overage: number;
  /** これまでに移した額 */
  moved: number;
  /** これから移す額 (マイナスは戻す) */
  toMove: number;
  sources: { label: string; amount: number; own: boolean }[];
}

export function adBudgetStatus(db: Database, month: string, storeIds?: string[]): AdBudgetRow[] {
  const { from, to } = monthRange(month);
  const inMonth = (d?: string) => Boolean(d) && d! >= from && d! <= to;
  const stores = db.stores.filter((s) => s.kind === "store" && (!storeIds || storeIds.includes(s.id)));
  const rows = new Map<string, AdBudgetRow>(stores.map((s) => [s.id, { storeId: s.id, budget: null, spend: 0, ownAlready: 0, overage: 0, moved: 0, toMove: 0, sources: [] }]));
  // 予算と移した額 (取消しの行も数えて相殺する)
  for (const m of db.mgmtEntries ?? []) {
    if (m.month !== month) continue;
    const r = rows.get(m.storeId);
    if (!r) continue;
    if (m.kind === "budget" && m.metric === "ad") r.budget = (r.budget ?? 0) + m.amount;
    if (m.kind === "store_expense" && m.metric === adOverKey(month)) r.moved += m.amount;
  }
  // 経費 (承認済み・精算済み)
  const classes = new Map((db.expenseClasses ?? []).map((c) => [c.expenseId, c]));
  for (const e of db.expenses ?? []) {
    if ((e.status !== "approved" && e.status !== "paid") || !inMonth(e.date) || !AD_ACCOUNTS.test(e.account ?? "")) continue;
    const r = rows.get(e.storeId);
    if (!r) continue;
    const amount = basisFromExTax(db, e.amount - (e.taxAmount ?? 0), e.date);
    const own = (classes.get(e.id)?.allocClass ?? defaultExpenseClass(e).allocClass) === "store";
    r.spend += amount;
    if (own) r.ownAlready += amount;
    r.sources.push({ label: `経費 ${e.number} ${e.vendor}`, amount, own });
  }
  // 仕入 (振り分けを確定した明細はその店舗、確定していない明細は仕入の登録の店舗)
  const allocs = new Map<string, NonNullable<Database["purchaseLineAllocs"]>>();
  for (const a of db.purchaseLineAllocs ?? []) (allocs.get(a.purchaseId) ?? allocs.set(a.purchaseId, []).get(a.purchaseId)!).push(a);
  for (const p of db.purchases ?? []) {
    if (p.status === "rejected" || !inMonth(p.invoiceDate) || !AD_ACCOUNTS.test(p.account ?? "")) continue;
    const confirmed = (allocs.get(p.id) ?? []).filter((a) => a.status === "confirmed");
    const done = new Set(confirmed.map((a) => a.itemId));
    for (const a of confirmed) {
      for (const s of a.splits) {
        const r = rows.get(s.storeId);
        if (!r || (s.costType !== "common_expense" && s.costType !== "store_expense")) continue;
        const amount = basisFromExTax(db, s.amount, p.invoiceDate);
        const own = s.costType === "store_expense";
        r.spend += amount;
        if (own) r.ownAlready += amount;
        r.sources.push({ label: `仕入 ${p.number} ${a.lineNo} 行目 ${a.ocr.name}`, amount, own });
      }
    }
    const r = rows.get(p.storeId);
    if (!r) continue;
    for (const l of linesExTax(p)) {
      if (done.has(l.itemId)) continue;
      const amount = basisFromExTax(db, l.exTax, p.invoiceDate);
      r.spend += amount;
      r.sources.push({ label: `仕入 ${p.number} (振り分け前)`, amount, own: false });
    }
  }
  for (const r of rows.values()) {
    if (r.budget === null) continue;
    r.overage = Math.max(0, r.spend - r.budget);
    r.toMove = Math.max(0, r.overage - r.ownAlready) - r.moved;
  }
  return [...rows.values()];
}

/** 超過分を店舗独自経費へ移す (mutate の中で呼ぶ)。登録した行の数、または誤りの理由 */
export function moveAdOverage(db: Database, month: string, input: { userId: string; now: string; makeId: () => string }): MgmtEntry[] | string {
  const closed = closedReason(db, `${month}-01`, "広告宣伝費の超過分の振替");
  if (closed) return closed;
  const rows = adBudgetStatus(db, month).filter((r) => r.budget !== null && r.toMove !== 0);
  if (!rows.length) return "移す超過分はありません (予算を登録していない店舗・超過していない店舗は対象外)。";
  const out: MgmtEntry[] = [];
  for (const r of rows) {
    const note = `広告宣伝費の予算超過 ${month} (広告 ${r.spend.toLocaleString("ja-JP")} 円 − 予算 ${(r.budget ?? 0).toLocaleString("ja-JP")} 円${r.ownAlready ? ` − 店舗独自経費済み ${r.ownAlready.toLocaleString("ja-JP")} 円` : ""})`;
    const base = { month, storeId: r.storeId, metric: adOverKey(month), itemCategory: "other", note, status: "active" as const, createdBy: input.userId, createdAt: input.now };
    out.push({ ...base, id: input.makeId(), kind: "store_expense", amount: r.toMove }, { ...base, id: input.makeId(), kind: "common_expense", amount: -r.toMove });
  }
  db.mgmtEntries.push(...out);
  return out;
}
