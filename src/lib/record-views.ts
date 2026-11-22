import "server-only";
import { after } from "next/server";
import { addAudit, mutate } from "@/lib/db/store";
import type { StoreId, User } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import type { AccessInfo } from "@/lib/case-access";

/**
 * 顧客情報の閲覧の記録 (閲覧の範囲の設定 src/lib/access-policy.ts で、ほかの店舗の顧客情報を見られるようにしたため)
 * ------------------------------------------------------------
 * - ほかの店舗の記録 (閲覧のみ = access が view) を開いたときに、変更履歴に「閲覧」(action = view) を残す。自店舗の記録は残さない (もともと見られる範囲)
 * - 同じ人・同じ記録は 1 日に 1 回だけ (書き込みを増やしすぎないため)。応答のあと (after) に書くので、画面の表示は遅くならない
 * - 記録の店舗 (storeId) を付けるので、その店舗の店長・管理者が 変更履歴 (操作 = 閲覧) と記録の画面の変更履歴で確かめられる
 */

const gv = globalThis as typeof globalThis & { __ichijoyaRecordViews?: Set<string> };
const logged: Set<string> = (gv.__ichijoyaRecordViews ??= new Set());

const WHY: Record<NonNullable<AccessInfo["basis"]>, string> = {
  all: "ほかの店舗の記録",
  open: "ほかの店舗の進行中の案件",
  grant: "閲覧の申請の承認による",
};

export interface ViewedRecord {
  entity: "customer" | "inquiry" | "quote" | "order" | "invoice";
  id: string;
  label: string;
  storeId: StoreId;
}

/** 同じ人・同じ記録・同じ日の 2 回目以降は記録しない */
export function shouldLogRecordView(userId: string, rec: Pick<ViewedRecord, "entity" | "id">, existing: { userId: string; action: string; entity: string; entityId: string; at: string }[], now = new Date()): boolean {
  const day = toDateKey(now);
  const key = `${userId}:${rec.entity}:${rec.id}:${day}`;
  if (logged.has(key)) return false;
  logged.add(key);
  if (logged.size > 20000) logged.clear();
  // ほかのインスタンス (3000 番と 3001 番など) がすでに書いていれば書かない
  return !existing.some((l) => l.action === "view" && l.userId === userId && l.entity === rec.entity && l.entityId === rec.id && toDateKey(new Date(l.at)) === day);
}

const ENTITY_WORD: Record<ViewedRecord["entity"], string> = { customer: "顧客", inquiry: "問い合わせ", quote: "見積", order: "受注", invoice: "請求書" };

/** ほかの店舗の記録を閲覧のみで開いたときに呼ぶ (画面の Server Component から) */
export function logRecordView(user: User, info: AccessInfo, rec: ViewedRecord, existing: Parameters<typeof shouldLogRecordView>[2]): void {
  if (info.access !== "view" || !shouldLogRecordView(user.id, rec, existing)) return;
  const why = info.basis ? WHY[info.basis] : "ほかの店舗の記録";
  after(async () => {
    await mutate((d) => {
      addAudit(d, { userId: user.id, action: "view", entity: rec.entity, entityId: rec.id, entityLabel: rec.label, summary: `${ENTITY_WORD[rec.entity]}を閲覧 (${why})`, storeId: rec.storeId });
    }).catch((err) => console.warn("[record-views] log failed:", (err as Error).message));
  });
}
