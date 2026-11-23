"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, nowIso } from "@/lib/db/store";
import { canEditProduction } from "@/lib/auth/permissions";
import { cleanRooms, roomsText, sameRooms } from "@/lib/tatami-spec";
import { orderRooms, quoteRooms } from "@/lib/tatami-rooms";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 畳の仕様 (部屋ごと。畳表・畳縁・畳床・寸法。src/lib/tatami-spec.ts) の入力 (見積・受注の画面)。
 * 金額に関わらないので承認は要らない。製造の現場 (職人) も現地の採寸のあとに直せるよう、有効な社員なら入れられる (canEditProduction)。
 * 受注にした見積の仕様は受注の画面で直す (畳製造予定は受注の仕様を使う)
 */

function parseRooms(formData: FormData, back: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(str(formData, "rooms") || "[]");
  } catch {
    fail(back, "仕様の形式が正しくありません。もう一度入力してください。");
  }
  const parsed = cleanRooms(raw);
  if (parsed.error) fail(back, parsed.error);
  return parsed.rooms;
}

export async function saveQuoteTatamiRooms(quoteId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${quoteId}`;
  if (!canEditProduction(user)) fail(back, "畳の仕様を入力する権限がありません。");
  const rooms = parseRooms(formData, back);
  let changed = false;
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === quoteId);
    if (!q) fail("/quotes", "見積が見つかりません。");
    if (q.orderId) fail(back, "受注にした見積です。畳の仕様は受注の画面で入力・変更してください。");
    const before = quoteRooms(db, q);
    if (before.source === "quote" && sameRooms(before.rooms, rooms)) return;
    const now = nowIso();
    q.tatamiRooms = rooms.length ? rooms : undefined;
    q.updatedAt = now;
    changed = true;
    addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `畳の仕様 (部屋ごと) を入力: ${roomsText(rooms).slice(0, 200)}`, storeId: q.storeId, changes: [{ field: "tatamiRooms", before: before.source === "quote" ? before.rooms : null, after: rooms }] });
  });
  revalidatePath(back);
  revalidatePath("/schedule/production");
  redirect(withMsg(back, changed ? "畳の仕様 (部屋ごと) を保存しました。受注にすると畳製造予定に反映されます。" : "変更はありませんでした。"));
}

export async function saveOrderTatamiRooms(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${orderId}`;
  if (!canEditProduction(user)) fail(back, "畳の仕様を入力する権限がありません。");
  const rooms = parseRooms(formData, back);
  let changed = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "受注が見つかりません。");
    if (o.status === "cancelled") fail(back, "キャンセルした受注です。");
    const before = orderRooms(db, o);
    if (before.source === "order" && sameRooms(before.rooms, rooms)) return;
    const now = nowIso();
    o.tatamiRooms = rooms.length ? rooms : undefined;
    o.updatedAt = now;
    changed = true;
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `畳の仕様 (部屋ごと) を入力: ${roomsText(rooms).slice(0, 200)}`, storeId: o.storeId, changes: [{ field: "tatamiRooms", before: before.source === "order" ? before.rooms : null, after: rooms }] });
  });
  revalidatePath(back);
  revalidatePath("/schedule/production");
  redirect(withMsg(back, changed ? "畳の仕様 (部屋ごと) を保存しました。畳製造予定に反映しました。" : "変更はありませんでした。"));
}
