import "server-only";
import { customerPhonesText } from "@/lib/customer-contacts";
import type { Database, User } from "@/lib/db/types";
import { canAccessStore, canViewExpense } from "@/lib/auth/permissions";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, EXPENSE_STATUS, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { approvalHref } from "@/lib/approval-href";
import { AiError, aiEnabled, generateJson, generateText } from "./provider";
import { SECTIONS_BY_KIND, SECTION_LABEL, SECTION_REF, SUMMARY_KIND_LABEL, type SectionSummary, type SummaryKind, type SummaryOptions, type SummaryResult, type SummarySection, type SummarySource } from "./summary-sections";

export { SUMMARY_KIND_LABEL, type SummaryKind } from "./summary-sections";

/**
 * 見積・受注 (施工)・経費・顧客・問い合わせの要約 (長い履歴に対応)
 * ------------------------------------------------------------
 * 1) recordDigest: 記録とその周辺を、区分 (見積・受注 / 進捗・作業 / 予定 / 請求・入金 / やりとり / 承認・変更) ごとの
 *    「根拠の記録」の一覧にする。1 件ずつに記号 ([P3] など) と元の画面へのリンクを付ける。期間 (from〜to) と区分で絞れる
 * 2) summarizeDigest: 区分ごとに要約し (長い区分は期間の古い順に分けて別々に要約)、最後に全体の要約 (概要・要点・次に必要な対応) を作る。
 *    AI には記号つきで渡し、要約の文にも記号を書かせる (画面で記号を元の記録へのリンクにする)。記録にない記号は消す
 * 3) AI のキーがないとき・失敗したときは、記録から決まった形でまとめる (件数・最新の記録・金額)
 * 閲覧できない記録は要約しない (記録ごとに permissions.ts で確かめる)。要約は保存しない
 */

export interface DigestItem {
  ref: string;
  date?: string;
  text: string;
  label: string;
  href?: string;
}

export interface DigestSection {
  key: SummarySection;
  label: string;
  items: DigestItem[];
}

export interface RecordDigest {
  kind: SummaryKind;
  label: string;
  href: string;
  /** 要点 (自動まとめにも使う) */
  head: string[];
  /** 基本の情報 (期間・区分に関係なく渡す) */
  basics: string[];
  sections: DigestSection[];
  /** 期間・区分の説明 */
  scope: string;
}

/** 互換: 事実の一覧 (文書の作成 draft.ts が使う) */
export interface RecordFacts {
  kind: SummaryKind;
  label: string;
  href: string;
  head: string[];
  facts: string;
}

const uname = (db: Database, id?: string) => (id === "system" ? "システム" : (db.users.find((u) => u.id === id)?.name ?? "-"));
const cname = (db: Database, id?: string) => db.customers.find((c) => c.id === id)?.name ?? "-";
const flat = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const dayOf = (s?: string) => (s ? s.slice(0, 10) : undefined);

/** 区分ごとの記録を集める入れ物 (期間で絞る・記号を振る) */
class Builder {
  private secs = new Map<SummarySection, DigestItem[]>();
  constructor(
    private readonly opts: SummaryOptions,
    private readonly allowed: SummarySection[],
  ) {}
  add(key: SummarySection, item: Omit<DigestItem, "ref">) {
    if (!this.allowed.includes(key)) return;
    const d = dayOf(item.date);
    if (d && this.opts.from && d < this.opts.from) return;
    if (d && this.opts.to && d > this.opts.to) return;
    const list = this.secs.get(key) ?? [];
    list.push({ ...item, ref: "" });
    this.secs.set(key, list);
  }
  build(): DigestSection[] {
    return this.allowed
      .filter((k) => this.secs.get(k)?.length)
      .map((key) => {
        // 古い順に並べて記号を振る (要約は時系列で読みやすく)
        const items = [...this.secs.get(key)!].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
        items.forEach((it, i) => (it.ref = `${SECTION_REF[key]}${i + 1}`));
        return { key, label: SECTION_LABEL[key], items };
      });
  }
}

function approvalsInto(db: Database, b: Builder, targetId: string) {
  for (const a of db.approvals.filter((x) => x.targetId === targetId)) {
    b.add("approvals", {
      date: a.decidedAt ?? a.createdAt,
      label: `${APPROVAL_TYPE_LABEL[a.type]} (${APPROVAL_STATUS[a.status].label})`,
      href: approvalHref(a),
      text: `${APPROVAL_TYPE_LABEL[a.type]}: ${APPROVAL_STATUS[a.status].label} (申請 ${uname(db, a.requestedBy)} ${fmtDate(a.createdAt)}${a.amount ? ` ${yen(a.amount)}` : ""}${a.decidedBy ? ` / 判断 ${uname(db, a.decidedBy)} ${fmtDate(a.decidedAt)}` : ""}${a.decisionComment ? ` 「${flat(a.decisionComment, 120)}」` : ""}${a.changes?.length ? ` / 変更 ${a.changes.map((c) => c.field).join("・")}` : ""})`,
    });
  }
}

function commsInto(db: Database, b: Builder, filter: (c: Database["commLogs"][number]) => boolean) {
  for (const c of db.commLogs.filter(filter)) {
    const day = c.at.slice(0, 10);
    b.add("comms", {
      date: c.at,
      label: `${CHANNEL_LABEL[c.channel]}・${c.direction === "inbound" ? "受信" : "送信"} ${flat(c.subject || c.body, 30)}`,
      href: c.customerId ? `/contacts?customerId=${c.customerId}&from=${day}&to=${day}` : `/contacts?from=${day}&to=${day}`,
      text: `${fmtDateTime(c.at)} [${CHANNEL_LABEL[c.channel]}・${c.direction === "inbound" ? "受信" : "送信"}${c.userId ? `・${uname(db, c.userId)}` : ""}] ${flat(c.subject || "", 40)} ${flat(c.body, 400)}`,
    });
  }
}

function eventsInto(db: Database, b: Builder, filter: (e: Database["schedule"][number]) => boolean) {
  for (const e of db.schedule.filter(filter)) {
    b.add("schedule", {
      date: e.date,
      label: `${fmtDate(e.date)} ${flat(e.title, 40)}`,
      href: `/schedule/${e.id}`,
      text: `${fmtDate(e.date)}${e.startTime ? ` ${e.startTime}` : ""} ${flat(e.title, 80)} (担当 ${e.assigneeIds.map((a) => uname(db, a)).join("・") || "未定"})${e.memo ? ` メモ: ${flat(e.memo, 160)}` : ""}`,
    });
  }
}

function invoicesInto(db: Database, b: Builder, invoices: Database["invoices"]) {
  for (const inv of invoices) {
    b.add("billing", {
      date: inv.issueDate,
      label: `請求 ${inv.number} (${INVOICE_STATUS[inv.status].label})`,
      href: `/invoices/${inv.id}`,
      text: `請求 ${inv.number} 請求日 ${fmtDate(inv.issueDate)} 期限 ${fmtDate(inv.dueDate)} 合計 ${yen(inv.total)} 入金済 ${yen(inv.paidAmount)} 残 ${yen(inv.total - inv.paidAmount)} ${INVOICE_STATUS[inv.status].label}`,
    });
    for (const p of db.payments.filter((x) => x.invoiceId === inv.id)) {
      b.add("billing", { date: p.date, label: `入金 ${fmtDate(p.date)} ${yen(p.amount)}`, href: `/invoices/${inv.id}`, text: `入金 ${fmtDate(p.date)} ${yen(p.amount)} (${p.method}${p.memo ? ` ${flat(p.memo, 60)}` : ""}) → 請求 ${inv.number}` });
    }
  }
}

function scopeText(kind: SummaryKind, opts: SummaryOptions, allowed: SummarySection[]): string {
  const all = SECTIONS_BY_KIND[kind];
  const period = opts.from || opts.to ? `期間 ${opts.from ? fmtDate(opts.from) : "最初"}〜${opts.to ? fmtDate(opts.to) : "今日"}` : "全期間";
  const secs = allowed.length === all.length ? "すべての内容" : allowed.map((s) => SECTION_LABEL[s]).join("・");
  return `${period} · ${secs}`;
}

/** 記録の根拠の一覧を作る (閲覧できないときは null) */
export function recordDigest(db: Database, user: User, kind: SummaryKind, id: string, opts: SummaryOptions = {}): RecordDigest | null {
  const all = SECTIONS_BY_KIND[kind];
  const allowed = opts.sections?.length ? all.filter((s) => opts.sections!.includes(s)) : all;
  const b = new Builder(opts, allowed);
  const scope = scopeText(kind, opts, allowed);

  if (kind === "quote") {
    const q = db.quotes.find((x) => x.id === id);
    if (!q || !canAccessStore(user, q.storeId)) return null;
    const order = db.orders.find((o) => o.quoteId === q.id);
    const head = [`${cname(db, q.customerId)} 様「${q.title}」 ${yen(q.total)} (${QUOTE_STATUS[q.status].label})`, `明細 ${q.items.length} 行 · 有効期限 ${fmtDate(q.validUntil)} · 作成 ${uname(db, q.createdBy)}`, order ? `受注 ${order.number} (${ORDER_STATUS[order.status].label})` : "まだ受注になっていません"];
    const basics = [
      `見積 ${q.number} (第 ${q.version} 版) ${CATEGORY_LABEL[q.category]}`,
      `お客様: ${cname(db, q.customerId)} 様 / 件名: ${q.title} / 状態: ${QUOTE_STATUS[q.status].label}`,
      `金額: 小計 ${yen(q.subtotal)} 値引 ${yen(q.discount)} 消費税 ${yen(q.tax)} 合計 ${yen(q.total)}${q.taxIncluded ? " (税込単価)" : ""}`,
      `作成 ${uname(db, q.createdBy)} ${fmtDate(q.createdAt)} / 有効期限 ${fmtDate(q.validUntil)}${q.issuedAt ? ` / 発行 ${fmtDate(q.issuedAt)}` : ""}${q.sentVia ? ` (${CHANNEL_LABEL[q.sentVia]}で送付)` : ""}`,
      "明細:",
      ...q.items.slice(0, 40).map((i) => `- ${i.name}${i.spec ? ` (${i.spec})` : ""} ${i.qty}${i.unit} × ${yen(i.unitPrice)} = ${yen(i.amount)}`),
      q.items.length > 40 ? `- … ほか ${q.items.length - 40} 行` : "",
      q.workDetails ? `作業内容: ${flat(q.workDetails, 600)}` : "",
      q.notes ? `備考: ${flat(q.notes, 600)}` : "",
    ];
    for (const rv of q.revisions ?? []) {
      b.add("quotes", { date: rv.replacedAt, label: `見積の改訂 (第 ${rv.version} 版 → 次の版)`, href: `/quotes/${q.id}`, text: `見積の改訂 ${fmtDate(rv.replacedAt)}: 第 ${rv.version} 版 (合計 ${yen(rv.total)}) から次の版へ${rv.changeReason ? ` 理由「${flat(rv.changeReason, 120)}」` : ""}${rv.changeRequestedBy ? ` 申請 ${uname(db, rv.changeRequestedBy)}` : ""}${rv.changeApprovedBy ? ` 承認 ${uname(db, rv.changeApprovedBy)}` : ""}` });
    }
    if (order) b.add("quotes", { date: order.contractDate, label: `受注 ${order.number}`, href: `/orders/${order.id}`, text: `受注 ${order.number} 契約 ${fmtDate(order.contractDate)} ${yen(order.total)} ${ORDER_STATUS[order.status].label} 施工予定 ${fmtDate(order.scheduledStart)}` });
    eventsInto(db, b, (e) => e.quoteId === q.id);
    commsInto(db, b, (c) => c.relatedType === "quote" && c.relatedId === q.id);
    approvalsInto(db, b, q.id);
    return { kind, label: `見積 ${q.number}`, href: `/quotes/${q.id}`, head, basics: basics.filter(Boolean), sections: b.build(), scope };
  }

  if (kind === "order") {
    const o = db.orders.find((x) => x.id === id);
    if (!o || !canAccessStore(user, o.storeId)) return null;
    const invs = db.invoices.filter((i) => i.id === o.invoiceId || i.orderId === o.id);
    const inv = invs[0];
    const head = [
      `${cname(db, o.customerId)} 様「${o.title}」 ${yen(o.total)} (${ORDER_STATUS[o.status].label})`,
      `契約 ${fmtDate(o.contractDate)} · 施工予定 ${fmtDate(o.scheduledStart)}${o.completedAt ? ` · 完了 ${fmtDate(o.completedAt)}` : ""}`,
      inv ? `請求 ${inv.number} ${INVOICE_STATUS[inv.status].label} (入金 ${yen(inv.paidAmount)} / ${yen(inv.total)})` : "請求書はまだありません",
    ];
    const basics = [
      `受注 ${o.number} ${CATEGORY_LABEL[o.category]} / お客様: ${cname(db, o.customerId)} 様 / 件名: ${o.title}`,
      `状態: ${ORDER_STATUS[o.status].label} / 金額: ${yen(o.total)} / 契約日 ${fmtDate(o.contractDate)}`,
      `施工予定: ${fmtDate(o.scheduledStart)}〜${fmtDate(o.scheduledEnd)} / 施工担当: ${o.workerIds.map((w) => uname(db, w)).join("・") || "未定"} / 現場: ${o.siteAddress || "-"}`,
      o.completedAt ? `施工完了: ${fmtDate(o.completedAt)}${o.salesDate ? ` (売上計上 ${fmtDate(o.salesDate)})` : ""}` : "",
      o.workDetails ? `作業内容: ${flat(o.workDetails, 600)}` : "",
      o.fusumaPaper ? `襖紙: ${o.fusumaPaper}` : "",
      o.specNote ? `仕様メモ: ${flat(o.specNote, 400)}` : "",
    ];
    for (const p of o.progressNotes) b.add("progress", { date: p.at, label: `${fmtDate(p.at)} ${uname(db, p.userId)}: ${flat(p.body, 30)}`, href: `/orders/${o.id}`, text: `${fmtDateTime(p.at)} ${uname(db, p.userId)}: ${flat(p.body, 500)}` });
    eventsInto(db, b, (e) => e.orderId === o.id);
    invoicesInto(db, b, invs);
    commsInto(db, b, (c) => (c.relatedType === "order" && c.relatedId === o.id) || (c.relatedType === "invoice" && invs.some((i) => i.id === c.relatedId)));
    const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
    if (q) b.add("quotes", { date: q.createdAt, label: `見積 ${q.number}`, href: `/quotes/${q.id}`, text: `元の見積 ${q.number} ${flat(q.title, 60)} ${yen(q.total)} (${QUOTE_STATUS[q.status].label}・作成 ${uname(db, q.createdBy)} ${fmtDate(q.createdAt)})` });
    approvalsInto(db, b, o.id);
    return { kind, label: `受注 ${o.number}`, href: `/orders/${o.id}`, head, basics: basics.filter(Boolean), sections: b.build(), scope };
  }

  if (kind === "expense") {
    const e = db.expenses.find((x) => x.id === id);
    if (!e || !canViewExpense(user, e)) return null;
    const head = [`${e.vendor} ${yen(e.amount)} (${e.account})`, `${fmtDate(e.date)} · 申請 ${uname(db, e.submittedBy)} · ${EXPENSE_STATUS[e.status].label}`];
    const basics = [
      `経費 ${e.number} / 日付 ${fmtDate(e.date)} / 支払先 ${e.vendor} / 金額 ${yen(e.amount)} (うち消費税 ${yen(e.taxAmount)})`,
      `勘定科目 ${e.account} / 支払方法 ${e.paymentMethod === "cash" ? "現金 (立替)" : e.paymentMethod === "card" ? "カード" : "振込"} / 状態 ${EXPENSE_STATUS[e.status].label}`,
      `申請 ${uname(db, e.submittedBy)}${e.approvedBy ? ` / 承認 ${uname(db, e.approvedBy)} ${fmtDate(e.approvedAt)}` : ""}${e.paidAt ? ` / 精算 ${fmtDate(e.paidAt)}` : ""}`,
      e.description ? `内容: ${flat(e.description, 400)}` : "",
      e.source === "ocr" ? "レシートの写真から登録" : "",
    ];
    approvalsInto(db, b, e.id);
    return { kind, label: `経費 ${e.number}`, href: `/expenses/${e.id}`, head, basics: basics.filter(Boolean), sections: b.build(), scope };
  }

  if (kind === "customer") {
    const c = db.customers.find((x) => x.id === id);
    if (!c || !canAccessStore(user, c.storeId)) return null;
    // ほかの店舗の案件 (お客様の店舗と違う店舗の受注など) は、見られる店舗のものだけ
    const orders = db.orders.filter((o) => o.customerId === c.id && canAccessStore(user, o.storeId));
    const quotes = db.quotes.filter((q) => q.customerId === c.id && canAccessStore(user, q.storeId));
    const inquiries = db.inquiries.filter((i) => i.customerId === c.id && canAccessStore(user, i.storeId));
    const invoices = db.invoices.filter((i) => i.customerId === c.id && canAccessStore(user, i.storeId));
    const open = inquiries.filter((i) => ["new", "in_progress", "quoted"].includes(i.status));
    const unpaid = invoices.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
    const sorted = [...orders].sort((a, b) => b.contractDate.localeCompare(a.contractDate));
    const head = [`${c.name} 様 (${c.code}) · 受注 ${orders.length} 件 · 累計売上 ${yen(orders.filter((o) => o.salesDate).reduce((a, o) => a + o.total, 0))}`, sorted[0] ? `最新の受注: ${sorted[0].title} (${fmtDate(sorted[0].contractDate)}, ${ORDER_STATUS[sorted[0].status].label})` : "受注はまだありません", `対応中の問い合わせ ${open.length} 件 · 未入金 ${unpaid.length} 件`];
    const basics = [
      `顧客 ${c.code} ${c.name} 様 (${c.kana}) ${c.type === "corporate" ? "法人" : "個人"} / 電話 ${customerPhonesText(c) || "-"} / 住所 ${c.address || "-"} / 担当 ${uname(db, c.assignedUserId)}${c.tradeStopped ? ` / 取引停止${c.tradeStopNote ? ` (${c.tradeStopNote})` : ""}` : ""}`,
      c.tags.length ? `タグ: ${c.tags.join("・")}` : "",
      c.notes ? `メモ: ${flat(c.notes, 600)}` : "",
      `受注 ${orders.length} 件 (うち施工完了 ${orders.filter((o) => o.completedAt).length} 件)・見積 ${quotes.length} 件・問い合わせ ${inquiries.length} 件・請求 ${invoices.length} 件 (未入金 ${unpaid.length} 件 残 ${yen(unpaid.reduce((a, i) => a + i.total - i.paidAmount, 0))})`,
    ];
    for (const i of inquiries) b.add("quotes", { date: i.receivedAt, label: `問い合わせ ${i.number}`, href: `/inquiries/${i.id}`, text: `問い合わせ ${i.number} ${fmtDate(i.receivedAt)} ${CHANNEL_LABEL[i.channel]} ${flat(i.summary, 80)} (${INQUIRY_STATUS[i.status].label})` });
    for (const q of quotes) b.add("quotes", { date: q.createdAt, label: `見積 ${q.number}`, href: `/quotes/${q.id}`, text: `見積 ${q.number} ${fmtDate(q.createdAt)} ${flat(q.title, 60)} ${yen(q.total)} (${QUOTE_STATUS[q.status].label})` });
    for (const o of orders) {
      const last = o.progressNotes[o.progressNotes.length - 1];
      b.add("progress", { date: o.contractDate, label: `受注 ${o.number} ${flat(o.title, 30)}`, href: `/orders/${o.id}`, text: `受注 ${o.number} 契約 ${fmtDate(o.contractDate)} ${flat(o.title, 60)} ${yen(o.total)} ${ORDER_STATUS[o.status].label}${o.completedAt ? ` 完了 ${fmtDate(o.completedAt)}` : ""}${o.workerIds.length ? ` 施工 ${o.workerIds.map((w) => uname(db, w)).join("・")}` : ""}${last ? ` / 最新の経過 ${fmtDate(last.at)}: ${flat(last.body, 160)}` : ""}` });
    }
    eventsInto(db, b, (e) => e.customerId === c.id && canAccessStore(user, e.storeId));
    invoicesInto(db, b, invoices);
    commsInto(db, b, (l) => l.customerId === c.id);
    return { kind, label: `${c.name} 様`, href: `/customers/${c.id}`, head, basics: basics.filter(Boolean), sections: b.build(), scope };
  }

  const i = db.inquiries.find((x) => x.id === id);
  if (!i || !canAccessStore(user, i.storeId)) return null;
  const head = [`${i.contactName} 様: ${i.summary} (${INQUIRY_STATUS[i.status].label})`, `${fmtDateTime(i.receivedAt)} · ${CHANNEL_LABEL[i.channel]} · 担当 ${uname(db, i.assignedUserId)}`, i.nextAction ? `次: ${i.nextAction}${i.nextActionDue ? ` (${fmtDate(i.nextActionDue)})` : ""}` : "次のアクションは未設定"];
  const basics = [
    `問い合わせ ${i.number} / 受付 ${fmtDateTime(i.receivedAt)} / 入口 ${CHANNEL_LABEL[i.channel]} / 種別 ${CATEGORY_LABEL[i.category]} / 状態 ${INQUIRY_STATUS[i.status].label}`,
    `お客様: ${i.contactName} ${i.contactPhone ?? ""} / 担当 ${uname(db, i.assignedUserId)}`,
    `要約: ${i.summary}`,
    `詳細: ${flat(i.detail, 3000)}`,
    i.nextAction ? `次の対応: ${i.nextAction}${i.nextActionDue ? ` (期限 ${fmtDate(i.nextActionDue)})` : ""}` : "",
  ];
  for (const q of db.quotes.filter((x) => x.inquiryId === i.id && canAccessStore(user, x.storeId))) b.add("quotes", { date: q.createdAt, label: `見積 ${q.number}`, href: `/quotes/${q.id}`, text: `見積 ${q.number} ${fmtDate(q.createdAt)} ${flat(q.title, 60)} ${yen(q.total)} (${QUOTE_STATUS[q.status].label})` });
  eventsInto(db, b, (e) => e.inquiryId === i.id);
  commsInto(db, b, (c) => c.relatedType === "inquiry" && c.relatedId === i.id);
  return { kind, label: `問い合わせ ${i.number}`, href: `/inquiries/${i.id}`, head, basics: basics.filter(Boolean), sections: b.build(), scope };
}

/** 互換: 事実の一覧 (各区分の新しいものから 10 件まで) */
export function recordFacts(db: Database, user: User, kind: SummaryKind, id: string): RecordFacts | null {
  const d = recordDigest(db, user, kind, id);
  if (!d) return null;
  const lines = [...d.basics];
  for (const s of d.sections) {
    lines.push(`${s.label} (新しい順):`);
    lines.push(...[...s.items].reverse().slice(0, 10).map((x) => `- ${x.text}`));
  }
  return { kind: d.kind, label: d.label, href: d.href, head: d.head, facts: lines.join("\n") };
}

/** AI の文章から Markdown の記号を除く (見出し → 【見出し】、**強調** → 強調、- 箇条書き → ・) */
export function plainText(s: string): string {
  return s
    .trim()
    .replace(/^#{1,6}\s*(.+?)\s*#*$/gm, (_, h: string) => (/^【.*】$/.test(h) ? h : `【${h}】`))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^(\s*)[-*]\s+/gm, "$1・")
    .replace(/\n{3,}/g, "\n\n");
}

/* ================================================================== */
/* 要約                                                                 */
/* ================================================================== */

/** 1 回で AI に渡す区分の文字数の目安 (超えたら区分ごと・期間ごとに分けて要約する) */
export const DIRECT_LIMIT = 9000;
/** 区分を分けるときの 1 つの塊の文字数 */
export const CHUNK_CHARS = 6000;
/** 1 つの区分の塊の数の上限 (超えたら新しい記録から使い、古いものは件数だけ伝える) */
export const MAX_CHUNKS = 4;
/** AI の呼び出しの上限 (区分の要約 + 全体の要約) */
export const MAX_CALLS = 9;

const itemLine = (x: DigestItem) => `[${x.ref}] ${x.text}`;

/** 区分を、文字数の目安で期間の古い順の塊に分ける (多すぎるときは新しいものを残す) */
export function chunkSection(s: DigestSection, chars = CHUNK_CHARS, maxChunks = MAX_CHUNKS): { chunks: DigestItem[][]; dropped: number } {
  const budget = chars * maxChunks;
  let total = 0;
  let start = s.items.length;
  while (start > 0 && total + itemLine(s.items[start - 1]).length + 1 <= budget) {
    total += itemLine(s.items[start - 1]).length + 1;
    start--;
  }
  const kept = s.items.slice(start);
  const chunks: DigestItem[][] = [];
  let cur: DigestItem[] = [];
  let size = 0;
  for (const it of kept) {
    const n = itemLine(it).length + 1;
    if (cur.length && size + n > chars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  // 詰め方の余りで塊が上限を超えたら、古い塊から落とす (件数だけ伝える)
  let dropped = start;
  while (chunks.length > maxChunks) dropped += chunks.shift()!.length;
  return { chunks, dropped };
}

const sectionText = (s: DigestSection, items = s.items) => items.map(itemLine).join("\n");
const span = (items: DigestItem[]) => {
  const ds = items.map((x) => dayOf(x.date)).filter(Boolean) as string[];
  return ds.length ? `${fmtDate(ds[0])}〜${fmtDate(ds[ds.length - 1])}` : "日付なし";
};

/** 記号を確かめる (記録にない記号を消す) */
export function cleanRefs(text: string, valid: Set<string>): string {
  return text.replace(/\[([A-Z]\d{1,4})(?:[,、・\s]+[A-Z]\d{1,4})*\]/g, (m) => {
    const refs = m.slice(1, -1).split(/[,、・\s]+/).filter((r) => valid.has(r));
    return refs.length ? `[${refs.join(", ")}]` : "";
  });
}

const SYSTEM_BASE = [
  "あなたは株式会社一畳屋 (畳・襖・障子・網戸の専門店) の社内向けアシスタントです。",
  "記録にない事実は書かないでください。金額・日付・名前は記録のとおりに書いてください。",
  "根拠にした記録の記号 (例: [P3]・[B1, B2]) を、その事実を書いた文の終わりに必ず付けてください。記号は与えられたものだけを使ってください。",
  "Markdown の記号 (#・**・-) は使わず、箇条書きは「・」にしてください (画面ではそのまま文字で表示されます)。",
].join("\n");

/** 区分の一部 (期間の塊) を要約する */
async function summarizeChunk(d: RecordDigest, s: DigestSection, items: DigestItem[], part: number, parts: number): Promise<{ text: string; provider: "claude" | "openai" }> {
  const r = await generateText({
    system: `${SYSTEM_BASE}\n次は ${d.label} の「${s.label}」の記録です${parts > 1 ? ` (${parts} 分割のうち ${part} 番目・${span(items)})` : ""}。大事な出来事・金額・日付・未解決のことを落とさず、「・」の箇条書き 3〜8 行で時系列にまとめてください。`,
    messages: [{ role: "user", content: sectionText(s, items) }],
    maxTokens: 900,
  });
  return { text: plainText(r.data), provider: r.provider };
}

interface FinalJson {
  overview: string;
  points: string[];
  next_actions: string[];
  sections: { key: string; summary: string }[];
}

const FINAL_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    points: { type: "array", items: { type: "string" } },
    next_actions: { type: "array", items: { type: "string" } },
    sections: { type: "array", items: { type: "object", properties: { key: { type: "string" }, summary: { type: "string" } }, required: ["key", "summary"], additionalProperties: false } },
  },
  required: ["overview", "points", "next_actions", "sections"],
  additionalProperties: false,
};

/** 自動まとめ (AI を使わない): 区分ごとの件数・最新の記録 */
export function rulesSummary(d: RecordDigest): Pick<SummaryResult, "overview" | "sections"> {
  const sections: SectionSummary[] = d.sections.map((s) => {
    const latest = [...s.items].reverse().slice(0, 3);
    const extra = s.key === "billing" ? billingLine(s) : "";
    return { key: s.key, label: s.label, count: s.items.length, used: s.items.length, text: [`・${s.items.length} 件 (${span(s.items)})${extra}`, ...latest.map((x) => `・最新: ${x.text.slice(0, 120)} [${x.ref}]`)].join("\n") };
  });
  return { overview: d.head.map((h) => `・${h}`).join("\n"), sections };
}

function billingLine(s: DigestSection): string {
  const paid = s.items.filter((x) => x.text.startsWith("入金")).length;
  return paid ? ` · 入金の記録 ${paid} 件` : "";
}

function composeText(d: RecordDigest, overview: string, sections: SectionSummary[]): string {
  return [`${d.label} の要約 (${d.scope})`, "", overview, ...sections.flatMap((s) => ["", `【${s.label}】(${s.count} 件${s.used < s.count ? `・新しい ${s.used} 件を要約` : ""})`, s.text])].join("\n").trim();
}

function sourcesOf(d: RecordDigest): SummarySource[] {
  return d.sections.flatMap((s) => s.items.map((x) => ({ ref: x.ref, section: s.key, date: dayOf(x.date), label: x.label, href: x.href })));
}

/**
 * 根拠の一覧から要約する (区分ごと → 全体)。
 * 区分の文字数の合計が DIRECT_LIMIT 以下なら 1 回の呼び出し。超えたら、長い区分を期間の塊に分けて並べて要約し、最後に全体をまとめる
 */
export async function summarizeDigest(d: RecordDigest): Promise<SummaryResult> {
  const sources = sourcesOf(d);
  const valid = new Set(sources.map((s) => s.ref));
  const base = { scope: d.scope, record: { label: d.label, href: d.href }, sources };
  const rules = () => {
    const r = rulesSummary(d);
    return { ...base, ok: true, provider: "rules" as const, ...r, text: composeText(d, r.overview, r.sections) };
  };
  if (!d.sections.length && !d.basics.length) return { ...rules(), message: "期間・内容に当てはまる記録がありません。" };
  if (!aiEnabled()) return rules();
  try {
    const total = d.sections.reduce((a, s) => a + sectionText(s).length, 0);
    // 区分ごとに、そのまま渡す文か、塊に分けた要約か
    const prepared: { s: DigestSection; text: string; used: number; summarized: boolean }[] = [];
    let calls = 0;
    let provider: "claude" | "openai" = "openai";
    if (total <= DIRECT_LIMIT) {
      for (const s of d.sections) prepared.push({ s, text: sectionText(s), used: s.items.length, summarized: false });
    } else {
      // 長い区分から塊に分ける (呼び出しの上限まで)
      const order = [...d.sections].sort((a, b) => sectionText(b).length - sectionText(a).length);
      const plans = new Map<SummarySection, { chunks: DigestItem[][]; dropped: number }>();
      let budget = MAX_CALLS - 1;
      for (const s of order) {
        const len = sectionText(s).length;
        if (len <= CHUNK_CHARS / 2 || budget <= 0) continue;
        const c = chunkSection(s, CHUNK_CHARS, Math.min(MAX_CHUNKS, budget));
        budget -= c.chunks.length;
        plans.set(s.key, c);
      }
      const jobs: Promise<void>[] = [];
      const results = new Map<SummarySection, string[]>();
      for (const s of d.sections) {
        const plan = plans.get(s.key);
        if (!plan) continue;
        const out: string[] = new Array(plan.chunks.length).fill("");
        results.set(s.key, out);
        plan.chunks.forEach((items, i) => {
          calls++;
          jobs.push(
            summarizeChunk(d, s, items, i + 1, plan.chunks.length).then((r) => {
              provider = r.provider;
              out[i] = plan.chunks.length > 1 ? `(${span(items)})\n${r.text}` : r.text;
            }),
          );
        });
      }
      await Promise.all(jobs);
      for (const s of d.sections) {
        const plan = plans.get(s.key);
        if (!plan) {
          // 塊に分けなかった区分は、短く切ってそのまま渡す
          const items = s.items.slice(-60);
          prepared.push({ s, text: sectionText(s, items), used: items.length, summarized: false });
          continue;
        }
        const used = plan.chunks.reduce((a, c) => a + c.length, 0);
        prepared.push({ s, text: `${plan.dropped ? `(古い記録 ${plan.dropped} 件は件数だけ: ${span(s.items.slice(0, plan.dropped))})\n` : ""}${results.get(s.key)!.join("\n")}`, used, summarized: true });
      }
    }
    calls++;
    const r = await generateJson<FinalJson>({
      system: [
        SYSTEM_BASE,
        `${SUMMARY_KIND_LABEL[d.kind]}「${d.label}」を、社員が 30 秒で把握できるようにまとめてください。範囲: ${d.scope}。`,
        "overview: 全体の概要 (1〜2 文)。points: 要点 (3〜6 個)。next_actions: 次に必要な対応 (0〜3 個。なければ空)。",
        "sections: 与えた区分ごとに 1 つ (key は区分の英字のまま)。summary は「・」の箇条書き 2〜6 行で、その区分の流れと大事な点。",
        "「(要約)」と書いた区分は、先に期間ごとに要約したものです。そこに付いている記号もそのまま使ってください。",
      ].join("\n"),
      parts: [
        {
          type: "text",
          text: [`■ 基本の情報\n${d.basics.join("\n")}`, ...prepared.map((p) => `■ 区分 ${p.s.key} (${p.s.label}・${p.s.items.length} 件${p.summarized ? "・要約" : ""})\n${p.text}`)].join("\n\n").slice(0, 40000),
        },
      ],
      schema: FINAL_SCHEMA,
      schemaName: "ichijoya_record_summary",
      maxTokens: 2500,
    });
    provider = r.provider;
    const f = r.data;
    const overview = cleanRefs([f.overview.trim(), ...(f.points ?? []).map((p) => `・${p.trim().replace(/^・/, "")}`), ...((f.next_actions ?? []).length ? ["", "【次に必要な対応】", ...f.next_actions.map((p) => `・${p.trim().replace(/^・/, "")}`)] : [])].join("\n"), valid);
    const sections: SectionSummary[] = prepared.map((p) => {
      const got = f.sections?.find((x) => x.key === p.s.key)?.summary;
      return { key: p.s.key, label: p.s.label, count: p.s.items.length, used: p.used, text: cleanRefs(plainText(got || "・(AI の要約がありません。根拠の記録を確かめてください)"), valid) };
    });
    return { ...base, ok: true, provider, overview: plainText(overview), sections, text: composeText(d, plainText(overview), sections), calls };
  } catch (err) {
    const message = err instanceof AiError ? err.message : (err as Error).message;
    return { ...rules(), message: `AI で要約できなかったため、記録から自動でまとめました (${message})` };
  }
}
