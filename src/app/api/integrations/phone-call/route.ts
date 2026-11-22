import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb, mutate, syncDb } from "@/lib/db/store";
import { phoneIntakeSecret } from "@/lib/notify/config";
import { domesticPhone, normalizeIntake } from "@/lib/ai-intake";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { readReception } from "@/lib/ai/reception";
import { withAiContext } from "@/lib/ai/usage";
import { toDateKey } from "@/lib/format";
import { normalizeReception, receptionHref, type ReceptionMeta } from "@/lib/reception";
import { newReceptionDoc, pushReceptionDoc, storeOfCall } from "@/lib/reception-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 電話のシステム (通話の録音・文字起こしができるクラウド電話・IP 電話など) からの通話の内容
 * POST /api/integrations/phone-call
 *   認証: ヘッダー Authorization: Bearer <PHONE_INTAKE_SECRET> (ヘッダーを設定できないシステムは ?token=<PHONE_INTAKE_SECRET>)
 *   本文: JSON。通話 ID (callId / id)・発信元 (from)・着信先 (to)・向き (direction: inbound / outbound)・開始 (startedAt)・
 *         長さ (duration 秒)・文字起こし (transcript: 文字列か [{speaker, text}])・要約 (summary)・録音の URL (recordingUrl。https のみ)・
 *         内線 (extension)・受けた社員 (staff: メール・名前)・店舗 (store)。項目名の違いは normalizeIntake (src/lib/ai-intake.ts) と同じに吸収する
 *   動き: AI が会話から項目と内容の種類 (新しい問い合わせ / 進行中の案件 / 仕入先 / 営業電話 …) を読み取り、確認待ちの受付にする。
 *         問い合わせ・案件の記録には、担当者が受付の画面で確かめてから登録する (AI の判定だけでは登録しない)
 *   応答: { ok: true, receptionId, href, duplicate? }。同じ通話 ID は 1 件だけ。文字起こしが短すぎる通話 (無言・すぐ切れた) は登録しない (skipped)
 */
export async function POST(req: Request) {
  const secret = phoneIntakeSecret();
  if (!secret) return NextResponse.json({ error: "PHONE_INTAKE_SECRET is not configured" }, { status: 503 });
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-phone-intake-secret") ?? url.searchParams.get("token") ?? "";
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
  const { input } = normalizeIntake(payload, "phone");
  const text = [input?.transcript, !input?.transcript ? [input?.summary, input?.detail].filter(Boolean).join("\n") : ""].filter(Boolean).join("\n").trim();
  const callId = String(input?.externalId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const val = (k: string[]) => {
    for (const key of k) {
      const v = payload[key];
      if (typeof v === "string" || typeof v === "number") return String(v).trim();
    }
    return "";
  };
  const to = val(["to", "callee", "calledNumber", "called_number", "dialedNumber", "dialed_number", "着信番号"]);
  const direction = /out|発信/i.test(val(["direction", "callDirection", "call_direction", "向き"])) ? "outbound" : "inbound";
  const extension = val(["extension", "ext", "内線"]);
  const durationSec = Number(val(["duration", "durationSec", "duration_sec", "callDuration", "通話時間"])) || undefined;
  if (text.replace(/\s/g, "").length < 15) return NextResponse.json({ ok: true, skipped: "no transcript" });
  const db = await syncDb();
  const id = callId ? `doc_call_${callId}`.slice(0, 80) : "";
  if (id && db.documents.some((d) => d.id === id)) return NextResponse.json({ ok: true, receptionId: id, href: receptionHref(id), duplicate: true });
  const call: ReceptionMeta["call"] = {
    id: callId || undefined,
    from: input?.phone ?? domesticPhone(val(["from", "caller"])) ?? undefined,
    to: to || undefined,
    direction,
    startedAt: input?.receivedAt,
    durationSec,
    recordingUrl: input?.recordingUrl,
    extension: extension || undefined,
    staff: input?.assignee,
  };
  const storeId = storeOfCall(db, { store: input?.store, to, staff: input?.assignee });
  const read = await withAiContext({ kind: "reception" }, () => readReception(db, { text, today: toDateKey(new Date()) }));
  // 電話のシステムが知っている発信元の番号は、会話で読み取れなかったときの電話番号にする (発信のときは相手 = 着信先)
  const other = direction === "outbound" ? domesticPhone(to) : call.from;
  if (!read.fields.phone && other) read.fields = normalizeReception({ ...read.fields, phone: other });
  const docId = id || `doc_call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const created = await mutate((d) => {
    if (d.documents.some((x) => x.id === docId)) return false;
    const doc = newReceptionDoc({ id: docId, uploadedBy: SYSTEM_USER, storeId, source: "phone_api", channel: "phone", fileName: `通話 ${call.from ?? "番号非通知"} ${call.startedAt ? new Date(call.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""}`.trim(), text, call, read });
    pushReceptionDoc(d, doc, SYSTEM_USER);
    return true;
  });
  return NextResponse.json({ ok: true, receptionId: docId, href: receptionHref(docId), ...(created ? {} : { duplicate: true }), store: getDb().stores.find((s) => s.id === storeId)?.name });
}
