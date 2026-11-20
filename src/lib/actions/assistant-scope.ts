"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate } from "@/lib/db/store";
import { canManageAssistantScope } from "@/lib/auth/permissions";
import { isDateKey } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { ASSISTANT_SCOPE_ID, assistantScope } from "@/lib/assistant/scope";
import { fail, requireActionUser, str, withMsg } from "./guards";

/** AI アシスタントの閲覧範囲 (権限どおり / 全店舗) の切り替え: 管理者 (src/lib/assistant/scope.ts) */
export async function setAssistantScope(formData: FormData) {
  const user = await requireActionUser();
  const back = "/ai?tab=bot";
  if (!canManageAssistantScope(user)) fail(back, "AI アシスタントの閲覧範囲は管理者が変更できます。");
  const mode = str(formData, "mode") === "all_stores" ? "all_stores" : "permission";
  const until = mode === "all_stores" ? str(formData, "until") : "";
  if (until && !isDateKey(until)) fail(back, "終了日を正しく入力してください。");
  if (until && until < toDateKey(new Date())) fail(back, "終了日は今日以降にしてください。");
  await mutate((db) => {
    const before = assistantScope(db);
    const now = new Date().toISOString();
    const value = { mode, ...(until ? { until } : {}) };
    const row = db.settings.find((s) => s.id === ASSISTANT_SCOPE_ID);
    if (row) {
      row.value = value;
      row.updatedBy = user.id;
      row.updatedAt = now;
    } else db.settings.push({ id: ASSISTANT_SCOPE_ID, value, updatedBy: user.id, updatedAt: now });
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: ASSISTANT_SCOPE_ID,
      entityLabel: "AI アシスタントの閲覧範囲",
      summary: mode === "all_stores" ? `AI アシスタントの閲覧範囲を「全店舗」に変更${until ? ` (${until} まで)` : ""}` : "AI アシスタントの閲覧範囲を「権限どおり」に戻す",
      storeId: "hq",
      changes: [
        { field: "mode", before: before.mode, after: mode },
        { field: "until", before: before.until ?? "", after: until },
      ],
    });
  });
  revalidatePath("/ai");
  redirect(withMsg(back, mode === "all_stores" ? `AI アシスタントは、全員が全店舗のデータを調べて答えるようになりました${until ? ` (${until} まで。過ぎると権限どおりに戻ります)` : ""}。` : "AI アシスタントの閲覧範囲を権限どおりに戻しました。"));
}
