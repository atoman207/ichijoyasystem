"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "@/components/ui/Link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ANNOUNCE_INIT, freshNotices, keysViewedAt, noticeToasts, unseenCount } from "@/lib/notify-seen";
import { addSeen, dropLegacyRead, seenSnapshot, subscribeSeen } from "./seen-store";
import clsx from "clsx";
import {
  ACCENT_BUTTON,
  CountBubble,
  DRAWER_BACKDROP,
  DRAWER_PANEL,
  HEADER_BAR,
  HEADER_WRAP,
  ICON_BUTTON,
  ICON_ZOOM,
  LOGO_LINK,
  MAIN_INNER,
  MAIN_PAD,
  MENU_PANEL,
  TAB,
  TabInner,
  TILE_LINK,
  tileIcon,
  tileLabel,
} from "./header-parts";
import { Award, BookOpen, Calculator, CircleHelp, ClipboardList, Coins, Printer, Landmark, ListTodo, PhoneCall, Truck, ListChecks, Bell, CalendarDays, CalendarOff, CalendarPlus, CalendarX2, ChartColumn, ChevronDown, CircleUser, ClipboardCheck, Clock, ClockFading, FileSpreadsheet, FileText, Hammer, FolderOpen, House, Inbox, LayoutGrid, LogOut, Menu, MessageSquare, MessagesSquare, Package, Plus, Receipt, ScanLine, Search, Settings, Sparkles, UserCog, UserPlus, Users, Wallet, X, type LucideIcon, MapPinned, Scale, NotebookPen, Layers, ClipboardPen, Megaphone, Database, BookOpenCheck, History } from "lucide-react";
import { Avatar, Badge } from "@/components/ui";
import { IchijoyaLogo } from "@/components/brand/Logo";
import { ChatbotWidget } from "@/components/chatbot/ChatbotWidget";
import { ChatIconButton, ChatLive, ChatPinnedButton } from "@/components/chat/ChatBadge";
import { Toaster } from "@/components/ui/Toaster";
import { toast } from "@/components/ui/toast";
import type { ChatSummary } from "@/lib/chat/types";
import { ScrollTopButton } from "./ScrollTopButton";

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
  | "chat"
  | "reports"
  | "ai"
  | "audit"
  | "settings"
  | "materials"
  | "dataio"
  | "kpi"
  | "cases"
  | "cashbook"
  | "finance"
  | "accounting"
  | "contacts"
  | "suppliers"
  | "knowledge"
  | "purchaseOrders"
  | "fax"
  | "maps"
  | "management"
  | "help"
  | "leave"
  | "office"
  | "heri"
  | "workReport"
  | "promotions"
  | "registry";

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
  chat: MessagesSquare,
  reports: ChartColumn,
  ai: Sparkles,
  audit: ClockFading,
  settings: Settings,
  materials: FolderOpen,
  dataio: FileSpreadsheet,
  maps: MapPinned,
  kpi: Award,
  cases: ListChecks,
  cashbook: Coins,
  finance: Landmark,
  accounting: Calculator,
  contacts: PhoneCall,
  suppliers: Truck,
  knowledge: BookOpen,
  purchaseOrders: ClipboardList,
  fax: Printer,
  help: CircleHelp,
  management: Scale,
  leave: CalendarOff,
  office: NotebookPen,
  heri: Layers,
  workReport: ClipboardPen,
  promotions: Megaphone,
  registry: Database,
};

export interface NavItem {
  href: string;
  /** 正式名 (ツールチップ・読み上げ) */
  label: string;
  /** ヘッダーのタブに表示する短い名前 (省略時は label) */
  short?: string;
  icon: NavIcon;
  badge?: number;
  /** 数字の元の記録のキー (src/lib/notify-seen.ts)。あれば数字は確認していない記録の数 (0 件なら出さない) */
  seenKeys?: string[];
  group?: string;
  /** ヘッダー左上 (ロゴの右) に常に表示する重要な機能。タブの列には出さない */
  pinned?: boolean;
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
  avatarSrc?: string;
  /** 社員管理 (アカウントの管理) ができる: 管理者・店長 (permissions.ts の canManageUsers) */
  canManageStaff?: boolean;
  /** 承認する立場 (管理者・店長)。ヘッダーに承認のボタン (件数つき) を常に出す */
  canApprove?: boolean;
}

export interface NotificationItem {
  kind: "approval" | "mention" | "overdue" | "inquiry" | "request" | "schedule" | "conflict" | "task" | "signup" | "fax" | "knowledge" | "change" | "inbound";
  title: string;
  detail?: string;
  href: string;
  /** この通知が知らせる記録のキー (src/lib/notify-seen.ts)。すべて確認すると既読 */
  keys?: string[];
}

const NOTIFICATION_STYLE: Record<NotificationItem["kind"], { icon: LucideIcon; cls: string }> = {
  approval: { icon: ClipboardCheck, cls: "bg-warn-soft text-warn-ink" },
  mention: { icon: MessageSquare, cls: "bg-info-soft text-info-ink" },
  overdue: { icon: Receipt, cls: "bg-critical-soft text-critical-ink" },
  inquiry: { icon: Inbox, cls: "bg-accent-soft text-accent-ink" },
  request: { icon: Clock, cls: "bg-neutral-soft text-ink-2" },
  schedule: { icon: CalendarPlus, cls: "bg-info-soft text-info-ink" },
  conflict: { icon: CalendarX2, cls: "bg-critical-soft text-critical-ink" },
  task: { icon: ListTodo, cls: "bg-warn-soft text-warn-ink" },
  signup: { icon: UserPlus, cls: "bg-accent-soft text-accent-ink" },
  fax: { icon: Printer, cls: "bg-warn-soft text-warn-ink" },
  knowledge: { icon: BookOpenCheck, cls: "bg-warn-soft text-warn-ink" },
  change: { icon: History, cls: "bg-accent-soft text-accent-ink" },
  // 外部から届いたメッセージ (LINE・メール・Slack・Chatwork。src/lib/inbound/feed.ts)
  inbound: { icon: MessagesSquare, cls: "bg-good-soft text-good-ink" },
};

const CREATE_ITEMS: { href: string; label: string; desc: string; icon: LucideIcon }[] = [
  { href: "/inquiries/reception", label: "問合せ登録", desc: "手書きメモを撮影 → AI が読み取り (手入力・話して入力も)", icon: Inbox },
  { href: "/customers/new", label: "顧客を登録", desc: "新規のお客様・法人", icon: Users },
  { href: "/quotes/new", label: "見積を作成", desc: "商品マスタから単価を自動入力", icon: FileText },
  { href: "/schedule/new", label: "予定を登録", desc: "現地調査・施工・会議・社内行事など", icon: CalendarPlus },
  { href: "/chat", label: "チャットで連絡", desc: "店舗・全社のチャンネル・DM。写真・資料も送れます", icon: MessagesSquare },
  { href: "/messages/new?kind=request", label: "業務を依頼", desc: "担当者・期限つき。確認 → 報告 → 完了", icon: ListTodo },
  { href: "/contacts", label: "やりとりを記録", desc: "お客様・協力業者との電話・メール・LINE", icon: PhoneCall },
  { href: "/expenses/new", label: "経費を登録", desc: "備品・ガソリン代など (勘定科目の候補つき)", icon: Wallet },
  { href: "/capture", label: "書類を取り込む", desc: "紙を撮影 → AI が読取", icon: ScanLine },
];

type MenuId = "notif" | "user" | "create" | "search" | "more" | null;

const NO_KEYS: ReadonlySet<string> = new Set();

/** ヘッダー左上に常に表示する重要な機能のボタン (光の輪・光の帯・アイコンの揺れで目立たせる) */
function PinnedButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      prefetch={false}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={item.badge ? `${item.label}（${item.badge} 件）` : item.label}
      title={item.label}
      className={clsx(
        // スマートフォンではヘッダーが窮屈になるため非表示 (メニューの「予定表」から開く)
        "group relative hidden h-9 shrink-0 items-center gap-1.5 rounded-xl bg-linear-to-br from-accent to-info px-2.5 text-sm font-semibold text-white outline-none transition-transform duration-200 hover:-translate-y-px focus-visible:ring-4 focus-visible:ring-accent/30 sm:inline-flex sm:h-10 sm:px-3.5",
        "animate-pin-glow motion-reduce:animate-none motion-reduce:shadow-[0_8px_18px_-10px_rgba(74,90,232,0.95)]",
        active && "ring-2 ring-white ring-offset-2 ring-offset-accent/40",
      )}
    >
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl" aria-hidden>
        <span className="absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-white/45 to-transparent animate-pin-shine motion-reduce:hidden" />
      </span>
      <Icon className="relative h-[18px] w-[18px] animate-pin-wiggle motion-reduce:animate-none sm:h-5 sm:w-5" strokeWidth={2.2} aria-hidden />
      <span className="relative max-[400px]:hidden">{item.short ?? item.label}</span>
      {item.badge ? <CountBubble n={item.badge} className="absolute -top-1.5 -right-1.5" /> : null}
    </Link>
  );
}

/** 画面を開いたら、その画面で見られる記録 (問い合わせ・請求書の画面、承認の一覧など) を確認済みにする (src/lib/notify-seen.ts) */
function SeenOnVisit({ keys, onSeen }: { keys: ReadonlySet<string>; onSeen: (keys: string[]) => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  useEffect(() => {
    onSeen(keysViewedAt(keys, pathname, new URLSearchParams(query)));
  }, [keys, pathname, query, onSeen]);
  return null;
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
  live,
  chat,
  logoutAction,
  children,
}: {
  user: ShellUser;
  nav: NavItem[];
  notifications: NotificationItem[];
  /** signups: 自分が承認できる新規登録の申請 (社員管理のメニューに件数を出す) */
  counts: { approvals: number; mentions: number; signups?: number; approvalKeys?: string[]; signupKeys?: string[] };
  /** ヘッダーの件数の印 (src/lib/notify-live.ts)。1 分ごとに確かめ、変わったら画面を読み直す */
  live?: { sig: string };
  /** チャットのアイコン (要対応・未読の数と通知音の設定。src/lib/chat/inbox.ts) */
  chat?: ChatSummary;
  logoutAction: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // 画面を開いたままでも、新しい承認の申請・問い合わせ・通知が届いたらヘッダーの件数とベルを新しくする
  // (1 分ごと・画面が表示されているときだけ。件数の印が変わったときだけ読み直す)
  useEffect(() => {
    if (!live?.sig) return;
    let stopped = false;
    let busy = false;
    const check = async () => {
      if (stopped || busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const res = await fetch("/api/notifications/summary", { cache: "no-store", headers: { accept: "application/json" } });
        if (res.ok) {
          const j = (await res.json()) as { sig?: string };
          if (!stopped && j.sig && j.sig !== live.sig) router.refresh();
        }
      } catch {
        // 通信できないときは次の回に確かめる
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [live?.sig, router]);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState<MenuId>(null);
  const [lastPath, setLastPath] = useState(pathname);
  // 確認済みの記録 (ヘッダーの数字は確認していない記録の数だけ。src/lib/notify-seen.ts・seen-store.ts)。
  // サーバーと最初の表示は null (= 読み込む前。保存した確認済みを反映する前の数字を一瞬出さない)
  const storageKey = `ichijoya:seen:${user.id}`;
  const subscribe = useCallback((onChange: () => void) => subscribeSeen(storageKey, onChange), [storageKey]);
  const seenSnap = useSyncExternalStore<ReadonlySet<string> | null>(subscribe, () => seenSnapshot(storageKey), () => null);
  const seenReady = seenSnap !== null;
  const seen = seenSnap ?? NO_KEYS;
  // メニューの数字: 記録のキーがあれば確認していない記録の数 (0 件・読み込む前は出さない)
  const navShown = useMemo(
    () => nav.map((it) => (it.seenKeys ? { ...it, badge: (seenReady ? unseenCount(it.seenKeys, seen) : 0) || undefined } : it)),
    [nav, seen, seenReady],
  );
  // ロゴの右に常に出す重要な機能 (予定表・チャット)。タブの列には出さない
  const pinnedItems = navShown.filter((it) => it.pinned);
  const tabs = navShown.filter((it) => !it.pinned);
  const [visibleCount, setVisibleCount] = useState(tabs.length);
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
  const notifKeys = (n: NotificationItem) => n.keys ?? [`n:${n.kind}|${n.href}|${n.title}`];
  const allKeys = useMemo(() => {
    const set = new Set<string>();
    for (const it of nav) for (const k of it.seenKeys ?? []) set.add(k);
    for (const n of notifications) for (const k of n.keys ?? [`n:${n.kind}|${n.href}|${n.title}`]) set.add(k);
    for (const k of counts.approvalKeys ?? []) set.add(k);
    for (const k of counts.signupKeys ?? []) set.add(k);
    return set;
  }, [nav, notifications, counts.approvalKeys, counts.signupKeys]);
  const markSeen = useCallback((keys: readonly string[]) => addSeen(storageKey, keys), [storageKey]);
  useEffect(() => dropLegacyRead(user.id), [user.id]);

  // 新しく届いた通知を画面の右上にトーストで知らせる (1 つの通知は 1 回だけ。知らせたキーはブラウザーに覚える。
  // 確認済みの記録は知らせない。このブラウザーで初めてのときは、今ある通知を覚えるだけ。src/lib/notify-seen.ts の freshNotices)
  const announceKey = `ichijoya:announced:${user.id}`;
  useEffect(() => {
    if (!seenReady) return;
    const items = notifications.map((n) => ({ ...n, keys: n.keys ?? [`n:${n.kind}|${n.href}|${n.title}`] }));
    const all = items.flatMap((n) => n.keys);
    const announced = seenSnapshot(announceKey);
    if (!announced.has(ANNOUNCE_INIT)) {
      addSeen(announceKey, [ANNOUNCE_INIT, ...all]);
      return;
    }
    const { show, more } = noticeToasts(freshNotices(items, announced, seen));
    addSeen(announceKey, all);
    // 新しいものが上に並ぶので、いちばん上の通知を最後に出す
    for (const n of [...show].reverse()) {
      toast.notice(n.title, { detail: n.detail, tag: "bell", action: { label: "開く", href: n.href, onClick: () => markSeen(n.keys) } });
    }
    if (more > 0) toast.notice(`ほかに新しい通知が ${more} 件あります`, { detail: "右上のベルで確認できます", tag: "bell" });
  }, [notifications, seenReady, seen, announceKey, markSeen]);
  // ベルを開いたら、ベルの通知のトーストは閉じる (同じ内容が一覧に出るため)
  useEffect(() => {
    if (menu === "notif") toast.dismissTag("bell");
  }, [menu]);

  const unseenOf = (keys: readonly string[] | undefined, fallback: number) => (!seenReady ? 0 : keys ? unseenCount(keys, seen) : fallback);
  const isUnread = (n: NotificationItem) => seenReady && notifKeys(n).some((k) => !seen.has(k));
  const unreadCount = notifications.filter(isUnread).length;
  const approvalsUnseen = unseenOf(counts.approvalKeys, counts.approvals);
  const signupsUnseen = unseenOf(counts.signupKeys, counts.signups ?? 0);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const shown = tabs.slice(0, visibleCount);
  const overflow = tabs.slice(visibleCount);
  const overflowActive = overflow.some((it) => isActive(it.href));
  const overflowBadge = overflow.reduce((a, it) => a + (it.badge ?? 0), 0);

  const groups: { name: string; items: NavItem[] }[] = [];
  for (const item of navShown) {
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
        className={TILE_LINK}
      >
        <span className={tileIcon(active)}>
          <Icon className={clsx("h-5 w-5", ICON_ZOOM)} aria-hidden />
          {item.badge ? <CountBubble n={item.badge} className="absolute -top-1 -right-1" /> : null}
        </span>
        <span className={tileLabel(active)}>{item.short ?? item.label}</span>
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
      <header ref={headerRef} className={HEADER_WRAP}>
        <div className={HEADER_BAR}>
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
            className={LOGO_LINK}
          >
            <IchijoyaLogo title="" className="h-4 w-auto max-w-[4.75rem] shrink-0 sm:h-7 sm:max-w-none" />
          </Link>

          {/* 重要な機能 (予定表・チャット): ロゴの右に常に表示し、アニメーションで目立たせる。チャットは要対応・未読の数つき */}
          {pinnedItems.map((it) =>
            it.href === "/chat" && chat ? <ChatPinnedButton key={it.href} initial={chat} active={isActive("/chat")} onClick={closeAll} /> : <PinnedButton key={it.href} item={it} active={isActive(it.href)} onClick={closeAll} />,
          )}

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
                {tabs.map((item) => (
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

          {/* 右端: スマートフォンは通知・アバターだけ。検索・新規・承認は sm 以上 (狭い画面はメニューへ) */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1 lg:ml-0">
            {/* 顧客検索 */}
            <div className="relative max-sm:hidden">
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
            <div className="relative max-sm:hidden">
              <button
                type="button"
                onClick={toggle("create")}
                aria-label="新規作成"
                aria-haspopup="menu"
                aria-expanded={menu === "create"}
                className={ACCENT_BUTTON}
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

            {/* 承認 (管理者・店長、または承認を待っている申請があるとき): 問い合わせのアイコンと同じく件数を出す */}
            {(user.canApprove || counts.approvals > 0) && (
              <Link
                href="/approvals?tab=mine"
                prefetch={false}
                onClick={closeAll}
                aria-label={counts.approvals > 0 ? `承認 (承認を待っている申請 ${counts.approvals} 件${approvalsUnseen > 0 ? `・未確認 ${approvalsUnseen} 件` : ""})` : "承認 (承認を待っている申請はありません)"}
                title={counts.approvals > 0 ? `承認を待っている申請 ${counts.approvals} 件${approvalsUnseen > 0 ? ` (未確認 ${approvalsUnseen} 件)` : ""}` : "承認"}
                data-testid="header-approvals"
                className={clsx(ICON_BUTTON, "relative max-sm:hidden", isActive("/approvals") && "bg-subtle text-ink")}
              >
                <ClipboardCheck className={clsx("h-5 w-5", ICON_ZOOM)} />
                {approvalsUnseen > 0 && <CountBubble n={approvalsUnseen} className="absolute top-1 right-1" />}
              </Link>
            )}

            {/* チャット (スマートフォン。パソコン・タブレットはロゴの右の緑のボタン。赤 = 要対応、青 = 未読。src/components/chat/ChatBadge.tsx) */}
            {chat && <ChatIconButton initial={chat} active={isActive("/chat")} />}

            {/* 通知 */}
            <div className="relative">
              <button
                type="button"
                className={clsx(ICON_BUTTON, "relative", menu === "notif" && "bg-subtle text-ink")}
                onClick={toggle("notif")}
                aria-label={unreadCount > 0 ? `通知 (未確認 ${unreadCount} 件)` : "通知"}
                aria-haspopup="menu"
                aria-expanded={menu === "notif"}
              >
                <Bell className={clsx("h-5 w-5", ICON_ZOOM)} />
                {unreadCount > 0 && <CountBubble n={unreadCount} className="absolute top-1 right-1" />}
              </button>
              {menu === "notif" && (
                <div role="menu" aria-label="通知" className={clsx(MENU_PANEL, "w-[360px]")}>
                  <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                    <span className="text-sm font-semibold text-ink">通知</span>
                    <span className="flex items-center gap-2 text-xs text-ink-3">
                      {unreadCount > 0 ? `未確認 ${unreadCount} 件` : notifications.length > 0 ? "すべて確認済み" : ""}
                      {unreadCount > 0 && (
                        <button
                          type="button"
                          onClick={() => markSeen(notifications.flatMap(notifKeys))}
                          className="rounded-md px-1.5 py-0.5 font-medium text-accent transition hover:bg-accent-soft"
                        >
                          すべて確認済みにする
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="max-h-[min(420px,calc(100dvh-7rem))] overflow-y-auto p-1.5">
                    {notifications.length === 0 && <div className="px-4 py-10 text-center text-xs text-ink-3">新しい通知はありません</div>}
                    {notifications.map((n, i) => {
                      const st = NOTIFICATION_STYLE[n.kind];
                      const keys = notifKeys(n);
                      const left = seenReady ? unseenCount(keys, seen) : 0;
                      const unread = left > 0;
                      return (
                        <Link
                          key={i}
                          href={n.href}
                          role="menuitem"
                          onClick={() => {
                            markSeen(keys);
                            closeAll();
                          }}
                          className={clsx("flex items-start gap-3 rounded-xl px-2.5 py-2 transition hover:bg-subtle", !unread && "opacity-70")}
                        >
                          <span className={clsx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", st.cls)}>
                            <st.icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={clsx("block text-sm text-ink", unread ? "font-semibold" : "font-medium")}>{n.title}</span>
                            {n.detail && <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-ink-3">{n.detail}</span>}
                          </span>
                          {/* 未確認の印: まとめた通知は確認していない件数 (確認するたびに減り、すべて確認すると消える) */}
                          {unread &&
                            (keys.length > 1 ? (
                              <span className="mt-1 shrink-0 rounded-full bg-critical px-1.5 text-[10px] leading-4 font-semibold text-white tnum" title={`未確認 ${left} 件`}>
                                {left > 99 ? "99+" : left}
                              </span>
                            ) : (
                              <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-critical" aria-hidden />
                            ))}
                          {unread && <span className="sr-only">（未確認{keys.length > 1 ? ` ${left} 件` : ""}）</span>}
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
                  "group flex shrink-0 items-center gap-1 rounded-full p-1 outline-none transition-colors hover:bg-subtle focus-visible:ring-2 focus-visible:ring-accent/40 sm:pr-1.5",
                  menu === "user" && "bg-subtle",
                )}
              >
                <span className={clsx("inline-flex shrink-0", ICON_ZOOM, "group-hover:scale-110 group-focus-visible:scale-110")}>
                  <Avatar name={user.name} id={user.id} size={32} ring src={user.avatarSrc} />
                </span>
                <ChevronDown className={clsx("hidden h-4 w-4 text-ink-3 transition-transform sm:block", menu === "user" && "rotate-180")} />
              </button>
              {menu === "user" && (
                <div role="menu" aria-label="ユーザーメニュー" className={clsx(MENU_PANEL, "w-80")}>
                  <div className="bg-linear-to-br from-accent-soft to-panel px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={user.name} id={user.id} size={48} ring src={user.avatarSrc} />
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
                      ...(user.canManageStaff ? [{ href: "/staff", label: "社員管理", icon: UserCog, count: signupsUnseen }] : []),
                      { href: "/approvals?tab=mine", label: "あなたの承認待ち", icon: ClipboardCheck, count: approvalsUnseen },
                      { href: "/chat", label: "チャット・業務依頼", icon: MessagesSquare, count: chat?.action ?? counts.mentions },
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
          <div className={DRAWER_BACKDROP} onClick={() => setDrawer(false)} aria-hidden />
          <nav
            id="app-drawer"
            aria-label="メインメニュー"
            className={DRAWER_PANEL}
          >
            {/* スマートフォン向け: ヘッダーから外した検索・新規・承認 */}
            <div className="mb-3 space-y-3 border-b border-line pb-3 sm:hidden">
              <div>
                <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-ink-3">顧客を検索</div>
                <SearchBox />
              </div>
              <div>
                <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-ink-3">新規作成</div>
                <div className="grid grid-cols-2 gap-1">
                  {CREATE_ITEMS.map((it) => (
                    <Link key={it.href} href={it.href} onClick={closeAll} className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-ink transition hover:bg-subtle">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                        <it.icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 truncate font-medium">{it.label}</span>
                    </Link>
                  ))}
                </div>
              </div>
              {(user.canApprove || counts.approvals > 0) && (
                <Link
                  href="/approvals?tab=mine"
                  prefetch={false}
                  onClick={closeAll}
                  className="flex items-center gap-2 rounded-xl bg-subtle px-3 py-2.5 text-sm font-medium text-ink transition hover:bg-line/60"
                >
                  <ClipboardCheck className="h-4 w-4 text-accent" />
                  <span className="flex-1">承認</span>
                  {approvalsUnseen > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white tnum">{approvalsUnseen}</span>}
                </Link>
              )}
            </div>
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

      <main id="main-content" className={MAIN_PAD}>
        <div className={MAIN_INNER}>{children}</div>
      </main>
      {/* 開いた画面の記録を確認済みにする (表示なし) */}
      <Suspense fallback={null}>
        <SeenOnVisit keys={allKeys} onSeen={markSeen} />
      </Suspense>
      {/* トースト (操作の結果 ?msg= / ?err= と、部品の toast.success() など。src/components/ui/toast.ts) */}
      <Toaster />
      {/* チャットの数の確認・通知音・アプリのアイコンの数字 (表示なし。1 つだけ) */}
      {chat && <ChatLive initial={chat} />}
      {/* チャットの画面は入力欄が画面の下にあるため、左下の「質問する」と右下の「↑」を出さない */}
      {!isActive("/chat") && <ChatbotWidget userName={user.name} userId={user.id} avatarSrc={user.avatarSrc} />}
      {!isActive("/chat") && <ScrollTopButton />}
    </div>
  );
}
