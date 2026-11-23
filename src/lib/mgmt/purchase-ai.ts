import type { CostType, Database, Order, PurchaseInvoice, PurchaseLineAlloc, StoreId } from "@/lib/db/types";
import { COST_TYPE_LABEL } from "./purchase-lines";
import { itemCategories, orderCategorySales } from "./categories";
import type { OrderFact } from "@/lib/assistant/facts";

/**
 * 仕入明細の振り分けの AI の候補 (規則で「要確認」になった明細だけ)
 * ------------------------------------------------------------
 * お客様のご説明 (2026-11-23 ■9):「判断が難しいものについては、AI が候補を提示し、担当者が確認・修正できる形でも構いません」。
 * - AI に渡すのは 明細 (品名・品番・数量・金額・明細の店舗名・現場名・備考)・仕入先・勘定科目・店舗・品目・費用区分の一覧と、
 *   案件の候補 (規則の候補 + 請求日の前後の案件。受注番号・お客様の名前・施工場所の町名・件名・品目別の売上)
 * - AI の答えは確かめてから使う (候補にない受注・存在しない店舗・品目・費用区分は捨てる)。会計のデータは変えず、
 *   振り分けの案 (splits) と理由を入れるだけで、確定は担当者が行う (状態は要確認のまま)
 * - 金額は AI に計算させない (振り分けの案の金額は明細の税抜の金額そのまま)
 */

export interface AiLineSuggestion {
  itemId: string;
  orderId?: string;
  storeId?: StoreId;
  itemCategory?: string;
  costType?: CostType;
  reason: string;
  /** 0〜100 */
  confidence: number;
}

export const PURCHASE_AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lineNo", "orderNumber", "storeId", "itemCategory", "costType", "reason", "confidence"],
        properties: {
          lineNo: { type: "integer" },
          orderNumber: { anyOf: [{ type: "string" }, { type: "null" }] },
          storeId: { anyOf: [{ type: "string" }, { type: "null" }] },
          itemCategory: { anyOf: [{ type: "string" }, { type: "null" }] },
          costType: { anyOf: [{ type: "string" }, { type: "null" }] },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

/** 振り分けの候補を出す明細 (確定していない・要確認の明細) */
export function aiTargetLines(allocs: PurchaseLineAlloc[]): PurchaseLineAlloc[] {
  return allocs.filter((a) => a.status !== "confirmed" && (a.status === "needs_review" || !a.splits.length || a.ai?.needsReview));
}

const shift = (d: string, days: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

/** 案件の候補 (規則の候補 + 請求日の 120 日前〜30 日後の、仕入の店舗・明細の店舗の案件。最大 30 件) */
export function aiCandidateOrders(db: Database, purchase: PurchaseInvoice, lines: PurchaseLineAlloc[]): Order[] {
  const ids = new Set(lines.flatMap((l) => l.ai?.candidates?.map((c) => c.orderId) ?? []));
  const from = shift(purchase.invoiceDate, -120);
  const to = shift(purchase.invoiceDate, 30);
  const stores = new Set<string>([purchase.storeId]);
  for (const l of lines) if (l.ai?.storeId) stores.add(l.ai.storeId);
  const near = db.orders
    .filter((o) => o.status !== "cancelled" && (o.salesDate ?? o.contractDate) >= from && o.contractDate <= to && (purchase.storeId === "hq" || stores.has(o.storeId)))
    .sort((a, b) => Math.abs(Date.parse(a.salesDate ?? a.contractDate) - Date.parse(purchase.invoiceDate)) - Math.abs(Date.parse(b.salesDate ?? b.contractDate) - Date.parse(purchase.invoiceDate)));
  const out = db.orders.filter((o) => ids.has(o.id));
  for (const o of near) {
    if (out.length >= 30) break;
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

/** AI への依頼の文 (system と user) */
export function buildPurchaseAiPrompt(db: Database, purchase: PurchaseInvoice, lines: PurchaseLineAlloc[], candidates: Order[], facts?: Map<string, OrderFact>): { system: string; user: string } {
  const supplier = db.suppliers.find((s) => s.id === purchase.supplierId);
  const stores = db.stores.map((s) => `${s.id} = ${s.name}`).join(" / ");
  const cats = itemCategories(db).filter((c) => c.active).map((c) => `${c.id} = ${c.name}`).join(" / ");
  const costs = Object.entries(COST_TYPE_LABEL).map(([k, v]) => `${k} = ${v}`).join(" / ");
  const system = [
    "あなたは畳・襖・内装の会社 (株式会社一畳屋) の経理の補助です。仕入の請求書の明細ごとに、どの案件 (受注)・どの店舗・どの品目・どの費用区分かの候補を出します。",
    "決まり:",
    "- 案件は「案件の候補」の受注番号からだけ選ぶ。現場名・お客様の名前・施工場所・件名・品目が合うものを選び、決められなければ null",
    "- 同じ材料でも使い道で品目が変わる (例: クロス紙を壁紙の張替に使えばリフォーム、襖に使えば襖)。品目は案件の品目別の売上で判断する",
    "- 店舗は明細の店舗名 → 案件の店舗 の順。分からなければ null",
    "- 費用区分: 協力業者への工事の支払いは outsource、案件の材料は material、本部で一括仕入して在庫にする畳表・畳縁・畳床は inventory、全店舗共通の消耗品・広告・処分費は common_expense、店舗だけの経費は store_expense",
    "- 金額は計算しない。理由は日本語で 1 文 (何が一致したか)。confidence は 0〜100 (根拠が弱ければ低く)",
    `店舗: ${stores}`,
    `品目: ${cats}`,
    `費用区分: ${costs}`,
  ].join("\n");
  const cand = candidates.map((o) => {
    const c = db.customers.find((x) => x.id === o.customerId);
    const sales = orderCategorySales(db, o, facts?.get(o.id), o.salesDate ?? o.contractDate);
    const town = (o.siteAddress || c?.address || "").replace(/^熊本県/, "").replace(/[0-9０-９\-－‐ー].*$/, "").slice(0, 16);
    return `- ${o.number} | ${c?.name ?? ""} | ${town} | ${o.title} | 店舗 ${o.storeId} | 品目別 ${Object.entries(sales).map(([k, v]) => `${k}:${v}`).join(",")} | ${o.salesDate ?? o.contractDate}`;
  });
  const user = [
    `仕入先: ${supplier?.name ?? "(不明)"}${supplier?.kind === "partner" ? " (協力業者)" : ""} / 勘定科目: ${purchase.account ?? "(なし)"} / 請求日: ${purchase.invoiceDate} / 仕入の登録の店舗: ${purchase.storeId}`,
    "明細:",
    ...lines.map((l) => `- lineNo ${l.lineNo}: ${l.ocr.name}${l.ocr.code ? ` 品番 ${l.ocr.code}` : ""}${l.ocr.spec ? ` (${l.ocr.spec})` : ""} 数量 ${l.ocr.qty ?? "-"}${l.ocr.unit ?? ""} 金額 ${l.ocr.amount} 円${l.ocr.storeText ? ` 店舗名「${l.ocr.storeText}」` : ""}${l.ocr.siteText ? ` 現場名「${l.ocr.siteText}」` : ""}${l.ocr.note ? ` 備考「${l.ocr.note}」` : ""}${l.ai?.reason ? ` / 規則の判定: ${l.ai.reason}` : ""}`),
    "案件の候補 (受注番号 | お客様 | 施工場所 | 件名 | 店舗 | 品目別の売上 | 日付):",
    ...(cand.length ? cand : ["- (候補なし)"]),
  ].join("\n");
  return { system, user };
}

/** AI の答えを確かめて、使える値だけにする (候補にない受注・存在しない店舗・品目・費用区分は捨てる) */
export function normalizePurchaseAi(db: Database, raw: unknown, lines: PurchaseLineAlloc[], candidates: Order[]): AiLineSuggestion[] {
  const arr = raw && typeof raw === "object" && Array.isArray((raw as { lines?: unknown }).lines) ? ((raw as { lines: unknown[] }).lines as Record<string, unknown>[]) : [];
  const byNo = new Map(lines.map((l) => [l.lineNo, l]));
  const orders = new Map(candidates.map((o) => [o.number, o]));
  const catIds = new Set(itemCategories(db).map((c) => c.id));
  const out: AiLineSuggestion[] = [];
  for (const r of arr) {
    const line = byNo.get(Number(r.lineNo));
    if (!line || out.some((x) => x.itemId === line.itemId)) continue;
    const order = typeof r.orderNumber === "string" ? orders.get(r.orderNumber.trim()) : undefined;
    const storeId = typeof r.storeId === "string" && db.stores.some((s) => s.id === r.storeId) ? (r.storeId as StoreId) : order?.storeId;
    const itemCategory = typeof r.itemCategory === "string" && catIds.has(r.itemCategory) ? r.itemCategory : undefined;
    const costType = typeof r.costType === "string" && r.costType in COST_TYPE_LABEL ? (r.costType as CostType) : undefined;
    const conf = Number(r.confidence);
    out.push({
      itemId: line.itemId,
      orderId: order?.id,
      storeId,
      itemCategory,
      costType,
      reason: String(r.reason ?? "").slice(0, 300) || "理由なし",
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : 0,
    });
  }
  return out;
}

/** AI の候補を明細の振り分けの行に入れる (mutate の中で呼ぶ)。確定は担当者が行うため、状態は要確認のまま */
export function applyAiSuggestions(db: Database, suggestions: AiLineSuggestion[], purchaseId: string, now: string): number {
  let n = 0;
  for (const s of suggestions) {
    const a = db.purchaseLineAllocs.find((x) => x.purchaseId === purchaseId && x.itemId === s.itemId);
    if (!a || a.status === "confirmed") continue;
    const prev = a.ai;
    a.ai = {
      storeId: s.storeId ?? prev?.storeId,
      orderId: s.orderId ?? prev?.orderId,
      itemCategory: s.itemCategory ?? prev?.itemCategory,
      costType: s.costType ?? prev?.costType,
      materialId: prev?.materialId,
      reason: `${prev?.reason ? `${prev.reason} / ` : ""}AI の候補 (信頼度 ${s.confidence}): ${s.reason}`,
      refs: [...(prev?.refs ?? []), ...(s.orderId ? [`order:${s.orderId}`] : [])],
      confidence: Math.max(prev?.confidence ?? 0, Math.min(s.confidence, 90)),
      needsReview: true,
      candidates: prev?.candidates ?? [],
      method: "rules+ai",
      at: now,
    };
    const st = a.ai.storeId;
    const cat = a.ai.itemCategory;
    const ct = a.ai.costType;
    if (st && cat && ct && (ct !== "inventory" || (a.ai.materialId && a.ocr.qty))) a.splits = [{ storeId: st, orderId: a.ai.orderId, itemCategory: cat, costType: ct, materialId: a.ai.materialId, qty: a.ai.materialId ? a.ocr.qty : undefined, amount: a.ocr.amountExTax }];
    a.status = "needs_review";
    a.updatedAt = now;
    n++;
  }
  return n;
}
