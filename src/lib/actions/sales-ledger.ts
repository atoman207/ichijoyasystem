"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { applySalesSlips, normalizeSlip, type SalesImportReport, type SalesSlip } from "@/lib/sales-ledger";
import { requireActionUser } from "./guards";

/**
 * 販売管理ソフトの「売上明細」CSV の取込。管理者・本部スタッフのみ
 * 画面で CSV を読み、取込済みの伝票の指紋 (salesLedgerFingerprints) と比べて追加・変更された伝票だけを
 * 得意先ごとのまとまりで分けて送る (importSalesSlips)。同じ伝票を何度送っても同じ状態になる
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function guard() {
  const user = await requireActionUser();
  if (!canImportData(user)) throw new Error("データの取込は管理者・本部スタッフが行います。");
  return user;
}

/** 取込済みの伝票: 伝票№ → 指紋 */
export async function salesLedgerFingerprints(): Promise<Result<Record<string, string>>> {
  try {
    await guard();
    const out: Record<string, string> = {};
    for (const o of getDb().orders)
      for (const n of o.progressNotes)
        if (n.id.startsWith("pn_s")) {
          const [no, fp] = n.id.slice(4).split("_");
          out[no] = fp ?? "";
        }
    return { ok: true, data: out };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function importSalesSlips(input: unknown[], meta: { fileName: string; part: number; parts: number }): Promise<Result<SalesImportReport>> {
  let user;
  try {
    user = await guard();
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > 20000) return { ok: false, error: "取込の内容が正しくありません。" };
  const slips = input.map(normalizeSlip);
  if (slips.some((s) => !s)) return { ok: false, error: "取込の内容が正しくありません (読み取れない伝票があります)。" };
  const fileName = String(meta?.fileName ?? "CSV").slice(0, 120);
  const part = `${Number(meta?.parts) > 1 ? ` (${Number(meta.part)}/${Number(meta.parts)})` : ""}`;
  try {
    const report = await mutate((db) => {
      const r = applySalesSlips(db, slips as SalesSlip[], { now: new Date().toISOString(), userId: user.id });
      addAudit(db, {
        userId: user.id,
        action: "import",
        entity: "data",
        entityId: "sales-ledger",
        entityLabel: "売上明細",
        summary: `売上明細 (${fileName}) を取込${part}: 伝票 ${r.slips - r.unchanged} 枚 / 顧客 新規 ${r.customersCreated}・更新 ${r.customersUpdated}・統合 ${r.customersMerged} / 受注 新規 ${r.ordersCreated}・更新 ${r.ordersUpdated}・ひも付け ${r.ordersLinked}`,
      });
      return r;
    });
    revalidatePath("/customers");
    revalidatePath("/orders");
    revalidatePath("/reports");
    revalidatePath("/");
    revalidatePath("/data");
    return { ok: true, data: report };
  } catch (err) {
    unstable_rethrow(err);
    console.error("[sales-ledger] import failed:", err);
    return { ok: false, error: (err as Error).message.startsWith("データベース") ? (err as Error).message : "取込に失敗しました。時間をおいて再度お試しください。" };
  }
}
