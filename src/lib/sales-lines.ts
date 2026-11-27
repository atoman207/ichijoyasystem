import "server-only";
import type { Approval, Database, Order, Quote, QuoteItem, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { approverRole } from "@/lib/auth/permissions";
import { approvalSettings } from "@/lib/approval-rules";
import { settleOwnApproval } from "@/lib/approval-decide";
import { quoteTotals, taxModeOf } from "@/lib/quote-calc";
import { autoUnit } from "@/lib/line-kind";
import { closedReason } from "@/lib/mgmt/close";
import { amendBlockedByInvoice } from "@/lib/invoice-sync";
import { fail } from "@/lib/actions/guards";

/**
 * 売上確定・請求書発行の画面の「明細・金額」(お客様のご要望 2026-11-27「■1」)。mutate の中で呼ぶ
 * ------------------------------------------------------------
 * 明細・金額の変更は見積の新しい版 (承認の type = quote_amend。見積の画面の「変更を申請」と同じ記録) として残し、受注の金額・請求書に反映する
 * (src/lib/approval-decide.ts の quote_amend → src/lib/invoice-sync.ts の syncInvoiceToOrder)。
 * - 売上確定の前: これまでの決まり (差額が設定の金額以下・仕様だけは承認なし、それを超えると店長・管理者の承認。店長・管理者は承認不要)
 * - 売上確定のあと (施工完了・請求済・入金済): 一般社員は差額にかかわらず店長の承認、店長・管理者は自分の権限で反映
 * - 入金の記録がある請求書・まとめ請求の請求書・月次確定した月の売上は直さない
 */

const CONFIRMED = new Set(["completed", "invoiced", "paid"]);
export const salesConfirmed = (o: Pick<Order, "status">): boolean => CONFIRMED.has(o.status);

/** 画面の明細 (JSON) → 見積の明細。元の明細の ID が来たら、商品・品目・畳床の選択はその明細のまま */
export function parseSalesItems(db: Pick<Database, "products">, raw: string, q: Pick<Quote, "items">, back: string): QuoteItem[] {
  let rows: unknown;
  try {
    rows = JSON.parse(raw || "[]");
  } catch {
    fail(back, "明細の形式が正しくありません。もう一度入力してください。");
  }
  if (!Array.isArray(rows)) fail(back, "明細の形式が正しくありません。");
  const byId = new Map(q.items.map((i) => [i.id, i]));
  const items: QuoteItem[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const name = String(r?.name ?? "").trim().slice(0, 100);
    if (!name) continue;
    const qty = Number(String(r.qty ?? "").normalize("NFKC"));
    const unitPrice = Number(String(r.unitPrice ?? "").normalize("NFKC").replace(/[,¥\s]/g, ""));
    if (!Number.isFinite(qty) || qty <= 0) fail(back, `「${name}」の数量を正しく入れてください。`);
    if (!Number.isFinite(unitPrice)) fail(back, `「${name}」の単価を正しく入れてください (値引きはマイナス)。`);
    const spec = String(r.spec ?? "").trim().slice(0, 200) || undefined;
    const orig = typeof r.id === "string" ? byId.get(r.id) : undefined;
    const productId = orig?.productId;
    const unit = String(r.unit ?? "").trim().slice(0, 10) || autoUnit(name, spec, productId ? db.products.find((p) => p.id === productId)?.category : undefined) || "式";
    items.push({
      id: orig?.id ?? newId("qi"),
      ...(productId ? { productId } : {}),
      name,
      ...(spec ? { spec } : {}),
      qty,
      unit,
      unitPrice: Math.round(unitPrice),
      amount: Math.round(qty * Math.round(unitPrice)),
      ...(orig?.itemCategory ? { itemCategory: orig.itemCategory } : {}),
      ...(orig?.dokoMaterialId ? { dokoMaterialId: orig.dokoMaterialId } : {}),
    });
  }
  if (!items.length) fail(back, "明細を 1 行以上入れてください。");
  return items;
}

const lineKey = (i: Pick<QuoteItem, "name" | "spec" | "qty" | "unit" | "unitPrice">) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice];

export type AmendResult = { state: "same" } | { state: "applied" | "pending"; role: "store_manager" | "admin"; approvalId: string; before: number; after: number };

/**
 * 明細・値引きの変更を見積の新しい版にする (承認を省略できればその場で反映 = applied、できなければ申請 = pending)
 */
export function amendOrderQuote(db: Database, user: User, o: Order, q: Quote, next: { items: QuoteItem[]; discount: number }, reason: string, back: string): AmendResult {
  const mode = taxModeOf(q);
  const t = quoteTotals(next.items, next.discount, mode);
  const same = JSON.stringify(next.items.map(lineKey)) === JSON.stringify(q.items.map(lineKey)) && t.discount === q.discount;
  if (same) return { state: "same" };
  if (q.pendingChange) fail(back, "この見積には承認待ちの変更があります。承認・差戻しのあとに直してください。");
  if (t.total <= 0) fail(back, "合計が 0 円以下になります。明細を確かめてください。");
  const confirmed = salesConfirmed(o);
  if (confirmed && o.salesDate) {
    const closed = closedReason(db, o.salesDate, "売上の金額の修正");
    if (closed) fail(back, closed);
  }
  const blocked = amendBlockedByInvoice(db, { orderId: o.id });
  if (blocked) fail(back, blocked);
  const now = nowIso();
  const why = reason || (t.total === q.total ? "仕様・内容の修正" : `金額の修正 (差額 ¥${Math.abs(t.total - q.total).toLocaleString("ja-JP")})`);
  q.pendingChange = {
    items: next.items,
    ...t,
    taxIncluded: mode === "included",
    taxExempt: mode === "exempt",
    title: q.title,
    workDetails: q.workDetails ?? "",
    notes: q.notes ?? "",
    reason: `${confirmed ? "売上確定のあとの修正: " : ""}${why}`,
    requestedBy: user.id,
    requestedAt: now,
  };
  q.updatedAt = now;
  // 売上確定のあとは差額にかかわらず店長の承認 (金額の基準で管理者に回さない)。確定の前はこれまでの決まり
  const role = confirmed ? approverRole(db.users, q.storeId, false, user.id) : approverRole(db.users, q.storeId, Math.max(t.total, q.total) >= approvalSettings(db).quoteAdminThreshold, user.id);
  const amend: Approval = {
    id: newId("ap"),
    type: "quote_amend",
    targetId: q.id,
    title: `${q.number} ${q.title} (${confirmed ? "売上の修正" : t.total !== q.total ? "金額変更" : "内容変更"} 第${q.version + 1}版)`,
    amount: t.total,
    storeId: q.storeId,
    requestedBy: user.id,
    requiredRole: role,
    status: "pending",
    requestComment: `${t.total !== q.total ? `変更前 ¥${q.total.toLocaleString("ja-JP")} → 変更後 ¥${t.total.toLocaleString("ja-JP")}` : `金額の変更なし (¥${q.total.toLocaleString("ja-JP")})`} / 受注 ${o.number}${confirmed ? " (売上確定済み)" : ""} / 理由: ${q.pendingChange.reason}`,
    createdAt: now,
  };
  db.approvals.push(amend);
  addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `${confirmed ? "売上確定のあとの明細・金額の修正" : "明細・金額の変更"}を申請 (${q.total.toLocaleString("ja-JP")}円 → ${t.total.toLocaleString("ja-JP")}円。売上確定・請求書発行の画面)`, storeId: q.storeId, changes: [{ field: "total", before: q.total, after: t.total }] });
  const before = q.total;
  const applied = settleOwnApproval(db, amend, user, back);
  return { state: applied ? "applied" : "pending", role, approvalId: amend.id, before, after: t.total };
}

/** 申請の文 (「店長へ申請しました」など) */
export function amendMessage(r: AmendResult): string {
  if (r.state === "same") return "";
  const diff = `¥${r.before.toLocaleString("ja-JP")} → ¥${r.after.toLocaleString("ja-JP")}`;
  if (r.state === "applied") return `明細・金額を直しました (${diff})。`;
  return `明細・金額の修正 (${diff}) を${r.role === "admin" ? "管理者" : "店長"}へ申請しました。承認されると受注・請求書に反映します。`;
}
