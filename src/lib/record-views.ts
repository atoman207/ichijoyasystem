import "server-only";
import { addAudit, mutate } from "@/lib/db/store";
import type { StoreId, User } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import type { AccessInfo } from "@/lib/case-access";
import { canAccessStore } from "@/lib/auth/permissions";

/**
 * 顧客情報の閲覧の記録 (お客様のご要望 2026-11-23「■10. 権限設定」: 全社員に公開 + 閲覧履歴の記録。自店舗の顧客の閲覧も記録する)
 * ------------------------------------------------------------
 * - 顧客・問い合わせ・見積・受注・請求書の画面を開いたときに、変更履歴に「閲覧」(action = view) を残す。
 *   自店舗の記録 (編集できる = access が edit) も、ほかの店舗の記録 (閲覧のみ = view) も残す。開けない記録 (none) は残さない
 * - 同じ人・同じ記録は 1 日に 1 回だけ (書き込みを増やしすぎないため)
 * - 書き込みはまとめて行う (開くたびにデータベースへ書かない): 15 秒ごとに、それまでの閲覧を 1 回の保存で書く。
 *   閲覧の日時は画面を開いた時刻。サーバーの再起動の直前 15 秒の閲覧は残らないことがある
 * - 記録の店舗 (storeId) を付けるので、その店舗の店長・管理者が 変更履歴 (操作 = 閲覧) と記録の画面の変更履歴で確かめられる
 */

const FLUSH_MS = 15_000;

interface PendingView {
  userId: string;
  rec: ViewedRecord;
  summary: string;
  at: string;
}

const gv = globalThis as typeof globalThis & { __ichijoyaRecordViews?: Set<string>; __ichijoyaViewQueue?: PendingView[]; __ichijoyaViewTimer?: ReturnType<typeof setTimeout> | null };
const logged: Set<string> = (gv.__ichijoyaRecordViews ??= new Set());
const queue: PendingView[] = (gv.__ichijoyaViewQueue ??= []);

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

type ExistingLog = { userId: string; action: string; entity: string; entityId: string; at: string };

const sameView = (l: ExistingLog, userId: string, rec: Pick<ViewedRecord, "entity" | "id">, day: string) => l.action === "view" && l.userId === userId && l.entity === rec.entity && l.entityId === rec.id && toDateKey(new Date(l.at)) === day;

/** 同じ人・同じ記録・同じ日の 2 回目以降は記録しない */
export function shouldLogRecordView(userId: string, rec: Pick<ViewedRecord, "entity" | "id">, existing: ExistingLog[], now = new Date()): boolean {
  const day = toDateKey(now);
  const key = `${userId}:${rec.entity}:${rec.id}:${day}`;
  if (logged.has(key)) return false;
  logged.add(key);
  if (logged.size > 20000) logged.clear();
  // ほかのインスタンス (3000 番と 3001 番など) がすでに書いていれば書かない (新しい記録から探す)
  for (let i = existing.length - 1; i >= 0; i--) {
    const l = existing[i];
    if (sameView(l, userId, rec, day)) return false;
    if (l.at && toDateKey(new Date(l.at)) < day && i < existing.length - 5000) break;
  }
  return true;
}

const ENTITY_WORD: Record<ViewedRecord["entity"], string> = { customer: "顧客", inquiry: "問い合わせ", quote: "見積", order: "受注", invoice: "請求書" };

/** 閲覧の記録の要約 (自店舗の記録 = 「閲覧」、ほかの店舗の記録 = 理由つき) */
export function viewSummary(info: Pick<AccessInfo, "access" | "basis">, rec: Pick<ViewedRecord, "entity">): string {
  if (info.access === "edit") return `${ENTITY_WORD[rec.entity]}を閲覧`;
  return `${ENTITY_WORD[rec.entity]}を閲覧 (${info.basis ? WHY[info.basis] : "ほかの店舗の記録"})`;
}

async function flush(): Promise<void> {
  gv.__ichijoyaViewTimer = null;
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  await mutate((d) => {
    for (const v of batch) {
      const day = toDateKey(new Date(v.at));
      if (d.auditLogs.some((l) => sameView(l, v.userId, v.rec, day))) continue;
      addAudit(d, { userId: v.userId, action: "view", entity: v.rec.entity, entityId: v.rec.id, entityLabel: v.rec.label, summary: v.summary, storeId: v.rec.storeId });
      // 閲覧の日時は画面を開いた時刻にする (まとめて書くため)
      d.auditLogs[d.auditLogs.length - 1].at = v.at;
    }
  }).catch((err) => console.warn("[record-views] log failed:", (err as Error).message));
}

/** 記録の画面 (Server Component) から呼ぶ。開ける記録 (edit / view) の閲覧を、1 人・1 件・1 日に 1 回残す */
export function logRecordView(user: User, info: AccessInfo, rec: ViewedRecord, existing: ExistingLog[]): void {
  if (info.access === "none" || !shouldLogRecordView(user.id, rec, existing)) return;
  // 店長がほかの店舗の記録 (顧客・問い合わせ・見積・受注は変更もできる = edit) を開いたときも、ほかの店舗の記録と分かるようにする
  const summary = info.access === "edit" && !canAccessStore(user, rec.storeId) ? `${viewSummary(info, rec)} (ほかの店舗の記録)` : viewSummary(info, rec);
  queue.push({ userId: user.id, rec, summary, at: new Date().toISOString() });
  if (!gv.__ichijoyaViewTimer) {
    gv.__ichijoyaViewTimer = setTimeout(() => void flush(), FLUSH_MS);
    gv.__ichijoyaViewTimer.unref?.();
  }
}
