import type { ReactNode } from "react";
import { IchijoyaLogo } from "@/components/brand/Logo";
import { PublicHeader, type PublicPage } from "@/components/brand/PublicHeader";
import { MAIN_PAD } from "@/components/layout/header-parts";
import { ScrollTopButton } from "@/components/layout/ScrollTopButton";
import { ChatbotWidget } from "@/components/chatbot/ChatbotWidget";

/**
 * ログイン前の画面 (ホーム・権限と担当・ログイン・新規登録) の枠。
 * ログイン後の画面 (AppShell) と同じ見た目にする: 淡いブルーの背景 (body)・上部に浮かぶヘッダーのカード・同じ幅の本文・白いカード。
 * ヘッダーと本文の枠の部品は src/components/layout/header-parts.tsx を共有する
 */
export function PublicShell({ children, current }: { children: ReactNode; current: PublicPage }) {
  // ホームは本文を 1220px に収める。ヘッダーは従来どおり広めのまま
  const contentMax = current === "home" ? "max-w-[1220px]" : "max-w-[1680px]";
  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        本文へ移動
      </a>
      <PublicHeader current={current} />
      <main id="main-content" className={MAIN_PAD}>
        <div className={`@container mx-auto w-full animate-fade ${contentMax}`}>{children}</div>
      </main>
      <footer className="px-3 pb-10 sm:px-4 lg:px-6">
        <div className={`mx-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-xs text-ink-3 ${contentMax}`}>
          <div className="flex items-center gap-3">
            <IchijoyaLogo title="株式会社一畳屋" className="h-5 w-auto" />
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
