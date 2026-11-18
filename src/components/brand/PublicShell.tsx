import type { ReactNode } from "react";
import Link from "@/components/ui/Link";
import { IchijoyaLogo } from "@/components/brand/Logo";
import { ScrollTopButton } from "@/components/layout/ScrollTopButton";
import { ChatbotWidget } from "@/components/chatbot/ChatbotWidget";

/**
 * ログイン前の画面 (ホーム・ログイン・新規登録) の枠: ヘッダー (ロゴ・案内・ログイン・新規登録) とフッター。
 * 基調は白。本文は Noto Sans JP、見出しは Noto Serif JP (font-maru / font-serif)。
 */
function navClass(active: boolean) {
  return active
    ? "rounded-md bg-neutral-100 px-2.5 py-1.5 font-sans text-[13px] font-medium text-wa-deep"
    : "rounded-md px-2.5 py-1.5 font-sans text-[13px] text-neutral-500 hover:bg-neutral-50 hover:text-wa-deep";
}

export function PublicShell({ children, current }: { children: ReactNode; current: "home" | "roles" | "login" | "signup" }) {
  return (
    <div className="min-h-screen bg-white font-sans text-ink">
      <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:h-16 sm:px-6">
          <Link href="/home" className="flex items-center gap-3" aria-label="一畳屋 統合業務システム ホーム">
            <IchijoyaLogo title="株式会社一畳屋" className="h-7 w-auto sm:h-8" />
            <span className="hidden border-l border-neutral-200 pl-3 font-serif text-[11px] leading-tight tracking-wide text-wa-deep/75 sm:block">
              統合業務システム
            </span>
          </Link>
          <nav className="ml-auto flex items-center gap-0.5 text-sm">
            <Link href="/home" className={`hidden lg:block ${navClass(current === "home")}`}>
              ホーム
            </Link>
            <a href="/home#issues" className="hidden rounded-md px-2.5 py-1.5 font-sans text-[13px] text-neutral-500 hover:bg-neutral-50 hover:text-wa-deep lg:block">解決すること</a>
            <a href="/home#stores" className="hidden rounded-md px-2.5 py-1.5 font-sans text-[13px] text-neutral-500 hover:bg-neutral-50 hover:text-wa-deep lg:block">店舗</a>
            <a href="/home#features" className="hidden rounded-md px-2.5 py-1.5 font-sans text-[13px] text-neutral-500 hover:bg-neutral-50 hover:text-wa-deep md:block">機能</a>
            <Link href="/roles" className={navClass(current === "roles")}>
              権限と担当
            </Link>
            <Link href="/login" className={navClass(current === "login")}>
              ログイン
            </Link>
            <Link
              href="/signup"
              className={current === "signup" ? "ml-1 rounded-full bg-wa-deep px-3.5 py-1.5 font-sans text-[13px] font-medium text-white" : "ml-1 rounded-full bg-wa-green px-3.5 py-1.5 font-sans text-[13px] font-medium text-white transition hover:bg-wa-deep"}
            >
              新規登録
            </Link>
          </nav>
        </div>
      </header>
      {children}
      <footer className="border-t border-neutral-200 bg-white text-neutral-500">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-xs sm:px-6">
          <div className="flex items-center gap-3 text-wa-deep">
            <IchijoyaLogo title="株式会社一畳屋" className="h-6 w-auto" />
            <span className="text-neutral-500">畳・襖・障子・網戸・内装の専門店 · 創業 明治35年</span>
          </div>
          <span>このシステムは一畳屋の社員専用です。ログイン情報は社外に共有しないでください。</span>
        </div>
      </footer>
      <ChatbotWidget guest />
      <ScrollTopButton />
    </div>
  );
}
