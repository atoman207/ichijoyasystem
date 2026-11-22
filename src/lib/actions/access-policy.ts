"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import { approverRole, canManageAccessPolicy, canRequestRecordView } from "@/lib/auth/permissions";
import { ACCESS_POLICY_ID, CUSTOMER_POLICY_LABEL, FIGURE_POLICY_LABEL, GRANT_DAYS_MAX, GRANT_DAYS_MIN, accessPolicy, normalizeAccessPolicy } from "@/lib/access-policy";
import { customerAccessInfo, pendingViewRequest } from "@/lib/case-access";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { fail, requireActionUser, str, withMsg } from "./guards";

/** 閲覧の範囲 (経営の数字・顧客情報) の設定: 管理者 (src/lib/access-policy.ts) */
export async function saveAccessPolicy(formData: FormData) {
  const user = await requireActionUser();
  const back = "/settings?tab=users";
  if (!canManageAccessPolicy(user)) fail(back, "閲覧の範囲は管理者が変更できます。");
  const figures = str(formData, "figures");
  const customers = str(formData, "customers");
  const days = Number(str(formData, "grantDays") || "7");
  if (!["all", "store"].includes(figures) || !["all", "approval", "open"].includes(customers)) fail(back, "閲覧の範囲を選んでください。");
  if (!Number.isInteger(days) || days < GRANT_DAYS_MIN || days > GRANT_DAYS_MAX) fail(back, `承認のあと見られる日数は ${GRANT_DAYS_MIN}〜${GRANT_DAYS_MAX} 日で入力してください。`);
  const next = normalizeAccessPolicy({ figures, customers, grantDays: days });
  let changed = false;
  await mutate((db) => {
    const before = accessPolicy(db);
    const changes = (["figures", "customers", "grantDays"] as const).filter((k) => before[k] !== next[k]).map((k) => ({ field: `accessPolicy.${k}`, before: before[k], after: next[k] }));
    if (!changes.length) return;
    changed = true;
    const now = nowIso();
    const value = { figures: next.figures, customers: next.customers, grantDays: next.grantDays };
    const row = db.settings.find((s) => s.id === ACCESS_POLICY_ID);
    if (row) {
      row.value = value;
      row.updatedBy = user.id;
      row.updatedAt = now;
    } else db.settings.push({ id: ACCESS_POLICY_ID, value, updatedBy: user.id, updatedAt: now });
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: ACCESS_POLICY_ID,
      entityLabel: "閲覧の範囲",
      summary: `閲覧の範囲を変更 (経営の数字: ${FIGURE_POLICY_LABEL[next.figures]} / 顧客情報: ${CUSTOMER_POLICY_LABEL[next.customers]}${next.customers === "approval" ? ` / 承認のあと ${next.grantDays} 日` : ""})`,
      storeId: "hq",
      changes,
    });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, changed ? "閲覧の範囲を保存しました。すぐに全員の画面・AI アシスタントに反映されます。" : "変更はありませんでした。"));
}

/**
 * ほかの店舗の完了した案件のお客様の閲覧を申請する (閲覧の範囲 = 承認制のとき。src/lib/case-access.ts)
 * 承認者は所属店舗の店長 (いなければ管理者)。承認されると、決まった日数だけ閲覧のみで見られる
 */
export async function requestRecordView(customerId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/customers/${customerId}`;
  const reason = str(formData, "reason");
  if (reason.length < 2) fail(back, "閲覧が必要な理由を入力してください (例: 前回の施工内容を確かめたい)。");
  let approvalId = "";
  let approver = "";
  await mutate((db) => {
    const policy = accessPolicy(db);
    if (!canRequestRecordView(user, policy)) fail(back, "閲覧の申請はできません (閲覧の範囲の設定が承認制ではありません)。");
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail("/customers", "お客様が見つかりません。");
    const info = customerAccessInfo(db, user, c);
    if (info.access !== "none") fail(back, "このお客様の情報はすでに閲覧できます。");
    if (pendingViewRequest(db, user, c.id)) fail(back, "このお客様の閲覧の申請は承認待ちです。");
    const role = approverRole(db.users, user.storeId, false, user.id);
    const store = db.stores.find((s) => s.id === c.storeId);
    approvalId = newId("ap");
    approver = role === "admin" ? "管理者" : "店長";
    db.approvals.push({
      id: approvalId,
      type: "record_view",
      targetId: c.id,
      title: `${c.code} ${c.name} 様 (${store?.name ?? c.storeId})`,
      amount: 0,
      // 承認者は申請者の上司 (所属店舗の店長)。お客様の店舗ではない
      storeId: user.storeId,
      requestedBy: user.id,
      requiredRole: role,
      status: "pending",
      requestComment: reason.slice(0, 500),
      createdAt: nowIso(),
    });
    addAudit(db, { userId: user.id, action: "submit", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `顧客情報の閲覧を申請 (${approver}承認。理由: ${reason.slice(0, 120)})`, storeId: c.storeId });
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  revalidatePath("/approvals");
  redirect(withMsg(back, `閲覧を${approver}に申請しました。承認されると、このお客様の情報を見られます。`));
}
