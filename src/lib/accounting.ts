import type { CashEntry, Database, PurchasePayMethod, StoreId } from "@/lib/db/types";
import { CASH_IN_ACCOUNTS, CASH_OUT_ACCOUNTS, EXPENSE_ACCOUNTS, EXPENSE_METHOD_LABEL, PAYMENT_METHOD_LABEL, PURCHASE_PAY_METHOD_LABEL } from "@/lib/constants";
import { encodeShiftJis } from "@/lib/sjis";
import { awaitsCompletion, invoiceOrderIds, isRecognizedSale, liveInvoicesOfOrder, orderTaxIndex } from "@/lib/billing";
import { purchaseMethodOf } from "@/lib/ar-ap";

/**
 * 会計処理用のデータ (仕訳・明細) の出力
 * ------------------------------------------------------------
 * システムに記録した取引から、期間 (日付) を指定して仕訳を作る。
 *   売上   受注の売上計上日 (= 施工完了日。個人・法人とも)   借方 売掛金 / 貸方 売上高
 *          (2026-11-23 お客様のご指示「■4」: 経営ダッシュボードと同じ日付。請求書の発行日 (まとめ請求の締め日など) とは別)
 *          受注で計上できない請求書 (受注が見つからない・移行データの受注の請求書) だけは、従来どおり請求書の発行日
 *   入金   入金日                借方 現金・普通預金・未収入金 (カード・電子決済) / 貸方 売掛金 (まとめ請求の入金も 1 件ずつ)
 *   決済   決済会社からの入金日  借方 普通預金        / 貸方 未収入金
 *   経費   経費の日付 (承認済み・精算済み)   借方 経費の勘定科目 / 貸方 未払金 (立替・カード)
 *   精算   精算日 (現金・振込の経費)         借方 未払金 / 貸方 現金・普通預金
 *   仕入   請求日 (却下を除く)   借方 仕入の勘定科目  / 貸方 買掛金
 *   支払   支払日                借方 買掛金          / 貸方 普通預金・現金・未払金。
 *          出す支払方法は設定 (accounting_scope。既定は 総合振込と現金): お客様は総合振込以外 (口座振替・都度振込など) を通帳から仕訳している (2026-11-23「■5」)
 *   現金出納 手入力の入出金 (銀行預入・小口現金の補充など)。入金・精算・仕入の支払から自動で記帳した行は上の仕訳と重なるため除く
 * 勘定科目名と税区分は 設定 → 会計データ で会計ソフトの設定に合わせる (settings の id = "accounting")。
 * 部門には店舗名を入れる (設定で止められる)。販売管理ソフトから移行した過去の売上 (source = import の受注。入金済み・請求書なし) は、
 * 移行前の会計で処理済みのため含めない (過去の期間の仕訳は変わらない)
 */

export interface AccountingSettings {
  cash: string;
  bank: string;
  receivable: string;
  cardReceivable: string;
  sales: string;
  payable: string;
  accrued: string;
  purchaseDefault: string;
  suspenseIn: string;
  suspenseOut: string;
  miscIncome: string;
  taxSales: string;
  taxPurchase: string;
  taxNone: string;
  /** 部門に店舗名を入れる */
  storeAsDepartment: boolean;
}

export const ACCOUNTING_SETTINGS_ID = "accounting";

export const DEFAULT_ACCOUNTING: AccountingSettings = {
  cash: "現金",
  bank: "普通預金",
  receivable: "売掛金",
  cardReceivable: "未収入金",
  sales: "売上高",
  payable: "買掛金",
  accrued: "未払金",
  purchaseDefault: "仕入高",
  suspenseIn: "仮受金",
  suspenseOut: "仮払金",
  miscIncome: "雑収入",
  taxSales: "課税売上10%",
  taxPurchase: "課対仕入10%",
  taxNone: "対象外",
  storeAsDepartment: true,
};

export const ACCOUNTING_LABEL: Record<Exclude<keyof AccountingSettings, "storeAsDepartment">, string> = {
  cash: "現金",
  bank: "預金 (振込の入出金)",
  receivable: "売掛金",
  cardReceivable: "カード・電子決済の未入金",
  sales: "売上",
  payable: "買掛金",
  accrued: "未払金 (経費の立替・カード)",
  purchaseDefault: "仕入 (科目の指定がないとき)",
  suspenseIn: "その他の入金の相手科目",
  suspenseOut: "その他の出金の相手科目",
  miscIncome: "雑収入",
  taxSales: "税区分: 売上",
  taxPurchase: "税区分: 経費・仕入",
  taxNone: "税区分: 対象外 (入金・支払・振替)",
};

export function accountingSettings(db: Pick<Database, "settings">): AccountingSettings {
  const v = (db.settings ?? []).find((s) => s.id === ACCOUNTING_SETTINGS_ID)?.value ?? {};
  const out = { ...DEFAULT_ACCOUNTING };
  for (const k of Object.keys(ACCOUNTING_LABEL) as (keyof typeof ACCOUNTING_LABEL)[]) {
    const x = v[k];
    if (typeof x === "string" && x.trim()) out[k] = x.trim().slice(0, 40);
  }
  if (typeof v.storeAsDepartment === "boolean") out.storeAsDepartment = v.storeAsDepartment;
  return out;
}

/* ---------------- 会計データに出す範囲 (仕入の支払) ---------------- */

export const ACCOUNTING_SCOPE_ID = "accounting_scope";

export interface AccountingScope {
  /** 仕入の支払 (買掛金 / 預金・現金) の仕訳を出す支払方法。ほかの方法は通帳から仕訳する (会計データに出さない) */
  paymentMethods: PurchasePayMethod[];
  /** 上の方法以外で払う仕入の計上 (仕入 / 買掛金) を出すか。exclude = 出さない (通帳から 仕入 / 普通預金 で仕訳しているとき) */
  nonBulkPurchases: "include" | "exclude";
}

/**
 * 既定: 総合振込と現金の支払だけを出す。お客様は総合振込以外 (口座振替・都度振込・カードなど) を各銀行口座の通帳から仕訳しているため (2026-11-23)。
 * 現金は通帳に出ないため出す (現金出納帳の自動の行は仕訳に重ねない)。仕入の計上 (仕入 / 買掛金) はすべて出す
 */
export const DEFAULT_ACCOUNTING_SCOPE: AccountingScope = { paymentMethods: ["bulk_transfer", "cash"], nonBulkPurchases: "include" };

export function accountingScope(db: Pick<Database, "settings">): AccountingScope {
  const v = (db.settings ?? []).find((s) => s.id === ACCOUNTING_SCOPE_ID)?.value ?? {};
  const all = Object.keys(PURCHASE_PAY_METHOD_LABEL) as PurchasePayMethod[];
  const methods = Array.isArray(v.paymentMethods) ? (v.paymentMethods as unknown[]).filter((m): m is PurchasePayMethod => typeof m === "string" && (all as string[]).includes(m)) : DEFAULT_ACCOUNTING_SCOPE.paymentMethods;
  return { paymentMethods: methods, nonBulkPurchases: v.nonBulkPurchases === "exclude" ? "exclude" : "include" };
}

/** 会計データに出さない仕入の支払 (通帳から仕訳するもの) の件数・金額 (画面の確認用) */
export function excludedPayments(db: Database, q: JournalQuery): { count: number; amount: number; byMethod: { method: PurchasePayMethod; count: number; amount: number }[] } {
  const scope = accountingScope(db);
  const by = new Map<PurchasePayMethod, { count: number; amount: number }>();
  for (const p of db.purchases) {
    if (p.status !== "paid" || !inRange(p.paidAt, q) || (q.storeId && p.storeId !== q.storeId)) continue;
    const m = p.payMethod ?? "transfer";
    if (scope.paymentMethods.includes(m)) continue;
    const r = by.get(m) ?? { count: 0, amount: 0 };
    r.count += 1;
    r.amount += p.amount;
    by.set(m, r);
  }
  const byMethod = [...by.entries()].map(([method, v]) => ({ method, ...v }));
  return { count: byMethod.reduce((a, r) => a + r.count, 0), amount: byMethod.reduce((a, r) => a + r.amount, 0), byMethod };
}

export type JournalKind = "sales" | "receipt" | "settle" | "expense" | "reimburse" | "purchase" | "payment" | "cash";

export const JOURNAL_KIND_LABEL: Record<JournalKind, string> = {
  sales: "売上",
  receipt: "入金",
  settle: "決済会社からの入金",
  expense: "経費",
  reimburse: "経費の精算",
  purchase: "仕入",
  payment: "仕入の支払",
  cash: "現金出納",
};

export interface JournalSide {
  account: string;
  sub?: string;
  dept?: string;
  tax: string;
  amount: number;
  taxAmount?: number;
}

export interface JournalRow {
  date: string;
  kind: JournalKind;
  /** 元の記録の番号 (請求番号・経費番号など) */
  ref: string;
  debit: JournalSide;
  credit: JournalSide;
  memo: string;
  partner?: string;
}

export interface JournalQuery {
  from: string;
  to: string;
  storeId?: StoreId;
  kinds?: JournalKind[];
}

const inRange = (d: string | undefined, q: JournalQuery) => Boolean(d && d >= q.from && d <= q.to);

/** 期間の仕訳 (日付順) */
export function buildJournal(db: Database, q: JournalQuery): JournalRow[] {
  const s = accountingSettings(db);
  const want = (k: JournalKind) => !q.kinds?.length || q.kinds.includes(k);
  const storeOk = (id: StoreId) => !q.storeId || q.storeId === id;
  const dept = (id: StoreId) => (s.storeAsDepartment ? (db.stores.find((x) => x.id === id)?.name ?? id) : undefined);
  const customer = (id?: string) => db.customers.find((c) => c.id === id)?.name ?? "";
  const supplier = (id?: string) => db.suppliers.find((x) => x.id === id)?.name ?? "";
  const rows: JournalRow[] = [];
  const side = (account: string, tax: string, amount: number, storeId: StoreId, taxAmount?: number, sub?: string): JournalSide => ({ account, sub, dept: dept(storeId), tax, amount: Math.round(amount), taxAmount: taxAmount === undefined ? undefined : Math.round(taxAmount) });

  // 売上: 受注の売上計上日 (= 施工完了日)。請求書の発行日とは別 (まとめ請求の締め日に発行しても、売上は案件ごとの完了日)
  const recognized = new Set(db.orders.filter(isRecognizedSale).map((o) => o.id));
  const orderMap = new Map(db.orders.map((o) => [o.id, o]));
  const orderOf = (id: string) => orderMap.get(id);
  if (want("sales")) {
    const taxOf = orderTaxIndex(db);
    for (const o of db.orders) {
      if (!recognized.has(o.id) || !storeOk(o.storeId) || !inRange(o.salesDate, q)) continue;
      const name = customer(o.customerId);
      const inv = liveInvoicesOfOrder(db.invoices, o)[0];
      rows.push({ date: o.salesDate!, kind: "sales", ref: o.number, partner: name, memo: `${o.number} ${name} 様 ${o.title}${inv ? ` (請求 ${inv.number})` : ""}`.trim(), debit: side(s.receivable, s.taxNone, o.total, o.storeId), credit: side(s.sales, s.taxSales, o.total, o.storeId, taxOf(o)) });
    }
    // 受注で計上できない請求書 (受注が見つからない・移行データの受注の請求書): 従来どおり請求書の発行日
    for (const i of db.invoices) {
      if (i.status === "void" || !storeOk(i.storeId) || !inRange(i.issueDate, q) || !(i.total > 0) || invoiceOrderIds(i).some((id) => recognized.has(id)) || awaitsCompletion(i, orderOf)) continue;
      const name = customer(i.customerId);
      rows.push({ date: i.issueDate, kind: "sales", ref: i.number, partner: name, memo: `${i.number} ${name} 様 ${i.title ?? ""}`.trim(), debit: side(s.receivable, s.taxNone, i.total, i.storeId), credit: side(s.sales, s.taxSales, i.total, i.storeId, i.tax) });
    }
  }
  const invById = new Map(db.invoices.map((i) => [i.id, i]));
  for (const p of db.payments) {
    const inv = invById.get(p.invoiceId);
    if (!inv || !storeOk(inv.storeId)) continue;
    const name = customer(inv.customerId);
    const card = p.method === "card" || p.method === "paypay";
    if (want("receipt") && inRange(p.date, q)) {
      const dr = p.method === "cash" ? s.cash : card ? s.cardReceivable : p.method === "transfer" ? s.bank : s.suspenseIn;
      rows.push({ date: p.date, kind: "receipt", ref: inv.number, partner: name, memo: `${inv.number} ${name} 様 入金 (${PAYMENT_METHOD_LABEL[p.method]})${p.memo ? ` ${p.memo}` : ""}`, debit: side(dr, s.taxNone, p.amount, inv.storeId), credit: side(s.receivable, s.taxNone, p.amount, inv.storeId) });
    }
    if (want("settle") && card && inRange(p.settledOn, q)) {
      rows.push({ date: p.settledOn!, kind: "settle", ref: inv.number, partner: name, memo: `${inv.number} ${PAYMENT_METHOD_LABEL[p.method]} の入金 (決済会社から)`, debit: side(s.bank, s.taxNone, p.amount, inv.storeId), credit: side(s.cardReceivable, s.taxNone, p.amount, inv.storeId) });
    }
  }
  for (const e of db.expenses) {
    if (!storeOk(e.storeId) || !(e.status === "approved" || e.status === "paid")) continue;
    if (want("expense") && inRange(e.date, q)) {
      rows.push({ date: e.date, kind: "expense", ref: e.number, partner: e.vendor, memo: `${e.number} ${e.vendor} ${e.description}`.trim(), debit: side(e.account, s.taxPurchase, e.amount, e.storeId, e.taxAmount), credit: side(s.accrued, s.taxNone, e.amount, e.storeId) });
    }
    if (want("reimburse") && e.status === "paid" && e.paymentMethod !== "card") {
      const date = e.paidAt ?? e.updatedAt.slice(0, 10);
      if (inRange(date, q)) rows.push({ date, kind: "reimburse", ref: e.number, partner: e.vendor, memo: `${e.number} 経費の精算 (${EXPENSE_METHOD_LABEL[e.paymentMethod]})`, debit: side(s.accrued, s.taxNone, e.amount, e.storeId), credit: side(e.paymentMethod === "cash" ? s.cash : s.bank, s.taxNone, e.amount, e.storeId) });
    }
  }
  const scope = accountingScope(db);
  const supplierById = new Map(db.suppliers.map((x) => [x.id, x]));
  for (const p of db.purchases) {
    if (!storeOk(p.storeId) || p.status === "rejected") continue;
    const name = supplier(p.supplierId);
    // 支払の仕訳を出さない方法 (通帳から仕訳) で払う仕入の計上も出さない設定のとき。支払方法が分からない仕入は出す
    const method = purchaseMethodOf(p, supplierById.get(p.supplierId));
    const skipPurchase = scope.nonBulkPurchases === "exclude" && method !== undefined && !scope.paymentMethods.includes(method);
    if (want("purchase") && inRange(p.invoiceDate, q) && !skipPurchase) {
      rows.push({ date: p.invoiceDate, kind: "purchase", ref: p.number, partner: name, memo: `${p.number} ${name} ${p.description}`.trim(), debit: side(p.account || s.purchaseDefault, s.taxPurchase, p.amount, p.storeId, p.taxAmount), credit: side(s.payable, s.taxNone, p.amount, p.storeId) });
    }
    if (want("payment") && p.status === "paid" && inRange(p.paidAt, q) && scope.paymentMethods.includes(p.payMethod ?? "transfer")) {
      const method = p.payMethod ?? "transfer";
      const cr = method === "cash" ? s.cash : method === "card" ? s.accrued : method === "other" ? s.suspenseOut : s.bank;
      rows.push({ date: p.paidAt!, kind: "payment", ref: p.number, partner: name, memo: `${p.number} ${name} 支払 (${PURCHASE_PAY_METHOD_LABEL[method]})${p.payReference ? ` ${p.payReference}` : ""}`, debit: side(s.payable, s.taxNone, p.amount, p.storeId), credit: side(cr, s.taxNone, p.amount, p.storeId) });
    }
  }
  if (want("cash")) {
    for (const c of db.cashEntries) {
      if (c.source !== "manual" || !storeOk(c.storeId) || !inRange(c.date, q)) continue;
      const [dr, cr, tax] = cashAccounts(c, s);
      rows.push({ date: c.date, kind: "cash", ref: c.number, partner: c.counterparty, memo: `${c.number} ${c.account}${c.description ? ` ${c.description}` : ""}`, debit: side(dr, c.direction === "out" ? tax : s.taxNone, c.amount, c.storeId), credit: side(cr, c.direction === "in" ? tax : s.taxNone, c.amount, c.storeId) });
    }
  }
  const order: Record<JournalKind, number> = { sales: 0, receipt: 1, settle: 2, expense: 3, reimburse: 4, purchase: 5, payment: 6, cash: 7 };
  return rows.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ref.localeCompare(b.ref));
}

/** 手入力の現金出納の [借方, 貸方, 税区分] */
function cashAccounts(c: CashEntry, s: AccountingSettings): [string, string, string] {
  const ins = CASH_IN_ACCOUNTS as readonly string[];
  const outs = CASH_OUT_ACCOUNTS as readonly string[];
  if (c.direction === "in") {
    if (c.account === ins[0]) return [s.cash, s.receivable, s.taxNone]; // 売掛金回収
    if (c.account === ins[1] || c.account === ins[2]) return [s.cash, s.bank, s.taxNone]; // 小口現金補充・銀行引出
    if (c.account === ins[3]) return [s.cash, s.miscIncome, s.taxSales]; // 雑収入
    return [s.cash, s.suspenseIn, s.taxNone];
  }
  if (c.account === outs[0] || c.account === outs[1]) return [s.bank, s.cash, s.taxNone]; // 銀行預入・小口現金返却
  if (c.account === outs[2]) return [s.purchaseDefault, s.cash, s.taxPurchase]; // 仕入 (現金払い)
  if ((EXPENSE_ACCOUNTS as readonly string[]).includes(c.account)) return [c.account, s.cash, s.taxPurchase];
  return [s.suspenseOut, s.cash, s.taxNone];
}

/* ---------------- 出力の形式 ---------------- */

export const GENERIC_HEADER = ["日付", "伝票番号", "区分", "借方勘定科目", "借方補助科目", "借方部門", "借方税区分", "借方金額", "借方税額", "貸方勘定科目", "貸方補助科目", "貸方部門", "貸方税区分", "貸方金額", "貸方税額", "摘要", "取引先", "元の番号"];

/** 汎用の仕訳 (1 行 1 仕訳。伝票番号は日付順の連番) */
export function genericRows(rows: JournalRow[]): (string | number)[][] {
  return [
    GENERIC_HEADER,
    ...rows.map((r, i) => [r.date, i + 1, JOURNAL_KIND_LABEL[r.kind], r.debit.account, r.debit.sub ?? "", r.debit.dept ?? "", r.debit.tax, r.debit.amount, r.debit.taxAmount ?? "", r.credit.account, r.credit.sub ?? "", r.credit.dept ?? "", r.credit.tax, r.credit.amount, r.credit.taxAmount ?? "", r.memo, r.partner ?? "", r.ref]),
  ];
}

/**
 * 弥生会計の仕訳日記帳のインポート形式 (25 項目・見出しなし・Shift_JIS)
 * 識別フラグ 2000 (1 行の仕訳)・伝票No・決算・取引日付・借方 (科目・補助・部門・税区分・金額・税金額)・貸方 (同)・摘要・番号・期日・タイプ 0・生成元・仕訳メモ・付箋1・付箋2・調整
 */
export function yayoiRows(rows: JournalRow[]): (string | number)[][] {
  const d = (s: string) => s.replace(/-/g, "/");
  const clip = (s: string, n: number) => [...s].slice(0, n).join("");
  return rows.map((r, i) => [
    2000,
    i + 1,
    "",
    d(r.date),
    r.debit.account,
    r.debit.sub ?? "",
    r.debit.dept ?? "",
    r.debit.tax,
    r.debit.amount,
    r.debit.taxAmount ?? "",
    r.credit.account,
    r.credit.sub ?? "",
    r.credit.dept ?? "",
    r.credit.tax,
    r.credit.amount,
    r.credit.taxAmount ?? "",
    clip(r.memo, 64),
    "",
    "",
    0,
    "",
    "",
    0,
    0,
    "no",
  ]);
}

/** 会計ソフト向けの CSV (数式の対策の ' を付けない。Shift_JIS または BOM 付き UTF-8) */
export function plainCsv(rows: (string | number)[][], encoding: "sjis" | "utf8"): Uint8Array {
  const cell = (v: string | number) => {
    if (typeof v === "number") return String(v);
    return /[",\r\n]/.test(v) || v === "" ? `"${v.replace(/"/g, '""')}"` : `"${v}"`;
  };
  const text = rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  if (encoding === "sjis") return encodeShiftJis(text);
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** 借方・貸方の合計 (画面の確認用。必ず一致する) */
export function journalTotals(rows: JournalRow[]): { count: number; debit: number; credit: number; byKind: { kind: JournalKind; count: number; amount: number }[] } {
  const byKind = new Map<JournalKind, { count: number; amount: number }>();
  for (const r of rows) {
    const k = byKind.get(r.kind) ?? { count: 0, amount: 0 };
    k.count += 1;
    k.amount += r.debit.amount;
    byKind.set(r.kind, k);
  }
  return {
    count: rows.length,
    debit: rows.reduce((a, r) => a + r.debit.amount, 0),
    credit: rows.reduce((a, r) => a + r.credit.amount, 0),
    byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })),
  };
}
