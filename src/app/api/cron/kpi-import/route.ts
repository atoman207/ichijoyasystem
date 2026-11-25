import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import { addAudit, mutate, nowIso, syncDb } from "@/lib/db/store";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { toDateKey } from "@/lib/format";
import { writeKpiBasis } from "@/lib/kpi-basis";
import { applyBasisImport, basisSheetsFromFiles, planBasisImport, readBasisSheets } from "@/lib/kpi-basis-import";
import { keepKpiSheetFromTabs, kpiCheck, readKpiSheet } from "@/lib/kpi-check";
import { tabsFromFiles } from "@/lib/survey-workbook/read";
import { applyWorkbook, planWorkbook } from "@/lib/survey-workbook/plan";
import { workbookTablesMissing } from "@/lib/survey-workbook/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * KPI の取込を開発担当がサーバーの中から行う入口 (ログインなし・CRON_SECRET で確かめる)。
 * お客様は画面 KPI →「分母・照合」「スプレッドシートの取込」で同じことができる (画面のファイルの上限 4・10 MB を超える .xlsx のとき・
 * 試験期間にテスト用のサーバーへ取り込むときに使う)。scripts/ops/import-kpi-sheets.mjs から呼ぶ。本体は multipart の files
 *   kind=basis    年間チラシ計画「個人件数売上」・アンケートハガキ（回答）「フォームの回答 1」(kpi-basis-import.ts)
 *   kind=workbook お客様アンケート集計表 (クレーム・手直し・口コミ・過去の集計・KPI のタブ。survey-workbook/plan.ts)
 *   action=plan   確認 (書き込まない) / action=apply 取り込む (操作した人 = システム) / action=check 支給前の照合 (KPI のタブ。kpi-check.ts)
 */
const MAX_BYTES = 40 * 1024 * 1024;

export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const kind = url.searchParams.get("kind");
  const db0 = await syncDb();

  if (action === "check") {
    const sheet = await readKpiSheet();
    if (!sheet) return NextResponse.json({ error: "KPI のタブがまだありません (kind=workbook で取り込むと残ります)" }, { status: 404 });
    const r = kpiCheck(db0, sheet);
    return NextResponse.json({ ok: true, label: sheet.label, problems: r.problems, years: r.years.map((y) => ({ label: y.label, period: y.period, compared: y.compared, matched: y.matched, differ: y.differ, sheetErrors: y.sheetErrors, pending: y.pending, rows: y.rows })) });
  }

  if ((action !== "plan" && action !== "apply") || (kind !== "basis" && kind !== "workbook")) return NextResponse.json({ error: "action=plan|apply|check, kind=basis|workbook" }, { status: 400 });
  const form = await req.formData().catch(() => null);
  const files = (form?.getAll("files") ?? []).filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "files がありません" }, { status: 400 });
  if (files.reduce((a, f) => a + f.size, 0) > MAX_BYTES) return NextResponse.json({ error: "ファイルが大きすぎます (合計 40 MB まで)" }, { status: 413 });
  const read = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const label = files.map((f) => f.name).join("・").slice(0, 120);
  const now = nowIso();

  if (kind === "basis") {
    const sh = basisSheetsFromFiles(read);
    const pv = { ...readBasisSheets(sh.sheets), label };
    pv.problems = [...sh.problems, ...pv.problems];
    if (!pv.individual.length && !pv.cardMonths.length) return NextResponse.json({ error: pv.problems.join(" / ") || "読み取れるシートがありません" }, { status: 422 });
    if (action === "plan") {
      const plan = planBasisImport(db0, pv);
      const c = plan.cards;
      return NextResponse.json({
        ok: true,
        problems: pv.problems,
        individual: { counts: plan.counts.individual, values: plan.individual.map((v) => ({ storeId: v.storeId, month: v.month, value: v.value, action: v.action, current: v.current })) },
        cards: { changes: c.changes.length, unchanged: c.unchanged, notInSystem: c.notInSystem, mismatch: c.mismatch, adds: c.adds.length, unresolved: c.unresolved, newCards: c.newCards.length, registered: c.registered, newByMonth: c.newCards.reduce<Record<string, number>>((m, x) => ({ ...m, [x.month || "(月なし)"]: (m[x.month || "(月なし)"] ?? 0) + 1 }), {}), unresolvedNames: [...new Set(c.newCards.flatMap((x) => x.unresolvedNames))] },
      });
    }
    let summary = "";
    await mutate((db) => {
      const { basis, result } = applyBasisImport(db, pv, { userId: SYSTEM_USER, now });
      summary = result.summary;
      writeKpiBasis(db, basis, SYSTEM_USER, now);
      addAudit(db, { userId: SYSTEM_USER, action: "import", entity: "kpi_basis", entityId: "kpi_basis", entityLabel: "KPI の分母・はがきの集計月", summary: `KPI の分母・はがきの集計月を取込 (${label}): ${summary}`, storeId: "hq", changes: result.changedMonths.slice(0, 80) });
    });
    revalidatePath("/kpi", "layout");
    return NextResponse.json({ ok: true, summary });
  }

  // お客様アンケート集計表
  const r = tabsFromFiles(read);
  if (!r.tabs.length) return NextResponse.json({ error: r.problems.join(" / ") || "読み取れるタブがありません" }, { status: 422 });
  const startYear = /^20\d\d$/.test(url.searchParams.get("startYear") ?? "") ? Number(url.searchParams.get("startYear")) : undefined;
  const today = toDateKey(new Date());
  if (action === "plan") {
    const plan = planWorkbook(db0, r.tabs, { today, startYear });
    return NextResponse.json({
      ok: true,
      problems: [...r.problems, ...plan.problems],
      warnings: plan.warnings,
      tabs: plan.tabs,
      claims: { ...plan.claims, items: undefined },
      reviews: { ...plan.reviews, items: undefined },
      history: { ...plan.history, rows: undefined },
      kpi: plan.kpi.map((y) => ({ label: y.label, compared: y.compared, matched: y.matched, differ: y.differ, sheetErrors: y.sheetErrors, pending: y.pending })),
    });
  }
  if (await workbookTablesMissing()) return NextResponse.json({ error: "取込の表がまだありません (npm run db:migrate)" }, { status: 409 });
  let summary = "";
  await mutate((db) => {
    summary = applyWorkbook(db, r.tabs, { today, startYear, userId: SYSTEM_USER, label }).summary;
  });
  await keepKpiSheetFromTabs(r.tabs, label, SYSTEM_USER, now);
  revalidatePath("/kpi", "layout");
  return NextResponse.json({ ok: true, summary });
}
