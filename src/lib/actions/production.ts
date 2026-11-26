"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { StoreId, TatamiProduction, TatamiProductionEvent } from "@/lib/db/types";
import { canEditProduction } from "@/lib/auth/permissions";
import { isDateKey, shortDate } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { carryTarget, findProductionRow, productionId, type ProductionRow } from "@/lib/production/plan";
import { productionTableMissing } from "@/lib/production/tables";
import { cleanRooms, roomTotals, roomsText, sameRooms } from "@/lib/tatami-spec";
import { orderRooms } from "@/lib/tatami-rooms";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 畳製造予定の操作 (お客様のご要望 2026-11-23「■3」)。製造日の変更・繰り越し・製造日未定・製造済み・手で足した行。
 * どの操作も予定表の予定 (引取日・納品日) には触れない。行ごとに変更履歴を残す
 */

const PAGE = "/schedule/production";
const HISTORY_MAX = 30;

type Op = "carry" | "date" | "undecided" | "auto" | "done" | "reopen" | "cancel" | "restore";
const OPS: Op[] = ["carry", "date", "undecided", "auto", "done", "reopen", "cancel", "restore"];

const label = (r: Pick<ProductionRow, "name" | "orderNumber">) => `${r.name}${r.orderNumber ? ` (${r.orderNumber})` : ""}`;
const dayText = (d?: string) => (d ? shortDate(d) : "未定");

function ensureRecord(db: { tatamiProduction: TatamiProduction[] }, row: ProductionRow, userId: string, now: string): TatamiProduction {
  let rec = db.tatamiProduction.find((r) => r.sourceKey === row.key);
  if (!rec) {
    rec = { id: productionId(row.key), sourceKey: row.key, storeId: row.storeId, orderId: row.orderId, eventId: row.eventId, customerId: row.customerId, status: "planned", history: [], createdBy: userId, createdAt: now, updatedAt: now };
    db.tatamiProduction.push(rec);
  }
  return rec;
}

function pushHistory(rec: TatamiProduction, ev: TatamiProductionEvent) {
  rec.history = [...(rec.history ?? []), ev].slice(-HISTORY_MAX);
}

/** 製造日の変更・繰り越し・未定・元の日に戻す・製造済み・取り消し (keys に複数の行を渡すと、まとめて同じ操作) */
export async function updateProduction(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), PAGE);
  if (!canEditProduction(user)) fail(back, "畳製造予定を変更する権限がありません。");
  const op = str(formData, "op") as Op;
  if (!OPS.includes(op)) fail(back, "操作の指定が正しくありません。");
  const keys = [...new Set(formData.getAll("key").map(String).filter(Boolean))].slice(0, 200);
  if (!keys.length) fail(back, "対象の製造の予定がありません。");
  const date = str(formData, "date");
  if (op === "date" && !isDateKey(date)) fail(back, "製造日を入れてください。");
  const missing = await productionTableMissing();
  if (missing) fail(back, missing);

  const today = toDateKey(new Date());
  const result = await mutate((db) => {
    const now = nowIso();
    const done: string[] = [];
    for (const key of keys) {
      const row = findProductionRow(db, key, today);
      if (!row) continue;
      const rec = ensureRecord(db, row, user.id, now);
      const before = { date: row.date, undecided: row.mode === "undecided", status: row.status };
      let action: TatamiProductionEvent["action"];
      let to: string | undefined;
      switch (op) {
        case "carry":
          to = carryTarget(db, row.date, today);
          rec.date = to;
          rec.undecided = undefined;
          rec.baseDate = row.baseDate;
          if (rec.status !== "planned") rec.status = "planned";
          action = "carry";
          break;
        case "date":
          to = date;
          rec.date = date;
          rec.undecided = undefined;
          rec.baseDate = row.baseDate;
          action = "move";
          break;
        case "undecided":
          rec.date = undefined;
          rec.undecided = true;
          rec.baseDate = row.baseDate;
          action = "undecided";
          break;
        case "auto":
          rec.date = undefined;
          rec.undecided = undefined;
          rec.baseDate = undefined;
          to = row.baseDate;
          action = "auto";
          break;
        case "done":
          rec.status = "done";
          rec.doneAt = now;
          rec.doneBy = user.id;
          action = "done";
          break;
        case "reopen":
          rec.status = "planned";
          rec.doneAt = undefined;
          rec.doneBy = undefined;
          action = "reopen";
          break;
        case "cancel":
          rec.status = "cancelled";
          action = "cancel";
          break;
        case "restore":
          rec.status = "planned";
          action = "reopen";
          break;
      }
      pushHistory(rec, { at: now, by: user.id, action, from: before.date, to });
      rec.updatedBy = user.id;
      rec.updatedAt = now;
      const after = { date: rec.undecided ? undefined : (rec.date ?? row.baseDate), undecided: Boolean(rec.undecided || (!rec.date && !row.baseDate)), status: rec.status };
      const changes = (["date", "undecided", "status"] as const).filter((f) => before[f] !== after[f]).map((f) => ({ field: f, before: before[f], after: after[f] }));
      const what = op === "carry" ? `${dayText(before.date)} → ${dayText(to)} に繰り越し` : op === "date" ? `製造日 ${dayText(before.date)} → ${dayText(to)}` : op === "undecided" ? "製造日未定にした" : op === "auto" ? `製造日を元の日 (${dayText(row.baseDate)}) に戻した` : op === "done" ? "製造済み" : op === "cancel" ? "製造の予定から外した" : "予定に戻した";
      addAudit(db, { userId: user.id, action: "update", entity: "production", entityId: rec.id, entityLabel: label(row), summary: `畳製造予定: ${label(row)} ${what}`, storeId: row.storeId, changes });
      done.push(op === "carry" ? `${row.name} → ${dayText(to)}` : row.name);
    }
    return done;
  });
  revalidatePath(PAGE);
  revalidatePath("/schedule");
  if (!result.length) fail(back, "対象の製造の予定が見つかりませんでした (受注・予定が変わった可能性があります)。画面を開き直してください。");
  const msg =
    op === "carry"
      ? `繰り越しました: ${result.slice(0, 5).join("、")}${result.length > 5 ? ` ほか ${result.length - 5} 件` : ""}。引取日・納品日の予定は変わりません。`
      : op === "date"
        ? `製造日を ${dayText(date)} にしました (${result.length} 件)。引取日・納品日の予定は変わりません。`
        : op === "undecided"
          ? `製造日未定にしました (${result.length} 件)。`
          : op === "auto"
            ? "製造日を元の日 (引取日・採寸日) に戻しました。"
            : op === "done"
              ? `製造済みにしました (${result.length} 件)。`
              : op === "cancel"
                ? "製造の予定から外しました。"
                : "予定に戻しました。";
  redirect(withMsg(back, msg));
}

/** 製造の予定を手で足す (受注・予定表にない製造。例: 在庫の畳・置き畳の製作) */
export async function addProduction(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), PAGE);
  if (!canEditProduction(user)) fail(back, "畳製造予定を変更する権限がありません。");
  const db0 = getDb();
  const storeId = str(formData, "storeId") as StoreId;
  if (!db0.stores.some((s) => s.id === storeId)) fail(back, "店舗を選んでください。");
  const title = str(formData, "title").slice(0, 80);
  if (!title) fail(back, "案件・内容を入れてください。");
  const spec = str(formData, "spec").slice(0, 200);
  // 部屋ごとの仕様 (畳表・マイト・畳縁・畳床・寸法)。入れたときは畳数・縁無の畳数も部屋の合計
  let rawRooms: unknown = [];
  try {
    rawRooms = JSON.parse(str(formData, "rooms") || "[]");
  } catch {
    fail(back, "仕様の形式が正しくありません。もう一度入力してください。");
  }
  const parsedRooms = cleanRooms(rawRooms);
  if (parsedRooms.error) fail(back, parsedRooms.error);
  const rooms = parsedRooms.rooms;
  const totals = roomTotals(rooms);
  const qty = rooms.length && totals.qty > 0 ? totals.qty : Number(str(formData, "qty") || 0);
  const herinashi = rooms.length && totals.qty > 0 ? totals.herinashi : Number(str(formData, "herinashi") || 0);
  if (!Number.isFinite(qty) || qty < 0 || qty > 500 || !Number.isFinite(herinashi) || herinashi < 0 || herinashi > 500) fail(back, "畳数は 0〜500 の数で入れてください。");
  const undecided = str(formData, "undecided") === "1";
  const date = str(formData, "date");
  if (!undecided && !isDateKey(date)) fail(back, "製造日を入れるか、「製造日未定」を選んでください。");
  const orderNumber = str(formData, "orderNumber");
  const order = orderNumber ? db0.orders.find((o) => o.number === orderNumber.trim()) : undefined;
  if (orderNumber && !order) fail(back, `受注番号「${orderNumber}」が見つかりません。`);
  const note = str(formData, "note").slice(0, 300);
  const missing = await productionTableMissing();
  if (missing) fail(back, missing);

  await mutate((db) => {
    const now = nowIso();
    const id = newId("tp");
    const rec: TatamiProduction = {
      id,
      sourceKey: `man:${id}`,
      storeId,
      orderId: order?.id,
      customerId: order?.customerId,
      date: undecided ? undefined : date,
      undecided: undecided || undefined,
      status: "planned",
      title,
      spec: spec || undefined,
      qty: qty || undefined,
      herinashi: herinashi || undefined,
      rooms: rooms.length ? rooms : undefined,
      note: note || undefined,
      history: [{ at: now, by: user.id, action: "create", to: undecided ? undefined : date }],
      createdBy: user.id,
      createdAt: now,
      updatedBy: user.id,
      updatedAt: now,
    };
    db.tatamiProduction.push(rec);
    addAudit(db, { userId: user.id, action: "create", entity: "production", entityId: id, entityLabel: title, summary: `畳製造予定を追加: ${title} ${undecided ? "製造日未定" : shortDate(date)} ${qty ? `${qty}畳` : ""}${rooms.length ? ` (${roomsText(rooms).slice(0, 160)})` : ""}`.trim(), storeId });
  });
  revalidatePath(PAGE);
  revalidatePath("/schedule");
  redirect(withMsg(back, `製造の予定を追加しました: ${title}`));
}

/** 手で足した製造の予定を削除する */
export async function deleteProduction(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), PAGE);
  if (!canEditProduction(user)) fail(back, "畳製造予定を変更する権限がありません。");
  const id = str(formData, "id");
  const missing = await productionTableMissing();
  if (missing) fail(back, missing);
  const ok = await mutate((db) => {
    const rec = db.tatamiProduction.find((r) => r.id === id && r.sourceKey.startsWith("man:"));
    if (!rec) return false;
    db.tatamiProduction = db.tatamiProduction.filter((r) => r.id !== id);
    addAudit(db, { userId: user.id, action: "delete", entity: "production", entityId: id, entityLabel: rec.title ?? id, summary: `畳製造予定を削除: ${rec.title ?? id}`, storeId: rec.storeId });
    return true;
  });
  revalidatePath(PAGE);
  revalidatePath("/schedule");
  if (!ok) fail(back, "削除できるのは手で追加した製造の予定だけです。");
  redirect(withMsg(back, "製造の予定を削除しました。"));
}

/**
 * 部屋ごとの仕様 (畳表・畳縁・畳床・寸法。src/lib/tatami-spec.ts) を畳製造予定の画面で入れる・直す。
 * 受注の行はその受注の仕様 (この行の作業の部屋を置き換え、ほかの作業の部屋は残す)、受注のない行は製造予定の行に保存する
 */
export async function saveProductionRooms(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), PAGE);
  if (!canEditProduction(user)) fail(back, "畳製造予定を変更する権限がありません。");
  const key = str(formData, "key");
  let raw: unknown;
  try {
    raw = JSON.parse(str(formData, "rooms") || "[]");
  } catch {
    fail(back, "仕様の形式が正しくありません。もう一度入力してください。");
  }
  const parsed = cleanRooms(raw);
  if (parsed.error) fail(back, parsed.error);
  const today = toDateKey(new Date());
  const row0 = findProductionRow(getDb(), key, today);
  if (!row0) fail(back, "製造の予定が見つかりません。");
  if (row0.roomsTarget.kind === "record") {
    const missing = await productionTableMissing();
    if (missing) fail(back, missing);
  }
  let changed = false;
  await mutate((db) => {
    const row = findProductionRow(db, key, today);
    if (!row) fail(back, "製造の予定が見つかりません。");
    const now = nowIso();
    if (row.roomsTarget.kind === "order") {
      const target = row.roomsTarget;
      const o = db.orders.find((x) => x.id === target.orderId);
      if (!o) fail(back, "受注が見つかりません。");
      const before = orderRooms(db, o);
      const next = [...before.rooms.filter((r) => !target.works.includes(r.work)), ...parsed.rooms];
      if (before.source === "order" && sameRooms(before.rooms, next)) return;
      o.tatamiRooms = next;
      o.updatedAt = now;
      changed = true;
      addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `畳の仕様 (部屋ごと) を畳製造予定で入力: ${roomsText(parsed.rooms).slice(0, 200)}`, storeId: o.storeId, changes: [{ field: "tatamiRooms", before: before.source === "order" ? before.rooms : null, after: next }] });
      return;
    }
    const rec = ensureRecord(db, row, user.id, now);
    const before = cleanRooms(rec.rooms ?? []).rooms;
    if (sameRooms(before, parsed.rooms)) return;
    rec.rooms = parsed.rooms.length ? parsed.rooms : undefined;
    rec.updatedBy = user.id;
    rec.updatedAt = now;
    pushHistory(rec, { at: now, by: user.id, action: "edit", note: "部屋ごとの仕様" });
    changed = true;
    addAudit(db, { userId: user.id, action: "update", entity: "production", entityId: rec.id, entityLabel: label(row), summary: `畳の仕様 (部屋ごと) を入力: ${roomsText(parsed.rooms).slice(0, 200)}`, storeId: rec.storeId, changes: [{ field: "rooms", before, after: parsed.rooms }] });
  });
  revalidatePath(PAGE);
  if (row0.orderId) revalidatePath(`/orders/${row0.orderId}`);
  redirect(withMsg(back, changed ? `${label(row0)} の仕様 (部屋ごと) を保存しました。` : "変更はありませんでした。"));
}
