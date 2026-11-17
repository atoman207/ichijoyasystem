"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate } from "@/lib/db/store";
import { canRunBackup } from "@/lib/auth/permissions";
import { startBackup } from "@/lib/backup";
import { fail, requireActionUser, withMsg } from "./guards";

/** 今すぐバックアップ (管理者)。終わるのは待たない (設定 → データ管理 に結果が出る) */
export async function runBackupNow() {
  const back = "/settings?tab=data";
  const user = await requireActionUser();
  if (!canRunBackup(user)) fail(back, "バックアップは管理者が行います。");
  const r = startBackup(user.name);
  if (!r.ok) fail(back, r.error);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "create", entity: "settings", entityId: "backup", entityLabel: "バックアップ", summary: "バックアップを手動で実行 (データベース・添付ファイル・写真をこの VPS に保存)" });
  });
  revalidatePath("/settings");
  redirect(withMsg(back, "バックアップを始めました。通常 1 分ほどで終わります (この画面に結果が出ます)。"));
}
