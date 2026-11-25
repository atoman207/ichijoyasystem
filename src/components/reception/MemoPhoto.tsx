"use client";

import { useState } from "react";
import clsx from "clsx";
import { Maximize2, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";

/**
 * 受付メモの写真を見ながら読み取った文字を直す (お客様のご要望 2026-11-25「⑧ 読み取った画像と変換後の文字を確認しながら修正」)。
 * 拡大・縮小・回転・全画面。スクロールで写真の中を動かす (拡大しても欄のそばで見比べられる)
 */
export function MemoPhoto({ src, fullSrc, alt = "受付メモの写真", compact = false }: { src: string; fullSrc: string; alt?: string; compact?: boolean }) {
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [full, setFull] = useState(false);
  const tools = (dark = false) => (
    <div className={clsx("flex items-center gap-1", dark ? "text-white" : "text-ink-2")}>
      <button type="button" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-black/10 disabled:opacity-40" aria-label="縮小">
        <ZoomOut className="h-4 w-4" />
      </button>
      <span className="w-10 text-center text-[11px] tnum">{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.5))} disabled={zoom >= 4} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-black/10 disabled:opacity-40" aria-label="拡大">
        <ZoomIn className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => setRot((r) => (r + 90) % 360)} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-black/10" aria-label="回転">
        <RotateCw className="h-4 w-4" />
      </button>
      {!dark && (
        <button type="button" onClick={() => setFull(true)} className="ml-auto inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs hover:bg-black/5" aria-label="全画面で見る">
          <Maximize2 className="h-4 w-4" />
          全画面
        </button>
      )}
    </div>
  );
  const img = (cls: string, source: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={source} alt={alt} draggable={false} className={cls} style={{ width: `${zoom * 100}%`, maxWidth: "none", transform: `rotate(${rot}deg)`, transformOrigin: "center" }} />
  );
  return (
    <div data-testid="memo-photo">
      {tools()}
      <div className={clsx("mt-1 overflow-auto rounded-lg border border-line bg-subtle", compact ? "max-h-56" : "max-h-[70vh]")} onDoubleClick={() => setZoom((z) => (z >= 2 ? 1 : 2))}>
        {img("block h-auto", src)}
      </div>
      <p className="mt-1 text-[11px] text-ink-3">ダブルクリック (2 回タップ) で拡大。黄色の欄は AI が読みにくかった項目です。写真と見比べて直してください。</p>
      {full && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label="受付メモの写真 (全画面)">
          <div className="flex items-center gap-2 px-3 py-2">
            {tools(true)}
            <button type="button" onClick={() => setFull(false)} className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-white hover:bg-white/10" aria-label="閉じる">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto" onDoubleClick={() => setZoom((z) => (z >= 2 ? 1 : 2))}>
            {img("mx-auto block h-auto", fullSrc)}
          </div>
        </div>
      )}
    </div>
  );
}
