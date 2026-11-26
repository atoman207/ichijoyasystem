"use client";

import { useEffect, useState } from "react";

/** 打刻の画面の時計 (秒まで。サーバーの時刻ではなく端末の時刻を表示するだけで、打刻の時刻はサーバーで決める) */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  if (!now) return <div className="h-[4.5rem]" aria-hidden />;
  const wd = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="text-center" aria-live="off">
      <div className="text-sm text-ink-2">
        {now.getFullYear()}年{now.getMonth() + 1}月{now.getDate()}日 ({wd})
      </div>
      <div className="font-semibold tabular-nums tracking-wider text-ink" style={{ fontSize: "clamp(2.5rem, 8vw, 3.75rem)", lineHeight: 1.1 }}>
        {p(now.getHours())}:{p(now.getMinutes())}
        <span className="text-[0.5em] text-ink-3">:{p(now.getSeconds())}</span>
      </div>
    </div>
  );
}
