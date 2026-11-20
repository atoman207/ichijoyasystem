import type { AuditAction, AuditLog, Database, StoreId, User } from "@/lib/db/types";
import { canManageIntegrations, canViewAuditEntry } from "@/lib/auth/permissions";
import { AUDIT_ACTION_LABEL, ENTITY_LABEL } from "@/lib/constants";
import { recordHref, type RecordType } from "@/lib/assistant/search";

/**
 * データ台帳: 社内の活動 (誰が・いつ・何をしたか) の集計
 * ------------------------------------------------------------
 * 元は変更履歴 (audit_logs。画面・取込・AI の確認のカードの操作がすべて書く) と送信履歴 (deliveries。管理者だけ)。
 * 見られる範囲は変更履歴の画面と同じ (permissions.ts の canViewAuditEntry: 店舗のロールは自店舗・本人の分)。
 * データ台帳の画面「活動」と AI アシスタントの道具 data_registry (view = activity) が使う。数字はここで数え、AI に数えさせない
 */

const RECORD_TYPES = new Set<RecordType>(["customer", "inquiry", "quote", "order", "invoice", "payment", "schedule", "expense", "purchase", "supplier", "purchase_order", "comm", "thread", "knowledge", "quality", "survey", "review", "fax"]);

export interface ActivityQuery {
  /** YYYY-MM-DD (日本時間)。なければ 7 日前から */
  from?: string;
  /** YYYY-MM-DD (日本時間)。なければ今日 */
  to?: string;
  userId?: string;
  storeId?: StoreId;
  entity?: string;
  action?: AuditAction;
  /** 言葉 (要約・対象の名前) */
  q?: string;
  limit?: number;
}

export interface ActivityItem {
  at: string;
  date: string;
  userId: string;
  userName: string;
  action: AuditAction;
  actionLabel: string;
  entity: string;
  entityLabel: string;
  target: string;
  summary: string;
  storeId?: StoreId;
  href?: string;
}

export interface ActivityReport {
  from: string;
  to: string;
  total: number;
  byAction: { action: string; label: string; count: number }[];
  byEntity: { entity: string; label: string; count: number }[];
  byUser: { userId: string; name: string; count: number }[];
  byStore: { storeId: string; name: string; count: number }[];
  byDay: { date: string; count: number }[];
  /** 0〜23 時 (日本時間) */
  byHour: number[];
  notable: { deletes: number; imports: number; exports: number; approvals: number; rejects: number; offHours: number; logins: number; failedDeliveries?: number; sentDeliveries?: number };
  recent: ActivityItem[];
  /** 店舗のロールなど、見られる範囲が絞られているとき */
  scoped: boolean;
}

/** 日本時間の日付・時 */
export function jstParts(iso: string): { date: string; hour: number } {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

const todayJst = (now = new Date()) => jstParts(now.toISOString()).date;
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function activityReport(db: Database, user: User, query: ActivityQuery = {}, now = new Date()): ActivityReport {
  const to = query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : todayJst(now);
  const from = query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : addDays(to, -6);
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const stores = new Map(db.stores.map((s) => [s.id, s.name]));
  const q = query.q?.normalize("NFKC").toLowerCase().trim();
  const scoped = !(user.role === "admin" || user.role === "hq_staff");

  const logs: (AuditLog & { date: string; hour: number })[] = [];
  for (const l of db.auditLogs) {
    const { date, hour } = jstParts(l.at);
    if (date < from || date > to) continue;
    if (!canViewAuditEntry(user, l)) continue;
    if (query.userId && l.userId !== query.userId) continue;
    if (query.storeId && l.storeId !== query.storeId) continue;
    if (query.entity && l.entity !== query.entity) continue;
    if (query.action && l.action !== query.action) continue;
    if (q && !`${l.summary} ${l.entityLabel} ${users.get(l.userId) ?? ""}`.normalize("NFKC").toLowerCase().includes(q)) continue;
    logs.push({ ...l, date, hour });
  }
  logs.sort((a, b) => b.at.localeCompare(a.at));

  const count = <K extends string>(key: (l: (typeof logs)[number]) => K | undefined) => {
    const m = new Map<K, number>();
    for (const l of logs) {
      const k = key(l);
      if (k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const l of logs) byHour[l.hour]++;
  const days: { date: string; count: number }[] = [];
  const perDay = new Map(count((l) => l.date));
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push({ date: d, count: perDay.get(d) ?? 0 });

  const notable: ActivityReport["notable"] = {
    deletes: logs.filter((l) => l.action === "delete").length,
    imports: logs.filter((l) => l.action === "import").length,
    exports: logs.filter((l) => l.action === "export").length,
    approvals: logs.filter((l) => l.action === "approve").length,
    rejects: logs.filter((l) => l.action === "reject").length,
    // 業務時間 (7〜20 時) の外の操作 (ログインを除く)
    offHours: logs.filter((l) => l.action !== "login" && (l.hour < 7 || l.hour >= 20)).length,
    logins: logs.filter((l) => l.action === "login").length,
  };
  if (canManageIntegrations(user)) {
    const dels = db.deliveries.filter((d) => {
      const { date } = jstParts(d.createdAt);
      return date >= from && date <= to;
    });
    notable.failedDeliveries = dels.filter((d) => d.status === "failed").length;
    notable.sentDeliveries = dels.filter((d) => d.status === "sent").length;
  }

  const recent: ActivityItem[] = logs.slice(0, Math.max(1, Math.min(200, query.limit ?? 30))).map((l) => {
    const type = l.entity as RecordType;
    const exists = RECORD_TYPES.has(type) && l.action !== "delete";
    return {
      at: l.at,
      date: l.date,
      userId: l.userId,
      userName: users.get(l.userId) ?? (l.userId === "system" ? "システム" : l.userId),
      action: l.action,
      actionLabel: AUDIT_ACTION_LABEL[l.action] ?? l.action,
      entity: l.entity,
      entityLabel: ENTITY_LABEL[l.entity] ?? l.entity,
      target: l.entityLabel,
      summary: l.summary,
      storeId: l.storeId,
      href: exists ? recordHref(type, l.entityId, db) : undefined,
    };
  });

  return {
    from,
    to,
    total: logs.length,
    byAction: count((l) => l.action).map(([action, n]) => ({ action, label: AUDIT_ACTION_LABEL[action as AuditAction] ?? action, count: n })),
    byEntity: count((l) => l.entity).map(([entity, n]) => ({ entity, label: ENTITY_LABEL[entity] ?? entity, count: n })),
    byUser: count((l) => l.userId).map(([userId, n]) => ({ userId, name: users.get(userId) ?? (userId === "system" ? "システム" : userId), count: n })),
    byStore: count((l) => l.storeId).map(([storeId, n]) => ({ storeId, name: stores.get(storeId as StoreId) ?? storeId, count: n })),
    byDay: days,
    byHour,
    notable,
    recent,
    scoped,
  };
}

/** AI に渡す文 (表は数字だけ。言い換えない) */
export function activityText(r: ActivityReport, opts: { recent?: number } = {}): string {
  const top = <T extends { count: number }>(rows: T[], name: (x: T) => string, n = 8) => rows.slice(0, n).map((x) => `${name(x)} ${x.count}`).join("・") || "なし";
  const busiest = [...r.byDay].sort((a, b) => b.count - a.count)[0];
  const lines = [
    `## 社内の活動 (変更履歴) ${r.from}〜${r.to}${r.scoped ? " ※あなたの閲覧の範囲 (自店舗・本人の操作) だけ" : ""}`,
    `- 操作の件数: ${r.total} 件${busiest && busiest.count ? ` (一番多い日 ${busiest.date} ${busiest.count} 件)` : ""}`,
    `- 操作の種類: ${top(r.byAction, (x) => x.label)}`,
    `- 対象: ${top(r.byEntity, (x) => x.label)}`,
    `- 人: ${top(r.byUser, (x) => x.name, 12)}`,
    r.byStore.length ? `- 店舗: ${top(r.byStore, (x) => x.name)}` : "",
    `- 注意して見るもの: 削除 ${r.notable.deletes}・取込 ${r.notable.imports}・書き出し ${r.notable.exports}・承認 ${r.notable.approvals}・却下 ${r.notable.rejects}・業務時間外 (7 時前・20 時以降) ${r.notable.offHours}・ログイン ${r.notable.logins}${r.notable.failedDeliveries !== undefined ? `・送信 ${r.notable.sentDeliveries} (失敗 ${r.notable.failedDeliveries})` : ""}`,
    "",
    `### 最近の操作 (新しい順 ${Math.min(opts.recent ?? 15, r.recent.length)} 件)`,
    ...r.recent.slice(0, opts.recent ?? 15).map((x) => `- ${x.at.slice(0, 16).replace("T", " ")} UTC ${x.userName} ${x.actionLabel} ${x.entityLabel}「${x.target}」 ${x.summary}${x.href ? ` [開く](${x.href})` : ""}`),
  ];
  return lines.filter((l) => l !== "").join("\n");
}
