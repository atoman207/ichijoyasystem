"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import clsx from "clsx";

/** ヒーローの 1 枚 (背景の写真と、その写真のあいだに表示する強み) */
export interface HeroSlide {
  /** 背景の写真 (public の静的ファイル) */
  src: string;
  /** 写真の拠点 (例: 合志店) */
  place: string;
  /** 強みの見出し */
  title: string;
  /** 強みの説明 */
  text: string;
}

/** 写真と強みを切り替える間隔 */
const INTERVAL_MS = 5000;

const reduceQuery = "(prefers-reduced-motion: reduce)";
function subscribeReduce(cb: () => void) {
  const mq = window.matchMedia(reduceQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * 公開ホームのヒーロー: 店舗・本社の写真を背景に 5 秒ごとに切り替え、写真ごとにこのシステムの強みを 1 つずつ表示する
 * - 写真は重ねて置き、フェードで切り替える
 * - ページ送りは画面下中央に置く (一時停止ボタンは付けない)
 * - intro (見出し) はサーバー側で作った中身をそのまま置く
 */
export function HeroCarousel({ slides, intro }: { slides: HeroSlide[]; intro: ReactNode }) {
  const [index, setIndex] = useState(0);
  const reduceMotion = useSyncExternalStore(subscribeReduce, () => window.matchMedia(reduceQuery).matches, () => false);
  const auto = !reduceMotion && slides.length > 1;

  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % slides.length), INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [auto, index, slides.length]);

  const current = slides[index] ?? slides[0];
  if (!current) return null;

  return (
    <section className="relative min-h-[min(70vh,36rem)] overflow-hidden text-white" aria-roledescription="carousel" aria-label="一畳屋 統合業務システムの紹介">
      <div className="absolute inset-0 bg-wa-deep" aria-hidden>
        {slides.map((s, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル (最適化済みの WebP)
          <img
            key={s.src}
            src={s.src}
            alt=""
            fetchPriority={i === 0 ? "high" : "low"}
            className={clsx("absolute inset-0 h-full w-full object-cover transition-opacity duration-1000 ease-out", i === index ? "opacity-100" : "opacity-0")}
          />
        ))}
        <div className="absolute inset-0 bg-linear-to-t from-black/50 via-black/10 to-transparent" />
      </div>

      <div className="relative mx-auto flex min-h-[min(70vh,36rem)] max-w-6xl flex-col justify-end px-4 pb-14 pt-20 sm:px-6 sm:pb-16">
        <div className="max-w-xl">
          {intro}

          <div className="mt-8 max-w-lg" aria-live={auto ? "off" : "polite"}>
            <span className="inline-block border border-white/40 px-2.5 py-0.5 font-maru text-[11px] tracking-wider text-white/90">
              {current.place}
            </span>
            <div className="mt-3 grid">
              {slides.map((s, i) => (
                <div
                  key={s.src}
                  aria-hidden={i !== index}
                  className={clsx("col-start-1 row-start-1 transition-opacity duration-700", i === index ? "opacity-100" : "pointer-events-none opacity-0")}
                >
                  <p className="font-maru text-xl leading-snug tracking-tight drop-shadow-sm sm:text-2xl">{s.title}</p>
                  <p className="mt-1.5 max-w-md text-sm leading-relaxed text-white/85 drop-shadow-sm sm:text-[15px]">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center sm:bottom-5">
        <div className="pointer-events-auto flex items-center gap-1.5" role="tablist" aria-label="写真の切り替え">
          {slides.map((s, i) => (
            <button
              key={s.src}
              type="button"
              role="tab"
              onClick={() => setIndex(i)}
              aria-label={`${s.place}: ${s.title}`}
              aria-selected={i === index}
              className={clsx(
                "rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/40",
                i === index ? "h-1.5 w-5 bg-white" : "h-1.5 w-1.5 bg-white/50 hover:bg-white/80",
              )}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
