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
  /** メンバー (見られる人。重要メッセージの確認・@全員 の範囲) */
  memberIds: string[];
  /** 管理者が足したメンバー (全社・店舗・店長のチャンネル。自動のメンバーではない人) */
  addedIds?: string[];
  /** チャンネルの画像の URL (なければアイコン) */
  image?: string;
  /** 画像は本部のチャンネルのもの (店長のチャンネルに画像を登録していないとき) */
  imageInherited?: boolean;
  /** 未読のメッセージ (自分以外が送った、スレッドの返信を除く) */
  unread: number;
  /** 未読のメンション・未確認の重要メッセージ (赤) */
  mentions: number;
  lastAt?: string;
  lastUserId?: string;
  lastPreview?: string;
  notify: NotifyLevel;
  /** 設定を変えられる (追加したチャンネルの作成者・管理者。全社・店舗・店長のチャンネルは管理者が説明・メンバー) */
  canManage: boolean;
  /** メンバーを外せる (追加したチャンネルの作成者・管理者。店舗・店長のチャンネルは管理者) */
  canRemoveMembers: boolean;
  /** 画像を変えられる */
  canEditImage: boolean;
  /** 削除できる (管理者。追加したチャンネルだけ) */
  canDelete: boolean;
  archived?: boolean;
  createdBy?: string;
  createdAt?: string;
  /** 追加したチャンネルの公開範囲: public = 社員なら誰でも探して参加できる / private = メンバーだけ */
  visibility?: "public" | "private";
  /** 自分がメンバー (追加したチャンネルで参加していないときは見るだけ) */
  joined: boolean;
  /** 送れる (追加したチャンネルはメンバーだけ) */
  canPost: boolean;
  /** メンバーを追加できる (追加したチャンネルのメンバーと管理者。店舗・店長のチャンネルは管理者) */
  canAddMembers: boolean;
  /** スター付き (自分の一覧の上に出す) */
  starred: boolean;
  /** ピン留めしたメッセージの数 */
  pinCount: number;
}

/** 共有 (転送) したメッセージの写し */
export interface SharedMessage {
  channelId: string;
  channelName: string;
  messageId: string;
  parentId?: string;
  userId: string;
  body: string;
  at: string;
  links: ChatLink[];
  /** 元のメッセージの資料・写真の名前 (開くのは元のチャンネルを見られる人だけ) */
  fileNames: string[];
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
  /** ピン留めした人 */
  pinnedBy?: string;
  /** 自分が「後で見る」に保存した */
  saved?: boolean;
  /** スレッドの返信を「チャンネルにも送信」した */
  alsoChannel?: boolean;
  /** チャンネルにも送信した返信の、スレッドの最初のメッセージ (要約) */
  root?: { id: string; userId: string; body: string };
  /** 共有 (転送) したメッセージ */
  shared?: SharedMessage;
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
  /** 開いているチャンネル・スレッドで入力中の人 */
  typing: string[];
  threadTyping: string[];
  /** オンライン (いま画面を開いている) の社員 */
  online: string[];
}

export interface ChatBootstrap {
  me: ChatUser;
  users: ChatUser[];
  stores: ChatStoreRef[];
  /** 重要メッセージを送れる・@全員を使える・店長以上の資料を登録できる (管理者・本部・店長) */
  canImportant: boolean;
  canCreateChannel: boolean;
  /** 管理者: すべてのチャンネル (非公開・アーカイブを含む) を管理の一覧で見て、追加・変更・削除できる */
  canAdminChannels: boolean;
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
/** チャンネルの画像 (画面で 512 px に縮小してから送る) */
export const CHAT_CHANNEL_IMAGE_BYTES = 2 * 1024 * 1024;
/** 1 つのメッセージの資料・写真 */
export const CHAT_MAX_FILES = 10;
/** 1 ファイルの大きさ (nginx の 1 回の送信の上限 10 MB に収める) */
export const CHAT_MAX_FILE_BYTES = 9 * 1024 * 1024;
/** 本文の長さ */
export const CHAT_MAX_BODY = 8000;
/** メッセージの上にすぐ出すリアクション (ほかは絵文字の一覧から。src/lib/chat/emoji.ts) */
/**
 * 非公開のチャンネル (メンバーだけが見られる) か: 店舗・店長のチャンネルと、非公開で作ったチャンネル。
 * 全社 (全社員が参加) と公開のチャンネルは公開。DM はチャンネルではないので対象外 (false)。
 * 画面ではチャンネルのアイコンの右下に鍵の印を付ける (parts.tsx の ChannelIcon。お客様のご要望 2026-11-26)
 */
export function isPrivateChannel(c: Pick<ChatChannelView, "kind" | "visibility">): boolean {
  return c.kind === "store" || c.kind === "managers" || (c.kind === "custom" && c.visibility !== "public");
}

/** 文字だけの場面 (入力欄の案内など) のチャンネルの名前: 公開 = 「# 名前」 / 非公開 = 「🔒 名前」 */
export function channelLabel(c: Pick<ChatChannelView, "kind" | "visibility" | "name">): string {
  return `${isPrivateChannel(c) ? "🔒" : "#"} ${c.name}`;
}

export const CHAT_REACTIONS = ["👍", "✅", "🙏", "😊", "🎉", "👀", "😢", "❗"] as const;
