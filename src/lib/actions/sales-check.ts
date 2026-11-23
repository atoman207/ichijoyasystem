"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { parseSalesReference, salesReference, SALES_REFERENCE_ID, type SalesReferenceRow } from "@/lib/sales-check";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 売上の照合 (/data/sales-check) の「旧システムの数字」を保存する (管理者・本部スタッフ)。
 * 1 行 = 月,店舗,金額[,メモ]。同じ月・店舗の行は置き換え、入力にない月・店舗の行は残す (「すべて置き換える」なら消す)
 */
export async function saveSalesReference(formData: FormData) {
  const user = await requireActionUser();
  const back = `/data/sales-check${str(formData, "qs") ? `?${str(formData, "qs")}` : ""}`;
  if (!canImportData(user)) fail(back, "旧システムの数字の入力は管理者・本部スタッフが行います。");
  const text = str(formData, "rows");
  const label = str(formData, "label").slice(0, 40);
  const replaceAll = str(formData, "replaceAll") === "1";
  const { rows, errors } = parseSalesReference(text, getDb().stores);
  if (errors.length) fail(back, `読めない行があります: ${errors.slice(0, 5).join(" / ")}${errors.length > 5 ? ` ほか ${errors.length - 5} 行` : ""}`);
  if (!rows.length && !replaceAll) fail(back, "入力がありません (1 行に 月,店舗,金額)。");
  let count = 0;
  await mutate((db) => {
    const now = new Date().toISOString();
    const before = salesReference(db);
    const keep: SalesReferenceRow[] = replaceAll ? [] : before.rows.filter((r) => !rows.some((x) => x.month === r.month && x.storeId === r.storeId));
    const next = [...keep, ...rows].sort((a, b) => a.month.localeCompare(b.month) || a.storeId.localeCompare(b.storeId));
    count = rows.length;
    const value = { rows: next, label: label || before.label };
    const row = db.settings.find((s) => s.id === SALES_REFERENCE_ID);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
    else db.settings.push({ id: SALES_REFERENCE_ID, value, updatedBy: user.id, updatedAt: now });
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: SALES_REFERENCE_ID,
      entityLabel: "売上の照合 (旧システムの数字)",
      summary: `売上の照合の「${value.label}」の数字を${replaceAll ? "置き換え" : "保存"} (${rows.length} 行・合計 ${next.length} 行)`,
      changes: [{ field: "rows", before: before.rows.length, after: next.length }],
    });
  });
  revalidatePath("/data/sales-check");
  redirect(withMsg(back, `${count} 行を保存しました。表の「${label || "旧システム"}」の列と差に出ます。`));
}
