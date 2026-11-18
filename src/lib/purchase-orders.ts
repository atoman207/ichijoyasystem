import "server-only";
import type { Customer, Database, FaxMessage, Order, PurchaseOrder, PurchaseOrderLine, PurchaseOrderStatus, StoreId, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { pdfCompany } from "@/lib/pdf/data";
import type { PurchaseOrderPdfData } from "@/lib/pdf/types";
import { fmtFax, normFax, normRef } from "@/lib/fax/numbers";
import { faxLocalNumber } from "@/lib/fax/adapter";

/**
 * 発注書 (仕入先への発注)
 * ------------------------------------------------------------
 * 1 枚の発注書 = 1 つの仕入先。明細ごとに案件 (受注) を持ち、1 枚に別の案件の明細を混ぜられる (同じ仕入先へまとめて発注)。
 * 明細の案件番号・発注番号は発注書に印字し、仕入先からの返信 FAX の照合に使う (src/lib/fax/inbound.ts)。
 * お客様の氏名・電話番号は showCustomer のときだけ発注書に載せる (既定は案件番号と件名・現場の地区だけ)
 */

export const PO_EDITABLE: PurchaseOrderStatus[] = ["draft", "issued", "sent"];
/** 返信 FAX のひも付け候補にする (送ったあと・完了の前) */
export const PO_OPEN: PurchaseOrderStatus[] = ["issued", "sent"];

export const MAX_PO_LINES = 60;

/** 明細の案件 (受注) の ID (重複なし・明細の順) */
export function lineOrderIds(lines: PurchaseOrderLine[]): string[] {
  return [...new Set(lines.map((l) => l.orderId).filter((x): x is string => Boolean(x)))];
}

/** 納品先の既定 (発注元の店舗) */
export function defaultDelivery(db: Database, storeId: StoreId): { place: string; address: string } {
  const s = db.stores.find((x) => x.id === storeId);
  return { place: s?.name ?? "", address: s ? [s.postalCode && `〒${s.postalCode}`, s.address].filter(Boolean).join(" ") : "" };
}

/** 案件の地区 (住所の市区町村まで。番地より後ろは載せない) */
function areaOf(address: string | undefined): string {
  const a = (address ?? "").normalize("NFKC").trim();
  const m = a.match(/^(.*?[都道府県])?(.*?[市郡区])(.*?[町村区])?/);
  return m ? `${m[1] ?? ""}${m[2] ?? ""}${m[3] ?? ""}` : "";
}

/** お客様の名字 (個人は空白の前まで。法人・空白のない名前はそのまま) */
function familyName(c: Customer): string {
  const name = c.name.normalize("NFKC").trim();
  if (c.type === "corporate") return name;
  return name.split(/\s+/)[0] || name;
}

/**
 * 発注書の現場名 (手書きの発注書の「現場名」と同じく「名字 様」)。
 * showCustomer のときは氏名・現場の住所・電話 (現場直送で仕入先が直接連絡するときなど)。お客様のない案件は件名と地区
 */
export function siteLabel(db: Database, o: Order, showCustomer: boolean): string {
  const c = db.customers.find((x) => x.id === o.customerId);
  if (!c) return [o.title, areaOf(o.siteAddress)].filter(Boolean).join("　");
  if (showCustomer) return [`${c.name} 様`, o.siteAddress || c.address, c.phone && `TEL ${c.phone}`].filter(Boolean).join("　");
  return `${familyName(c)} 様`;
}

/** 送信先の FAX 番号 (発注書の指定 → 仕入先の FAX) */
export function poFaxTo(db: Database, po: Pick<PurchaseOrder, "faxTo" | "supplierId">): string {
  return normFax(po.faxTo) || normFax(db.suppliers.find((s) => s.id === po.supplierId)?.fax);
}

export function poAmount(po: Pick<PurchaseOrder, "lines">): number | undefined {
  const priced = po.lines.filter((l) => typeof l.unitPrice === "number");
  return priced.length ? priced.reduce((a, l) => a + Math.round((l.unitPrice ?? 0) * l.qty), 0) : undefined;
}

/** 発注書 PDF のデータ (手書きの発注書の様式) */
export function purchaseOrderPdfData(db: Database, po: PurchaseOrder): PurchaseOrderPdfData {
  const supplier = db.suppliers.find((s) => s.id === po.supplierId);
  const store = db.stores.find((s) => s.id === po.storeId);
  const staff = db.users.find((u) => u.id === po.createdBy);
  const company = pdfCompany(db, po.storeId);
  const orders = new Map(db.orders.filter((o) => po.orderIds.includes(o.id)).map((o) => [o.id, o]));
  return {
    number: po.number,
    version: po.version,
    revisionLabel: po.version > 1 ? `第${po.version}版 (訂正)` : undefined,
    issuedOn: po.issuedOn,
    companyName: company.name,
    storeName: store?.name ?? "",
    staffName: staff?.name,
    storeAddress: store ? [store.postalCode && `〒${store.postalCode}`, store.address].filter(Boolean).join(" ") : company.address,
    storeTel: store?.phone || company.tel,
    // 返信先は会社の FAX (全社で 1 つ。FAX_NUMBER)。未設定なら帳票の設定の FAX
    replyFax: faxLocalNumber() || company.fax,
    supplierName: supplier?.name ?? "(仕入先なし)",
    supplierFax: fmtFax(poFaxTo(db, po)) || undefined,
    supplierContact: supplier?.contactName,
    deliveryPlace: po.deliveryPlace,
    deliveryAddress: po.deliveryAddress,
    lines: po.lines.map((l) => {
      const o = l.orderId ? orders.get(l.orderId) : undefined;
      return {
        name: l.name,
        code: l.code,
        spec: l.spec,
        qty: l.qty,
        unit: l.unit,
        site: o ? siteLabel(db, o, Boolean(po.showCustomer)) : undefined,
        orderNumber: o?.number ?? l.orderNumber,
        arrival: l.dueDate || po.desiredDate,
        notes: l.notes,
        unitPrice: l.unitPrice,
      };
    }),
    notes: po.notes,
    draft: po.status === "draft",
    cancelled: po.status === "cancelled",
  };
}

export function poFileName(po: Pick<PurchaseOrder, "number" | "version">): string {
  return `発注書_${po.number}${po.version > 1 ? `_第${po.version}版` : ""}.pdf`;
}

/* ================================================================== */
/* 明細の受け取り (画面の JSON → 検証)                                     */
/* ================================================================== */

const s = (v: unknown, max: number) => String(v ?? "").normalize("NFKC").trim().slice(0, max);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * 画面から届いた明細を検証する。案件は閲覧できる受注だけ (改ざんされた ID は断る)。
 * 戻り値: 明細、または利用者向けのエラー
 */
export function parseLines(db: Database, user: User, raw: string, newId: (p: string) => string): { lines: PurchaseOrderLine[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw || "[]");
  } catch {
    return { error: "明細を読み取れませんでした。画面を開き直してください。" };
  }
  if (!Array.isArray(data)) return { error: "明細を読み取れませんでした。" };
  const rows = (data as Record<string, unknown>[]).filter((r) => r && typeof r === "object" && s(r.name, 120));
  if (!rows.length) return { error: "明細を 1 行以上入力してください (商品名が空の行は登録しません)。" };
  if (rows.length > MAX_PO_LINES) return { error: `明細は ${MAX_PO_LINES} 行までです。発注書を分けてください。` };
  const lines: PurchaseOrderLine[] = [];
  for (const [i, r] of rows.entries()) {
    const qty = Number(String(r.qty ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) return { error: `${i + 1} 行目: 数量は 0 より大きい数で入力してください。` };
    const unit = s(r.unit, 10) || "式";
    const due = s(r.dueDate, 10);
    if (due && !isDate(due)) return { error: `${i + 1} 行目: 希望納期の日付が正しくありません。` };
    const priceRaw = String(r.unitPrice ?? "").replace(/[,¥\s]/g, "");
    const unitPrice = priceRaw === "" ? undefined : Number(priceRaw);
    if (unitPrice !== undefined && (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100_000_000)) return { error: `${i + 1} 行目: 単価は 0 円以上の数で入力してください。` };
    const orderId = s(r.orderId, 60);
    let orderNumber: string | undefined;
    if (orderId) {
      const o = db.orders.find((x) => x.id === orderId);
      if (!o || !canAccessStore(user, o.storeId)) return { error: `${i + 1} 行目: 案件が見つからないか、扱う権限がありません。` };
      orderNumber = o.number;
    }
    const productId = s(r.productId, 60);
    lines.push({
      id: s(r.id, 60) || newId("pol"),
      orderId: orderId || undefined,
      orderNumber,
      productId: productId && db.products.some((p) => p.id === productId) ? productId : undefined,
      name: s(r.name, 120),
      code: s(r.code, 60) || undefined,
      spec: s(r.spec, 200) || undefined,
      qty: Math.round(qty * 1000) / 1000,
      unit,
      dueDate: due || undefined,
      notes: s(r.notes, 200) || undefined,
      unitPrice: unitPrice === undefined ? undefined : Math.round(unitPrice),
    });
  }
  return { lines };
}

/* ================================================================== */
/* 返信 FAX の照合の候補                                                   */
/* ================================================================== */

export interface FaxCandidate {
  po: PurchaseOrder;
  /** 候補にした理由 (発注番号の一致・案件番号の一致・送信元の仕入先の未完了の発注) */
  reason: string;
  /** 一致の強さ (並び順) */
  score: number;
}

/** 受信 FAX をひも付ける発注書の候補 (担当者が選ぶ)。読み取った番号の一致 → 送信元の仕入先の未完了の発注 の順 */
export function faxCandidates(db: Database, f: FaxMessage, user: User): { pos: FaxCandidate[]; orders: Order[] } {
  const po = new Map<string, FaxCandidate>();
  const add = (p: PurchaseOrder, reason: string, score: number) => {
    if (p.status === "cancelled" || !canAccessStore(user, p.storeId)) return;
    const cur = po.get(p.id);
    if (!cur || cur.score < score) po.set(p.id, { po: p, reason, score });
  };
  const poNumbers = new Set((f.ai?.poNumbers ?? []).map(normRef));
  const orderNumbers = new Set((f.ai?.orderNumbers ?? []).map(normRef));
  for (const p of db.purchaseOrders) {
    if (poNumbers.has(p.number)) add(p, "発注番号が一致", 3);
  }
  const orders = db.orders.filter((o) => orderNumbers.has(normRef(o.number)) && canAccessStore(user, o.storeId));
  const orderIds = new Set(orders.map((o) => o.id));
  for (const p of db.purchaseOrders) {
    if (p.orderIds.some((id) => orderIds.has(id))) add(p, "案件番号が一致", 2);
  }
  if (f.supplierId) {
    db.purchaseOrders
      .filter((p) => p.supplierId === f.supplierId && PO_OPEN.includes(p.status))
      .sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt))
      .slice(0, 15)
      .forEach((p) => add(p, "送信元の仕入先の未完了の発注", 1));
  }
  const pos = [...po.values()].sort((a, b) => b.score - a.score || (b.po.sentAt ?? b.po.updatedAt).localeCompare(a.po.sentAt ?? a.po.updatedAt));
  return { pos, orders };
}
