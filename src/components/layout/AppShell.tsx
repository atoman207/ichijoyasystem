"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "@/components/ui/Link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Bell,
  CalendarDays,
  CalendarPlus,
  CalendarX2,
  ChartColumn,
  ChevronDown,
  CircleUser,
  ClipboardCheck,
  Clock,
  ClockFading,
  FileSpreadsheet,
  FileText,
  Hammer,
  FolderOpen,
  House,
  Inbox,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  Package,
  Plus,
  Receipt,
  ScanLine,
  Search,
  Settings,
  Sparkles,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { Avatar, Badge } from "@/components/ui";
import { IchijoyaLogo } from "@/components/brand/Logo";

export type NavIcon =
  | "dashboard"
  | "customers"
  | "inquiries"
  | "quotes"
  | "orders"
  | "schedule"
  | "invoices"
  | "expenses"
  | "purchases"
  | "capture"
  | "approvals"
  | "messages"
  | "reports"
  | "ai"
  | "audit"
  | "settings"
  | "materials"
  | "dataio";

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: House,
  customers: Users,
  inquiries: Inbox,
  quotes: FileText,
  orders: Hammer,
  schedule: CalendarDays,
  invoices: Receipt,
  expenses: Wallet,
  purchases: Package,
  capture: ScanLine,
  approvals: ClipboardCheck,
  messages: MessageSquare,
  reports: ChartColumn,
  ai: Sparkles,
  audit: ClockFading,
  settings: Settings,
  materials: FolderOpen,
  dataio: FileSpreadsheet,
};

export interface NavItem {
  href: string;
  /** 正式名 (ツールチップ・読み上げ) */
  label: string;
  /** ヘッダーのタブに表示する短い名前 (省略時は label) */
  short?: string;
  icon: NavIcon;
  badge?: number;
  group?: string;
}

export interface ShellUser {
  id: string;
  name: string;
  email: string;
  title: string;
  roleLabel: string;
  storeLabel: string;
  storeColor: string;
  /** 閲覧範囲の説明 (例: 全店舗の情報を閲覧 / 合志店の情報のみ) */
  scopeLabel: string;
}

export interface NotificationItem {
  kind: "approval" | "mention" | "overdue" | "inquiry" | "request" | "schedule" | "conflict";
  title: string;
  detail?: string;
  href: string;
}

const NOTIFICATION_STYLE: Record<NotificationItem["kind"], { icon: LucideIcon; cls: string }> = {
  approval: { icon: ClipboardCheck, cls: "bg-warn-soft text-warn-ink" },
  mention: { icon: MessageSquare, cls: "bg-info-soft text-info-ink" },
  overdue: { icon: Receipt, cls: "bg-critical-soft text-critical-ink" },
  inquiry: { icon: Inbox, cls: "bg-accent-soft text-accent-ink" },
  request: { icon: Clock, cls: "bg-neutral-soft text-ink-2" },
  schedule: { icon: CalendarPlus, cls: "bg-info-soft text-info-ink" },
  conflict: { icon: CalendarX2, cls: "bg-critical-soft text-critical-ink" },
};

const CREATE_ITEMS: { href: string; label: string; desc: string; icon: LucideIcon }[] = [
  { href: "/inquiries/new", label: "問い合わせを登録", desc: "電話・LINE・来店などの受付", icon: Inbox },
  { href: "/customers/new", label: "顧客を登録", desc: "新規のお客様・法人", icon: Users },
  { href: "/quotes/new", label: "見積を作成", desc: "商品マスタから単価を自動入力", icon: FileText },
  { href: "/schedule/new", label: "予定を登録", desc: "現地調査・施工・会議・社内行事など", icon: CalendarPlus },
  { href: "/messages/new", label: "社内連絡を送る", desc: "依頼・報告・確認をシステム内で", icon: MessageSquare },
  { href: "/capture", label: "書類を取り込む", desc: "紙を撮影 → AI が読取", icon: ScanLine },
];

type MenuId = "notif" | "user" | "create" | "search" | "more" | null;

/** アイコンボタンの共通スタイル */
const ICON_BUTTON =
  "group inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors outline-none hover:bg-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-10 sm:w-10";
/** ヘッダーのアイコンを少し拡大するホバー効果 */
const ICON_ZOOM = "transition-transform duration-200 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:scale-125 group-focus-visible:scale-125 motion-reduce:transition-none";
/** ヘッダーのタブ (アイコン + 名前) */
const TAB =
  "group relative flex h-14 shrink-0 flex-col items-center justify-center gap-[5px] rounded-xl px-2.5 text-[11px] leading-none font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset";
/** ヘッダーから開くメニュー。スマートフォンではヘッダーの下に全幅で表示する */
const MENU_PANEL =
  "absolute top-full right-0 z-50 mt-3 overflow-hidden rounded-2xl border border-line/80 bg-panel shadow-pop animate-pop max-sm:fixed max-sm:inset-x-3 max-sm:top-[84px] max-sm:mt-0 max-sm:w-auto";

function CountBubble({ n, className }: { n: number; className?: string }) {
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
function TabInner({ icon: Icon, label, badge, active }: { icon: LucideIcon; label: string; badge?: number; active: boolean }) {
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

function SearchBox({ autoFocus }: { autoFocus?: boolean }) {
  return (
    <form action="/customers" method="get" role="search" className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <input
        name="q"
        placeholder="顧客名・電話番号・住所で検索"
        aria-label="顧客を検索"
        enterKeyHint="search"
        autoFocus={autoFocus}
        className="h-11 w-full rounded-xl border border-line bg-subtle pr-3 pl-9 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:bg-panel focus:ring-4 focus:ring-accent/15"
      />
    </form>
  );
}

/**
 * 画面全体の枠。
 * - ヘッダー (上部に浮かぶカード): ロゴ / メニューのタブ (アイコン + 名前) / 検索・新規作成・通知・ユーザーメニュー
 *   タブが入りきらない幅では、あふれた分を「その他」にまとめる
 * - タブレット・スマートフォン: 左上のボタンでメニュー (アイコンの一覧) を開く
 * - 本文: 中身はコンテナクエリ (@container) で、使える幅に応じて段組みが変わる
 */
export function AppShell({
  user,
  nav,
  notifications,
  counts,
  logoutAction,
  children,
}: {
  user: ShellUser;
  nav: NavItem[];
  notifications: NotificationItem[];
  counts: { approvals: number; mentions: number };
  logoutAction: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState<MenuId>(null);
  const [lastPath, setLastPath] = useState(pathname);
  const [visibleCount, setVisibleCount] = useState(nav.length);
  const headerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // 画面を移動したら、開いているメニューを閉じる (検索やブラウザの「戻る」を含む)
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenu(null);
    setDrawer(false);
  }

  // 開いているメニューは Esc キーまたはヘッダー外のクリックで閉じる
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onPointer = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [menu]);

  // メニュー (タブレット・スマートフォン) 表示中は背面をスクロールさせない。Esc キー、または PC 幅になったら閉じる
  useEffect(() => {
    if (!drawer) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    const onResize = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawer(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onResize);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onResize);
    };
  }, [drawer]);

  // ヘッダーに入りきるタブの数を求める。非表示の計測用の列 (全タブ + 「その他」) の幅と、使える幅を比べる。
  // ResizeObserver は監視を始めた直後にも呼ばれるため、初回の計算もここで行われる
  useLayoutEffect(() => {
    const navEl = navRef.current;
    const measureEl = measureRef.current;
    if (!navEl || !measureEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const avail = navEl.clientWidth;
      if (avail <= 0) return;
      const gap = parseFloat(getComputedStyle(measureEl).columnGap) || 0;
      const children = Array.from(measureEl.children) as HTMLElement[];
      const moreW = children.pop()?.offsetWidth ?? 0;
      const widths = children.map((c) => c.offsetWidth);
      const total = widths.reduce((a, w) => a + w, 0) + gap * Math.max(widths.length - 1, 0);
      if (total <= avail) {
        setVisibleCount(widths.length);
        return;
      }
      let used = moreW;
      let count = 0;
      for (const w of widths) {
        if (used + gap + w > avail) break;
        used += gap + w;
        count += 1;
      }
      setVisibleCount(count);
    });
    ro.observe(navEl);
    ro.observe(measureEl);
    return () => ro.disconnect();
  }, []);

  const toggle = (id: Exclude<MenuId, null>) => () => setMenu((m) => (m === id ? null : id));
  const closeAll = () => {
    setMenu(null);
    setDrawer(false);
  };

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const shown = nav.slice(0, visibleCount);
  const overflow = nav.slice(visibleCount);
  const overflowActive = overflow.some((it) => isActive(it.href));
  const overflowBadge = overflow.reduce((a, it) => a + (it.badge ?? 0), 0);

  const groups: { name: string; items: NavItem[] }[] = [];
  for (const item of nav) {
    const g = item.group ?? "";
    let grp = groups.find((x) => x.name === g);
    if (!grp) {
      grp = { name: g, items: [] };
      groups.push(grp);
    }
    grp.items.push(item);
  }

  /** アイコンの一覧 (スマートフォンのメニュー・「その他」) */
  const renderTile = (item: NavItem) => {
    const Icon = ICONS[item.icon];
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        prefetch={false}
        onClick={closeAll}
        aria-current={active ? "page" : undefined}
        title={item.label}
        className="group flex min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 text-center outline-none transition-colors hover:bg-subtle focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span
          className={clsx(
            "relative flex h-11 w-11 items-center justify-center rounded-2xl",
            active ? "bg-accent text-white shadow-[0_8px_16px_-8px_rgba(74,90,232,0.9)]" : "bg-subtle text-ink-2 group-hover:text-ink",
          )}
        >
          <Icon className={clsx("h-5 w-5", ICON_ZOOM)} aria-hidden />
          {item.badge ? <CountBubble n={item.badge} className="absolute -top-1 -right-1" /> : null}
        </span>
        <span className={clsx("w-full truncate text-[11px] leading-tight", active ? "font-semibold text-accent-ink" : "text-ink-2")}>{item.short ?? item.label}</span>
        {item.badge ? <span className="sr-only">（{item.badge} 件）</span> : null}
      </Link>
    );
  };

  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        本文へ移動
      </a>

      {/* ヘッダー (上部に浮かぶカード) */}
      <header ref={headerRef} className="pointer-events-none sticky top-0 z-40 px-3 pt-3 sm:px-4 lg:px-6">
        <div className="pointer-events-auto mx-auto flex h-16 max-w-[1680px] items-center gap-1 rounded-2xl border border-white/80 bg-panel/85 px-2 shadow-header backdrop-blur-xl sm:gap-2 sm:px-3 xl:gap-4 xl:px-4">
          {/* タブレット・スマートフォン: メニューの開閉 */}
          <button
            type="button"
            className={clsx(ICON_BUTTON, "lg:hidden", drawer && "bg-subtle text-ink")}
            onClick={() => {
              setMenu(null);
              setDrawer((d) => !d);
            }}
            aria-label={drawer ? "メニューを閉じる" : "メニューを開く"}
            aria-expanded={drawer}
            aria-controls="app-drawer"
          >
            {drawer ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          {/* ロゴ */}
          <Link
            href="/"
            prefetch={false}
            onClick={closeAll}
            aria-label="一畳屋 統合業務システム (ダッシュボード)"
            className="flex shrink-0 items-center rounded-xl px-1.5 py-2 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <IchijoyaLogo title="" className="h-6 w-auto sm:h-7" />
          </Link>

          {/* PC: メニューのタブ */}
          <nav ref={navRef} aria-label="メインメニュー" className="relative hidden min-w-0 flex-1 items-center justify-center lg:flex">
            <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
              {shown.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    onClick={closeAll}
                    aria-current={active ? "page" : undefined}
                    title={item.label}
                    className={clsx(TAB, active ? "text-accent" : "text-ink-2 hover:text-ink")}
                  >
                    <TabInner icon={ICONS[item.icon]} label={item.short ?? item.label} badge={item.badge} active={active} />
                  </Link>
                );
              })}
            </div>
            {overflow.length > 0 && (
              <div className="relative ml-0.5 shrink-0">
                <button
                  type="button"
                  onClick={toggle("more")}
                  aria-haspopup="menu"
                  aria-expanded={menu === "more"}
                  className={clsx(TAB, overflowActive || menu === "more" ? "text-accent" : "text-ink-2 hover:text-ink")}
                >
                  <TabInner icon={LayoutGrid} label="その他" badge={overflowBadge || undefined} active={overflowActive} />
                </button>
                {menu === "more" && (
                  <div role="menu" aria-label="その他のメニュー" className={clsx(MENU_PANEL, "w-[340px] p-2")}>
                    <div className="grid grid-cols-4 gap-1">{overflow.map(renderTile)}</div>
                  </div>
                )}
              </div>
            )}
            {/* 計測用 (非表示): すべてのタブ + 「その他」。外側で切り取り、ページの横幅に影響させない */}
            <div aria-hidden inert className="pointer-events-none invisible absolute inset-0 overflow-hidden">
              <div ref={measureRef} className="flex w-max gap-0.5">
                {nav.map((item) => (
                  <span key={item.href} className={TAB}>
                    <TabInner icon={ICONS[item.icon]} label={item.short ?? item.label} badge={item.badge} active={false} />
                  </span>
                ))}
                <span className={clsx(TAB, "ml-0.5")}>
                  <TabInner icon={LayoutGrid} label="その他" active={false} />
                </span>
              </div>
            </div>
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1 lg:ml-0">
            {/* 顧客検索 */}
            <div className="relative">
              <button
                type="button"
                className={clsx(ICON_BUTTON, menu === "search" && "bg-subtle text-ink")}
                onClick={toggle("search")}
                aria-label="顧客を検索"
                aria-haspopup="dialog"
                aria-expanded={menu === "search"}
              >
                <Search className={clsx("h-5 w-5", ICON_ZOOM)} />
              </button>
              {menu === "search" && (
                <div role="dialog" aria-label="顧客を検索" className={clsx(MENU_PANEL, "w-[400px] p-3")}>
                  <SearchBox autoFocus />
                  <p className="mt-2 px-1 text-[11px] text-ink-3">Enter で顧客一覧を検索します</p>
                </div>
              )}
            </div>

            {/* 新規作成 */}
            <div className="relative">
              <button
                type="button"
                onClick={toggle("create")}
                aria-label="新規作成"
                aria-haspopup="menu"
                aria-expanded={menu === "create"}
                className="group inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-2.5 text-sm font-medium text-white sm:h-10 shadow-[0_8px_18px_-10px_rgba(74,90,232,0.95)] transition-colors outline-none hover:bg-accent-hover focus-visible:ring-4 focus-visible:ring-accent/25 sm:px-3"
              >
                <Plus className={clsx("h-4 w-4", ICON_ZOOM)} />
                <span className="hidden sm:inline">新規</span>
                <ChevronDown className={clsx("hidden h-3.5 w-3.5 opacity-80 transition-transform sm:block", menu === "create" && "rotate-180")} />
              </button>
              {menu === "create" && (
                <div role="menu" aria-label="新規作成メニュー" className={clsx(MENU_PANEL, "w-72 p-1.5")}>
                  {CREATE_ITEMS.map((it) => (
                    <Link key={it.href} href={it.href} role="menuitem" onClick={closeAll} className="flex items-start gap-3 rounded-xl px-2.5 py-2 transition hover:bg-subtle">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                        <it.icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-ink">{it.label}</span>
                        <span className="block text-[11px] text-ink-3">{it.desc}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* 通知 */}
            <div className="relative">
              <button
                type="button"
                className={clsx(ICON_BUTTON, "relative", menu === "notif" && "bg-subtle text-ink")}
                onClick={toggle("notif")}
                aria-label="通知"
                aria-haspopup="menu"
                aria-expanded={menu === "notif"}
              >
                <Bell className={clsx("h-5 w-5", ICON_ZOOM)} />
                {notifications.length > 0 && <CountBubble n={notifications.length} className="absolute top-1 right-1" />}
              </button>
              {menu === "notif" && (
                <div role="menu" aria-label="通知" className={clsx(MENU_PANEL, "w-[360px]")}>
                  <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <span className="text-sm font-semibold text-ink">通知</span>
                    <span className="text-xs text-ink-3">{notifications.length} 件</span>
                  </div>
                  <div className="max-h-[min(420px,calc(100dvh-7rem))] overflow-y-auto p-1.5">
                    {notifications.length === 0 && <div className="px-4 py-10 text-center text-xs text-ink-3">新しい通知はありません</div>}
                    {notifications.map((n, i) => {
                      const st = NOTIFICATION_STYLE[n.kind];
                      return (
                        <Link key={i} href={n.href} role="menuitem" onClick={closeAll} className="flex items-start gap-3 rounded-xl px-2.5 py-2 transition hover:bg-subtle">
                          <span className={clsx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", st.cls)}>
                            <st.icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-ink">{n.title}</span>
                            {n.detail && <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-ink-3">{n.detail}</span>}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ユーザーメニュー (アバター) */}
            <div className="relative">
              <button
                type="button"
                onClick={toggle("user")}
                aria-label="ユーザーメニュー"
                aria-haspopup="menu"
                aria-expanded={menu === "user"}
                title={`${user.name} (${user.roleLabel})`}
                className={clsx(
                  "group flex items-center gap-1 rounded-full p-1 outline-none transition-colors hover:bg-subtle focus-visible:ring-2 focus-visible:ring-accent/40 sm:pr-1.5",
                  menu === "user" && "bg-subtle",
                )}
              >
                <span className={clsx("inline-flex", ICON_ZOOM, "group-hover:scale-110 group-focus-visible:scale-110")}>
                  <Avatar name={user.name} id={user.id} size={32} ring />
                </span>
                <ChevronDown className={clsx("hidden h-4 w-4 text-ink-3 transition-transform sm:block", menu === "user" && "rotate-180")} />
              </button>
              {menu === "user" && (
                <div role="menu" aria-label="ユーザーメニュー" className={clsx(MENU_PANEL, "w-80")}>
                  <div className="bg-linear-to-br from-accent-soft to-panel px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={user.name} id={user.id} size={48} ring />
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-semibold text-ink">{user.name}</div>
                        <div className="truncate text-xs text-ink-2">{user.title}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <Badge tone="accent" dot={false}>
                        {user.roleLabel}
                      </Badge>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-panel px-2 py-0.5 text-xs text-ink-2 ring-1 ring-line">
                        <span className="h-2 w-2 rounded-full" style={{ background: user.storeColor }} aria-hidden />
                        {user.storeLabel}
                      </span>
                    </div>
                    <div className="mt-2 truncate font-mono text-[11px] text-ink-3">{user.email}</div>
                    <div className="mt-1 text-[11px] text-ink-3">{user.scopeLabel}</div>
                  </div>
                  <div className="border-t border-line p-1.5">
                    {[
                      { href: "/profile", label: "プロフィール", icon: CircleUser, count: 0 },
                      { href: "/approvals?tab=mine", label: "あなたの承認待ち", icon: ClipboardCheck, count: counts.approvals },
                      { href: "/messages?tab=mine", label: "社内連絡", icon: MessageSquare, count: counts.mentions },
                      { href: "/schedule?view=list&user=me&store=all", label: "自分の予定", icon: CalendarDays, count: 0 },
                      { href: "/settings", label: "設定", icon: Settings, count: 0 },
                    ].map((it) => (
                      <Link
                        key={it.href}
                        href={it.href}
                        prefetch={false}
                        role="menuitem"
                        onClick={closeAll}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-2 transition hover:bg-subtle hover:text-ink"
                      >
                        <it.icon className="h-4 w-4 text-ink-3" />
                        <span className="flex-1">{it.label}</span>
                        {it.count > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white tnum">{it.count}</span>}
                      </Link>
                    ))}
                  </div>
                  <form action={logoutAction} className="border-t border-line p-1.5">
                    <button
                      type="submit"
                      role="menuitem"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-2 transition hover:bg-critical-soft hover:text-critical-ink"
                    >
                      <LogOut className="h-4 w-4" />
                      <span className="flex-1 text-left">ログアウト</span>
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* タブレット・スマートフォン: ヘッダーの下に開くメニュー (アイコンの一覧) */}
      {drawer && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]" onClick={() => setDrawer(false)} aria-hidden />
          <nav
            id="app-drawer"
            aria-label="メインメニュー"
            className="absolute inset-x-3 top-[84px] max-h-[calc(100dvh-96px)] overflow-y-auto rounded-2xl border border-line/80 bg-panel p-3 shadow-pop animate-drop sm:inset-x-4"
          >
            {groups.map((g) => (
              <div key={g.name || "_top"} className="mb-1 last:mb-0">
                {g.name && <div className="px-1.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-3">{g.name}</div>}
                <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">{g.items.map(renderTile)}</div>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-subtle px-3 py-2.5 text-xs text-ink-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: user.storeColor }} aria-hidden />
              <span className="font-medium text-ink">{user.storeLabel}</span>
              <span className="truncate text-ink-3">{user.scopeLabel}</span>
            </div>
          </nav>
        </div>
      )}

      <main id="main-content" className="px-3 pt-5 pb-12 sm:px-4 lg:px-6 lg:pt-7">
        <div className="@container mx-auto w-full max-w-[1680px] animate-fade">{children}</div>
      </main>
    </div>
  );
}
