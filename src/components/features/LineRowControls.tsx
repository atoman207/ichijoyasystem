"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, BetweenHorizontalEnd, BetweenHorizontalStart, EllipsisVertical } from "lucide-react";

/**
 * 明細の行の挿入・移動のボタン (見積の明細 QuoteEditor・書類取込の確認 DocumentReview で共通。お客様のご要望 2026-11-26「■1」)
 * - カード (狭い欄): 行の見出しに「↑」「↓」「上に挿入」「下に挿入」を並べる (タッチの端末は 44px)
 * - 表 (広い欄): 列の幅が足りないため「⋯」(行の操作) のメニューにまとめる。メニューは body に出して画面に固定する
 *   (表の枠の overflow-hidden で切れないように。コンテナクエリの枠の中では position: fixed の基準が枠になることがあるため portal)
 * 削除のボタンは今までどおり各画面に置く (赤)
 */

export type InsertWhere = "above" | "below";

interface Props {
  /** 読み上げ用の行の名前 (例: 明細 3 行目) */
  label: string;
  first: boolean;
  last: boolean;
  onInsert: (where: InsertWhere) => void;
  onMove: (delta: -1 | 1) => void;
  disabled?: boolean;
}

const BTN =
  "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-line bg-panel px-1.5 text-[11px] text-ink-2 hover:bg-subtle disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:min-w-11";

/** カードの見出しの行に置くボタン */
export function RowInlineControls({ label, first, last, onInsert, onMove, disabled }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`${label}の挿入・移動`}>
      <button type="button" className={BTN} onClick={() => onMove(-1)} disabled={disabled || first} aria-label={`${label}を上へ移動`} title="上へ移動">
        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" className={BTN} onClick={() => onMove(1)} disabled={disabled || last} aria-label={`${label}を下へ移動`} title="下へ移動">
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" className={BTN} onClick={() => onInsert("above")} disabled={disabled} aria-label={`${label}の上に行を挿入`} title="この行の上に空の行を入れる">
        <BetweenHorizontalStart className="h-3.5 w-3.5" aria-hidden />
        上に挿入
      </button>
      <button type="button" className={BTN} onClick={() => onInsert("below")} disabled={disabled} aria-label={`${label}の下に行を挿入`} title="この行の下に空の行を入れる">
        <BetweenHorizontalEnd className="h-3.5 w-3.5" aria-hidden />
        下に挿入
      </button>
    </div>
  );
}

const MENU_W = 184;
const MENU_H = 200;
/** メニューを開いたら最初の項目に (ref の関数は同じものを使う。毎回作ると描くたびに選び直す) */
const focusOnMount = (el: HTMLButtonElement | null) => el?.focus({ preventScroll: true });

/** 表の行の「⋯」メニュー (上に挿入・下に挿入・上へ・下へ) */
export function RowMenu({ label, first, last, onInsert, onMove, disabled }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  function toggle() {
    if (open) {
      setPos(null);
      return;
    }
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.bottom + 4 + MENU_H <= window.innerHeight;
    setPos({ top: below ? r.bottom + 4 : Math.max(4, r.top - 4 - MENU_H), left: Math.max(4, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 4)) });
  }
  const close = (focusButton = false) => {
    setPos(null);
    if (focusButton) btn.current?.focus({ preventScroll: true });
  };

  // 外を押す・スクロール・画面の大きさの変更で閉じる (固定の位置がずれるため)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || btn.current?.contains(t)) return;
      setPos(null);
    };
    const onScroll = (e: Event) => {
      if (menu.current?.contains(e.target as Node)) return;
      setPos(null);
    };
    const onResize = () => setPos(null);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  /** 上下の矢印でメニューの中を動く・Esc で閉じる */
  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-ink hover:bg-subtle focus:bg-subtle focus:outline-none disabled:opacity-40 pointer-coarse:min-h-11";
  function pick(fn: () => void) {
    fn();
    close(true);
  }
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}の挿入・移動`}
        title="行の挿入・移動"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-2 hover:bg-subtle hover:text-ink disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <EllipsisVertical className="h-4 w-4" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div ref={menu} role="menu" aria-label={`${label}の挿入・移動`} onKeyDown={onMenuKey} className="fixed z-50 rounded-xl border border-line bg-panel p-1 shadow-lg" style={{ top: pos.top, left: pos.left, width: MENU_W }}>
            <button type="button" role="menuitem" className={item} onClick={() => pick(() => onInsert("above"))} ref={focusOnMount}>
              <BetweenHorizontalStart className="h-4 w-4 text-accent" aria-hidden /> 上に行を挿入
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => pick(() => onInsert("below"))}>
              <BetweenHorizontalEnd className="h-4 w-4 text-accent" aria-hidden /> 下に行を挿入
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => pick(() => onMove(-1))} disabled={first}>
              <ArrowUp className="h-4 w-4 text-ink-3" aria-hidden /> 上へ移動
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => pick(() => onMove(1))} disabled={last}>
              <ArrowDown className="h-4 w-4 text-ink-3" aria-hidden /> 下へ移動
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
