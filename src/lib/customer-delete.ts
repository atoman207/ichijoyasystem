import type { Approval, Customer, Database } from "@/lib/db/types";
import { TABLES } from "@/lib/db/schema";

/**
 * 顧客の削除 (二重登録・誤って登録したお客様。お客様のご要望 2026-11-27)
 * ------------------------------------------------------------
 * - 売上が紐付いているお客様は削除できない: 施工完了・請求済・入金済の受注 (売上計上日のある受注)・移行した売上台帳の受注・
 *   発行済みの請求書 (無効にしたものを除く)・発行済みの領収書。承認待ちの重要情報の変更があるときも削除しない
 * - 記録 (問い合わせ・見積・売上の前の受注・予定・資料・やりとりなど) が 1 件もなければ、そのまま削除する
 * - 記録があるときは「残すほうのお客様」(統合先) を選び、すべての記録を統合先に移してから削除する (二重登録の片方を消す)。
 *   削除するお客様の電話番号 (統合先にない番号) は統合先の「ほかの電話番号」に、タグ・メモも統合先に足す (お名前・住所などは変えない)
 * - 店長・本部・管理者は承認なし、店舗スタッフは所属店舗の店長の承認 (承認の type = customer_delete。permissions.ts)
 * - 削除したお客様の画面のリンク (通知・チャットなど) は、統合先のお客様の画面へ移る (deletedCustomerOf)。
 *   削除の前の登録内容は変更履歴 (action = delete) に残す
 * import は型と schema.ts (表の日本語名) だけ (サーバー・テストで共通。画面の部品からは import しない = schema.ts を画面に載せない)
 */

/** 売上に数える受注の状態 (施工完了 = 売上計上) */
const SALES_STATUS = new Set(["completed", "invoiced", "paid"]);

/** 記録の数を数えない表 (顧客そのもの・変更履歴・承認 (承認待ちは別に確かめる)・設定) */
const SKIP = new Set(["customers", "auditLogs", "approvals", "settings"]);
/** 削除するときに一緒に消す・外す記録 (お客様の住所の場所の結び付け・お客様あての変更のお知らせ) */
const MINOR = new Set(["mapLocationRefs", "changeNotices"]);

/** 表の名前 (画面の言葉。なければ schema.ts の日本語名) */
const LABEL: Record<string, string> = {
  inquiries: "問い合わせ",
  quotes: "見積",
  orders: "受注 (売上の前・キャンセル)",
  schedule: "予定",
  attachments: "資料・写真",
  commLogs: "やりとりの記録",
  surveys: "アンケート",
  documents: "取込書類",
  threads: "社内連絡・業務依頼",
  docDrafts: "文書の下書き",
};
const tableLabel = (key: string) => LABEL[key] ?? TABLES.find((t) => t.collection === key)?.label ?? "そのほかの記録";

type Row = Record<string, unknown>;

/** この行がお客様 id を指しているか (customerId・種類と ID の組・文書の下書きの関係する記録) */
function refersTo(r: Row, id: string): boolean {
  if (r.customerId === id) return true;
  if (r.parentType === "customer" && r.parentId === id) return true;
  if (r.linkedType === "customer" && r.linkedId === id) return true;
  if (r.relatedType === "customer" && r.relatedId === id) return true;
  if (r.targetType === "customer" && r.targetId === id) return true;
  if (r.recordType === "customer" && r.recordId === id) return true;
  if (Array.isArray(r.refs) && (r.refs as Row[]).some((x) => x && x.type === "customer" && x.id === id)) return true;
  return false;
}

export interface CustomerRecordCount {
  key: string;
  label: string;
  count: number;
}

export interface CustomerDeletePlan {
  /** 削除できない理由 (売上・請求書・領収書・承認待ち)。空なら削除できる */
  blockers: string[];
  /** 統合先へ移す記録 (1 件以上なら統合先が必要) */
  records: CustomerRecordCount[];
  /** 移す記録の合計 */
  total: number;
}

const list = (xs: string[], max = 5) => (xs.length > max ? `${xs.slice(0, max).join("・")} ほか ${xs.length - max} 件` : xs.join("・"));

/** 削除できるか・移す記録 (お客様の画面と削除の処理で共通) */
export function customerDeletePlan(db: Database, customerId: string): CustomerDeletePlan {
  const blockers: string[] = [];
  const sales = db.orders.filter((o) => o.customerId === customerId && o.status !== "cancelled" && (SALES_STATUS.has(o.status) || Boolean(o.salesDate) || o.source === "import"));
  if (sales.length) blockers.push(`売上が紐付いている受注があります (${list(sales.map((o) => o.number))})`);
  const invoices = db.invoices.filter((i) => i.customerId === customerId && i.status !== "void");
  if (invoices.length) blockers.push(`発行済みの請求書があります (${list(invoices.map((i) => i.number))})`);
  const receipts = (db.receipts ?? []).filter((r) => r.customerId === customerId && r.status !== "void");
  if (receipts.length) blockers.push(`発行済みの領収書があります (${list(receipts.map((r) => r.number))})`);
  if (db.approvals.some((a) => a.type === "customer_change" && a.targetId === customerId && a.status === "pending")) blockers.push("承認待ちの重要情報の変更があります (承認・差戻しのあとに削除してください)");
  const records: CustomerRecordCount[] = [];
  for (const [key, rows] of Object.entries(db)) {
    if (!Array.isArray(rows) || SKIP.has(key) || MINOR.has(key)) continue;
    let count = 0;
    for (const r of rows as unknown[]) if (r && typeof r === "object" && refersTo(r as Row, customerId)) count++;
    if (count) records.push({ key, label: tableLabel(key), count });
  }
  return { blockers, records, total: records.reduce((a, r) => a + r.count, 0) };
}

/** 承認待ちの削除の申請 */
export const pendingCustomerDelete = (db: Pick<Database, "approvals">, customerId: string): Approval | undefined =>
  db.approvals.find((a) => a.type === "customer_delete" && a.targetId === customerId && a.status === "pending");

/** 申請の統合先 (approval.changes の mergeInto) */
export function approvalMergeTarget(a: Pick<Approval, "changes">): string | undefined {
  const v = a.changes?.find((c) => c.field === "mergeInto")?.after;
  return typeof v === "string" && v ? v : undefined;
}

/** 統合先に選べないときの理由 */
export function mergeTargetBlocker(db: Database, from: Customer, to: Customer | undefined, targetId: string | undefined): string | undefined {
  if (!targetId) return undefined;
  if (!to) return "統合先のお客様が見つかりません (削除された可能性があります)。もう一度選んでください。";
  if (to.id === from.id) return "統合先には削除するお客様と別のお客様を選んでください。";
  if (pendingCustomerDelete(db, to.id)) return `統合先の ${to.code} ${to.name} 様には削除の申請が出ています。別のお客様を選ぶか、申請を却下してから統合してください。`;
  return undefined;
}

/** 削除・統合ができないときの理由 (できるなら undefined) */
export function customerDeleteBlocker(db: Database, from: Customer, to: Customer | undefined, targetId: string | undefined): string | undefined {
  const plan = customerDeletePlan(db, from.id);
  if (plan.blockers.length) return `${from.code} ${from.name} 様は削除できません: ${plan.blockers.join("。")}。`;
  const t = mergeTargetBlocker(db, from, to, targetId);
  if (t) return t;
  if (plan.total && !targetId) return `${from.code} ${from.name} 様には記録 (${plan.records.map((r) => `${r.label} ${r.count} 件`).join("・")}) があります。記録を移す「残すほうのお客様」を選んでください。`;
  return undefined;
}

const digits = (s: string | undefined) => (s ?? "").replace(/\D/g, "");

export interface CustomerDeleteResult {
  /** 統合先に移した記録 */
  moved: CustomerRecordCount[];
  movedTotal: number;
  /** 統合先の「ほかの電話番号」に足した番号 */
  phones: string[];
  /** 統合先に足したタグ */
  tags: string[];
  /** 統合先のメモに足したか */
  notes: boolean;
  /** 取り下げにした申請 (このお客様の閲覧・削除の申請) */
  cancelled: number;
}

/**
 * 削除する (mutate の中で呼ぶ。確かめは customerDeleteBlocker で先に)。to があれば記録をすべて to に移してから削除する。
 * 変更履歴は呼び出し側で残す (削除の前の登録内容は result と一緒に呼び出し側が残す)
 */
export function applyCustomerDelete(db: Database, from: Customer, to: Customer | undefined, opts: { at: string; newId: (prefix: string) => string; decidedBy: string }): CustomerDeleteResult {
  const moved: CustomerRecordCount[] = [];
  const id = from.id;
  for (const [key, rows] of Object.entries(db)) {
    if (!Array.isArray(rows) || SKIP.has(key)) continue;
    if (key === "mapLocationRefs") {
      // お客様の住所の場所の結び付け (ID は mlr_customer_<顧客>) は消す (統合先は統合先の住所で決まる)
      (db as unknown as Record<string, unknown[]>)[key] = (rows as Row[]).filter((r) => !(r && r.recordType === "customer" && r.recordId === id));
      continue;
    }
    if (key === "changeNotices" && !to) {
      (db as unknown as Record<string, unknown[]>)[key] = (rows as Row[]).filter((r) => !(r && refersTo(r, id)));
      continue;
    }
    if (!to) continue;
    let count = 0;
    for (const raw of rows as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Row;
      if (!refersTo(r, id)) continue;
      if (r.customerId === id) r.customerId = to.id;
      if (r.parentType === "customer" && r.parentId === id) r.parentId = to.id;
      if (r.linkedType === "customer" && r.linkedId === id) r.linkedId = to.id;
      if (r.relatedType === "customer" && r.relatedId === id) r.relatedId = to.id;
      if (r.targetType === "customer" && r.targetId === id) r.targetId = to.id;
      if (typeof r.href === "string" && r.href.startsWith(`/customers/${id}`)) r.href = `/customers/${to.id}${r.href.slice(`/customers/${id}`.length)}`;
      if (Array.isArray(r.refs)) {
        r.refs = (r.refs as Row[]).map((x) => (x && x.type === "customer" && x.id === id ? { ...x, id: to.id, href: `/customers/${to.id}`, label: `顧客 ${to.code} ${to.name}` } : x));
      }
      if ("updatedAt" in r) r.updatedAt = opts.at;
      count++;
    }
    if (count && !MINOR.has(key)) moved.push({ key, label: tableLabel(key), count });
  }
  // このお客様の閲覧の申請・削除の申請 (承認待ち) は取り下げにする
  let cancelled = 0;
  for (const a of db.approvals) {
    if (a.status !== "pending" || a.targetId !== id || (a.type !== "record_view" && a.type !== "customer_delete")) continue;
    a.status = "cancelled";
    a.decidedBy = opts.decidedBy;
    a.decidedAt = opts.at;
    a.decisionComment = to ? `お客様を ${to.code} ${to.name} 様に統合して削除したため` : "お客様を削除したため";
    cancelled++;
  }
  const phones: string[] = [];
  const tags: string[] = [];
  let notes = false;
  if (to) {
    // 電話番号 (統合先にない番号だけ)・タグ・メモを統合先に足す。お名前・住所・メールなどの重要情報は変えない
    const has = (p: string) => {
      const d = digits(p);
      return d.length > 0 && (digits(to.phone) === d || (to.contacts ?? []).some((c) => digits(c.phone) === d));
    };
    const add = (p: string | undefined, relation: string) => {
      const d = digits(p);
      if (d.length < 9 || has(p!) || (to.contacts ?? []).length >= 30) return;
      to.contacts = [...(to.contacts ?? []), { id: opts.newId("cc"), relation, phone: p!.trim(), note: `${from.code} ${from.name} 様 (統合して削除) の電話番号` }];
      phones.push(p!.trim());
    };
    add(from.phone, "統合した顧客の電話");
    for (const c of from.contacts ?? []) add(c.phone, c.relation || "統合した顧客の電話");
    for (const t of from.tags ?? []) if (t && t !== "予定表から登録" && !to.tags.includes(t)) tags.push(t);
    if (tags.length) to.tags = [...to.tags, ...tags];
    const memo = (from.notes ?? "").trim();
    if (memo && !(to.notes ?? "").includes(memo)) {
      to.notes = `${(to.notes ?? "").trim()}${to.notes?.trim() ? "\n" : ""}[${from.code} ${from.name} 様から統合] ${memo}`.slice(0, 4000);
      notes = true;
    }
    to.updatedAt = opts.at;
  }
  db.customers = db.customers.filter((c) => c.id !== id);
  return { moved, movedTotal: moved.reduce((a, r) => a + r.count, 0), phones, tags, notes, cancelled };
}

/** 変更履歴に残す削除の前の登録内容 (復元の手がかり) */
export function customerSnapshot(c: Customer): Record<string, unknown> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
}

/** 削除したお客様の記録 (変更履歴から。統合先があれば統合先の ID) */
export function deletedCustomerOf(db: Pick<Database, "auditLogs">, customerId: string): { at: string; userId: string; label: string; mergedInto?: string } | undefined {
  for (let i = db.auditLogs.length - 1; i >= 0; i--) {
    const l = db.auditLogs[i];
    if (l.entity !== "customer" || l.entityId !== customerId || l.action !== "delete") continue;
    const m = l.changes?.find((c) => c.field === "mergeInto")?.after;
    return { at: l.at, userId: l.userId, label: l.entityLabel, mergedInto: typeof m === "string" && m ? m : undefined };
  }
  return undefined;
}
