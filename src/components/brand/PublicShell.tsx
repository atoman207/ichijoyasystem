import type { ReactNode } from "react";
import Link from "@/components/ui/Link";
import { IchijoyaLogo } from "@/components/brand/Logo";
import { ScrollTopButton } from "@/components/layout/ScrollTopButton";
import { ChatbotWidget } from "@/components/chatbot/ChatbotWidget";

/**
 * ログイン前の画面 (ホーム・ログイン・新規登録) の枠: ヘッダー (ロゴ・案内・ログイン・新規登録) とフッター。
 * 色と見出しの書体は公式サイト (ichijoya.co.jp) に合わせる (畳の緑・ロゴの赤・丸みのある見出し)。
 * 見出しの書体 (Kiwi Maru) はこの画面だけで読み込む (業務の画面は端末のフォントで軽くする)
 */
const MARU_FONT = "https://fonts.googleapis.com/css2?family=Kiwi+Maru:wght@500&display=swap";

function navClass(active: boolean) {
  return active
    ? "rounded-lg bg-wa-cream px-3 py-1.5 font-maru font-medium text-wa-deep"
    : "rounded-lg px-3 py-1.5 font-maru text-ink-2 hover:bg-wa-cream hover:text-wa-deep";
}

export function PublicShell({ children, current }: { children: ReactNode; current: "home" | "roles" | "login" | "signup" }) {
  return (
    <div className="min-h-screen bg-wa-cream">
      <link rel="stylesheet" href={MARU_FONT} precedence="default" />
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/home" className="flex items-center gap-3" aria-label="一畳屋 統合業務システム ホーム">
            <IchijoyaLogo title="株式会社一畳屋" className="h-8 w-auto" />
            <span className="hidden border-l border-black/15 pl-3 font-maru text-xs leading-tight text-wa-deep sm:block">
              統合業務システム
            </span>
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link href="/home" className={`hidden lg:block ${navClass(current === "home")}`}>
              ホーム
            </Link>
            <a href="/home#issues" className="hidden rounded-lg px-3 py-1.5 font-maru text-ink-2 hover:bg-wa-cream hover:text-wa-deep lg:block">解決すること</a>
            <a href="/home#stores" className="hidden rounded-lg px-3 py-1.5 font-maru text-ink-2 hover:bg-wa-cream hover:text-wa-deep lg:block">店舗</a>
            <a href="/home#features" className="hidden rounded-lg px-3 py-1.5 font-maru text-ink-2 hover:bg-wa-cream hover:text-wa-deep md:block">機能</a>
            <Link href="/roles" className={navClass(current === "roles")}>
              権限と担当
            </Link>
            <Link href="/login" className={navClass(current === "login")}>
              ログイン
            </Link>
            <Link
              href="/signup"
              className={current === "signup" ? "rounded-full bg-wa-deep px-4 py-1.5 font-maru font-medium text-white shadow-sm" : "rounded-full bg-wa-green px-4 py-1.5 font-maru font-medium text-white shadow-sm hover:bg-wa-deep"}
            >
              新規登録
            </Link>
          </nav>
        </div>
        <div className="tatami-heri h-1.5" aria-hidden />
      </header>
      {children}
      <footer className="relative bg-wa-deep text-white/80">
        <div className="tatami-weave absolute inset-0 opacity-60" aria-hidden />
        <div className="relative mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-xs sm:px-6">
          <div className="flex items-center gap-3">
            <IchijoyaLogo variant="white" title="株式会社一畳屋" className="h-6 w-auto" />
            <span>畳・襖・障子・網戸・内装の専門店 · 創業 明治35年</span>
          </div>
          <span>このシステムは一畳屋の社員専用です。ログイン情報は社外に共有しないでください。</span>
        </div>
      </footer>
      <ChatbotWidget guest />
      <ScrollTopButton />
    </div>
  );
}
