"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowUp } from "lucide-react";

/** 下にスクロールすると右下に出る「ページの先頭へ」のボタン */
export function ScrollTopButton({ threshold = 400 }: { threshold?: number }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  const toTop = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="ページの先頭へ"
      title="ページの先頭へ"
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
      className={clsx(
        "fixed right-4 bottom-4 z-40 grid h-11 w-11 place-items-center rounded-full border border-line bg-panel text-accent shadow-pop transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:right-6 sm:bottom-6",
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
      )}
    >
      <ArrowUp className="h-5 w-5" aria-hidden />
    </button>
  );
}
