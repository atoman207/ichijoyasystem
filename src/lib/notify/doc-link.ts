import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appBaseUrl, linkSecret } from "./config";

/**
 * 見積書・請求書・領収書の共有リンク (ログインなしで PDF を開く。期限つき)
 * ------------------------------------------------------------
 * LINE では PDF を添付できないため、お客様には期限つきのリンクを送る。
 * URL: /api/doc/<kind>/<id>?exp=<期限 (UNIX 秒)>&sig=<署名>
 * 署名は種類・ID・期限を秘密の鍵で HMAC したもの。ID や期限を書き換えたリンクは開けない
 */

export type DocKind = "quote" | "invoice" | "receipt";
export const DOC_KINDS: DocKind[] = ["quote", "invoice", "receipt"];

const DAY = 86400;

function sign(kind: DocKind, id: string, exp: number): string {
  return createHmac("sha256", linkSecret()).update(`${kind}:${id}:${exp}`).digest("base64url");
}

export function docLink(kind: DocKind, id: string, days = 14, now = Date.now()): { url: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + days * DAY;
  return { url: `${appBaseUrl()}/api/doc/${kind}/${encodeURIComponent(id)}?exp=${exp}&sig=${sign(kind, id, exp)}`, expiresAt: new Date(exp * 1000) };
}

export function verifyDocLink(kind: DocKind, id: string, expRaw: string | null, sig: string | null, now = Date.now()): "ok" | "expired" | "invalid" {
  const exp = Number(expRaw);
  if (!sig || !Number.isInteger(exp)) return "invalid";
  const expected = Buffer.from(sign(kind, id, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  return exp * 1000 < now ? "expired" : "ok";
}
