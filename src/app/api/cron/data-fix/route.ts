import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { addAudit, mutate, nowIso, syncDb } from "@/lib/db/store";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { categoryName } from "@/lib/mgmt/categories";
import { applyLineFixes, planLineFixes } from "@/lib/quote-line-normalize";
import { isDateKey } from "@/lib/calendar";
import { addDays } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 運用のデータの手直し (サーバーの中から 1 回だけ実行する。ログインなし・CRON_SECRET で確かめる)
 *   task = quote-line-units: 見積の明細の単位・品目を品名・仕様からそろえる (src/lib/quote-line-normalize.ts。
 *     お客様のご要望 2026-11-23「■1」の「今日登録したものも反映」)。from・to = 見積の作成日 (日本時間の日付。to を含む)
 *   既定は確認だけ (直す内容を返す)。apply=1 で書き込み、見積ごとに変更履歴を残す
 * 例: curl -X POST -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3300/api/cron/data-fix?task=quote-line-units&from=2026-11-23&to=2026-11-23&apply=1"
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const task = url.searchParams.get("task");
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
