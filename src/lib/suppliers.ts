import type { PurchaseInvoice, Supplier } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";

/**
 * 仕入先・協力業者の支払条件と、仕入請求書の支払期限・支払予定日
 * ------------------------------------------------------------
 * 締め日 (closingDay)・支払月 (payMonthOffset)・支払日 (payDay) は 31 = 末日。
 * 未設定の取引先は支払条件の文章 (例: 「月末締め 翌月末払い」「20日締め 翌月15日払い」「都度払い」) から読み取る。
 * 読み取れないときは請求日の 30 日後を支払期限にする
 */

export interface PayTerms {
  closingDay: number;
  /** 0 = 当月 / 1 = 翌月 / 2 = 翌々月。null = 都度払い (請求日の当日) */
  payMonthOffset: number | null;
  payDay: number;
}

const clampDay = (d: number) => Math.min(31, Math.max(1, Math.round(d)));

/** 支払条件の文章を読む (読めないときは undefined) */
export function parsePaymentTerms(text: string | undefined): Partial<PayTerms> | undefined {
  const t = (text ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (!t) return undefined;
  if (/都度|即時|現金払/.test(t)) return { payMonthOffset: null };
  const out: Partial<PayTerms> = {};
  const close = t.match(/(末|(\d{1,2})日)締/);
  if (close) out.closingDay = close[1] === "末" ? 31 : clampDay(Number(close[2]));
  const pay = t.match(/(当月|翌月|翌々月|翌翌月|(\d)ヶ?か?月後)(末|(\d{1,2})日)(払|支払)/);
  if (pay) {
    out.payMonthOffset = pay[1] === "当月" ? 0 : pay[1] === "翌月" ? 1 : pay[1] === "翌々月" || pay[1] === "翌翌月" ? 2 : Number(pay[2]);
    out.payDay = pay[3] === "末" ? 31 : clampDay(Number(pay[4]));
  }
  return Object.keys(out).length ? out : undefined;
}

/** 取引先の支払条件 (項目の設定 → 文章の順。どちらもなければ undefined) */
export function supplierTerms(s: Pick<Supplier, "closingDay" | "payMonthOffset" | "payDay" | "paymentTerms"> | undefined): PayTerms | undefined {
  if (!s) return undefined;
  const parsed = parsePaymentTerms(s.paymentTerms);
  if (parsed?.payMonthOffset === null && s.payMonthOffset == null) return { closingDay: 31, payMonthOffset: null, payDay: 31 };
  const offset = s.payMonthOffset ?? parsed?.payMonthOffset;
  const day = s.payDay ?? parsed?.payDay;
  if (offset == null || day == null) return undefined;
  return { closingDay: clampDay(s.closingDay ?? parsed?.closingDay ?? 31), payMonthOffset: offset, payDay: clampDay(day) };
}

function lastDayOf(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function ymd(year: number, month0: number, day: number): string {
  const d = new Date(Date.UTC(year, month0, Math.min(day, lastDayOf(year, month0))));
  return d.toISOString().slice(0, 10);
}

/**
 * 請求日から支払期限を計算する。
 * 例: 月末締め翌月末払い / 請求日 2026-11-15 → 2026-12-31。20日締め翌月15日払い / 請求日 2026-11-25 → 締めは 12/20 → 2027-01-15
 */
export function dueDateFor(invoiceDate: string, terms: PayTerms | undefined): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return addDays(toDateKey(new Date()), 30);
  if (!terms) return addDays(invoiceDate, 30);
  if (terms.payMonthOffset === null) return invoiceDate;
  const [y, m, d] = invoiceDate.split("-").map(Number);
  let year = y;
  let month0 = m - 1;
  // 締め日を過ぎた請求は翌月の締めに入る
  const close = Math.min(terms.closingDay, lastDayOf(year, month0));
  if (d > close) {
    month0 += 1;
    if (month0 > 11) {
      month0 = 0;
      year += 1;
    }
  }
  month0 += terms.payMonthOffset;
  year += Math.floor(month0 / 12);
  month0 %= 12;
  return ymd(year, month0, terms.payDay);
}

/** 支払条件の表示 (例: 月末締め 翌月末払い) */
export function termsLabel(s: Supplier | undefined): string {
  const t = supplierTerms(s);
  if (!t) return s?.paymentTerms || "未設定";
  if (t.payMonthOffset === null) return "都度払い";
  const close = t.closingDay >= 31 ? "月末" : `${t.closingDay}日`;
  const month = ["当月", "翌月", "翌々月"][t.payMonthOffset] ?? `${t.payMonthOffset}か月後`;
  const pay = t.payDay >= 31 ? "末" : `${t.payDay}日`;
  return `${close}締め ${month}${pay}払い`;
}

/** 未払の仕入請求書 (支払完了・却下以外) */
export function isOpenPurchase(p: PurchaseInvoice): boolean {
  return p.status !== "paid" && p.status !== "rejected";
}

/** 支払予定日 (未設定は支払期限) */
export function payDateOf(p: PurchaseInvoice): string {
  return p.scheduledPayDate || p.dueDate;
}

export function supplierKindOf(s: Pick<Supplier, "kind"> | undefined): "supplier" | "partner" {
  return s?.kind === "partner" ? "partner" : "supplier";
}

export function isActiveSupplier(s: Supplier): boolean {
  return s.active !== false;
}
