import { NextResponse, after } from "next/server";
import { mutate, syncDb } from "@/lib/db/store";
import { faxConnection } from "@/lib/fax/adapter";
import { analyzeAndLink, FaxError, MAX_FAX_BYTES, receiveFax } from "@/lib/fax/inbound";
import { applyRemoteStatus } from "@/lib/fax/outbound";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { faxTablesMissing } from "@/lib/fax/tables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * クラウド FAX サービスからの通知 (受信・送信の状態の変化)
 * POST /api/integrations/fax  (形式と署名は FAX サービスごと。src/lib/fax/adapter.ts のアダプターが確かめて読む)
 * - 受信: PDF を保存して FAX の記録を作り (同じ ID は 1 回だけ)、応答のあとに AI で判定・ひも付け
 * - 状態: 送信の記録を 成功 / 失敗 にする
 * 未接続のときは 503、署名が正しくなければ 401
 */
export async function POST(req: Request) {
  const conn = faxConnection();
  if (conn.mode !== "mock" && conn.mode !== "live") return NextResponse.json({ error: "fax is not configured" }, { status: 503 });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_FAX_BYTES * 1.4 + 100_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > MAX_FAX_BYTES * 1.4 + 100_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const events = await conn.adapter.parseWebhook(req.headers, body);
  if (!events) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // テーブルの反映前は 503 (FAX サービスがあとで送り直す)
  if (await faxTablesMissing()) return NextResponse.json({ error: "database tables are not ready" }, { status: 503 });
  await syncDb();
  let received = 0;
  let duplicate = 0;
  let updated = 0;
  const analyze: string[] = [];
  for (const e of events) {
    if (e.type === "received") {
      try {
        const r = await receiveFax({ provider: conn.adapter.name, providerId: e.providerId, from: e.from, to: e.to, receivedAt: e.receivedAt, pages: e.pages, bytes: e.pdf, fileName: e.fileName, text: e.text, userId: SYSTEM_USER });
        if (r.created) {
          received += 1;
          if (r.fax.aiPending) analyze.push(r.fax.id);
        } else duplicate += 1;
      } catch (err) {
        if (err instanceof FaxError) return NextResponse.json({ error: err.message }, { status: 400 });
        throw err;
      }
    } else {
      const ref = `${conn.adapter.name}:${e.providerId}`;
      const hit = await mutate((db) => {
        const x = db.faxMessages.find((f) => f.providerRef === ref);
        if (!x) return false;
        applyRemoteStatus(db, x, { status: e.status, error: e.error, pages: e.pages, completedAt: e.at });
        return true;
      });
      if (hit) updated += 1;
    }
  }
  // AI の判定は応答のあと (FAX サービスの待ち時間を短くする。失敗したものは定期実行で読み直す)
  if (analyze.length) after(async () => {
    for (const id of analyze) await analyzeAndLink(id).catch((err) => console.warn("[fax] analyze failed:", (err as Error).message));
  });
  return NextResponse.json({ ok: true, received, duplicate, updated });
}
