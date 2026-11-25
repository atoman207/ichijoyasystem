import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canSeeAllStoreFigures, canViewPromoAnalysis } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { toCsv } from "@/lib/csv";
import { toDateKey } from "@/lib/format";
import { salesFacts } from "@/lib/assistant/facts";
import { scopeStores } from "@/lib/ops-reports/promo-analysis";
import { GBP_LABEL, OMOTE_GROUPS, PRODUCT_CATS, PRODUCT_LABEL, omoteCounts, productKpis, promoFyMonths, promoFyOf, promoKpiSettings, readGbp, type GbpMetric } from "@/lib/ops-reports/promo-products";

export const maxDuration = 60;

const SECTIONS = { products: "畳・襖・障子・網戸", omote_mix: "畳表の内訳", fusuma_mix: "襖紙の内訳", extras: "マイトスタット・リフォーム", omote_counts: "畳表の出数", gbp: "Google ビジネスプロフィール" } as const;
type Section = keyof typeof SECTIONS;

/**
 * 販促と媒体の分析 → 商品の KPI の CSV (画面 /promotions?tab=products と同じ集計。src/lib/ops-reports/promo-products.ts)
 * /api/promotions/products?section=products|omote_mix|fusuma_mix|extras|omote_counts|gbp &pfy=2026 &oy=2025 &gy=2026 &store=koshi
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const sessionUser = await getSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const db = await syncDb();
  const user = policyReader(db, sessionUser);
  if (!canViewPromoAnalysis(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const section = (sp.section ?? "products") as Section;
  if (!(section in SECTIONS)) return NextResponse.json({ error: "unknown section" }, { status: 400 });
  const today = toDateKey(new Date());
  const s = promoKpiSettings(db);
  const curFy = promoFyOf(today, s.fyStartMonth);
  const fy = Number(sp.pfy) >= 2015 && Number(sp.pfy) <= curFy + 1 ? Number(sp.pfy) : curFy;
  const storeIds = scopeStores(db, user, sp.store).filter((id) => db.stores.find((x) => x.id === id)?.kind === "store");
  const storeName = (id: string) => (id === "all" ? "全店" : (db.stores.find((x) => x.id === id)?.name ?? id));
  const facts = salesFacts(db).facts;
  const rows: (string | number | null)[][] = [];
  if (section === "omote_counts") {
    const oy = Number(sp.oy) >= 2015 ? Number(sp.oy) : Number(today.slice(0, 4));
    const list = omoteCounts(facts, `${oy - 1}-11-01`, `${oy}-10-31`, s, storeIds);
    const total = list.reduce((a, x) => a + x.qty, 0);
    rows.push([`畳表の出数 (${oy - 1}-11〜${oy}-10)`, "枚数", "比率"]);
    for (const x of list) rows.push([x.label, x.qty, total ? `${((x.qty / total) * 100).toFixed(2)}%` : ""]);
    rows.push(["合計", total, ""]);
  } else if (section === "gbp") {
    const gy = Number(sp.gy) >= 2015 ? Number(sp.gy) : Number(today.slice(0, 4));
    const gbp = readGbp(db);
    const stores = db.stores.filter((x) => canSeeAllStoreFigures(user) || storeIds.includes(x.id));
    for (const m of ["calls", "web", "views"] as GbpMetric[]) {
      rows.push([`${gy}年 ${GBP_LABEL[m]}`, ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`), "合計"]);
      for (const st of stores) {
        const vals = Array.from({ length: 12 }, (_, i) => gbp[`${st.id}|${gy}-${String(i + 1).padStart(2, "0")}`]?.[m] ?? null);
        rows.push([st.name, ...vals, vals.reduce((a: number, v) => a + (v ?? 0), 0)]);
      }
      rows.push([]);
    }
  } else {
    const kpis = productKpis(facts, new Map(db.customers.map((c) => [c.id, c])), storeIds, promoFyMonths(fy, s.fyStartMonth), s);
    if (section === "products") {
      rows.push(["店舗", "月", ...PRODUCT_CATS.flatMap((c) => [`${PRODUCT_LABEL[c]} 平均単価 (税抜)`, `${PRODUCT_LABEL[c]} 売上 (税込)`, `${PRODUCT_LABEL[c]} 枚数`]), "受注"]);
      for (const k of kpis) for (const m of [...k.months, k.total]) rows.push([storeName(k.storeId), m.month === "total" ? "累計" : m.month, ...PRODUCT_CATS.flatMap((c) => [m.cats[c].unitPrice, m.cats[c].sales, m.cats[c].qty]), m.orders]);
    } else if (section === "omote_mix" || section === "fusuma_mix") {
      const cols = section === "omote_mix" ? [...OMOTE_GROUPS] : [...s.fusuma.map((r) => r.label), "その他"];
      rows.push(["店舗", "月", ...cols, "合計"]);
      for (const k of kpis)
        for (const m of [...k.months, k.total]) {
          const mix = section === "omote_mix" ? m.omote : m.fusuma;
          rows.push([storeName(k.storeId), m.month === "total" ? "累計" : m.month, ...cols.map((c) => mix[c] ?? 0), Object.values(mix).reduce((a, b) => a + b, 0)]);
        }
    } else {
      rows.push(["店舗", "月", "マイトスタット 件数", "マイトスタット 枚数", `${s.reformMin}円以上のリフォーム 件数`, "リフォーム 売上 (税込)"]);
      for (const k of kpis) for (const m of [...k.months, k.total]) rows.push([storeName(k.storeId), m.month === "total" ? "累計" : m.month, m.mite.orders, m.mite.qty, m.reform.orders, m.reform.sales]);
    }
  }
  const label = `商品の KPI (${SECTIONS[section]} · ${fy}年度 · ${storeIds.length === 1 ? storeName(storeIds[0]) : "全店"})`;
  await mutate((d) => {
    addAudit(d, { userId: sessionUser.id, action: "export", entity: "data", entityId: `promo_products_${section}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: storeIds.length === 1 ? storeIds[0] : undefined });
  });
  const name = `promo_products_${section}_${fy}${storeIds.length === 1 ? `_${storeIds[0]}` : ""}.csv`;
  return new NextResponse(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
