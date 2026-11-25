import "server-only";
import { PDFDocument } from "pdf-lib";
import type { Database, User } from "@/lib/db/types";
import { canOutputDocument } from "@/lib/auth/permissions";
import { invoiceAccessInfo } from "@/lib/case-access";
import { receiptPdfData } from "@/lib/pdf/data";
import { renderReceiptPdf } from "@/lib/pdf/render";
import { activeReceipts } from "@/lib/receipts";
import { mergePdfs, recordOutputs, renderTarget, type PrintTarget } from "@/lib/doc-print";
import type { OutputInput } from "@/lib/doc-outputs";
import { pdfPageToPng } from "@/lib/maps/render";

/**
 * 帳票 (見積書・納品書・請求書・領収書・まとめて印刷) をシステムの画面の中で見る (お客様のご要望 2026-11-26
 * 「スマートフォンで PDF を開いたあと元の画面に簡単に戻れるように」)。PDF をそのまま開かず、ページを画像にして /docs/view に出す
 * (住宅地図の画面と同じ作り。src/lib/maps/render.ts の pdftoppm)。上と下に「元の画面に戻る」。
 * src = 帳票の PDF の場所 (/api/pdf/…)。権限と出力の記録は PDF を開いたときと同じ (doc-print.ts)。
 * 画面を開いたときに PDF を作って控え (10 分) に置き、ページの画像はその控えから作る
 */

export const VIEW_WIDTH = 1600;
export const MAX_VIEW_PAGES = 30;
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 40;

interface Entry {
  bytes: Uint8Array;
  pages: number;
  fileName: string;
  at: number;
  pngs: Map<number, Buffer>;
}
const cache = new Map<string, Entry>();

const KIND: Record<string, PrintTarget["kind"]> = { quotes: "quote", invoices: "invoice", receipts: "receipt", delivery: "delivery" };

/** 帳票の PDF の場所か (/api/pdf/quotes|invoices|receipts|delivery/<ID> と /api/pdf/batch?docs=)。ほかの場所は開かない */
export function isDocSrc(src: string): boolean {
  return /^\/api\/pdf\/(quotes|invoices|receipts|delivery)\/[A-Za-z0-9_-]+(\?version=\d+)?$/.test(src) || /^\/api\/pdf\/batch\?docs=[A-Za-z0-9_:,%-]+(&date=[0-9-]*)?$/.test(src);
}

type Loaded = { ok: true; entry: Entry } | { ok: false; status: number; error: string };

/** 帳票の PDF を作る (record = 出力の記録を残す。画面を開いたとき) */
export async function loadDoc(db: Database, user: User, src: string, opts: { record: boolean }): Promise<Loaded> {
  if (!isDocSrc(src)) return { ok: false, status: 400, error: "表示できる帳票ではありません。" };
  const key = `${user.id}|${src}`;
  const now = Date.now();
  if (!opts.record) {
    const hit = cache.get(key);
    if (hit && now - hit.at < TTL_MS) return { ok: true, entry: hit };
  }
  const url = new URL(src, "http://local");
  const parts = url.pathname.split("/");
  const inputs: OutputInput[] = [];
  let bytes: Uint8Array;
  let fileName: string;
  if (parts[3] === "batch") {
    const targets: PrintTarget[] = (url.searchParams.get("docs") ?? "")
      .split(",")
      .map((x) => x.split(":"))
      .map(([k, id]) => ({ kind: ({ q: "quote", i: "invoice", r: "receipt", d: "delivery" } as Record<string, PrintTarget["kind"]>)[k], id }))
      .filter((t): t is PrintTarget => Boolean(t.kind && t.id))
      .slice(0, 60);
    const list: Uint8Array[] = [];
    for (const t of targets) {
      const r = await renderTarget(db, user, t, "batch");
      if (!r.ok) continue;
      list.push(r.bytes);
      inputs.push(r.input);
    }
    if (!list.length) return { ok: false, status: 403, error: "表示できる帳票がありません。" };
    bytes = await mergePdfs(list);
    fileName = `帳票 ${list.length} 枚`;
  } else {
    const kind = KIND[parts[3]];
    const id = parts[4];
    // 領収書の場所に請求書の ID (以前の形): 領収書が 1 枚ならその領収書、なければ入金の記録から作る
    const inv = kind === "receipt" ? db.invoices.find((x) => x.id === id) : undefined;
    if (inv) {
      const active = activeReceipts(db, inv.id);
      if (active.length === 1) return loadDoc(db, user, `/api/pdf/receipts/${active[0].id}`, opts);
      if (!canOutputDocument(user, invoiceAccessInfo(db, user, inv).access)) return { ok: false, status: 403, error: "この請求書を表示する権限がありません。" };
      const data = receiptPdfData(db, inv);
      if (!data) return { ok: false, status: 409, error: "入金の記録がないため、領収書は出力できません。" };
      bytes = await renderReceiptPdf(data);
      fileName = `領収書 ${inv.number}`;
      inputs.push({ kind: "receipt", refId: inv.id, number: data.number, storeId: inv.storeId, customerId: inv.customerId, orderId: inv.orderId, via: "view" });
    } else {
      const v = url.searchParams.get("version");
      const r = await renderTarget(db, user, { kind, id, version: v ? Number(v) : undefined }, "view");
      if (!r.ok) return r;
      bytes = r.bytes;
      fileName = r.fileName.replace(/\.pdf$/, "").replace(/_/g, " ");
      inputs.push(r.input);
    }
  }
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  if (opts.record) await recordOutputs(user, inputs);
  const entry: Entry = { bytes, pages, fileName, at: now, pngs: new Map() };
  cache.set(key, entry);
  // 古い控えから捨てる
  for (const [k, e] of cache) if (now - e.at > TTL_MS || cache.size > MAX_ENTRIES) cache.delete(k);
  return { ok: true, entry };
}

/** ページの画像 (控えの PDF から。なければ作り直す) */
export async function docPagePng(db: Database, user: User, src: string, page: number): Promise<{ ok: true; png: Buffer } | { ok: false; status: number; error: string }> {
  const r = await loadDoc(db, user, src, { record: false });
  if (!r.ok) return r;
  if (!Number.isInteger(page) || page < 1 || page > Math.min(r.entry.pages, MAX_VIEW_PAGES)) return { ok: false, status: 404, error: "ページがありません。" };
  const hit = r.entry.pngs.get(page);
  if (hit) return { ok: true, png: hit };
  const png = await pdfPageToPng(Buffer.from(r.entry.bytes), page, VIEW_WIDTH);
  r.entry.pngs.set(page, png);
  return { ok: true, png };
}
