import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appBaseUrl, linkSecret } from "@/lib/notify/config";

/**
 * お客様への日程の候補の案内のリンク (ログインなしで候補を選ぶ。期限つき)
 * URL: /api/doc/schedule-offer/<groupId>?exp=<期限 (UNIX 秒)>&sig=<署名>
 * 署名は groupId と期限を秘密の鍵で HMAC したもの (doc-link.ts と同じ方式)。書き換えたリンクは開けない
 */

const sign = (groupId: string, exp: number) => createHmac("sha256", linkSecret()).update(`schedule-offer:${groupId}:${exp}`).digest("base64url");

export function offerLink(groupId: string, days = 7, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + days * 86400;
  return `${appBaseUrl()}/api/doc/schedule-offer/${encodeURIComponent(groupId)}?exp=${exp}&sig=${sign(groupId, exp)}`;
}

export function verifyOfferLink(groupId: string, expRaw: string | null, sig: string | null, now = Date.now()): "ok" | "expired" | "invalid" {
  const exp = Number(expRaw);
  if (!sig || !Number.isInteger(exp)) return "invalid";
  const a = Buffer.from(sign(groupId, exp));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "invalid";
  return exp * 1000 < now ? "expired" : "ok";
}
