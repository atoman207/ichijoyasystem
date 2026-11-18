import type { Database, FaxNumber } from "@/lib/db/types";

/**
 * FAX 番号の正規化と、送信元の判別
 * ------------------------------------------------------------
 * 番号は数字だけで持つ (例: 0963483177)。+81 / 81 から始まる国際表記は 0 から始まる国内の番号に直す。
 * 送信元の判別の順番: 不要な番号の台帳 → 仕入先の FAX (台帳の FAX 番号・FAX 番号の台帳) → 顧客 (FAX 番号の台帳・電話番号)
 */

/** 数字だけにする (全角・ハイフン・括弧・空白を除く。+81 → 0) */
export function normFax(v: string | undefined | null): string {
  let d = String(v ?? "")
    .normalize("NFKC")
    .replace(/[^\d+]/g, "");
  if (d.startsWith("+81")) d = `0${d.slice(3)}`;
  else if (d.startsWith("81") && d.length >= 11 && !d.startsWith("810")) d = `0${d.slice(2)}`;
  return d.replace(/\D/g, "");
}

/** 国内の FAX 番号として送れる形 (0 から始まる 10〜11 桁) */
export function isValidFax(digits: string): boolean {
  return /^0\d{9,10}$/.test(digits);
}

/** 表示用 (例: 096-348-3177・03-1234-5678・050-1234-5678・0120-123-456) */
export function fmtFax(v: string | undefined | null): string {
  const d = normFax(v);
  if (!d) return "";
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) {
    if (/^0120|^0800/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
    if (/^0[36]/.test(d)) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return d;
}

export type SenderMatch =
  | { kind: "blocked"; entry: FaxNumber; label: string }
  | { kind: "supplier"; supplierId: string; label: string }
  | { kind: "customer"; customerId: string; label: string }
  /** 同じ番号の顧客が複数いる (自動ではひも付けない) */
  | { kind: "ambiguous"; customerIds: string[]; label: string }
  | { kind: "none" };

/** 送信元の番号から、不要な番号・仕入先・顧客を判別する */
export function matchSender(db: Database, raw: string): SenderMatch {
  const n = normFax(raw);
  if (!n) return { kind: "none" };
  const entry = db.faxNumbers.find((x) => x.number === n);
  if (entry?.kind === "blocked") return { kind: "blocked", entry, label: entry.label || "不要な番号" };
  if (entry?.kind === "supplier" && entry.supplierId && db.suppliers.some((s) => s.id === entry.supplierId)) {
    return { kind: "supplier", supplierId: entry.supplierId, label: db.suppliers.find((s) => s.id === entry.supplierId)!.name };
  }
  const suppliers = db.suppliers.filter((s) => normFax(s.fax) === n).sort((a, b) => Number(b.active !== false) - Number(a.active !== false));
  if (suppliers.length) return { kind: "supplier", supplierId: suppliers[0].id, label: suppliers[0].name };
  if (entry?.kind === "customer" && entry.customerId && db.customers.some((c) => c.id === entry.customerId)) {
    return { kind: "customer", customerId: entry.customerId, label: db.customers.find((c) => c.id === entry.customerId)!.name };
  }
  // 顧客の電話番号 (FAX 兼用の家庭が多い)。携帯電話の番号は FAX にならないので見ない
  if (/^0[5789]0/.test(n)) return { kind: "none" };
  const customers = db.customers.filter((c) => normFax(c.phone) === n);
  if (customers.length === 1) return { kind: "customer", customerId: customers[0].id, label: customers[0].name };
  if (customers.length > 1) return { kind: "ambiguous", customerIds: customers.map((c) => c.id), label: `同じ電話番号の顧客 ${customers.length} 件` };
  return { kind: "none" };
}

/** 発注番号・案件番号の書き方のゆれをそろえる (全角・空白・いろいろなハイフン) */
export function normRef(v: string): string {
  return v
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s_]/g, "")
    .replace(/[‐‑‒–—―ー−－]/g, "-");
}

/**
 * 文章から発注番号 (PO-2026-0001) と案件番号 (O-2026-0123 など) を拾う。
 * AI が読めないとき (模擬の受信の文字・AI の読み取り結果の確認) に使う
 */
export function findRefs(text: string): { poNumbers: string[]; orderNumbers: string[] } {
  const t = normRef(text);
  const po = new Set<string>();
  const orders = new Set<string>();
  for (const m of t.matchAll(/P-?O-?(\d{4})-?(\d{1,5})(?!\d)/g)) po.add(`PO-${m[1]}-${m[2].padStart(4, "0")}`);
  for (const m of t.matchAll(/(?<![A-Z])O-(\d{4})-(\d{1,5})(?!\d)/g)) orders.add(`O-${m[1]}-${m[2].padStart(4, "0")}`);
  return { poNumbers: [...po], orderNumbers: [...orders] };
}
