import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canAccessStore, canViewExpense } from "@/lib/auth/permissions";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, EXPENSE_STATUS, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { AiError, aiEnabled, generateText } from "./provider";

/**
 * 見積・受注 (施工)・経費・顧客・問い合わせの要約
 * ------------------------------------------------------------
 * 記録とその周辺 (明細・承認・進捗・予定・請求・やりとり) を文章 (事実の一覧) にし、AI が社内向けに要点をまとめる。
 * AI の API キーがないときは、事実の一覧から決まった形でまとめる。閲覧できない記録は要約しない
 */

export type SummaryKind = "quote" | "order" | "expense" | "customer" | "inquiry";

export const SUMMARY_KIND_LABEL: Record<SummaryKind, string> = { quote: "見積", order: "受注・施工", expense: "経費", customer: "顧客", inquiry: "問い合わせ" };

export interface RecordFacts {
  kind: SummaryKind;
  label: string;
  href: string;
  /** 要点 (自動まとめにも使う) */
  head: string[];
  /** 詳しい事実の一覧 (AI に渡す) */
  facts: string;
}

const uname = (db: Database, id?: string) => (id === "system" ? "システム" : (db.users.find((u) => u.id === id)?.name ?? "-"));
const cname = (db: Database, id?: string) => db.customers.find((c) => c.id === id)?.name ?? "-";

function approvalsOf(db: Database, targetId: string): string[] {
  return db.approvals
    .filter((a) => a.targetId === targetId)
    .map((a) => `- ${APPROVAL_TYPE_LABEL[a.type]}: ${APPROVAL_STATUS[a.status].label} (申請 ${uname(db, a.requestedBy)} ${fmtDate(a.createdAt)}${a.decidedBy ? ` / 判断 ${uname(db, a.decidedBy)} ${fmtDate(a.decidedAt)}` : ""}${a.decisionComment ? ` 「${a.decisionComment}」` : ""})`);
}

function commsOf(db: Database, filter: (c: Database["commLogs"][number]) => boolean, n = 8): string[] {
  return db.commLogs
    .filter(filter)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, n)
    .map((c) => `- ${fmtDateTime(c.at)} [${CHANNEL_LABEL[c.channel]}・${c.direction === "inbound" ? "受信" : "送信"}] ${(c.subject || "").slice(0, 40)} ${c.body.replace(/\s+/g, " ").slice(0, 160)}`);
}

/** 記録の事実を集める (閲覧できないときは null) */
export function recordFacts(db: Database, user: User, kind: SummaryKind, id: string): RecordFacts | null {
  if (kind === "quote") {
    const q = db.quotes.find((x) => x.id === id);
    if (!q || !canAccessStore(user, q.storeId)) return null;
    const order = db.orders.find((o) => o.quoteId === q.id);
    const head = [`${cname(db, q.customerId)} 様「${q.title}」 ${yen(q.total)} (${QUOTE_STATUS[q.status].label})`, `明細 ${q.items.length} 行 · 有効期限 ${fmtDate(q.validUntil)} · 作成 ${uname(db, q.createdBy)}`, order ? `受注 ${order.number} (${ORDER_STATUS[order.status].label})` : "まだ受注になっていません"];
    const facts = [
      `見積 ${q.number} (第 ${q.version} 版) ${CATEGORY_LABEL[q.category]}`,
      `お客様: ${cname(db, q.customerId)} 様 / 件名: ${q.title} / 状態: ${QUOTE_STATUS[q.status].label}`,
      `金額: 小計 ${yen(q.subtotal)} 値引 ${yen(q.discount)} 消費税 ${yen(q.tax)} 合計 ${yen(q.total)}${q.taxIncluded ? " (税込単価)" : ""}`,
      `作成 ${uname(db, q.createdBy)} ${fmtDate(q.createdAt)} / 有効期限 ${fmtDate(q.validUntil)}${q.issuedAt ? ` / 発行 ${fmtDate(q.issuedAt)}` : ""}${q.sentVia ? ` (${CHANNEL_LABEL[q.sentVia]}で送付)` : ""}`,
      "明細:",
      ...q.items.map((i) => `- ${i.name}${i.spec ? ` (${i.spec})` : ""} ${i.qty}${i.unit} × ${yen(i.unitPrice)} = ${yen(i.amount)}`),
      q.workDetails ? `作業内容: ${q.workDetails}` : "",
      q.notes ? `備考: ${q.notes}` : "",
      q.revisions?.length ? `修正履歴: ${q.revisions.length} 回` : "",
      ...approvalsOf(db, q.id),
      order ? `受注: ${order.number} ${ORDER_STATUS[order.status].label} 施工予定 ${fmtDate(order.scheduledStart)}` : "",
      ...commsOf(db, (c) => c.relatedType === "quote" && c.relatedId === q.id, 5),
    ];
    return { kind, label: `見積 ${q.number}`, href: `/quotes/${q.id}`, head, facts: facts.filter(Boolean).join("\n") };
  }
  if (kind === "order") {
    const o = db.orders.find((x) => x.id === id);
    if (!o || !canAccessStore(user, o.storeId)) return null;
    const inv = db.invoices.find((i) => i.id === o.invoiceId || i.orderId === o.id);
    const events = db.schedule.filter((e) => e.orderId === o.id).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    const head = [
      `${cname(db, o.customerId)} 様「${o.title}」 ${yen(o.total)} (${ORDER_STATUS[o.status].label})`,
      `契約 ${fmtDate(o.contractDate)} · 施工予定 ${fmtDate(o.scheduledStart)}${o.completedAt ? ` · 完了 ${fmtDate(o.completedAt)}` : ""}`,
      inv ? `請求 ${inv.number} ${INVOICE_STATUS[inv.status].label} (入金 ${yen(inv.paidAmount)} / ${yen(inv.total)})` : "請求書はまだありません",
    ];
    const facts = [
      `受注 ${o.number} ${CATEGORY_LABEL[o.category]} / お客様: ${cname(db, o.customerId)} 様 / 件名: ${o.title}`,
      `状態: ${ORDER_STATUS[o.status].label} / 金額: ${yen(o.total)} / 契約日 ${fmtDate(o.contractDate)}`,
      `施工予定: ${fmtDate(o.scheduledStart)}〜${fmtDate(o.scheduledEnd)} / 施工担当: ${o.workerIds.map((w) => uname(db, w)).join("・") || "未定"} / 現場: ${o.siteAddress || "-"}`,
      o.completedAt ? `施工完了: ${fmtDate(o.completedAt)}${o.salesDate ? ` (売上計上 ${fmtDate(o.salesDate)})` : ""}` : "",
      o.workDetails ? `作業内容: ${o.workDetails}` : "",
      o.fusumaPaper ? `襖紙: ${o.fusumaPaper}` : "",
      o.specNote ? `仕様メモ: ${o.specNote}` : "",
      events.length ? "予定:" : "",
      ...events.slice(0, 10).map((e) => `- ${fmtDate(e.date)} ${e.startTime ?? ""} ${e.title} (${e.assigneeIds.map((a) => uname(db, a)).join("・")})`),
      o.progressNotes.length ? "進捗メモ (新しい順):" : "",
      ...[...o.progressNotes].reverse().slice(0, 10).map((p) => `- ${fmtDateTime(p.at)} ${uname(db, p.userId)}: ${p.body.replace(/\s+/g, " ").slice(0, 200)}`),
      inv ? `請求: ${inv.number} 請求日 ${fmtDate(inv.issueDate)} 期限 ${fmtDate(inv.dueDate)} 合計 ${yen(inv.total)} 入金 ${yen(inv.paidAmount)} ${INVOICE_STATUS[inv.status].label}` : "",
      ...approvalsOf(db, o.id),
      ...commsOf(db, (c) => c.relatedType === "order" && c.relatedId === o.id, 5),
    ];
    return { kind, label: `受注 ${o.number}`, href: `/orders/${o.id}`, head, facts: facts.filter(Boolean).join("\n") };
  }
  if (kind === "expense") {
    const e = db.expenses.find((x) => x.id === id);
    if (!e || !canViewExpense(user, e)) return null;
    const head = [`${e.vendor} ${yen(e.amount)} (${e.account})`, `${fmtDate(e.date)} · 申請 ${uname(db, e.submittedBy)} · ${EXPENSE_STATUS[e.status].label}`];
    const facts = [
      `経費 ${e.number} / 日付 ${fmtDate(e.date)} / 支払先 ${e.vendor} / 金額 ${yen(e.amount)} (うち消費税 ${yen(e.taxAmount)})`,
      `勘定科目 ${e.account} / 支払方法 ${e.paymentMethod === "cash" ? "現金 (立替)" : e.paymentMethod === "card" ? "カード" : "振込"} / 状態 ${EXPENSE_STATUS[e.status].label}`,
      `申請 ${uname(db, e.submittedBy)}${e.approvedBy ? ` / 承認 ${uname(db, e.approvedBy)} ${fmtDate(e.approvedAt)}` : ""}${e.paidAt ? ` / 精算 ${fmtDate(e.paidAt)}` : ""}`,
      e.description ? `内容: ${e.description}` : "",
      e.source === "ocr" ? "レシートの写真から登録" : "",
      ...approvalsOf(db, e.id),
    ];
    return { kind, label: `経費 ${e.number}`, href: `/expenses/${e.id}`, head, facts: facts.filter(Boolean).join("\n") };
  }
  if (kind === "customer") {
    const c = db.customers.find((x) => x.id === id);
    if (!c || !canAccessStore(user, c.storeId)) return null;
    const orders = db.orders.filter((o) => o.customerId === c.id).sort((a, b) => b.contractDate.localeCompare(a.contractDate));
    const open = db.inquiries.filter((i) => i.customerId === c.id && ["new", "in_progress", "quoted"].includes(i.status));
    const unpaid = db.invoices.filter((i) => i.customerId === c.id && ["issued", "partially_paid", "overdue"].includes(i.status));
    const head = [`${c.name} 様 (${c.code}) · 受注 ${orders.length} 件 · 累計売上 ${yen(orders.filter((o) => o.salesDate).reduce((a, o) => a + o.total, 0))}`, orders[0] ? `最新の受注: ${orders[0].title} (${fmtDate(orders[0].contractDate)}, ${ORDER_STATUS[orders[0].status].label})` : "受注はまだありません", `対応中の問い合わせ ${open.length} 件 · 未入金 ${unpaid.length} 件`];
    const facts = [
      `顧客 ${c.code} ${c.name} 様 (${c.kana}) ${c.type === "corporate" ? "法人" : "個人"} / 電話 ${c.phone || "-"} / 住所 ${c.address || "-"} / 担当 ${uname(db, c.assignedUserId)}`,
      c.tags.length ? `タグ: ${c.tags.join("・")}` : "",
      c.notes ? `メモ: ${c.notes}` : "",
      "受注 (新しい順):",
      ...orders.slice(0, 10).map((o) => `- ${o.number} ${fmtDate(o.contractDate)} ${o.title} ${yen(o.total)} ${ORDER_STATUS[o.status].label}`),
      ...open.map((i) => `- 対応中の問い合わせ ${i.number} ${i.summary} (${INQUIRY_STATUS[i.status].label})`),
      ...unpaid.map((i) => `- 未入金 ${i.number} 残 ${yen(i.total - i.paidAmount)} 期限 ${fmtDate(i.dueDate)}`),
      "やりとり (新しい順):",
      ...commsOf(db, (l) => l.customerId === c.id, 10),
    ];
    return { kind, label: `${c.name} 様`, href: `/customers/${c.id}`, head, facts: facts.filter(Boolean).join("\n") };
  }
  const i = db.inquiries.find((x) => x.id === id);
  if (!i || !canAccessStore(user, i.storeId)) return null;
  const head = [`${i.contactName} 様: ${i.summary} (${INQUIRY_STATUS[i.status].label})`, `${fmtDateTime(i.receivedAt)} · ${CHANNEL_LABEL[i.channel]} · 担当 ${uname(db, i.assignedUserId)}`, i.nextAction ? `次: ${i.nextAction}${i.nextActionDue ? ` (${fmtDate(i.nextActionDue)})` : ""}` : "次のアクションは未設定"];
  const facts = [
    `問い合わせ ${i.number} / 受付 ${fmtDateTime(i.receivedAt)} / 入口 ${CHANNEL_LABEL[i.channel]} / 種別 ${CATEGORY_LABEL[i.category]} / 状態 ${INQUIRY_STATUS[i.status].label}`,
    `お客様: ${i.contactName} ${i.contactPhone ?? ""} / 担当 ${uname(db, i.assignedUserId)}`,
    `要約: ${i.summary}`,
    `詳細: ${i.detail.slice(0, 3000)}`,
    ...commsOf(db, (c) => c.relatedType === "inquiry" && c.relatedId === i.id, 5),
  ];
  return { kind, label: `問い合わせ ${i.number}`, href: `/inquiries/${i.id}`, head, facts: facts.filter(Boolean).join("\n") };
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

export interface SummaryResult {
  ok: boolean;
  text: string;
  provider: "claude" | "openai" | "rules";
  message?: string;
}

/** AI で要約する (キーがない・失敗したときは自動まとめ) */
export async function summarizeFacts(f: RecordFacts): Promise<SummaryResult> {
  const rules = `${f.head.map((h) => `・${h}`).join("\n")}`;
  if (!aiEnabled()) return { ok: true, text: rules, provider: "rules" };
  try {
    const r = await generateText({
      system: [
        "あなたは株式会社一畳屋 (畳・襖・障子・網戸の専門店) の社内向けアシスタントです。",
        `次の${SUMMARY_KIND_LABEL[f.kind]}の記録を、社員が 30 秒で把握できるように日本語でまとめてください。`,
        "形式: 【概要】(1〜2 文)、【要点】(「・」の箇条書き 3〜6 行)、【次に必要な対応】(「・」の箇条書き 1〜3 行。なければ「特になし」)。Markdown の記号 (#・**) は使わないでください (画面ではそのまま文字で表示されます)。",
        "記録にない事実は書かないでください。金額・日付は記録のとおりに書いてください。",
      ].join("\n"),
      messages: [{ role: "user", content: f.facts.slice(0, 12000) }],
      maxTokens: 1200,
    });
    return { ok: true, text: plainText(r.data) || rules, provider: r.provider };
  } catch (err) {
    const message = err instanceof AiError ? err.message : (err as Error).message;
    return { ok: true, text: rules, provider: "rules", message: `AI で要約できなかったため、記録から自動でまとめました (${message})` };
  }
}
