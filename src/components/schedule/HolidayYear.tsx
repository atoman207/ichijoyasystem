import Link from "@/components/ui/Link";
import clsx from "clsx";
import { dayOfWeek } from "@/lib/calendar";

/**
 * 休日カレンダーの 1 年 (12 か月)。画面 (/schedule/holidays) と印刷 (/print/holidays) で共通
 * 休業日は塗りつぶし、日曜・祝日は赤字、土曜は青字。月の下に祝日と休業日の名前 (「休業日」以外) を書く
 */

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export interface HolidayYearProps {
  year: number;
  /** 休業日 (日付 → 名前) */
  closed: Map<string, string>;
  holidayOf: (d: string) => string | undefined;
  today?: string;
  selected?: string;
  /** 日付を押したときのリンク (管理者の変更)。なければリンクにしない */
  hrefOf?: (d: string) => string;
  print?: boolean;
}

export function HolidayYear({ year, closed, holidayOf, today, selected, hrefOf, print }: HolidayYearProps) {
  return (
    <div className={clsx("grid gap-3", print ? "grid-cols-4 gap-x-3 gap-y-2" : "grid-cols-1 @xl:grid-cols-2 @4xl:grid-cols-3 @5xl:grid-cols-4")}>
      {Array.from({ length: 12 }, (_, i) => (
        <HolidayMonth key={i} year={year} month={i + 1} closed={closed} holidayOf={holidayOf} today={today} selected={selected} hrefOf={hrefOf} print={print} />
      ))}
    </div>
  );
}

function HolidayMonth({ year, month, closed, holidayOf, today, selected, hrefOf, print }: Omit<HolidayYearProps, "year"> & { year: number; month: number }) {
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const last = new Date(year, month, 0).getDate();
  const days = Array.from({ length: last }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
  const lead = dayOfWeek(days[0]);
  const closedCount = days.filter((d) => closed.has(d)).length;
  const notes = days
    .map((d) => {
      const h = holidayOf(d);
      const label = closed.get(d);
      const extra = label && label !== "休業日" && label !== h ? label : "";
      const text = [h, extra].filter(Boolean).join("・");
      return text ? { d, text, closed: Boolean(label) } : null;
    })
    .filter((x): x is { d: string; text: string; closed: boolean } => Boolean(x));

  return (
    <section className={clsx("rounded-xl border border-line bg-panel", print ? "break-inside-avoid p-1.5" : "p-2.5")} aria-label={`${month}月`}>
      <div className="mb-1 flex items-baseline justify-between gap-2 px-0.5">
        <h3 className={clsx("font-semibold text-ink", print ? "text-[11px]" : "text-sm")}>{month}月</h3>
        <span className={clsx("text-ink-3 tnum", print ? "text-[8px]" : "text-[11px]")}>
          休業 {closedCount} 日 · 営業 {last - closedCount} 日
        </span>
      </div>
      <div className={clsx("grid grid-cols-7 text-center", print ? "gap-px text-[9px]" : "gap-0.5 text-xs")}>
        {WEEK.map((w, i) => (
          <div key={w} className={clsx("py-0.5 font-medium", i === 0 ? "text-critical-ink" : i === 6 ? "text-info-ink" : "text-ink-3")}>
            {w}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead${i}`} />
        ))}
        {days.map((d) => {
          const h = holidayOf(d);
          const label = closed.get(d);
          const w = dayOfWeek(d);
          const title = [d, h, label].filter(Boolean).join(" ");
          const cls = clsx(
            "relative flex items-center justify-center rounded-md tnum",
            print ? "h-[15px]" : "h-8",
            label ? "bg-critical-soft font-semibold" : "",
            h || w === 0 ? "text-critical-ink" : w === 6 ? "text-info-ink" : "text-ink",
            d === today && !print && "outline outline-1 outline-accent",
            d === selected && "ring-2 ring-accent",
          );
          const body = (
            <>
              {Number(d.slice(8))}
              {h && <span aria-hidden className={clsx("absolute rounded-full bg-critical", print ? "bottom-0 h-[2px] w-[2px]" : "bottom-1 h-1 w-1")} />}
              <span className="sr-only">{[h, label].filter(Boolean).join(" ")}</span>
            </>
          );
          return hrefOf ? (
            <Link key={d} href={hrefOf(d)} className={clsx(cls, "hover:ring-1 hover:ring-accent/60")} title={title}>
              {body}
            </Link>
          ) : (
            <div key={d} className={cls} title={title}>
              {body}
            </div>
          );
        })}
      </div>
      {notes.length > 0 && (
        <ul className={clsx("mt-1 space-y-0.5 px-0.5 text-ink-2", print ? "text-[7.5px] leading-tight" : "text-[11px]")}>
          {notes.map((n) => (
            <li key={n.d} className="flex gap-1">
              <span className="shrink-0 tnum text-ink-3">{Number(n.d.slice(8))}日</span>
              <span className={clsx("min-w-0", n.closed && "font-medium text-critical-ink")}>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
