"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import type { Database, User } from "@/lib/db/types";
import { canEditCaseStore, canManageIntegrations } from "@/lib/auth/permissions";
import { LINE_GROUP_PURPOSES, LINE_GROUP_PURPOSE_LABEL, findLineGroup, lineGroupName, touchLineGroups, trimPending, LINE_GROUP_ID_RE, type LineGroupPurpose } from "@/lib/line-groups";
import type { StoreId } from "@/lib/db/types";
import { recordLineGroupMessage, type LineMediaJob } from "@/lib/notify/inbound";
import { checkLine, saveLineMedia, setLineWebhook } from "@/lib/notify/line-api";
import { checkChatwork } from "@/lib/notify/chatwork-api";
import { verifyMail } from "@/lib/notify/channels";
import { appBaseUrl } from "@/lib/notify/config";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * LINE グループ (施工現場ごとのグループなど) を受注 (案件)・協力業者にひも付ける
 * - 管理者: どのグループも変更できる (設定 → 外部連携・AI)
 * - 店舗の担当者: 自店舗の受注へのひも付け・解除 (受注の画面)。店長はほかの店舗の受注も (permissions.ts の canEditCaseStore)
 * ひも付けたときに、それまで保留していたメッセージを案件のやりとり履歴に移し、写真・資料を保存する
 */

function canEditGroup(user: User, db: Database, orderId?: string): boolean {
  if (canManageIntegrations(user)) return true;
  if (!orderId) return false;
  const o = db.orders.find((x) => x.id === orderId);
  return Boolean(o && canEditCaseStore(user, o.storeId));
}

export async function linkLineGroup(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/settings?tab=integrations");
  const groupId = str(formData, "groupId");
  if (!LINE_GROUP_ID_RE.test(groupId)) fail(back, "LINE グループを選んでください。");
  const db0 = getDb();
  const orderRef = str(formData, "orderRef").normalize("NFKC").trim().toUpperCase();
  const order = orderRef ? db0.orders.find((o) => o.number.toUpperCase() === orderRef || o.id === str(formData, "orderRef")) : undefined;
  if (orderRef && !order) fail(back, `受注番号「${orderRef}」が見つかりません。`);
  const supplierId = str(formData, "supplierId");
  const supplier = supplierId ? db0.suppliers.find((s) => s.id === supplierId) : undefined;
  if (supplierId && !supplier) fail(back, "協力業者・仕入先が見つかりません。");
  if (!order && !supplier) fail(back, "受注番号か協力業者・仕入先のどちらかを指定してください (外すときは「ひも付けを外す」)。");
  const label = str(formData, "label").slice(0, 60);

  const jobs: LineMediaJob[] = [];
  let moved = 0;
  let name = "";
  await mutate((db) => {
    const g = findLineGroup(db, groupId);
    if (!g) fail(back, "LINE グループが見つかりません。");
    // 他の案件にひも付いているグループは、その案件を変更できる人だけが付け替えられる
    if (!canEditGroup(user, db, order?.id) || (g.orderId && g.orderId !== order?.id && !canEditGroup(user, db, g.orderId)) || (!canManageIntegrations(user) && !order)) fail(back, "この LINE グループを変更する権限がありません。");
    const before = [g.orderId ?? "", g.supplierId ?? "", g.label ?? ""].join(" / ");
    g.orderId = order?.id;
    g.supplierId = supplier?.id;
    // 現場・業者のグループにする (店舗別・クレーム報告などの用途は外す)
    g.purpose = undefined;
    g.storeId = undefined;
    g.notifyInquiries = undefined;
    if (formData.has("label")) g.label = label || undefined;
    name = lineGroupName(g);
    for (const m of g.pending) {
      const job = recordLineGroupMessage(db, g, m, true);
      if (job) jobs.push(job);
      moved++;
    }
    g.pending = [];
    touchLineGroups(db, user.id);
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: g.id,
      entityLabel: name,
      summary: `LINE グループ「${name}」をひも付け (${[order ? `受注 ${order.number}` : "", supplier ? `協力業者 ${supplier.name}` : ""].filter(Boolean).join(" / ")})${moved ? ` · 保留のメッセージ ${moved} 件を履歴に移動` : ""}`,
      storeId: order?.storeId ?? "hq",
      changes: [{ field: "lineGroup", before, after: [g.orderId ?? "", g.supplierId ?? "", g.label ?? ""].join(" / ") }],
    });
  });
  if (jobs.length) after(() => saveLineMedia(jobs).then(() => undefined));
  revalidatePath("/settings");
  if (order) revalidatePath(`/orders/${order.id}`);
  redirect(withMsg(back, `LINE グループ「${name}」をひも付けました。${moved ? `保留していたメッセージ ${moved} 件をやりとり履歴に移しました${jobs.length ? ` (写真・資料 ${jobs.length} 件は保存中)` : ""}。` : ""}`));
}

export async function unlinkLineGroup(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/settings?tab=integrations");
  const groupId = str(formData, "groupId");
  let name = "";
  let orderId: string | undefined;
  await mutate((db) => {
    const g = findLineGroup(db, groupId);
    if (!g) fail(back, "LINE グループが見つかりません。");
    if (!canEditGroup(user, db, g.orderId)) fail(back, "この LINE グループを変更する権限がありません。");
    orderId = g.orderId;
    const before = [g.orderId ?? "", g.supplierId ?? ""].join(" / ");
    delete g.orderId;
    delete g.supplierId;
    name = lineGroupName(g);
    touchLineGroups(db, user.id);
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: g.id, entityLabel: name, summary: `LINE グループ「${name}」のひも付けを外す`, storeId: "hq", changes: [{ field: "lineGroup", before, after: "" }] });
  });
  revalidatePath("/settings");
  if (orderId) revalidatePath(`/orders/${orderId}`);
  redirect(withMsg(back, `LINE グループ「${name}」のひも付けを外しました (この後のメッセージは保留になります)。`));
}

/**
 * グループの用途と店舗 (管理者。設定 → 外部連携・AI)。一畳屋の社内の LINE グループ (店舗別・クレーム・手直し報告・施工事例写真・整理整頓など) をシステムにつなぐ:
 * 店舗別グループは新しい問い合わせを知らせる (notifyInquiries)・クレーム・手直し報告は KPI → クレーム・手直し に報告を並べる。それ以外はメッセージを残す
 */
export async function setLineGroupPurpose(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/settings?tab=integrations");
  if (!canManageIntegrations(user)) fail(back, "LINE グループの用途を変更できるのは管理者です。");
  const groupId = str(formData, "groupId");
  const raw = str(formData, "purpose");
  const purpose = (LINE_GROUP_PURPOSES as string[]).includes(raw) ? (raw as LineGroupPurpose) : "site";
  const storeRaw = str(formData, "storeId");
  let name = "";
  await mutate((db) => {
    const g = findLineGroup(db, groupId);
    if (!g) fail(back, "LINE グループが見つかりません。");
    const storeId = storeRaw && db.stores.some((s) => s.id === storeRaw) ? (storeRaw as StoreId) : undefined;
    if (purpose === "store" && !storeId) fail(back, "店舗別グループは店舗を選んでください。");
    if (purpose !== "site" && (g.orderId || g.supplierId)) fail(back, "案件・協力業者にひも付いているグループです。先に「ひも付けを外す」を押してください。");
    const before = [g.purpose ?? "site", g.storeId ?? "", g.notifyInquiries ? "知らせる" : "", g.label ?? ""].join(" / ");
    g.purpose = purpose === "site" ? undefined : purpose;
    g.storeId = purpose === "site" ? undefined : storeId;
    g.notifyInquiries = purpose === "store" && formData.get("notifyInquiries") === "on" ? true : undefined;
    if (formData.has("label")) g.label = str(formData, "label").slice(0, 60) || undefined;
    trimPending(g);
    name = lineGroupName(g);
    touchLineGroups(db, user.id);
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: g.id,
      entityLabel: name,
      summary: `LINE グループ「${name}」の用途を「${LINE_GROUP_PURPOSE_LABEL[purpose]}」に変更${g.storeId ? ` (${db.stores.find((s) => s.id === g.storeId)?.name ?? g.storeId})` : ""}${g.notifyInquiries ? " · 新しい問い合わせを知らせる" : ""}`,
      storeId: g.storeId ?? "hq",
      changes: [{ field: "linePurpose", before, after: [g.purpose ?? "site", g.storeId ?? "", g.notifyInquiries ? "知らせる" : "", g.label ?? ""].join(" / ") }],
    });
  });
  revalidatePath("/settings");
  revalidatePath("/kpi/quality");
  redirect(withMsg(back, `LINE グループ「${name}」の用途を保存しました。`));
}

/* ---------------- 接続の確認 (設定 → 外部連携・AI) ---------------- */

export async function checkMessagingConnections(): Promise<{ mail: { ok: boolean; lines: string[] }; line: { ok: boolean; lines: string[] }; chatwork: { ok: boolean; lines: string[] } }> {
  const user = await requireActionUser();
  if (!canManageIntegrations(user)) {
    const denied = { ok: false, lines: ["この操作は管理者のみ実行できます。"] };
    return { mail: denied, line: denied, chatwork: denied };
  }
  const [mail, line, chatwork] = await Promise.all([verifyMail(), checkLine(), checkChatwork(getDb(), `${appBaseUrl()}/api/integrations/chatwork`)]);
  return { mail, line, chatwork };
}

export async function connectLineWebhook(): Promise<{ ok: boolean; lines: string[] }> {
  const user = await requireActionUser();
  if (!canManageIntegrations(user)) return { ok: false, lines: ["この操作は管理者のみ実行できます。"] };
  const r = await setLineWebhook();
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: "line_webhook", entityLabel: "LINE の Webhook URL", summary: `LINE の Webhook URL を設定 (${r.ok ? "成功" : "失敗"}: ${r.lines[0] ?? ""})`.slice(0, 300) });
  }).catch(() => undefined);
  return r;
}
