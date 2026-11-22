import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb, mutate, syncDb } from "@/lib/db/store";
import { webformSecret } from "@/lib/notify/config";
import { SYSTEM_USER, recordWebForm, type WebFormInput } from "@/lib/notify/inbound";
import { storeInquiryNotices } from "@/lib/notify/store-line";
import { sendAndRecord } from "@/lib/notify/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIELDS: (keyof WebFormInput)[] = ["id", "name", "kana", "phone", "email", "postalCode", "address", "category", "message", "store"];

/**
 * Web サイトのお問い合わせフォームの受信 (サーバーから送る。共有鍵をブラウザに置かない)
 * POST /api/integrations/webform  ヘッダー Authorization: Bearer <WEBFORM_SECRET>
 * 本文 (JSON または フォーム形式): name・message は必須。kana・phone・email・postalCode・address・category (畳 / 襖 …)・store (店舗名)・id (フォーム側の受付番号。同じ id は 1 件だけ登録)
 * 応答: { ok: true, number: "INQ-2026-0123", duplicate?: true }
 */
export async function POST(req: Request) {
  const secret = webformSecret();
  if (!secret) return NextResponse.json({ error: "WEBFORM_SECRET is not configured" }, { status: 503 });
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-webform-secret") ?? "";
  const a = Buffer.from(auth);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = await req.text();
  if (raw.length > 64_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  let data: Record<string, unknown> = {};
  try {
    data = (req.headers.get("content-type") ?? "").includes("application/json") ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const input: WebFormInput = {};
  for (const k of FIELDS) if (data[k] != null) input[k] = String(data[k]).slice(0, k === "message" ? 4000 : 200);
  await syncDb();
  const r = await mutate((db) => recordWebForm(db, input));
  if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
  // 店舗が決まった新しい問い合わせは、その店舗の LINE グループ (店舗別・問い合わせを知らせる) に送る
  if (r.created && r.inquiry) await sendAndRecord(storeInquiryNotices(getDb(), r.inquiry), SYSTEM_USER).catch((err) => console.warn("[webform] store LINE notice failed:", (err as Error).message));
  return NextResponse.json({ ok: true, number: r.inquiry?.number, duplicate: !r.created || undefined });
}
