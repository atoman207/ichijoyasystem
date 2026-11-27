import type { Attachment, Database, Order, Quote } from "@/lib/db/types";
import { MATERIAL_STATUS, needDate, type MaterialRow } from "@/lib/material-orders/plan";
import { ATTACHMENT_CATEGORY } from "@/lib/attachment-category";
import { shortDate } from "@/lib/calendar";
import { yen } from "@/lib/format";
import { siteInfoLines } from "@/lib/site-info";

/**
 * 材料発注の画面の「見積・図面を印刷」の内容 (お客様のご要望 2026-11-27「材料発注画面から、該当案件の見積内容と現場図面を…直接印刷」)。
 * 画面の案件の見出し (src/components/material-orders/MaterialList.tsx) と同じ: 見積の明細・現場の情報・発注する材料・手書き見積書の原本・現場図面・採寸図・資料。
 * 印刷の画面は src/components/material-orders/MaterialPrint.tsx (JSON にできる値だけを渡す)
 */

export interface PrintSheet {
  /** 印刷の見出し (お客様・案件) */
  title: string;
  /** 見出しの下の行 (受注番号・店舗・日程・施工場所) */
  lines: string[];
  quote?: {
    number: string;
    items: { name: string; spec?: string; qty: string; unit: string; unitPrice: string; amount: string }[];
    totals: string;
    /** 手書きの見積書の現場の情報 (引取・納品・サイズ・備考など) */
    site: [string, string][];
    notes?: string;
  };
  materials: { status: string; name: string; code?: string; qty: string; need?: string; supplier?: string; spec?: string; orderedBy?: string }[];
  files: { id: string; label: string; name: string; kind: "image" | "pdf" | "other" }[];
}

/** 案件の発注に必要な資料: 手書き見積書の原本 (取込書類の写真) と、案件の現場図面・採寸図・資料 */
export function caseFiles(db: Database, quote: Quote | undefined, order: Order | undefined): { originals: Attachment[]; drawings: Attachment[] } {
  const originals = quote?.documentId ? db.attachments.filter((a) => a.parentType === "document" && a.parentId === quote.documentId) : [];
  const drawings = db.attachments.filter(
    (a) => ((a.parentType === "quote" && a.parentId === quote?.id) || (a.parentType === "order" && a.parentId === order?.id) || (a.parentType === "inquiry" && quote?.inquiryId && a.parentId === quote.inquiryId)) && (a.category === "site_plan" || a.category === "measure" || a.category === "doc"),
  );
  return { originals, drawings };
}

export const caseDatesText = (row: MaterialRow) => [row.pickup ? `引取 ${shortDate(row.pickup)}` : "", row.delivery ? `納品 ${shortDate(row.delivery)}` : "", row.install ? `工事 ${shortDate(row.install)}` : ""].filter(Boolean).join(" · ");

export const fileKind = (a: Attachment): "image" | "pdf" | "other" => (a.contentType === "application/pdf" ? "pdf" : a.kind === "photo" || a.contentType.startsWith("image/") ? (a.contentType === "image/svg+xml" ? "other" : "image") : "other");
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** 印刷の内容 (見積の内容・現場の情報・発注する材料・原本と図面)。画面に出している内容と同じもの */
export function printSheetOf(db: Database, row: MaterialRow, rows: MaterialRow[]): PrintSheet {
  const store = db.stores.find((s) => s.id === row.storeId);
  const quote = row.quoteId ? db.quotes.find((q) => q.id === row.quoteId) : undefined;
  const order = row.orderId ? db.orders.find((o) => o.id === row.orderId) : undefined;
  const { originals, drawings } = caseFiles(db, quote, order);
  const userName = (id?: string) => (id ? db.users.find((u) => u.id === id)?.name : undefined);
  const site = order?.siteAddress || quote?.siteAddress || (row.customerId ? db.customers.find((c) => c.id === row.customerId)?.address : undefined);
  const dates = caseDatesText(row);
  return {
    title: row.orderId ? `${row.customerName ? `${row.customerName} 様 ` : ""}${row.caseTitle ?? ""}`.trim() : "案件なし (在庫補充など)",
    lines: [[row.orderNumber ? `受注 ${row.orderNumber}` : "", store?.name ?? "", dates].filter(Boolean).join(" · "), site ? `施工場所: ${site}` : ""].filter(Boolean),
    ...(quote
      ? {
          quote: {
            number: quote.number,
            items: quote.items.map((it) => ({ name: it.name, spec: it.spec, qty: num(it.qty), unit: it.unit, unitPrice: yen(it.unitPrice), amount: yen(it.amount) })),
            totals: [`小計 ${yen(quote.subtotal)}`, quote.discount ? `値引き ${yen(quote.discount)}` : "", quote.taxExempt ? "非課税" : `消費税 ${yen(quote.tax)}${quote.taxIncluded ? " (内税)" : ""}`, `合計 ${yen(quote.total)}`].filter(Boolean).join(" · "),
            site: siteInfoLines(quote.siteInfo),
            ...(quote.workDetails || quote.notes ? { notes: [quote.workDetails, quote.notes].filter(Boolean).join("\n") } : {}),
          },
        }
      : {}),
    materials: rows.map((r) => {
      const need = needDate(r);
      return {
        status: MATERIAL_STATUS[r.status].label,
        name: r.name,
        ...(r.code ? { code: r.code } : {}),
        qty: r.qty !== undefined ? `${num(r.qty)}${r.unit ?? ""}` : r.qtyAuto !== undefined ? `${num(r.qtyAuto)}${r.unit ?? ""}` : "-",
        ...(need ? { need: shortDate(need) } : {}),
        ...(r.supplierName || r.note ? { supplier: [r.supplierName, r.note].filter(Boolean).join(" / ") } : {}),
        ...(r.spec ? { spec: r.spec } : {}),
        ...(r.status === "ordered" && userName(r.orderedBy) ? { orderedBy: userName(r.orderedBy) } : {}),
      };
    }),
    files: [...originals.map((a) => ({ a, label: "手書き見積書の原本" })), ...drawings.map((a) => ({ a, label: a.category ? ATTACHMENT_CATEGORY[a.category].short : "資料" }))].map(({ a, label }) => ({ id: a.id, label, name: a.fileName, kind: fileKind(a) })),
  };
}
