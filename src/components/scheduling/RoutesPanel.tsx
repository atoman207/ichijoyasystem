"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { AlertTriangle, Car, Loader2, MapPin, Route } from "lucide-react";
import Link from "@/components/ui/Link";
import type { StoreId } from "@/lib/db/types";
import type { DayRoute } from "@/lib/scheduling/route";
import { dayRoutesAction } from "@/lib/actions/scheduling";
import { Button, Field, Input, Select } from "@/components/ui";

/**
 * 1 日の巡回順 (計画の画面「巡回順」・最適化の結果)
 * 時刻の決まった予定は動かさず、時刻未定の予定を移動が最も短くなる順に並べる (src/lib/scheduling/route.ts)
 */

export function RouteList({ routes }: { routes: DayRoute[] }) {
  if (!routes.length) return <p className="text-xs text-ink-3">この日の担当者が決まっている現場の予定はありません。</p>;
  return (
    <ul className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
      {routes.map((r) => (
        <li key={`${r.userId}-${r.day}`} className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink">
              {r.name} <span className="text-xs font-normal text-ink-3">{r.day}</span>
            </p>
            <span className="text-[11px] text-ink-3 tnum">
              出発 {r.startAt} → 帰着 {r.endAt}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-2">
            移動 合計 {r.totalTravel} 分{r.source === "google" ? " (道路の経路)" : " (目安)"}
            {r.reordered && r.currentTravel > r.totalTravel && <span className="ml-1 font-semibold text-good-ink">順番を変えると {r.currentTravel - r.totalTravel} 分短くなります (予定表の時刻の順だと {r.currentTravel} 分)</span>}
            {r.overtimeMin > 0 && <span className="ml-1 text-warn-ink">残業の見込み 約 {Math.round(r.overtimeMin / 15) * 15} 分</span>}
          </p>
          <ol className="mt-2 space-y-1">
            {r.stops.map((s, i) => (
              <li key={s.itemId} className="flex items-start gap-2 text-xs">
                <span className={clsx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold", s.fixed ? "bg-accent text-white" : "bg-accent-soft text-accent-ink")} title={s.fixed ? "時刻の決まった予定" : "時刻未定の予定 (この順を提案)"}>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-ink">
                    <span className="font-semibold tnum">{s.start}</span>
                    <span className="text-ink-3 tnum">–{s.end}</span>{" "}
                    {s.itemId.startsWith("hold") ? (
                      <span>{s.title}</span>
                    ) : (
                      <Link href={`/schedule/${s.itemId}`} className="hover:text-accent hover:underline">
                        {s.title}
                      </Link>
                    )}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
                    <span className="inline-flex items-center gap-0.5">
                      <Car className="h-3 w-3" aria-hidden /> {s.travelMin} 分
                    </span>
                    {s.place && (
                      <span className="inline-flex items-center gap-0.5">
                        <MapPin className="h-3 w-3" aria-hidden /> {s.place}
                      </span>
                    )}
                    <span>{s.kind}</span>
                    {!s.fixed && <span className="text-accent-ink">開始 {s.start} を提案</span>}
                    {s.lateMin && (
                      <span className="inline-flex items-center gap-0.5 text-critical-ink">
                        <AlertTriangle className="h-3 w-3" aria-hidden /> 約束の時刻に {s.lateMin} 分遅れます
                      </span>
                    )}
                    {s.outOfSlot && <span className="text-warn-ink">時間帯 (午前/午後) を過ぎます</span>}
                    {s.noGeo && <span>場所が分からないため移動は目安</span>}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-1 text-[11px] text-ink-3">帰りの移動 {r.returnTravel} 分</p>
        </li>
      ))}
    </ul>
  );
}

export function RoutesPanel({ stores, defaultStore, today }: { stores: { id: StoreId; name: string }[]; defaultStore: StoreId; today: string }) {
  const [store, setStore] = useState<string>(defaultStore);
  const [date, setDate] = useState(today);
  const [routes, setRoutes] = useState<DayRoute[] | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setRoutes(await dayRoutesAction({ storeId: store, date }).catch(() => []));
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="店舗">
          <Select value={store} onChange={(e) => setStore(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="日">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Button type="button" onClick={run} disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Route className="h-4 w-4" aria-hidden />}
          巡回順を計算する
        </Button>
      </div>
      {routes && <RouteList routes={routes} />}
    </div>
  );
}
