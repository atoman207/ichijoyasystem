import { BookOpenCheck, Bell, CalendarPlus, CalendarX2, ClipboardCheck, Clock, Hash, History, Inbox, ListTodo, Mail, MessageCircle, MessageSquare, MessagesSquare, Printer, Receipt, UserPlus, type LucideIcon } from "lucide-react";

/**
 * 通知の種類ごとの色・アイコン・ラベル (お客様のご要望 2026-11-26「トーストは通知ごとに違う色で」)
 * ------------------------------------------------------------
 * ヘッダーのベルの行 (AppShell) と、新しく届いた通知のトースト (Toaster.tsx の tone = notice + style) で同じものを使う。
 * 色だけに意味を持たせないよう、必ずアイコンとラベル (承認・請求・LINE など) を一緒に出す。
 * Tailwind のクラスはこの表に文字のまま書く (組み立てるとクラスが作られない)
 */

/** ベルの通知の種類 (src/app/(app)/layout.tsx が作る NotificationItem.kind) */
export type NoticeKind = "approval" | "mention" | "overdue" | "inquiry" | "request" | "schedule" | "conflict" | "task" | "signup" | "fax" | "knowledge" | "change" | "inbound";

/** 外部から届いたメッセージの経路 (src/lib/inbound/feed.ts の InboundChannel と同じ) */
export type NoticeChannel = "line" | "email" | "slack" | "chatwork";

/** トースト・ベルの色の種類: 通知の種類、届いたメッセージは経路ごと、チャット、その他 (bell) */
export type NoticeStyleKey = Exclude<NoticeKind, "inbound"> | `inbound:${NoticeChannel}` | "chat" | "bell";

export interface NoticeStyle {
  icon: LucideIcon;
  /** ラベル (トーストの見出し・ベルの読み上げ) */
  label: string;
  /** アイコンの丸 (背景 + 文字の色) */
  chip: string;
  /** トーストの左の帯・残り時間の線 */
  bar: string;
  /** 見出しの文字の色 */
  text: string;
}

export const NOTICE_STYLE: Record<NoticeStyleKey, NoticeStyle> = {
  approval: { icon: ClipboardCheck, label: "承認", chip: "bg-warn-soft text-warn-ink", bar: "bg-warn", text: "text-warn-ink" },
  task: { icon: ListTodo, label: "業務依頼", chip: "bg-serious-soft text-serious-ink", bar: "bg-serious", text: "text-serious-ink" },
  overdue: { icon: Receipt, label: "請求", chip: "bg-critical-soft text-critical-ink", bar: "bg-critical", text: "text-critical-ink" },
  conflict: { icon: CalendarX2, label: "予定の重複", chip: "bg-rose-50 text-rose-700", bar: "bg-rose-500", text: "text-rose-700" },
  change: { icon: History, label: "変更", chip: "bg-fuchsia-50 text-fuchsia-700", bar: "bg-fuchsia-500", text: "text-fuchsia-700" },
  signup: { icon: UserPlus, label: "新規登録", chip: "bg-violet-50 text-violet-700", bar: "bg-violet-500", text: "text-violet-700" },
  inquiry: { icon: Inbox, label: "問い合わせ", chip: "bg-accent-soft text-accent-ink", bar: "bg-accent", text: "text-accent-ink" },
  schedule: { icon: CalendarPlus, label: "予定", chip: "bg-info-soft text-info-ink", bar: "bg-info", text: "text-info-ink" },
  mention: { icon: MessageSquare, label: "メンション", chip: "bg-sky-50 text-sky-700", bar: "bg-sky-500", text: "text-sky-700" },
  fax: { icon: Printer, label: "FAX", chip: "bg-cyan-50 text-cyan-800", bar: "bg-cyan-600", text: "text-cyan-800" },
  knowledge: { icon: BookOpenCheck, label: "社内資料", chip: "bg-lime-50 text-lime-800", bar: "bg-lime-600", text: "text-lime-800" },
  request: { icon: Clock, label: "依頼", chip: "bg-slate-100 text-slate-700", bar: "bg-slate-500", text: "text-slate-700" },
  "inbound:line": { icon: MessageCircle, label: "LINE", chip: "bg-[#e6f9ee] text-[#05893c]", bar: "bg-[#06c755]", text: "text-[#05893c]" },
  "inbound:email": { icon: Mail, label: "メール", chip: "bg-teal-50 text-teal-800", bar: "bg-teal-600", text: "text-teal-800" },
  "inbound:slack": { icon: Hash, label: "Slack", chip: "bg-purple-50 text-purple-800", bar: "bg-purple-700", text: "text-purple-800" },
  "inbound:chatwork": { icon: MessagesSquare, label: "Chatwork", chip: "bg-orange-50 text-orange-800", bar: "bg-orange-600", text: "text-orange-800" },
  chat: { icon: MessagesSquare, label: "チャット", chip: "bg-emerald-50 text-emerald-700", bar: "bg-emerald-600", text: "text-emerald-700" },
  bell: { icon: Bell, label: "通知", chip: "bg-neutral-soft text-ink-2", bar: "bg-ink-3", text: "text-ink-2" },
};

/** 通知 (ベルの 1 行) の色の種類。届いたメッセージは経路ごとの色 */
export function noticeStyleKey(n: { kind: NoticeKind; channel?: NoticeChannel }): NoticeStyleKey {
  if (n.kind === "inbound") return n.channel ? `inbound:${n.channel}` : "bell";
  return n.kind;
}

/** 色の種類から表示の色 (知らないものは「通知」の色) */
export function noticeStyle(key: string | undefined): NoticeStyle {
  return (key && NOTICE_STYLE[key as NoticeStyleKey]) || NOTICE_STYLE.bell;
}
