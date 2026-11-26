"use client";

import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Bell, CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import Link from "@/components/ui/Link";
import { closeStickyElsewhere, getServerToasts, getToasts, showResult, subscribeToasts, toast, TOAST_LABEL, type ToastItem, type ToastTone } from "./toast";
import { noticeStyle } from "./notice-style";

/**
 * トーストの表示 (AppShell に 1 つだけ。仕組みは ./toast.ts)
 * - 位置: 画面の右上 = ヘッダーのすぐ下の右端 (ベルの下。新しいものが上)。スマートフォンは上に左右 12px の余白で横いっぱい
 *   (下は「質問する」・予定表のボタンと重ならない)
 * - 画面の操作の結果 (?msg= / ?err=) を URL から読んで出し、URL から外す (ToastFromUrl)
 * - 閉じる: × / 横にはらう (タッチ) / 時間 (完了・お知らせ・注意)。マウスを乗せる・押さえる・別のタブのあいだは止める
 * - 読み上げ: 完了・お知らせ・通知は status (polite)、エラー・注意は alert
 * - 通知 (tone = notice) は種類 (style) ごとの色・アイコン・ラベル (承認 = 黄・請求 = 赤・LINE = 緑・メール = 青緑など。./notice-style.ts。ベルの行と同じ)
 */

const TONE: Record<ToastTone, { icon: LucideIcon; bar: string; chip: string; label: string }> = {
  success: { icon: CircleCheck, bar: "bg-good", chip: "bg-good-soft text-good-ink", label: "text-good-ink" },
  error: { icon: CircleAlert, bar: "bg-critical", chip: "bg-critical-soft text-critical-ink", label: "text-critical-ink" },
  info: { icon: Info, bar: "bg-info", chip: "bg-info-soft text-info-ink", label: "text-info-ink" },
  warn: { icon: TriangleAlert, bar: "bg-warn", chip: "bg-warn-soft text-warn-ink", label: "text-warn-ink" },
  notice: { icon: Bell, bar: "bg-accent", chip: "bg-accent-soft text-accent-ink", label: "text-accent-ink" },
};

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};

export function Toaster() {
  const list = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  const hidden = useSyncExternalStore(subscribeVisibility, () => document.hidden, () => false);
  const pathname = usePathname();
  useEffect(() => {
    closeStickyElsewhere(pathname);
  }, [pathname]);
  return (
    <>
      <Suspense fallback={null}>
        <ToastFromUrl />
      </Suspense>
      {/* 右端はヘッダーのカードの右端にそろえる (ヘッダーと同じ左右の余白・最大の幅) */}
      <section aria-label="お知らせ" className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+5.25rem)] z-[100] px-3 sm:px-4 lg:px-6" data-testid="toaster">
        <div className="mx-auto flex max-w-[1680px] flex-col items-stretch gap-2 sm:items-end">
          {list.map((t) => (
            <ToastCard key={t.id} item={t} hidden={hidden} />
          ))}
        </div>
      </section>
    </>
  );
}

/**
 * 画面の操作の結果 (Server Action の redirect の ?msg= / ?err=) をトーストにして、URL から外す (読み込み直し・戻るで二度出さない)。
 * URL の書き換えは EventQuick.tsx と同じく setTimeout のあと・状態は null (Next.js が履歴の書き換えを受け取る用意は一番上の部品の useEffect でするため)
 */
function ToastFromUrl() {
  const params = useSearchParams();
  const msg = params.get("msg");
  const err = params.get("err");
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!msg && !err) {
      handled.current = null;
      return;
    }
    const key = `${msg ?? ""}\u0000${err ?? ""}`;
    if (handled.current !== key) {
      handled.current = key;
      showResult(msg, err);
    }
    const t = window.setTimeout(() => {
      const u = new URL(window.location.href);
      if (!u.searchParams.has("msg") && !u.searchParams.has("err")) return;
      u.searchParams.delete("msg");
      u.searchParams.delete("err");
      window.history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
    }, 0);
    return () => window.clearTimeout(t);
  }, [msg, err]);
  return null;
}

/** トーストの色・アイコン・ラベル: 通知は種類ごと (notice-style.ts)、それ以外は完了・エラー・お知らせ・注意 */
function toastLook(item: ToastItem): { icon: LucideIcon; bar: string; chip: string; label: string; title: string } {
  if (item.tone === "notice") {
    const s = noticeStyle(item.style);
    return { icon: s.icon, bar: s.bar, chip: s.chip, label: s.text, title: item.title ?? s.label };
  }
  const t = TONE[item.tone];
  return { ...t, title: item.title ?? TOAST_LABEL[item.tone] };
}

function ToastCard({ item, hidden }: { item: ToastItem; hidden: boolean }) {
  const tone = toastLook(item);
  const Icon = tone.icon;
  const [hover, setHover] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const timed = item.duration !== "sticky";
  const ms = typeof item.duration === "number" ? item.duration : 0;
  // 押さえているあいだ (タッチ) も hover にして止める
  const paused = hover || hidden;
  // 残りの時間 (止めたら残りを覚える)。まとめた (bump) ときは数え直す
  const left = useRef(ms);
  useEffect(() => {
    left.current = ms;
  }, [item.bump, ms]);
  useEffect(() => {
    if (!timed || paused || leaving) return;
    const started = Date.now();
    const t = window.setTimeout(() => setLeaving(true), Math.max(0, left.current));
    return () => {
      window.clearTimeout(t);
      left.current -= Date.now() - started;
    };
  }, [timed, paused, leaving, item.bump]);
  // 消えるときは少し薄くしてから外す
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => toast.dismiss(item.id), 160);
    return () => window.clearTimeout(t);
  }, [leaving, item.id]);
  const close = () => setLeaving(true);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("a,button")) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    setHover(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const x = e.clientX - d.x;
    if (Math.abs(x) > Math.abs(e.clientY - d.y)) setDx(x);
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    drag.current = null;
    setHover(false);
    if (Math.abs(dx) > 72) close();
    else setDx(0);
  };

  return (
    <div
      role={item.tone === "error" || item.tone === "warn" ? "alert" : "status"}
      aria-atomic="true"
      data-testid="toast"
      data-tone={item.tone}
      data-style={item.tone === "notice" ? (item.style ?? "bell") : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 220) } : undefined}
      className={clsx(
        "pointer-events-auto relative w-full touch-pan-y overflow-hidden rounded-xl border border-line bg-panel shadow-pop transition-opacity duration-150 animate-drop sm:w-[400px]",
        leaving && "opacity-0",
      )}
    >
      <span className={clsx("absolute inset-y-0 left-0 w-1", tone.bar)} aria-hidden />
      <div className="flex items-start gap-3 py-3 pr-1.5 pl-4">
        <span className={clsx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", tone.chip)} aria-hidden>
          <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1 pt-px">
          <div className={clsx("flex items-center gap-1.5 text-xs font-semibold", tone.label)}>
            {tone.title}
            {item.count > 1 && <span className="rounded-full bg-neutral-soft px-1.5 text-[11px] font-medium text-ink-2 tnum">×{item.count}</span>}
          </div>
          <p className={clsx("mt-0.5 max-h-[40vh] overflow-y-auto text-sm leading-relaxed break-words whitespace-pre-line text-ink", item.tone === "notice" && "font-semibold")}>{item.text}</p>
          {item.detail && <p className="mt-0.5 line-clamp-3 text-xs leading-snug break-words text-ink-2">{item.detail}</p>}
          {item.action &&
            (item.action.href ? (
              <Link href={item.action.href} onClick={() => { item.action?.onClick?.(); close(); }} className="mt-1.5 inline-flex rounded-lg px-2 py-1 text-sm font-medium text-accent-ink hover:bg-accent-soft">
                {item.action.label}
              </Link>
            ) : (
              <button type="button" onClick={() => { item.action?.onClick?.(); close(); }} className="mt-1.5 inline-flex rounded-lg px-2 py-1 text-sm font-medium text-accent-ink hover:bg-accent-soft">
                {item.action.label}
              </button>
            ))}
        </div>
        <button type="button" onClick={close} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-subtle hover:text-ink" aria-label="この知らせを閉じる" title="閉じる">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {timed && (
        <span
          key={item.bump}
          aria-hidden
          className={clsx("absolute bottom-0 left-0 h-[3px] w-full origin-left opacity-60 motion-reduce:hidden", tone.bar)}
          style={{ animation: `toast-bar ${ms}ms linear forwards`, animationPlayState: paused || leaving ? "paused" : "running" }}
        />
      )}
    </div>
  );
}
