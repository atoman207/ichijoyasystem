import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canExportData } from "@/lib/auth/permissions";
import { monthlySales } from "@/lib/db/queries";
import { CHANNEL_LABEL } from "@/lib/constants";

function csv(rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    let s = String(v ?? "");
    // 表計算ソフトで数式として実行されないようにする (CSV インジェクション対策)
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

// 全データの書き出し (JSON) と、起動直後の読み込みを待つため
export const maxDuration = 60;

export async function GET(req: Request) {
  // 画面遷移の先読み (prefetch / RSC) では書き出さない (監査ログに誤って残らないように)
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) {
    return new NextResponse(null, { status: 204 });
  }
  const user = await getSessionUser();
  if (!user || !canExportData(user)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const type = new URL(req.url).searchParams.get("type") ?? "db";
  const db = await syncDb();
  const stamp = new Date().toISOString().slice(0, 10);
  const TYPE_LABEL: Record<string, string> = { customers: "顧客一覧 (CSV)", sales: "月次売上 (CSV)", db: "全データ (JSON)" };
  // 個人情報を含むデータの持ち出しなので、誰がいつ書き出したかを監査ログに残す
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: type, entityLabel: TYPE_LABEL[type] ?? type, summary: `データを書き出し: ${TYPE_LABEL[type] ?? type}` });
  });
  if (type === "customers") {
    const rows: (string | number)[][] = [["顧客コード", "氏名", "フリガナ", "区分", "電話", "メール", "郵便番号", "住所", "担当店舗", "希望連絡手段", "タグ", "登録日"]];
    for (const c of db.customers) rows.push([c.code, c.name, c.kana, c.type === "corporate" ? "法人" : "個人", c.phone, c.email ?? "", c.postalCode, c.address, db.stores.find((s) => s.id === c.storeId)?.name ?? "", CHANNEL_LABEL[c.preferredChannel], c.tags.join(" "), c.createdAt.slice(0, 10)]);
    return new NextResponse(csv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="customers_${stamp}.csv"` } });
  }
  if (type === "sales") {
    const sales = monthlySales(db, 12);
    const rows: (string | number)[][] = [["年月", ...db.stores.map((s) => s.name), "合計"]];
    for (const m of sales) rows.push([m.month, ...db.stores.map((s) => m.byStore[s.id]), m.total]);
    return new NextResponse(csv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="monthly_sales_${stamp}.csv"` } });
  }
  // パスワード (ハッシュ) は書き出さない。このファイルは分析・保管用で、ユーザーの復元には使えない
  const safe = { ...db, users: db.users.map((u) => ({ ...u, password: u.password ? "***" : undefined, passwordHash: u.passwordHash ? "***" : undefined })) };
  return new NextResponse(JSON.stringify(safe, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="ichijoya_db_${stamp}.json"` } });
}
