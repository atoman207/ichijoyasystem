import "server-only";
import type { Approval, Database, Message, Thread, User } from "@/lib/db/types";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, TASK_STATUS } from "@/lib/constants";
import { isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { fieldLabel, fieldValue } from "@/lib/field-labels";
import { isEmail } from "./channels";
import { appBaseUrl, chatworkConfig } from "./config";
import type { Outgoing } from "./send";

/**
 * 社内通知 (承認依頼・承認結果・メンション・業務依頼) の宛先と文面
 * ------------------------------------------------------------
 * - メール: 本人がプロフィール (または管理者が社員の設定) で「メールで通知を受け取る」にした社員だけ
 * - Chatwork: 社内通知のルーム (CHATWORK_ROOM_ID) へ 1 通。Chatwork のアカウント ID がある社員は [To] で宛てる
 * - どちらも 設定 → 外部連携・通知 で、通知の種類ごとに止められる (settings の id = "notify")
 * 画面のヘッダーの通知 (お知らせ) は従来どおり常に表示する
 */

export type NotifyEvent = "approval_request" | "approval_result" | "mention" | "task";

export const NOTIFY_EVENT_LABEL: Record<NotifyEvent, string> = {
  approval_request: "承認の依頼 (承認者へ)",
  approval_result: "承認・差戻し・却下の結果 (申請者へ)",
  mention: "社内連絡のメンション",
  task: "業務依頼 (依頼・確認・報告・完了)",
};

export interface NotifySettings {
  email: Record<NotifyEvent, boolean>;
  chatwork: Record<NotifyEvent, boolean>;
}

export const NOTIFY_SETTINGS_ID = "notify";
const EVENTS = Object.keys(NOTIFY_EVENT_LABEL) as NotifyEvent[];

export function notifySettings(db: Pick<Database, "settings">): NotifySettings {
  const v = (db.settings ?? []).find((s) => s.id === NOTIFY_SETTINGS_ID)?.value ?? {};
  const read = (x: unknown): Record<NotifyEvent, boolean> => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return Object.fromEntries(EVENTS.map((e) => [e, o[e] !== false])) as Record<NotifyEvent, boolean>;
  };
  return { email: read(v.email), chatwork: read(v.chatwork) };
}

/** 社員の通知用メールアドレス (受け取る設定のときだけ) */
export function notifyAddress(u: User): string | undefined {
  if (!u.active || !u.notifyByEmail || isDemoAccount({ email: u.notifyEmail || u.email })) return undefined;
  const addr = (u.notifyEmail || u.email).trim();
  return isEmail(addr) ? addr : undefined;
}

/** 承認できる人 (通知の宛先)。店長承認はその店舗の店長、管理者承認は管理者。申請者・確認用アカウントを除き、申請者と同じ種類 (社員 / デモ用) */
export function approversFor(db: Database, a: Approval): User[] {
  const requester = db.users.find((u) => u.id === a.requestedBy);
  const demo = requester ? isDemoAccount(requester) : false;
  return db.users.filter(
    (u) =>
      u.active &&
      u.id !== a.requestedBy &&
      !isReviewAccount(u) &&
      isDemoAccount(u) === demo &&
      (a.requiredRole === "admin" ? u.role === "admin" : u.role === "store_manager" && u.storeId === a.storeId),
  );
}

function build(db: Database, event: NotifyEvent, users: User[], subject: string, body: string, link: string, related: Pick<Outgoing, "relatedType" | "relatedId">): Outgoing[] {
  const s = notifySettings(db);
  const out: Outgoing[] = [];
  const url = `${appBaseUrl()}${link}`;
  if (s.email[event]) {
    for (const u of users) {
      const to = notifyAddress(u);
      if (to) out.push({ channel: "email", to, toLabel: u.name, subject: `[一畳屋 業務システム] ${subject}`, body: `${u.name} さん\n\n${body}\n\n画面で確認する: ${url}\n\n(このメールは業務システムから自動で送信しています)`, purpose: "notify", ...related });
    }
  }
  const cw = chatworkConfig();
  if (s.chatwork[event] && cw?.roomId && users.length) {
    const to = users.filter((u) => u.chatworkAccountId && /^\d+$/.test(u.chatworkAccountId)).map((u) => `[To:${u.chatworkAccountId}]${u.name}さん`).join("\n");
    out.push({ channel: "chatwork", to: "", toLabel: `社内通知 (${users.map((u) => u.name).join("・")})`, subject, body: `${to ? `${to}\n` : ""}${body}\n${url}`, purpose: "notify", ...related });
  }
  return out;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const nameOf = (db: Database, id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";

export function approvalRequestNotices(db: Database, a: Approval): Outgoing[] {
  const entity = a.type === "customer_change" ? "customer" : "order";
  const changes = a.changes?.length ? `\n変更: ${a.changes.map((c) => `${fieldLabel(entity, c.field)} ${fieldValue(c.field, c.before)} → ${fieldValue(c.field, c.after)}`).join(" / ")}` : "";
  return build(
    db,
    "approval_request",
    approversFor(db, a),
    `承認依頼: ${APPROVAL_TYPE_LABEL[a.type]} ${a.title}`,
    `${nameOf(db, a.requestedBy)} さんから承認の依頼があります。\n種類: ${APPROVAL_TYPE_LABEL[a.type]}\n件名: ${a.title}\n金額: ${yen(a.amount)}${a.requestComment ? `\n申請コメント: ${a.requestComment}` : ""}${changes}`,
    "/approvals?tab=mine",
    { relatedType: "approval", relatedId: a.id },
  );
}

export function approvalResultNotices(db: Database, a: Approval, href: string): Outgoing[] {
  const requester = db.users.filter((u) => u.id === a.requestedBy);
  const label = APPROVAL_STATUS[a.status].label;
  const next = a.status === "returned" ? "\n内容を修正して、もう一度申請してください。" : "";
  return build(
    db,
    "approval_result",
    requester,
    `${label}: ${APPROVAL_TYPE_LABEL[a.type]} ${a.title}`,
    `申請が「${label}」になりました (${nameOf(db, a.decidedBy)} さん)。\n件名: ${a.title}${a.decisionComment ? `\nコメント: ${a.decisionComment}` : ""}${next}`,
    href,
    { relatedType: "approval", relatedId: a.id },
  );
}

export function mentionNotices(db: Database, t: Thread, m: Message): Outgoing[] {
  const users = db.users.filter((u) => m.mentions.includes(u.id) && u.id !== m.userId);
  return build(db, "mention", users, `社内連絡: ${t.title}`, `${nameOf(db, m.userId)} さんからメンションがありました。\n\n${m.body.slice(0, 1000)}`, `/messages/${t.id}`, { relatedType: "thread", relatedId: t.id });
}

/** 業務依頼の通知: 依頼・差し戻しは担当者へ、確認・報告は依頼者へ、完了は担当者へ */
export function taskNotices(db: Database, t: Thread, actorId: string, what: "request" | "ack" | "report" | "confirm" | "reopen", note?: string): Outgoing[] {
  const assignees = db.users.filter((u) => (t.assigneeIds ?? []).includes(u.id) && u.id !== actorId);
  const requester = db.users.filter((u) => u.id === t.createdBy && u.id !== actorId);
  const to = what === "ack" || what === "report" ? requester : assignees;
  const head: Record<typeof what, string> = {
    request: "業務の依頼があります",
    ack: "依頼を確認しました (対応中)",
    report: "依頼の対応を報告しました",
    confirm: "報告を確認し、依頼を完了にしました",
    reopen: "報告を差し戻しました (対応を続けてください)",
  };
  const status = t.taskStatus ? TASK_STATUS[t.taskStatus].label : "";
  return build(
    db,
    "task",
    to,
    `業務依頼: ${t.title}`,
    `${nameOf(db, actorId)} さん: ${head[what]}${t.dueDate ? `\n期限: ${t.dueDate}` : ""}${status ? `\n状態: ${status}` : ""}${note ? `\n\n${note.slice(0, 1000)}` : ""}`,
    `/messages/${t.id}`,
    { relatedType: "thread", relatedId: t.id },
  );
}
