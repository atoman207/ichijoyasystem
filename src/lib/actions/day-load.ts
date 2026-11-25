"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, nowIso } from "@/lib/db/store";
import { canManageSettings } from "@/lib/auth/permissions";
import { DAY_LOAD_ID, SHEET_ITEMS, SHEET_ITEM_LABEL, dayLoadChanges, readDayLoadSettings, writeDayLoadSettings, type DayLoadSettings } from "@/lib/day-sheet";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 1 日の対応可能枚数の設定 (お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」③)
 * 1 人の枚数 (既定 11)・換算 (畳 1・襖 1・障子 0.5・網戸 0.5)・店舗ごとの対象から外す社員と人数・納品も数えるか・休暇を引くか。管理者
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
  const next: DayLoadSettings = {
    perPerson: num("perPerson", "1 人の 1 日の対応可能枚数", 1, 99, true)!,
    weights: Object.fromEntries(SHEET_ITEMS.map((k) => [k, num(`w.${k}`, `${SHEET_ITEM_LABEL[k]}の換算`, 0, 10, true)!])) as DayLoadSettings["weights"],
    countDelivery: formData.get("countDelivery") === "1",
    countEstimates: formData.get("countEstimates") === "1",
    subtractLeave: formData.get("subtractLeave") === "1",
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
