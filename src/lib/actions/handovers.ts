"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, mutate } from "@/lib/db/store";
import { orderEditable } from "@/lib/db/schedule";
import { completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { propagateOrderSite } from "@/lib/maps/store";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { AUTO_APPROVAL_NOTE } from "@/lib/approval-decide";
import { cleanHandovers } from "@/lib/handover";
import { planConflicts, savePlan } from "@/lib/handover-save";
import { assertCaseStore, fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 受注の画面の「引取・納品の日程」(品目ごとの引取日・納品日。src/lib/handover.ts)
 * - はじめて入れる日程はすぐに予定表へ反映、登録済みの日程の変更は承認の申請 (店長。店長の申請は管理者。管理者は承認を省略)
 * - 担当 (施工担当) と現場住所もここで変える (担当は承認なし)
 */
export async function saveOrderHandovers(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  let raw: unknown;
  try {
    raw = JSON.parse(str(formData, "handovers") || "[]");
  } catch {
    fail(back, "日程の形式が正しくありません。もう一度入力してください。");
  }
  const parsed = cleanHandovers(raw);
  if (parsed.error) fail(back, parsed.error);
  const workerIds = [...new Set(formData.getAll("workerIds").map(String).filter(Boolean))];
  const reason = str(formData, "reason").slice(0, 300);
  const siteAddress = str(formData, "siteAddress");

  const db0 = getDb();
  const o0 = db0.orders.find((x) => x.id === id);
  if (!o0) fail("/orders", "受注が見つかりません。");
  // 店長はほかの店舗の受注の日程も変更できる (permissions.ts の canEditCaseStore。変更の申請の承認は管理者)
  assertCaseStore(user, o0.storeId, back);
  if (!orderEditable(o0)) fail(back, "完了・キャンセルした案件の日程は変更できません。");
  const lock0 = completedCaseLock(db0, user, o0);
  if (lock0.locked) fail(back, completedLockMessage(lock0.reason));
  const validWorkers = workerIds.filter((w) => db0.users.some((u) => u.id === w));
  const hits = planConflicts(db0, o0, parsed.rows, validWorkers);
  if (hits.length && str(formData, "allowOverlap") !== "1") {
    fail(back, `担当者の予定が重複しています: ${hits.slice(0, 3).join("、")}${hits.length > 3 ? ` ほか ${hits.length - 3} 件` : ""}。日程・担当を見直すか「重複を承知で保存する」にチェックしてください。`);
  }

  let result: ReturnType<typeof savePlan> | undefined;
  let siteChanged = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    if (siteAddress && siteAddress !== o.siteAddress) {
      const before = o.siteAddress;
      o.siteAddress = siteAddress.slice(0, 200);
      propagateOrderSite(db, user, o, before);
      siteChanged = true;
    }
    result = savePlan(db, user, o, parsed.rows, { back, reason, workerIds: validWorkers, via: "order" });
  });
  const r = result!;
  if (r.approval && !r.auto) await notifyNewApprovals([r.approval.id], user.id);
  revalidatePath(back);
  revalidatePath("/schedule");
  revalidatePath("/approvals");
  const who = r.approval?.requiredRole === "admin" ? "管理者" : "店長";
  const msg = [
    r.registered.length ? "引取・納品の日程を保存し、予定表に反映しました。" : r.applied || siteChanged ? "保存しました。" : "",
    r.approval ? (r.auto ? `${AUTO_APPROVAL_NOTE}し、日程の変更を予定表に反映しました。` : `日程の変更を${who}へ申請しました。承認されると予定表に反映されます (それまでは前の日程のままです)。`) : "",
    ...r.followUps,
  ]
    .filter(Boolean)
    .join("");
  redirect(withMsg(back, msg || "変更はありませんでした。"));
}
