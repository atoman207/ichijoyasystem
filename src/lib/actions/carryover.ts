"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import { canDecideCarryover, canReviewCarryover } from "@/lib/auth/permissions";
import { CARRYOVER_REVIEW_ID, readCarryoverReview, RUNTIME_SETTINGS, type CarryoverReview } from "@/lib/carryover";
import { isTestWeekDb } from "@/lib/carryover-server";
import type { Database, User } from "@/lib/db/types";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 試験期間のデータの本番への引き継ぎの判断 (/data/carryover)。テスト用のデータベースの settings (id = carryover_review) に残す。
 * 12/1 の引き継ぎ (scripts/ops/testweek-carryover.mjs) がこの判断を読む。判断の設定そのものは本番に引き継がない
 */

const BACK = "/data/carryover";

async function guard(): Promise<User> {
  const user = await requireActionUser();
  if (!canReviewCarryover(user)) fail(BACK, "本番への引き継ぎの判断は管理者・本部スタッフが行います。");
  if (!isTestWeekDb(getDb())) fail(BACK, "試験期間のテスト用のデータベースではありません (この画面は試験期間だけ使います)。");
  return user;
}

function save(db: Database, user: User, next: CarryoverReview, summary: string, changes: { field: string; before: unknown; after: unknown }[]) {
  const now = new Date().toISOString();
  const row = db.settings.find((s) => s.id === CARRYOVER_REVIEW_ID);
  if (row) Object.assign(row, { value: next, updatedBy: user.id, updatedAt: now });
  else db.settings.push({ id: CARRYOVER_REVIEW_ID, value: next, updatedBy: user.id, updatedAt: now });
  addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: CARRYOVER_REVIEW_ID, entityLabel: "本番への引き継ぎ", summary, changes });
}

/** まとまりごとの判断: include = 引き継ぐ / exclude = 引き継がない / clear = 自動の判断に戻す */
export async function setCarryoverDecision(formData: FormData) {
  const user = await guard();
  const id = str(formData, "groupId");
  const label = str(formData, "label").slice(0, 80);
  const decision = str(formData, "decision");
  if (!id || !["include", "exclude", "clear"].includes(decision)) fail(BACK, "判断を読み取れません。");
  await mutate((db) => {
    const cur = readCarryoverReview(db as unknown as Record<string, unknown>);
    const before = cur.include.includes(id) ? "引き継ぐ" : cur.exclude.includes(id) ? "引き継がない" : "自動";
    const next: CarryoverReview = { ...cur, include: cur.include.filter((x) => x !== id), exclude: cur.exclude.filter((x) => x !== id) };
    if (decision === "include") next.include.push(id);
    if (decision === "exclude") next.exclude.push(id);
    const after = decision === "include" ? "引き継ぐ" : decision === "exclude" ? "引き継がない" : "自動";
    // 最終判断のあとに変えたら、最終判断はやり直し
    if (cur.decidedAt && before !== after) Object.assign(next, { decidedAt: undefined, decidedBy: undefined });
    save(db, user, next, `本番への引き継ぎ: ${label || id} を「${after}」に${cur.decidedAt && before !== after ? " (最終判断は取り消し)" : ""}`, [{ field: id, before, after }]);
  });
  revalidatePath(BACK);
  redirect(withMsg(`${BACK}#g-${id}`, `「${label || id}」を${decision === "include" ? "引き継ぐ" : decision === "exclude" ? "引き継がない" : "自動の判断"}にしました。`));
}

/** 期間と、引き継ぐ設定 */
export async function setCarryoverScope(formData: FormData) {
  const user = await guard();
  const since = str(formData, "since");
  const until = str(formData, "until");
  const isDate = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(since) || !isDate(until)) fail(BACK, "期間の日付を正しく入れてください。");
  if (since && until && since > until) fail(BACK, "期間のはじめがおわりより後になっています。");
  const settings = formData.getAll("settings").map(String).filter((x) => x && !RUNTIME_SETTINGS.has(x));
  await mutate((db) => {
    const cur = readCarryoverReview(db as unknown as Record<string, unknown>);
    const next: CarryoverReview = { ...cur, since: since || undefined, until: until || undefined, settings };
    const changed = cur.since !== next.since || cur.until !== next.until || cur.settings.join() !== settings.join();
    if (cur.decidedAt && changed) Object.assign(next, { decidedAt: undefined, decidedBy: undefined });
    save(db, user, next, `本番への引き継ぎ: 期間 ${since || "はじめ"}〜${until || "おわり"}・設定 ${settings.length ? settings.join("・") : "なし"}${cur.decidedAt && changed ? " (最終判断は取り消し)" : ""}`, [
      { field: "since", before: cur.since ?? null, after: since || null },
      { field: "until", before: cur.until ?? null, after: until || null },
      { field: "settings", before: cur.settings, after: settings },
    ]);
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, "引き継ぐ期間と設定を保存しました。"));
}

/** 最終判断 (この内容で引き継ぐと決める / 取り消す)。管理者だけ */
export async function decideCarryover(formData: FormData) {
  const user = await guard();
  if (!canDecideCarryover(user)) fail(BACK, "最終判断は管理者が行います。");
  const undo = str(formData, "undo") === "1";
  const note = str(formData, "note").slice(0, 500);
  await mutate((db) => {
    const cur = readCarryoverReview(db as unknown as Record<string, unknown>);
    const next: CarryoverReview = undo ? { ...cur, decidedAt: undefined, decidedBy: undefined } : { ...cur, decidedAt: new Date().toISOString(), decidedBy: user.id, note: note || cur.note };
    save(db, user, next, undo ? "本番への引き継ぎ: 最終判断を取り消し" : "本番への引き継ぎ: この内容で引き継ぐと決めた (最終判断)", [{ field: "decidedAt", before: cur.decidedAt ?? null, after: next.decidedAt ?? null }]);
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, undo ? "最終判断を取り消しました。" : "最終判断を記録しました。12 月 1 日の朝、この内容で本番のデータベースに引き継ぎます。"));
}
