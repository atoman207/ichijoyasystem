import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canExportAccounting } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { buildJournal, genericRows, plainCsv, yayoiRows, type JournalKind } from "@/lib/accounting";
import { signed, sortCash } from "@/lib/cashbook";
import { invoiceOfOrder, invoiceOrderIds } from "@/lib/billing";
import { CASH_SOURCE_LABEL, EXPENSE_METHOD_LABEL, EXPENSE_STATUS, INVOICE_STATUS, PAYMENT_METHOD_LABEL, PURCHASE_PAY_METHOD_LABEL, PURCHASE_STATUS } from "@/lib/constants";
import type { StoreId } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KIND_LABEL: Record<string, string> = {
  journal: "仕訳",
  sales: "売上の明細 (売上計上日)",
  invoices: "請求書の明細",
  payments: "入金の明細",
  expenses: "経費の明細",
  purchases: "仕入の明細",
  cashbook: "現金出納帳",
};

const isDate = (v: string | null): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/**
 * 会計処理用のデータの出力 (本部スタッフ・管理者)
 * /api/accounting?kind=journal|sales|invoices|payments|expenses|purchases|cashbook&from=YYYY-MM-DD&to=YYYY-MM-DD[&store=koshi]
 *   sales = 売上計上日 (施工完了日) の売上 (仕訳の売上と同じ範囲) / invoices = 請求書の発行日の一覧 (以前の sales)
 *   kind=journal: &format=generic (汎用・BOM 付き UTF-8 / &encoding=sjis で Shift_JIS) | yayoi (弥生会計のインポート形式・Shift_JIS) [&journal=sales,receipt,…]
 * 書き出しは変更履歴に残す
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canExportAccounting(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const kind = p.get("kind") ?? "journal";
  if (!KIND_LABEL[kind]) return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  let from = p.get("from");
  let to = p.get("to");
  if (!isDate(from) || !isDate(to)) return NextResponse.json({ error: "from / to (YYYY-MM-DD) are required" }, { status: 400 });
  // 月末の 31 日などを実在する日にそろえる
  const clamp = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
  };
  from = clamp(from);
  to = clamp(to);
  if (from > to) return NextResponse.json({ error: "from must be before to" }, { status: 400 });
  const db = await syncDb();
  const storeParam = p.get("store");
  const store = storeParam && db.stores.some((s) => s.id === storeParam) ? (storeParam as StoreId) : undefined;
  const storeName = (id: StoreId) => db.stores.find((s) => s.id === id)?.name ?? id;
  const customer = (id?: string) => db.customers.find((c) => c.id === id)?.name ?? "";
  const supplier = (id?: string) => db.suppliers.find((s) => s.id === id)?.name ?? "";
  const user_ = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "";
  const inRange = (d?: string) => Boolean(d && d >= from! && d <= to!);
  const storeOk = (id: StoreId) => !store || store === id;
  const format = kind === "journal" ? (p.get("format") === "yayoi" ? "yayoi" : "generic") : "detail";
  const label = `${KIND_LABEL[kind]}${format === "yayoi" ? " (弥生会計形式)" : ""} ${from}〜${to}${store ? ` · ${storeName(store)}` : ""}`;
  const stamp = `${from.replace(/-/g, "")}-${to.replace(/-/g, "")}${store ? `_${store}` : ""}`;

  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "accounting", entityId: kind, entityLabel: label, summary: `会計データを書き出し: ${label}` });
  });

  const file = (body: Uint8Array | string, name: string, charset: "utf-8" | "shift_jis") =>
    new NextResponse(typeof body === "string" ? body : Buffer.from(body), {
      headers: { "Content-Type": `text/csv; charset=${charset}`, "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" },
    });

  if (kind === "journal") {
    const kinds = (p.get("journal") ?? "").split(",").filter(Boolean) as JournalKind[];
    const rows = buildJournal(db, { from, to, storeId: store, kinds });
    if (format === "yayoi") return file(plainCsv(yayoiRows(rows), "sjis"), `仕訳_弥生会計_${stamp}.csv`, "shift_jis");
    const sjis = p.get("encoding") === "sjis";
    return file(plainCsv(genericRows(rows), sjis ? "sjis" : "utf8"), `仕訳_${stamp}.csv`, sjis ? "shift_jis" : "utf-8");
  }
  if (kind === "sales") {
    // 仕訳の「売上」と同じ行 (受注の売上計上日 = 施工完了日。受注で計上できない請求書は発行日)
    const rows: (string | number)[][] = [["売上計上日", "受注番号", "お客様", "店舗", "件名", "税抜", "消費税", "税込", "請求番号", "請求書の発行日", "請求の状態"]];
    for (const r of buildJournal(db, { from, to, storeId: store, kinds: ["sales"] })) {
      const o = db.orders.find((x) => x.number === r.ref);
      const inv = o ? invoiceOfOrder(db.invoices, o) : db.invoices.find((i) => i.number === r.ref);
      const live = inv && inv.status !== "void" ? inv : undefined;
      const tax = r.credit.taxAmount ?? 0;
      rows.push([r.date, o?.number ?? "", r.partner ?? "", r.credit.dept ?? storeName((o ?? inv)?.storeId ?? "hq"), o?.title ?? inv?.title ?? "", r.credit.amount - tax, tax, r.credit.amount, live?.number ?? "", live?.issueDate ?? "", live ? INVOICE_STATUS[live.status].label : "未請求"]);
    }
    return file(toCsv(rows), `売上明細_${stamp}.csv`, "utf-8");
  }
  if (kind === "invoices") {
    const rows: (string | number)[][] = [["発行日", "請求番号", "お客様", "店舗", "件名", "税抜", "消費税", "税込", "入金済", "残高", "状態", "支払期限", "入金予定日", "入金予定額", "対象の受注", "締め日"]];
    for (const i of db.invoices) if (inRange(i.issueDate) && storeOk(i.storeId)) rows.push([i.issueDate, i.number, customer(i.customerId), storeName(i.storeId), i.title ?? "", i.subtotal, i.tax, i.total, i.paidAmount, i.status === "void" ? 0 : i.total - i.paidAmount, INVOICE_STATUS[i.status].label, i.dueDate, i.expectedDate ?? "", i.expectedAmount ?? "", invoiceOrderIds(i).map((id) => db.orders.find((o) => o.id === id)?.number ?? id).join(" "), i.periodTo ?? ""]);
    return file(toCsv(rows), `請求書明細_${stamp}.csv`, "utf-8");
  }
  if (kind === "payments") {
    const rows: (string | number)[][] = [["入金日", "請求番号", "お客様", "店舗", "方法", "金額", "決済会社からの入金日", "メモ", "登録者"]];
    for (const pay of db.payments) {
      const inv = db.invoices.find((i) => i.id === pay.invoiceId);
      if (!inv || !inRange(pay.date) || !storeOk(inv.storeId)) continue;
      rows.push([pay.date, inv.number, customer(inv.customerId), storeName(inv.storeId), PAYMENT_METHOD_LABEL[pay.method], pay.amount, pay.settledOn ?? "", pay.memo ?? "", user_(pay.recordedBy)]);
    }
    return file(toCsv(rows), `入金明細_${stamp}.csv`, "utf-8");
  }
  if (kind === "expenses") {
    const rows: (string | number)[][] = [["日付", "番号", "店舗", "申請者", "支払先", "勘定科目", "支払方法", "金額 (税込)", "消費税", "状態", "承認者", "精算日", "内容"]];
    for (const e of db.expenses) if (inRange(e.date) && storeOk(e.storeId)) rows.push([e.date, e.number, storeName(e.storeId), user_(e.submittedBy), e.vendor, e.account, EXPENSE_METHOD_LABEL[e.paymentMethod], e.amount, e.taxAmount, EXPENSE_STATUS[e.status].label, user_(e.approvedBy), e.paidAt ?? "", e.description]);
    return file(toCsv(rows), `経費明細_${stamp}.csv`, "utf-8");
  }
  if (kind === "purchases") {
    const rows: (string | number)[][] = [["請求日", "番号", "仕入先", "店舗", "勘定科目", "金額 (税込)", "消費税", "支払期限", "支払予定日", "状態", "支払日", "支払方法", "仕入先の請求書番号", "摘要", "案件"]];
    for (const pu of db.purchases) {
      if (!inRange(pu.invoiceDate) || !storeOk(pu.storeId)) continue;
      rows.push([pu.invoiceDate, pu.number, supplier(pu.supplierId), storeName(pu.storeId), pu.account ?? "仕入高", pu.amount, pu.taxAmount, pu.dueDate, pu.scheduledPayDate ?? pu.dueDate, PURCHASE_STATUS[pu.status].label, pu.paidAt ?? "", pu.payMethod ? PURCHASE_PAY_METHOD_LABEL[pu.payMethod] : "", pu.supplierInvoiceNo ?? "", pu.description, db.orders.find((o) => o.id === pu.orderId)?.number ?? ""]);
    }
    return file(toCsv(rows), `仕入明細_${stamp}.csv`, "utf-8");
  }
  // 現金出納帳 (店舗ごとに残高を積み上げる)
  const rows: (string | number)[][] = [["日付", "番号", "店舗", "科目", "相手", "摘要", "入金", "出金", "残高", "記帳", "記帳した人"]];
  for (const s of db.stores) {
    if (!storeOk(s.id)) continue;
    const entries = sortCash(db.cashEntries.filter((c) => c.storeId === s.id));
    let balance = entries.filter((c) => c.date < from!).reduce((a, c) => a + signed(c), 0);
    const inside = entries.filter((c) => inRange(c.date));
    if (!inside.length && !balance) continue;
    rows.push([from, "", s.name, "前期からの繰越", "", "", "", "", balance, "", ""]);
    for (const c of inside) {
      balance += signed(c);
      rows.push([c.date, c.number, s.name, c.account, c.counterparty ?? "", c.description, c.direction === "in" ? c.amount : "", c.direction === "out" ? c.amount : "", balance, CASH_SOURCE_LABEL[c.source], user_(c.recordedBy)]);
    }
  }
  return file(toCsv(rows), `現金出納帳_${stamp}.csv`, "utf-8");
}
