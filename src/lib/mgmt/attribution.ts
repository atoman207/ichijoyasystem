import type { Database, Order, OrderAttribution, SalesAdjustment, StoreId, WorkKind } from "@/lib/db/types";
import { taxRate } from "@/lib/sales-ledger";
import { applyBp, exTax, type Rounding } from "./decimal";
import { ruleAt } from "./rules";
import { matchArea, type AreaMatch } from "./areas";
import { correctionDate } from "./close";

/**
 * 売上の帰属と店舗間の売上配分
 * ------------------------------------------------------------
 * - 売上は実際に施工した店舗に計上する。受注の「店舗」(storeId) を売上帰属店舗とし、外部売上の集計は今まで通り storeId で行う
 * - 受注店舗 ≠ 施工店舗 のときは内部受注として、依頼元に「基準額 × 配分率」を移す調整の行を作る (施工店舗から同額を引く)。
 *   調整の行は店舗の合計が常に 0 のため、全社の外部売上は増えない (内部受注を外部売上として二重に数えない)
 * - 本部の特殊配分 (例: 本部の売上のうち店舗の作業分) は、金額を指定した調整の行にする
 * - 調整の行は書き換えない。取消し・訂正は逆の行を足す (reverseAdjustment)
 */

export const WORK_KIND_LABEL: Record<WorkKind, string> = { normal: "通常工事", reform: "リフォーム工事" };
export const ADJ_KIND_LABEL: Record<SalesAdjustment["kind"], string> = { internal_order: "内部受注", hq_special: "本部の特殊配分", manual: "手入力の調整" };
export const TREATMENT_LABEL: Record<NonNullable<SalesAdjustment["treatment"]>, string> = { unset: "未確定", sales_transfer: "売上の配分", cost_only: "原価のみ計上" };
export const TAX_CATEGORY_LABEL: Record<NonNullable<OrderAttribution["taxCategory"]>, string> = { unset: "未設定", taxable: "課税", exempt: "免税 (輸出など)", non_taxable: "非課税", out_of_scope: "不課税" };

export const ratePct = (date: string) => Math.round(taxRate(date) * 100);

export const attributionId = (orderId: string) => `oa_${orderId}`;

/** 受注の住所 (施工場所 → お客様の住所) */
export function orderAddress(db: Pick<Database, "customers">, order: Pick<Order, "siteAddress" | "customerId">): string {
  return order.siteAddress?.trim() || db.customers.find((c) => c.id === order.customerId)?.address || "";
}

export interface Attribution {
  orderId: string;
  /** 売上帰属店舗 (= 受注の店舗) */
  attributionStoreId: StoreId;
  receivedStoreId: StoreId;
  workStoreId: StoreId;
  workKind: WorkKind;
  hqSpecial: boolean;
  taxCategory: NonNullable<OrderAttribution["taxCategory"]>;
  area: AreaMatch;
  /** 登録した行 (なければ既定: 受注店舗 = 施工店舗 = 受注の店舗) */
  saved?: OrderAttribution;
  /** 確かめること (施工店舗と売上帰属店舗が違う など) */
  warnings: string[];
}

/** 受注の工事の区分の初期値 (主な品目がリフォームならリフォーム工事) */
export function suggestWorkKind(mainCategory: string): WorkKind {
  return mainCategory === "reform" ? "reform" : "normal";
}

export function attributionOf(db: Database, order: Order, mainCategory: string, date = order.salesDate ?? order.contractDate): Attribution {
  const saved = db.orderAttributions?.find((a) => a.orderId === order.id);
  const area = matchArea(db, orderAddress(db, order), date);
  const receivedStoreId = saved?.receivedStoreId ?? order.storeId;
  const workStoreId = saved?.workStoreId ?? order.storeId;
  const warnings: string[] = [];
  // 本部の売上で作業だけ店舗が行った案件 (本部の特殊配分) は、売上を本部に計上して作業分を配分するため警告しない
  if (workStoreId !== order.storeId && !(saved?.hqSpecial && order.storeId === "hq")) warnings.push(`施工店舗 (${storeName(db, workStoreId)}) と売上帰属店舗 (受注の店舗: ${storeName(db, order.storeId)}) が違います。売上は施工店舗に計上するため、受注の店舗を施工店舗に合わせるか、理由を残してください。`);
  if (area.status === "ambiguous") warnings.push(`住所が複数の店舗の営業エリアに当てはまります (${area.candidates.map((c) => `${c.town}=${storeName(db, c.storeId)}`).join("・")})。`);
  return {
    orderId: order.id,
    attributionStoreId: order.storeId,
    receivedStoreId,
    workStoreId,
    workKind: saved?.workKind ?? suggestWorkKind(mainCategory),
    hqSpecial: Boolean(saved?.hqSpecial),
    taxCategory: saved?.taxCategory ?? "unset",
    area,
    saved,
    warnings,
  };
}

export function storeName(db: Pick<Database, "stores">, id: string | undefined): string {
  return db.stores.find((s) => s.id === id)?.name ?? id ?? "-";
}

export interface InternalOrderCalc {
  base: "tax_included" | "tax_excluded";
  baseAmount: number;
  rateBp: number;
  rateSource: "standard" | "override";
  rounding: Rounding;
  amount: number;
  ruleIds: string[];
  provisional: boolean;
  /** 計算の説明 (根拠) */
  explain: string;
}

/** 内部受注の配分額 (設定の配分率・基準額・端数。overrideBp は管理者が指定した特例の率) */
export function calcInternalOrder(db: Database, order: Pick<Order, "total" | "salesDate" | "contractDate">, workKind: WorkKind, overrideBp?: number): InternalOrderCalc {
  const date = order.salesDate ?? order.contractDate;
  const rate = ruleAt(db, workKind === "reform" ? "internal.rate.reform" : "internal.rate.normal", date);
  const base = ruleAt(db, "internal.base", date);
  const rounding = ruleAt(db, "internal.rounding", date);
  const exRound = ruleAt(db, "tax.exclusion_rounding", date);
  const baseKind = base.value === "tax_excluded" ? "tax_excluded" : "tax_included";
  const baseAmount = baseKind === "tax_included" ? order.total : exTax(order.total, ratePct(date), exRound.value as Rounding);
  const rateBp = overrideBp ?? Number(rate.value);
  const mode = rounding.value as Rounding;
  const amount = applyBp(baseAmount, rateBp, mode);
  const used = [rate, base, rounding, ...(baseKind === "tax_excluded" ? [exRound] : [])];
  return {
    base: baseKind,
    baseAmount,
    rateBp,
    rateSource: overrideBp === undefined ? "standard" : "override",
    rounding: mode,
    amount,
    ruleIds: used.map((r) => r.ruleId ?? `default:${r.key}`),
    // 特例の率のときは、率の設定の状態は使わない
    provisional: used.filter((r) => overrideBp === undefined || r !== rate).some((r) => r.status === "provisional"),
    explain: `${baseKind === "tax_included" ? "税込" : "税抜"} ${baseAmount.toLocaleString("ja-JP")} 円 × ${(rateBp / 100).toLocaleString("ja-JP")}% (${overrideBp === undefined ? WORK_KIND_LABEL[workKind] + "の標準" : "特例"}) → ${ROUND_LABEL[mode]} = ${amount.toLocaleString("ja-JP")} 円`,
  };
}

const ROUND_LABEL: Record<Rounding, string> = { floor: "切り捨て", round: "四捨五入", ceil: "切り上げ" };

/** 調整の行の店舗ごとの金額 (依頼元 +、施工店舗 −。合計は 0) */
export function adjustmentLines(a: Pick<SalesAdjustment, "fromStoreId" | "toStoreId" | "amount">): { storeId: StoreId; amount: number }[] {
  return [
    { storeId: a.fromStoreId, amount: a.amount },
    { storeId: a.toStoreId, amount: -a.amount },
  ];
}

/** 調整の計上日 (日付の指定がなければ受注の売上計上日。施工完了前は null = 未計上) */
export function adjustmentDate(db: Pick<Database, "orders">, a: Pick<SalesAdjustment, "date" | "orderId">, orderIndex?: Map<string, Order>): string | null {
  if (a.date) return a.date;
  if (!a.orderId) return null;
  const o = orderIndex ? orderIndex.get(a.orderId) : db.orders.find((x) => x.id === a.orderId);
  return o?.salesDate ?? null;
}

/** 受注の有効な (取り消していない) 内部受注 */
export function activeInternalOrder(db: Pick<Database, "salesAdjustments">, orderId: string): SalesAdjustment | undefined {
  return (db.salesAdjustments ?? []).find((a) => a.orderId === orderId && a.kind === "internal_order" && a.status === "active" && !a.reversalOf);
}

/**
 * 調整の行を取り消す (mutate の中で呼ぶ)。逆の行を足し、元の行に reversedBy を残す。
 * 元の行の計上月が確定済みなら、設定に従って開いている月に入れるか断る (null)
 */
export function reverseAdjustment(db: Database, adj: SalesAdjustment, input: { id: string; number: string; userId: string; now: string; today: string; reason: string }): SalesAdjustment | string {
  if (adj.status !== "active" || adj.reversalOf) return "この行は取り消せません (取消し済み、または取消しの行です)。";
  const original = adjustmentDate(db, adj) ?? undefined;
  const date = correctionDate(db, original, input.today);
  if (date === null) return `${original?.slice(0, 7)} は月次確定済みです。管理者が確定を解除してから取り消してください。`;
  const rev: SalesAdjustment = {
    ...adj,
    id: input.id,
    number: input.number,
    // 元の計上日と同じ月なら、受注の売上計上日に連動させる (日付を持たない)
    date: original && date === original && !adj.date ? undefined : date,
    amount: -adj.amount,
    status: "active",
    reversalOf: adj.id,
    reversedBy: undefined,
    reason: input.reason,
    createdBy: input.userId,
    createdAt: input.now,
  };
  adj.status = "reversed";
  adj.reversedBy = rev.id;
  db.salesAdjustments.push(rev);
  return rev;
}

/** 内部受注の金額が今の受注の金額・設定と合っているか (変わっていたら再計算 (訂正) が必要) */
export function internalOrderStale(db: Database, adj: SalesAdjustment, order: Order | undefined): string | null {
  if (!order || adj.kind !== "internal_order" || adj.status !== "active" || adj.reversalOf || adj.rateSource === "override" || adj.baseAmount === undefined) return null;
  const base = adj.base === "tax_excluded" ? exTax(order.total, ratePct(order.salesDate ?? order.contractDate), ruleAt(db, "tax.exclusion_rounding", order.salesDate ?? order.contractDate).value as Rounding) : order.total;
  if (base !== adj.baseAmount) return `受注の金額が変わっています (計上時 ${adj.baseAmount.toLocaleString("ja-JP")} 円 → 今 ${base.toLocaleString("ja-JP")} 円)。訂正 (再計算) してください。`;
  return null;
}
