import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { mutate, syncDb } from "@/lib/db/store";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { isDateKey } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { staffMatcher } from "@/lib/survey-workbook/staff";
import { readScheduleWorkbook } from "@/lib/schedule-sheet/read";
import { BATCH_RE, addMonthToBatch, newBatchId, readBatchMonths, removeBatch } from "@/lib/schedule-sheet/batch";
import { applySheetImport, planSheetImport, sheetSettings, writeSheetSettings } from "@/lib/schedule-sheet/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 予定表 (スプレッドシート) の取込を開発担当がサーバーの中から行う入口 (ログインなし・CRON_SECRET で確かめる。
 * お客様は画面 予定表 →「スプレッドシートの取込」で同じことができる)。scripts/ops/import-schedule-sheet.mjs から呼ぶ
 *   action=upload&name=<ファイル名>[&batch=]  本体 = .xlsx → { batch, … }
 *   action=alias   本体 = JSON { "<シートの名前>": "<社員の ID / 社員の名前 / ->" }
 *   action=plan&batch=&from=   照合の結果 (書き込まない)
 *   action=apply&batch=&from=  取り込む (操作した人 = システム)
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const today = toDateKey(new Date());
  const fromParam = url.searchParams.get("from") ?? "";
  const from = isDateKey(fromParam) ? fromParam : addDays(today, 1);
  if (from < today) return NextResponse.json({ error: "from は今日以降にしてください" }, { status: 400 });
  const db0 = await syncDb();

  if (action === "upload") {
    const name = url.searchParams.get("name") ?? "";
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) return NextResponse.json({ error: "ファイルが空か大きすぎます" }, { status: 400 });
    const batch = BATCH_RE.test(url.searchParams.get("batch") ?? "") ? url.searchParams.get("batch")! : newBatchId();
    try {
      const month = readScheduleWorkbook(name, bytes, db0.stores.map((s) => ({ id: s.id, name: s.name, shortName: s.shortName })));
      await addMonthToBatch(batch, SYSTEM_USER, name, month);
      return NextResponse.json({ ok: true, batch, label: month.label, days: month.days.length, events: month.events.length, persons: month.persons, problems: month.problems });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 });
    }
  }

  if (action === "alias") {
    const body = (await req.json().catch(() => null)) as Record<string, string> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON で { シートの名前: 社員 } を送ってください" }, { status: 400 });
    const users = db0.users.filter((u) => !u.id.startsWith("u_review"));
    const match = staffMatcher(users);
    const resolved: Record<string, string> = {};
    for (const [name, v] of Object.entries(body)) {
      const val = String(v ?? "").trim();
      const id = val === "-" || val === "" ? val : users.some((u) => u.id === val) ? val : match(val).userId;
      if (id === undefined) return NextResponse.json({ error: `「${val}」に当たる社員がいません (1 人に決まりません)` }, { status: 422 });
      resolved[name.trim().slice(0, 30)] = id;
    }
    await mutate((db) => {
      const s = sheetSettings(db);
      for (const [name, id] of Object.entries(resolved)) {
        if (id) s.aliases[name] = id;
        else delete s.aliases[name];
      }
      writeSheetSettings(db, s, SYSTEM_USER);
    });
    return NextResponse.json({ ok: true, aliases: Object.fromEntries(Object.entries(resolved).map(([k, id]) => [k, id === "-" ? "-" : (db0.users.find((u) => u.id === id)?.name ?? id)])) });
  }

  const batch = url.searchParams.get("batch") ?? "";
  if (!BATCH_RE.test(batch)) return NextResponse.json({ error: "batch が正しくありません" }, { status: 400 });
  const loaded = await readBatchMonths(batch);
  if (!loaded?.months.length) return NextResponse.json({ error: "読み込んだファイルがありません" }, { status: 404 });

  if (action === "plan") {
    const plan = planSheetImport(db0, loaded.months, { from });
    const name = (id?: string) => db0.users.find((u) => u.id === id)?.name ?? "";
    return NextResponse.json({
      ok: true,
      from: plan.from,
      to: plan.to,
      months: plan.months,
      counts: plan.counts,
      persons: plan.persons.map((p) => ({ name: p.name, count: p.count, user: p.userName ?? null })),
      unknownNames: plan.unknownNames.slice(0, 40),
      ambiguous: plan.groups.filter((g) => g.ambiguous).slice(0, 60).map((g) => ({ name: `${g.area ? `(${g.area})` : ""}${g.name}`, chosen: g.candidates.find((c) => c.id === g.auto)?.label, candidates: g.candidates.slice(0, 4).map((c) => c.label) })),
      duplicates: plan.items.filter((i) => i.status === "duplicate").map((i) => `${i.ev.date} ${i.title} = ${i.dupOf?.title}`),
      remove: plan.remove.map((r) => `${r.date} ${r.title}`),
      kept: plan.keep.map((k) => `${k.date} ${k.title}`),
      sample: plan.items.slice(0, 30).map((i) => `${i.ev.date} ${i.status} [${i.storeId}] ${i.ev.kind} ${i.title}${i.assigneeIds.length ? ` 担当 ${i.assigneeIds.map(name).join("・")}` : ""}`),
    });
  }

  if (action === "apply") {
    let summary = "";
    await mutate((db) => {
      const plan = planSheetImport(db, loaded.months, { from });
      summary = applySheetImport(db, plan, { id: SYSTEM_USER }, loaded.months.map((m) => m.label).join("・")).summary;
    });
    await removeBatch(batch);
    return NextResponse.json({ ok: true, summary });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
