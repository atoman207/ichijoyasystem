import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canViewCondolences, canViewHeriStock, canViewOfficeImprovements } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { CONDOLENCE_CATEGORY_LABEL, condolenceCsvRows, filterCondolences, filterImprovements, improvementCsvRows, officeCtx } from "@/lib/office";
import { heriCsvRows } from "@/lib/heri-stock";
import { toDateKey } from "@/lib/format";
import type { CondolenceCategory } from "@/lib/db/types";

/**
 * 事務・縁在庫の CSV (UTF-8 BOM 付き。同じ見出しでそのまま取り込める)
 * /api/office?kind=kaizen&year=2025&staff=…&item=…&q=…  事務改善シート (全員)
 * /api/office?kind=keicho&year=2025&category=condolence&q=…  慶弔リスト (事務担当・本部・管理者)
 * /api/office?kind=heri  縁在庫 (全員。原価・単価は入れない)
 * 書き出しは変更履歴に残す
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind") ?? "";
  const db = await syncDb();
  const ctx = officeCtx(db);
  let rows: (string | number)[][];
  let label: string;
  let entity: string;
  if (kind === "kaizen") {
    if (!canViewOfficeImprovements(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const list = filterImprovements(db.officeImprovements, { year: Number(sp.get("year")) || undefined, staff: sp.get("staff") || undefined, item: sp.get("item") || undefined, q: sp.get("q") || undefined });
    rows = improvementCsvRows(list);
    label = `事務改善シート (${list.length} 件)`;
    entity = "office_improvement";
  } else if (kind === "keicho") {
    if (!canViewCondolences(user, ctx)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const category = (Object.keys(CONDOLENCE_CATEGORY_LABEL) as CondolenceCategory[]).find((c) => c === sp.get("category"));
    const list = filterCondolences(db.condolences, { year: Number(sp.get("year")) || undefined, category, q: sp.get("q") || undefined });
    rows = condolenceCsvRows(list);
    label = `慶弔リスト (${list.length} 件)`;
    entity = "condolence";
  } else if (kind === "heri") {
    if (!canViewHeriStock(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    rows = heriCsvRows(db);
    label = `縁在庫 (${rows.length - 1} 品番)`;
    entity = "material";
  } else {
    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  }
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity, entityId: `export_${kind}`, entityLabel: label, summary: `データを書き出し: ${label}` });
  });
  const name = `${kind === "kaizen" ? "office_improvements" : kind === "keicho" ? "condolences" : "heri_stock"}_${toDateKey(new Date())}.csv`;
  return new NextResponse(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" },
  });
}
