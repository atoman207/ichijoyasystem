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
 * - ログイン後の画面と同じカードの形 (角丸・罫線・影) で、本文の枠の中に置く
 * - 写真は重ねて置き、フェードで切り替える。ページ送りはカードの右下
 * - intro (見出しなど) はサーバー側で作った中身をそのまま置く (なくてもよい)
 */
export function HeroCarousel({ slides, intro }: { slides: HeroSlide[]; intro?: ReactNode }) {
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
    <section
      className="relative overflow-hidden rounded-2xl border border-line/70 text-white shadow-card"
      aria-roledescription="carousel"
      aria-label="一畳屋 統合業務システムの紹介"
    >
      <div className="absolute inset-0 bg-ink" aria-hidden>
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
        {/* 文字を読みやすくする重ね (左下を濃く) */}
        <div className="absolute inset-0 bg-linear-to-t from-ink/75 via-ink/15 to-transparent" />
        <div className="absolute inset-0 bg-linear-to-r from-ink/45 via-transparent to-transparent" />
      </div>

      <div className="relative flex min-h-[17rem] flex-col justify-end p-5 pb-14 sm:min-h-[22rem] sm:p-7 lg:min-h-[26rem] lg:p-9">
        {intro}
        <div className={clsx("max-w-xl", intro && "mt-6")} aria-live={auto ? "off" : "polite"}>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-0.5 text-[11px] font-semibold text-ink shadow-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            {current.place}
          </span>
          <div className="mt-3 grid">
            {slides.map((s, i) => (
              <div
                key={s.src}
                aria-hidden={i !== index}
                className={clsx("col-start-1 row-start-1 transition-opacity duration-700", i === index ? "opacity-100" : "pointer-events-none opacity-0")}
              >
                <p className="text-xl leading-snug font-bold tracking-tight drop-shadow-sm sm:text-[26px]">{s.title}</p>
                <p className="mt-1.5 max-w-md text-sm leading-relaxed text-white/90 drop-shadow-sm sm:text-[15px]">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="absolute right-4 bottom-4 z-10 sm:right-6 sm:bottom-6">
        <div className="flex items-center gap-1.5 rounded-full bg-ink/35 px-2.5 py-2 backdrop-blur-sm" role="tablist" aria-label="写真の切り替え">
          {slides.map((s, i) => (
            <button
              key={s.src}
              type="button"
              role="tab"
              onClick={() => setIndex(i)}
              aria-label={`${s.place}: ${s.title}`}
              aria-selected={i === index}
              className={clsx(
                "rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-ink/40",
                i === index ? "h-1.5 w-5 bg-white" : "h-1.5 w-1.5 bg-white/55 hover:bg-white/85",
              )}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
