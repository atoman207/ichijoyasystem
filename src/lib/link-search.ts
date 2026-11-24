import type { Customer, Database, Inquiry, User } from "@/lib/db/types";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { customerPhoneDigits, customerPhoneIncludes, phoneDigits } from "@/lib/customer-contacts";
import { normName } from "@/lib/duplicates";
import { canLinkToCustomer, isPlaceholderCustomer, relinkBlocker } from "@/lib/customer-link";
import { addressMatch } from "@/lib/customer-match";
import { INQUIRY_STATUS } from "@/lib/constants";

/**
 * 問い合わせと既存の顧客をひも付けるときの検索 (お客様のご要望 2026-11-24「■5」「■6」: 少ない操作で検索・選択してひも付ける)
 * - 問い合わせの画面: 既存の顧客を、お名前・フリガナ・住所・町名・電話番号・顧客コードで探す (入力するたびに候補)
 * - 顧客の画面: このお客様にひも付けられる問い合わせ (お客様が未登録・予定表の取込の仮の顧客・見積の前) を、電話・お名前・地区の一致の順に出す
 * 顧客の候補は顧客の一覧で見られるお客様 (customer-link.ts の canLinkToCustomer)。問い合わせの候補はひも付けを変更できる店舗の記録だけ (canEditCaseStore)
 */

export interface CustomerHit {
  id: string;
  code: string;
  name: string;
  kana: string;
  phone: string;
  address: string;
  storeName: string;
  corporate: boolean;
  /** 予定表の取込で仮に作った顧客 */
  placeholder: boolean;
  /** 進行中の問い合わせ・受注の件数 */
  open: number;
}

const OPEN_INQ = new Set(["new", "in_progress", "quoted"]);
const OPEN_ORDER = new Set(["pending_approval", "returned", "confirmed", "scheduled", "in_progress"]);

const compact = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 既存の顧客の検索 (問い合わせ → 顧客)。q が空なら [] */
export function searchCustomers(db: Pick<Database, "customers" | "stores" | "inquiries" | "orders" | "settings">, user: User, q: string, limit = 20): CustomerHit[] {
  const term = compact(q);
  if (term.length < 1) return [];
  const digits = phoneDigits(q);
  const scored: { c: Customer; score: number }[] = [];
  // 住所で探す (「○○町△△117」「北区○○5丁目9-17」: 県・市区郡の書き方が違っても同じ住所。src/lib/customer-match.ts)
  const addrQuery = /\d/.test(term) && /[^\d-]/.test(term) && digits.length < 9;
  for (const c of db.customers) {
    // 顧客の一覧で見られるお客様 (ほかの店舗・本部で登録したお客様も。紐付けはお客様の記録を変えない)
    if (!canLinkToCustomer(db, user, c)) continue;
    const name = compact(c.name);
    const kana = compact(c.kana);
    let score = 0;
    if (name === term || kana === term) score = 100;
    else if (name.startsWith(term) || kana.startsWith(term)) score = 80;
    else if (name.includes(term) || kana.includes(term)) score = 60;
    else if (compact(c.code) === term) score = 90;
    else if (digits.length >= 3 && customerPhoneIncludes(c, digits)) score = digits.length >= 9 ? 95 : 55;
    else if (addrQuery && c.address && addressMatch(q, c.address) === "exact") score = 85;
    else if (addrQuery && c.address && (addressMatch(q, c.address) === "partial" || addressMatch(q, c.address) === "building")) score = 70;
    else if (compact(c.address).includes(term) || compact(c.area).includes(term)) score = 50;
    if (!score) continue;
    // 仮の顧客 (電話・住所なし) は後ろに
    if (isPlaceholderCustomer(c)) score -= 30;
    scored.push({ c, score });
  }
  // 同じ点数なら、変更できる店舗 (自店舗など) のお客様を先に
  const mine = (c: Customer) => (canEditCaseStore(user, c.storeId) ? 1 : 0);
  scored.sort((a, b) => b.score - a.score || mine(b.c) - mine(a.c) || b.c.updatedAt.localeCompare(a.c.updatedAt));
  const top = scored.slice(0, limit).map((x) => x.c);
  const ids = new Set(top.map((c) => c.id));
  const open = new Map<string, number>();
  for (const i of db.inquiries) if (i.customerId && ids.has(i.customerId) && OPEN_INQ.has(i.status)) open.set(i.customerId, (open.get(i.customerId) ?? 0) + 1);
  for (const o of db.orders) if (ids.has(o.customerId) && OPEN_ORDER.has(o.status)) open.set(o.customerId, (open.get(o.customerId) ?? 0) + 1);
  const storeName = new Map(db.stores.map((s) => [s.id, s.shortName || s.name]));
  return top.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    kana: c.kana,
    phone: [c.phone, ...(c.contacts ?? []).map((x) => x.phone)].filter(Boolean).slice(0, 2).join(" / "),
    address: c.address || (c.area ? `地区 ${c.area}` : ""),
    storeName: storeName.get(c.storeId) ?? c.storeId,
    corporate: c.type === "corporate",
    placeholder: isPlaceholderCustomer(c),
    open: open.get(c.id) ?? 0,
  }));
}

export interface InquiryHit {
  id: string;
  number: string;
  date: string;
  contactName: string;
  phone: string;
  address: string;
  summary: string;
  statusLabel: string;
  storeName: string;
  /** 今ひも付いているお客様 (予定表の取込の仮の顧客など) */
  currentCustomer?: string;
  /** 候補にした理由 (電話が一致・同じ姓・同じ地区) */
  reason?: string;
  /** 予定の件数 */
  events: number;
}

const surnameOf = (name: string) => normName(name.split(/[\s　]+/)[0] ?? "");

/** 顧客の画面: このお客様にひも付けられる問い合わせ。q が空なら電話・お名前・地区が合う候補だけ */
export function linkableInquiries(db: Pick<Database, "inquiries" | "customers" | "stores" | "quotes" | "schedule">, user: User, customer: Customer, q: string, limit = 20): InquiryHit[] {
  const term = compact(q);
  const digits = phoneDigits(q);
  const myPhones = new Set(customerPhoneDigits(customer));
  const mySei = surnameOf(customer.name);
  const myKana = compact(customer.kana);
  const myAddr = compact(customer.address);
  const myArea = compact(customer.area);
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const storeName = new Map(db.stores.map((s) => [s.id, s.shortName || s.name]));
  const eventCount = new Map<string, number>();
  for (const e of db.schedule) if (e.inquiryId) eventCount.set(e.inquiryId, (eventCount.get(e.inquiryId) ?? 0) + 1);
  const out: { inq: Inquiry; score: number; reason?: string }[] = [];
  for (const inq of db.inquiries) {
    if (inq.customerId === customer.id) continue;
    if (!canEditCaseStore(user, inq.storeId)) continue;
    const cur = inq.customerId ? customers.get(inq.customerId) : undefined;
    // お客様が未登録か、予定表の取込で仮に作った顧客の問い合わせだけ (ほかのお客様の案件は付け替えない)。見積の後の案件は除く
    if (cur && !isPlaceholderCustomer(cur)) continue;
    if (relinkBlocker(db, inq)) continue;
    const phones = [inq.contactPhone, inq.intake?.phone, inq.intake?.callbackPhone].map(phoneDigits).filter((d) => d.length >= 9);
    const addr = compact(inq.intake?.address);
    const area = compact(inq.area) || compact(cur?.area);
    let score = 0;
    let reason: string | undefined;
    if (term) {
      const hay = compact([inq.number, inq.contactName, inq.intake?.name, inq.intake?.kana, inq.summary, inq.detail, inq.intake?.address, inq.area, cur?.name].filter(Boolean).join(" "));
      if (digits.length >= 3 && phones.some((p) => p.includes(digits))) score = 90;
      else if (hay.includes(term)) score = 60;
      if (!score) continue;
    }
    if (phones.some((p) => myPhones.has(p))) {
      score += 50;
      reason = "電話番号が一致";
    } else if (mySei && (surnameOf(inq.contactName) === mySei || (myKana && compact(inq.intake?.kana).startsWith(myKana.slice(0, 3))))) {
      const sameArea = Boolean(area && (myAddr.includes(area) || myArea === area)) || Boolean(addr && myAddr && (addr.includes(myAddr.slice(0, 8)) || myAddr.includes(addr.slice(0, 8))));
      score += sameArea ? 40 : 20;
      reason = sameArea ? "同じ姓・同じ地区" : "同じ姓";
    } else if (!term) continue;
    if (OPEN_INQ.has(inq.status)) score += 5;
    out.push({ inq, score, reason });
  }
  out.sort((a, b) => b.score - a.score || b.inq.receivedAt.localeCompare(a.inq.receivedAt));
  return out.slice(0, limit).map(({ inq, reason }) => {
    const cur = inq.customerId ? customers.get(inq.customerId) : undefined;
    return {
      id: inq.id,
      number: inq.number,
      date: inq.receivedAt.slice(0, 10),
      contactName: inq.contactName,
      phone: inq.contactPhone || inq.intake?.phone || "",
      address: inq.intake?.address || (inq.area ? `地区 ${inq.area}` : cur?.area ? `地区 ${cur.area}` : ""),
      summary: inq.summary,
      statusLabel: INQUIRY_STATUS[inq.status]?.label ?? inq.status,
      storeName: storeName.get(inq.storeId) ?? inq.storeId,
      currentCustomer: cur ? `${cur.name} (${cur.code}・仮の顧客)` : undefined,
      reason,
      events: eventCount.get(inq.id) ?? 0,
    };
  });
}

/** 一覧に出す問い合わせの電話・住所 (顧客にひも付いていれば顧客の情報、なければ受付で聞いた情報。名前と電話だけの受付は住所が空) */
export function inquiryContact(inq: Pick<Inquiry, "contactPhone" | "intake" | "area">, c: Pick<Customer, "phone" | "address" | "area" | "tags"> | undefined): { phone: string; address: string } {
  const placeholder = isPlaceholderCustomer(c);
  const phone = (!placeholder && c?.phone) || inq.contactPhone || inq.intake?.phone || "";
  const address = (!placeholder && c?.address) || inq.intake?.address || c?.address || (inq.area ? inq.area : "");
  return { phone, address };
}
