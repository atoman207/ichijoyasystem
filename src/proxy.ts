import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 認証ガード (楽観的チェック)
 * セッション Cookie が無ければ、公開ホーム (/home) かログイン (/login) へリダイレクトする。
 * 外部サービスからの受信 (/api/integrations/*: LINE・Chatwork・Web フォーム・AI 受付)、お客様に送る帳票の共有リンク (/api/doc/*)、
 * サーバーの定期実行 (/api/cron/*) はログインなしで届くため matcher から除外し、署名・共有鍵の確認を各ルートで行う。
 * サイトのアイコン (/icon.png・/apple-icon.png。src/app の icon.png・apple-icon.png) もログイン前の画面 (ブラウザーのタブ・
 * スマートフォンのホーム画面・リンクのプレビュー) で読み込まれるため除外する。
 * 公開ホームの店舗写真・飾り (public/brand/*) も除外する。
 * 署名の検証とロール判定はサーバーコンポーネント側 (requireUser) で行う。
 */
const SESSION_COOKIE = "ichijoya_session";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // 公開ホーム・ログイン・新規登録は常に表示できるようにする (ログイン済みかどうかの判定は画面側で署名を検証して行う。
  // 期限切れ・無効な Cookie のままでも /login・/home と / の間でリダイレクトが繰り返されないように)
  if (pathname === "/home" || pathname.startsWith("/home/")) return NextResponse.next();
  if (pathname.startsWith("/login")) return NextResponse.next();
  // 新規登録 (申請) もログイン前に開く
  if (pathname === "/signup") return NextResponse.next();
  // 確認用リンク (鍵の確認は /review の処理で行う)
  if (pathname === "/review") return NextResponse.next();

  if (!hasSession) {
    // ルート (/) は公開ホームへ。それ以外の業務画面はログインへ (戻り先を next に付ける)
    if (pathname === "/") return NextResponse.redirect(new URL("/home", request.url));
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|brand/|api/health|api/integrations/|api/doc/|api/cron/).*)"],
};
