import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canExportData } from "@/lib/auth/permissions";
import { monthlySales } from "@/lib/db/queries";
import { toCsv } from "@/lib/csv";
import { exportCustomers, exportInquiries, exportOrders, templateRows } from "@/lib/data-io";
import type { StoreId } from "@/lib/db/types";

// 全データの書き出し (JSON) と、起動直後の読み込みを待つため
export const maxDuration = 60;

const TYPE_LABEL: Record<string, string> = {
  customers: "顧客一覧 (CSV)",
  inquiries: "問い合わせ一覧 (CSV)",
  orders: "受注・施工一覧 (CSV)",
  sales: "月次売上 (CSV)",
  db: "全データ (JSON)",
};

/**
 * データの書き出し (管理者・本部スタッフ)
 * /api/export?type=customers|inquiries|orders|sales|db [&store=koshi] 、取込用のひな形は type=template-customers|template-inquiries
 * CSV は UTF-8 (BOM 付き)。Excel・Google スプレッドシート (ファイル → インポート) でそのまま開ける
 */
export async function GET(req: Request) {
  // 画面遷移の先読み (prefetch / RSC) では書き出さない (監査ログに誤って残らないように)
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) {
    return new NextResponse(null, { status: 204 });
  }
  const user = await getSessionUser();
  if (!user || !canExportData(user)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const params = new URL(req.url).searchParams;
  const type = params.get("type") ?? "db";
  const db = await syncDb();
  const stamp = new Date().toISOString().slice(0, 10);
  const csv = (body: string, name: string) =>
    new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` } });

  // 取込用のひな形 (見出しと記入例だけ。個人情報を含まないので変更履歴には残さない)
  if (type === "template-customers" || type === "template-inquiries") {
    const target = type === "template-customers" ? "customers" : "inquiries";
    return csv(toCsv(templateRows(target)), `template_${target}.csv`);
  }
  if (!TYPE_LABEL[type]) return NextResponse.json({ error: "unknown type" }, { status: 400 });

  const storeParam = params.get("store");
  const store = storeParam && db.stores.some((s) => s.id === storeParam) ? (storeParam as StoreId) : undefined;
  const storeName = store ? db.stores.find((s) => s.id === store)?.name : undefined;
  const label = `${TYPE_LABEL[type]}${storeName ? ` · ${storeName}` : ""}`;
  // 個人情報を含むデータの持ち出しなので、誰がいつ書き出したかを監査ログに残す
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: type, entityLabel: label, summary: `データを書き出し: ${label}` });
  });
  const suffix = store ? `_${store}` : "";
  if (type === "customers") return csv(toCsv(exportCustomers(db, store)), `customers${suffix}_${stamp}.csv`);
  if (type === "inquiries") return csv(toCsv(exportInquiries(db, store)), `inquiries${suffix}_${stamp}.csv`);
  if (type === "orders") return csv(toCsv(exportOrders(db, store)), `orders${suffix}_${stamp}.csv`);
  if (type === "sales") {
    const sales = monthlySales(db, 12);
    const rows: (string | number)[][] = [["年月", ...db.stores.map((s) => s.name), "合計"]];
    for (const m of sales) rows.push([m.month, ...db.stores.map((s) => m.byStore[s.id]), m.total]);
    return csv(toCsv(rows), `monthly_sales_${stamp}.csv`);
  }
  // パスワード (ハッシュ) は書き出さない。このファイルは分析・保管用で、ユーザーの復元には使えない
  const safe = { ...db, users: db.users.map((u) => ({ ...u, password: u.password ? "***" : undefined, passwordHash: u.passwordHash ? "***" : undefined })) };
  return new NextResponse(JSON.stringify(safe, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="ichijoya_db_${stamp}.json"` } });
}
