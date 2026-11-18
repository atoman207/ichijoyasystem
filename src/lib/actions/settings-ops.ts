"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, diffChanges, getDb, mutate } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import type { Database } from "@/lib/db/types";
import { canExportAccounting, canManageIntegrations, canManageSettings, canManageUser } from "@/lib/auth/permissions";
import { APPROVAL_SETTINGS_ID, approvalSettings, manYen } from "@/lib/approval-rules";
import { ACCOUNTING_LABEL, ACCOUNTING_SETTINGS_ID, accountingSettings } from "@/lib/accounting";
import { NOTIFY_EVENT_LABEL, NOTIFY_SETTINGS_ID, notifySettings, type NotifyEvent } from "@/lib/notify/events";
import { isEmail } from "@/lib/notify/channels";
import { sendAndRecord, type Outgoing } from "@/lib/notify/send";
import { appBaseUrl } from "@/lib/notify/config";
import { fieldLabel } from "@/lib/field-labels";
import { AI_INTAKE_SETTINGS_ID, HANDOFF_MODE_LABEL, aiIntakeSettings } from "@/lib/ai-intake";
import { fail, numField, requireActionUser, safeReturn, str, withMsg } from "./guards";

/** settings の 1 行を保存する (なければ作る) */
function saveSetting(db: Database, id: string, value: Record<string, unknown>, userId: string) {
  const now = new Date().toISOString();
  const row = db.settings.find((s) => s.id === id);
  if (row) Object.assign(row, { value, updatedBy: userId, updatedAt: now });
  else db.settings.push({ id, value, updatedBy: userId, updatedAt: now });
}

async function assertSettingsTable(back: string) {
  if (BACKEND === "supabase" && missingTables().includes("settings") && (await recheckMissingTables()).includes("settings")) fail(back, "データベースに設定の表がまだありません。");
}

/** 承認ルール (承認者が管理者になる金額・顧客の重要情報の変更の承認) */
export async function updateApprovalSettings(formData: FormData) {
  const back = "/settings?tab=rules";
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "承認ルールの変更は管理者のみ行えます。");
  await assertSettingsTable(back);
  const quote = Math.round(numField(formData, "quoteAdminThreshold"));
  const expense = Math.round(numField(formData, "expenseAdminThreshold"));
  if (quote < 10_000 || quote > 100_000_000) fail(back, "見積・契約の基準額は 1 万円〜1 億円で入力してください。");
  if (expense < 1_000 || expense > 10_000_000) fail(back, "経費の基準額は 1,000 円〜1,000 万円で入力してください。");
  const customerChange = formData.get("customerChange") === "on";
  await mutate((db) => {
    const before = approvalSettings(db);
    const value = { quoteAdminThreshold: quote, expenseAdminThreshold: expense, customerChange };
    saveSetting(db, APPROVAL_SETTINGS_ID, value, user.id);
    const changes = diffChanges(before, approvalSettings(db), ["quoteAdminThreshold", "expenseAdminThreshold", "customerChange"]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    const label: Record<string, string> = { quoteAdminThreshold: "見積・契約の管理者承認の基準額", expenseAdminThreshold: "経費の管理者承認の基準額", customerChange: "顧客の重要情報の変更の承認" };
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: APPROVAL_SETTINGS_ID, entityLabel: "承認ルール", summary: `承認ルールを変更 (${changes.map((c) => `${label[c.field]}: ${typeof c.after === "number" ? manYen(c.after) : c.after ? "必要" : "不要"}`).join(" / ")})`, changes });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, "承認ルールを保存しました。これから申請するものに使われます (申請済みのものは変わりません)。"));
}

/** 会計データの科目名・税区分 */
export async function updateAccountingSettings(formData: FormData) {
  const back = "/accounting?tab=settings";
  const user = await requireActionUser();
  if (!canExportAccounting(user)) fail(back, "会計の設定は本部スタッフ・管理者が変更します。");
  await assertSettingsTable(back);
  await mutate((db) => {
    const before = accountingSettings(db);
    const value: Record<string, unknown> = { storeAsDepartment: formData.get("storeAsDepartment") === "on" };
    for (const k of Object.keys(ACCOUNTING_LABEL)) {
      const v = str(formData, k).slice(0, 40);
      if (!v) fail(back, `「${ACCOUNTING_LABEL[k as keyof typeof ACCOUNTING_LABEL]}」を入力してください。`);
      value[k] = v;
    }
    saveSetting(db, ACCOUNTING_SETTINGS_ID, value, user.id);
    const after = accountingSettings(db);
    const changes = diffChanges(before, after, [...(Object.keys(ACCOUNTING_LABEL) as (keyof typeof after)[]), "storeAsDepartment"]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: ACCOUNTING_SETTINGS_ID, entityLabel: "会計データの設定", summary: `会計データの科目名・税区分を変更 (${changes.length} 項目)`, changes });
  });
  revalidatePath("/accounting");
  redirect(withMsg(back, "会計データの設定を保存しました。次に出力するデータから使われます。"));
}

/** 社内通知の種類ごとのオン・オフ (メール・Chatwork) */
export async function updateNotifySettings(formData: FormData) {
  const back = "/settings?tab=integrations";
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "通知の設定は管理者のみ変更できます。");
  await assertSettingsTable(back);
  const events = Object.keys(NOTIFY_EVENT_LABEL) as NotifyEvent[];
  const value = {
    email: Object.fromEntries(events.map((e) => [e, formData.get(`email_${e}`) === "on"])),
    chatwork: Object.fromEntries(events.map((e) => [e, formData.get(`chatwork_${e}`) === "on"])),
  };
  await mutate((db) => {
    const before = notifySettings(db);
    saveSetting(db, NOTIFY_SETTINGS_ID, value, user.id);
    const after = notifySettings(db);
    const changes = events.flatMap((e) => [
      ...(before.email[e] !== after.email[e] ? [{ field: `メール: ${NOTIFY_EVENT_LABEL[e]}`, before: before.email[e], after: after.email[e] }] : []),
      ...(before.chatwork[e] !== after.chatwork[e] ? [{ field: `Chatwork: ${NOTIFY_EVENT_LABEL[e]}`, before: before.chatwork[e], after: after.chatwork[e] }] : []),
    ]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: NOTIFY_SETTINGS_ID, entityLabel: "通知の設定", summary: `社内通知の設定を変更 (${changes.length} 項目)`, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "通知の設定を保存しました。"));
}

/** 外部連携の接続確認 (テスト送信)。宛先: メールアドレス / LINE のユーザー ID / Chatwork のルーム ID (空なら社内通知のルーム) */
export async function sendTestMessage(formData: FormData) {
  const back = "/settings?tab=integrations";
  const user = await requireActionUser();
  if (!canManageIntegrations(user)) fail(back, "接続の確認は管理者が行います。");
  const channel = str(formData, "channel");
  const to = str(formData, "to");
  if (channel !== "email" && channel !== "line" && channel !== "chatwork") fail(back, "送信先のサービスを選んでください。");
  if (channel === "email" && !isEmail(to)) fail(back, "テストの送信先のメールアドレスを入力してください。");
  if (channel === "line" && !/^U[0-9a-f]{32}$/.test(to)) fail(back, "テストの送信先の LINE ユーザー ID (U で始まる 33 文字) を入力してください。");
  if (channel === "chatwork" && to && !/^\d+$/.test(to)) fail(back, "Chatwork のルーム ID は数字です (空欄なら社内通知のルーム)。");
  const out: Outgoing = { channel, to, subject: "接続の確認 (一畳屋 業務システム)", body: `業務システムからのテスト送信です。\n送信: ${user.name} さん\n画面: ${appBaseUrl()}`, purpose: "test" };
  const [d] = await sendAndRecord([out], user.id);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "send", entity: "delivery", entityId: d.id, entityLabel: channel, summary: `外部連携の接続を確認 (${channel} / ${d.status === "sent" ? "送信" : d.status === "skipped" ? "設定なし" : `失敗: ${d.error ?? ""}`})` });
  }).catch(() => undefined);
  if (d.status === "skipped") fail(back, "このサービスの送信設定 (環境変数) がありません。");
  if (d.status === "failed") fail(back, `送信できませんでした: ${d.error ?? "原因不明"}`);
  redirect(withMsg(back, "テスト送信しました。届いたことを確認してください。"));
}

/** 自分の通知の受け取り方 (プロフィール) */
export async function updateOwnNotify(formData: FormData) {
  const back = "/profile";
  const user = await requireActionUser();
  await saveNotify(user.id, user.id, formData, back);
  redirect(withMsg(back, "通知の受け取り方を保存しました。"));
}

/** 社員の通知の受け取り方 (管理者が社員のアカウント画面から) */
export async function updateUserNotify(userId: string, formData: FormData) {
  const back = safeReturn(str(formData, "returnTo"), `/settings/users/${userId}`);
  const user = await requireActionUser();
  const target = getDb().users.find((u) => u.id === userId);
  if (!target || !canManageUser(user, target)) fail(back, "このアカウントを管理する権限がありません (店長は自店舗の店舗スタッフのみ)。");
  await saveNotify(user.id, userId, formData, back);
  redirect(withMsg(back, "通知の受け取り方を保存しました。"));
}

async function saveNotify(actorId: string, targetId: string, formData: FormData, back: string) {
  const notifyEmail = str(formData, "notifyEmail").toLowerCase();
  const notifyByEmail = formData.get("notifyByEmail") === "on";
  const chatworkAccountId = str(formData, "chatworkAccountId");
  if (notifyEmail && !isEmail(notifyEmail)) fail(back, "通知用のメールアドレスの形が正しくありません。");
  if (notifyEmail.endsWith("@ichijoya.example")) fail(back, "デモ用のアドレス (@ichijoya.example) には送れません。");
  if (chatworkAccountId && !/^\d+$/.test(chatworkAccountId)) fail(back, "Chatwork のアカウント ID は数字です。");
  await mutate((db) => {
    const u = db.users.find((x) => x.id === targetId);
    if (!u) fail(back, "ユーザーが見つかりません。");
    if (notifyByEmail && !notifyEmail && !isEmail(u.email)) fail(back, "ログイン ID がメールアドレスではないため、通知用のメールアドレスを入力してください。");
    const before = { ...u };
    u.notifyEmail = notifyEmail || undefined;
    u.notifyByEmail = notifyByEmail || undefined;
    u.chatworkAccountId = chatworkAccountId || undefined;
    const changes = diffChanges(before, u, ["notifyEmail", "notifyByEmail", "chatworkAccountId"]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: actorId, action: "update", entity: "user", entityId: u.id, entityLabel: u.name, summary: `通知の受け取り方を変更 (${changes.map((c) => fieldLabel("user", c.field)).join("・")})`, changes });
  });
  revalidatePath(back);
}

/** 既存の AI システムからの受付の取込 (登録する店舗・引き継ぎの方法・店舗ごとの引き継ぎ先) */
export async function updateAiIntakeSettings(formData: FormData) {
  const back = "/settings?tab=integrations";
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "AI 受付の設定は管理者のみ変更できます。");
  await assertSettingsTable(back);
  await mutate((db) => {
    const defaultStore = db.stores.find((s) => s.id === str(formData, "defaultStore"))?.id ?? "hq";
    const mode = str(formData, "handoff");
    const handoff = mode === "requested" || mode === "never" ? mode : "always";
    const assignees: Record<string, string> = {};
    for (const s of db.stores) {
      const uid = str(formData, `assignee_${s.id}`);
      if (!uid) continue;
      if (!db.users.some((u) => u.id === uid && u.active)) fail(back, `${s.name}の引き継ぎ先が見つかりません。`);
      assignees[s.id] = uid;
    }
    const before = aiIntakeSettings(db);
    saveSetting(db, AI_INTAKE_SETTINGS_ID, { defaultStore, handoff, assignees }, user.id);
    const name = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "店長";
    const changes = [
      ...(before.defaultStore !== defaultStore ? [{ field: "店舗が分からないときの登録先", before: db.stores.find((s) => s.id === before.defaultStore)?.name, after: db.stores.find((s) => s.id === defaultStore)?.name }] : []),
      ...(before.handoff !== handoff ? [{ field: "引き継ぎ", before: HANDOFF_MODE_LABEL[before.handoff], after: HANDOFF_MODE_LABEL[handoff] }] : []),
      ...db.stores.filter((s) => (before.assignees[s.id] ?? "") !== (assignees[s.id] ?? "")).map((s) => ({ field: `引き継ぎ先: ${s.name}`, before: name(before.assignees[s.id]), after: name(assignees[s.id]) })),
    ];
    if (!changes.length) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: AI_INTAKE_SETTINGS_ID, entityLabel: "AI 受付の取込", summary: `AI 受付の取込の設定を変更 (${changes.length} 項目)`, changes });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "AI 受付の取込の設定を保存しました。"));
}
