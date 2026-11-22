import type { Database, StoreId } from "@/lib/db/types";

/**
 * LINE のグループ・複数人トーク (施工現場ごとのグループなど)
 * ------------------------------------------------------------
 * - 公式アカウントをグループに招待すると、Webhook の join で登録する (settings テーブルの id = "line_groups")
 * - 受注 (案件) と協力業者・仕入先にひも付けると、そのグループのメッセージ・写真・資料を案件のやりとり履歴・現場写真に残す
 * - ひも付ける前に届いたメッセージは pending に残し (新しい 50 件まで)、ひも付けたときに履歴へ移す
 * - 受注の画面から、ひも付けたグループへ LINE で送れる
 * - グループの用途 (purpose) と店舗を決めると、社内のグループもシステムにつながる (設定 → 外部連携・AI):
 *   店舗別グループ = 新しい問い合わせをそのグループに知らせる (notifyInquiries) / クレーム・手直し報告 = 報告を KPI → クレーム・手直し に並べ、
 *   その場で記録にする / 施工事例写真・整理整頓の確認・その他 = メッセージを残す (用途のあるグループは 300 件まで)
 */

export const LINE_GROUPS_ID = "line_groups";
export const MAX_PENDING = 50;
/** 用途を決めたグループ (店舗別・クレーム報告など) のメッセージを残す件数 */
export const MAX_PENDING_PURPOSE = 300;

/** グループの用途 (一畳屋の LINE 運用のグループの種類) */
export type LineGroupPurpose = "site" | "store" | "quality" | "photos" | "tidy" | "other";

export const LINE_GROUP_PURPOSES: LineGroupPurpose[] = ["site", "store", "quality", "photos", "tidy", "other"];

export const LINE_GROUP_PURPOSE_LABEL: Record<LineGroupPurpose, string> = {
  site: "現場・業者 (案件・協力業者にひも付け)",
  store: "店舗別グループ",
  quality: "クレーム・手直し報告",
  photos: "施工事例写真",
  tidy: "整理整頓の確認",
  other: "その他 (店長・事務と幹部など。記録だけ)",
};

export interface PendingLineMessage {
  /** LINE のメッセージ ID */
  id: string;
  at: string;
  /** 送った人の LINE ユーザー ID (取得できたとき) */
  userId?: string;
  /** text / image / file など */
  type: string;
  text: string;
  fileName?: string;
  /** 対応済み (クレーム・手直しの記録にした・対応不要にした) */
  handledAt?: string;
  handledBy?: string;
  /** 対応で作った記録 (quality:<ID> など) */
  recordRef?: string;
}

export interface LineGroup {
  /** groupId (C…) または roomId (R…) */
  id: string;
  kind: "group" | "room";
  /** グループ名 (LINE から取得) */
  name?: string;
  /** 社内で分かる名前 (任意。例: 〇〇様邸 現場) */
  label?: string;
  orderId?: string;
  supplierId?: string;
  /** 用途 (空 = 現場・業者のグループ) */
  purpose?: LineGroupPurpose;
  /** 店舗 (店舗別グループ・クレーム報告などの店舗。全店のグループは空) */
  storeId?: StoreId;
  /** 店舗別グループ: 新しい問い合わせ (この店舗) をこのグループに知らせる。LINE の送信 (プッシュ) の通数を使う */
  notifyInquiries?: boolean;
  status: "joined" | "left";
  joinedAt: string;
  leftAt?: string;
  lastMessageAt?: string;
  messageCount: number;
  pending: PendingLineMessage[];
}

/** LINE のグループ ID・トーク ID の形 */
export const LINE_GROUP_ID_RE = /^[CR][0-9a-f]{32}$/;

export function lineGroups(db: Pick<Database, "settings">): LineGroup[] {
  const v = (db.settings ?? []).find((s) => s.id === LINE_GROUPS_ID)?.value as { groups?: LineGroup[] } | undefined;
  return Array.isArray(v?.groups) ? v.groups : [];
}

export function lineGroupsOfOrder(db: Pick<Database, "settings">, orderId: string): LineGroup[] {
  return lineGroups(db).filter((g) => g.orderId === orderId && g.status === "joined");
}

export function lineGroupName(g: Pick<LineGroup, "id" | "name" | "label">): string {
  return g.label || g.name || `LINE グループ (${g.id.slice(0, 8)}…)`;
}

/** 一覧の行 (mutate の中で呼ぶ。なければ作る) */
export function ensureLineGroup(db: Database, id: string, kind: LineGroup["kind"], at: string, updatedBy = "system"): LineGroup {
  let row = db.settings.find((s) => s.id === LINE_GROUPS_ID);
  if (!row) {
    row = { id: LINE_GROUPS_ID, value: { groups: [] }, updatedBy, updatedAt: at };
    db.settings.push(row);
  }
  const value = row.value as { groups?: LineGroup[] };
  if (!Array.isArray(value.groups)) value.groups = [];
  let g = value.groups.find((x) => x.id === id);
  if (!g) {
    g = { id, kind, status: "joined", joinedAt: at, messageCount: 0, pending: [] };
    value.groups.push(g);
  }
  if (!Array.isArray(g.pending)) g.pending = [];
  row.updatedAt = new Date().toISOString();
  row.updatedBy = updatedBy;
  return g;
}

/** 既存の行を探す (mutate の中で書き換える用) */
export function findLineGroup(db: Database, id: string): LineGroup | undefined {
  return lineGroups(db).find((g) => g.id === id);
}

export function touchLineGroups(db: Database, updatedBy: string) {
  const row = db.settings.find((s) => s.id === LINE_GROUPS_ID);
  if (row) {
    row.updatedAt = new Date().toISOString();
    row.updatedBy = updatedBy;
  }
}

/** 保留・記録として残す件数 (用途のあるグループは多めに残す) */
export function pendingLimit(g: Pick<LineGroup, "purpose">): number {
  return g.purpose && g.purpose !== "site" ? MAX_PENDING_PURPOSE : MAX_PENDING;
}

/** 件数を超えたら古いものから消す (対応済みを先に消す) */
export function trimPending(g: LineGroup): void {
  const limit = pendingLimit(g);
  while (g.pending.length > limit) {
    const i = g.pending.findIndex((m) => m.handledAt);
    g.pending.splice(i >= 0 ? i : 0, 1);
  }
}

/** 用途のグループ (参加中) */
export function lineGroupsFor(db: Pick<Database, "settings">, purpose: LineGroupPurpose, storeId?: StoreId): LineGroup[] {
  return lineGroups(db).filter((g) => g.status === "joined" && g.purpose === purpose && (!storeId || !g.storeId || g.storeId === storeId));
}

/** クレーム・手直し報告のグループに届いた、まだ記録にしていない報告 (新しい順) */
export interface LineReport {
  group: LineGroup;
  message: PendingLineMessage;
}
export function pendingLineReports(db: Pick<Database, "settings">, canSee: (storeId: StoreId | undefined) => boolean): LineReport[] {
  return lineGroups(db)
    .filter((g) => g.purpose === "quality" && canSee(g.storeId))
    .flatMap((g) => g.pending.filter((m) => !m.handledAt && (m.text.trim() || m.type === "image" || m.type === "file")).map((message) => ({ group: g, message })))
    .sort((a, b) => b.message.at.localeCompare(a.message.at));
}

/** 「グループ ID:メッセージ ID」の形 (画面のリンク・フォームで使う) */
export function lineMessageRef(groupId: string, messageId: string): string {
  return `${groupId}:${messageId}`;
}
export function parseLineMessageRef(ref: string): { groupId: string; messageId: string } | null {
  const m = ref.match(/^([CR][0-9a-f]{32}):([A-Za-z0-9_-]{1,64})$/);
  return m ? { groupId: m[1], messageId: m[2] } : null;
}

/** 保留のメッセージを対応済みにする (mutate の中で呼ぶ)。見つからなければ false */
export function markLineMessageHandled(db: Database, ref: string, by: string, recordRef?: string): boolean {
  const p = parseLineMessageRef(ref);
  if (!p) return false;
  const g = findLineGroup(db, p.groupId);
  const m = g?.pending.find((x) => x.id === p.messageId);
  if (!g || !m) return false;
  m.handledAt = new Date().toISOString();
  m.handledBy = by;
  if (recordRef) m.recordRef = recordRef;
  touchLineGroups(db, by);
  return true;
}
