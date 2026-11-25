import type { Customer, Database, Invoice, Order, PaymentMethod, Receipt, ReceiptMethod, ReceiptPart } from "@/lib/db/types";

/**
 * 領収書の発行台帳 (お客様のご要望 2026-11-25「⑦ 一括印刷」「⑧ 領収書の支払内訳」)
 * ------------------------------------------------------------
 * - 1 枚の請求書に対して領収書を発行する (支払方法ごとの内訳: 現金・商品券・カード・電子決済・振込・その他)。内訳の合計 = 領収金額
 * - 有効な領収書の合計は請求書の金額まで (超える発行 = 二重発行は断る)。取り消しは理由つき。作り直しは取り消してから
 * - 入金の記録 (payments) と比べて、入金が未記録・支払方法の違い・入金のうち領収書が未発行を知らせる (receiptChecks)
 * - 案件ごとに「発行する・しない」(Order.receiptWanted)。未設定は入金の予定方法から自動: 現金・訪問集金 = 発行する、
 *   カード・電子決済 = ご希望があれば (既定は発行しない)、振込・業者取引 = 発行しない (receiptWanted)
 * import は型だけ (画面・サーバー・テストで共通)
 */

export const RECEIPT_METHOD_LABEL: Record<ReceiptMethod, string> = { cash: "現金", voucher: "商品券", card: "カード", epay: "電子決済", transfer: "振込", other: "その他" };
export const RECEIPT_METHODS = Object.keys(RECEIPT_METHOD_LABEL) as ReceiptMethod[];
export const isReceiptMethod = (v: unknown): v is ReceiptMethod => typeof v === "string" && v in RECEIPT_METHOD_LABEL;

/** 入金の記録の支払方法 → 領収書の支払方法 */
export const PAYMENT_TO_RECEIPT: Record<PaymentMethod, ReceiptMethod> = { cash: "cash", transfer: "transfer", card: "card", paypay: "epay", other: "other" };
/** 領収書の支払方法 → 入金の記録の支払方法 (商品券は「その他」) */
export const RECEIPT_TO_PAYMENT: Record<ReceiptMethod, PaymentMethod> = { cash: "cash", voucher: "other", card: "card", epay: "paypay", transfer: "transfer", other: "other" };

/** 受注の入金の予定方法 (Order.plannedPayment) → 領収書の支払方法 */
const PLANNED_TO_RECEIPT: Record<string, ReceiptMethod> = { cash: "cash", visit: "cash", card: "card", epay: "epay", transfer: "transfer", trade: "transfer" };

export const partLabel = (p: Pick<ReceiptPart, "method" | "note">): string => (p.method === "other" && p.note?.trim() ? p.note.trim() : RECEIPT_METHOD_LABEL[p.method]);

/** 有効な (取り消していない) 領収書 */
export function activeReceipts(db: Pick<Database, "receipts">, invoiceId: string): Receipt[] {
  return (db.receipts ?? []).filter((r) => r.invoiceId === invoiceId && r.status === "issued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const receiptedTotal = (db: Pick<Database, "receipts">, invoiceId: string): number => activeReceipts(db, invoiceId).reduce((a, r) => a + r.amount, 0);

export interface ReceiptWanted {
  wanted: boolean;
  /** 受注で決めていない (入金の予定方法から自動) */
  auto: boolean;
  reason: string;
}

/** 領収書を発行するか (案件ごとに決めた値 → 入金の予定方法)。お客様のご説明: 基本は現金払いのお客様、カード・電子決済はご希望があれば */
export function receiptWanted(o: Pick<Order, "receiptWanted" | "plannedPayment"> | undefined): ReceiptWanted {
  if (o?.receiptWanted !== undefined) return { wanted: o.receiptWanted, auto: false, reason: o.receiptWanted ? "この案件は発行する" : "この案件は発行しない" };
  const p = o?.plannedPayment;
  if (p === "cash" || p === "visit") return { wanted: true, auto: true, reason: "現金払いの予定のため発行" };
  if (p === "card" || p === "epay") return { wanted: false, auto: true, reason: "カード・電子決済の予定 (ご希望があれば発行)" };
  if (p === "transfer" || p === "trade") return { wanted: false, auto: true, reason: "振込・業者取引の予定" };
  return { wanted: false, auto: true, reason: "入金の予定方法が未登録" };
}

/** 消費税 (全額なら請求書の税額、一部なら 10% の内税。非課税は 0)。今までの領収書と同じ計算 */
export function receiptTax(inv: Pick<Invoice, "total" | "tax" | "taxExempt">, amount: number): number {
  if (inv.taxExempt) return 0;
  return amount === inv.total ? inv.tax : Math.floor((amount * 10) / 110);
}

export interface ReceiptDraft {
  amount: number;
  parts: ReceiptPart[];
  /** 入金の記録より先の発行 (納品の前に印刷するなど) */
  beforePayment: boolean;
  /** あと何円まで発行できるか (請求書の金額 − 有効な領収書) */
  remaining: number;
}

/**
 * 新しい領収書の初期値: 入金の記録があり、まだ領収書を出していない分 → その分を入金の支払方法で。
 * 入金の記録がなければ、まだ発行していない残りを入金の予定方法 (なければ現金) で
 */
export function receiptDraft(db: Pick<Database, "receipts" | "payments">, inv: Pick<Invoice, "id" | "total" | "paidAmount">, order?: Pick<Order, "plannedPayment">): ReceiptDraft {
  const done = activeReceipts(db, inv.id);
  const receipted = done.reduce((a, r) => a + r.amount, 0);
  const remaining = Math.max(0, inv.total - receipted);
  const paidLeft = Math.max(0, Math.min(remaining, inv.paidAmount - receipted));
  if (paidLeft > 0) {
    // 支払方法ごとの入金 − 支払方法ごとの発行済み
    const left = new Map<ReceiptMethod, number>();
    for (const p of db.payments.filter((x) => x.invoiceId === inv.id)) left.set(PAYMENT_TO_RECEIPT[p.method], (left.get(PAYMENT_TO_RECEIPT[p.method]) ?? 0) + p.amount);
    for (const r of done) for (const part of r.parts) left.set(part.method, (left.get(part.method) ?? 0) - part.amount);
    const parts = [...left].filter(([, v]) => v > 0).map(([method, amount]) => ({ method, amount }));
    const sum = parts.reduce((a, p) => a + p.amount, 0);
    return { amount: paidLeft, parts: sum === paidLeft ? parts : [{ method: parts[0]?.method ?? "cash", amount: paidLeft }], beforePayment: false, remaining };
  }
  const method = PLANNED_TO_RECEIPT[order?.plannedPayment ?? ""] ?? "cash";
  return { amount: remaining, parts: remaining > 0 ? [{ method, amount: remaining }] : [], beforePayment: true, remaining };
}

/** 画面・フォームから来た内訳を整える (金額 0 の行は外す。その他のメモは 40 文字まで) */
export function cleanParts(raw: unknown): ReceiptPart[] {
  if (!Array.isArray(raw)) return [];
  const out: ReceiptPart[] = [];
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || !isReceiptMethod(x.method)) continue;
    const amount = typeof x.amount === "number" ? x.amount : Number(String(x.amount ?? "").normalize("NFKC").replace(/[,，円¥\s]/g, ""));
    if (!Number.isFinite(amount) || amount === 0) continue;
    const note = typeof x.note === "string" ? x.note.trim().slice(0, 40) : "";
    out.push({ method: x.method, amount: Math.round(amount), ...(note ? { note } : {}) });
  }
  return out;
}

/** 領収書の内容の確かめ (合計の一致・二重発行)。問題がなければ undefined */
export function receiptError(input: { amount: number; parts: ReceiptPart[] }, inv: Pick<Invoice, "id" | "total" | "status">, db: Pick<Database, "receipts">, opts: { replacing?: string } = {}): string | undefined {
  if (inv.status === "void") return "無効にした請求書の領収書は発行できません。";
  if (!Number.isInteger(input.amount) || input.amount <= 0) return "領収金額を 1 円以上で入力してください。";
  if (!input.parts.length) return "支払方法ごとの金額 (内訳) を入力してください。";
  if (input.parts.some((p) => p.amount < 0)) return "内訳の金額にマイナスは入れられません。";
  if (input.parts.some((p) => p.method === "other" && !p.note?.trim())) return "「その他」の支払方法は名前 (例: 地域振興券) を入れてください。";
  const sum = input.parts.reduce((a, p) => a + p.amount, 0);
  if (sum !== input.amount) return `内訳の合計 (¥${sum.toLocaleString("ja-JP")}) が領収金額 (¥${input.amount.toLocaleString("ja-JP")}) と合いません。`;
  const others = activeReceipts(db, inv.id).filter((r) => r.id !== opts.replacing);
  const issued = others.reduce((a, r) => a + r.amount, 0);
  if (issued + input.amount > inv.total) {
    return `この請求書 (¥${inv.total.toLocaleString("ja-JP")}) にはすでに領収書 ¥${issued.toLocaleString("ja-JP")} (${others.map((r) => r.number).join("・")}) を発行しています。二重発行にならないよう、残り ¥${Math.max(0, inv.total - issued).toLocaleString("ja-JP")} までにしてください (作り直すときは前の領収書を取り消してから)。`;
  }
  return undefined;
}

export interface ReceiptCheck {
  tone: "warn" | "info";
  text: string;
}

/** 入金の記録と領収書の突き合わせ (請求書の画面・まとめて印刷・予定表の小さな画面に出す) */
export function receiptChecks(db: Pick<Database, "receipts" | "payments">, inv: Pick<Invoice, "id" | "total" | "paidAmount" | "status">, order?: Pick<Order, "receiptWanted" | "plannedPayment">): ReceiptCheck[] {
  if (inv.status === "void") return [];
  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
  const done = activeReceipts(db, inv.id);
  const receipted = done.reduce((a, r) => a + r.amount, 0);
  const out: ReceiptCheck[] = [];
  if (receipted > inv.paidAmount) out.push({ tone: "warn", text: `領収書 ${yen(receipted)} を発行済みですが、入金の記録は ${yen(inv.paidAmount)} です (未記録 ${yen(receipted - inv.paidAmount)})。お預かりしたら入金を記録してください。` });
  if (receipted > 0 && inv.paidAmount >= receipted) {
    const byMethod = (pairs: [ReceiptMethod, number][]) => {
      const m = new Map<PaymentMethod, number>();
      for (const [k, v] of pairs) m.set(RECEIPT_TO_PAYMENT[k], (m.get(RECEIPT_TO_PAYMENT[k]) ?? 0) + v);
      return m;
    };
    const rec = byMethod(done.flatMap((r) => r.parts.map((p) => [p.method, p.amount] as [ReceiptMethod, number])));
    const pay = byMethod(db.payments.filter((p) => p.invoiceId === inv.id).map((p) => [PAYMENT_TO_RECEIPT[p.method], p.amount] as [ReceiptMethod, number]));
    const diff = [...rec].filter(([k, v]) => (pay.get(k) ?? 0) < v);
    if (diff.length) {
      const label = (k: PaymentMethod) => RECEIPT_METHOD_LABEL[PAYMENT_TO_RECEIPT[k]];
      out.push({ tone: "warn", text: `領収書の支払方法と入金の記録が合いません (領収書: ${[...rec].map(([k, v]) => `${label(k)} ${yen(v)}`).join("・")} / 入金: ${[...pay].map(([k, v]) => `${label(k)} ${yen(v)}`).join("・") || "なし"})。` });
    }
  }
  if (inv.paidAmount > receipted && receiptWanted(order).wanted) out.push({ tone: "info", text: `入金 ${yen(inv.paidAmount)} のうち ${yen(inv.paidAmount - receipted)} は領収書が未発行です。` });
  return out;
}

/** 宛名・但し書き (受注の領収書の宛名 → お客様名。まとめ請求はお客様名) */
export function receiptHeading(customer: Pick<Customer, "name" | "type"> | undefined, inv: Pick<Invoice, "title" | "orderLines" | "periodTo">, order?: Pick<Order, "receiptName" | "title">): { addressee: string; honorific: "様" | "御中"; purpose: string } {
  const honorific = customer?.type === "corporate" ? "御中" : "様";
  const raw = inv.orderLines?.length ? "" : (order?.receiptName ?? "").trim();
  let addressee = customer?.name ?? "お客様";
  let h: "様" | "御中" = honorific;
  if (raw) {
    const m = raw.match(/^(.*?)[\s　]*(御中|様)$/);
    if (m && m[1].trim()) {
      addressee = m[1].trim();
      h = m[2] as "様" | "御中";
    } else {
      addressee = raw;
      h = /(株式会社|有限会社|合同会社|合資会社|一般社団|社団法人|財団法人|医療法人|社会福祉法人|学校法人|NPO|組合|\(株\)|（株）|\(有\)|（有）)/.test(raw) ? "御中" : "様";
    }
  }
  const purpose = inv.orderLines?.length
    ? `工事代 (${inv.periodTo ? `${inv.periodTo.slice(5, 7).replace(/^0/, "")}月${inv.periodTo.slice(8, 10).replace(/^0/, "")}日締め · ` : ""}${inv.orderLines.length} 件) として`
    : `${(inv.title ?? order?.title ?? "工事").replace(/代$/, "")}代として`;
  return { addressee, honorific: h, purpose };
}
