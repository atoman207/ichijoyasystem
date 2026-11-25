import "server-only";
import { randomBytes } from "node:crypto";
import type { Database, User } from "@/lib/db/types";
import { canAddChatMembers, canManageChatChannel, canPostChatChannel, canViewChatChannel, isChatLead } from "@/lib/auth/permissions";
import { chatDb, jsonArr, str } from "./db";
import type { ChatChannelKind } from "./types";

/**
 * チャンネルの定義とメンバー
 * ------------------------------------------------------------
 * - 全社 (all)・店舗 (store:<店舗の ID>)・店長 (managers) は、店舗と社員の登録から毎回作る (行を持たない)。
 *   社員の所属・ロール・退職がそのまま反映され、異動・退職で自動で入れ替わる。管理者が店舗を追加すると、その店舗のチャンネルもできる
 * - 追加したチャンネル (c_…) と DM (dm:<ID>+<ID> = 1 対 1、dm_… = 数人) は SQLite の channels に持つ
 * - 見られる人は permissions.ts の canViewChatChannel (DM は参加している本人同士だけ)
 */

export interface ChannelDef {
  id: string;
  kind: ChatChannelKind;
  name: string;
  topic?: string;
  storeId?: string;
  color?: string;
  /** 宛先のメンバー (有効な社員だけ) */
  memberIds: string[];
  createdBy?: string;
  createdAt?: string;
  archivedAt?: string;
  /** 追加したチャンネルの公開範囲 (public = 社員なら誰でも探して参加できる) */
  visibility?: "public" | "private";
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

/** 全社・店舗・店長のチャンネル (並びは 全社 → 店舗 (表示順) → 店長) */
export function systemChannels(db: Pick<Database, "stores" | "users">, today = new Date().toISOString().slice(0, 10)): ChannelDef[] {
  const users = activeUsers(db);
  return [
    { id: ALL_CHANNEL, kind: "all", name: "全社", topic: "全社員へのお知らせ・全店舗で共有したい内容", memberIds: users.map((u) => u.id) },
    ...openStores(db, today).map<ChannelDef>((s) => ({
      id: storeChannelId(s.id),
      kind: "store",
      name: storeChannelName(s),
      topic: `${s.name}の社員の連絡・相談・写真の共有`,
      storeId: s.id,
      color: s.color,
      memberIds: users.filter((u) => u.storeId === s.id).map((u) => u.id),
    })),
    { id: MANAGERS_CHANNEL, kind: "managers", name: "店長", topic: "管理者・本部から店長への指示、店長会議の資料 (店長以上だけ)", memberIds: users.filter((u) => isChatLead(u)).map((u) => u.id) },
  ];
}

function rowToDef(r: Record<string, unknown>, db: Pick<Database, "users">): ChannelDef {
  const active = new Set(activeUsers(db).map((u) => u.id));
  return {
    id: String(r.id),
    kind: r.kind === "dm" ? "dm" : "custom",
    name: String(r.name ?? ""),
    topic: str(r.topic),
    memberIds: jsonArr<string>(r.members).filter((id) => active.has(id)),
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
    archivedAt: str(r.archived_at),
    visibility: r.kind === "custom" ? (r.visibility === "public" ? "public" : "private") : undefined,
  };
}

/** 追加したチャンネル・DM (自分がメンバーのもの + 公開のチャンネル) */
export function memberChannels(db: Pick<Database, "users">, userId: string): ChannelDef[] {
  const rows = chatDb().prepare("select * from channels where members like ? or (kind = 'custom' and visibility = 'public') order by created_at").all(`%"${userId}"%`);
  return rows.map((r) => rowToDef(r, db)).filter((c) => c.memberIds.includes(userId) || c.visibility === "public");
}

/** 公開のチャンネル (チャンネルを探す。アーカイブしたものを除く) */
export function publicChannels(db: Pick<Database, "users">): ChannelDef[] {
  return chatDb()
    .prepare("select * from channels where kind = 'custom' and visibility = 'public' and archived_at is null order by name")
    .all()
    .map((r) => rowToDef(r, db));
}

/** 自分が参加している (サイドバーに出す)。全社・店舗・店長は見られれば参加、追加したチャンネル・DM はメンバー */
export function isJoined(userId: string, ch: ChannelDef): boolean {
  return ch.kind === "custom" || ch.kind === "dm" ? ch.memberIds.includes(userId) : true;
}

/** チャンネル 1 つ (ない・見られないときは undefined) */
export function findChannel(db: Pick<Database, "stores" | "users">, id: string): ChannelDef | undefined {
  const sys = systemChannels(db).find((c) => c.id === id);
  if (sys) return sys;
  const row = chatDb().prepare("select * from channels where id = ?").get(id);
  return row ? rowToDef(row, db) : undefined;
}

/** 見られるチャンネル (アーカイブしたものを除く) */
export function visibleChannels(db: Pick<Database, "stores" | "users">, user: User): ChannelDef[] {
  return [...systemChannels(db), ...memberChannels(db, user.id)].filter((c) => !c.archivedAt && canViewChatChannel(user, c));
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

/** 自分がメンバーではなく、本部・管理者として見ている店舗のチャンネル */
export function isViewer(user: User, ch: ChannelDef): boolean {
  return ch.kind === "store" && !ch.memberIds.includes(user.id);
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

/** チャンネルを見られる人 (宛先のメンバー + 店舗のチャンネルは本部・管理者)。メンション・通知の宛先を絞るのに使う */
export function viewersOf(db: Pick<Database, "users">, ch: ChannelDef): User[] {
  return activeUsers(db).filter((u) => canViewChatChannel(u, ch));
}
