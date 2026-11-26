import type { Database, StoreId, User } from "@/lib/db/types";
import { canSeeInboundMessage } from "@/lib/auth/permissions";

/**
 * 外部から届いたメッセージ (LINE・メール・Slack・Chatwork) の通知の一覧
 * ------------------------------------------------------------
 * お客様のご要望 2026-11-26「Slack や LINE、メールで送信されたメッセージが、システム上で通知として表示されるように」。
 * - 受信の処理 (src/lib/notify/inbound.ts の LINE・Chatwork、src/lib/inbound/slack.ts、src/lib/inbound/mail.ts) が 1 件ずつここに足す。
 *   正本の記録 (やりとり履歴・問い合わせ・LINE グループの保留) はこれまでどおりで、ここは「通知」のための写し (本文は先頭だけ)
 * - 保存先は settings の id = "inbound_feed" (新しい 500 件・30 日。テーブルを増やさない。試験期間の引き継ぎはしない = carryover.ts の RUNTIME_SETTINGS)
 * - 見られる人は permissions.ts の canSeeInboundMessage (届いた店舗の社員と、本部・管理者。お店の決まらないものは本部・管理者だけ)
 * - 画面: ヘッダーのベル (経路ごとに 1 行・確認していない件数。src/app/(app)/layout.tsx) → トースト、一覧 /notices/inbound
 * - 設定 (メールの受信のオン・オフ、Slack のチャンネルの店舗) は settings の id = "inbound_settings" (設定 → 外部連携・AI)
 */

export const INBOUND_FEED_ID = "inbound_feed";
export const INBOUND_SETTINGS_ID = "inbound_settings";
export const INBOUND_MAX_ITEMS = 500;
export const INBOUND_KEEP_DAYS = 30;
/** ベルに出す期間 (日) */
export const INBOUND_BELL_DAYS = 7;
const TEXT_MAX = 600;

export type InboundChannel = "line" | "email" | "slack" | "chatwork";
export const INBOUND_CHANNELS: InboundChannel[] = ["line", "email", "slack", "chatwork"];
export const INBOUND_CHANNEL_LABEL: Record<InboundChannel, string> = { line: "LINE", email: "メール", slack: "Slack", chatwork: "Chatwork" };

export interface InboundItem {
  /** line_<メッセージ ID> / mail_<UIDVALIDITY>_<UID> / slack_<チャンネル>_<ts> / cw_<メッセージ ID> (同じ受信は 1 件) */
  id: string;
  channel: InboundChannel;
  /** 届いた日時 (ISO) */
  at: string;
  /** 送り主 (お客様のお名前・会社名・メールの差出人・Slack のユーザー) */
  from: string;
  /** メールアドレス・LINE のグループ名・Slack のチャンネル名 */
  fromDetail?: string;
  /** メールの件名 */
  subject?: string;
  /** 本文の先頭 */
  text: string;
  /** 知らせる店舗 (hq = 本部・管理者だけ) */
  storeId: StoreId;
  /** 関係する記録の画面 (お客様・案件・問い合わせ・取引先) */
  href?: string;
  /** 記録の説明 (例: お客様 / 案件 O-2026-0012 / 未登録) */
  ref?: string;
  /** 自動送信・メールマガジン (ベルには出さず、一覧だけ) */
  bulk?: boolean;
  /** Slack: 名前を後から入れるための ID */
  slack?: { channel: string; user?: string };
}

export interface InboundMailState {
  /** メールボックスの UIDVALIDITY (変わったら読み直しの起点を作り直す) */
  uidValidity?: string;
  /** 最後に読んだメールの UID */
  lastUid?: number;
  lastRunAt?: string;
  lastOkAt?: string;
  lastError?: string;
  /** これまでに受け取った件数 */
  received?: number;
}

export interface SlackSeenChannel {
  name?: string;
  lastAt: string;
  count: number;
}

interface FeedValue {
  items?: InboundItem[];
  mail?: InboundMailState;
  /** Slack の名前の控え (users.info・conversations.info で取得) */
  slackNames?: { users?: Record<string, string>; channels?: Record<string, string> };
  /** 届いたことのある Slack のチャンネル (設定でお店を決める一覧) */
  slackChannels?: Record<string, SlackSeenChannel>;
}

export interface InboundSettings {
  /** 会社のメールボックス (IMAP) の受信を通知する (既定はオフ。管理者が 設定 → 外部連携・AI でオンにする) */
  mailEnabled?: boolean;
  /** Slack のチャンネル → 知らせる店舗 (決めていないチャンネルは本部・管理者だけ) */
  slackStores?: Record<string, StoreId>;
}

function feedValue(db: Pick<Database, "settings">): FeedValue {
  const v = (db.settings ?? []).find((s) => s.id === INBOUND_FEED_ID)?.value;
  return v && typeof v === "object" ? (v as FeedValue) : {};
}

/** mutate の中で書き換える (なければ作る) */
export function feedRow(db: Database, by = "system"): FeedValue {
  let row = db.settings.find((s) => s.id === INBOUND_FEED_ID);
  if (!row) {
    row = { id: INBOUND_FEED_ID, value: { items: [] }, updatedBy: by, updatedAt: new Date().toISOString() };
    db.settings.push(row);
  }
  if (!row.value || typeof row.value !== "object") row.value = { items: [] };
  const v = row.value as FeedValue;
  if (!Array.isArray(v.items)) v.items = [];
  row.updatedAt = new Date().toISOString();
  row.updatedBy = by;
  return v;
}

export function inboundItems(db: Pick<Database, "settings">): InboundItem[] {
  const items = feedValue(db).items;
  return Array.isArray(items) ? items : [];
}

export function inboundMailState(db: Pick<Database, "settings">): InboundMailState {
  return feedValue(db).mail ?? {};
}

export function slackNames(db: Pick<Database, "settings">): { users: Record<string, string>; channels: Record<string, string> } {
  const n = feedValue(db).slackNames;
  return { users: n?.users ?? {}, channels: n?.channels ?? {} };
}

export function slackSeenChannels(db: Pick<Database, "settings">): Record<string, SlackSeenChannel> {
  return feedValue(db).slackChannels ?? {};
}

export function inboundSettings(db: Pick<Database, "settings">): InboundSettings {
  const v = (db.settings ?? []).find((s) => s.id === INBOUND_SETTINGS_ID)?.value;
  return v && typeof v === "object" ? (v as InboundSettings) : {};
}

/** 本文を 1 行にそろえて短くする */
export function clipText(text: string, max = TEXT_MAX): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 古いもの (30 日より前) と多すぎる分を消す */
export function trimInbound(items: InboundItem[], now = Date.now()): InboundItem[] {
  const since = new Date(now - INBOUND_KEEP_DAYS * 86_400_000).toISOString();
  const kept = items.filter((i) => i.at >= since).sort((a, b) => a.at.localeCompare(b.at));
  return kept.length > INBOUND_MAX_ITEMS ? kept.slice(kept.length - INBOUND_MAX_ITEMS) : kept;
}

/** 1 件足す (mutate の中で呼ぶ)。同じ ID がすでにあれば足さない (再送・グループのひも付けで同じメッセージをもう一度処理したとき) */
export function addInbound(db: Database, item: InboundItem): boolean {
  const v = feedRow(db);
  if (v.items!.some((i) => i.id === item.id)) return false;
  v.items!.push({ ...item, text: clipText(item.text), subject: item.subject ? clipText(item.subject, 200) : undefined });
  v.items = trimInbound(v.items!);
  return true;
}

/** メールの受信の状態を書く (mutate の中で呼ぶ) */
export function setInboundMailState(db: Database, patch: Partial<InboundMailState>): void {
  const v = feedRow(db);
  v.mail = { ...(v.mail ?? {}), ...patch };
}

/** Slack の名前の控えとチャンネルの一覧を書く (mutate の中で呼ぶ)。名前が分かったら、届いたメッセージの送り主・チャンネル名も直す */
export function setSlackNames(db: Database, names: { users?: Record<string, string>; channels?: Record<string, string> }): void {
  const v = feedRow(db);
  const cur = { users: { ...(v.slackNames?.users ?? {}), ...(names.users ?? {}) }, channels: { ...(v.slackNames?.channels ?? {}), ...(names.channels ?? {}) } };
  v.slackNames = cur;
  for (const [id, name] of Object.entries(names.channels ?? {})) if (v.slackChannels?.[id]) v.slackChannels[id].name = name;
  for (const i of v.items!) {
    if (!i.slack) continue;
    if (i.slack.user && cur.users[i.slack.user]) i.from = cur.users[i.slack.user];
    const ch = cur.channels[i.slack.channel];
    if (ch && i.fromDetail !== "DM") i.fromDetail = `#${ch}`;
  }
}

/** Slack のチャンネルに届いたことを記録する (設定の一覧に出す。mutate の中で呼ぶ) */
export function touchSlackChannel(db: Database, channel: string, at: string, name?: string): void {
  const v = feedRow(db);
  const all = (v.slackChannels ??= {});
  const c = (all[channel] ??= { lastAt: at, count: 0 });
  c.count += 1;
  if (at > c.lastAt) c.lastAt = at;
  if (name) c.name = name;
}

/**
 * その人に知らせる受信 (新しい順)。days 日以内。bulk = true の自動送信のメールは includeBulk のときだけ
 */
export function inboundForUser(db: Pick<Database, "settings">, user: User, opts: { days?: number; includeBulk?: boolean; now?: number } = {}): InboundItem[] {
  const since = opts.days ? new Date((opts.now ?? Date.now()) - opts.days * 86_400_000).toISOString() : "";
  return inboundItems(db)
    .filter((i) => i.at >= since && (opts.includeBulk || !i.bulk) && canSeeInboundMessage(user, i.storeId))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** ベルの 1 行 (経路ごと)。件数・最新の送り主と本文 */
export interface InboundBellGroup {
  channel: InboundChannel;
  items: InboundItem[];
}

export function inboundBellGroups(items: InboundItem[]): InboundBellGroup[] {
  return INBOUND_CHANNELS.map((channel) => ({ channel, items: items.filter((i) => i.channel === channel && !i.bulk) })).filter((g) => g.items.length > 0);
}

/** 送り主と本文の 1 行 (ベル・トースト) */
export function inboundLine(i: Pick<InboundItem, "from" | "subject" | "text">): string {
  const body = (i.subject ? `${i.subject} — ${i.text}` : i.text).replace(/\s+/g, " ").trim();
  return `${i.from}: ${body}`.slice(0, 120);
}

/** 経路のメッセージの一覧の画面 */
export function inboundListHref(channel?: InboundChannel): string {
  return channel ? `/notices/inbound?channel=${channel}` : "/notices/inbound";
}
