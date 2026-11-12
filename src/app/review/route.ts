import { NextResponse } from "next/server";
import { isReviewKey, REVIEW_COOKIE, REVIEW_COOKIE_MAX_AGE } from "@/lib/auth/review";

export const dynamic = "force-dynamic";

/**
 * 確認用リンク: /review?key=…
 * 鍵が正しければ、この端末に確認用の Cookie を付けてログイン画面へ移動する (ログイン画面にロールのボタンが出る)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const to = new URL("/login", url);
  if (!isReviewKey(key)) {
    to.searchParams.set("err", "確認用リンクが正しくないか、無効になっています。");
    return NextResponse.redirect(to, 303);
  }
  const res = NextResponse.redirect(to, 303);
  const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" || process.env.VERCEL === "1";
  res.cookies.set(REVIEW_COOKIE, key!, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: REVIEW_COOKIE_MAX_AGE });
  return res;
}
