import type { Customer, Database, Inquiry, Invoice, Order, Quote, User } from "@/lib/db/types";
import { scopeByStore } from "@/lib/auth/permissions";
import { fmtDate, yen } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";

/**
 * 顧客・案件・施工情報の検索 (AI アシスタントの検索支援)
 * ------------------------------------------------------------
 * 質問から「〇〇様」「〇〇さん」などの名前、番号 (O-2026-0012・Q-…・INQ-…・INV-…・C-00012)、電話番号、
 * 「」で囲んだ言葉を取り出し、利用者が閲覧できる店舗の顧客・問い合わせ・見積・受注・請求から探す。
 * 見つかった記録は、AI に渡す文章 (根拠) と画面のリンクにする
 */

export interface SearchTerms {
  names: string[];
  numbers: string[];
  phones: string[];
  words: string[];
}

const SPLIT = /[\s、。,.・「」『』()（）!?！？:：/]+|の|は|が|を|に|で|と|へ|から|まで|について|って|とか|や/;
const HONORIFIC = /(様|さま|サマ|さん|サン|邸|氏|殿|ちゃん)$/;
const NUMBER = /\b(?:O|Q|INQ|INV|EXP|AP|CASH)-\d{4}-\d{3,6}\b|\bC-\d{3,6}\b/gi;
const PHONE = /0\d{1,4}[-‐－(（]?\d{1,4}[-‐－)）]?\d{3,4}/g;

const digits = (v?: string) => (v ?? "").normalize("NFKC").replace(/[^0-9]/g, "");
const flat = (v?: string) => (v ?? "").normalize("NFKC").replace(/[\s　]/g, "");

export function extractTerms(question: string): SearchTerms {
  // 「田中 一郎様」のように姓と名の間に空白があっても 1 つの名前として読む
  const q = question.normalize("NFKC").replace(/([぀-ヿ㐀-鿿々])[\s　]+(?=[぀-ヿ㐀-鿿々])/g, "$1");
  const numbers = [...new Set((q.match(NUMBER) ?? []).map((n) => n.toUpperCase()))];
  const phones = [...new Set((q.match(PHONE) ?? []).map(digits).filter((d) => d.length >= 9))];
  const words = [...new Set([...q.matchAll(/[「『"]([^」』"]{2,40})[」』"]/g)].map((m) => m[1].trim()))];
  const names = [
    ...new Set(
      q
        .split(SPLIT)
        .map((t) => t.trim())
        .filter((t) => HONORIFIC.test(t))
        .map((t) => t.replace(HONORIFIC, "").replace(/^(お客|顧客|お客様)/, ""))
        .filter((t) => t.length >= 1 && t.length <= 12 && /[぀-ヿ㐀-鿿A-Za-z]/.test(t) && !/^(お客|皆|みな|担当|職人|店長|社長|業者)$/.test(t)),
    ),
  ];
  return { names, numbers, phones, words };
}

export interface RecordSearch {
  terms: SearchTerms;
  customers: { customer: Customer; total: number }[];
  /** 名前の候補が多すぎて絞り込めなかったとき */
  tooMany: { name: string; count: number }[];
  inquiries: Inquiry[];
  quotes: Quote[];
  orders: Order[];
  invoices: Invoice[];
  /** AI に渡す文章 (見つからなければ空) */
  context: string;
  /** 画面に出すリンク */
  links: { label: string; href: string }[];
}

export function searchRecords(db: Database, user: User, question: string): RecordSearch {
  const terms = extractTerms(question);
  const customersAll = scopeByStore(user, db.customers);
  const orders = scopeByStore(user, db.orders);
  const quotes = scopeByStore(user, db.quotes);
  const inquiries = scopeByStore(user, db.inquiries);
  const invoices = scopeByStore(user, db.invoices);
  const found = new Map<string, Customer>();
  const tooMany: { name: string; count: number }[] = [];
  // 名前 (姓だけでも探す。候補が 6 件以上なら、絞り込みを促す)
  for (const name of terms.names) {
    const n = flat(name);
    const hits = customersAll.filter((c) => flat(c.name).startsWith(n) || flat(c.kana) === n || (n.length >= 3 && flat(c.name).includes(n)));
    if (hits.length > 5) tooMany.push({ name, count: hits.length });
    for (const c of hits.slice(0, 5)) found.set(c.id, c);
  }
  // 名前の敬称がなくても、氏名 (3 文字以上) がそのまま質問に含まれていれば当てる
  if (!terms.names.length && !terms.numbers.length && !terms.phones.length) {
    const q = flat(question);
    for (const c of customersAll) {
      const n = flat(c.name);
      if (n.length >= 3 && q.includes(n)) found.set(c.id, c);
      if (found.size >= 5) break;
    }
  }
  for (const p of terms.phones) for (const c of customersAll.filter((c) => digits(c.phone) === p).slice(0, 5)) found.set(c.id, c);
  for (const code of terms.numbers.filter((n) => n.startsWith("C-"))) {
    const c = customersAll.find((x) => x.code.toUpperCase() === code);
    if (c) found.set(c.id, c);
  }
  // 番号で直接
  const has = (n: string) => terms.numbers.includes(n.toUpperCase());
  const hitInquiries = inquiries.filter((i) => has(i.number) || (terms.phones.length && terms.phones.includes(digits(i.contactPhone))));
  const hitQuotes = quotes.filter((q) => has(q.number));
  const hitOrders = orders.filter((o) => has(o.number));
  const hitInvoices = invoices.filter((i) => has(i.number));
  // 「」の言葉: 受注・見積の件名、問い合わせの要約、顧客の住所
  for (const w of terms.words) {
    const f = flat(w);
    hitOrders.push(...orders.filter((o) => flat(o.title).includes(f) || flat(o.siteAddress).includes(f)).slice(0, 5));
    hitQuotes.push(...quotes.filter((q) => flat(q.title).includes(f)).slice(0, 5));
    hitInquiries.push(...inquiries.filter((i) => flat(i.summary).includes(f)).slice(0, 5));
    for (const c of customersAll.filter((c) => flat(c.address).includes(f)).slice(0, 5)) found.set(c.id, c);
  }
  const uniq = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  const customers = [...found.values()].slice(0, 5);

  const name = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const cname = (id?: string) => db.customers.find((c) => c.id === id)?.name ?? "-";
  const store = (id: string) => db.stores.find((s) => s.id === id)?.shortName ?? id;
  const lines: string[] = [];
  const links: { label: string; href: string }[] = [];
  const orderLine = (o: Order) => `  - 受注 [${o.number}](/orders/${o.id}) ${o.title} ${yen(o.total)} ${ORDER_STATUS[o.status].label} 契約 ${fmtDate(o.contractDate)}${o.scheduledStart ? ` 施工予定 ${fmtDate(o.scheduledStart)}` : ""}${o.completedAt ? ` 完了 ${fmtDate(o.completedAt)}` : ""} 担当 ${name(o.createdBy)}${o.workerIds.length ? ` 施工 ${o.workerIds.map(name).join("・")}` : ""}`;
  for (const c of customers) {
    const co = orders.filter((o) => o.customerId === c.id).sort((a, b) => b.contractDate.localeCompare(a.contractDate));
    const ci = inquiries.filter((i) => i.customerId === c.id && ["new", "in_progress", "quoted"].includes(i.status));
    const cv = invoices.filter((i) => i.customerId === c.id && ["issued", "partially_paid", "overdue"].includes(i.status));
    const comms = db.commLogs.filter((l) => l.customerId === c.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
    lines.push(`- 顧客 [${c.name} 様](/customers/${c.id}) (${c.code} / ${store(c.storeId)}) 電話 ${c.phone || "-"} 住所 ${c.address || "-"} 担当 ${name(c.assignedUserId)} / 受注 ${co.length} 件・累計売上 ${yen(co.filter((o) => o.salesDate).reduce((a, o) => a + o.total, 0))}`);
    for (const o of co.slice(0, 5)) lines.push(orderLine(o));
    for (const i of ci) lines.push(`  - 対応中の問い合わせ [${i.number}](/inquiries/${i.id}) ${i.summary} (${INQUIRY_STATUS[i.status].label}, 担当 ${name(i.assignedUserId)})`);
    for (const i of cv) lines.push(`  - 未入金の請求 [${i.number}](/invoices/${i.id}) 残 ${yen(i.total - i.paidAmount)} 期限 ${fmtDate(i.dueDate)}`);
    for (const l of comms) lines.push(`  - やりとり ${fmtDate(l.at)} [${CHANNEL_LABEL[l.channel]}] ${l.subject || l.body.slice(0, 40)}`);
    links.push({ label: `${c.name} 様 (${c.code})`, href: `/customers/${c.id}` });
  }
  for (const i of uniq(hitInquiries).slice(0, 5)) {
    lines.push(`- 問い合わせ [${i.number}](/inquiries/${i.id}) ${fmtDate(i.receivedAt)} [${CHANNEL_LABEL[i.channel]}] ${i.contactName}: ${i.summary} (${INQUIRY_STATUS[i.status].label}, ${CATEGORY_LABEL[i.category]}, 担当 ${name(i.assignedUserId)}${i.nextAction ? `, 次: ${i.nextAction} ${i.nextActionDue ?? ""}` : ""})`);
    links.push({ label: `問い合わせ ${i.number}`, href: `/inquiries/${i.id}` });
  }
  for (const q of uniq(hitQuotes).slice(0, 5)) {
    lines.push(`- 見積 [${q.number}](/quotes/${q.id}) ${cname(q.customerId)} 様 ${q.title} ${yen(q.total)} ${QUOTE_STATUS[q.status].label} 作成 ${name(q.createdBy)} 有効期限 ${fmtDate(q.validUntil)}`);
    links.push({ label: `見積 ${q.number}`, href: `/quotes/${q.id}` });
  }
  for (const o of uniq(hitOrders).slice(0, 5)) {
    lines.push(`- ${cname(o.customerId)} 様の受注:\n${orderLine(o)} 現場 ${o.siteAddress || "-"}${o.progressNotes.length ? ` / 最新の進捗: ${o.progressNotes[o.progressNotes.length - 1].body.slice(0, 80)}` : ""}`);
    links.push({ label: `受注 ${o.number}`, href: `/orders/${o.id}` });
  }
  for (const i of uniq(hitInvoices).slice(0, 5)) {
    lines.push(`- 請求 [${i.number}](/invoices/${i.id}) ${cname(i.customerId)} 様 ${yen(i.total)} 入金 ${yen(i.paidAmount)} ${INVOICE_STATUS[i.status].label} 期限 ${fmtDate(i.dueDate)}`);
    links.push({ label: `請求 ${i.number}`, href: `/invoices/${i.id}` });
  }
  for (const t of tooMany) lines.push(`- 「${t.name}」に当てはまる顧客が ${t.count} 件あります (上位 5 件のみ表示。フルネーム・電話番号・住所で絞り込めます)`);
  return { terms, customers: customers.map((c) => ({ customer: c, total: orders.filter((o) => o.customerId === c.id).length })), tooMany, inquiries: uniq(hitInquiries), quotes: uniq(hitQuotes), orders: uniq(hitOrders), invoices: uniq(hitInvoices), context: lines.join("\n"), links };
}
