import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canAccessStore, canSeeAllStores, canViewPayables, canViewPurchase, canViewReceivables } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { encodeShiftJis } from "@/lib/sjis";
import { AGING_BUCKETS, AP_METHOD_LABEL, apMethodFilter, payablesAsOf, receivablesAsOf } from "@/lib/ar-ap";
import { PURCHASE_PAY_METHOD_LABEL, PURCHASE_STATUS } from "@/lib/constants";
import type { StoreId } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KIND_LABEL: Record<string, string> = {
  ar: "売掛一覧",
  ar_lines: "売掛明細",
  ap: "買掛一覧",
  ap_lines: "買掛明細",
};

const isDate = (v: string | null): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/**
 * 売掛一覧・買掛一覧の CSV (src/lib/ar-ap.ts。画面は 入出金の予定 → 売掛一覧 / 買掛一覧)
 * /api/finance?kind=ar|ar_lines|ap|ap_lines&asOf=YYYY-MM-DD[&store=koshi][&method=bulk|all|unset|transfer…][&payMonth=YYYY-MM][&encoding=sjis]
 * 項目は汎用の形 (税理士事務所の形式が分かったら合わせる)。書き出しは変更履歴に残す。
 * 転送は使わない (エラーは JSON)。req.url は検索パラメーターを読むだけに使う
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const kind = p.get("kind") ?? "ar";
  if (!KIND_LABEL[kind]) return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  const ar = kind.startsWith("ar");
  if (ar ? !canViewReceivables(user) : !canViewPayables(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const asOfRaw = p.get("asOf");
  if (!isDate(asOfRaw)) return NextResponse.json({ error: "asOf (YYYY-MM-DD) is required" }, { status: 400 });
  const asOf = asOfRaw;
  const db = await syncDb();
  const storeParam = p.get("store");
  const store = canSeeAllStores(user) && storeParam && db.stores.some((s) => s.id === storeParam) ? (storeParam as StoreId) : undefined;
  const storeName = (id: StoreId) => db.stores.find((s) => s.id === id)?.name ?? id;
  const sjis = p.get("encoding") === "sjis";
  const method = apMethodFilter(p.get("method"));
  const payMonth = /^\d{4}-\d{2}$/.test(p.get("payMonth") ?? "") ? p.get("payMonth")! : undefined;
  const label = `${KIND_LABEL[kind]} ${asOf} 時点${store ? ` · ${storeName(store)}` : ""}${ar ? "" : ` · ${AP_METHOD_LABEL(method)}${payMonth ? ` · 支払予定 ${payMonth}` : ""}`}`;
  const stamp = `${asOf.replace(/-/g, "")}${store ? `_${store}` : ""}${ar ? "" : `_${method}${payMonth ? `_${payMonth.replace("-", "")}` : ""}`}`;

  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "accounting", entityId: kind, entityLabel: label, summary: `${KIND_LABEL[kind]}を書き出し: ${label}` });
  });

  const file = (rows: (string | number | null | undefined)[][], name: string) => {
    const text = toCsv(rows);
    const body = sjis ? Buffer.from(encodeShiftJis(text.replace(/^﻿/, ""))) : text;
    return new NextResponse(body, {
      headers: { "Content-Type": `text/csv; charset=${sjis ? "shift_jis" : "utf-8"}`, "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" },
    });
  };

  if (ar) {
    const inScope = (id: StoreId) => canAccessStore(user, id) && (!store || id === store);
    const { customers } = receivablesAsOf(db, asOf, inScope);
    if (kind === "ar") {
      const rows: (string | number)[][] = [["基準日", "得意先コード", "得意先名", "区分", "まとめ請求", "店舗", "売掛残高", "うち請求済み", "うち未請求", "うち支払期限超過", ...AGING_BUCKETS.map((b) => `売上計上日から${b.label}`), "最も古い売上計上日", "件数"]];
      for (const c of customers) rows.push([asOf, c.code, c.name, c.corporate ? "法人" : "個人", c.batch ? "あり" : "", c.storeIds.map(storeName).join("・"), c.balance, c.invoiced, c.uninvoiced, c.overdue, ...c.buckets, c.oldest ?? "", c.lines.length]);
      return file(rows, `売掛一覧_${stamp}.csv`);
    }
    const rows: (string | number)[][] = [["基準日", "得意先コード", "得意先名", "店舗", "売上計上日", "受注番号", "件名", "金額 (税込)", "入金済み", "残高", "請求番号", "請求書の発行日", "支払期限", "経過日数", "区分"]];
    for (const c of customers) for (const l of c.lines) rows.push([asOf, c.code, c.name, storeName(l.storeId), l.salesDate, l.kind === "order" ? l.number : "", l.title, l.amount, l.paid, l.balance, l.invoiceNumber ?? "", l.invoiceDate ?? "", l.dueDate ?? "", l.ageDays, l.kind === "order" ? (l.invoiced ? "請求済み" : "未請求") : "請求書のみ (受注なし)"]);
    return file(rows, `売掛明細_${stamp}.csv`);
  }

  const { suppliers } = payablesAsOf(db, asOf, { method, payMonth, storeId: store, canView: (x) => canViewPurchase(user, x) });
  if (kind === "ap") {
    const rows: (string | number)[][] = [["基準日", "仕入先", "いつもの支払方法", "支払条件", "買掛残高", "件数", "次の支払予定日", "振込先", "登録番号"]];
    for (const s of suppliers) rows.push([asOf, s.name, s.method ? PURCHASE_PAY_METHOD_LABEL[s.method] : "未設定", s.terms, s.balance, s.count, s.nextPayDate ?? "", s.bankInfo ?? "", s.registrationNumber ?? ""]);
    return file(rows, `買掛一覧_${stamp}.csv`);
  }
  const rows: (string | number)[][] = [["基準日", "仕入先", "店舗", "番号", "仕入先の請求書番号", "請求日", "支払期限", "支払予定日", "支払方法", "金額 (税込)", "うち消費税", "勘定科目", "状態", "摘要", "案件"]];
  for (const s of suppliers) {
    for (const l of s.lines) {
      const pu = l.purchase;
      rows.push([asOf, s.name, storeName(pu.storeId), pu.number, pu.supplierInvoiceNo ?? "", pu.invoiceDate, pu.dueDate, l.payDate, l.method ? PURCHASE_PAY_METHOD_LABEL[l.method] : "未設定", pu.amount, pu.taxAmount, pu.account ?? "仕入高", PURCHASE_STATUS[pu.status].label, pu.description, db.orders.find((o) => o.id === pu.orderId)?.number ?? ""]);
    }
  }
  return file(rows, `買掛明細_${stamp}.csv`);
}
