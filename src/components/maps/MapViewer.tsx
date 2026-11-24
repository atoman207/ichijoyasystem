"use client";

import { useRef, useState, type MouseEvent } from "react";
import Link from "@/components/ui/Link";
import { ArrowLeft, Maximize2, Minus, Plus } from "lucide-react";
import { buttonClass } from "@/components/ui";

/**
 * 住宅地図の表示 (お客様のご要望 2026-11-24「① 登録済みPDF地図の表示」)
 * ------------------------------------------------------------
 * PDF をそのまま開かずに、システムの画面の中で地図の画像 (/api/maps/documents/<ID>/page) を出す。
 * 地図を押すと拡大 (押した場所を中心に)・もう一度押すと元の大きさ。＋ − でも変えられ、拡大中は指・マウスで動かせる。
 * 画像にできないとき (サーバーに変換の道具がないなど) は、画面の中に PDF を出す
 */

const SCALES = [1, 1.5, 2, 3, 4];

export function MapPageImage({ src, pdfSrc, alt, page, pages }: { src: string; pdfSrc: string; alt: string; page: number; pages: number }) {
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  /** 倍率を変えて、指定した点 (画像の中の割合) を枠の中央に */
  function zoomTo(next: number, rx = 0.5, ry = 0.5) {
    setScale(next);
    requestAnimationFrame(() => {
      const el = box.current;
      const img = el?.querySelector("img");
      if (!el || !img) return;
      el.scrollLeft = Math.max(0, rx * img.clientWidth - el.clientWidth / 2);
      el.scrollTop = Math.max(0, ry * img.clientHeight - el.clientHeight / 2);
    });
  }

  function onImageClick(e: MouseEvent<HTMLImageElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const rx = r.width ? (e.clientX - r.left) / r.width : 0.5;
    const ry = r.height ? (e.clientY - r.top) / r.height : 0.5;
    zoomTo(scale === 1 ? 2 : 1, rx, ry);
  }

  const step = (dir: 1 | -1) => {
    const i = SCALES.indexOf(scale);
    const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    if (next !== scale) zoomTo(next);
  };

  if (failed) {
    return (
      <figure className="space-y-1">
        <iframe src={pdfSrc} title={alt} className="h-[75vh] w-full rounded-lg border border-line bg-white" />
        <figcaption className="text-[11px] text-ink-3">地図を画像にできなかったため、PDF を表示しています。表示されないときは下の「ダウンロード」をお使いください。</figcaption>
      </figure>
    );
  }

  return (
    <figure className="space-y-1.5" data-testid="map-page">
      <div className="flex flex-wrap items-center gap-1.5">
        {pages > 1 && <span className="mr-1 text-xs font-medium text-ink-2">{page} / {pages} ページ</span>}
        <button type="button" onClick={() => step(-1)} disabled={scale === SCALES[0]} className={buttonClass("secondary", "sm")} aria-label="縮小">
          <Minus />
        </button>
        <span className="tnum w-12 text-center text-xs text-ink-2">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => step(1)} disabled={scale === SCALES[SCALES.length - 1]} className={buttonClass("secondary", "sm")} aria-label="拡大">
          <Plus />
        </button>
        {scale !== 1 && (
          <button type="button" onClick={() => zoomTo(1)} className={buttonClass("ghost", "sm")}>
            <Maximize2 />
            画面の幅に戻す
          </button>
        )}
      </div>
      <div ref={box} className={`relative rounded-lg border border-line bg-white ${scale === 1 ? "" : "max-h-[78vh] overflow-auto overscroll-contain"}`}>
        {!loaded && <div className="flex h-48 items-center justify-center text-xs text-ink-3">地図を読み込んでいます…</div>}
        {/* eslint-disable-next-line @next/next/no-img-element -- 権限を確かめて返す画像 (/api/maps/documents/<ID>/page) */}
        <img
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          onClick={onImageClick}
          style={scale === 1 ? undefined : { width: `${scale * 100}%`, maxWidth: "none" }}
          className={`block h-auto ${scale === 1 ? "w-full cursor-zoom-in" : "cursor-zoom-out"} ${loaded ? "" : "absolute h-px w-px opacity-0"}`}
        />
      </div>
      <figcaption className="text-[11px] text-ink-3">地図を押すと拡大します (押した場所が中央)。もう一度押すと元の大きさに戻ります。{scale !== 1 ? "拡大中は指・マウスで動かせます。" : ""}</figcaption>
    </figure>
  );
}

/** 画面のカードの小さな表示 (押すと地図の画面へ)。押したときだけ読み込む */
export function MapPreview({ src, href, title }: { src: string; href: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="w-full">
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "プレビューを閉じる" : "プレビュー"}
      </button>
      {open &&
        (failed ? (
          <p className="mt-2 text-xs text-ink-3">プレビューを表示できません。「地図を開く」で表示してください。</p>
        ) : (
          <Link href={href} className="mt-2 block overflow-hidden rounded-lg border border-line bg-white" title={`${title} を大きく表示`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 権限を確かめて返す画像 */}
            <img src={src} alt={title} onError={() => setFailed(true)} className="block h-auto w-full" />
          </Link>
        ))}
    </div>
  );
}

/** 元の画面に戻るボタン (地図の画面の上と下) */
export function MapBackButton({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={buttonClass("primary", "lg")} data-testid="map-back">
      <ArrowLeft />
      {label}
    </Link>
  );
}
