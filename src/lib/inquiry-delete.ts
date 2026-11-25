import type { Database, Inquiry, ScheduleEvent } from "@/lib/db/types";

/**
 * 問い合わせの削除 (誤って登録した問い合わせ。お客様のご要望 2026-11-25)
 * ------------------------------------------------------------
 * - 店長以上 (店長・本部・管理者) は承認なしで削除、店舗スタッフは所属店舗の店長の承認 (承認の type = inquiry_delete)。権限は permissions.ts
 * - 削除しても記録は消さない (Inquiry.deleted に 誰が・いつ・理由・削除の前の状態)。状態は「完了」にし、通常の一覧・集計・候補に出さない (isLiveInquiry)。
 *   問い合わせの一覧で検索したときだけ「削除済み」として出す。変更履歴にも残る
 * - 見積・受注にした問い合わせは削除できない (見積の失注・受注のキャンセルで扱う)
 * - この問い合わせだけにひも付いた予定 (見積・受注のない予定) はあわせて削除する (誤って登録した予定が予定表に残らないように)
 * - 管理者は元に戻せる (状態を削除の前に戻す。消した予定は戻さない)
 * import は型だけ (画面・サーバー・テストで共通)
 */

export const isDeletedInquiry = (i: Pick<Inquiry, "deleted"> | undefined): boolean => Boolean(i?.deleted);
export const isLiveInquiry = (i: Pick<Inquiry, "deleted">): boolean => !i.deleted;

/** 削除の理由の候補 (画面の選択肢) */
export const INQUIRY_DELETE_REASONS = ["誤って登録", "二重に登録", "練習・テストの登録", "お客様の取り消し (案件にならない)"] as const;

/** 削除できない理由 (削除できるときは undefined) */
export function inquiryDeleteBlocker(db: Pick<Database, "quotes" | "orders">, inq: Inquiry): string | undefined {
  if (inq.deleted) return "この問い合わせはすでに削除されています。";
  const quotes = db.quotes.filter((q) => (q.id === inq.quoteId || q.inquiryId === inq.id) && q.status !== "rejected" && q.status !== "expired");
  if (quotes.length) return `見積 (${quotes.map((q) => q.number).join("・")}) のある問い合わせは削除できません。見積の画面で失注にするか、見積を削除してから削除してください。`;
  const orders = db.orders.filter((o) => o.status !== "cancelled" && db.quotes.some((q) => q.id === o.quoteId && q.inquiryId === inq.id));
  if (orders.length) return `受注 (${orders.map((o) => o.number).join("・")}) のある問い合わせは削除できません。`;
  return undefined;
}

/** あわせて削除する予定 (この問い合わせだけにひも付いた予定。見積・受注の予定は除く) */
export function inquiryOnlyEvents(db: Pick<Database, "schedule">, inq: Pick<Inquiry, "id">): ScheduleEvent[] {
  return db.schedule.filter((e) => e.inquiryId === inq.id && !e.quoteId && !e.orderId);
}

/** 承認待ちの削除の申請 */
export const pendingInquiryDelete = (db: Pick<Database, "approvals">, inquiryId: string) => db.approvals.find((a) => a.type === "inquiry_delete" && a.targetId === inquiryId && a.status === "pending");

/**
 * 削除する (mutate の中で呼ぶ)。by = 削除した人 (申請の承認では申請した人)、approvedBy = 承認した人。
 * 予定を消した件数を返す。変更履歴は呼び出し側で残す
 */
export function applyInquiryDelete(db: Database, inq: Inquiry, opts: { by: string; at: string; reason?: string; approvedBy?: string; approvalId?: string }): number {
  const events = inquiryOnlyEvents(db, inq);
  const ids = new Set(events.map((e) => e.id));
  if (ids.size) db.schedule = db.schedule.filter((e) => !ids.has(e.id));
  inq.deleted = {
    at: opts.at,
    by: opts.by,
    ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}),
    ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
    ...(opts.reason?.trim() ? { reason: opts.reason.trim().slice(0, 200) } : {}),
    prevStatus: inq.status,
    ...(ids.size ? { events: ids.size } : {}),
  };
  inq.status = "closed";
  inq.updatedAt = opts.at;
  return ids.size;
}

/** 元に戻す (管理者)。状態を削除の前に戻す (消した予定は戻さない) */
export function restoreInquiry(inq: Inquiry, at: string): void {
  if (!inq.deleted) return;
  inq.status = inq.deleted.prevStatus;
  inq.deleted = undefined;
  inq.updatedAt = at;
}

/** 削除の表示 (問い合わせの画面・一覧の検索) */
export function deletedLabel(inq: Pick<Inquiry, "deleted">, userName: (id: string) => string): string {
  const d = inq.deleted;
  if (!d) return "";
  const at = new Date(d.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${at} ${userName(d.by)} さんが削除${d.approvedBy ? ` (${userName(d.approvedBy)} さんが承認)` : ""}${d.reason ? ` · 理由: ${d.reason}` : ""}${d.events ? ` · 予定 ${d.events} 件もあわせて削除` : ""}`;
}
