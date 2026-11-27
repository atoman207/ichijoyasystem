"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { applySalesSlips, normalizeSlip, type SalesImportReport, type SalesSlip } from "@/lib/sales-ledger";
import { applyReconcile, planReconcile } from "@/lib/sales-reconcile";
import { applySlipRelink, planSlipRelink } from "@/lib/sales-relink";
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
      const now = new Date().toISOString();
      const r = applySalesSlips(db, slips as SalesSlip[], { now, userId: user.id });
      // 売上台帳の受注と二重になった伝票の受注をまとめる (src/lib/sales-reconcile.ts)
      const rec = applyReconcile(db, planReconcile(db), { now });
      r.duplicatesMerged = rec.ordersRemoved;
      r.customersMerged += rec.customersMerged;
      // 売上台帳の受注を、ひも付いた伝票の得意先のお客様に付け替える (同じ名字・地区の何人かの受注を持つ台帳のお客様。src/lib/sales-relink.ts。
      // お客様のご連絡 2026-11-28「コンパスには売上履歴があるが新システムにはない」)
      const rel = applySlipRelink(db, planSlipRelink(db, slips as SalesSlip[]), { now, userId: user.id, audit: (e) => addAudit(db, { userId: user.id, ...e }) });
      r.ordersRelinked = rel.moved;
      r.customersMerged += rel.removed;
      addAudit(db, {
        userId: user.id,
        action: "import",
        entity: "data",
        entityId: "sales-ledger",
        entityLabel: "売上明細",
        summary: `売上明細 (${fileName}) を取込${part}: 伝票 ${r.slips - r.unchanged} 枚 / 顧客 新規 ${r.customersCreated}・更新 ${r.customersUpdated}・統合 ${r.customersMerged} / 受注 新規 ${r.ordersCreated}・更新 ${r.ordersUpdated}・ひも付け ${r.ordersLinked}${r.duplicatesMerged ? `・売上台帳と二重の受注をまとめた ${r.duplicatesMerged}` : ""}${r.ordersRelinked ? `・売上台帳の受注を伝票の得意先に付け替え ${r.ordersRelinked}` : ""}`,
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

/* ---------- 売上台帳と二重になった伝票の受注をまとめる (確認 → 実行) ---------- */

export interface SalesReconcilePreview {
  pairs: number;
  ordersRemoved: number;
  /** 消す伝票の受注の金額の合計 (= 売上の合計が減る額) */
  amountRemoved: number;
  /** 年ごとの売上 (今 → まとめたあと) */
  years: { year: string; before: number; after: number; pairs: number }[];
  /** 組の例 (新しい月から 40 組) */
  samples: { month: string; ledger: string; slips: string; reason: string }[];
  hash: string;
}

function reconcilePlanHash(pairs: { ledgerIds: string[]; slipOrderIds: string[] }[]): string {
  return createHash("sha256").update(JSON.stringify(pairs.map((p) => [p.ledgerIds, p.slipOrderIds]))).digest("hex").slice(0, 32);
}

export async function previewSalesReconcile(): Promise<Result<SalesReconcilePreview>> {
  try {
    await guard();
    const db = getDb();
    const pairs = planReconcile(db);
    const orderById = new Map(db.orders.map((o) => [o.id, o]));
    const customerName = new Map(db.customers.map((c) => [c.id, c.name]));
    const label = (id: string) => {
      const o = orderById.get(id);
      return o ? `${o.number} ${customerName.get(o.customerId) ?? ""} ${o.salesDate ?? ""} ¥${o.total.toLocaleString("ja-JP")}` : id;
    };
    const removed = new Set(pairs.flatMap((p) => p.slipOrderIds));
    const years = new Map<string, { year: string; before: number; after: number; pairs: number }>();
    for (const o of db.orders) {
      if (o.status === "cancelled" || !o.salesDate) continue;
      const y = o.salesDate.slice(0, 4);
      const r = years.get(y) ?? years.set(y, { year: y, before: 0, after: 0, pairs: 0 }).get(y)!;
      r.before += o.total;
      if (!removed.has(o.id)) r.after += o.total;
    }
    for (const p of pairs) {
      const r = years.get(p.month.slice(0, 4));
      if (r) r.pairs++;
    }
    return {
      ok: true,
      data: {
        pairs: pairs.length,
        ordersRemoved: removed.size,
        amountRemoved: [...removed].reduce((a, id) => a + (orderById.get(id)?.total ?? 0), 0),
        years: [...years.values()].filter((y) => y.pairs > 0).sort((a, b) => b.year.localeCompare(a.year)),
        samples: [...pairs]
          .reverse()
          .slice(0, 40)
          .map((p) => ({ month: p.month, ledger: p.ledgerIds.map(label).join(" + "), slips: p.slipOrderIds.map(label).join(" + "), reason: p.reason })),
        hash: reconcilePlanHash(pairs),
      },
    };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function applySalesReconcile(hash: string): Promise<Result<{ pairs: number; ordersRemoved: number; customersMerged: number }>> {
  let user;
  try {
    user = await guard();
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
  try {
    const out = await mutate((db) => {
      const pairs = planReconcile(db);
      if (!pairs.length) return { pairs: 0, ordersRemoved: 0, customersMerged: 0 };
      if (reconcilePlanHash(pairs) !== hash) throw new Error("STALE");
      const rec = applyReconcile(db, pairs, { now: new Date().toISOString() });
      addAudit(db, {
        userId: user.id,
        action: "import",
        entity: "data",
        entityId: "sales-reconcile",
        entityLabel: "売上台帳と売上明細の二重計上",
        summary: `売上台帳と二重になっていた伝票の受注をまとめました: ${rec.pairs.length} 組・受注 ${rec.ordersRemoved} 件を台帳の受注へ (お客様の統合 ${rec.customersMerged})`,
      });
      return { pairs: rec.pairs.length, ordersRemoved: rec.ordersRemoved, customersMerged: rec.customersMerged };
    });
    revalidatePath("/customers");
    revalidatePath("/orders");
    revalidatePath("/reports");
    revalidatePath("/");
    revalidatePath("/data");
    return { ok: true, data: out };
  } catch (err) {
    unstable_rethrow(err);
    if ((err as Error).message === "STALE") return { ok: false, error: "確認のあとにデータが変わりました。もう一度「確認する」を押してください。" };
    console.error("[sales-reconcile] failed:", err);
    return { ok: false, error: "まとめられませんでした。時間をおいて再度お試しください。" };
  }
}
