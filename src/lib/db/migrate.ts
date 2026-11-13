import type { Database } from "./types";
import { normTime } from "@/lib/calendar";

/** 現在のデータ形式のバージョン (seed.ts の meta.version もこの値) */
export const DATA_VERSION = 3;

/**
 * 旧バージョンのデータを現在の形式にそろえる。読み込み時に 1 回だけ実行する。
 * v2 (全社カレンダー): 予定の時刻を HH:MM に統一、受注の施工予定と連動する予定に source="order"、案件 ID の補完
 * v3 (クライアント資料の取込): 休業日・アンケート・資料台帳・写真台帳のコレクション
 * (添付ファイル attachments は後から追加したコレクション。無ければ空で作る)
 */
export function migrateDb(db: Database): Database {
  const version = db.meta?.version ?? 1;
  if (version < 2) migrateV2(db);
  for (const key of ["holidays", "surveys", "sourceFiles", "photoAlbums", "attachments"] as const) {
    if (!Array.isArray(db[key])) (db as unknown as Record<string, unknown[]>)[key] = [];
  }
  if (version < DATA_VERSION) db.meta = { ...db.meta, version: DATA_VERSION };
  return db;
}

function migrateV2(db: Database) {
  db.schedule = Array.isArray(db.schedule) ? db.schedule : [];
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const linked = new Set<string>();
  for (const e of db.schedule) {
    e.startTime = normTime(e.startTime);
    e.endTime = e.startTime ? normTime(e.endTime) : undefined;
    if (!Array.isArray(e.assigneeIds)) e.assigneeIds = [];
    if (e.endDate && e.endDate <= e.date) e.endDate = undefined;
    const o = e.orderId ? orders.get(e.orderId) : undefined;
    if (o) {
      e.quoteId ??= o.quoteId;
      e.inquiryId ??= o.quoteId ? quotes.get(o.quoteId)?.inquiryId : undefined;
      e.customerId ??= o.customerId;
      if (e.kind === "install" && !e.source && !linked.has(o.id)) {
        e.source = "order";
        linked.add(o.id);
      }
      continue;
    }
    if (e.kind === "survey" && e.customerId && !e.inquiryId) {
      const from = new Date(e.date);
      from.setDate(from.getDate() - 14);
      const inq = db.inquiries
        .filter((i) => i.customerId === e.customerId && i.receivedAt.slice(0, 10) <= e.date && new Date(i.receivedAt) >= from)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
      if (inq) {
        e.inquiryId = inq.id;
        const q = inq.quoteId ? quotes.get(inq.quoteId) : undefined;
        if (q) {
          e.quoteId = q.id;
          e.orderId = q.orderId;
        }
      }
    }
  }
}
