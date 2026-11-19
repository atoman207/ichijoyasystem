import type { CostType, Database, Material, Order, PurchaseInvoice, PurchaseLineAlloc, PurchaseSplit, StoreId } from "@/lib/db/types";
import type { LineItem } from "@/lib/ai/ocr";
import { apportion, round4, dec4, divRound, fmtDec4 } from "./decimal";
import { storeIdOfName } from "./areas";
import { mainCategory, orderCategorySales } from "./categories";
import { storeLoc } from "./stock";

/**
 * 仕入請求書の明細の振り分け (店舗・案件・品目・費用区分)
 * ------------------------------------------------------------
 * - 明細ごとに 3 つを別々に持つ: ocr (読み取った内容の写し) / ai (自動の判定: 推定・理由・参照・信頼度・要確認) / splits (担当者が確定した振り分け)
 * - 自動の判定は、請求書の店舗名・現場名・品番と、材料マスタ・案件 (施工内容・品目)・発注書・仕入先・過去に確定した振り分けを照らし合わせる。
 *   AI の推測で会計のデータは変えない: 判定は候補で、確定は担当者が行う。根拠が足りない・候補が複数・金額が合わない明細は「要確認」
 * - 同じ品番でも使い道で品目が変わる (例: クロス紙を壁紙の張替に使えばリフォーム材料費、襖の張替に使えば襖材料費): 品番だけで品目を決めず、
 *   ひも付いた案件の品目で決める。案件が決まらなければ要確認
 * - 振り分けの合計は明細の金額 (税抜) と一致させる (validateSplits)
 */

export const COST_TYPE_LABEL: Record<CostType, string> = {
  material: "材料費",
  outsource: "外注費",
  inventory: "在庫 (受入。使ったときに原価)",
  store_expense: "店舗独自経費",
  common_expense: "共通経費 (案分)",
  other: "その他",
};

export const allocId = (purchaseId: string, itemId: string) => `pla_${purchaseId}_${itemId}`;

/** 使い道で品目が変わる材料 (クロス・襖紙など): 案件の品目で決める */
const PURPOSE_DEPENDENT: Material["kind"][] = ["cloth", "paper"];
/** 本部で一括仕入して在庫にする材料 */
const STOCKED: Material["kind"][] = ["omote", "chem_omote", "heri", "doko"];

const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "").toLowerCase();

/** 明細の税抜の金額 (請求書の消費税額を明細の金額の割合で配る。合計は 請求額 − 消費税 と一致) */
export function linesExTax(p: Pick<PurchaseInvoice, "amount" | "taxAmount" | "items">): { itemId: string; amount: number; exTax: number }[] {
  const items = p.items?.length ? p.items : [{ id: "all", amount: p.amount }];
  const amounts = items.map((i) => Math.round(i.amount));
  const positive = amounts.map((a) => Math.max(0, a));
  const tax = Math.round(p.taxAmount || 0);
  const taxes = tax && positive.some((a) => a > 0) ? apportion(tax, positive) : amounts.map(() => 0);
  return items.map((i, k) => ({ itemId: i.id, amount: amounts[k], exTax: amounts[k] - taxes[k] }));
}

export interface Classification {
  storeId?: StoreId;
  orderId?: string;
  itemCategory?: string;
  costType?: CostType;
  materialId?: string;
  reason: string;
  refs: string[];
  confidence: number;
  needsReview: boolean;
  candidates: { orderId: string; label: string; score: number }[];
}

interface Ctx {
  db: Database;
  purchase: PurchaseInvoice;
  orders: Order[];
  history: PurchaseLineAlloc[];
}

function orderLabel(db: Database, o: Order): string {
  const c = db.customers.find((x) => x.id === o.customerId);
  return `${o.number} ${c?.name ?? ""} ${o.title}`.trim();
}

/** 1 明細の自動判定 (規則による。理由と参照した情報を残す) */
export function classifyLine(ctx: Ctx, line: PurchaseLineAlloc["ocr"]): Classification {
  const { db, purchase } = ctx;
  const reasons: string[] = [];
  const refs: string[] = [];
  const review: string[] = [];
  let conf = 0;
  const name = norm(`${line.name} ${line.spec ?? ""}`);
  const code = norm(line.code);
  const supplier = db.suppliers.find((s) => s.id === purchase.supplierId);

  // 1) 材料: 品番 (仕入先の品番) → 品名
  let material: Material | undefined;
  if (code) material = db.materials.find((m) => m.active && norm(m.supplierCode) === code);
  if (material) {
    reasons.push(`品番 ${line.code} が材料「${material.name}」の仕入先の品番と一致`);
    refs.push(`material:${material.id}`);
    conf += 25;
  } else {
    material = db.materials.filter((m) => m.active && name.includes(norm(m.name)) && norm(m.name).length >= 2).sort((a, b) => b.name.length - a.name.length)[0];
    if (material) {
      reasons.push(`品名が材料「${material.name}」を含む`);
      refs.push(`material:${material.id}`);
      conf += 15;
    }
  }

  // 2) 案件: 請求書・発注書のひも付け → 現場名 (お客様名・施工場所・件名)
  const scores = new Map<string, { score: number; why: string[] }>();
  const bump = (id: string, v: number, why: string) => {
    const cur = scores.get(id) ?? scores.set(id, { score: 0, why: [] }).get(id)!;
    cur.score += v;
    cur.why.push(why);
  };
  if (purchase.orderId) bump(purchase.orderId, 60, "仕入の登録で案件が指定されている");
  for (const po of db.purchaseOrders ?? []) {
    if (po.supplierId !== purchase.supplierId) continue;
    for (const l of po.lines ?? []) {
      if (!l.orderId) continue;
      const ln = norm(`${l.name ?? ""}`);
      if (code && norm(l.code) === code) bump(l.orderId, 45, `発注書 ${po.number} の同じ品番 (${line.code}) の行の案件`);
      else if (ln && (name.includes(ln) || ln.includes(norm(line.name)))) bump(l.orderId, 40, `発注書 ${po.number} の同じ品名の行の案件`);
    }
  }
  const site = norm(line.siteText);
  if (site.length >= 2) {
    for (const o of ctx.orders) {
      const c = db.customers.find((x) => x.id === o.customerId);
      const cname = norm(c?.name).replace(/様$/, "");
      if (cname && (site.includes(cname) || (cname.length >= 2 && cname.includes(site)))) bump(o.id, 45, `現場名「${line.siteText}」がお客様名と一致`);
      else if (norm(c?.name).split(/[\s　]/)[0] && site.includes(norm((c?.name ?? "").split(/[\s　]/)[0])) && norm((c?.name ?? "").split(/[\s　]/)[0]).length >= 2) bump(o.id, 25, `現場名「${line.siteText}」がお客様の名字と一致`);
      if (o.siteAddress && norm(o.siteAddress).includes(site)) bump(o.id, 20, `現場名が施工場所に含まれる`);
    }
  }
  const candidates = [...scores.entries()]
    .map(([orderId, v]) => ({ orderId, label: db.orders.find((o) => o.id === orderId) ? orderLabel(db, db.orders.find((o) => o.id === orderId)!) : orderId, score: Math.min(100, v.score), why: v.why }))
    .sort((a, b) => b.score - a.score);
  let order: Order | undefined;
  if (candidates.length) {
    const [top, second] = candidates;
    if (top.score >= 40 && (!second || top.score - second.score >= 20)) {
      order = db.orders.find((o) => o.id === top.orderId);
      reasons.push(`案件 ${top.label}: ${top.why.join("・")}`);
      refs.push(`order:${top.orderId}`);
      conf += 30;
    } else review.push(`案件の候補が複数あります (${candidates.slice(0, 3).map((c) => c.label).join(" / ")})`);
  }

  // 3) 店舗: 明細の店舗名 → 案件の店舗 → 発注書の店舗 → 仕入の店舗 (本部以外)
  let storeId: StoreId | undefined;
  const fromText = line.storeText ? storeIdOfName(db, line.storeText) : undefined;
  if (fromText) {
    storeId = fromText;
    reasons.push(`明細の店舗名「${line.storeText}」`);
    conf += 20;
    if (order && order.storeId !== fromText) review.push(`明細の店舗名 (${line.storeText}) と案件の店舗が違います`);
  } else if (order) {
    storeId = order.storeId;
    reasons.push("案件の店舗 (売上帰属店舗)");
    conf += 15;
  } else if (purchase.storeId !== "hq") {
    storeId = purchase.storeId;
    reasons.push("仕入の登録の店舗");
    conf += 10;
  }

  // 4) 過去に確定した振り分け (同じ仕入先・同じ品番か品名)
  const past = ctx.history.filter((h) => h.status === "confirmed" && h.splits.length === 1 && (code ? norm(h.ocr.code) === code : norm(h.ocr.name) === norm(line.name)));
  const pastType = past.length ? mode(past.map((h) => h.splits[0].costType)) : undefined;
  const pastCat = past.length ? mode(past.map((h) => h.splits[0].itemCategory)) : undefined;

  // 5) 品目: 使い道で変わる材料は案件の品目、それ以外は材料の品目 → 過去の振り分け → 案件の品目
  let itemCategory: string | undefined;
  const orderMain = order ? mainCategory(orderCategorySales(db, order, undefined, order.salesDate ?? order.contractDate), "other") : undefined;
  if (material && PURPOSE_DEPENDENT.includes(material.kind)) {
    if (orderMain) {
      itemCategory = orderMain === "fusuma" || orderMain === "reform" ? orderMain : undefined;
      if (itemCategory) reasons.push(`「${material.name}」は使い道で品目が変わるため、案件の施工内容 (${orderMain === "fusuma" ? "襖" : "リフォーム"}) で判定`);
      else review.push(`「${material.name}」の使い道 (襖・リフォーム) が案件から判断できません`);
    } else review.push(`「${material.name}」は使い道 (襖の張替か壁紙の張替か) で品目が変わるため、案件が必要です`);
  } else if (material) {
    itemCategory = material.itemCategory;
    reasons.push(`材料の品目`);
  } else if (pastCat) {
    itemCategory = pastCat;
    reasons.push(`過去に確定した同じ明細の品目 (${past.length} 件)`);
    conf += 10;
  } else if (orderMain) {
    itemCategory = orderMain;
    reasons.push("案件の主な品目");
  }

  // 6) 費用区分
  let costType: CostType | undefined;
  if (supplier?.kind === "partner" || /外注/.test(purchase.account ?? "")) {
    costType = "outsource";
    reasons.push(supplier?.kind === "partner" ? "協力業者 (外注)" : "勘定科目が外注費");
  } else if (material && STOCKED.includes(material.kind) && !order && (storeId ?? purchase.storeId) === "hq") {
    costType = "inventory";
    reasons.push("本部の一括仕入の材料 (在庫に受け入れ、使ったときに原価)");
  } else if (material || order) {
    costType = "material";
  } else if (pastType) {
    costType = pastType;
    reasons.push(`過去に確定した同じ明細の費用区分 (${past.length} 件)`);
  }
  if (pastType && costType && pastType !== costType) review.push(`過去の振り分け (${COST_TYPE_LABEL[pastType]}) と今回の判定 (${COST_TYPE_LABEL[costType]}) が違います`);

  // 7) 金額の照合
  if (line.qty !== undefined && line.unitPrice !== undefined) {
    const calc = Math.round(Number(fmtDec4(divRound(dec4(line.qty) * dec4(line.unitPrice), BigInt(10000), "round"))));
    if (Math.abs(calc - line.amount) > 1) review.push(`数量 × 単価 (${calc.toLocaleString("ja-JP")} 円) と金額 (${line.amount.toLocaleString("ja-JP")} 円) が合いません`);
  }
  if (!storeId) review.push("店舗が判定できません");
  if (!itemCategory) review.push("品目が判定できません");
  if (!costType) review.push("費用区分が判定できません");
  if (!order && costType === "material") review.push("材料費ですが案件が決まっていません (店舗の材料費として計上するか確認してください)");
  const confidence = Math.max(0, Math.min(100, conf + (review.length ? 0 : 20)));
  const needsReview = review.length > 0 || confidence < 50;
  return {
    storeId,
    orderId: order?.id,
    itemCategory,
    costType,
    materialId: material?.id,
    reason: [...reasons, ...review.map((r) => `要確認: ${r}`)].join(" / ") || "手がかりがありません",
    refs,
    confidence,
    needsReview,
    candidates: candidates.slice(0, 5).map(({ orderId, label, score }) => ({ orderId, label, score })),
  };
}

function mode<T extends string>(xs: T[]): T | undefined {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** 仕入の明細 (と読み取りの結果) から、明細ごとの振り分けの行を作る・判定し直す (確定した行はそのまま) */
export function buildLineAllocs(db: Database, purchase: PurchaseInvoice, now: string): PurchaseLineAlloc[] {
  const doc = purchase.documentId ? db.documents.find((d) => d.id === purchase.documentId) : undefined;
  const ocrItems = ((doc?.extracted?.items as LineItem[] | undefined) ?? []).filter((i) => i && typeof i.name === "string");
  const ex = linesExTax(purchase);
  const items = purchase.items?.length ? purchase.items : [{ id: "all", name: purchase.description || "請求の合計", qty: 1, unit: "式", unitPrice: purchase.amount, amount: purchase.amount }];
  const from = shiftDate(purchase.invoiceDate, -120);
  const orders = db.orders.filter((o) => o.status !== "cancelled" && (o.salesDate ?? o.contractDate) >= from && o.contractDate <= shiftDate(purchase.invoiceDate, 30));
  const history = (db.purchaseLineAllocs ?? []).filter((h) => h.purchaseId !== purchase.id && db.purchases.find((p) => p.id === h.purchaseId)?.supplierId === purchase.supplierId);
  // 読み取りの明細との対応: 行数が同じなら同じ順番、違えば同じ品名の未使用の行
  const usedOcr = new Set<number>();
  const ocrFor = (name: string, k: number): LineItem | undefined => {
    if (ocrItems.length === items.length) return ocrItems[k];
    const i = ocrItems.findIndex((x, n) => !usedOcr.has(n) && norm(x.name) === norm(name));
    if (i < 0) return undefined;
    usedOcr.add(i);
    return ocrItems[i];
  };
  return items.map((it, k) => {
    const id = allocId(purchase.id, it.id);
    const prev = db.purchaseLineAllocs?.find((a) => a.id === id);
    const o = ocrFor(it.name, k);
    const ocr: PurchaseLineAlloc["ocr"] = {
      name: it.name,
      code: o?.code,
      spec: it.spec,
      qty: it.qty,
      unit: it.unit,
      unitPrice: it.unitPrice,
      amount: ex[k].amount,
      amountExTax: ex[k].exTax,
      storeText: o?.storeName,
      siteText: o?.siteName,
      note: o?.lineNote,
    };
    if (prev?.status === "confirmed") return { ...prev, ocr: prev.ocr };
    const c = classifyLine({ db, purchase, orders, history }, ocr);
    const ai: PurchaseLineAlloc["ai"] = { storeId: c.storeId, orderId: c.orderId, itemCategory: c.itemCategory, costType: c.costType, materialId: c.materialId, reason: c.reason, refs: c.refs, confidence: c.confidence, needsReview: c.needsReview, candidates: c.candidates, method: "rules", at: now };
    const splits: PurchaseSplit[] = c.storeId && c.itemCategory && c.costType ? [{ storeId: c.storeId, orderId: c.orderId, itemCategory: c.itemCategory, costType: c.costType, materialId: c.materialId, qty: c.materialId ? it.qty : undefined, amount: ocr.amountExTax }] : [];
    return { id, purchaseId: purchase.id, itemId: it.id, lineNo: k + 1, ocr, ai, splits: prev?.splits?.length ? prev.splits : splits, status: c.needsReview || !splits.length ? "needs_review" : "unassigned", updatedAt: now };
  });
}

function shiftDate(d: string, days: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 振り分けを確かめる (誤りなら理由): 合計が明細の税抜の金額と一致・必須の項目・在庫は材料と数量 */
export function validateSplits(alloc: Pick<PurchaseLineAlloc, "ocr">, splits: PurchaseSplit[], db: Pick<Database, "stores" | "materials" | "orders">): string | null {
  if (!splits.length) return "振り分け先を 1 つ以上入力してください。";
  for (const [i, s] of splits.entries()) {
    const n = `${i + 1} 行目`;
    if (!db.stores.some((x) => x.id === s.storeId)) return `${n}: 店舗を選んでください。`;
    if (!s.itemCategory) return `${n}: 品目を選んでください。`;
    if (!COST_TYPE_LABEL[s.costType]) return `${n}: 費用区分を選んでください。`;
    if (!Number.isSafeInteger(s.amount)) return `${n}: 金額は円の整数で入力してください。`;
    if (s.orderId && !db.orders.some((o) => o.id === s.orderId)) return `${n}: 案件が見つかりません。`;
    if (s.costType === "inventory" && (!s.materialId || !(Number(s.qty) > 0))) return `${n}: 在庫にするときは材料と数量を入力してください。`;
    if (s.materialId && !db.materials.some((m) => m.id === s.materialId)) return `${n}: 材料が見つかりません。`;
  }
  const sum = splits.reduce((a, s) => a + s.amount, 0);
  if (sum !== alloc.ocr.amountExTax) return `振り分けの合計 (${sum.toLocaleString("ja-JP")} 円) が明細の税抜の金額 (${alloc.ocr.amountExTax.toLocaleString("ja-JP")} 円) と一致しません。`;
  return null;
}

/** 金額を複数の振り分け先へ割合で分ける (合計は一致) */
export function splitEvenly(amount: number, weights: number[]): number[] {
  return apportion(amount, weights.map((w) => Math.max(0, Math.round(w))));
}

/** 在庫の受入の単価 (金額 ÷ 数量。小数 4 桁) */
export function receiveUnitCost(amount: number, qty: number): number {
  return round4(Number(fmtDec4(divRound(BigInt(amount) * BigInt(100000000), dec4(qty), "round"))));
}

export const receiveLoc = (storeId: StoreId) => storeLoc(storeId);

/** 振り分けの行を保存する (ID で置き換え。同じ請求書を読み直しても行は増えない) */
export function upsertLineAllocs(db: Database, rows: PurchaseLineAlloc[]): void {
  for (const r of rows) {
    const i = db.purchaseLineAllocs.findIndex((a) => a.id === r.id);
    if (i >= 0) db.purchaseLineAllocs[i] = r;
    else db.purchaseLineAllocs.push(r);
  }
}

const sameSplits = (a: PurchaseSplit[], b: PurchaseSplit[]) => JSON.stringify(a.map((s) => [s.storeId, s.orderId ?? "", s.itemCategory, s.costType, s.materialId ?? "", s.qty ?? "", s.amount])) === JSON.stringify(b.map((s) => [s.storeId, s.orderId ?? "", s.itemCategory, s.costType, s.materialId ?? "", s.qty ?? "", s.amount]));

/**
 * 明細の振り分けを確定する (mutate の中で呼ぶ)。誤りなら理由を返す。
 * - 在庫 (inventory) の振り分けは、在庫の受入 (仕入先 → 店舗) を登録する。同じ内容で確定し直しても受入は増えない。
 *   内容を変えたときは前の受入を取り消して (逆の移動) 入れ直す
 */
export function confirmLineAlloc(
  db: Database,
  alloc: PurchaseLineAlloc,
  splits: PurchaseSplit[],
  input: { userId: string; now: string; today: string; reason?: string; makeMove: () => { id: string; number: string }; closed: (date: string) => string | null },
): string | null {
  const err = validateSplits(alloc, splits, db);
  if (err) return err;
  const purchase = db.purchases.find((p) => p.id === alloc.purchaseId);
  if (!purchase) return "仕入が見つかりません。";
  const closed = input.closed(purchase.invoiceDate);
  if (closed) return closed;
  if (alloc.status === "confirmed" && sameSplits(alloc.splits, splits)) return null;
  // 前の受入を取り消す
  for (const m of db.stockMoves.filter((x) => x.purchaseId === alloc.purchaseId && x.purchaseItemId === alloc.itemId && x.kind === "receive" && x.status === "confirmed" && !x.reversalOf)) {
    const ids = input.makeMove();
    const rev = reverseMoveInline(db, m, { ...ids, userId: input.userId, now: input.now, date: purchase.invoiceDate, reason: "仕入明細の振り分けの訂正" });
    if (typeof rev === "string") return rev;
  }
  for (const s of splits.filter((x) => x.costType === "inventory")) {
    const ids = input.makeMove();
    db.stockMoves.push({
      id: ids.id,
      number: ids.number,
      date: purchase.invoiceDate,
      kind: "receive",
      materialId: s.materialId!,
      qty: round4(Number(s.qty)),
      unitCost: receiveUnitCost(s.amount, Number(s.qty)),
      amount: s.amount,
      fromLoc: "supplier",
      toLoc: storeLoc(s.storeId),
      storeId: s.storeId,
      purchaseId: alloc.purchaseId,
      purchaseItemId: alloc.itemId,
      status: "confirmed",
      note: `仕入 ${purchase.number} ${alloc.lineNo} 行目`,
      createdBy: input.userId,
      createdAt: input.now,
      approvedBy: input.userId,
      approvedAt: input.now,
    });
  }
  alloc.splits = splits;
  alloc.status = "confirmed";
  alloc.reason = input.reason?.trim() || alloc.reason;
  alloc.confirmedBy = input.userId;
  alloc.confirmedAt = input.now;
  alloc.updatedAt = input.now;
  return null;
}

/** 受入の取消し (金額は元の行のまま。逆向きの移動) */
function reverseMoveInline(db: Database, m: Database["stockMoves"][number], input: { id: string; number: string; userId: string; now: string; date: string; reason: string }): string | null {
  if (m.status !== "confirmed" || m.reversalOf) return "取り消せない移動です。";
  db.stockMoves.push({ ...m, id: input.id, number: input.number, date: input.date, fromLoc: m.toLoc, toLoc: m.fromLoc, reversalOf: m.id, reversedBy: undefined, note: `取消し: ${input.reason}`, createdBy: input.userId, createdAt: input.now });
  m.status = "reversed";
  m.reversedBy = input.id;
  return null;
}

/** 同じ仕入先・同じ請求書番号の仕入 (二重登録の確認。却下したものは除く) */
export function duplicatePurchase(db: Pick<Database, "purchases">, supplierId: string, supplierInvoiceNo: string | undefined, exceptId?: string): PurchaseInvoice | undefined {
  const no = norm(supplierInvoiceNo);
  if (!no) return undefined;
  return db.purchases.find((p) => p.id !== exceptId && p.supplierId === supplierId && p.status !== "rejected" && norm(p.supplierInvoiceNo) === no);
}
