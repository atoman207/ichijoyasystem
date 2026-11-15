import "server-only";
import { getDb } from "@/lib/db/store";
import { approvalRequestNotices } from "./events";
import { sendAndRecord } from "./send";

/** 新しい承認依頼を承認者へ通知する (申請を保存した後に呼ぶ。設定がなければ何も送らない) */
export async function notifyNewApprovals(ids: string[], userId: string): Promise<void> {
  if (!ids.length) return;
  const db = getDb();
  const items = ids.flatMap((id) => {
    const a = db.approvals.find((x) => x.id === id);
    return a && a.status === "pending" ? approvalRequestNotices(db, a) : [];
  });
  await sendAndRecord(items, userId);
}
