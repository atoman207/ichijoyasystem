import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canExportData, canViewAuditEntry } from "@/lib/auth/permissions";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, AUDIT_ACTION_LABEL, ENTITY_LABEL } from "@/lib/constants";
import { fieldLabel, fieldValue } from "@/lib/field-labels";
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
  audit: "変更履歴 (CSV)",
  approvals: "承認履歴 (CSV)",
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
  const userOf = (id?: string) => (id === "system" ? "システム (外部連携)" : (db.users.find((u) => u.id === id)?.name ?? id ?? ""));
  const names = new Map<string, string>([...db.users.map((u) => [u.id, u.name] as [string, string]), ...db.suppliers.map((s) => [s.id, s.name] as [string, string])]);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (type === "audit") {
    // 画面と同じ絞り込み・閲覧範囲。変更した項目は 1 項目 1 行 (変更前・変更後)
    let logs = db.auditLogs.filter((l) => canViewAuditEntry(user, l));
    const f = (k: string) => params.get(k) ?? "";
    if (f("entity")) logs = logs.filter((l) => l.entity === f("entity"));
    if (f("action")) logs = logs.filter((l) => l.action === f("action"));
    if (f("user")) logs = logs.filter((l) => l.userId === f("user"));
    if (store) logs = logs.filter((l) => l.storeId === store);
    if (from) logs = logs.filter((l) => l.at.slice(0, 10) >= from);
    if (to) logs = logs.filter((l) => l.at.slice(0, 10) <= to);
    if (f("q")) logs = logs.filter((l) => [l.summary, l.entityLabel].join(" ").toLowerCase().includes(f("q").toLowerCase()));
    const rows: (string | number)[][] = [["日時", "操作した人", "操作", "対象", "対象の番号・名前", "店舗", "内容", "変更した項目", "変更前", "変更後"]];
    for (const l of logs) {
      const base = [new Date(l.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }), userOf(l.userId), AUDIT_ACTION_LABEL[l.action] ?? l.action, ENTITY_LABEL[l.entity] ?? l.entity, l.entityLabel, l.storeId ? (db.stores.find((s) => s.id === l.storeId)?.name ?? l.storeId) : "", l.summary];
      if (l.changes?.length) for (const c of l.changes) rows.push([...base, fieldLabel(l.entity, c.field), fieldValue(c.field, c.before, names), fieldValue(c.field, c.after, names)]);
      else rows.push([...base, "", "", ""]);
    }
    return csv(toCsv(rows), `audit_log_${stamp}.csv`);
  }
  if (type === "approvals") {
    let list = db.approvals.filter((a) => a.status !== "pending");
    const kind = params.get("kind");
    const status = params.get("status");
    if (kind) list = list.filter((a) => a.type === kind);
    if (status) list = list.filter((a) => a.status === status);
    if (from) list = list.filter((a) => (a.decidedAt ?? a.createdAt).slice(0, 10) >= from);
    if (to) list = list.filter((a) => (a.decidedAt ?? a.createdAt).slice(0, 10) <= to);
    const rows: (string | number)[][] = [["申請日時", "種類", "件名", "金額", "店舗", "申請者", "申請コメント", "承認者の区分", "判断", "判断した人", "判断日時", "判断コメント", "変更の内容"]];
    for (const a of list.sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
      const entity = a.type === "customer_change" ? "customer" : "order";
      rows.push([
        new Date(a.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
        APPROVAL_TYPE_LABEL[a.type],
        a.title,
        a.amount,
        db.stores.find((s) => s.id === a.storeId)?.name ?? a.storeId,
        userOf(a.requestedBy),
        a.requestComment ?? "",
        a.requiredRole === "admin" ? "管理者" : "店長",
        APPROVAL_STATUS[a.status].label,
        userOf(a.decidedBy),
        a.decidedAt ? new Date(a.decidedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "",
        a.decisionComment ?? "",
        (a.changes ?? []).map((c) => `${fieldLabel(entity, c.field)}: ${fieldValue(c.field, c.before)} → ${fieldValue(c.field, c.after)}`).join(" / "),
      ]);
    }
    return csv(toCsv(rows), `approval_history_${stamp}.csv`);
  }
  // パスワード (ハッシュ) は書き出さない。このファイルは分析・保管用で、ユーザーの復元には使えない
  const safe = { ...db, users: db.users.map((u) => ({ ...u, password: u.password ? "***" : undefined, passwordHash: u.passwordHash ? "***" : undefined })) };
  return new NextResponse(JSON.stringify(safe, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="ichijoya_db_${stamp}.json"` } });
}
