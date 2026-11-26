import "server-only";
import { randomBytes } from "node:crypto";
import type { Database, User } from "@/lib/db/types";
import { canAddChatMembers, canDeleteChatChannel, canEditChatChannelImage, canManageChatChannel, canPostChatChannel, canRemoveChatMembers, canViewChatChannel } from "@/lib/auth/permissions";
import { chatDb, jsonArr, str } from "./db";
import { allCustomChannelRows, channelMetaAll, memberOverrides, type ChannelMeta, type MemberOverrides } from "./repo";
import type { ChatChannelKind } from "./types";

/**
 * チャンネルの定義とメンバー
 * ------------------------------------------------------------
 * - 全社 (all)・店舗 (store:<店舗の ID>)・店長 (managers) は、店舗と社員の登録から毎回作る (行を持たない)。
 *   社員の所属・ロール・退職がそのまま反映され、異動・退職で自動で入れ替わる。管理者が店舗を追加すると、その店舗のチャンネルもできる
 *   自動のメンバー: 全社 = 有効な社員全員 / 店舗 = その店舗の社員 + その店舗の店長 (設定 → 店舗 の店長) / 店長 = 店長のロールの社員 + 各店舗の店長
 *   管理者は店舗・店長のチャンネルにメンバーを足す・外すことができる (SQLite の channel_members。お客様のご要望 2026-11-26)
 * - 追加したチャンネル (c_…) と DM (dm:<ID>+<ID> = 1 対 1、dm_… = 数人) は SQLite の channels に持つ
 * - 見られる人は permissions.ts の canViewChatChannel: 自分が所属している (メンバーの) チャンネルと公開のチャンネルだけ
 *   (お客様のご要望 2026-11-26「ユーザーは自分が所属しているチャンネルと公開チャンネルだけを見られる」。店長のチャンネルはメンバー以外に見えない。
 *   DM は参加している本人同士だけ。管理者も見られない)
 * - チャンネルの画像は channel_meta (本体は storage.ts の chat/channel-images/)。店長のチャンネルに画像がなければ本部のチャンネルの画像を使う
 */

export interface ChannelImage {
  key: string;
  type: string;
  at: string;
  /** 本部のチャンネルの画像を借りている (店長のチャンネル) */
  inherited?: boolean;
}

export interface ChannelDef {
  id: string;
  kind: ChatChannelKind;
  name: string;
  topic?: string;
  storeId?: string;
  color?: string;
  /** メンバー (有効な社員だけ。見られる人・宛先) */
  memberIds: string[];
  /** 全社・店舗・店長のチャンネルの自動のメンバー (管理者の変更の前) */
  autoIds?: string[];
  /** 管理者が足したメンバー (全社・店舗・店長のチャンネル) */
  addedIds?: string[];
  /** 画像を変えられる人 (店舗のチャンネル = その店舗の店長 / 店長のチャンネル = 本部の店長。管理者はすべて) */
  ownerIds?: string[];
  createdBy?: string;
  createdAt?: string;
  archivedAt?: string;
  /** 追加したチャンネルの公開範囲 (public = 社員なら誰でも探して参加できる) */
  visibility?: "public" | "private";
  image?: ChannelImage;
}

export const ALL_CHANNEL = "all";
export const MANAGERS_CHANNEL = "managers";
export const storeChannelId = (storeId: string) => `store:${storeId}`;

const activeUsers = (db: Pick<Database, "users">) => db.users.filter((u) => u.active && !u.signupStatus);

/** 店舗のチャンネルの名前 (本部・ショールームは「本部」) */
export function storeChannelName(s: { name: string; shortName?: string; kind: string }): string {
  return s.kind === "hq" ? s.shortName?.trim() || "本部" : s.name;
}

/** 開いている店舗 (閉鎖・統合した店舗のチャンネルは作らない) */
function openStores(db: Pick<Database, "stores">, today: string) {
  return db.stores.filter((s) => !s.mergedInto && !(s.closedOn && s.closedOn <= today));
}

function imageOf(meta: ChannelMeta | undefined): ChannelImage | undefined {
  return meta?.imageKey && meta.imageType ? { key: meta.imageKey, type: meta.imageType, at: meta.imageAt ?? "" } : undefined;
}

/** 自動のメンバーに管理者の変更 (足す・外す) を重ねる */
function withOverrides(def: ChannelDef, active: Set<string>, o: MemberOverrides | undefined): ChannelDef {
  const auto = def.memberIds.filter((id) => active.has(id));
  if (def.kind === "all" || !o) return { ...def, memberIds: auto, autoIds: auto, addedIds: [] };
  const added = [...o.add].filter((id) => active.has(id) && !auto.includes(id));
  return { ...def, memberIds: [...auto.filter((id) => !o.remove.has(id)), ...added], autoIds: auto, addedIds: added };
}

/** 全社・店舗・店長のチャンネル (並びは 全社 → 店舗 (表示順) → 店長) */
export function systemChannels(db: Pick<Database, "stores" | "users">, today = new Date().toISOString().slice(0, 10)): ChannelDef[] {
  const users = activeUsers(db);
  const active = new Set(users.map((u) => u.id));
  const overrides = memberOverrides();
  const meta = channelMetaAll();
  const stores = openStores(db, today);
  /** 店舗の店長 (設定 → 店舗 の店長。登録がなければその店舗の店長のロールの社員) */
  const managersOf = (s: (typeof stores)[number]) => (s.managerUserId && active.has(s.managerUserId) ? [s.managerUserId] : users.filter((u) => u.role === "store_manager" && u.storeId === s.id).map((u) => u.id));
  const hq = stores.find((s) => s.kind === "hq");
  const topic = (id: string, fallback: string) => meta.get(id)?.topic?.trim() || fallback;
  const defs: ChannelDef[] = [
    { id: ALL_CHANNEL, kind: "all", name: "全社", topic: topic(ALL_CHANNEL, "全社員へのお知らせ・全店舗で共有したい内容"), memberIds: users.map((u) => u.id), image: imageOf(meta.get(ALL_CHANNEL)) },
    ...stores.map<ChannelDef>((s) => {
      const id = storeChannelId(s.id);
      const own = managersOf(s);
      return {
        id,
        kind: "store",
        name: storeChannelName(s),
        topic: topic(id, `${s.name}の社員の連絡・相談・写真の共有`),
        storeId: s.id,
        color: s.color,
        memberIds: [...new Set([...users.filter((u) => u.storeId === s.id).map((u) => u.id), ...own])],
        ownerIds: own,
        image: imageOf(meta.get(id)),
      };
    }),
    (() => {
      const hqImage = hq ? imageOf(meta.get(storeChannelId(hq.id))) : undefined;
      return {
        id: MANAGERS_CHANNEL,
        kind: "managers" as const,
        name: "店長",
        topic: topic(MANAGERS_CHANNEL, "管理者・本部から店長への指示、店長会議の資料 (メンバーだけ)"),
        memberIds: [...new Set([...users.filter((u) => u.role === "store_manager").map((u) => u.id), ...stores.flatMap(managersOf)])],
        ownerIds: hq ? managersOf(hq) : [],
        image: imageOf(meta.get(MANAGERS_CHANNEL)) ?? (hqImage ? { ...hqImage, inherited: true } : undefined),
      };
    })(),
  ];
  return defs.map((d) => withOverrides(d, active, overrides.get(d.id)));
}

function rowToDef(r: Record<string, unknown>, db: Pick<Database, "users">, meta?: Map<string, ChannelMeta>): ChannelDef {
  const active = new Set(activeUsers(db).map((u) => u.id));
  const id = String(r.id);
  return {
    id,
    kind: r.kind === "dm" ? "dm" : "custom",
    name: String(r.name ?? ""),
    topic: str(r.topic),
    memberIds: jsonArr<string>(r.members).filter((x) => active.has(x)),
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
    archivedAt: str(r.archived_at),
    visibility: r.kind === "custom" ? (r.visibility === "public" ? "public" : "private") : undefined,
    image: r.kind === "custom" ? imageOf((meta ?? channelMetaAll()).get(id)) : undefined,
  };
}

/** 追加したチャンネル・DM (自分がメンバーのもの + 公開のチャンネル) */
export function memberChannels(db: Pick<Database, "users">, userId: string): ChannelDef[] {
  const rows = chatDb().prepare("select * from channels where members like ? or (kind = 'custom' and visibility = 'public') order by created_at").all(`%"${userId}"%`);
  const meta = channelMetaAll();
  return rows.map((r) => rowToDef(r, db, meta)).filter((c) => c.memberIds.includes(userId) || c.visibility === "public");
}

/** 公開のチャンネル (チャンネルを探す。アーカイブしたものを除く) */
export function publicChannels(db: Pick<Database, "users">): ChannelDef[] {
  const meta = channelMetaAll();
  return chatDb()
    .prepare("select * from channels where kind = 'custom' and visibility = 'public' and archived_at is null order by name")
    .all()
    .map((r) => rowToDef(r, db, meta));
}

/** 管理者のチャンネルの管理: 追加したチャンネルすべて (非公開・アーカイブしたものを含む。DM は含めない) */
export function allCustomChannels(db: Pick<Database, "users">): ChannelDef[] {
  const meta = channelMetaAll();
  return allCustomChannelRows().map((r) => rowToDef(r, db, meta));
}

/** 自分が参加している (サイドバーに出す) = メンバー */
export function isJoined(userId: string, ch: ChannelDef): boolean {
  return ch.memberIds.includes(userId);
}

/** チャンネル 1 つ (ない・見られないときは undefined) */
export function findChannel(db: Pick<Database, "stores" | "users">, id: string): ChannelDef | undefined {
  if (!id) return undefined;
  if (id === ALL_CHANNEL || id === MANAGERS_CHANNEL || id.startsWith("store:")) return systemChannels(db).find((c) => c.id === id);
  const row = chatDb().prepare("select * from channels where id = ?").get(id);
  return row ? rowToDef(row, db) : undefined;
}

/** 見られるチャンネル (アーカイブしたものを除く) */
export function visibleChannels(db: Pick<Database, "stores" | "users">, user: User): ChannelDef[] {
  return [...systemChannels(db), ...memberChannels(db, user.id)].filter((c) => !c.archivedAt && canViewChatChannel(user, c));
}

/** 全社・店舗・店長のチャンネル (店舗と社員から作るもの。名前・公開範囲は変えられず、削除・アーカイブもできない) */
export const isSystemChannel = (ch: Pick<ChannelDef, "kind">) => ch.kind === "all" || ch.kind === "store" || ch.kind === "managers";

/** チャンネルの画像の URL (画像が変わると URL も変わる = 画面の控えを使わない) */
export function channelImageUrl(ch: Pick<ChannelDef, "id" | "image">): string | undefined {
  if (!ch.image) return undefined;
  return `/api/chat/channel-image?c=${encodeURIComponent(ch.id)}&v=${encodeURIComponent(ch.image.key.slice(-12))}`;
}

export function canView(user: User, ch: ChannelDef | undefined): ch is ChannelDef {
  return Boolean(ch && canViewChatChannel(user, ch));
}

export function canManage(user: User, ch: ChannelDef): boolean {
  return canManageChatChannel(user, ch);
}

export function canPost(user: User, ch: ChannelDef | undefined): ch is ChannelDef {
  return Boolean(ch && canPostChatChannel(user, ch));
}

export function canAddMembers(user: User, ch: ChannelDef): boolean {
  return canAddChatMembers(user, ch);
}

export function canRemoveMembers(user: User, ch: ChannelDef): boolean {
  return canRemoveChatMembers(user, ch);
}

export function canDelete(user: User, ch: ChannelDef): boolean {
  return canDeleteChatChannel(user, ch);
}

export function canEditImage(user: User, ch: ChannelDef): boolean {
  return canEditChatChannelImage(user, ch);
}

/** 1 対 1 の DM の ID (同じ 2 人ならいつも同じ) */
export function directId(a: string, b: string): string {
  return `dm:${[a, b].sort().join("+")}`;
}

export function newChannelId(prefix: "c" | "dm"): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** DM の表示名 (自分以外の参加者の名前。自分だけなら「自分のメモ」) */
export function dmName(db: Pick<Database, "users">, ch: Pick<ChannelDef, "memberIds">, meId: string): string {
  const others = ch.memberIds.filter((id) => id !== meId);
  if (!others.length) return "自分のメモ";
  const names = others.map((id) => db.users.find((u) => u.id === id)?.name ?? "退職した社員");
  return names.length > 3 ? `${names.slice(0, 3).join("、")} ほか ${names.length - 3} 名` : names.join("、");
}

/** チャンネルを見られる人 (メンバー + 公開のチャンネルは社員全員)。メンション・通知の宛先を絞るのに使う */
export function viewersOf(db: Pick<Database, "users">, ch: ChannelDef): User[] {
  return activeUsers(db).filter((u) => canViewChatChannel(u, ch));
}
