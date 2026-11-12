import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 認証ガード (楽観的チェック)
 * セッション Cookie が無ければ /login へリダイレクトする。
 * 外部サービスからの受信 (今後の /api/inbound/* など) を追加するときは matcher の除外に加え、署名検証を各ルートで行う。
 * 署名の検証とロール判定はサーバーコンポーネント側 (requireUser) で行う。
 */
const SESSION_COOKIE = "ichijoya_session";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // ログイン画面は常に表示できるようにする (ログイン済みかどうかの判定は画面側で署名を検証して行う。
  // 期限切れ・無効な Cookie のままでも /login と / の間でリダイレクトが繰り返されないように)
  if (pathname.startsWith("/login")) return NextResponse.next();

  if (!hasSession) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
