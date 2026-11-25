"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { mutate } from "@/lib/db/store";
import { isUnread } from "@/lib/change-notices";
import { requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 変更のお知らせを読んだことにする (お客様のご要望 2026-11-25「⑥」。src/lib/change-notices.ts)。
 * ids (複数) か all = 1 (自分あての未読をすべて)。読んだ人だけを足す (お知らせの内容は変えない)
 */
export async function markNoticesRead(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/notices");
  const all = str(formData, "all") === "1";
  const ids = new Set(formData.getAll("ids").map(String));
  let count = 0;
  await mutate((db) => {
    for (const n of db.changeNotices ?? []) {
      if (!isUnread(user, n) || (!all && !ids.has(n.id))) continue;
      n.readBy = [...n.readBy, user.id];
      count++;
    }
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, count ? `${count} 件のお知らせを既読にしました。` : "未読のお知らせはありません。"));
}
