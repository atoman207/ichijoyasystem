import type { Database, Order, OrderWorkStaff, ScheduleKind } from "@/lib/db/types";

/**
 * 作業の担当 (実績) (お客様のご要望 2026-11-25「④ 作業担当者の変更とインセンティブ」)
 * ------------------------------------------------------------
 * 誰が 現地見積 (見積り・現地調査・現場見積・採寸)・引取・納品・施工 をしたか。1 つの作業を複数人ですることもある。
 * - 受注に保存した値 (Order.workStaff) がなければ、案件 (問い合わせ → 見積 → 受注) の予定表の予定の担当者から自動で決める
 *   (現地見積の予定がなければ見積の担当者、施工の予定がなければ受注の施工担当)。予定表で担当者を直すと自動の値も変わる
 * - 施工完了・売上確定のときに画面で確かめて保存する (confirmedAt)。保存した値が正しいデータ: インセンティブ (アンケートの ②③ の担当)
 *   と経営ダッシュボードの担当 (order-staff.ts) に使う
 * このファイルは画面 (クライアント)・サーバー・テストから読むため、サーバー専用の import をしない
 */

export const WORK_ROLES = ["survey", "pickup", "delivery", "install"] as const;
export type WorkRole = (typeof WORK_ROLES)[number];

export const WORK_ROLE_LABEL: Record<WorkRole, string> = { survey: "現地見積", pickup: "引取", delivery: "納品", install: "施工" };
export const WORK_ROLE_HINT: Record<WorkRole, string> = {
  survey: "見積り・現地調査・現場見積・採寸に行った人",
  pickup: "畳・襖などを引き取りに行った人",
  delivery: "納品・取り付けに行った人",
  install: "リフォーム・取付などの施工をした人",
};

const KIND_ROLE: Partial<Record<ScheduleKind, WorkRole>> = { survey: "survey", site_survey: "survey", onsite_quote: "survey", measure: "survey", pickup: "pickup", delivery: "delivery", install: "install" };

export const workRoleOfKind = (k: ScheduleKind): WorkRole | undefined => KIND_ROLE[k];

const uniq = (ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => Boolean(x)))];

/** 予定表の予定・見積・受注から決めた担当 (保存した値がないとき) */
export function derivedWorkStaff(db: Pick<Database, "schedule" | "quotes" | "inquiries">, o: Pick<Order, "id" | "quoteId" | "workerIds">): OrderWorkStaff {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const inquiryId = q?.inquiryId;
  const out: OrderWorkStaff = { survey: [], pickup: [], delivery: [], install: [] };
  const events = db.schedule.filter((e) => e.orderId === o.id || (q && e.quoteId === q.id) || (inquiryId && e.inquiryId === inquiryId)).sort((a, b) => a.date.localeCompare(b.date));
  for (const e of events) {
    const role = KIND_ROLE[e.kind];
    if (role) out[role] = uniq([...out[role], ...e.assigneeIds]);
  }
  if (!out.survey.length && q) out.survey = uniq([q.estimatorId ?? q.createdBy]);
  if (!out.install.length && !out.pickup.length && !out.delivery.length) out.install = uniq(o.workerIds ?? []);
  return out;
}

/** 受注の作業の担当 (保存した値 → 自動)。source = saved / auto */
export function workStaffOf(db: Pick<Database, "schedule" | "quotes" | "inquiries">, o: Pick<Order, "id" | "quoteId" | "workerIds" | "workStaff">): OrderWorkStaff & { source: "saved" | "auto" } {
  if (o.workStaff) return { ...o.workStaff, source: "saved" };
  return { ...derivedWorkStaff(db, o), source: "auto" };
}

/** 納品担当 (アンケートの ②③ の評価対象): 引取・納品・施工をした人 */
export function deliveryStaffOf(ws: Pick<OrderWorkStaff, "pickup" | "delivery" | "install">): string[] {
  return uniq([...ws.delivery, ...ws.install, ...ws.pickup]);
}

/** フォームの値 (workStaff.<役割> = 社員 ID。複数) → 作業の担当 */
export function workStaffFromForm(fd: FormData, activeIds: Set<string>, max = 8): Omit<OrderWorkStaff, "confirmedAt" | "confirmedBy" | "updatedAt" | "updatedBy"> {
  const pick = (role: WorkRole) => uniq(fd.getAll(`workStaff.${role}`).map(String)).filter((id) => activeIds.has(id)).slice(0, max);
  return { survey: pick("survey"), pickup: pick("pickup"), delivery: pick("delivery"), install: pick("install") };
}

/** 2 つの作業の担当が同じか (並びは問わない) */
export function sameWorkStaff(a: Pick<OrderWorkStaff, WorkRole> | undefined, b: Pick<OrderWorkStaff, WorkRole> | undefined): boolean {
  const key = (x?: Pick<OrderWorkStaff, WorkRole>) => WORK_ROLES.map((r) => [...(x?.[r] ?? [])].sort().join(",")).join("|");
  return key(a) === key(b);
}
