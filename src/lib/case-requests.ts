import type { CaseRequestKind, Database, ScheduleEvent, StoreId, Thread, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { caseChainOf, type CaseChain } from "@/lib/case-store";
import { periodLabel } from "@/lib/calendar";
import { SCHEDULE_KIND } from "@/lib/constants";
import { requestTargets } from "@/lib/inquiry-requests";
import { jstDate } from "@/lib/inquiry-flow";

/**
 * 案件への依頼 (メンション) (お客様のご要望 2026-11-25「⑪ 予定表からのメンション機能」)
 * ------------------------------------------------------------
 * 予定表で案件を開いたとき (と案件の画面) から、担当店舗 (店長・スタッフ全員) か担当者を選んで、種類 (日程変更依頼・仕様変更依頼・クレーム・手直し・その他) と
 * 内容を送る。業務依頼 (threads の kind = request。確認 → 報告 → 完了) として作り、受けた人にはヘッダーのベル (押すと案件の画面へ) と各自の通知の設定で知らせる。
 * どの案件か (案件番号・お客様・予定) を件名と本文に書き、送った内容・日時・送信者・送信先は案件の画面の「この案件への依頼」に残る (relatedId と案件の記録の ID で引く)
 */

export const CASE_REQUEST_KIND: Record<CaseRequestKind, { label: string; hint: string }> = {
  schedule_change: { label: "日程変更依頼", hint: "例: お客様のご都合で引取を 12/3 の午後に変えたいとのことです。調整をお願いします" },
  spec_change: { label: "仕様変更依頼", hint: "例: 畳表を「さくら」から「きずな」に変更したいとのご連絡がありました。見積の明細の変更をお願いします" },
  claim: { label: "クレーム・手直し", hint: "例: 納品した襖の引手がゆるいとのご連絡です。手直しの訪問をお願いします" },
  other: { label: "その他", hint: "依頼の内容を書いてください" },
};

export const CASE_REQUEST_KINDS = Object.keys(CASE_REQUEST_KIND) as CaseRequestKind[];

export const isCaseRequestKind = (v: unknown): v is CaseRequestKind => typeof v === "string" && Object.prototype.hasOwnProperty.call(CASE_REQUEST_KIND, v);

/** 案件の画面の印 (ベルから案件を直接開いたときに「この案件への依頼」を出す) */
export const CASE_REQUEST_ANCHOR = "case-requests";

const caseHref = (c: CaseChain) => (c.head.type === "order" ? `/orders/${c.head.id}` : c.head.type === "quote" ? `/quotes/${c.head.id}` : `/inquiries/${c.head.id}`);

/** 依頼のスレッドを開いたときの案件の画面 (#case-requests)。案件の依頼でなければ undefined */
export function caseRequestHref(db: Pick<Database, "orders" | "quotes" | "inquiries">, t: Pick<Thread, "caseRequest" | "relatedType" | "relatedId">): string | undefined {
  if (!t.caseRequest || !t.relatedId) return undefined;
  if (t.relatedType === "customer") return `/customers/${t.relatedId}`;
  const c = caseChainOf(db, t.relatedId);
  return c ? `${caseHref(c)}#${CASE_REQUEST_ANCHOR}` : undefined;
}

/** この案件への依頼 (問い合わせ・見積・受注のどれかの ID。新しい順) */
export function caseRequestsOf(db: Pick<Database, "threads" | "orders" | "quotes" | "inquiries">, ids: (string | undefined)[]): Thread[] {
  const set = new Set(ids.filter((x): x is string => Boolean(x)));
  // 問い合わせ → 見積 → 受注 のどの段階の ID からでも、案件のすべての記録の依頼を引く (依頼を送ったときの段階の ID で残っているため)
  for (const id of [...set]) {
    const c = caseChainOf(db, id);
    if (c) for (const x of [c.order?.id, c.quote?.id, c.inquiry?.id]) if (x) set.add(x);
  }
  if (!set.size) return [];
  return db.threads.filter((t) => t.caseRequest && t.relatedId && set.has(t.relatedId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface CaseRequestInput {
  actor: User;
  /** 案件 (なければお客様だけの予定) */
  chain?: CaseChain;
  customerId?: string;
  event?: ScheduleEvent;
  kind: CaseRequestKind;
  note: string;
  /** 宛先: 店舗 (店長・スタッフ全員) か、担当者 (複数) */
  storeId?: StoreId;
  assignees?: User[];
  dueAt?: string;
  urgent?: boolean;
}

/**
 * 依頼を作る (mutate の中で呼ぶ)。宛先の人にメンションし、業務依頼として「依頼中」にする。
 * 受注なら経過メモにも残す。作ったスレッドを返す (保存のあとに taskNotices で知らせる)
 */
export function createCaseRequest(db: Database, p: CaseRequestInput): Thread {
  const now = nowIso();
  const id = newId("th");
  const store = p.storeId ?? p.chain?.head.storeId ?? p.event?.storeId ?? p.actor.storeId;
  const targets = (p.assignees?.length ? p.assignees : requestTargets(db, store)).filter((u) => u.id !== p.actor.id);
  const kind = CASE_REQUEST_KIND[p.kind];
  const customerId = p.chain ? (p.chain.order?.customerId ?? p.chain.quote?.customerId ?? p.chain.inquiry?.customerId) : p.customerId;
  const customer = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
  const who = customer?.name ?? p.chain?.inquiry?.contactName ?? "";
  const number = p.chain?.head.number;
  const caseTitle = p.chain?.head.title ?? "";
  const label = [number, who ? `${who} 様` : ""].filter(Boolean).join(" ");
  const storeName = (sid: string) => db.stores.find((s) => s.id === sid)?.name ?? sid;
  const toText = p.assignees?.length ? targets.map((u) => u.name).join("・") : `${storeName(store)} (店舗の店長・スタッフ)`;
  const href = p.chain ? caseHref(p.chain) : customer ? `/customers/${customer.id}` : undefined;
  const site = p.chain?.order?.siteAddress || p.chain?.quote?.siteAddress || p.chain?.inquiry?.siteAddress || customer?.address;
  const body = [
    `【${kind.label}】${p.urgent ? " 至急" : ""}`,
    `案件: ${[label, caseTitle].filter(Boolean).join(" · ") || "(案件なし)"}`,
    site ? `場所: ${site}` : "",
    p.event ? `予定: ${periodLabel(p.event)} ${SCHEDULE_KIND[p.event.kind].label} (担当: ${p.event.assigneeIds.map((a) => db.users.find((u) => u.id === a)?.name ?? "-").join("・") || "未定"})` : "",
    `宛先: ${toText}`,
    "",
    p.note,
    "",
    href ? `案件を開く: ${href}` : "",
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .trim();
  const t: Thread = {
    id,
    title: `${p.urgent ? "【至急】" : ""}${kind.label}: ${[label, caseTitle].filter(Boolean).join(" ")}`.slice(0, 120),
    kind: "request",
    storeId: store,
    createdBy: p.actor.id,
    participants: [...new Set([p.actor.id, ...targets.map((u) => u.id)])],
    relatedType: p.chain ? p.chain.head.type : customer ? "customer" : undefined,
    relatedId: p.chain ? p.chain.head.id : customer?.id,
    relatedLabel: label || undefined,
    status: "open",
    createdAt: now,
    updatedAt: now,
    assigneeIds: targets.map((u) => u.id),
    ...(p.assignees?.length ? {} : { assigneeStoreId: store }),
    purpose: "other",
    ...(p.dueAt ? { dueAt: p.dueAt, dueDate: jstDate(new Date(p.dueAt)) } : {}),
    taskStatus: "requested",
    caseRequest: p.kind,
    ...(p.event ? { eventId: p.event.id } : {}),
  };
  db.threads.push(t);
  db.messages.push({ id: newId("msg"), threadId: id, userId: p.actor.id, body, at: now, mentions: targets.map((u) => u.id) });
  if (p.chain?.order) {
    p.chain.order.progressNotes.push({ id: newId("pn"), at: now, userId: p.actor.id, kind: "note", body: `${kind.label}を送信 (宛先: ${toText}): ${p.note.slice(0, 200)}` });
    p.chain.order.updatedAt = now;
  }
  addAudit(db, {
    userId: p.actor.id,
    action: "create",
    entity: "thread",
    entityId: id,
    entityLabel: t.title,
    summary: `${number ? `案件 ${number} への` : ""}${kind.label}を送信 (宛先: ${toText}${p.event ? ` / 予定 ${periodLabel(p.event)}` : ""})`,
    storeId: store,
  });
  return t;
}
