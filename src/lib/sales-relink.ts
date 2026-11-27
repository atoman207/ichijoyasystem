import type { Customer, Database } from "@/lib/db/types";

/**
 * 売上台帳から移行した受注を、ひも付いた販売管理ソフト (コンパス) の伝票の得意先のお客様に付け替える
 * (お客様のご連絡 2026-11-28「コンパスには売上履歴があるが、新システムには売上履歴が見当たらない (伊倉北方の○○様)」)
 * ------------------------------------------------------------
 * 売上台帳には名字と地区しかないため、台帳の取込は「名字 + 地区」ごとにお客様 (ID = c_<12 桁>) を作った。
 * 伝票の取込 (src/lib/sales-ledger.ts の applySalesSlips) は台帳の受注と伝票をひも付け、台帳のお客様の受注がすべて 1 つの得意先の
 * 伝票なら台帳のお客様を得意先のお客様 (c_s<得意先コード>) に統合した。ところが同じ名字・同じ地区の何人かの受注を持つ台帳のお客様
 * (例: 「松井」(伊倉北方) = 得意先 3 人の受注) は統合せず、受注も台帳のお客様のままだったため、得意先のお客様の画面に売上が出なかった。
 * ここでは受注ごとに、ひも付いた伝票 (経過メモ pn_s<伝票№>_…) の得意先が 1 つに決まるときだけ、その得意先のお客様へ付け替え、
 * 受注につながる予定・アンケート・資料・やりとりなども付け替える。記録が残らなくなった台帳のお客様は削除する (変更履歴に残す)。
 * お客様の項目 (名前・電話・住所) は変えない (人が直した内容を残す)。データの書き込みは applySlipRelink (mutate の中で呼ぶ)
 */

/** 売上台帳の取込で作ったお客様の ID */
export const LEDGER_CUSTOMER = /^c_[0-9a-f]{12}$/;
/** 伝票を取り込んだ経過メモの ID (pn_s<伝票№>_<指紋>) */
const SLIP_NOTE = "pn_s";

export interface RelinkMove {
  orderId: string;
  orderNumber: string;
  salesDate?: string;
  total: number;
  storeId: string;
  fromId: string;
  fromCode: string;
  fromName: string;
  toId: string;
  toCode: string;
  toName: string;
  slipNos: string[];
}

export interface RelinkPlan {
  moves: RelinkMove[];
  /** 伝票の得意先が 2 つ以上の受注 (付け替えない。人が確かめる) */
  ambiguous: { orderId: string; orderNumber: string; codes: string[] }[];
  /** 伝票の得意先のお客様が登録されていない受注 (付け替えない) */
  missingCustomer: { orderId: string; orderNumber: string; code: string }[];
  /** 付け替えると記録が何も残らない台帳のお客様 (削除する) */
  emptied: { id: string; code: string; name: string }[];
}

type Row = Record<string, unknown>;

/** 受注にひも付いた伝票の番号 (経過メモから) */
export function slipNosOf(o: { progressNotes?: { id: string }[] }): string[] {
  const out = new Set<string>();
  for (const n of o.progressNotes ?? []) if (n.id.startsWith(SLIP_NOTE)) out.add(n.id.slice(SLIP_NOTE.length).split("_")[0]);
  return [...out].filter(Boolean);
}

/** 受注につながる記録 (お客様 = 前のお客様のもの): 予定・アンケート・資料・やりとり・クレームなど */
function relatedOf(item: Row, orderIds: Set<string>): string | undefined {
  if (typeof item.orderId === "string" && orderIds.has(item.orderId)) return item.orderId;
  if (item.parentType === "order" && typeof item.parentId === "string" && orderIds.has(item.parentId)) return item.parentId;
  if (item.relatedType === "order" && typeof item.relatedId === "string" && orderIds.has(item.relatedId)) return item.relatedId;
  return undefined;
}

/** 顧客を参照している記録があるか (受注と、受注につながる記録は moving を除く) */
function referencedCustomers(db: Database, skipOrders: Set<string>): Set<string> {
  const used = new Set<string>();
  for (const [key, rows] of Object.entries(db as unknown as Record<string, unknown>)) {
    if (!Array.isArray(rows) || key === "customers" || key === "auditLogs") continue;
    for (const r of rows as Row[]) {
      if (!r || typeof r !== "object") continue;
      if (key === "orders" && typeof r.id === "string" && skipOrders.has(r.id)) continue;
      if (key !== "orders" && relatedOf(r, skipOrders)) continue;
      if (typeof r.customerId === "string") used.add(r.customerId);
      if (r.parentType === "customer" && typeof r.parentId === "string") used.add(r.parentId);
      if ((r.targetType === "customer" || r.recordType === "customer") && typeof (r.targetId ?? r.recordId) === "string") used.add(String(r.targetId ?? r.recordId));
    }
  }
  return used;
}

/** 付け替えの計画 (読むだけ)。slips = 伝票№ と得意先コード (販売管理ソフトの売上明細) */
export function planSlipRelink(db: Database, slips: { no: string; customerCode: string }[]): RelinkPlan {
  const codeOf = new Map(slips.filter((s) => s.no && s.customerCode).map((s) => [s.no, s.customerCode]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const plan: RelinkPlan = { moves: [], ambiguous: [], missingCustomer: [], emptied: [] };
  for (const o of db.orders) {
    if (o.id.startsWith("o_s") || !LEDGER_CUSTOMER.test(o.customerId)) continue;
    const nos = slipNosOf(o).filter((n) => codeOf.has(n));
    if (!nos.length) continue;
    const codes = [...new Set(nos.map((n) => codeOf.get(n)!))];
    if (codes.length > 1) {
      plan.ambiguous.push({ orderId: o.id, orderNumber: o.number, codes });
      continue;
    }
    const to = customers.get(`c_s${codes[0]}`);
    if (!to) {
      plan.missingCustomer.push({ orderId: o.id, orderNumber: o.number, code: codes[0] });
      continue;
    }
    if (to.id === o.customerId) continue;
    const from = customers.get(o.customerId);
    plan.moves.push({ orderId: o.id, orderNumber: o.number, salesDate: o.salesDate, total: o.total, storeId: o.storeId, fromId: o.customerId, fromCode: from?.code ?? "", fromName: from?.name ?? "", toId: to.id, toCode: to.code, toName: to.name, slipNos: nos });
  }
  if (plan.moves.length) {
    const used = referencedCustomers(db, new Set(plan.moves.map((m) => m.orderId)));
    const from = new Set(plan.moves.map((m) => m.fromId));
    for (const id of from) {
      if (used.has(id)) continue;
      const c = customers.get(id);
      if (c) plan.emptied.push({ id: c.id, code: c.code, name: c.name });
    }
  }
  return plan;
}

export interface RelinkResult {
  moved: number;
  related: number;
  removed: number;
}

/**
 * 計画どおりに付け替える (db を直接書き換える。mutate の中で呼ぶ)。計画のあとに変わった受注 (お客様が計画の前のお客様でない) は飛ばす。
 * 変更履歴: 受注ごとに customerId の変更・削除した台帳のお客様ごとに delete (試験期間の引き継ぎが削除を運ぶ)
 */
export function applySlipRelink(
  db: Database,
  plan: RelinkPlan,
  opts: { now: string; userId: string; audit?: (e: { action: "update" | "delete"; entity: "order" | "customer"; entityId: string; entityLabel: string; summary: string; storeId: string; changes?: { field: string; before: unknown; after: unknown }[] }) => void },
): RelinkResult {
  const result: RelinkResult = { moved: 0, related: 0, removed: 0 };
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const moves = plan.moves.filter((m) => orders.get(m.orderId)?.customerId === m.fromId && customers.has(m.toId));
  if (!moves.length) return result;
  const byOrder = new Map(moves.map((m) => [m.orderId, m]));
  for (const m of moves) {
    const o = orders.get(m.orderId)!;
    o.customerId = m.toId;
    o.updatedAt = opts.now;
    result.moved++;
    const to = customers.get(m.toId)!;
    const from = customers.get(m.fromId);
    if (from?.code && !to.tags.includes(`旧コード:${from.code}`)) to.tags = [...to.tags, `旧コード:${from.code}`];
    if (from?.area && !to.area) to.area = from.area;
    opts.audit?.({ action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `売上台帳の受注を販売管理ソフトの伝票 (№${m.slipNos.join("・")}) の得意先 ${m.toCode} ${m.toName} に付け替え (前: ${m.fromCode} ${m.fromName})`, storeId: o.storeId, changes: [{ field: "customerId", before: m.fromId, after: m.toId }] });
  }
  // 受注につながる記録 (前のお客様のもの) も付け替える
  const ids = new Set(byOrder.keys());
  for (const [key, rows] of Object.entries(db as unknown as Record<string, unknown>)) {
    if (!Array.isArray(rows) || key === "orders" || key === "customers" || key === "auditLogs") continue;
    for (const r of rows as Row[]) {
      if (!r || typeof r !== "object") continue;
      const oid = relatedOf(r, ids);
      if (!oid) continue;
      const m = byOrder.get(oid)!;
      if (r.customerId === m.fromId) {
        r.customerId = m.toId;
        result.related++;
      }
    }
  }
  // 記録が残らなくなった台帳のお客様を削除する
  const used = referencedCustomers(db, new Set());
  const remove = new Set<string>();
  for (const id of new Set(moves.map((m) => m.fromId))) {
    if (used.has(id) || !LEDGER_CUSTOMER.test(id)) continue;
    const c = customers.get(id);
    if (!c) continue;
    remove.add(id);
    const to = [...new Set(moves.filter((m) => m.fromId === id).map((m) => `${m.toCode} ${m.toName}`))];
    opts.audit?.({ action: "delete", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `売上台帳の取込で作った顧客を削除 (受注を販売管理ソフトの得意先 ${to.slice(0, 5).join("・")}${to.length > 5 ? ` ほか ${to.length - 5} 人` : ""} に付け替え、ほかの記録はありません)`, storeId: c.storeId });
  }
  if (remove.size) {
    db.customers = db.customers.filter((c) => !remove.has(c.id));
    result.removed = remove.size;
  }
  return result;
}

/** 計画の一覧 (CSV。お客様に確かめていただく) */
export function relinkCsv(plan: RelinkPlan, customerOf: (id: string) => Pick<Customer, "address" | "area"> | undefined): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["受注番号", "売上計上日", "金額", "店舗", "伝票№", "いまのお客様 (売上台帳から作成)", "いまのお客様の地区", "付け替え先 (販売管理ソフトの得意先)", "付け替え先の住所"];
  const lines = plan.moves.map((m) => [m.orderNumber, m.salesDate ?? "", m.total, m.storeId, m.slipNos.join(" "), `${m.fromCode} ${m.fromName}`, customerOf(m.fromId)?.area ?? customerOf(m.fromId)?.address ?? "", `${m.toCode} ${m.toName}`, customerOf(m.toId)?.address ?? ""].map(esc).join(","));
  return `﻿${[head.join(","), ...lines].join("\n")}\n`;
}
