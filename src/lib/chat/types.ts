/**
 * チャット (チャンネル・DM) の型 (画面とサーバーで共通。server-only の import をしない)
 * ------------------------------------------------------------
 * お客様のご要望 2026-11-25「社内連絡機能 (チャンネル・DM)」(other/docs/16〜18)。
 * データは VPS の SQLite (src/lib/chat/db.ts)。業務依頼は従来の threads (Supabase) をそのまま使う。
 */

import type { Role, TaskStatus } from "@/lib/db/types";

/**
 * チャンネルの種類
 * - all: 全社 (有効な社員全員) / store: 店舗 (その店舗の社員。本部・管理者はすべての店舗を見られる) / managers: 店長 (店長以上 = 店長・本部・管理者)
 * - custom: 追加したチャンネル (選んだメンバーだけ) / dm: 個別のメッセージ (参加している本人同士だけ。管理者も見られない)
 */
export type ChatChannelKind = "all" | "store" | "managers" | "custom" | "dm";

/** 通常のメッセージの通知: all = すべて (音・プッシュ通知) / priority = 自分あて (メンション・重要・業務依頼) だけ */
export type NotifyLevel = "all" | "priority";

/** 資料・写真の公開範囲: members = チャンネルのメンバー全員 / managers = 店長以上 (店長・本部・管理者) だけ */
export type ChatFileAccess = "members" | "managers";

export interface ChatUser {
  id: string;
  name: string;
  kana: string;
  storeId: string;
  role: Role;
  title: string;
  avatar?: string;
}

export interface ChatStoreRef {
  id: string;
  name: string;
  color: string;
}

export interface ChatChannelView {
  id: string;
  kind: ChatChannelKind;
  name: string;
  topic?: string;
  storeId?: string;
  color?: string;
  /** 宛先のメンバー (重要メッセージの確認・@全員 の範囲) */
  memberIds: string[];
  /** 自分がメンバーでなく、本部・管理者として見ている (店舗のチャンネル) */
  viewer?: boolean;
  /** 未読のメッセージ (自分以外が送った、スレッドの返信を除く) */
  unread: number;
  /** 未読のメンション・未確認の重要メッセージ (赤) */
  mentions: number;
  lastAt?: string;
  lastUserId?: string;
  lastPreview?: string;
  notify: NotifyLevel;
  /** 名前・メンバーを変えられる (追加したチャンネルの作成者・管理者) */
  canManage: boolean;
  archived?: boolean;
  createdBy?: string;
}

export interface ChatFile {
  id: string;
  name: string;
  type: string;
  size: number;
  photo: boolean;
  video?: boolean;
  width?: number;
  height?: number;
  thumb?: boolean;
  access: ChatFileAccess;
}

export interface ChatReaction {
  emoji: string;
  userIds: string[];
}

export interface ChatTaskInfo {
  threadId: string;
  title: string;
  status: TaskStatus;
  assigneeIds: string[];
  createdBy: string;
  dueAt?: string;
  dueDate?: string;
  overdue: boolean;
}

export interface ChatAckInfo {
  /** 自分が確認する人 (受け取った人) */
  required: boolean;
  /** 自分が確認した日時 */
  mine?: string;
  done: number;
  total: number;
  /** 確認した人・まだの人 (送った人・店長以上だけに返す) */
  ackedIds?: string[];
  pendingIds?: string[];
  remindedAt?: string;
}

export interface ChatLink {
  text: string;
  href: string;
}

export interface ChatMessageView {
  id: string;
  channelId: string;
  parentId?: string;
  userId: string;
  /** 本文 (メンションは <@ID>・<!all>・<!store:ID> の印) */
  body: string;
  at: string;
  editedAt?: string;
  deleted?: boolean;
  important: boolean;
  mentions: string[];
  mentionAll: boolean;
  files: ChatFile[];
  /** 公開範囲が店長以上の資料で、自分が見られないものの数 */
  hiddenFiles: number;
  reactions: ChatReaction[];
  replyCount: number;
  lastReplyAt?: string;
  replyUserIds: string[];
  ack?: ChatAckInfo;
  task?: ChatTaskInfo;
  links: ChatLink[];
  rev: number;
}

export type InboxKind = "task" | "report" | "important" | "mention" | "thread_mention";

/** 要対応 (チャットのアイコンの赤い数字) の 1 件 */
export interface InboxItem {
  key: string;
  kind: InboxKind;
  title: string;
  detail: string;
  fromId?: string;
  at: string;
  /** 開く先 (チャットの中なら channelId・messageId、業務依頼・社内連絡なら href) */
  channelId?: string;
  messageId?: string;
  parentId?: string;
  href?: string;
  dueAt?: string;
  overdue?: boolean;
  status?: TaskStatus;
  channelName?: string;
}

/** 依頼中 (自分が報告済みで、依頼した人の確認を待っているもの。数字には入れない) */
export interface WaitingItem {
  key: string;
  title: string;
  href: string;
  at: string;
  status: TaskStatus;
  otherId?: string;
}

export interface ChatCounts {
  /** 要対応 (赤): 業務依頼・報告の確認・未確認の重要メッセージ・未読のメンション */
  action: number;
  /** 未読 (青): DM と「すべて通知」にしたチャンネルの未読のメッセージ */
  unread: number;
  /** 新しいものが届いたかを比べる印 (要対応 / 未読の最新) */
  actionKey: string;
  unreadKey: string;
}

export interface ChatPrefs {
  sound: boolean;
  push: boolean;
}

export interface ChatSummary extends ChatCounts {
  prefs: ChatPrefs;
}

export interface ChatSyncResponse {
  rev: number;
  channels: ChatChannelView[];
  counts: ChatCounts;
  inbox: InboxItem[];
  waiting: WaitingItem[];
  /** 開いているチャンネルの変わったメッセージ (スレッドの返信を除く) */
  messages: ChatMessageView[];
  /** 開いているスレッドの変わった返信 */
  replies: ChatMessageView[];
  /** 開いているチャンネルの業務依頼の状態 (メッセージの task を新しくする) */
  tasks: Record<string, ChatTaskInfo>;
}

export interface ChatBootstrap {
  me: ChatUser;
  users: ChatUser[];
  stores: ChatStoreRef[];
  /** 重要メッセージを送れる・@全員を使える・店長以上の資料を登録できる (管理者・本部・店長) */
  canImportant: boolean;
  canCreateChannel: boolean;
  /** プッシュ通知の公開鍵 (VAPID)。使えないときは空 */
  vapidKey: string;
  maxFileBytes: number;
}

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** 送るときに選ぶ期限 (src/lib/inquiry-flow.ts の DueChoice と同じ) */
export type ChatDueChoice = "none" | "noon" | "today" | "tomorrow" | "custom";

export interface ChatTaskInput {
  title: string;
  assigneeIds: string[];
  due: ChatDueChoice;
  dueCustom?: string;
}

/** 1 回に選べる DM の相手 (自分を除く) */
export const DM_MAX_MEMBERS = 8;
/** 1 つのメッセージの資料・写真 */
export const CHAT_MAX_FILES = 10;
/** 1 ファイルの大きさ (nginx の 1 回の送信の上限 10 MB に収める) */
export const CHAT_MAX_FILE_BYTES = 9 * 1024 * 1024;
/** 本文の長さ */
export const CHAT_MAX_BODY = 8000;
/** リアクションに使える絵文字 */
export const CHAT_REACTIONS = ["👍", "✅", "🙏", "😊", "🎉", "👀", "😢", "❗"] as const;
