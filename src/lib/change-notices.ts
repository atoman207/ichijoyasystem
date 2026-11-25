import type { AuditChange, ChangeNotice, ChangeNoticeLine, Database, QuoteItem, ScheduleEvent, StoreId, User } from "@/lib/db/types";
import { newId, nowIso } from "@/lib/db/store";
import { isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { approvalSettings } from "@/lib/approval-rules";
import { caseChainOf } from "@/lib/case-store";
import { fieldLabel, fieldValue } from "@/lib/field-labels";

/**
 * 案件の変更のお知らせ (お客様のご要望 2026-11-25「⑥ 変更時の承認・通知・履歴」)
 * ------------------------------------------------------------
 * 予定の変更・削除、明細・仕様・金額の変更、作業の担当の変更、お客様の付け替え、施工店舗・現場の住所の変更などを、承認なしでその場で反映するかわりに、
 * 担当店舗 (案件の店舗) のメンバーに知らせる。当面は本部と管理者にも同じお知らせを届ける (設定 → 承認ルールの noticeHq。既定 = 届ける)。
 * お知らせには どの案件を・何をどのように (変更前 → 変更後)・いつ・誰が を持ち、案件ごとの変更の履歴として残す (caseIds で引く)。
 * 画面はヘッダーのベルと「変更のお知らせ」(/notices)、案件の画面の「この案件の変更の履歴」。mutate の中で addChangeNotice を呼ぶ
 */

export interface NoticeTarget {
  targetType: ChangeNotice["targetType"];
  targetId: string;
  caseIds: string[];
  number?: string;
  title: string;
  customerId?: string;
  storeId: StoreId;
  href: string;
}

const customerLabel = (db: Pick<Database, "customers">, id?: string) => {
  const c = id ? db.customers.find((x) => x.id === id) : undefined;
  return c ? `${c.name} 様` : "";
};

/** 案件 (問い合わせ・見積・受注のどれかの ID) のお知らせの宛先の情報 */
export function caseTarget(db: Database, id: string | undefined): NoticeTarget | undefined {
  const chain = caseChainOf(db, id);
  if (!chain) return undefined;
  const head = chain.head;
  const customerId = chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId;
  const who = customerLabel(db, customerId) || (chain.inquiry?.contactName ? `${chain.inquiry.contactName} 様` : "");
  const href = head.type === "order" ? `/orders/${head.id}` : head.type === "quote" ? `/quotes/${head.id}` : `/inquiries/${head.id}`;
  return {
    targetType: head.type,
    targetId: head.id,
    caseIds: [chain.order?.id, chain.quote?.id, chain.inquiry?.id].filter((x): x is string => Boolean(x)),
    number: head.number,
    title: [who, head.title].filter(Boolean).join(" · "),
    customerId,
    storeId: head.storeId,
    href,
  };
}

/** 予定のお知らせの宛先 (案件の予定は案件、案件のない予定はお客様・予定そのもの)。全社の予定・社内の予定はお知らせしない (undefined) */
export function eventTarget(db: Database, e: Pick<ScheduleEvent, "id" | "title" | "storeId" | "orderId" | "quoteId" | "inquiryId" | "customerId" | "companyWide">): NoticeTarget | undefined {
  if (e.companyWide) return undefined;
  const t = caseTarget(db, e.orderId ?? e.quoteId ?? e.inquiryId);
  if (t) return t;
  if (!e.customerId) return undefined;
  return { targetType: "schedule", targetId: e.id, caseIds: [], title: [customerLabel(db, e.customerId), e.title].filter(Boolean).join(" · "), customerId: e.customerId, storeId: e.storeId, href: `/schedule/${e.id}` };
}

/**
 * 知らせる人: 担当店舗の社員 (店長・スタッフ) + 設定により本部 (本部スタッフ・本部の店舗の社員) と管理者。変更した人・確認用アカウントを除き、
 * 変更した人と同じ種類 (社員 / デモ用) のアカウントだけ
 */
export function noticeRecipients(db: Pick<Database, "users" | "stores" | "settings">, storeId: StoreId, actorId: string): string[] {
  const actor = db.users.find((u) => u.id === actorId);
  const demo = actor ? isDemoAccount(actor) : false;
  const hqStores = new Set(db.stores.filter((s) => s.kind === "hq").map((s) => s.id));
  const withHq = approvalSettings(db).noticeHq;
  return db.users
    .filter((u) => u.active && u.id !== actorId && u.id !== "system" && !isReviewAccount(u) && isDemoAccount(u) === demo)
    .filter((u) => u.storeId === storeId || (withHq && (u.role === "admin" || u.role === "hq_staff" || hqStores.has(u.storeId))))
    .map((u) => u.id);
}

/** 変更履歴の変更 (AuditChange) → お知らせの行 (社員の ID は名前にする) */
export function noticeLines(db: Pick<Database, "users">, entity: string, changes: AuditChange[] | undefined): ChangeNoticeLine[] {
  const names = new Map(db.users.map((u) => [u.id, u.name]));
  return (changes ?? []).map((c) => ({ label: fieldLabel(entity, c.field), before: fieldValue(c.field, c.before, names), after: fieldValue(c.field, c.after, names) }));
}

/**
 * お知らせを残す (mutate の中で呼ぶ)。行がなければ何もしない。
 * 同じ人が同じ案件の同じ種類の変更を 2 分以内に続けたときは、まだ誰も読んでいなければ 1 件にまとめる (保存を続けて押したときに通知が並ばないように)
 */
export function addChangeNotice(db: Database, actorId: string, target: NoticeTarget | undefined, topic: string, lines: ChangeNoticeLine[], opts: { href?: string; at?: string; alsoStores?: StoreId[] } = {}): ChangeNotice | undefined {
  if (!target) return undefined;
  const clean = lines.filter((l) => l.label && (l.before ?? "") !== (l.after ?? ""));
  if (!clean.length) return undefined;
  db.changeNotices ??= [];
  const at = opts.at ?? nowIso();
  const recent = db.changeNotices[db.changeNotices.length - 1];
  if (recent && recent.actorId === actorId && recent.targetId === target.targetId && recent.topic === topic && !recent.readBy.length && Date.parse(at) - Date.parse(recent.at) < 120_000) {
    for (const l of clean) {
      const same = recent.lines.find((x) => x.label === l.label);
      if (same) same.after = l.after;
      else recent.lines.push(l);
    }
    recent.lines = recent.lines.filter((l) => (l.before ?? "") !== (l.after ?? ""));
    recent.at = at;
    return recent;
  }
  const n: ChangeNotice = {
    id: newId("cn"),
    at,
    actorId,
    storeId: target.storeId,
    targetType: target.targetType,
    targetId: target.targetId,
    caseIds: target.caseIds,
    number: target.number,
    title: target.title,
    customerId: target.customerId,
    topic,
    lines: clean.slice(0, 40).map((l) => ({ label: l.label.slice(0, 60), before: l.before?.slice(0, 300), after: l.after?.slice(0, 300) })),
    href: opts.href ?? target.href,
    recipients: [...new Set([...noticeRecipients(db, target.storeId, actorId), ...(opts.alsoStores ?? []).flatMap((sid) => noticeRecipients(db, sid, actorId))])],
    readBy: [],
  };
  db.changeNotices.push(n);
  return n;
}

/** 見られるお知らせ: 自分に届いたもの・自分が変更したもの。管理者はすべて */
export function canViewNotice(user: Pick<User, "id" | "role">, n: Pick<ChangeNotice, "recipients" | "actorId">): boolean {
  return user.role === "admin" || n.actorId === user.id || n.recipients.includes(user.id);
}

export function isUnread(user: Pick<User, "id">, n: Pick<ChangeNotice, "recipients" | "readBy">): boolean {
  return n.recipients.includes(user.id) && !n.readBy.includes(user.id);
}

/** 自分あての未読のお知らせ (新しい順) */
export function unreadNotices(db: Pick<Database, "changeNotices">, user: Pick<User, "id">): ChangeNotice[] {
  const out: ChangeNotice[] = [];
  const list = db.changeNotices ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (isUnread(user, list[i])) out.push(list[i]);
  return out;
}

/** 案件の変更の履歴 (問い合わせ・見積・受注のどれかの ID。新しい順) */
export function caseNotices(db: Pick<Database, "changeNotices">, ids: string[]): ChangeNotice[] {
  const set = new Set(ids.filter(Boolean));
  if (!set.size) return [];
  return (db.changeNotices ?? []).filter((n) => set.has(n.targetId) || n.caseIds.some((c) => set.has(c))).sort((a, b) => b.at.localeCompare(a.at));
}

/** 「11/25 14:03」 */
export function noticeTime(at: string): string {
  const d = new Date(new Date(at).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** お知らせの 1 行の文 (例: 引取日: 11/26 → 11/28) */
export function lineText(l: ChangeNoticeLine): string {
  if (!l.before || l.before === "(空)") return `${l.label}: ${l.after ?? ""}`;
  if (l.after === undefined || l.after === "(空)") return `${l.label}: ${l.before} → (なし)`;
  return `${l.label}: ${l.before} → ${l.after}`;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const itemText = (i: Pick<QuoteItem, "name" | "spec" | "qty" | "unit" | "unitPrice" | "amount">) => `${i.name}${i.spec ? ` (${i.spec})` : ""} ${i.qty}${i.unit} × ${yen(i.unitPrice)} = ${yen(i.amount)}`;

/**
 * 見積の明細の違い → お知らせの行 (追加・削除 (部分キャンセル)・数量・単価・仕様の変更)。
 * 品名と仕様で同じ行を探し、見つからなければ並びの順で比べる
 */
export function quoteItemLines(before: QuoteItem[], after: QuoteItem[]): ChangeNoticeLine[] {
  const out: ChangeNoticeLine[] = [];
  const left = [...before];
  const take = (a: QuoteItem): QuoteItem | undefined => {
    let k = left.findIndex((b) => b.id === a.id);
    if (k < 0) k = left.findIndex((b) => b.name === a.name && (b.spec ?? "") === (a.spec ?? ""));
    if (k < 0) k = left.findIndex((b) => b.name === a.name);
    return k >= 0 ? left.splice(k, 1)[0] : undefined;
  };
  for (const a of after) {
    const b = take(a);
    if (!b) {
      out.push({ label: `明細の追加: ${a.name}`, before: "(なし)", after: itemText(a) });
      continue;
    }
    if (b.qty !== a.qty || b.unitPrice !== a.unitPrice || (b.spec ?? "") !== (a.spec ?? "") || b.unit !== a.unit || b.name !== a.name) out.push({ label: `明細の変更: ${a.name}`, before: itemText(b), after: itemText(a) });
  }
  for (const b of left) out.push({ label: `明細の削除 (部分キャンセル): ${b.name}`, before: itemText(b), after: "(削除)" });
  return out;
}
