import type { ReactNode } from "react";
import Link from "@/components/ui/Link";
import { IchijoyaLogo } from "@/components/brand/Logo";

/** ログイン前の画面 (トップ・新規登録) の枠: ヘッダー (ロゴ・ログイン・新規登録) とフッター */
export function PublicShell({ children, current }: { children: ReactNode; current: "login" | "signup" }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-accent-strong/95 text-white backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/login" className="flex items-center gap-3" aria-label="一畳屋 統合業務システム トップ">
            <IchijoyaLogo variant="white" title="株式会社一畳屋" className="h-7 w-auto" />
            <span className="hidden border-l border-white/25 pl-3 text-xs leading-tight text-white/80 sm:block">
              統合業務システム
            </span>
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <a href="/login#about" className="hidden rounded-lg px-3 py-1.5 text-white/80 hover:bg-white/10 hover:text-white md:block">システムについて</a>
            <a href="/login#features" className="hidden rounded-lg px-3 py-1.5 text-white/80 hover:bg-white/10 hover:text-white md:block">機能</a>
            <a href="/login#roles" className="hidden rounded-lg px-3 py-1.5 text-white/80 hover:bg-white/10 hover:text-white md:block">権限</a>
            <Link href="/login#login" className={current === "login" ? "rounded-lg bg-white/15 px-3 py-1.5 font-medium" : "rounded-lg px-3 py-1.5 text-white/85 hover:bg-white/10"}>
              ログイン
            </Link>
            <Link href="/signup" className={current === "signup" ? "rounded-lg bg-white px-3 py-1.5 font-medium text-accent-strong" : "rounded-lg bg-white px-3 py-1.5 font-medium text-accent-strong hover:bg-white/90"}>
              新規登録
            </Link>
          </nav>
        </div>
      </header>
      {children}
      <footer className="border-t border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-ink-3 sm:px-6">
          <span>© 株式会社一畳屋 · 畳・襖・障子・網戸・内装の専門店</span>
          <span>このシステムは一畳屋の社員専用です。ログイン情報は社外に共有しないでください。</span>
        </div>
      </footer>
    </div>
  );
}
