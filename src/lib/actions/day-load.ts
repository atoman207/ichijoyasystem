"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, nowIso } from "@/lib/db/store";
import { canAccessStore, canManageSettings } from "@/lib/auth/permissions";
import { DAY_CARRY_ID, DAY_LOAD_ID, PER_EVENT_OPTIONS, SHEET_ITEMS, SHEET_ITEM_LABEL, dayLoadChanges, readDayLoadSettings, writeCarryFix, writeDayLoadSettings, type DayLoadSettings } from "@/lib/day-sheet";
import { isDateKey } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 1 日の対応可能枚数の設定 (お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」③)
 * 1 人の枚数 (既定 11)・換算 (畳 1・襖 1・障子 0.5・網戸 0.5)・見積など 1 件の換算 (既定 3) と種類・前日繰越と数え始める日・
 * 店舗ごとの対象から外す社員と人数・納品も数えるか・休暇を引くか。管理者
 */
export async function updateDayLoad(formData: FormData) {
  const back = "/schedule/capacity?tab=dayload";
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "1 日の対応可能枚数の設定は管理者のみ変更できます。");
  const db0 = getDb();
  const num = (key: string, label: string, min: number, max: number, required: boolean): number | undefined => {
    const raw = str(formData, key).normalize("NFKC");
    if (!raw) {
      if (required) fail(back, `「${label}」を入力してください。`);
      return undefined;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) fail(back, `「${label}」は ${min}〜${max} の数で入力してください。`);
    return Math.round(n * 100) / 100;
  };
  const before = readDayLoadSettings(db0);
  const stores: DayLoadSettings["stores"] = {};
  for (const s of db0.stores) {
    if (s.kind === "hq") continue;
    const members = db0.users.filter((u) => u.active && u.storeId === s.id).map((u) => u.id);
    const included = new Set(formData.getAll(`${s.id}.include`).map(String));
    // 画面にない社員 (あとから足した・無効にした) の対象外は残す
    const keep = (before.stores[s.id]?.excludeUserIds ?? []).filter((id) => !members.includes(id));
    stores[s.id] = { excludeUserIds: [...members.filter((id) => !included.has(id)), ...keep], people: num(`${s.id}.people`, `${s.shortName}の人数`, 0, 99, false) };
  }
  const perPerson = num("perPerson", "1 人の 1 日の対応可能枚数", 1, 99, true)!;
  const weights = Object.fromEntries(SHEET_ITEMS.map((k) => [k, num(`w.${k}`, `${SHEET_ITEM_LABEL[k]}の換算`, 0, 10, true)!])) as DayLoadSettings["weights"];
  const perEvent = num("perEvent", "見積など 1 件の換算", 0, 99, true)!;
  const carryFrom = str(formData, "carryFrom");
  if (!isDateKey(carryFrom)) fail(back, "「繰り越しを数え始める日」を入力してください。");
  const kinds = formData.getAll("perEventKinds").map(String);
  const next: DayLoadSettings = {
    perPerson,
    weights,
    countDelivery: formData.get("countDelivery") === "1",
    perEventKinds: PER_EVENT_OPTIONS.filter((k) => kinds.includes(k)),
    perEvent,
    subtractLeave: formData.get("subtractLeave") === "1",
    carry: formData.get("carry") === "1",
    carryFrom,
    carryFix: before.carryFix,
    stores,
  };
  await mutate((db) => {
    const changes = dayLoadChanges(db, readDayLoadSettings(db), next);
    writeDayLoadSettings(db, next, user.id, nowIso());
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: DAY_LOAD_ID,
      entityLabel: "1 日の対応可能枚数",
      summary: changes.length ? `1 日の対応可能枚数の設定を変更 (${changes.length} 項目)` : "1 日の対応可能枚数の設定を保存 (変更なし)",
      changes,
    });
  });
  revalidatePath("/schedule");
  revalidatePath("/schedule/capacity");
  redirect(withMsg(back, "1 日の対応可能枚数の設定を保存しました。予定表の日の表示に反映されます。"));
}

/**
 * 前日繰越を手で直す (スプレッドシートで「繰り越し」の欄を書き直していたのと同じ。お客様のご要望 2026-11-25 の補足「③」)。
 * value が空なら自動の計算に戻す。その店舗の予定表を変更できる人 (自店舗・本部・管理者)。変更履歴つき
 */
export async function setDayCarry(formData: FormData) {
  const user = await requireActionUser();
  const storeId = str(formData, "storeId");
  const day = str(formData, "date");
  const back = safeReturn(str(formData, "returnTo"), `/schedule?view=day&date=${isDateKey(day) ? day : ""}`);
  const db0 = getDb();
  const store = db0.stores.find((s) => s.id === storeId);
  if (!store || store.kind === "hq" || !isDateKey(day)) fail(back, "店舗・日付が正しくありません。");
  if (!canAccessStore(user, storeId)) fail(back, `${store.name}の前日繰越は、${store.name}の社員・本部・管理者が直せます。`);
  const raw = str(formData, "value").normalize("NFKC").trim();
  let value: number | undefined;
  if (raw) {
    value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 9999) fail(back, "前日繰越は 0〜9999 の枚数で入力してください。");
    value = Math.round(value * 10) / 10;
  }
  await mutate((db) => {
    const prev = readDayLoadSettings(db).carryFix[storeId]?.[day];
    writeCarryFix(db, storeId, day, value, user.id, nowIso(), toDateKey(new Date()));
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: DAY_CARRY_ID,
      entityLabel: `前日繰越 ${store!.shortName} ${day}`,
      summary: value === undefined ? `${store!.name}の ${day} の前日繰越を自動の計算に戻しました` : `${store!.name}の ${day} の前日繰越を ${value} 枚にしました`,
      storeId,
      changes: [{ field: `前日繰越 ${day}`, before: prev ?? "自動", after: value ?? "自動" }],
    });
  });
  revalidatePath("/schedule");
  redirect(withMsg(back, value === undefined ? "前日繰越を自動の計算に戻しました。" : `前日繰越を ${value} 枚にしました。`));
}
