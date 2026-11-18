import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FaxAdapter, FaxWebhookEvent } from "./adapter";

/**
 * 模擬の FAX サービス (サンプルデータの検証環境だけ。adapter.ts の faxConnection が DATA_BACKEND=json のときだけ使う)
 * ------------------------------------------------------------
 * 実際には送らない。送信先の番号の末尾で結果を変えて、失敗・再送・要確認の流れを確かめられる:
 *   …0000 → 送信失敗 (番号が使われていない。再送しない)
 *   …9999 → FAX サービスに接続できない (通信エラー。自動で再送する)
 *   …7777 → 依頼のあとに通信が切れる (要確認。自動では再送しない)
 *   …8888 → 受け付けたあと、相手先が話し中で失敗
 *   それ以外 → 受け付けて、数秒後に送信成功
 * 通知 (Webhook) は JSON。ヘッダー x-fax-signature に本文の HMAC-SHA256 (16 進。鍵は FAX_WEBHOOK_SECRET)
 */

interface MockJob {
  to: string;
  at: number;
}

const g = globalThis as unknown as { __ichijoyaMockFax?: Map<string, MockJob> };
const jobs = (g.__ichijoyaMockFax ??= new Map());

const SEND_DELAY_MS = 3000;

export function mockSignature(body: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function mockFaxAdapter(): FaxAdapter {
  return {
    name: "mock",
    label: "模擬 (検証環境)",
    mode: "mock",
    async send(req) {
      if (req.to.endsWith("0000")) return { ok: false, kind: "permanent", message: "相手先の FAX 番号が使われていません (模擬)" };
      if (req.to.endsWith("9999")) return { ok: false, kind: "retryable", message: "FAX サービスに接続できませんでした (模擬の通信エラー)" };
      if (req.to.endsWith("7777")) return { ok: false, kind: "unknown", message: "送信の依頼のあとに通信が切れました (模擬)" };
      const providerId = `mock-${req.reference}`;
      jobs.set(providerId, { to: req.to, at: Date.now() });
      return { ok: true, providerId, status: "sending", pages: 1 };
    },
    async status(providerId) {
      const job = jobs.get(providerId);
      // サーバーを起動し直して記録がないときは、送信済みとして扱う (模擬のみ)
      if (!job) return { status: "sent", pages: 1, completedAt: new Date().toISOString() };
      if (Date.now() - job.at < SEND_DELAY_MS) return { status: "sending" };
      if (job.to.endsWith("8888")) return { status: "failed", error: "相手先が話し中のため送信できませんでした (模擬)" };
      return { status: "sent", pages: 1, completedAt: new Date(job.at + SEND_DELAY_MS).toISOString() };
    },
    async parseWebhook(headers, body) {
      const secret = (process.env.FAX_WEBHOOK_SECRET ?? "").trim();
      if (!secret) return null;
      const given = Buffer.from(headers.get("x-fax-signature") ?? "");
      const want = Buffer.from(mockSignature(body, secret));
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        return [];
      }
      const list = Array.isArray(data.events) ? (data.events as Record<string, unknown>[]) : [data];
      const out: FaxWebhookEvent[] = [];
      for (const e of list) {
        const id = String(e.id ?? e.providerId ?? "").slice(0, 120);
        if (!id) continue;
        if (e.type === "received" && typeof e.pdfBase64 === "string") {
          out.push({
            type: "received",
            providerId: id,
            from: String(e.from ?? ""),
            to: e.to ? String(e.to) : undefined,
            receivedAt: typeof e.receivedAt === "string" && !Number.isNaN(Date.parse(e.receivedAt)) ? e.receivedAt : new Date().toISOString(),
            pages: Number.isFinite(Number(e.pages)) ? Number(e.pages) : undefined,
            pdf: Buffer.from(e.pdfBase64, "base64"),
            fileName: e.fileName ? String(e.fileName).slice(0, 120) : undefined,
            contentType: e.contentType ? String(e.contentType) : undefined,
            text: typeof e.text === "string" ? e.text.slice(0, 4000) : undefined,
          });
        } else if (e.type === "status" && (e.status === "sending" || e.status === "sent" || e.status === "failed")) {
          out.push({ type: "status", providerId: id, status: e.status, error: e.error ? String(e.error).slice(0, 300) : undefined, at: typeof e.at === "string" ? e.at : undefined });
        }
      }
      return out;
    },
  };
}
