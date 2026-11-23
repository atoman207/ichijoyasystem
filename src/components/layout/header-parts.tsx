import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

/**
 * ヘッダーと本文の枠の共通部品
 * ------------------------------------------------------------
 * ログイン後の画面 (AppShell) とログイン前の画面 (PublicShell の PublicHeader) で同じものを使い、見た目をそろえる。
 * 片方だけ変えないこと (変えるときはここを直す)
 */

/** ヘッダーの外枠 (上部に浮かぶカードを、画面の上に固定する) */
export const HEADER_WRAP = "pointer-events-none sticky top-0 z-40 px-3 pt-3 sm:px-4 lg:px-6";
/** ヘッダーのカード */
export const HEADER_BAR =
  "pointer-events-auto mx-auto flex h-16 max-w-[1680px] items-center gap-1 rounded-2xl border border-white/80 bg-panel/85 px-2 shadow-header backdrop-blur-xl sm:gap-2 sm:px-3 xl:gap-4 xl:px-4";
/** ロゴのリンク */
export const LOGO_LINK = "flex shrink-0 items-center rounded-xl px-0.5 py-1.5 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/40 sm:px-1.5 sm:py-2";
/** 本文の外枠と中身 (中身はコンテナクエリの基準) */
export const MAIN_PAD = "px-3 pt-5 pb-24 sm:px-4 lg:px-6 lg:pt-7";
export const MAIN_INNER = "@container mx-auto w-full max-w-[1680px] animate-fade";

/** アイコンボタンの共通スタイル */
export const ICON_BUTTON =
  "group inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors outline-none hover:bg-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-10 sm:w-10";
/** ヘッダーのアイコンを少し拡大するホバー効果 */
export const ICON_ZOOM = "transition-transform duration-200 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:scale-125 group-focus-visible:scale-125 motion-reduce:transition-none";
/** ヘッダーのタブ (アイコン + 名前) */
export const TAB =
  "group relative flex h-14 shrink-0 flex-col items-center justify-center gap-[5px] rounded-xl px-2.5 text-[11px] leading-none font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset";
/** ヘッダーの目立たせるボタン (新規など。アクセント色) */
export const ACCENT_BUTTON =
  "group inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-2.5 text-sm font-medium text-white sm:h-10 shadow-[0_8px_18px_-10px_rgba(74,90,232,0.95)] transition-colors outline-none hover:bg-accent-hover focus-visible:ring-4 focus-visible:ring-accent/25 sm:px-3";
/** ヘッダーから開くメニュー。スマートフォンではヘッダーの下に全幅で表示する */
export const MENU_PANEL =
  "absolute top-full right-0 z-50 mt-3 overflow-hidden rounded-2xl border border-line/80 bg-panel shadow-pop animate-pop max-sm:fixed max-sm:inset-x-3 max-sm:top-[84px] max-sm:mt-0 max-sm:w-auto";

/** タブレット・スマートフォンのメニュー (ヘッダーの下に開くアイコンの一覧) */
export const DRAWER_BACKDROP = "absolute inset-0 bg-ink/25 backdrop-blur-[2px]";
export const DRAWER_PANEL =
  "absolute inset-x-3 top-[84px] max-h-[calc(100dvh-96px)] overflow-y-auto rounded-2xl border border-line/80 bg-panel p-3 shadow-pop animate-drop sm:inset-x-4";
/** メニューのアイコンの 1 つ (リンク・アイコンの丸・名前) */
export const TILE_LINK =
  "group flex min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 text-center outline-none transition-colors hover:bg-subtle focus-visible:ring-2 focus-visible:ring-accent/40";
export const tileIcon = (active: boolean) =>
  clsx("relative flex h-11 w-11 items-center justify-center rounded-2xl", active ? "bg-accent text-white shadow-[0_8px_16px_-8px_rgba(74,90,232,0.9)]" : "bg-subtle text-ink-2 group-hover:text-ink");
export const tileLabel = (active: boolean) => clsx("w-full truncate text-[11px] leading-tight", active ? "font-semibold text-accent-ink" : "text-ink-2");

export function CountBubble({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={clsx(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-panel tnum",
        className,
      )}
      aria-hidden
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** タブの中身 (アイコン + 短い名前 + 件数) */
export function TabInner({ icon: Icon, label, badge, active }: { icon: LucideIcon; label: string; badge?: number; active: boolean }) {
  return (
    <>
      <span className="relative">
        <Icon className={clsx("h-5 w-5", ICON_ZOOM)} strokeWidth={active ? 2.2 : 1.9} aria-hidden />
        {badge ? <CountBubble n={badge} className="absolute -top-1.5 -right-2.5" /> : null}
      </span>
      <span>{label}</span>
      {badge ? <span className="sr-only">（{badge} 件）</span> : null}
      {active && <span className="absolute inset-x-3 bottom-0.5 h-[3px] rounded-full bg-accent" aria-hidden />}
    </>
  );
}
