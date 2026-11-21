import "server-only";
import type { Database, User } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { KNOWLEDGE_SOURCES_ID, knowledgeSources, type KnowledgeSheetSource, type KnowledgeSyncRun } from "@/lib/knowledge";
import { applySheetPlan, planSheetSync, planSummary, sheetPrefix, type SheetPlan } from "@/lib/knowledge-sheet";
import { myReviewItems, reviewCtx, todayKey, addDays } from "@/lib/knowledge-review";
import { fetchSheetCsv } from "@/lib/data-io";
import { parseCsv } from "@/lib/csv";
import { canManageKnowledgeSources, isReviewAccount } from "@/lib/auth/permissions";
import { knowledgeReviewNotices, knowledgeSyncNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";

/**
 * 社内資料と Google スプレッドシートの同期 (一方向: シート → システム。画面のボタン・定期実行 /api/cron/knowledge-sync)
 * ------------------------------------------------------------
 * - シートを読む (data-io.ts の fetchSheetCsv: サービスアカウント → リンクの共有) → 行ごとに確かめた計画 (knowledge-sheet.ts) → 計画どおりに書く
 * - 画面: 「確認する」で計画を見てから「この内容で同期する」(確認したときのシートの中身の hash が変わっていたら断る)
 * - 定期: 計画にシート全体の誤り・大量の削除があれば書かずに失敗とし、担当者・本部・管理者に知らせる (同じ失敗は 24 時間に 1 回)。
 *   失敗のあと成功したら「復旧しました」を知らせる。最後に成功した日時・続けて失敗した回数・同期の記録 (20 件) を取込元に残す
 * - 定期の実行のたびに knowledge_sync_state に時刻を残す (定期実行が止まっていないかを画面で確かめる)。
 *   あわせて 1 日 1 回、確認期限を過ぎた資料の担当者に知らせる (同じ人には 7 日に 1 回。新しく期限が切れた資料があればその日に)
 * 権限の確認は呼び出し側で行う
 */

export const KNOWLEDGE_SYNC_STATE_ID = "knowledge_sync_state";
/** 定期の同期 (cron は毎時) がこれより前なら「止まっている」 */
export const CRON_STALE_HOURS = 3;
/** 最後の成功がこれより前なら「同期が古い」 */
export const SUCCESS_STALE_HOURS = 26;

export interface KnowledgeSyncState {
  lastCronAt?: string;
  lastCronResult?: string;
  /** 確認期限の通知を最後に確かめた日 */
  lastDigestOn?: string;
  /** 担当者ごとに最後に知らせた日 */
  ownerNotified?: Record<string, string>;
}

export function syncState(db: Pick<Database, "settings">): KnowledgeSyncState {
  return ((db.settings.find((s) => s.id === KNOWLEDGE_SYNC_STATE_ID)?.value ?? {}) as KnowledgeSyncState) || {};
}

function saveState(db: Database, patch: Partial<KnowledgeSyncState>, userId: string) {
  const row = db.settings.find((s) => s.id === KNOWLEDGE_SYNC_STATE_ID);
  const value = { ...syncState(db), ...patch };
  if (row) Object.assign(row, { value, updatedBy: userId, updatedAt: nowIso() });
  else db.settings.push({ id: KNOWLEDGE_SYNC_STATE_ID, value, updatedBy: userId, updatedAt: nowIso() });
}

export function saveSources(db: Database, sources: KnowledgeSheetSource[], userId: string) {
  const row = db.settings.find((s) => s.id === KNOWLEDGE_SOURCES_ID);
  const now = nowIso();
  if (row) Object.assign(row, { value: { sources }, updatedBy: userId, updatedAt: now });
  else db.settings.push({ id: KNOWLEDGE_SOURCES_ID, value: { sources }, updatedBy: userId, updatedAt: now });
}

const hoursSince = (iso: string | undefined, now = Date.now()) => (iso ? (now - Date.parse(iso)) / 3600000 : Infinity);

/** 取込元の状態 (画面・ヘッダーの通知・本番運用の確認) */
export function sourceHealth(s: KnowledgeSheetSource, now = Date.now()): { tone: "good" | "warn" | "critical" | "neutral"; label: string; detail: string } {
  if (!s.lastSyncedAt) return { tone: "neutral", label: "未同期", detail: "まだ同期していません。「確認する」でシートの内容を確かめてから同期してください" };
  if (s.failCount) return { tone: "critical", label: `失敗 (${s.failCount} 回続けて)`, detail: s.lastError ?? "原因不明" };
  if (hoursSince(s.lastSuccessAt, now) > SUCCESS_STALE_HOURS) return { tone: "warn", label: "同期が古い", detail: `最後の成功から ${Math.floor(hoursSince(s.lastSuccessAt, now))} 時間たっています (定期の同期は毎時)` };
  return { tone: "good", label: "正常", detail: s.lastResult ?? "" };
}

/** 定期実行の状態 (cron が動いているか) */
export function cronHealth(db: Pick<Database, "settings">, now = Date.now()): { ok: boolean; detail: string } {
  const st = syncState(db);
  if (!st.lastCronAt) return { ok: false, detail: "定期の同期が一度も動いていません (/etc/cron.d/ichijoya の knowledge-sync と CRON_SECRET を確かめてください)" };
  const h = hoursSince(st.lastCronAt, now);
  return h > CRON_STALE_HOURS
    ? { ok: false, detail: `定期の同期が ${Math.floor(h)} 時間動いていません (最後 ${new Date(st.lastCronAt).toLocaleString("ja-JP")})。/etc/cron.d/ichijoya と /var/log/ichijoya/cron.log を確かめてください` }
    : { ok: true, detail: `定期の同期 最後 ${new Date(st.lastCronAt).toLocaleString("ja-JP")}${st.lastCronResult ? ` (${st.lastCronResult})` : ""}` };
}

/* ================================================================== */
/* シートの読み取りと確認                                                  */
/* ================================================================== */

export interface Preview {
  src: KnowledgeSheetSource;
  plan: SheetPlan;
  /** 読み取った方法 (サービスアカウント・リンクの共有) */
  via: string;
}

async function readPlan(src: KnowledgeSheetSource): Promise<{ plan: SheetPlan; via: string }> {
  const { text, label } = await fetchSheetCsv(src.url);
  return { plan: planSheetSync(getDb(), src, text, parseCsv(text)), via: label };
}

/** シートを読んで同期の計画を作る (書かない) */
export async function previewSource(sourceId: string): Promise<{ ok: true; preview: Preview } | { ok: false; message: string; src?: KnowledgeSheetSource }> {
  const src = knowledgeSources(getDb()).find((s) => s.id === sourceId);
  if (!src) return { ok: false, message: "取込元が見つかりません。" };
  try {
    const { plan, via } = await readPlan(src);
    return { ok: true, preview: { src, plan, via } };
  } catch (err) {
    return { ok: false, message: (err as Error).message, src };
  }
}

/* ================================================================== */
/* 同期                                                                 */
/* ================================================================== */

export interface SyncOptions {
  trigger: "cron" | "manual";
  /** 確認の画面で見たシートの中身の hash (変わっていたら断る) */
  expectHash?: string;
  /** 大量の削除を確かめた */
  allowMassDelete?: boolean;
}

export interface SyncOutcome {
  ok: boolean;
  message: string;
  /** 書かずに止めた (シートが変わった・大量の削除) */
  blocked?: boolean;
}

/** 知らせる人: 取込元の担当者 + 社内資料の取込元を管理する人 (本部・管理者) */
function syncRecipients(db: Database, src: KnowledgeSheetSource): User[] {
  return db.users.filter((u) => u.active && !isReviewAccount(u) && (u.id === src.ownerId || canManageKnowledgeSources(u)));
}

function pushHistory(s: KnowledgeSheetSource, run: KnowledgeSyncRun) {
  s.history = [run, ...(s.history ?? [])].slice(0, 20);
}

/** 1 つの取込元を同期する */
export async function syncSource(sourceId: string, userId: string, opts: SyncOptions = { trigger: "manual" }): Promise<SyncOutcome> {
  const src0 = knowledgeSources(getDb()).find((s) => s.id === sourceId);
  if (!src0) return { ok: false, message: "取込元が見つかりません。" };
  let plan: SheetPlan | undefined;
  let error: string | undefined;
  try {
    plan = (await readPlan(src0)).plan;
    if (plan.sheetErrors.length) error = plan.sheetErrors.join(" ");
  } catch (err) {
    error = (err as Error).message;
  }
  if (!error && plan && opts.expectHash && plan.hash !== opts.expectHash) {
    return { ok: false, blocked: true, message: "確認したあとにシートの内容が変わりました。もう一度「確認する」で内容を確かめてから同期してください。" };
  }
  if (!error && plan?.massDelete && !opts.allowMassDelete) {
    error = `シートから消えた行が多いため (登録済み ${plan.counts.remove + plan.counts.update + plan.counts.unchanged + plan.kept.length} 件のうち ${plan.counts.remove} 件を削除する計画)、同期を止めました。シートを確かめ、問題なければ取込元の画面で「確認する」→ 削除を確かめて同期してください。`;
  }
  let notify: "failed" | "recovered" | undefined;
  const outcome = await mutate((db): SyncOutcome & { src?: KnowledgeSheetSource } => {
    const sources = knowledgeSources(db);
    const s = sources.find((x) => x.id === sourceId);
    if (!s) return { ok: false, message: "取込元が見つかりません。" };
    const now = nowIso();
    s.lastSyncedAt = now;
    if (error || !plan) {
      const msg = error ?? "シートを読めませんでした。";
      const first = !s.failCount;
      s.failCount = (s.failCount ?? 0) + 1;
      s.lastError = msg;
      s.lastResult = "失敗";
      if (opts.trigger === "cron" && (first || hoursSince(s.lastNotifiedAt) >= 24)) {
        s.lastNotifiedAt = now;
        notify = "failed";
      }
      pushHistory(s, { at: now, ok: false, trigger: opts.trigger, by: userId, result: msg.slice(0, 300) });
      saveSources(db, sources, userId);
      addAudit(db, { userId, action: "import", entity: "knowledge", entityId: s.id, entityLabel: s.label, summary: `社内資料の同期に失敗 (${s.label}${opts.trigger === "cron" ? "・定期" : ""}: ${msg.slice(0, 80)})` });
      return { ok: false, message: `「${s.label}」を同期できませんでした: ${msg}`, src: { ...s } };
    }
    const r = applySheetPlan(db, s, plan, userId, () => newId("kn"));
    if (s.failCount && s.lastNotifiedAt) notify = "recovered";
    s.failCount = 0;
    s.lastError = undefined;
    s.lastNotifiedAt = undefined;
    s.lastSuccessAt = now;
    s.lastHash = plan.hash;
    s.lastCount = db.knowledge.filter((k) => k.sourceRef?.startsWith(sheetPrefix(s.id))).length;
    s.lastResult = planSummary(r);
    pushHistory(s, { at: now, ok: true, trigger: opts.trigger, by: userId, result: s.lastResult });
    saveSources(db, sources, userId);
    const titles = plan.rows.filter((x) => x.action === "add" || x.action === "update").map((x) => x.title).slice(0, 5);
    addAudit(db, { userId, action: "import", entity: "knowledge", entityId: s.id, entityLabel: s.label, summary: `社内資料をスプレッドシートから同期 (${s.label}${opts.trigger === "cron" ? "・定期" : ""}: ${s.lastResult}${titles.length ? ` / ${titles.join("・")}${plan.counts.add + plan.counts.update > titles.length ? " ほか" : ""}` : ""}${plan.remove.length ? ` / 削除: ${plan.remove.slice(0, 3).map((x) => x.title).join("・")}${plan.remove.length > 3 ? " ほか" : ""}` : ""})` });
    return { ok: true, message: `「${s.label}」を同期しました (${s.lastCount} 件。${s.lastResult})。${plan.counts.skip ? ` 取り込めなかった行が ${plan.counts.skip} 行あります (取込元の画面の「確認する」で理由を確かめてください)。` : ""}`, src: { ...s } };
  });
  if (notify && outcome.src) {
    const db = getDb();
    await sendAndRecord(knowledgeSyncNotices(db, syncRecipients(db, outcome.src), outcome.src, notify), userId).catch((e) => console.warn("[knowledge-sync] notify failed:", e instanceof Error ? e.message : e));
  }
  return { ok: outcome.ok, message: outcome.message, blocked: outcome.ok ? undefined : Boolean(plan?.massDelete && !opts.allowMassDelete && !plan.sheetErrors.length) };
}

/* ================================================================== */
/* 定期実行 (毎時): 全部の取込元の同期 + 確認期限の通知 (1 日 1 回)              */
/* ================================================================== */

export async function runKnowledgeCron(userId: string, now = new Date()): Promise<{ ok: boolean; results: { source: string; ok: boolean; message: string }[]; reviewNotified: number }> {
  const results: { source: string; ok: boolean; message: string }[] = [];
  for (const s of knowledgeSources(getDb())) {
    const r = await syncSource(s.id, userId, { trigger: "cron" });
    results.push({ source: s.label, ok: r.ok, message: r.message });
  }
  const reviewNotified = await reviewDigest(userId, now);
  await mutate((db) => saveState(db, { lastCronAt: now.toISOString(), lastCronResult: results.length ? `${results.filter((r) => r.ok).length}/${results.length} 件成功` : "取込元なし" }, userId));
  return { ok: results.every((r) => r.ok), results, reviewNotified };
}

/**
 * 確認期限を過ぎた資料の担当者に知らせる (1 日 1 回。同じ人には 7 日に 1 回、新しく期限が切れた資料があればその日に)。
 * 知らせた人数を返す
 */
export async function reviewDigest(userId: string, now = new Date()): Promise<number> {
  const db0 = getDb();
  const today = todayKey(now);
  const st = syncState(db0);
  if (st.lastDigestOn === today) return 0;
  const ctx = reviewCtx(db0, now);
  const notified = { ...(st.ownerNotified ?? {}) };
  const out: ReturnType<typeof knowledgeReviewNotices> = [];
  const owners = [...new Set(db0.knowledge.filter((k) => k.active && k.ownerId).map((k) => k.ownerId!))];
  let n = 0;
  for (const ownerId of owners) {
    const owner = db0.users.find((u) => u.id === ownerId && u.active && !isReviewAccount(u));
    if (!owner) continue;
    const { overdue, soon } = myReviewItems(db0.knowledge, ownerId, ctx);
    if (!overdue.length) continue;
    const last = notified[ownerId];
    const fresh = overdue.some((k) => !last || k.reviewDue! >= last);
    if (last && last > addDays(today, -7) && !fresh) continue;
    out.push(...knowledgeReviewNotices(db0, owner, overdue, soon));
    notified[ownerId] = today;
    n++;
  }
  await mutate((db) => saveState(db, { lastDigestOn: today, ownerNotified: notified }, userId));
  if (out.length) await sendAndRecord(out, userId).catch((e) => console.warn("[knowledge-sync] review notify failed:", e instanceof Error ? e.message : e));
  return n;
}
