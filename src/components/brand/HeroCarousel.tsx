"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
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
 * トップページのヒーロー: 店舗・本社の写真を背景に 5 秒ごとに切り替え、写真ごとにこのシステムの強みを 1 つずつ表示する
 * - 写真は重ねて置き、フェードで切り替える (すべて最初に読み込むので、切り替えでちらつかない)
 * - 強みの文は同じ場所に重ねて置き、いちばん長い文の高さを確保する (切り替えで下のボタン・ログインがずれない)
 * - 一時停止のボタンと、各スライドへのボタンを付ける。OS の「視差効果を減らす」では自動で切り替えない
 * - intro (見出し)・actions (ボタン・数字)・aside (ログイン) はサーバー側で作った中身をそのまま置く
 */
export function HeroCarousel({ slides, intro, actions, aside }: { slides: HeroSlide[]; intro: ReactNode; actions: ReactNode; aside: ReactNode }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useSyncExternalStore(subscribeReduce, () => window.matchMedia(reduceQuery).matches, () => false);
  const auto = !paused && !reduceMotion && slides.length > 1;

  // 自動の切り替え。手で選んだときは (index が変わるので) そこから 5 秒数え直す
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % slides.length), INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [auto, index, slides.length]);

  const current = slides[index];

  return (
    <section className="relative overflow-hidden bg-wa-deep text-white" aria-roledescription="carousel" aria-label="一畳屋 統合業務システムの強み">
      {/* 背景: 4 店舗と本社の写真 */}
      <div className="absolute inset-0" aria-hidden>
        {slides.map((s, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル (最適化済みの WebP)
          <img
            key={s.src}
            src={s.src}
            alt=""
            fetchPriority={i === 0 ? "high" : "low"}
            className={clsx("absolute inset-0 h-full w-full scale-105 object-cover transition-opacity duration-1000 ease-out", i === index ? "opacity-100" : "opacity-0")}
          />
        ))}
        {/* 文字を読みやすくする重ね (公式サイトの畳の緑)。スマートフォンは文字が全幅のため一様に、広い画面は文字のある左を濃く、右は写真が見えるように薄く */}
        <div className="absolute inset-0 bg-wa-deep/75 lg:bg-transparent lg:bg-linear-to-r lg:from-wa-deep/90 lg:via-wa-deep/55 lg:to-black/5" />
        <div className="absolute inset-0 bg-linear-to-t from-wa-deep/60 via-transparent to-transparent" />
        <div className="tatami-weave absolute inset-0 opacity-30" />
      </div>

      <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:py-16">
        <div className="max-w-xl self-center">
          {intro}

          {/* このシステムの強み (写真と一緒に切り替わる) */}
          <div className="mt-6 rounded-2xl bg-black/30 p-4 ring-1 ring-white/20 backdrop-blur-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-[11px] font-medium tracking-wide text-white/85">
                <span className="rounded-full bg-wa-yellow px-2 py-0.5 font-maru text-[11px] text-wa-deep tnum">
                  強み {index + 1} / {slides.length}
                </span>
                <span>写真: {current.place}</span>
              </span>
              <div className="flex items-center gap-1.5">
                {slides.map((s, i) => (
                  <button
                    key={s.src}
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-label={`強み ${i + 1}: ${s.title}`}
                    aria-current={i === index ? "true" : undefined}
                    className={clsx("h-2 rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-wa-yellow", i === index ? "w-6 bg-wa-yellow" : "w-2 bg-white/50 hover:bg-white/80")}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setPaused((p) => !p)}
                  aria-label={auto ? "自動の切り替えを止める" : "自動で切り替える"}
                  title={auto ? "自動の切り替えを止める" : "自動で切り替える"}
                  className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/30 hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-wa-yellow"
                >
                  {auto ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                </button>
              </div>
            </div>
            {/* 5 つの文を同じ場所に重ね、表示中の 1 つだけを見せる (高さはいちばん長い文に合わせる) */}
            <div className="mt-3 grid" aria-live={auto ? "off" : "polite"}>
              {slides.map((s, i) => (
                <div
                  key={s.src}
                  aria-hidden={i !== index}
                  className={clsx("col-start-1 row-start-1 transition-opacity duration-700", i === index ? "opacity-100" : "pointer-events-none opacity-0")}
                >
                  <p className="font-maru text-lg leading-snug text-wa-yellow sm:text-xl">{s.title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/95 sm:text-[15px]">{s.text}</p>
                </div>
              ))}
            </div>
          </div>

          {actions}
        </div>
        {aside}
      </div>
    </section>
  );
}
