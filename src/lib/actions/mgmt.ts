"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CostType, MaterialKind, MaterialTransfer, MgmtEntry, Order, PurchaseSplit, SalesAdjustment, StoreId, User, WorkKind } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";
import { canAdminMgmt, canEditMgmt, canRecordUsage, canRequestMove, canViewMgmtStore } from "@/lib/mgmt/access";
import { mgmtTablesMissing } from "@/lib/mgmt/tables";
import { RULE_DEFS, ruleAt, setRule, validateRule } from "@/lib/mgmt/rules";
import { closedReason, lastClosedMonth, monthOf } from "@/lib/mgmt/close";
import { activeInternalOrder, attributionId, calcInternalOrder, orderAddress, reverseAdjustment, storeName, TAX_CATEGORY_LABEL, wantsInternalOrder } from "@/lib/mgmt/attribution";
import { matchArea, planAreaImport, applyAreaImport, storeIdOfName } from "@/lib/mgmt/areas";
import { moveAdOverage } from "@/lib/mgmt/ad-budget";
import { aiCandidateOrders, aiTargetLines, applyAiSuggestions, buildPurchaseAiPrompt, normalizePurchaseAi, PURCHASE_AI_SCHEMA, type AiLineSuggestion } from "@/lib/mgmt/purchase-ai";
import { AiError, aiStatus, generateJson } from "@/lib/ai/provider";
import { withAiContext } from "@/lib/ai/usage";
import { costingLines, planUsage, recordUsages, setMaterialCost, MATERIAL_KIND_LABEL, type SpecChoice } from "@/lib/mgmt/costing";
import { productionNotes } from "@/lib/mgmt/doko";
import { averageCost, postMove, reverseMove, validateMove, locStore } from "@/lib/mgmt/stock";
import { buildLineAllocs, confirmLineAlloc, upsertLineAllocs, COST_TYPE_LABEL } from "@/lib/mgmt/purchase-lines";
import { confirmAllocation, previewAllocation } from "@/lib/mgmt/allocation";
import { freezeMonth } from "@/lib/mgmt/freeze";
import { confirmOmoteDiff, omoteDiffKey, previewOmoteDiff, reverseOmoteDiff } from "@/lib/mgmt/omote-diff";
import { planTransfer, reverseTransfer } from "@/lib/mgmt/transfers";
import { storePnl } from "@/lib/mgmt/pnl";
import { CATEGORY_IDS, categoryName, isItemCategory, itemCategories, mainCategory, orderCategorySales, orderLineSource, syncInvoiceLineCategories } from "@/lib/mgmt/categories";
import { salesFacts } from "@/lib/assistant/facts";
import { round4 } from "@/lib/mgmt/decimal";
import { areaRowsFromXlsx, readXlsx } from "@/lib/xlsx";
import { applyMaterialMoveImport, planHash, planMaterialMoveImport, type MoveImportPlan } from "@/lib/mgmt/material-move-import";
import { applyTatamiCostPlan, parseTatamiCostSheet } from "@/lib/mgmt/tatami-cost-sheet";
import { putObject, readObject, removeObjects } from "@/lib/storage";

/**
 * 管理会計の操作 (src/lib/mgmt の計算を使う)
 * ------------------------------------------------------------
 * - 権限は src/lib/mgmt/access.ts。確定した月にかかる登録は src/lib/mgmt/close.ts で断る
 * - 確定した行は書き換えない: 取消し・訂正は逆の行を足す。すべての操作を変更履歴 (監査ログ) に残す
 */

const BASE = "/management";
const today = () => toDateKey(new Date());
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: string) => /^\d{4}-\d{2}$/.test(v);
const yenInt = (v: string) => {
  const n = Number(v.replace(/[,¥\s円]/g, ""));
  return Number.isSafeInteger(n) ? n : NaN;
};
const decimal = (v: string) => {
  const t = v.replace(/[,\s]/g, "");
  return /^-?\d+(\.\d{1,4})?$/.test(t) ? Number(t) : NaN;
};

async function start(fd: FormData, fallback: string, need: "edit" | "admin" | "any") {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), fallback);
  if (need === "admin" && !canAdminMgmt(user)) fail(back, "この操作は管理者が行います。");
  if (need === "edit" && !canEditMgmt(user)) fail(back, "この操作は本部スタッフ・管理者が行います。");
  const missing = await mgmtTablesMissing();
  if (missing) fail(back, missing);
  return { user, back };
}

function done(back: string, msg: string): never {
  revalidatePath(BASE);
  redirect(withMsg(back, msg));
}

function storeIdOf(v: string): StoreId | undefined {
  return getDb().stores.some((s) => s.id === v) ? (v as StoreId) : undefined;
}

function orderByNumberOrId(v: string): Order | undefined {
  const t = v.trim();
  if (!t) return undefined;
  return getDb().orders.find((o) => o.id === t || o.number === t);
}

/* ================================================================== */
/* 売上の帰属・内部受注                                                  */
/* ================================================================== */

/** 受注の売上の帰属 (受注店舗・施工店舗・工事の区分・税区分) を保存し、内部受注の配分を自動で計上・訂正する */
export async function saveAttribution(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=sales`, "edit");
  const order = orderByNumberOrId(str(fd, "orderId"));
  if (!order) fail(back, "受注が見つかりません。");
  const received = storeIdOf(str(fd, "receivedStoreId"));
  const work = storeIdOf(str(fd, "workStoreId"));
  if (!received || !work) fail(back, "受注店舗と施工店舗を選んでください。");
  const workKind: WorkKind = str(fd, "workKind") === "reform" ? "reform" : "normal";
  const tax = str(fd, "taxCategory");
  const taxCategory = (["taxable", "exempt", "non_taxable", "out_of_scope", "unset"].includes(tax) ? tax : "unset") as "unset";
  const overrideRaw = str(fd, "overridePct");
  let overrideBp: number | undefined;
  if (overrideRaw) {
    if (!canAdminMgmt(user)) fail(back, "特例の配分率は管理者が設定します。");
    const pct = decimal(overrideRaw);
    if (!(pct >= 0 && pct <= 100)) fail(back, "特例の配分率は 0〜100 の % で入力してください。");
    overrideBp = Math.round(pct * 100);
    if (!str(fd, "reason")) fail(back, "特例の配分率にするときは、理由を入力してください。");
  }
  const reason = str(fd, "reason").slice(0, 300);
  let msg = "売上の帰属を保存しました。";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === order.id)!;
    // 施工店舗・税区分などは確定した月の材料費・売上を変えるため、月次確定済みの月の受注は断る
    const closedAttr = closedReason(db, o.salesDate ?? today(), "売上の帰属の変更");
    if (closedAttr) fail(back, closedAttr);
    const facts = salesFacts(db).byId.get(o.id);
    const main = mainCategory(orderCategorySales(db, o, facts, o.salesDate ?? o.contractDate), "other");
    const area = matchArea(db, orderAddress(db, o), o.salesDate ?? o.contractDate);
    const id = attributionId(o.id);
    const prev = db.orderAttributions.find((a) => a.id === id);
    const row = { id, orderId: o.id, areaStoreId: area.storeId, areaKey: area.key, receivedStoreId: received, workStoreId: work, workKind, hqSpecial: str(fd, "hqSpecial") === "1" || undefined, taxCategory, note: str(fd, "note").slice(0, 300) || undefined, updatedBy: user.id, updatedAt: nowIso() };
    if (prev) Object.assign(prev, row);
    else db.orderAttributions.push(row);
    // 内部受注: 受注店舗 ≠ 施工店舗 なら計上。前の計上と内容が違えば取り消して計上し直す。
    // ただし本部の売上で作業だけ店舗が行った案件 (本部の特殊配分) は、金額を指定した配分で店舗に移すため内部受注を計上しない
    const active = activeInternalOrder(db, o.id);
    const want = wantsInternalOrder(o, received, work, row.hqSpecial);
    const same = active && active.fromStoreId === received && active.toStoreId === work && active.workKind === workKind && (overrideBp === undefined ? active.rateSource !== "override" : active.rateBp === overrideBp);
    if (active && (!want || !same)) {
      const r = reverseAdjustment(db, active, { id: newId("adj"), number: nextNumber(db, "SA", db.salesAdjustments, today()), userId: user.id, now: nowIso(), today: today(), reason: reason || "売上の帰属の変更" });
      if (typeof r === "string") fail(back, r);
      msg += " 前の内部受注を取り消しました。";
    }
    if (want && !same) {
      const closed = closedReason(db, o.salesDate, "内部受注の計上");
      if (closed) fail(back, closed);
      const calc = calcInternalOrder(db, o, workKind, overrideBp);
      const adj: SalesAdjustment = {
        id: newId("adj"),
        number: nextNumber(db, "SA", db.salesAdjustments, today()),
        kind: "internal_order",
        orderId: o.id,
        fromStoreId: received,
        toStoreId: work,
        workKind,
        base: calc.base,
        baseAmount: calc.baseAmount,
        rateBp: calc.rateBp,
        rateSource: calc.rateSource,
        ruleIds: calc.ruleIds,
        rounding: calc.rounding,
        amount: calc.amount,
        provisional: calc.provisional,
        status: "active",
        reason: reason || undefined,
        createdBy: user.id,
        createdAt: nowIso(),
      };
      db.salesAdjustments.push(adj);
      msg += ` 内部受注 ${adj.number} を計上しました (${calc.explain})。`;
      addAudit(db, { userId: user.id, action: "create", entity: "sales_adjustment", entityId: adj.id, entityLabel: adj.number, summary: `内部受注 ${storeName(db, received)} ← ${storeName(db, work)} ${calc.explain}${calc.provisional ? " (暫定の設定を含む)" : ""}`, storeId: work });
    }
    addAudit(db, { userId: user.id, action: prev ? "update" : "create", entity: "order_attribution", entityId: id, entityLabel: o.number, summary: `売上の帰属: 受注店舗 ${storeName(db, received)} / 施工店舗 ${storeName(db, work)} / ${workKind === "reform" ? "リフォーム工事" : "通常工事"} (主な品目 ${main})`, storeId: o.storeId });
  });
  done(back, msg);
}

/** 受注の税区分だけを登録する (輸出の免税など。内部受注などほかの帰属の内容は変えない) */
export async function setOrderTaxCategory(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=sales`, "edit");
  const order = orderByNumberOrId(str(fd, "orderId"));
  if (!order) fail(back, "受注が見つかりません。");
  const tax = str(fd, "taxCategory");
  if (!["taxable", "exempt", "non_taxable", "out_of_scope"].includes(tax)) fail(back, "税区分を選んでください。");
  const taxCategory = tax as "taxable" | "exempt" | "non_taxable" | "out_of_scope";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === order.id)!;
    const closed = closedReason(db, o.salesDate ?? today(), "税区分の登録");
    if (closed) fail(back, closed);
    const id = attributionId(o.id);
    const prev = db.orderAttributions.find((a) => a.id === id);
    const before = prev?.taxCategory ?? "unset";
    if (prev) {
      prev.taxCategory = taxCategory;
      prev.updatedBy = user.id;
      prev.updatedAt = nowIso();
    } else {
      const main = mainCategory(orderCategorySales(db, o, salesFacts(db).byId.get(o.id), o.salesDate ?? o.contractDate), "other");
      const area = matchArea(db, orderAddress(db, o), o.salesDate ?? o.contractDate);
      db.orderAttributions.push({ id, orderId: o.id, areaStoreId: area.storeId, areaKey: area.key, receivedStoreId: o.storeId, workStoreId: o.storeId, workKind: main === "reform" ? "reform" : "normal", taxCategory, updatedBy: user.id, updatedAt: nowIso() });
    }
    addAudit(db, { userId: user.id, action: prev ? "update" : "create", entity: "order_attribution", entityId: id, entityLabel: o.number, summary: `税区分を登録: ${TAX_CATEGORY_LABEL[before as "unset"] ?? before} → ${TAX_CATEGORY_LABEL[taxCategory]}`, storeId: o.storeId, changes: [{ field: "taxCategory", before, after: taxCategory }] });
  });
  done(back, "税区分を登録しました。");
}

/** 本部の特殊配分・手入力の売上調整 (金額指定)。管理者 */
export async function createAdjustment(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=sales`, "admin");
  const kind = str(fd, "kind") === "manual" ? "manual" : "hq_special";
  const from = storeIdOf(str(fd, "fromStoreId"));
  const to = storeIdOf(str(fd, "toStoreId"));
  const amount = yenInt(str(fd, "amount"));
  const date = str(fd, "date");
  const reason = str(fd, "reason").slice(0, 300);
  if (!from || !to || from === to) fail(back, "配分を受け取る店舗と渡す店舗を、別々に選んでください。");
  if (!Number.isSafeInteger(amount) || amount === 0) fail(back, "金額は円の整数で入力してください。");
  if (!isDate(date)) fail(back, "計上日を入力してください。");
  if (!reason) fail(back, "理由 (どの取引の、どの作業分か) を入力してください。");
  const orderRaw = str(fd, "order");
  const order = orderRaw ? orderByNumberOrId(orderRaw) : undefined;
  if (orderRaw && !order) fail(back, "受注が見つかりません。");
  const base = str(fd, "base") === "tax_included" ? "tax_included" : "tax_excluded";
  const t = str(fd, "treatment");
  let number = "";
  await mutate((db) => {
    const closed = closedReason(db, date, "売上の調整");
    if (closed) fail(back, closed);
    // 会計上の扱いを選ばなければ設定の既定 (お客様のご説明: 店舗への売上の配分)
    const treatment = (["sales_transfer", "cost_only", "unset"].includes(t) ? t : ruleAt(db, "hq.treatment", date).value) as SalesAdjustment["treatment"];
    number = nextNumber(db, "SA", db.salesAdjustments, date);
    const adj: SalesAdjustment = { id: newId("adj"), number, kind, orderId: order?.id, date, fromStoreId: from!, toStoreId: to!, base, amount, treatment: kind === "hq_special" ? treatment : undefined, provisional: kind === "hq_special" && treatment === "unset", status: "active", reason, createdBy: user.id, createdAt: nowIso() };
    db.salesAdjustments.push(adj);
    addAudit(db, { userId: user.id, action: "create", entity: "sales_adjustment", entityId: adj.id, entityLabel: number, summary: `${kind === "hq_special" ? "本部の特殊配分" : "売上の調整"} ${storeName(db, to)} → ${storeName(db, from)} ${amount.toLocaleString("ja-JP")} 円 (${base === "tax_included" ? "税込" : "税抜"}) ${reason}`, storeId: to });
  });
  done(back, `売上の調整 ${number} を登録しました。`);
}

/** 売上の調整の取消し (逆の行を足す) */
export async function reverseAdjustmentAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=sales`, "edit");
  const reason = str(fd, "reason").slice(0, 300);
  if (!reason) fail(back, "取消しの理由を入力してください。");
  let number = "";
  await mutate((db) => {
    const adj = db.salesAdjustments.find((a) => a.id === str(fd, "id"));
    if (!adj) fail(back, "調整の行が見つかりません。");
    if (adj.kind !== "internal_order" && !canAdminMgmt(user)) fail(back, "本部の特殊配分・手入力の調整の取消しは管理者が行います。");
    const r = reverseAdjustment(db, adj, { id: newId("adj"), number: nextNumber(db, "SA", db.salesAdjustments, today()), userId: user.id, now: nowIso(), today: today(), reason });
    if (typeof r === "string") fail(back, r);
    number = adj.number;
    addAudit(db, { userId: user.id, action: "update", entity: "sales_adjustment", entityId: adj.id, entityLabel: adj.number, summary: `取消し (${r.number}): ${reason}`, storeId: adj.toStoreId });
  });
  done(back, `${number} を取り消しました (取消しの行を追加)。`);
}

/** 内部受注を今の受注の金額・設定で計算し直す (前の行を取り消して計上し直す) */
export async function recalcInternalOrder(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=sales`, "edit");
  let msg = "";
  await mutate((db) => {
    const adj = db.salesAdjustments.find((a) => a.id === str(fd, "id"));
    const o = adj?.orderId ? db.orders.find((x) => x.id === adj.orderId) : undefined;
    if (!adj || !o || adj.kind !== "internal_order") fail(back, "内部受注が見つかりません。");
    const closed = closedReason(db, o.salesDate, "内部受注の再計算");
    if (closed) fail(back, closed);
    const r = reverseAdjustment(db, adj, { id: newId("adj"), number: nextNumber(db, "SA", db.salesAdjustments, today()), userId: user.id, now: nowIso(), today: today(), reason: "受注の金額・設定の変更による再計算" });
    if (typeof r === "string") fail(back, r);
    const calc = calcInternalOrder(db, o, adj.workKind ?? "normal", adj.rateSource === "override" ? adj.rateBp : undefined);
    const next: SalesAdjustment = { ...adj, id: newId("adj"), number: nextNumber(db, "SA", db.salesAdjustments, today()), base: calc.base, baseAmount: calc.baseAmount, rateBp: calc.rateBp, ruleIds: calc.ruleIds, rounding: calc.rounding, amount: calc.amount, provisional: calc.provisional, status: "active", reversalOf: undefined, reversedBy: undefined, reason: "再計算", createdBy: user.id, createdAt: nowIso() };
    db.salesAdjustments.push(next);
    msg = `${adj.number} を取り消し、${next.number} で計上し直しました (${calc.explain})。`;
    addAudit(db, { userId: user.id, action: "update", entity: "sales_adjustment", entityId: next.id, entityLabel: next.number, summary: `内部受注の再計算: ${calc.explain}`, storeId: next.toStoreId });
  });
  done(back, msg);
}

/* ================================================================== */
/* 材料原価                                                             */
/* ================================================================== */

/** 受注の材料の使用 (原価) を材料構成から計算して登録する (段階: 予想・使用予定・実績) */
export async function recordOrderCost(fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=cost`);
  const missing = await mgmtTablesMissing();
  if (missing) fail(back, missing);
  const order = orderByNumberOrId(str(fd, "orderId"));
  if (!order) fail(back, "受注が見つかりません。");
  if (!canRecordUsage(user, order)) fail(back, "この受注の原価を登録する権限がありません。");
  const stage = (["estimate", "planned", "actual"].includes(str(fd, "stage")) ? str(fd, "stage") : "planned") as "estimate" | "planned" | "actual";
  const spec: SpecChoice = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("spec:") || typeof v !== "string" || !v) continue;
    // 製造仕様で選べるのは畳床の材料だけ
    if (!getDb().materials.some((m) => m.id === v && m.kind === "doko" && m.active)) fail(back, "畳床の仕様は材料マスタの畳床から選んでください。");
    spec[k.slice(5)] = { materialId: v };
  }
  let msg = "";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === order.id)!;
    const date = o.salesDate ?? today();
    const closed = closedReason(db, date, "材料の使用の登録");
    if (closed) fail(back, closed);
    const fact = salesFacts(db).byId.get(o.id);
    const lines = costingLines(db, o, fact);
    const plan = planUsage(db, lines, date, spec, { hintText: productionNotes(db, o.id) });
    if (!plan.usages.length) fail(back, "材料構成に合う明細がありません (材料構成を登録するか、明細の品名を確かめてください)。");
    const att = db.orderAttributions.find((a) => a.orderId === o.id);
    const rows = recordUsages(db, o, att?.workStoreId ?? o.storeId, stage, plan.usages, { userId: user.id, now: nowIso(), date, source: Object.keys(spec).length ? "production" : "bom", makeId: () => newId("mu") });
    const total = rows.reduce((a, r) => a + (r.amount ?? 0), 0);
    const review = rows.filter((r) => r.needsReview).length;
    msg = `材料の${stage === "actual" ? "使用実績" : stage === "planned" ? "使用予定" : "予想原価"}を登録しました (${rows.length} 行・${total.toLocaleString("ja-JP")} 円${review ? `・要確認 ${review} 行` : ""})。`;
    addAudit(db, { userId: user.id, action: "create", entity: "material_usage", entityId: o.id, entityLabel: o.number, summary: msg, storeId: o.storeId });
  });
  done(back, msg);
}

/**
 * 受注の明細の品目 (管理会計) を直す (本部スタッフ・管理者)。見積の画面で直せない受注 (完了・入金済みで編集できない見積など) のため。
 * 売上の明細の元 (見積 → 請求書) の明細に品目を書く。同じ受注の請求書の同じ明細も合わせる。月次確定済みの月の受注は断る
 */
export async function saveLineCategories(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=cost`, "edit");
  const order = orderByNumberOrId(str(fd, "orderId"));
  if (!order) fail(back, "受注が見つかりません。");
  let msg = "";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === order.id)!;
    const closed = closedReason(db, o.salesDate ?? today(), "明細の品目の変更");
    if (closed) fail(back, closed);
    const src = orderLineSource(db, o);
    if (!src) fail(back, "この受注には見積・請求書の明細がありません (移行した受注は売上台帳の区分のままです)。");
    const now = nowIso();
    const changes: { field: string; before: unknown; after: unknown }[] = [];
    const lines: string[] = [];
    src.items.forEach((it, k) => {
      if (!fd.has(`cat_${k}`)) return;
      const raw = str(fd, `cat_${k}`);
      if (raw && !isItemCategory(db, raw)) fail(back, `${k + 1} 行目: 品目を選んでください。`);
      const next = raw || undefined;
      if ((it.itemCategory ?? "") === (next ?? "")) return;
      changes.push({ field: `items.${k + 1}.itemCategory`, before: it.itemCategory ?? null, after: next ?? null });
      lines.push(`${k + 1} 行目 ${it.name}: ${it.itemCategory ? categoryName(db, it.itemCategory) : "自動"} → ${next ? categoryName(db, next) : "自動"}`);
      it.itemCategory = next;
    });
    if (!changes.length) fail(back, "変更された品目がありません。");
    src.record.updatedAt = now;
    // 同じ受注の請求書 (見積から作った同じ明細) も合わせる
    if (src.kind === "quote") syncInvoiceLineCategories(db, o.id, src.items, now);
    msg = `明細の品目を変更しました (${changes.length} 行)。`;
    addAudit(db, { userId: user.id, action: "update", entity: src.kind === "quote" ? "quote" : "invoice", entityId: src.record.id, entityLabel: src.record.number, summary: `明細の品目 (管理会計) を変更 (受注 ${o.number}): ${lines.join(" / ")}`, storeId: o.storeId, changes });
  });
  done(back, msg);
}

/** 材料マスタの登録・変更 (管理者) */
export async function saveMaterial(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=masters`, "admin");
  const code = str(fd, "code").slice(0, 40);
  const name = str(fd, "name").slice(0, 80);
  const kind = str(fd, "kind") as MaterialKind;
  if (!code || !name) fail(back, "コードと名前を入力してください。");
  if (!MATERIAL_KIND_LABEL[kind]) fail(back, "材料の種類を選んでください。");
  const itemCategory = str(fd, "itemCategory");
  if (!itemCategories(getDb()).some((c) => c.id === itemCategory)) fail(back, "品目を選んでください。");
  const thickness = str(fd, "thickness") ? decimal(str(fd, "thickness")) : undefined;
  if (thickness !== undefined && !(thickness > 0)) fail(back, "厚みは mm の数で入力してください。");
  const id = str(fd, "id");
  await mutate((db) => {
    if (db.materials.some((m) => m.code === code && m.id !== id)) fail(back, `コード ${code} の材料はもうあります。`);
    const row = { code, name, kind, spec: str(fd, "spec") || undefined, unit: str(fd, "unit") || "枚", thickness, size: str(fd, "size") || undefined, itemCategory, supplierCode: str(fd, "supplierCode") || undefined, active: str(fd, "active") !== "0", note: str(fd, "note") || undefined, updatedAt: nowIso() };
    const m = id ? db.materials.find((x) => x.id === id) : undefined;
    if (id && !m) fail(back, "材料が見つかりません。");
    if (m) Object.assign(m, row);
    else db.materials.push({ id: newId("mat"), ...row, createdAt: nowIso() });
    addAudit(db, { userId: user.id, action: m ? "update" : "create", entity: "material", entityId: m?.id ?? code, entityLabel: name, summary: `材料 ${code} ${name} (${MATERIAL_KIND_LABEL[kind]})` });
  });
  done(back, "材料を保存しました。");
}

/** 原価単価の変更 (新しい行。確定した月にかかる適用開始日は断る) */
export async function setMaterialCostAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=masters`, "admin");
  const unitCost = decimal(str(fd, "unitCost"));
  const validFrom = str(fd, "validFrom");
  if (!(unitCost >= 0)) fail(back, "単価は 0 以上の数 (小数 4 桁まで) で入力してください。");
  if (!isDate(validFrom)) fail(back, "適用開始日を入力してください。");
  await mutate((db) => {
    const m = db.materials.find((x) => x.id === str(fd, "materialId"));
    if (!m) fail(back, "材料が見つかりません。");
    const lc = lastClosedMonth(db);
    if (lc && monthOf(validFrom) <= lc) fail(back, `${lc} まで月次確定済みです。適用開始日は確定した月より後にしてください。`);
    const row = setMaterialCost(db, { materialId: m.id, unitCost, kind: str(fd, "kind") === "provisional" ? "provisional" : "standard", validFrom, note: str(fd, "note") || undefined }, user.id, newId("mc"), nowIso());
    addAudit(db, { userId: user.id, action: "update", entity: "material_cost", entityId: row.id, entityLabel: m.name, summary: `${m.name} の単価 ${unitCost.toLocaleString("ja-JP")} 円 (${row.kind === "provisional" ? "仮原価" : "原価単価"}) ${validFrom} から` });
  });
  done(back, "単価を登録しました (前の単価は履歴に残ります)。");
}

/** 材料構成 (BOM) の登録 (新しい版。前の版は適用開始日の前日で閉じる) */
export async function saveBom(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=masters`, "admin");
  const name = str(fd, "name").slice(0, 80);
  const validFrom = str(fd, "validFrom") || today();
  if (!name) fail(back, "名前を入力してください。");
  if (!isDate(validFrom)) fail(back, "適用開始日を入力してください。");
  const productId = str(fd, "productId") || undefined;
  const matchName = str(fd, "matchName") || undefined;
  if (!productId && !matchName) fail(back, "商品マスタの商品か、品名に含まれる言葉 (例: 半畳) を指定してください。");
  const db0 = getDb();
  // 行: 「材料コード または 種類, 使用量[, 既定の材料コード]」 (例: OMOTE-A, 1 / doko, 0.5, DOKO-K55 / sub, 1)
  const lines = str(fd, "lines")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const [ref, q, def] = l.split(/[,，\t]/).map((x) => x.trim());
      const qty = decimal(q ?? "");
      if (!(qty > 0)) fail(back, `${i + 1} 行目: 使用量を数で入力してください (例: 0.5)。`);
      const m = db0.materials.find((x) => x.code === ref);
      if (m) return { materialId: m.id, materialKind: m.kind, qty: round4(qty) };
      if (MATERIAL_KIND_LABEL[ref as MaterialKind]) {
        if (!def) return { materialKind: ref as MaterialKind, qty: round4(qty) };
        const d = db0.materials.find((x) => x.code === def);
        if (!d) fail(back, `${i + 1} 行目: 既定の材料コード「${def}」が見つかりません。`);
        if (d.kind !== ref) fail(back, `${i + 1} 行目: 既定の材料「${d.name}」の種類 (${MATERIAL_KIND_LABEL[d.kind]}) が行の種類と違います。`);
        return { materialKind: ref as MaterialKind, qty: round4(qty), defaultMaterialId: d.id };
      }
      fail(back, `${i + 1} 行目: 材料コード「${ref}」が見つかりません (種類だけを決めるときは doko・sub など)。`);
    });
  if (!lines.length) fail(back, "材料の行を入力してください。");
  await mutate((db) => {
    const lc = lastClosedMonth(db);
    if (lc && monthOf(validFrom) <= lc) fail(back, `${lc} まで月次確定済みです。適用開始日は確定した月より後にしてください。`);
    for (const b of db.boms) {
      const sameKey = (productId && b.productId === productId) || (matchName && b.matchName === matchName);
      if (sameKey && (!b.validTo || b.validTo >= validFrom) && b.validFrom < validFrom) b.validTo = new Date(Date.parse(`${validFrom}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      else if (sameKey && b.validFrom === validFrom) b.validTo = new Date(Date.parse(`${validFrom}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    }
    const id = newId("bom");
    db.boms.push({ id, productId, matchName, name, lines: lines as never, validFrom, note: str(fd, "note") || undefined, createdBy: user.id, createdAt: nowIso() });
    addAudit(db, { userId: user.id, action: "create", entity: "bom", entityId: id, entityLabel: name, summary: `材料構成 ${name} (${lines.length} 行) ${validFrom} から` });
  });
  done(back, "材料構成を保存しました。");
}

/** 材料マスタ・単価の一括登録 (CSV: コード,名前,種類,単位,品目,単価,単価の種類,適用開始日,厚み,規格,仕入先の品番) */
export async function importMaterialsCsv(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=masters`, "admin");
  const file = fd.get("file");
  const text = file instanceof File && file.size ? Buffer.from(await file.arrayBuffer()).toString("utf8").replace(/^﻿/, "") : str(fd, "csv");
  if (!text.trim()) fail(back, "CSV を選んでください。");
  const rows = text.split(/\r?\n/).map((l) => l.split(",").map((x) => x.trim())).filter((r) => r.some(Boolean));
  if (rows.length && /コード|code/i.test(rows[0][0])) rows.shift();
  let added = 0;
  let costs = 0;
  await mutate((db) => {
    const lc = lastClosedMonth(db);
    rows.forEach((r, i) => {
      const [code, name, kind, unit, cat, cost, costKind, from, thick, size, supplierCode] = r;
      const n = `${i + 1} 行目`;
      if (!code || !name) fail(back, `${n}: コードと名前が必要です。`);
      if (!MATERIAL_KIND_LABEL[kind as MaterialKind]) fail(back, `${n}: 種類「${kind}」は ${Object.keys(MATERIAL_KIND_LABEL).join("・")} のどれかにしてください。`);
      if (!CATEGORY_IDS.includes(cat) && !db.itemCategories.some((c) => c.id === cat)) fail(back, `${n}: 品目「${cat}」は ${CATEGORY_IDS.join("・")} のどれかにしてください。`);
      let m = db.materials.find((x) => x.code === code);
      if (!m) {
        m = { id: newId("mat"), code, name, kind: kind as MaterialKind, unit: unit || "枚", itemCategory: cat, thickness: thick ? decimal(thick) : undefined, size: size || undefined, supplierCode: supplierCode || undefined, active: true, createdAt: nowIso(), updatedAt: nowIso() };
        db.materials.push(m);
        added++;
      }
      if (cost) {
        const c = decimal(cost);
        const vf = from || today();
        if (!(c >= 0) || !isDate(vf)) fail(back, `${n}: 単価・適用開始日を確かめてください。`);
        if (lc && monthOf(vf) <= lc) fail(back, `${n}: 適用開始日 ${vf} は月次確定済みの月です。`);
        setMaterialCost(db, { materialId: m.id, unitCost: c, kind: costKind === "provisional" || costKind === "仮原価" ? "provisional" : "standard", validFrom: vf }, user.id, newId("mc"), nowIso());
        costs++;
      }
    });
    addAudit(db, { userId: user.id, action: "import", entity: "material", entityId: "csv", entityLabel: "材料マスタ", summary: `材料 ${added} 件・単価 ${costs} 件を取り込み` });
  });
  done(back, `材料 ${added} 件・単価 ${costs} 件を取り込みました。`);
}

/** 売上台帳「新原本」右上の畳材料原価単価表を取り込む (適用開始日つき。過去の原価は変えない) */
export async function importTatamiCostSheet(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=masters`, "admin");
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "売上台帳の .xlsx (シート「新原本」) を選んでください。");
  if (!/\.xlsx$/i.test(file.name)) fail(back, ".xlsx のファイルを選んでください。");
  const validFrom = str(fd, "validFrom") || today();
  if (!isDate(validFrom)) fail(back, "適用開始日を入力してください。");
  let plan;
  try {
    plan = parseTatamiCostSheet({ buf: Buffer.from(await file.arrayBuffer()), validFrom });
  } catch (e) {
    fail(back, (e as Error).message || "単価表を読めませんでした。");
  }
  if (!plan.rows.length) fail(back, "単価表の行がありません (シート「新原本」の右上を確かめてください)。");
  const lc = lastClosedMonth(getDb());
  if (lc && monthOf(validFrom) <= lc) fail(back, `${lc} まで月次確定済みです。適用開始日は確定した月より後にしてください。`);
  let r = { added: 0, updated: 0, costs: 0, unchanged: 0, codes: [] as string[] };
  await mutate((db) => {
    r = applyTatamiCostPlan(db, plan, { userId: user.id, now: nowIso(), makeId: newId });
    addAudit(db, {
      userId: user.id,
      action: "import",
      entity: "material",
      entityId: "tatami_cost_sheet",
      entityLabel: "畳材料原価単価表",
      summary: `新原本の単価表を取込: 材料の追加 ${r.added}・更新 ${r.updated}・単価 ${r.costs}・変更なし ${r.unchanged} (適用 ${validFrom}・${plan.rows.length} 品目)`,
    });
  });
  done(back, `取り込みました: 材料の追加 ${r.added} 件・更新 ${r.updated} 件・新しい単価 ${r.costs} 件 (同じ単価 ${r.unchanged} 件は履歴に足していません)。過去の受注の原価は変わりません。`);
}

/* ================================================================== */
/* 在庫・材料移動                                                        */
/* ================================================================== */

export async function postStockMoveAction(fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=stock`);
  const missing = await mgmtTablesMissing();
  if (missing) fail(back, missing);
  const kind = str(fd, "kind") as "receive" | "transfer" | "use" | "return" | "dispose" | "adjust";
  const date = str(fd, "date") || today();
  const qty = decimal(str(fd, "qty"));
  const fromLoc = str(fd, "fromLoc");
  const toLoc = str(fd, "toLoc");
  if (!canRequestMove(user, fromLoc, toLoc)) fail(back, "この移動を登録する権限がありません (店長は自店舗が移動元・移動先の移動だけ)。");
  if (!isDate(date)) fail(back, "日付を入力してください。");
  const order = str(fd, "order") ? orderByNumberOrId(str(fd, "order")) : undefined;
  if (str(fd, "order") && !order) fail(back, "案件 (受注) が見つかりません。");
  let msg = "";
  await mutate((db) => {
    const m = db.materials.find((x) => x.id === str(fd, "materialId"));
    if (!m) fail(back, "材料を選んでください。");
    const closed = closedReason(db, date, "在庫の移動");
    if (closed) fail(back, closed);
    // 単価: 入力 → 移動元の在庫の平均 → その日の原価単価
    const fromStore = locStore(fromLoc);
    const input = str(fd, "unitCost") ? decimal(str(fd, "unitCost")) : NaN;
    const unitCost = Number.isFinite(input) ? input : ((fromStore ? averageCost(db, fromStore, m.id, date) : undefined) ?? db.materialCosts.filter((c) => c.materialId === m.id && c.validFrom <= date).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]?.unitCost ?? NaN);
    if (!(unitCost >= 0)) fail(back, "単価が分かりません。単価を入力してください。");
    const move = { kind, fromLoc, toLoc: kind === "use" && order ? `order:${order.id}` : toLoc, qty, unitCost, orderId: order?.id };
    const err = validateMove(move);
    if (err) fail(back, err);
    const row = postMove(db, { id: newId("sm"), number: nextNumber(db, "SM", db.stockMoves, date), date, ...move, materialId: m.id, note: str(fd, "note").slice(0, 200) || undefined, status: canEditMgmt(user) ? "confirmed" : "draft", createdBy: user.id, createdAt: nowIso(), ...(canEditMgmt(user) ? { approvedBy: user.id, approvedAt: nowIso() } : {}) });
    msg = `${row.number} を${row.status === "draft" ? "申請しました (本部スタッフ・管理者が確定します)" : "登録しました"}。`;
    addAudit(db, { userId: user.id, action: "create", entity: "stock_move", entityId: row.id, entityLabel: row.number, summary: `${m.name} ${row.qty} ${m.unit} ${fromLoc || "-"} → ${row.toLoc || "-"} (${row.amount.toLocaleString("ja-JP")} 円)`, storeId: row.storeId });
  });
  done(back, msg);
}

export async function approveStockMove(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=stock`, "edit");
  await mutate((db) => {
    const m = db.stockMoves.find((x) => x.id === str(fd, "id"));
    if (!m || m.status !== "draft") fail(back, "申請中の移動が見つかりません。");
    const closed = closedReason(db, m.date, "在庫の移動の確定");
    if (closed) fail(back, closed);
    m.status = "confirmed";
    m.approvedBy = user.id;
    m.approvedAt = nowIso();
    addAudit(db, { userId: user.id, action: "approve", entity: "stock_move", entityId: m.id, entityLabel: m.number, summary: "在庫の移動を確定", storeId: m.storeId });
  });
  done(back, "移動を確定しました。");
}

export async function reverseStockMoveAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=stock`, "edit");
  const reason = str(fd, "reason").slice(0, 200);
  if (!reason) fail(back, "取消しの理由を入力してください。");
  await mutate((db) => {
    const m = db.stockMoves.find((x) => x.id === str(fd, "id"));
    if (!m) fail(back, "移動が見つかりません。");
    if (m.status === "draft") {
      m.status = "reversed";
      m.note = `${m.note ?? ""} (申請を取消し: ${reason})`.trim();
    } else {
      const r = reverseMove(db, m, { id: newId("sm"), number: nextNumber(db, "SM", db.stockMoves, today()), userId: user.id, now: nowIso(), today: today(), reason });
      if (typeof r === "string") fail(back, r);
    }
    addAudit(db, { userId: user.id, action: "update", entity: "stock_move", entityId: m.id, entityLabel: m.number, summary: `取消し: ${reason}`, storeId: m.storeId });
  });
  done(back, "移動を取り消しました (逆向きの移動を追加)。");
}

/* ================================================================== */
/* 仕入明細の振り分け                                                     */
/* ================================================================== */

/** 仕入の明細を自動で判定する (確定した明細はそのまま) */
export async function analyzePurchase(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=purchases`, "edit");
  const ids = str(fd, "purchaseId") ? [str(fd, "purchaseId")] : str(fd, "all") === "1" ? getDb().purchases.filter((p) => p.status !== "rejected" && !getDb().purchaseLineAllocs.some((a) => a.purchaseId === p.id)).map((p) => p.id).slice(0, 200) : [];
  if (!ids.length) fail(back, "判定する仕入がありません。");
  let n = 0;
  await mutate((db) => {
    for (const id of ids) {
      const p = db.purchases.find((x) => x.id === id);
      if (!p) continue;
      const rows = buildLineAllocs(db, p, nowIso());
      upsertLineAllocs(db, rows.filter((r) => r.status !== "confirmed" || !db.purchaseLineAllocs.some((a) => a.id === r.id)));
      n += rows.length;
    }
    addAudit(db, { userId: user.id, action: "update", entity: "purchase_line_alloc", entityId: ids[0], entityLabel: `${ids.length} 件の仕入`, summary: `仕入明細の自動判定 (${n} 明細)` });
  });
  done(back, `${ids.length} 件の仕入 (${n} 明細) を判定しました。確定は明細ごとに確認してから行ってください。`);
}

/** 要確認の明細に AI の候補を出す (規則で決まらなかった案件・店舗・品目・費用区分。確定は担当者) */
export async function aiAssistPurchase(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=purchases`, "edit");
  if (!aiStatus().enabled) fail(back, "AI の API キーが設定されていないため、AI の候補は出せません (規則の判定と担当者の確認で進めてください)。");
  const db0 = getDb();
  const p = db0.purchases.find((x) => x.id === str(fd, "purchaseId"));
  if (!p) fail(back, "仕入が見つかりません。");
  const lines = aiTargetLines(db0.purchaseLineAllocs.filter((a) => a.purchaseId === p.id)).slice(0, 30);
  if (!lines.length) fail(back, "AI の候補を出す明細 (要確認・未振り分けの明細) がありません。先に「自動判定する」を押してください。");
  const candidates = aiCandidateOrders(db0, p, lines);
  const prompt = buildPurchaseAiPrompt(db0, p, lines, candidates, salesFacts(db0).byId);
  let suggestions: AiLineSuggestion[] = [];
  let aiError = "";
  try {
    const r = await withAiContext({ kind: "purchase_match", userId: user.id }, () =>
      generateJson<unknown>({ system: prompt.system, parts: [{ type: "text", text: prompt.user }], schema: PURCHASE_AI_SCHEMA as unknown as Record<string, unknown>, schemaName: "ichijoya_purchase_lines", maxTokens: 4000 }),
    );
    suggestions = normalizePurchaseAi(db0, r.data, lines, candidates);
  } catch (err) {
    aiError = err instanceof AiError ? err.message : "AI の候補を出せませんでした。";
  }
  if (aiError) fail(back, aiError);
  let n = 0;
  await mutate((db) => {
    n = applyAiSuggestions(db, suggestions, p.id, nowIso());
    addAudit(db, { userId: user.id, action: "update", entity: "purchase_line_alloc", entityId: p.id, entityLabel: p.number, summary: `仕入明細に AI の候補を入れました (${n} 明細・案件の候補 ${candidates.length} 件)` });
  });
  done(back, n ? `${n} 明細に AI の候補を入れました。理由を確かめてから確定してください (AI の候補だけでは確定しません)。` : "AI は候補を出せませんでした。明細ごとに確かめて振り分けてください。");
}

/** 明細の振り分けを確定する (複数の店舗・案件・品目に分けられる。合計は明細の税抜の金額) */
export async function confirmPurchaseLine(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=purchases`, "edit");
  const splits: PurchaseSplit[] = [];
  for (let i = 0; i < 6; i++) {
    const amountRaw = str(fd, `amount${i}`);
    if (!amountRaw) continue;
    const storeId = storeIdOf(str(fd, `store${i}`));
    const costType = str(fd, `costType${i}`) as CostType;
    const order = str(fd, `order${i}`) ? orderByNumberOrId(str(fd, `order${i}`)) : undefined;
    if (str(fd, `order${i}`) && !order) fail(back, `${i + 1} 行目: 案件が見つかりません。`);
    if (!COST_TYPE_LABEL[costType]) fail(back, `${i + 1} 行目: 費用区分を選んでください。`);
    splits.push({ storeId: storeId ?? ("" as StoreId), orderId: order?.id, itemCategory: str(fd, `cat${i}`), costType, materialId: str(fd, `material${i}`) || undefined, qty: str(fd, `qty${i}`) ? decimal(str(fd, `qty${i}`)) : undefined, amount: yenInt(amountRaw) });
  }
  await mutate((db) => {
    const a = db.purchaseLineAllocs.find((x) => x.id === str(fd, "id"));
    if (!a) fail(back, "明細が見つかりません。");
    const err = confirmLineAlloc(db, a, splits, { userId: user.id, now: nowIso(), today: today(), reason: str(fd, "reason"), makeMove: () => ({ id: newId("sm"), number: nextNumber(db, "SM", db.stockMoves, today()) }), closed: (d) => closedReason(db, d, "仕入明細の振り分け") });
    if (err) fail(back, err);
    const differs = a.ai && (a.ai.storeId !== splits[0]?.storeId || a.ai.itemCategory !== splits[0]?.itemCategory || a.ai.costType !== splits[0]?.costType || splits.length > 1);
    addAudit(db, { userId: user.id, action: "approve", entity: "purchase_line_alloc", entityId: a.id, entityLabel: `${a.ocr.name}`, summary: `振り分けを確定: ${splits.map((s) => `${storeName(db, s.storeId)} ${s.itemCategory} ${COST_TYPE_LABEL[s.costType]} ${s.amount.toLocaleString("ja-JP")} 円`).join(" / ")}${differs ? " (自動判定から修正)" : ""}${str(fd, "reason") ? ` 理由: ${str(fd, "reason")}` : ""}` });
  });
  done(back, "振り分けを確定しました。");
}

/* ================================================================== */
/* 経費の区分・手入力                                                    */
/* ================================================================== */

export async function classifyExpense(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=alloc`, "edit");
  const allocClass = str(fd, "allocClass") === "common" ? "common" : "store";
  const costKind = str(fd, "costKind").slice(0, 40) || "その他";
  await mutate((db) => {
    const e = db.expenses.find((x) => x.id === str(fd, "expenseId"));
    if (!e) fail(back, "経費が見つかりません。");
    const closed = closedReason(db, e.date, "経費の区分の変更");
    if (closed) fail(back, closed);
    const id = `ec_${e.id}`;
    const prev = db.expenseClasses.find((c) => c.id === id);
    const row = { id, expenseId: e.id, allocClass: allocClass as "store" | "common", costKind, note: str(fd, "note") || undefined, updatedBy: user.id, updatedAt: nowIso() };
    if (prev) Object.assign(prev, row);
    else db.expenseClasses.push(row);
    addAudit(db, { userId: user.id, action: prev ? "update" : "create", entity: "expense_class", entityId: id, entityLabel: e.number, summary: `経費の区分: ${allocClass === "common" ? "共通経費 (案分)" : "店舗独自経費"} / ${costKind}`, storeId: e.storeId });
  });
  done(back, "経費の区分を保存しました。");
}

const ENTRY_KINDS: MgmtEntry["kind"][] = ["labor", "store_expense", "common_expense", "other_mgmt", "material_adjust", "budget"];

export async function addMgmtEntry(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=entries`, "edit");
  const month = str(fd, "month");
  const storeId = storeIdOf(str(fd, "storeId"));
  const kind = str(fd, "kind") as MgmtEntry["kind"];
  const amount = yenInt(str(fd, "amount"));
  if (!isMonth(month)) fail(back, "月を選んでください。");
  if (!storeId) fail(back, "店舗を選んでください。");
  if (!ENTRY_KINDS.includes(kind)) fail(back, "種類を選んでください。");
  if (!Number.isSafeInteger(amount) || amount === 0) fail(back, "金額は円の整数で入力してください。");
  if (kind === "material_adjust" && !str(fd, "note")) fail(back, "材料の差額調整は、期間・在庫の確認内容を備考に書いてください。");
  await mutate((db) => {
    const closed = closedReason(db, `${month}-01`, "手入力");
    if (closed) fail(back, closed);
    const row: MgmtEntry = { id: newId("me"), month, storeId, kind, metric: kind === "budget" ? str(fd, "metric") || "sales" : undefined, itemCategory: str(fd, "itemCategory") || undefined, amount, note: str(fd, "note").slice(0, 200) || undefined, status: "active", createdBy: user.id, createdAt: nowIso() };
    db.mgmtEntries.push(row);
    addAudit(db, { userId: user.id, action: "create", entity: "mgmt_entry", entityId: row.id, entityLabel: `${month} ${storeName(db, storeId)}`, summary: `${kind} ${amount.toLocaleString("ja-JP")} 円 ${row.note ?? ""}`, storeId });
  });
  done(back, "登録しました。");
}

/**
 * 人件費の一括取込 (CSV: 月,店舗,金額[,備考]。給与ソフトなどから店舗ごとの月額)。
 * 月 × 店舗の人件費の合計が CSV の金額になるように、差額だけの行を足す (同じ CSV をもう一度取り込んでも増えない)
 */
export async function importLaborCsv(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=entries`, "edit");
  const file = fd.get("file");
  const text = file instanceof File && file.size ? Buffer.from(await file.arrayBuffer()).toString("utf8").replace(/^\uFEFF/, "") : str(fd, "csv");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) fail(back, "CSV を選ぶか貼り付けてください。");
  if (lines.length > 600) fail(back, "1 回に取り込めるのは 600 行までです。");
  const db0 = getDb();
  const rows: { month: string; storeId: StoreId; amount: number; note?: string }[] = [];
  for (const [i, l] of lines.entries()) {
    const [m, storeRaw, amountRaw, note] = l.split(/[,\t]/).map((x) => x.trim());
    if (i === 0 && !/^\d{4}[-/]\d{1,2}$/.test(m ?? "")) continue; // 見出しの行
    const mm = (m ?? "").match(/^(\d{4})[-/](\d{1,2})$/);
    if (!mm) fail(back, `${i + 1} 行目: 月は 2026-11 の形で書いてください。`);
    const month = `${mm[1]}-${mm[2].padStart(2, "0")}`;
    const storeId = storeIdOf(storeRaw ?? "") ?? storeIdOfName(db0, storeRaw ?? "");
    if (!storeId) fail(back, `${i + 1} 行目: 店舗「${storeRaw}」が分かりません。`);
    const amount = yenInt(amountRaw ?? "");
    if (!Number.isSafeInteger(amount)) fail(back, `${i + 1} 行目: 金額は円の整数で書いてください。`);
    rows.push({ month, storeId, amount, note: note?.slice(0, 100) || undefined });
  }
  let added = 0;
  let same = 0;
  await mutate((db) => {
    for (const r of rows) {
      const closed = closedReason(db, `${r.month}-01`, "人件費の取込");
      if (closed) fail(back, closed);
      const current = db.mgmtEntries.filter((m) => m.kind === "labor" && m.month === r.month && m.storeId === r.storeId).reduce((a, m) => a + m.amount, 0);
      const diff = r.amount - current;
      if (diff === 0) {
        same++;
        continue;
      }
      db.mgmtEntries.push({ id: newId("me"), month: r.month, storeId: r.storeId, kind: "labor", amount: diff, note: `人件費の取込 (CSV): 合計 ${r.amount.toLocaleString("ja-JP")} 円${current ? ` (前の合計 ${current.toLocaleString("ja-JP")} 円との差額)` : ""}${r.note ? ` ${r.note}` : ""}`, status: "active", createdBy: user.id, createdAt: nowIso() });
      added++;
    }
    addAudit(db, { userId: user.id, action: "import", entity: "mgmt_entry", entityId: "labor_csv", entityLabel: "人件費の取込", summary: `人件費の取込 (CSV): ${rows.length} 行 (登録 ${added}・変わらず ${same})` });
  });
  done(back, `人件費を取り込みました (${rows.length} 行のうち 登録 ${added} 行・同じ金額のため変更なし ${same} 行)。`);
}

/** 広告宣伝費の予算の超過分を店舗独自経費へ移す (月ごと) */
export async function moveAdOverageAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=alloc`, "edit");
  const month = str(fd, "month");
  if (!isMonth(month)) fail(back, "月を選んでください。");
  let msg = "";
  await mutate((db) => {
    const r = moveAdOverage(db, month, { userId: user.id, now: nowIso(), makeId: () => newId("me") });
    if (typeof r === "string") fail(back, r);
    const moved = r.filter((x) => x.kind === "store_expense");
    msg = `広告宣伝費の予算超過分を店舗独自経費へ移しました (${moved.map((x) => `${storeName(db, x.storeId)} ${x.amount.toLocaleString("ja-JP")} 円`).join("・")})。`;
    addAudit(db, { userId: user.id, action: "create", entity: "mgmt_entry", entityId: `ad_over_${month}`, entityLabel: `${month} 広告の予算超過`, summary: msg });
  });
  done(back, msg);
}

export async function reverseMgmtEntry(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=entries`, "edit");
  const reason = str(fd, "reason").slice(0, 200);
  if (!reason) fail(back, "取消しの理由を入力してください。");
  await mutate((db) => {
    const m = db.mgmtEntries.find((x) => x.id === str(fd, "id"));
    if (!m || m.status !== "active" || m.reversalOf) fail(back, "取り消せる行が見つかりません。");
    const closed = closedReason(db, `${m.month}-01`, "手入力の取消し");
    if (closed) fail(back, closed);
    const rev: MgmtEntry = { ...m, id: newId("me"), amount: -m.amount, reversalOf: m.id, note: `取消し: ${reason}`, createdBy: user.id, createdAt: nowIso() };
    m.status = "reversed";
    m.reversedBy = rev.id;
    db.mgmtEntries.push(rev);
    addAudit(db, { userId: user.id, action: "update", entity: "mgmt_entry", entityId: m.id, entityLabel: m.month, summary: `取消し: ${reason}`, storeId: m.storeId });
  });
  done(back, "取り消しました。");
}

/* ================================================================== */
/* 畳表の仮原価と実仕入の差額                                             */
/* ================================================================== */

/** 期間の差額を計算して、店舗ごとに粗利益の比率で案分した行を登録する (管理者) */
export async function confirmOmoteDiffAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=alloc`, "admin");
  const fromMonth = str(fd, "fromMonth");
  const toMonth = str(fd, "toMonth");
  if (!isMonth(fromMonth) || !isMonth(toMonth) || fromMonth > toMonth) fail(back, "期間 (開始月・終了月) を選んでください。");
  let msg = "";
  await mutate((db) => {
    const p = previewOmoteDiff(db, fromMonth, toMonth);
    const r = confirmOmoteDiff(db, p, { userId: user.id, now: nowIso(), makeId: () => newId("me") });
    if (typeof r === "string") fail(back, r);
    msg = `畳表の差額 ${fromMonth}〜${toMonth} (${p.diff.toLocaleString("ja-JP")} 円) を店舗に案分しました。`;
    addAudit(db, { userId: user.id, action: "approve", entity: "mgmt_entry", entityId: omoteDiffKey(fromMonth, toMonth), entityLabel: `畳表の差額 ${fromMonth}〜${toMonth}`, summary: `${msg} 実際の仕入 ${p.purchases.toLocaleString("ja-JP")} 円 − 仮原価の計上 ${p.booked.toLocaleString("ja-JP")} 円 / ${r.map((x) => `${storeName(db, x.storeId)} ${x.amount.toLocaleString("ja-JP")}`).join("・")}` });
  });
  done(back, msg);
}

export async function reverseOmoteDiffAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=alloc`, "admin");
  const key = str(fd, "key");
  const reason = str(fd, "reason").slice(0, 200);
  if (!reason) fail(back, "取消しの理由を入力してください。");
  await mutate((db) => {
    const r = reverseOmoteDiff(db, key, { userId: user.id, now: nowIso(), makeId: () => newId("me"), reason });
    if (typeof r === "string") fail(back, r);
    addAudit(db, { userId: user.id, action: "update", entity: "mgmt_entry", entityId: key, entityLabel: "畳表の差額", summary: `取消し (${r.length} 行): ${reason}` });
  });
  done(back, "畳表の差額を取り消しました (逆の行を追加)。");
}

/* ================================================================== */
/* 店舗間の材料移動 (原価の振替)                                          */
/* ================================================================== */

export async function postMaterialTransfer(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=stock`, "edit");
  const date = str(fd, "date") || today();
  if (!isDate(date)) fail(back, "日付を入力してください。");
  const qty = decimal(str(fd, "qty"));
  const unitRaw = str(fd, "unitCost");
  const unitCost = unitRaw ? decimal(unitRaw) : undefined;
  if (unitRaw && !(Number(unitCost) >= 0)) fail(back, "単価は 0 以上の数で入力してください。");
  const itemCategory = str(fd, "itemCategory");
  if (itemCategory && !itemCategories(getDb()).some((c) => c.id === itemCategory)) fail(back, "品目を選んでください。");
  let number = "";
  await mutate((db) => {
    const closed = closedReason(db, date, "材料移動");
    if (closed) fail(back, closed);
    const input = { date, fromStoreId: str(fd, "fromStoreId") as StoreId, toStoreId: str(fd, "toStoreId") as StoreId, materialId: str(fd, "materialId") || undefined, name: str(fd, "name").slice(0, 80), itemCategory, qty, unitCost, note: str(fd, "note").slice(0, 200) || undefined };
    const plan = planTransfer(db, input);
    if (typeof plan === "string") fail(back, plan);
    number = nextNumber(db, "MT", db.materialTransfers, date);
    const row: MaterialTransfer = { id: newId("mt"), number, date, fromStoreId: input.fromStoreId, toStoreId: input.toStoreId, materialId: input.materialId, name: plan.name, itemCategory: plan.itemCategory, qty: round4(qty), unitCost: plan.unitCost, amount: plan.amount, note: input.note, status: "active", createdBy: user.id, createdAt: nowIso() };
    db.materialTransfers.push(row);
    addAudit(db, { userId: user.id, action: "create", entity: "material_transfer", entityId: row.id, entityLabel: number, summary: `${storeName(db, row.fromStoreId)} → ${storeName(db, row.toStoreId)} ${row.name} ×${row.qty} (${row.amount.toLocaleString("ja-JP")} 円・${itemCategories(db).find((c) => c.id === row.itemCategory)?.name ?? row.itemCategory})`, storeId: row.toStoreId });
  });
  done(back, `材料移動 ${number} を登録しました (渡した店舗の材料費 −・受け取った店舗の材料費 +)。`);
}

export async function reverseMaterialTransfer(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=stock`, "edit");
  const reason = str(fd, "reason").slice(0, 200);
  if (!reason) fail(back, "取消しの理由を入力してください。");
  let number = "";
  await mutate((db) => {
    const t = db.materialTransfers.find((x) => x.id === str(fd, "id"));
    if (!t) fail(back, "材料移動が見つかりません。");
    const r = reverseTransfer(db, t, { id: newId("mt"), number: nextNumber(db, "MT", db.materialTransfers, today()), userId: user.id, now: nowIso(), today: today(), reason });
    if (typeof r === "string") fail(back, r);
    number = t.number;
    addAudit(db, { userId: user.id, action: "update", entity: "material_transfer", entityId: t.id, entityLabel: t.number, summary: `取消し (${r.number}): ${reason}`, storeId: t.toStoreId });
  });
  done(back, `${number} を取り消しました (取消しの行を追加)。`);
}

/* ================================================================== */
/* これまでの「材料移動」の表 (.xlsx) の取込                               */
/* ================================================================== */

const MM_KEY = (hash: string) => `imports/material-moves/${hash}.json`;

/** 表を読んで、取り込む内容を確かめる (保存はしない。確認の内容はファイルに置く)。管理者 */
export async function previewMaterialMoves(fd: FormData) {
  const { back } = await start(fd, `${BASE}?tab=stock`, "admin");
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "材料移動の表 (.xlsx) を選んでください。");
  if (file.size > 4 * 1024 * 1024) fail(back, "ファイルが大きすぎます (4 MB まで)。");
  const buf = Buffer.from(await file.arrayBuffer());
  let sheets: ReturnType<typeof readXlsx>;
  try {
    sheets = readXlsx(buf, { sheet: (n) => /^\s*\d{4}\.\d{1,2}\s*$/.test(n) });
  } catch {
    fail(back, ".xlsx のファイルを読めませんでした。");
  }
  const hash = planHash(buf);
  const plan = planMaterialMoveImport(getDb(), sheets, { hash, fileName: file.name.slice(0, 100), now: nowIso() });
  if (!plan.sheets) fail(back, "月ごとのシート (「2026.10」のような名前) が見つかりません。");
  // 同じファイルをもう一度読んだときは前の確認の内容を置き換える (ストレージは同じキーへの上書きを断るため、先に消す)
  if (await readObject(MM_KEY(hash))) await removeObjects([MM_KEY(hash)]);
  await putObject(MM_KEY(hash), Buffer.from(JSON.stringify(plan)));
  // メッセージは「#」より前に付ける (後ろに付けるとページ内の位置の一部になって消える)
  redirect(`${withMsg(`${BASE}?tab=stock&mmplan=${hash}`, `${plan.sheets} か月分を読みました。内容を確かめてから「取り込む」を押してください。`)}#mm-import`);
}

/** 確かめた内容を取り込む (材料移動 = 原価の振替・内部受注 = 売上の調整)。すでに取り込んだ行・確定した月の行は飛ばす。管理者 */
export async function applyMaterialMoves(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=stock`, "admin");
  const hash = str(fd, "hash");
  if (!/^[0-9a-f]{32}$/.test(hash)) fail(back, "確認の内容が見つかりません。もう一度ファイルを読んでください。");
  const raw = await readObject(MM_KEY(hash));
  if (!raw) fail(back, "確認の内容が見つかりません。もう一度ファイルを読んでください。");
  const plan = JSON.parse(raw.toString("utf8")) as MoveImportPlan;
  let r = { transfers: 0, adjustments: 0, existing: 0, closed: 0 };
  await mutate((db) => {
    r = applyMaterialMoveImport(db, plan, { userId: user.id, now: nowIso(), makeId: (p) => newId(p), number: (p, list, date) => nextNumber(db, p, list, date) });
    addAudit(db, { userId: user.id, action: "import", entity: "material_transfer", entityId: hash, entityLabel: plan.fileName, summary: `材料移動の表の取込 (${plan.sheets} か月分): 材料移動 ${r.transfers} 件・売上の調整 ${r.adjustments} 件 (取込済み ${r.existing}・確定済みの月 ${r.closed} は飛ばした)` });
  });
  done(back, `取り込みました: 店舗間の材料移動 ${r.transfers} 件・店舗間の売上の調整 (過去の内部受注・本部の特殊配分) ${r.adjustments} 件${r.existing ? ` (取込済み ${r.existing} 件は飛ばしました)` : ""}${r.closed ? ` (月次確定済みの月の ${r.closed} 件は飛ばしました)` : ""}。`);
}

/* ================================================================== */
/* 共通経費の案分・月次確定                                               */
/* ================================================================== */

export async function confirmAllocationAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=alloc`, "admin");
  const month = str(fd, "month");
  if (!isMonth(month)) fail(back, "月を選んでください。");
  let manual: Record<string, number> | undefined;
  if (str(fd, "method") === "manual") {
    manual = {};
    for (const s of getDb().stores) {
      const v = str(fd, `w_${s.id}`);
      if (v) manual[s.id] = decimal(v);
    }
  }
  let msg = "";
  await mutate((db) => {
    const p = previewAllocation(db, month, { manual });
    const r = confirmAllocation(db, p, { id: newId("ar"), number: nextNumber(db, "AR", db.allocationRuns, `${month}-01`), userId: user.id, now: nowIso(), reason: str(fd, "reason"), methodReason: str(fd, "methodReason") });
    if (typeof r === "string") fail(back, r);
    msg = `${month} の共通経費の案分を確定しました (${r.number}・${r.poolTotal.toLocaleString("ja-JP")} 円)。`;
    addAudit(db, { userId: user.id, action: "approve", entity: "allocation_run", entityId: r.id, entityLabel: r.number, summary: `${msg} ${r.results.map((x) => `${storeName(db, x.storeId)} ${x.amount.toLocaleString("ja-JP")}`).join("・")}${r.correctionOf ? ` (訂正: ${r.reason})` : ""}` });
  });
  done(back, msg);
}

export async function closeMonthAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=close`, "admin");
  const month = str(fd, "month");
  if (!isMonth(month)) fail(back, "月を選んでください。");
  await mutate((db) => {
    const row = db.periodCloses.find((p) => p.month === month);
    if (row?.status === "closed") fail(back, `${month} はもう確定しています。`);
    const p = previewAllocation(db, month);
    if (p.status !== "empty" && !db.allocationRuns.some((r) => r.month === month && r.status === "confirmed")) fail(back, `${month} の共通経費の案分が確定していません${p.status === "held" ? ` (保留: ${p.holdReason})` : ""}。先に案分を確定してください。`);
    // 自動で決まる値 (自動計算の材料原価・「自動」の明細の品目) を固定してから確定する (確定後に材料マスタなどを変えても確定した月の数字が変わらない)
    const frozen = freezeMonth(db, month, { userId: user.id, now: nowIso(), makeId: () => newId("mu") });
    const [y, m] = month.split("-").map(Number);
    const res = storePnl(db, `${month}-01`, toDateKey(new Date(y, m, 0)));
    const snapshot = { at: nowIso(), basis: res.basis, stores: res.stores, total: res.total, categories: res.categories, allocations: res.allocations, provisional: res.provisional };
    const entry = { action: "close" as const, by: user.id, at: nowIso(), reason: str(fd, "reason") || undefined };
    if (row) Object.assign(row, { status: "closed", snapshot, history: [...row.history, entry], updatedAt: nowIso() });
    else db.periodCloses.push({ id: month, month, status: "closed", snapshot, history: [entry], updatedAt: nowIso() });
    addAudit(db, { userId: user.id, action: "approve", entity: "period_close", entityId: month, entityLabel: month, summary: `月次確定 (全社の管理売上 ${res.total.mgmtSales.toLocaleString("ja-JP")} 円・損益 ${res.total.profit.toLocaleString("ja-JP")} 円${res.provisional ? "・暫定を含む" : ""}${frozen.usages || frozen.lines ? ` / 固定: 自動計算の材料原価 ${frozen.orders} 件 (${frozen.usages} 行)・明細の品目 ${frozen.lines} 行` : ""})` });
  });
  done(back, `${month} を月次確定しました (確定時の店舗別損益を保存しました)。`);
}

export async function reopenMonthAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=close`, "admin");
  const month = str(fd, "month");
  const reason = str(fd, "reason").slice(0, 300);
  if (!reason) fail(back, "確定を解除する理由を入力してください。");
  await mutate((db) => {
    const row = db.periodCloses.find((p) => p.month === month);
    if (!row || row.status !== "closed") fail(back, "確定している月ではありません。");
    row.status = "open";
    row.history = [...row.history, { action: "reopen", by: user.id, at: nowIso(), reason }];
    row.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "period_close", entityId: month, entityLabel: month, summary: `月次確定を解除: ${reason}` });
  });
  done(back, `${month} の確定を解除しました (確定時の数字と解除の理由は履歴に残ります)。`);
}

/* ================================================================== */
/* 設定 (配分率・端数・未確定の扱い)・品目・営業エリア・店舗                    */
/* ================================================================== */

export async function setRuleAction(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=settings`, "admin");
  const key = str(fd, "key");
  const def = RULE_DEFS[key];
  if (!def) fail(back, "設定の項目が正しくありません。");
  let value = str(fd, "value");
  if (def.type === "bp") {
    const pct = decimal(value);
    if (!(pct >= 0)) fail(back, "率は % で入力してください (例: 20)。");
    value = String(Math.round(pct * 100));
  }
  if (def.type === "yen") value = String(yenInt(value));
  const err = validateRule(key, value);
  if (err) fail(back, err);
  const validFrom = str(fd, "validFrom");
  if (!isDate(validFrom)) fail(back, "適用開始日を入力してください。");
  const status = str(fd, "status") === "confirmed" ? "confirmed" : "provisional";
  await mutate((db) => {
    const lc = lastClosedMonth(db);
    if (lc && monthOf(validFrom) <= lc) fail(back, `${lc} まで月次確定済みです。適用開始日は確定した月より後にしてください (過去の確定した結果は変えません)。`);
    const before = ruleAt(db, key, validFrom);
    const row = setRule(db, { key, value, validFrom, status, note: str(fd, "note").slice(0, 300) || undefined }, user.id, newId("rule"), nowIso());
    addAudit(db, { userId: user.id, action: "update", entity: "mgmt_rule", entityId: row.id, entityLabel: def.label, summary: `${def.label}: ${before.value} → ${value} (${validFrom} から・${status === "confirmed" ? "確認済み" : "暫定"})` });
  });
  done(back, "設定を変更しました (前の値は履歴に残り、適用開始日より前の期間は前の値のままです)。");
}

export async function saveItemCategory(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=settings`, "admin");
  const id = str(fd, "id");
  const name = str(fd, "name").slice(0, 40);
  if (!CATEGORY_IDS.includes(id)) fail(back, "品目が正しくありません。");
  if (!name) fail(back, "名前を入力してください。");
  await mutate((db) => {
    const prev = db.itemCategories.find((c) => c.id === id);
    const row = { id, name, sort: Number(str(fd, "sort")) || CATEGORY_IDS.indexOf(id) + 1, active: str(fd, "active") !== "0", updatedAt: nowIso() };
    if (prev) Object.assign(prev, row);
    else db.itemCategories.push(row);
    addAudit(db, { userId: user.id, action: "update", entity: "item_category", entityId: id, entityLabel: name, summary: `品目 ${id} → ${name}` });
  });
  done(back, "品目を保存しました。");
}

export async function addSalesArea(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=settings`, "admin");
  const town = str(fd, "town").replace(/[\s　]/g, "").slice(0, 40);
  const storeId = storeIdOf(str(fd, "storeId"));
  const validFrom = str(fd, "validFrom") || today();
  if (!town || !storeId) fail(back, "町名と店舗を入力してください。");
  await mutate((db) => {
    // 同じ町名の有効な行は前日で閉じる (担当の変更の履歴)
    for (const a of db.salesAreas) if (a.town === town && (!a.validTo || a.validTo >= validFrom)) a.validTo = new Date(Date.parse(`${validFrom}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    db.salesAreas.push({ id: newId("sa"), municipality: str(fd, "municipality").slice(0, 40), town, storeId, validFrom, source: "manual", note: str(fd, "note") || undefined, createdBy: user.id, createdAt: nowIso() });
    addAudit(db, { userId: user.id, action: "update", entity: "sales_area", entityId: town, entityLabel: town, summary: `営業エリア ${town} → ${storeName(db, storeId)} (${validFrom} から)` });
  });
  done(back, `営業エリア「${town}」を保存しました。`);
}

export async function closeSalesArea(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=settings`, "admin");
  await mutate((db) => {
    const a = db.salesAreas.find((x) => x.id === str(fd, "id"));
    if (!a) fail(back, "営業エリアが見つかりません。");
    a.validTo = new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    addAudit(db, { userId: user.id, action: "update", entity: "sales_area", entityId: a.id, entityLabel: a.town, summary: `営業エリア ${a.town} の担当を終了 (${a.validTo} まで)` });
  });
  done(back, "営業エリアを終了しました (履歴は残ります)。");
}

/** 予定表スプレッドシートの「地域一覧」(.xlsx) を取り込む */
export async function importSalesAreas(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=settings`, "admin");
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "地域一覧のある .xlsx を選んでください。");
  if (file.size > 30 * 1024 * 1024) fail(back, "ファイルが大きすぎます (30MB まで)。");
  const validFrom = str(fd, "validFrom") || today();
  if (!isDate(validFrom)) fail(back, "適用開始日を入力してください。");
  let parsed: ReturnType<typeof areaRowsFromXlsx>;
  try {
    parsed = areaRowsFromXlsx(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    fail(back, `読み取れませんでした: ${(e as Error).message}`);
  }
  if (!parsed) fail(back, "「地域一覧」のシートが見つかりません。");
  const plan = planAreaImport(getDb(), parsed.rows);
  if (!plan.rows.length) fail(back, "取り込める行がありません。");
  let n = 0;
  await mutate((db) => {
    n = applyAreaImport(db, plan, validFrom, user.id, nowIso(), () => newId("sa"), file.name.slice(0, 80));
    addAudit(db, { userId: user.id, action: "import", entity: "sales_area", entityId: "import", entityLabel: file.name.slice(0, 80), summary: `地域一覧の取込: ${n} 件 (${Object.entries(plan.byStore).map(([s, c]) => `${storeName(db, s)} ${c}`).join("・")})${plan.problems.length ? ` / 確認: ${plan.problems.slice(0, 5).join(" / ")}` : ""}` });
  });
  done(back, `地域一覧を ${n} 件取り込みました (${validFrom} から)。${plan.problems.length ? ` 確認: ${plan.problems.slice(0, 4).join(" / ")}` : ""}`);
}

/** 店舗 (管理部門) の名前・開設日・閉鎖日・統合先 */
export async function saveStoreUnit(fd: FormData) {
  const { user, back } = await start(fd, `${BASE}?tab=settings`, "admin");
  const id = storeIdOf(str(fd, "id"));
  if (!id) fail(back, "店舗が見つかりません。");
  const name = str(fd, "name").slice(0, 40);
  const shortName = str(fd, "shortName").slice(0, 10);
  if (!name || !shortName) fail(back, "名前と略称を入力してください。");
  const openedOn = str(fd, "openedOn");
  const closedOn = str(fd, "closedOn");
  if ((openedOn && !isDate(openedOn)) || (closedOn && !isDate(closedOn))) fail(back, "日付を確かめてください。");
  const mergedInto = str(fd, "mergedInto") ? storeIdOf(str(fd, "mergedInto")) : undefined;
  await mutate((db) => {
    const s = db.stores.find((x) => x.id === id)!;
    const before = `${s.name}/${s.shortName}/${s.openedOn ?? ""}/${s.closedOn ?? ""}/${s.mergedInto ?? ""}`;
    Object.assign(s, { name, shortName, openedOn: openedOn || undefined, closedOn: closedOn || undefined, mergedInto });
    addAudit(db, { userId: user.id, action: "update", entity: "store", entityId: s.id, entityLabel: name, summary: `管理部門: ${before} → ${name}/${shortName}/${openedOn}/${closedOn}/${mergedInto ?? ""}`, storeId: s.id });
  });
  done(back, "店舗を保存しました。");
}

/** 損益の閲覧範囲の確認 (ページから呼ぶ) */
export async function assertMgmtStore(user: User, storeId: string, back: string) {
  if (!canViewMgmtStore(user, storeId)) fail(back, "この店舗の管理会計は見られません。");
}
