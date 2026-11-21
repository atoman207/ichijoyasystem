import "server-only";
import type { AuditChange, Database, DocDraft, DocDraftAction, DocDraftChannel, DocDraftEvent, DocDraftFormat, DocDraftRef, DocDraftRefType, DocDraftStatus, StoreId, User } from "@/lib/db/types";
import type { Tone } from "@/lib/constants";
import { newId, nextNumber, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { canApproveDocDraft, canDiscardDocDraft, canEditDocDraft, canReturnDocDraft, canReviewDocDraft, canSendDocDraft, canViewDocDraft, isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { isEmail, isLineTarget } from "@/lib/notify/channels";

/**
 * 文書の下書きの管理 (AI アシスタント →「文書の作成」で作った文面)
 * ------------------------------------------------------------
 * - 保存: 作った文面を版 1 として保存する (関係する記録・作成者・日時)。人が直すたびに版が増える (新しい 50 版を残す)
 * - 進み方: 下書き → 確認済み (内容を確認した) → 承認済み (店長・本部・管理者。作成者は自分の文書を承認できない。管理者は省略できる) → 送信済み
 *   確認済み・承認済みの文書を直すと下書きに戻る (承認した文面 = 送った文面)。差し戻し (理由つき) で下書きへ。送信前は破棄できる
 * - 送信: 承認済みの文書だけを、メール・LINE・Chatwork (src/lib/notify/send.ts) で送る。送れたときだけ送信済みにする
 *   (失敗・送信の設定がないときは承認済みのまま)。郵送・手渡しで渡したときは「記録のみ」で送信済みにする
 * - 権限は permissions.ts の canViewDocDraft ほか。ここの関数は権限を確かめてから記録を変え、断るときは DocDraftError
 * 画面の操作は src/lib/actions/doc-drafts.ts、画面は /ai/drafts
 */

export const DOC_DRAFT_STATUS: Record<DocDraftStatus, { label: string; tone: Tone; hint: string }> = {
  draft: { label: "下書き", tone: "neutral", hint: "文面を直し、よければ「内容を確認した」を押してください" },
  reviewed: { label: "確認済み (承認待ち)", tone: "warn", hint: "店長・本部・管理者の承認を待っています" },
  approved: { label: "承認済み (送信待ち)", tone: "info", hint: "承認された文面です。送信するか、郵送・手渡しで渡したら記録してください" },
  sent: { label: "送信済み", tone: "good", hint: "送った文書です。直すときは複製して新しい下書きにしてください" },
  discarded: { label: "破棄", tone: "critical", hint: "破棄した文書です。必要なら下書きに戻せます" },
};

export const DOC_DRAFT_ACTION_LABEL: Record<DocDraftAction, string> = {
  create: "作成",
  edit: "文面を修正",
  review: "内容を確認",
  approve: "承認",
  return: "差し戻し",
  discard: "破棄",
  restore: "下書きに戻す",
  send: "送信",
  send_failed: "送信に失敗",
  send_skipped: "送信の設定がないため送れず",
  record_manual: "郵送・手渡しの記録",
  copy: "複製して作成",
};

export const DOC_DRAFT_CHANNEL_LABEL: Record<DocDraftChannel, string> = {
  email: "メール",
  line: "LINE",
  chatwork: "Chatwork",
  manual_mail: "郵送 (記録のみ)",
  manual_hand: "手渡し・対面 (記録のみ)",
};

export const DOC_DRAFT_FORMAT_LABEL: Record<DocDraftFormat, string> = { email: "メール", line: "LINE (短め)", document: "文書・報告書" };

export const DOC_DRAFT_REF_LABEL: Record<DocDraftRefType, string> = { quote: "見積", order: "受注", inquiry: "問い合わせ", invoice: "請求", customer: "顧客" };

export const DOC_DRAFT_MAX_VERSIONS = 50;
export const DOC_DRAFT_MAX_BODY = 20000;
const MAX_SUBJECT = 200;

export class DocDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocDraftError";
  }
}

const clean = (s: string | undefined, max: number) => (s ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);

/** メールの下書きの 1 行目「件名: …」を件名に分ける (AI はメールの形式のとき 1 行目に件名を書く) */
export function splitSubject(format: DocDraftFormat, text: string): { subject?: string; body: string } {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (format !== "email") return { body: t };
  const m = /^件名\s*[:：]\s*(.+)\n+/.exec(t);
  if (!m) return { body: t };
  return { subject: m[1].trim().slice(0, MAX_SUBJECT), body: t.slice(m[0].length).trim() };
}

/* ================================================================== */
/* 関係する記録                                                          */
/* ================================================================== */

const HREF_TYPE: Record<string, DocDraftRefType> = { quotes: "quote", orders: "order", inquiries: "inquiry", invoices: "invoice", customers: "customer" };

/** 画面のパス (/orders/<ID> など) から記録の種類と ID */
export function refFromHref(label: string, href: string): DocDraftRef | undefined {
  const m = /^\/(quotes|orders|inquiries|invoices|customers)\/([^/?#]+)/.exec(href);
  return m ? { type: HREF_TYPE[m[1]], id: decodeURIComponent(m[2]), label: label.slice(0, 80), href } : undefined;
}

interface RecordInfo {
  storeId?: StoreId;
  customerId?: string;
  label: string;
}

function recordInfo(db: Database, r: Pick<DocDraftRef, "type" | "id">): RecordInfo | undefined {
  switch (r.type) {
    case "quote": {
      const q = db.quotes.find((x) => x.id === r.id);
      return q && { storeId: q.storeId, customerId: q.customerId, label: `見積 ${q.number}` };
    }
    case "order": {
      const o = db.orders.find((x) => x.id === r.id);
      return o && { storeId: o.storeId, customerId: o.customerId, label: `受注 ${o.number}` };
    }
    case "inquiry": {
      const i = db.inquiries.find((x) => x.id === r.id);
      return i && { storeId: i.storeId, customerId: i.customerId, label: `問い合わせ ${i.number}` };
    }
    case "invoice": {
      const v = db.invoices.find((x) => x.id === r.id);
      return v && { storeId: v.storeId, customerId: v.customerId, label: `請求 ${v.number}` };
    }
    case "customer": {
      const c = db.customers.find((x) => x.id === r.id);
      return c && { storeId: c.storeId, customerId: c.id, label: `${c.name} 様` };
    }
  }
}

/**
 * 作成のときの関係する記録: 文書を作るときに参照した記録と、そのお客様 (見積・受注・問い合わせ・請求のとき)。
 * 文書の店舗は参照した記録の店舗 (なければ作成者の店舗)
 */
export function draftRefs(db: Database, user: User, used?: { label: string; href: string }): { refs: DocDraftRef[]; storeId: StoreId } {
  const main = used ? refFromHref(used.label, used.href) : undefined;
  const info = main ? recordInfo(db, main) : undefined;
  if (!main || !info) return { refs: [], storeId: user.storeId };
  const refs: DocDraftRef[] = [main];
  if (main.type !== "customer" && info.customerId) {
    const c = db.customers.find((x) => x.id === info.customerId);
    if (c) refs.push({ type: "customer", id: c.id, label: `${c.name} 様`, href: `/customers/${c.id}` });
  }
  return { refs, storeId: info.storeId ?? user.storeId };
}

/** 文書のお客様 (関係する記録から) */
export function draftCustomer(db: Database, d: Pick<DocDraft, "refs">) {
  for (const r of d.refs) {
    const info = recordInfo(db, r);
    if (info?.customerId) {
      const c = db.customers.find((x) => x.id === info.customerId);
      if (c) return c;
    }
  }
  return undefined;
}

/** やりとり履歴・送信履歴にひも付ける記録 (顧客以外の最初の記録) */
export function draftCase(d: Pick<DocDraft, "refs">): DocDraftRef | undefined {
  return d.refs.find((r) => r.type !== "customer");
}

/** 送信方法ごとの既定の宛先 (お客様のメール・LINE。Chatwork は社内通知のルーム) */
export function defaultRecipients(db: Database, d: Pick<DocDraft, "refs">): Partial<Record<"email" | "line" | "chatwork", { to: string; label: string }>> {
  const c = draftCustomer(db, d);
  const out: Partial<Record<"email" | "line" | "chatwork", { to: string; label: string }>> = { chatwork: { to: "", label: "社内通知のルーム" } };
  if (c && isEmail(c.email)) out.email = { to: c.email.trim(), label: `${c.name} 様` };
  if (c?.lineId && isLineTarget(c.lineId)) out.line = { to: c.lineId, label: `${c.name} 様` };
  return out;
}

/* ================================================================== */
/* 作成・修正・状態の変更                                                  */
/* ================================================================== */

export interface NewDocDraft {
  template: string;
  templateLabel: string;
  format: DocDraftFormat;
  audience: "customer" | "internal";
  subject?: string;
  body: string;
  provider: DocDraft["provider"];
  notes?: string;
  refs: DocDraftRef[];
  storeId: StoreId;
  source?: "ai" | "copy";
  copiedFrom?: string;
}

function event(d: DocDraft, by: string, action: DocDraftAction, at: string, extra: Partial<DocDraftEvent> = {}) {
  d.events.push({ at, by, action, version: d.version, ...extra });
  if (d.events.length > 200) d.events.splice(0, d.events.length - 200);
}

/** 新しい下書き (版 1) を作って db に足す */
export function createDocDraft(db: Database, user: User, input: NewDocDraft, now = nowIso()): DocDraft {
  const body = clean(input.body, DOC_DRAFT_MAX_BODY);
  if (!body) throw new DocDraftError("文面が空です。");
  const subject = clean(input.subject, MAX_SUBJECT) || undefined;
  const main = input.refs[0];
  const d: DocDraft = {
    id: newId("dd"),
    number: nextNumber(db, "DOC", db.docDrafts, toDateKey(new Date(now))),
    title: `${input.templateLabel}${main ? ` (${main.label})` : ""}`.slice(0, 120),
    template: input.template,
    format: input.format,
    audience: input.audience,
    subject,
    body,
    status: "draft",
    storeId: input.storeId,
    refs: input.refs.slice(0, 5),
    provider: input.provider,
    notes: clean(input.notes, 3000) || undefined,
    version: 1,
    versions: [{ v: 1, at: now, by: user.id, subject, body, source: input.source ?? "ai" }],
    events: [],
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
    deliveryIds: [],
    copiedFrom: input.copiedFrom,
  };
  event(d, user.id, input.source === "copy" ? "copy" : "create", now, { to: "draft" });
  db.docDrafts.push(d);
  return d;
}

/** 送った・破棄した文書を複製して新しい下書きにする */
export function copyDocDraft(db: Database, user: User, src: DocDraft, now = nowIso()): DocDraft {
  if (!canViewDocDraft(user, src)) throw new DocDraftError("この文書を見る権限がありません。");
  const label = src.title.replace(/\s*\(.*\)$/, "");
  return createDocDraft(db, user, { template: src.template, templateLabel: label, format: src.format, audience: src.audience, subject: src.subject, body: src.body, provider: src.provider, notes: src.notes, refs: src.refs, storeId: src.storeId, source: "copy", copiedFrom: src.id }, now);
}

/**
 * 文面 (件名・本文) を直す。変わったときだけ版を増やす。確認済み・承認済みは下書きに戻る (確認・承認のやり直し)。
 * 戻り値の changes は変更履歴に残す変更 (本文は長いので文字数だけ)
 */
export function editDocDraft(d: DocDraft, user: User, input: { subject?: string; body: string; note?: string }, now = nowIso()): { changed: boolean; reset: boolean; changes: AuditChange[] } {
  if (!canEditDocDraft(user, d)) throw new DocDraftError(d.status === "sent" ? "送信済みの文書は直せません。複製して新しい下書きにしてください。" : d.status === "discarded" ? "破棄した文書です。下書きに戻してから直してください。" : "この文書を直す権限がありません (作成者と、店長・本部・管理者が直せます)。");
  const body = clean(input.body, DOC_DRAFT_MAX_BODY);
  if (!body) throw new DocDraftError("本文を入力してください。");
  const subject = clean(input.subject, MAX_SUBJECT) || undefined;
  if (body === d.body && (subject ?? "") === (d.subject ?? "")) return { changed: false, reset: false, changes: [] };
  const changes: AuditChange[] = [];
  if ((subject ?? "") !== (d.subject ?? "")) changes.push({ field: "subject", before: d.subject ?? "", after: subject ?? "" });
  if (body !== d.body) changes.push({ field: "body", before: `${d.body.length} 文字 (第 ${d.version} 版)`, after: `${body.length} 文字 (第 ${d.version + 1} 版)` });
  const from = d.status;
  const reset = from === "reviewed" || from === "approved";
  d.version += 1;
  d.subject = subject;
  d.body = body;
  d.versions.push({ v: d.version, at: now, by: user.id, subject, body, note: clean(input.note, 300) || undefined, source: "edit" });
  if (d.versions.length > DOC_DRAFT_MAX_VERSIONS) d.versions.splice(0, d.versions.length - DOC_DRAFT_MAX_VERSIONS);
  if (reset) {
    d.status = "draft";
    d.reviewedBy = d.reviewedAt = d.approvedBy = d.approvedAt = undefined;
    changes.push({ field: "status", before: DOC_DRAFT_STATUS[from].label, after: DOC_DRAFT_STATUS.draft.label });
  }
  d.updatedBy = user.id;
  d.updatedAt = now;
  event(d, user.id, "edit", now, { from, to: d.status, comment: clean(input.note, 300) || undefined });
  return { changed: true, reset, changes };
}

export type DocDraftTransition = "review" | "approve" | "return" | "discard" | "restore";

const TRANSITION: Record<DocDraftTransition, { to: DocDraftStatus; can: (u: User, d: DocDraft) => boolean; denied: (d: DocDraft) => string }> = {
  review: { to: "reviewed", can: canReviewDocDraft, denied: (d) => (d.status === "draft" ? "この文書を確認する権限がありません。" : `「${DOC_DRAFT_STATUS[d.status].label}」の文書は確認済みにできません。`) },
  approve: {
    to: "approved",
    can: canApproveDocDraft,
    denied: (d) => (d.status !== "reviewed" ? "承認できるのは「確認済み」の文書です。先に「内容を確認した」を押してください。" : "この文書を承認する権限がありません (その店舗の店長・本部スタッフ・管理者が承認します。自分が作った文書は承認できません)。"),
  },
  return: { to: "draft", can: canReturnDocDraft, denied: (d) => (d.status === "reviewed" || d.status === "approved" ? "この文書を差し戻す権限がありません。" : "差し戻せるのは確認済み・承認済みの文書です。") },
  discard: { to: "discarded", can: (u, d) => d.status !== "discarded" && canDiscardDocDraft(u, d), denied: (d) => (d.status === "sent" ? "送信済みの文書は破棄できません。" : d.status === "discarded" ? "すでに破棄されています。" : "この文書を破棄する権限がありません。") },
  restore: { to: "draft", can: (u, d) => d.status === "discarded" && canDiscardDocDraft(u, d), denied: (d) => (d.status !== "discarded" ? "下書きに戻せるのは破棄した文書です。" : "この文書を戻す権限がありません。") },
};

/** 状態を変える (確認・承認・差し戻し・破棄・戻す)。差し戻しは理由が必要 */
export function transitionDocDraft(d: DocDraft, user: User, action: DocDraftTransition, comment?: string, now = nowIso()): { from: DocDraftStatus; to: DocDraftStatus } {
  const t = TRANSITION[action];
  if (!t.can(user, d)) throw new DocDraftError(t.denied(d));
  const note = clean(comment, 500) || undefined;
  if (action === "return" && !note) throw new DocDraftError("差し戻しの理由を入力してください (作成者に伝わります)。");
  const from = d.status;
  d.status = t.to;
  if (action === "review") Object.assign(d, { reviewedBy: user.id, reviewedAt: now });
  if (action === "approve") Object.assign(d, { approvedBy: user.id, approvedAt: now });
  if (action === "return" || action === "restore") Object.assign(d, { reviewedBy: undefined, reviewedAt: undefined, approvedBy: undefined, approvedAt: undefined });
  d.updatedBy = user.id;
  d.updatedAt = now;
  event(d, user.id, action, now, { from, to: t.to, comment: note });
  return { from, to: t.to };
}

/** 送信できるか (承認済み・権限)。できなければ DocDraftError */
export function assertSendable(d: DocDraft, user: User): void {
  if (d.status !== "approved") throw new DocDraftError(d.status === "sent" ? "この文書は送信済みです。" : "送信できるのは承認済みの文書です (下書き → 内容を確認した → 承認 の順に進めてください)。");
  if (!canSendDocDraft(user, d)) throw new DocDraftError("この文書を送信する権限がありません (作成者と、店長・本部・管理者が送信します)。");
  if (!d.body.trim()) throw new DocDraftError("本文が空です。");
}

/** 送信した (または郵送・手渡しで渡した) ことを記録して送信済みにする */
export function markDocDraftSent(d: DocDraft, user: User, p: { channel: DocDraftChannel; recipient?: string; recipientLabel?: string; deliveryId?: string; commLogId?: string; comment?: string }, now = nowIso()): void {
  assertSendable(d, user);
  const from = d.status;
  Object.assign(d, { status: "sent", sentBy: user.id, sentAt: now, channel: p.channel, recipient: p.recipient?.slice(0, 200) || undefined, recipientLabel: p.recipientLabel?.slice(0, 100) || undefined, commLogId: p.commLogId ?? d.commLogId, updatedBy: user.id, updatedAt: now });
  if (p.deliveryId) d.deliveryIds = [...(d.deliveryIds ?? []), p.deliveryId];
  event(d, user.id, p.channel.startsWith("manual") ? "record_manual" : "send", now, { from, to: "sent", comment: clean(p.comment, 300) || `${DOC_DRAFT_CHANNEL_LABEL[p.channel]}${p.recipientLabel || p.recipient ? ` → ${p.recipientLabel || p.recipient}` : ""}` });
}

/** 送れなかったこと (失敗・設定なし) を記録する。状態は承認済みのまま */
export function noteSendProblem(d: DocDraft, user: User, kind: "send_failed" | "send_skipped", p: { deliveryId?: string; comment: string }, now = nowIso()): void {
  if (p.deliveryId) d.deliveryIds = [...(d.deliveryIds ?? []), p.deliveryId];
  d.updatedAt = now;
  event(d, user.id, kind, now, { comment: clean(p.comment, 300) });
}

/* ================================================================== */
/* 一覧・知らせ                                                         */
/* ================================================================== */

/** 最後の出来事 (差し戻しの理由などを一覧に出す) */
export const lastEvent = (d: Pick<DocDraft, "events">): DocDraftEvent | undefined => d.events[d.events.length - 1];

/** 差し戻されて直していない (作成者に知らせる) */
export const isReturned = (d: DocDraft) => d.status === "draft" && lastEvent(d)?.action === "return";

/** 画面のヘッダーの知らせ: 承認を待っている文書 (承認できる人)・差し戻された自分の文書・承認されて送っていない自分の文書 */
export function docDraftAttention(db: Pick<Database, "docDrafts">, user: User): { toApprove: DocDraft[]; returned: DocDraft[]; toSend: DocDraft[] } {
  const list = db.docDrafts ?? [];
  return {
    toApprove: list.filter((d) => d.status === "reviewed" && canApproveDocDraft(user, d)),
    returned: list.filter((d) => d.createdBy === user.id && isReturned(d)),
    toSend: list.filter((d) => d.createdBy === user.id && d.status === "approved"),
  };
}

/** 承認を頼む相手: その店舗の店長 (作成者を除く)。いなければ (合志店・本部の文書など) 本部スタッフと管理者 */
export function docDraftApprovers(db: Database, d: Pick<DocDraft, "storeId" | "createdBy">): User[] {
  const creator = db.users.find((u) => u.id === d.createdBy);
  const demo = creator ? isDemoAccount(creator) : false;
  const ok = (u: User) => u.active && u.id !== d.createdBy && !isReviewAccount(u) && isDemoAccount(u) === demo;
  const managers = db.users.filter((u) => ok(u) && u.role === "store_manager" && u.storeId === d.storeId);
  return managers.length ? managers : db.users.filter((u) => ok(u) && (u.role === "admin" || u.role === "hq_staff"));
}

/* ================================================================== */
/* 版の比べ方 (行ごと)                                                    */
/* ================================================================== */

export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
}

/** 2 つの文面の行ごとの違い (最長共通部分列)。行が多すぎるときは前後の同じ行だけを除いて比べる */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: "same", text }));
  if (am.length * bm.length > 400_000) {
    out.push(...am.map((text) => ({ op: "del" as const, text })), ...bm.map((text) => ({ op: "add" as const, text })));
  } else {
    const n = am.length;
    const m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ op: "same", text: am[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) {
        // 消えた行を先に、増えた行を後に出す
        out.push({ op: "del", text: am[i++] });
      } else {
        out.push({ op: "add", text: bm[j++] });
      }
    }
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ op: "same" as const, text })));
  return out;
}
