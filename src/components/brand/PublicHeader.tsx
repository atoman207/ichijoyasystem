"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { House, Layers, LayoutGrid, LogIn, Menu, ShieldCheck, Store, UserPlus, X, type LucideIcon } from "lucide-react";
import Link from "@/components/ui/Link";
import { IchijoyaLogo } from "@/components/brand/Logo";
import {
  ACCENT_BUTTON,
  DRAWER_BACKDROP,
  DRAWER_PANEL,
  HEADER_BAR,
  HEADER_WRAP,
  ICON_BUTTON,
  ICON_ZOOM,
  LOGO_LINK,
  TAB,
  TabInner,
  TILE_LINK,
  tileIcon,
  tileLabel,
} from "@/components/layout/header-parts";

export type PublicPage = "home" | "roles" | "login" | "signup";

interface Item {
  href: string;
  label: string;
  icon: LucideIcon;
  /** このページを開いているときに選択中にする */
  page?: PublicPage;
}

/** ホームの中の案内 (ページ内の位置へ移動) と、ほかの公開ページ */
const ITEMS: Item[] = [
  { href: "/home", label: "ホーム", icon: House, page: "home" },
  { href: "/home#stores", label: "店舗", icon: Store },
  { href: "/home#issues", label: "解決すること", icon: Layers },
  { href: "/home#features", label: "機能", icon: LayoutGrid },
  { href: "/roles", label: "権限と担当", icon: ShieldCheck, page: "roles" },
];

/**
 * ログイン前の画面のヘッダー。ログイン後のヘッダー (AppShell) と同じ部品 (header-parts) で作り、見た目をそろえる
 * - PC: ロゴ・タブ (アイコン + 名前)・ログイン・新規登録
 * - タブレット・スマートフォン: 左上のボタンで、ヘッダーの下にアイコンの一覧を開く
 */
export function PublicHeader({ current }: { current: PublicPage }) {
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const close = () => setDrawer(false);
  const drawerItems: Item[] = [...ITEMS, { href: "/login", label: "ログイン", icon: LogIn, page: "login" }, { href: "/signup", label: "新規登録", icon: UserPlus, page: "signup" }];

  return (
    <>
      <header className={HEADER_WRAP}>
        <div className={HEADER_BAR}>
          {/* タブレット・スマートフォン: メニューの開閉 */}
          <button
            type="button"
            className={clsx(ICON_BUTTON, "lg:hidden", drawer && "bg-subtle text-ink")}
            onClick={() => setDrawer((d) => !d)}
            aria-label={drawer ? "メニューを閉じる" : "メニューを開く"}
            aria-expanded={drawer}
            aria-controls="public-drawer"
          >
            {drawer ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          {/* ロゴ */}
          <Link href="/home" onClick={close} aria-label="一畳屋 統合業務システム (ホーム)" className={LOGO_LINK}>
            <IchijoyaLogo title="" className="h-4 w-auto max-w-[4.75rem] shrink-0 sm:h-7 sm:max-w-none" />
          </Link>

          {/* PC: メニューのタブ */}
          <nav aria-label="メインメニュー" className="hidden min-w-0 flex-1 items-center justify-center lg:flex">
            <div className="flex min-w-0 items-center gap-0.5">
              {ITEMS.map((item) => {
                const active = item.page === current;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={item.label}
                    className={clsx(TAB, active ? "text-accent" : "text-ink-2 hover:text-ink")}
                  >
                    <TabInner icon={item.icon} label={item.label} active={active} />
                  </Link>
                );
              })}
            </div>
          </nav>

          {/* ログイン・新規登録 */}
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5 lg:ml-0">
            <Link
              href="/login"
              onClick={close}
              aria-current={current === "login" ? "page" : undefined}
              className={clsx(
                "group inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-4 focus-visible:ring-accent/25 sm:h-10 sm:px-3",
                current === "login" ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line bg-panel text-ink hover:border-line-strong hover:bg-subtle",
              )}
            >
              <LogIn className={clsx("h-4 w-4", ICON_ZOOM)} aria-hidden />
              ログイン
            </Link>
            <Link href="/signup" onClick={close} aria-current={current === "signup" ? "page" : undefined} className={ACCENT_BUTTON}>
              <UserPlus className={clsx("h-4 w-4", ICON_ZOOM)} aria-hidden />
              <span className="hidden sm:inline">新規登録</span>
            </Link>
          </div>
        </div>
      </header>

      {/* タブレット・スマートフォン: ヘッダーの下に開くメニュー (アイコンの一覧) */}
      {drawer && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className={DRAWER_BACKDROP} onClick={close} aria-hidden />
          <nav id="public-drawer" aria-label="メインメニュー" className={DRAWER_PANEL}>
            <div className="grid grid-cols-4 gap-1 sm:grid-cols-7">
              {drawerItems.map((item) => {
                const active = item.page === current;
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} onClick={close} aria-current={active ? "page" : undefined} title={item.label} className={TILE_LINK}>
                    <span className={tileIcon(active)}>
                      <Icon className={clsx("h-5 w-5", ICON_ZOOM)} aria-hidden />
                    </span>
                    <span className={tileLabel(active)}>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
