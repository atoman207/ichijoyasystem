import type { Database } from "@/lib/db/types";

/**
 * LINE のグループ・複数人トーク (施工現場ごとのグループなど)
 * ------------------------------------------------------------
 * - 公式アカウントをグループに招待すると、Webhook の join で登録する (settings テーブルの id = "line_groups")
 * - 受注 (案件) と協力業者・仕入先にひも付けると、そのグループのメッセージ・写真・資料を案件のやりとり履歴・現場写真に残す
 * - ひも付ける前に届いたメッセージは pending に残し (新しい 50 件まで)、ひも付けたときに履歴へ移す
 * - 受注の画面から、ひも付けたグループへ LINE で送れる
 */

export const LINE_GROUPS_ID = "line_groups";
export const MAX_PENDING = 50;

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
