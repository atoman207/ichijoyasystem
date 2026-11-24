import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { addAudit, mutate, nowIso, syncDb } from "@/lib/db/store";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { categoryName } from "@/lib/mgmt/categories";
import { applyLineFixes, planLineFixes } from "@/lib/quote-line-normalize";
import { isDateKey } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { isOnsiteQuoteText, isSiteSurveyText } from "@/lib/schedule-sheet/parse";
import { SHEET_REF_PREFIX, eventFingerprint, sheetSettings, writeSheetSettings } from "@/lib/schedule-sheet/plan";
import type { Database, ScheduleKind } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 運用のデータの手直し (サーバーの中から 1 回だけ実行する。ログインなし・CRON_SECRET で確かめる)
 *   task = quote-line-units: 見積の明細の単位・品目を品名・仕様からそろえる (src/lib/quote-line-normalize.ts。
 *     お客様のご要望 2026-11-23「■1」の「今日登録したものも反映」)。from・to = 見積の作成日 (日本時間の日付。to を含む)
 *   既定は確認だけ (直す内容を返す)。apply=1 で書き込み、見積ごとに変更履歴を残す
 * 例: curl -X POST -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3300/api/cron/data-fix?task=quote-line-units&from=2026-11-23&to=2026-11-23&apply=1"
 *   task = store-name: 店舗の名前・略称を変える (id・name・short。お客様のご要望 2026-11-23「本社」→「本部」。画面では 設定 → 店舗)。
 *     既定は確認だけ、apply=1 で書き込み、変更履歴を残す
 *   task = schedule-kinds (旧 schedule-onsite): 予定表 (スプレッドシート) から取り込んだ「現見」「現調」の予定を、見積りから
 *     現場見積 (現見)・現地調査 (現調) にする (お客様のご要望 2026-11-24「■2」「業務フロー ③」。種類を足す前に取り込んだ予定)。
 *     from = この日以降の予定 (既定は今日)。既定は確認だけ、apply=1 で書き込み、予定ごとに変更履歴
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const task = url.searchParams.get("task");
  if (task === "store-name") return storeName(url);
  if (task === "schedule-onsite" || task === "schedule-kinds") return scheduleOnsite(url);
  if (task !== "quote-line-units") return NextResponse.json({ error: "unknown task" }, { status: 400 });
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? from;
  if (!isDateKey(from) || !isDateKey(to) || to < from) return NextResponse.json({ error: "from / to (YYYY-MM-DD) が正しくありません" }, { status: 400 });
  // 日本時間の日付 → UTC の日時の範囲
  const range = { from: new Date(`${from}T00:00:00+09:00`).toISOString(), to: new Date(`${addDays(to, 1)}T00:00:00+09:00`).toISOString() };
  const apply = url.searchParams.get("apply") === "1";

  const db0 = await syncDb();
  const plan = planLineFixes(db0, range);
  if (!apply || !plan.length) return NextResponse.json({ ok: true, applied: false, range, fixes: plan });

  const applied = await mutate((db) => {
    const fixes = planLineFixes(db, range);
    const now = nowIso();
    const byQuote = applyLineFixes(db, fixes, now);
    for (const [quoteId, list] of byQuote) {
      const q = db.quotes.find((x) => x.id === quoteId)!;
      const text = list.map((f) => `${f.line}行目 ${f.name.slice(0, 20)} ${f.field === "unit" ? "単位" : "品目"} ${f.field === "unit" ? (f.before ?? "") : f.before ? categoryName(db, f.before) : "自動"} → ${f.field === "unit" ? f.after : categoryName(db, f.after)}`);
      addAudit(db, {
        userId: SYSTEM_USER,
        action: "update",
        entity: "quote",
        entityId: q.id,
        entityLabel: q.number,
        summary: `明細の単位・品目を品名からそろえました (${list.length} か所。金額は変わりません): ${text.join(" / ").slice(0, 300)}`,
        storeId: q.storeId,
        changes: [{ field: "items", before: list.map((f) => ({ line: f.line, field: f.field, value: f.before ?? "" })), after: list.map((f) => ({ line: f.line, field: f.field, value: f.after })) }],
      });
    }
    return fixes;
  });
  return NextResponse.json({ ok: true, applied: true, range, fixes: applied });
}

/** 店舗の名前・略称 (設定 → 店舗 と同じ変更。変更履歴つき) */
async function storeName(url: URL) {
  const id = url.searchParams.get("id") ?? "";
  const name = (url.searchParams.get("name") ?? "").trim().slice(0, 30);
  const short = (url.searchParams.get("short") ?? "").trim().slice(0, 10);
  const apply = url.searchParams.get("apply") === "1";
  const db0 = await syncDb();
  const s0 = db0.stores.find((s) => s.id === id);
  if (!s0) return NextResponse.json({ error: "店舗がありません" }, { status: 404 });
  if (!name || !short) return NextResponse.json({ error: "name と short を指定してください" }, { status: 400 });
  if (db0.stores.some((s) => s.id !== id && s.name === name)) return NextResponse.json({ error: "ほかの店舗と同じ名前です" }, { status: 400 });
  const plan = { id, before: { name: s0.name, shortName: s0.shortName }, after: { name, shortName: short } };
  if (!apply || (s0.name === name && s0.shortName === short)) return NextResponse.json({ ok: true, applied: false, plan });
  await mutate((db) => {
    const s = db.stores.find((x) => x.id === id)!;
    const changes = [
      ...(s.name !== name ? [{ field: "name", before: s.name, after: name }] : []),
      ...(s.shortName !== short ? [{ field: "shortName", before: s.shortName, after: short }] : []),
    ];
    s.name = name;
    s.shortName = short;
    addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "store", entityId: id, entityLabel: name, summary: `店舗の名前を変更 (${plan.before.name} → ${name}・略称 ${plan.before.shortName} → ${short})`, changes });
  });
  return NextResponse.json({ ok: true, applied: true, plan, at: nowIso() });
}

/** 予定表から取り込んだ「現見」「現調」の予定 (見積りのまま) → 直す種類 */
const KIND_TITLE: Partial<Record<ScheduleKind, string>> = { onsite_quote: "現場見積", site_survey: "現地調査" };
function kindFix(e: { source?: string; kind: string; sourceRef?: string }): ScheduleKind | undefined {
  if (e.source !== "import" || e.kind !== "survey" || !e.sourceRef?.startsWith(SHEET_REF_PREFIX)) return undefined;
  // 印 = sheet:<日付>|<店舗>|<欄>|<…>|<書き込み>
  const raw = e.sourceRef.slice(SHEET_REF_PREFIX.length).split("|").slice(4).join("|");
  return isOnsiteQuoteText(raw) ? "onsite_quote" : isSiteSurveyText(raw) ? "site_survey" : undefined;
}
function onsiteTargets(db: Pick<Database, "schedule">, from: string) {
  return db.schedule.filter((e) => e.date >= from && kindFix(e));
}

async function scheduleOnsite(url: URL) {
  const fromParam = url.searchParams.get("from") ?? "";
  const from = isDateKey(fromParam) ? fromParam : toDateKey(new Date());
  const apply = url.searchParams.get("apply") === "1";
  const db0 = await syncDb();
  const list = (db: Pick<Database, "schedule">) => onsiteTargets(db, from).map((e) => ({ id: e.id, date: e.date, title: e.title, kind: kindFix(e), ref: e.sourceRef }));
  const plan = list(db0);
  if (!apply || !plan.length) return NextResponse.json({ ok: true, applied: false, from, events: plan });
  const done = await mutate((db) => {
    const targets = onsiteTargets(db, from);
    const settings = sheetSettings(db);
    const now = nowIso();
    const out: { id: string; date: string; title: string; kind: string }[] = [];
    for (const e of targets) {
      const kind = kindFix(e)!;
      const before = { kind: e.kind, title: e.title };
      e.kind = kind;
      e.title = e.title.replace(/\s*(?:現地調査・見積|見積)$/, ` ${KIND_TITLE[kind]}`);
      e.updatedAt = now;
      // 取込で書いた予定の印も新しい内容にする (次の取込で「新システムで変えた予定」と取り違えない)
      const written = settings.written ?? {};
      if (written[e.id]) written[e.id] = eventFingerprint(e);
      settings.written = written;
      addAudit(db, {
        userId: SYSTEM_USER,
        action: "update",
        entity: "schedule",
        entityId: e.id,
        entityLabel: e.title,
        summary: `予定表の「${kind === "onsite_quote" ? "現見" : "現調"}」の予定を、見積りから${kind === "onsite_quote" ? "現場見積 (現見)" : "現地調査 (現調)"}にしました (種類の追加にあわせて)`,
        storeId: e.storeId,
        changes: [
          { field: "kind", before: before.kind, after: e.kind },
          ...(before.title !== e.title ? [{ field: "title", before: before.title, after: e.title }] : []),
        ],
      });
      out.push({ id: e.id, date: e.date, title: e.title, kind });
    }
    if (targets.length) writeSheetSettings(db, settings, SYSTEM_USER);
    return out;
  });
  return NextResponse.json({ ok: true, applied: true, from, events: done });
}
