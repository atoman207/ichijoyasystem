import { NextResponse } from "next/server";
import { isReviewKey, REVIEW_COOKIE, REVIEW_COOKIE_MAX_AGE } from "@/lib/auth/review";

export const dynamic = "force-dynamic";

/**
 * 確認用リンク: /review?key=…
 * 鍵が正しければ、この端末に確認用の Cookie を付けてログイン画面へ移動する (ログイン画面にロールのボタンが出る)
 *
 * 移動先は相対パス (/login) で返す。本番のアプリは nginx の内側 (next start -H 0.0.0.0 / 127.0.0.1) で動くため、
 * req.url のホストは「0.0.0.0:3000」などになり、ブラウザーが開いているドメインと違う。
 * 絶対 URL にすると、Cookie を付けたドメインとは別の場所へ移動してしまい、外からは開けない
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!isReviewKey(key)) return seeOther(`/login?err=${encodeURIComponent("確認用リンクが正しくないか、無効になっています。")}`);
  const res = seeOther("/login");
  const secure = req.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:" || process.env.VERCEL === "1";
  res.cookies.set(REVIEW_COOKIE, key!, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: REVIEW_COOKIE_MAX_AGE });
  return res;
}
