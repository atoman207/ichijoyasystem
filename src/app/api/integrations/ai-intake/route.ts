import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb, mutate, syncDb } from "@/lib/db/store";
import { aiIntakeSecret } from "@/lib/notify/config";
import { normalizeIntake, recordAiIntake } from "@/lib/ai-intake";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { taskNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受付情報
 * POST /api/integrations/ai-intake?source=chat|voice|phone
 *   認証: ヘッダー Authorization: Bearer <AI_INTAKE_SECRET> (ヘッダーを設定できないシステムは ?token=<AI_INTAKE_SECRET>)
 *   本文: JSON (またはフォーム形式)。項目名は src/lib/ai-intake.ts の normalizeIntake を参照 (name / phone / summary / transcript など)
 *   応答: { ok: true, number, inquiryId, customerMatched, handoff: { assignee } | null, duplicate? }
 */
export async function POST(req: Request) {
  const secret = aiIntakeSecret();
  if (!secret) return NextResponse.json({ error: "AI_INTAKE_SECRET is not configured" }, { status: 503 });
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-ai-intake-secret") ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = await req.text();
  if (raw.length > 512_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  let payload: Record<string, unknown>;
  try {
    payload = (req.headers.get("content-type") ?? "").includes("application/json") || /^\s*[{[]/.test(raw) ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const { input, error } = normalizeIntake(payload, url.searchParams.get("source") ?? undefined);
  if (!input) return NextResponse.json({ error }, { status: 400 });
  await syncDb();
  const r = await mutate((db) => recordAiIntake(db, input));
  // 引き継ぎ先への通知 (メール・Chatwork の設定があるとき。ないときは送信履歴に「記録のみ」)
  if (r.created && r.thread) {
    const db = getDb();
    const t = db.threads.find((x) => x.id === r.thread!.id);
    if (t) await sendAndRecord(taskNotices(db, t, t.createdBy === SYSTEM_USER ? SYSTEM_USER : t.createdBy, "request", r.inquiry.summary), SYSTEM_USER).catch((err) => console.warn("[ai-intake] notify failed:", (err as Error).message));
  }
  const assignee = r.thread ? getDb().users.find((u) => u.id === r.thread!.assigneeIds?.[0]) : undefined;
  return NextResponse.json({
    ok: true,
    number: r.inquiry.number,
    inquiryId: r.inquiry.id,
    customerMatched: r.customerMatched,
    handoff: assignee ? { assignee: assignee.name, taskId: r.thread!.id } : null,
    ...(r.duplicate ? { duplicate: true } : {}),
  });
}
