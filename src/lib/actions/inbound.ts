"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { canManageIntegrations } from "@/lib/auth/permissions";
import { INBOUND_SETTINGS_ID, inboundSettings, type InboundSettings } from "@/lib/inbound/feed";
import { inboundMailConfig, pollInboundMail } from "@/lib/inbound/mail";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 外部から届いたメッセージの通知の設定 (設定 → 外部連携・AI。管理者)。src/lib/inbound/feed.ts
 * - メールの受信を通知する (オン・オフ)・今すぐ確認
 * - Slack のチャンネル → 知らせる店舗
 */

const BACK = "/settings?tab=integrations#inbound";

function saveSettings(db: Parameters<Parameters<typeof mutate>[0]>[0], userId: string, patch: Partial<InboundSettings>): InboundSettings {
  let row = db.settings.find((s) => s.id === INBOUND_SETTINGS_ID);
  const now = new Date().toISOString();
  if (!row) {
    row = { id: INBOUND_SETTINGS_ID, value: {}, updatedBy: userId, updatedAt: now };
    db.settings.push(row);
  }
  const next = { ...inboundSettings(db), ...patch };
  row.value = next;
  row.updatedAt = now;
  row.updatedBy = userId;
  return next;
}

/** メールの受信を通知する (オン・オフ) */
export async function setInboundMail(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageIntegrations(user)) fail(back, "メールの受信の設定を変えられるのは管理者です。");
  const on = str(formData, "enabled") === "1";
  if (on && !inboundMailConfig()) fail(back, "メールサーバーの設定 (INBOUND_MAIL_* か SMTP_*) がないため、受信を始められません。");
  await mutate((db) => {
    const before = Boolean(inboundSettings(db).mailEnabled);
    if (before === on) fail(back, on ? "すでにオンです。" : "すでにオフです。");
    saveSettings(db, user.id, { mailEnabled: on });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: INBOUND_SETTINGS_ID, entityLabel: "外部から届いたメッセージの通知", summary: on ? "メールの受信の通知をオンにしました" : "メールの受信の通知をオフにしました", changes: [{ field: "mailEnabled", before, after: on }] });
  });
  let note = "";
  if (on) {
    const r = await pollInboundMail({ force: true });
    note = r.ok ? ` 最初の確認: ${r.recorded ?? 0} 通 (直近 24 時間)。` : ` ただし接続に失敗しました: ${r.error}`;
  }
  revalidatePath("/", "layout");
  redirect(withMsg(back, on ? `メールの受信の通知をオンにしました。新しいメールは 2〜5 分ごとに確認します。${note}` : "メールの受信の通知をオフにしました。"));
}

/** 今すぐメールを確認する */
export async function checkInboundMailNow(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageIntegrations(user)) fail(back, "メールの受信を確認できるのは管理者です。");
  const r = await pollInboundMail({ force: true });
  if (r.skipped === "disabled") fail(back, "メールの受信の通知がオフです。");
  if (r.skipped === "not_configured") fail(back, "メールサーバーの設定 (INBOUND_MAIL_* か SMTP_*) がありません。");
  if (r.skipped === "running") fail(back, "ほかの確認が実行中です。少し待ってからもう一度押してください。");
  if (!r.ok) fail(back, r.error ?? "メールの受信に失敗しました。");
  revalidatePath("/", "layout");
  redirect(withMsg(back, `メールを確認しました: 新しいメール ${r.recorded ?? 0} 通${r.baseline ? " (最初の確認のため直近 24 時間)" : ""}。`));
}

/** Slack のチャンネルの通知を知らせる店舗 (空 = 本部・管理者だけ) */
export async function setSlackChannelStore(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageIntegrations(user)) fail(back, "Slack のチャンネルの設定を変えられるのは管理者です。");
  const channel = str(formData, "channel");
  if (!/^[CG][A-Z0-9]+$/.test(channel)) fail(back, "チャンネルが正しくありません。");
  const raw = str(formData, "storeId");
  await mutate((db) => {
    const storeId = raw && db.stores.some((s) => s.id === raw) && raw !== "hq" ? (raw as StoreId) : undefined;
    const cur = { ...(inboundSettings(db).slackStores ?? {}) };
    const before = cur[channel] ?? "";
    if (storeId) cur[channel] = storeId;
    else delete cur[channel];
    saveSettings(db, user.id, { slackStores: cur });
    const label = storeId ? (db.stores.find((s) => s.id === storeId)?.name ?? storeId) : "本部・管理者だけ";
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: INBOUND_SETTINGS_ID, entityLabel: "Slack のチャンネル", summary: `Slack のチャンネル ${channel} の通知を「${label}」に知らせる`, changes: [{ field: `slack:${channel}`, before, after: storeId ?? "" }] });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "Slack のチャンネルの知らせる先を変更しました (これから届くメッセージから)。"));
}
