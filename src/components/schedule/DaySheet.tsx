import Link from "@/components/ui/Link";
import clsx from "clsx";
import { Globe, Plus, Settings2, TriangleAlert } from "lucide-react";
import type { ScheduleEvent } from "@/lib/db/types";
import { SHEET_ITEMS, SHEET_ITEM_LABEL, hasCols, itemTotal, perEventKindsLabel, sheetNum, workloadFormula, type DayLoadSettings, type SheetBand, type SheetCols, type SheetRow, type SheetSide, type StoreSheet } from "@/lib/day-sheet";
import { KindMark, shortName } from "./parts";
import { eventHref, titleOf, type CalendarContext } from "./CalendarViews";
import { timeLabel } from "@/lib/calendar";
import { setDayCarry } from "@/lib/actions/day-load";
import { Button, Input } from "@/components/ui";

/**
 * 日ごとの予定表 (スプレッドシートの形。お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」)
 * 店舗ごとに 左 = 引取・見積・現調・会議など / 右 = 納品、上 = 午前 / 下 = 午後。一番下に枚数の合計・換算作業量・前日繰越・対応可能枚数と超過。
 * 見積・現調・現場管理の行は枚数の欄に「1件 3枚換算」(実際の枚数ではない。お客様のご説明 2026-11-25 の補足「①」)。
 * 計算は src/lib/day-sheet.ts。予定を押すと予定表の上の小さな画面 (EventQuickHost) で開く
 */

const BANDS: { id: SheetBand; label: string }[] = [
  { id: "am", label: "午前 (AM)" },
  { id: "pm", label: "午後 (PM)" },
  { id: "none", label: "時間指定なし" },
];

const SIDE_TITLE: Record<SheetSide, string> = { left: "引取・見積・現調・会議など", right: "納品" };

const staffNames = (ctx: CalendarContext, ids: string[]) => ids.map((id) => ctx.users.get(id)?.name).filter((n): n is string => Boolean(n));

function Verdict({ s, size = "md", carry = false }: { s: StoreSheet; size?: "sm" | "md"; carry?: boolean }) {
  const cap = s.capacity;
  if (!cap) return null;
  const base = size === "md" ? "rounded-xl px-3 py-2 text-sm" : "rounded-full px-2 py-0.5 text-[11px]";
  if (cap.closed) return <span className={clsx(base, "bg-subtle font-medium text-ink-2")}>休業日{carry && s.over > 0 && size === "md" ? ` (${sheetNum(s.over)} 枚を次の営業日へ繰越)` : ""}</span>;
  if (cap.capacity <= 0) return <span className={clsx(base, "bg-warn-soft font-medium text-warn-ink")}>対象人数 0 人</span>;
  if (s.over > 0)
    return (
      <span className={clsx(base, "inline-flex items-center gap-1 bg-critical-soft font-semibold text-critical-ink")} data-testid="day-load-over">
        <TriangleAlert className={size === "md" ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
        {sheetNum(s.over)} 枚オーバー{size === "md" && <span className="font-normal">{carry ? "(翌日に繰越)" : "(翌日持越の目安)"}</span>}
      </span>
    );
  return (
    <span className={clsx(base, "bg-good-soft font-medium text-good-ink")} data-testid="day-load-ok">
      あと {sheetNum(Math.round((cap.capacity - s.workload) * 10) / 10) || "0"} 枚
    </span>
  );
}

function NumCells({ cols, muted, strong }: { cols: SheetCols; muted?: boolean; strong?: boolean }) {
  return (
    <>
      {SHEET_ITEMS.map((k) => (
        <FragmentCells key={k} a={cols[k].omote} b={cols[k].fresh} muted={muted} strong={strong} />
      ))}
    </>
  );
}

function FragmentCells({ a, b, muted, strong }: { a: number; b: number; muted?: boolean; strong?: boolean }) {
  const cls = clsx("px-0.5 py-1 text-center tnum", muted ? "text-ink-3 italic" : "text-ink", strong && "font-semibold");
  return (
    <>
      <td className={clsx(cls, "border-l border-line")}>{sheetNum(a)}</td>
      <td className={cls}>{sheetNum(b)}</td>
    </>
  );
}

/** 品目の数の短い文 (狭い画面の行): 畳 表6 新2 / 襖 表3 */
function colsText(c: SheetCols): string {
  return SHEET_ITEMS.filter((k) => itemTotal(c, k) > 0)
    .map((k) => `${SHEET_ITEM_LABEL[k]} ${[c[k].omote ? `表${sheetNum(c[k].omote)}` : "", c[k].fresh ? `新${sheetNum(c[k].fresh)}` : ""].filter(Boolean).join(" ")}`)
    .join(" / ");
}

function rowLabel(ctx: CalendarContext, r: SheetRow): string {
  const e = r.event;
  const staff = staffNames(ctx, e.assigneeIds).join("・") || "担当未定";
  const load = r.mode === "fixed" ? `(1件 ${sheetNum(r.fixed ?? 0) || "0"}枚換算${r.counted ? "" : "・数えない"}) ` : r.counted || r.mode === "count" ? "" : "(作業量に数えない) ";
  return `${timeLabel(e)} ${titleOf(ctx, e)} ${load}${colsText(r.cols)} ${staff}`.replace(/\s+/g, " ").trim();
}

function SideTable({ side, rows, totals, ctx, set }: { side: SheetSide; rows: SheetRow[]; totals: SheetCols; ctx: CalendarContext; set: DayLoadSettings }) {
  const bands = BANDS.filter((b) => b.id !== "none" || rows.some((r) => r.band === "none"));
  const holds = rows.some((r) => r.hold && (hasCols(r.cols) || r.mode === "fixed"));
  const fixedRows = rows.filter((r) => r.mode === "fixed" && r.counted);
  const totalNote =
    side === "left"
      ? `引取・現見・施工・採寸の枚数の合計${fixedRows.length ? ` (ほかに${perEventKindsLabel(set.perEventKinds)} ${fixedRows.length} 件 × ${sheetNum(set.perEvent) || "0"} 枚)` : ""}`
      : set.countDelivery
        ? "納品の合計 (作業量に数える)"
        : "納品の合計 (作業量には数えない)";
  return (
    <div className="min-w-0" data-testid={`day-sheet-${side}`}>
      <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-ink">
        <span className={clsx("rounded-md px-2 py-0.5", side === "left" ? "bg-warn-soft text-warn-ink" : "bg-good-soft text-good-ink")}>{SIDE_TITLE[side]}</span>
        <span className="font-normal text-ink-3 tnum">{rows.length} 件</span>
      </h4>

      {/* 広い欄: スプレッドシートと同じ並びの表 */}
      <div className="hidden overflow-x-auto rounded-lg border border-line @3xl:block">
        <table className="w-full min-w-[600px] table-fixed border-collapse text-[11px] leading-tight">
          <colgroup>
            <col className="w-[52px]" />
            <col className="w-[60px]" />
            <col className="w-[96px]" />
            <col className="w-[52px]" />
            {SHEET_ITEMS.flatMap((k) => [<col key={`${k}a`} className="w-[24px]" />, <col key={`${k}b`} className="w-[24px]" />])}
            <col />
            <col className="w-[62px]" />
          </colgroup>
          <thead className="bg-subtle text-[10px] text-ink-2">
            <tr>
              <th rowSpan={2} className="px-1 py-1 text-left font-medium">時間</th>
              <th rowSpan={2} className="px-1 py-1 text-left font-medium">地名</th>
              <th rowSpan={2} className="px-1 py-1 text-left font-medium">現場</th>
              <th rowSpan={2} className="px-1 py-1 text-left font-medium">内容</th>
              {SHEET_ITEMS.map((k) => (
                <th key={k} colSpan={2} className="border-l border-line px-0.5 pt-1 text-center font-semibold text-ink">
                  {SHEET_ITEM_LABEL[k]}
                </th>
              ))}
              <th rowSpan={2} className="border-l border-line px-1 py-1 text-left font-medium">備考</th>
              <th rowSpan={2} className="px-1 py-1 text-left font-medium">担当者</th>
            </tr>
            <tr>
              {SHEET_ITEMS.flatMap((k) => [
                <th key={`${k}a`} className="border-l border-line px-0.5 pb-1 text-center font-normal" title="表替え・裏返し・張替え">
                  表
                </th>,
                <th key={`${k}b`} className="px-0.5 pb-1 text-center font-normal" title="新調">
                  新
                </th>,
              ])}
            </tr>
          </thead>
          {bands.map((b) => {
            const list = rows.filter((r) => r.band === b.id);
            return (
              <tbody key={b.id}>
                <tr className="border-t border-line">
                  <th colSpan={14} scope="rowgroup" className={clsx("px-1.5 py-0.5 text-left text-[10px] font-semibold", b.id === "am" ? "bg-info-soft/60 text-info-ink" : b.id === "pm" ? "bg-accent-soft/60 text-accent-ink" : "bg-subtle text-ink-2")}>
                    {b.label} <span className="font-normal tnum">{list.length} 件</span>
                  </th>
                </tr>
                {list.length === 0 && (
                  <tr className="border-t border-line">
                    <td colSpan={14} className="px-1.5 py-1.5 text-ink-3">
                      予定なし
                    </td>
                  </tr>
                )}
                {list.map((r) => {
                  const e = r.event;
                  const names = staffNames(ctx, e.assigneeIds);
                  return (
                    <tr key={e.id} className={clsx("border-t border-line align-top hover:bg-subtle/60", r.hold && "opacity-70")}>
                      <td className="px-1 py-1 whitespace-nowrap text-ink-2 tnum">{r.time}</td>
                      <td className="truncate px-1 py-1 text-ink-2" title={r.town}>
                        {r.town}
                      </td>
                      <td className="truncate px-1 py-1">
                        <Link href={eventHref(e)} data-ev={e.id} title={rowLabel(ctx, r)} aria-label={rowLabel(ctx, r)} className={clsx("font-medium text-ink hover:underline", r.hold && "border-b border-dashed border-ink-3")}>
                          {r.site}
                        </Link>
                      </td>
                      <td className="px-1 py-1">
                        <Link href={eventHref(e)} data-ev={e.id} tabIndex={-1} aria-hidden>
                          <KindMark kind={e.kind} />
                        </Link>
                      </td>
                      {r.mode === "count" ? (
                        <NumCells cols={r.cols} muted={!r.counted && !(side === "right" && !r.hold)} />
                      ) : r.mode === "fixed" ? (
                        <td colSpan={8} className={clsx("border-l border-line px-1 py-1 text-center text-[10px]", r.counted ? "text-ink-2" : "text-ink-3 italic")} title={`${perEventKindsLabel(set.perEventKinds)}の予定は 1 件 = ${sheetNum(r.fixed ?? 0) || "0"} 枚として作業量に足します (実際の枚数ではありません)`}>
                          1件 {sheetNum(r.fixed ?? 0) || "0"}枚換算
                        </td>
                      ) : (
                        <td colSpan={8} className="border-l border-line" />
                      )}
                      <td className="truncate border-l border-line px-1 py-1 text-ink-2" title={r.remark}>
                        {r.remark}
                      </td>
                      <td className="truncate px-1 py-1 text-ink-2" title={names.join("・")}>
                        {names.map(shortName).join("・")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
          <tfoot>
            <tr className="border-t-2 border-line bg-subtle">
              <th colSpan={4} className="px-1.5 py-1 text-right text-[10px] font-semibold text-ink" title={totalNote}>
                計
              </th>
              <NumCells cols={totals} strong />
              <td colSpan={2} className="truncate border-l border-line px-1 py-1 text-[10px] text-ink-3" title={totalNote}>
                {totalNote}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 狭い欄 (スマートフォン): 1 予定 = 1 行のカード */}
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line @3xl:hidden">
        {bands.map((b) => {
          const list = rows.filter((r) => r.band === b.id);
          return [
            <li key={`h-${b.id}`} className={clsx("px-2 py-1 text-[11px] font-semibold", b.id === "am" ? "bg-info-soft/60 text-info-ink" : b.id === "pm" ? "bg-accent-soft/60 text-accent-ink" : "bg-subtle text-ink-2")}>
              {b.label} <span className="font-normal tnum">{list.length} 件</span>
            </li>,
            ...(list.length === 0
              ? [
                  <li key={`n-${b.id}`} className="px-2 py-1.5 text-xs text-ink-3">
                    予定なし
                  </li>,
                ]
              : list.map((r) => {
                  const e = r.event;
                  const names = staffNames(ctx, e.assigneeIds);
                  const work = r.mode === "fixed" ? `1件 ${sheetNum(r.fixed ?? 0) || "0"}枚換算` : colsText(r.cols);
                  return (
                    <li key={e.id} className={clsx("px-2 py-1.5", r.hold && "opacity-70")}>
                      <Link href={eventHref(e)} data-ev={e.id} aria-label={rowLabel(ctx, r)} className="flex min-w-0 items-center gap-1.5 text-[13px]">
                        <span className="w-11 shrink-0 text-[11px] text-ink-2 tnum">{r.time || "-"}</span>
                        <KindMark kind={e.kind} />
                        <span className="min-w-0 truncate font-medium text-ink">
                          {r.town ? `（${r.town}）` : ""}
                          {r.site}
                        </span>
                      </Link>
                      {(work || r.remark || names.length > 0) && (
                        <p className="mt-0.5 pl-12 text-[11px] leading-snug text-ink-2">
                          {work && <span className={clsx("mr-2 font-semibold tnum", r.counted || (side === "right" && !r.hold) ? "text-ink" : "font-normal text-ink-3 italic")}>{work}</span>}
                          {r.remark && <span className="mr-2">{r.remark}</span>}
                          {names.length > 0 && <span className="text-ink-3">担当: {names.map(shortName).join("・")}</span>}
                        </p>
                      )}
                    </li>
                  );
                })),
          ];
        })}
        <li className="bg-subtle px-2 py-1.5 text-[11px] text-ink">
          <span className="font-semibold">計</span> {colsText(totals) || "0 枚"} <span className="text-ink-3">({totalNote})</span>
        </li>
      </ul>
      {holds && <p className="mt-1 text-[10px] text-ink-3">灰色の斜体は仮押さえです (作業量の合計には入れません)。</p>}
    </div>
  );
}

/** 前日繰越を手で直す (スプレッドシートで繰り越しの欄を書き直していたのと同じ) */
function CarryFix({ s, day, returnTo }: { s: StoreSheet; day: string; returnTo: string }) {
  const c = s.carry!;
  return (
    <details className="group inline-block align-middle" data-testid="carry-fix">
      <summary className="ml-1 inline cursor-pointer list-none text-[11px] text-info-ink underline-offset-2 hover:underline">前日繰越を直す</summary>
      <div className="mt-1.5 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-2">
        <form action={setDayCarry} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="storeId" value={s.storeId} />
          <input type="hidden" name="date" value={day} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="text-[11px] text-ink-2">
            この日の前日繰越 (枚)
            <Input type="number" inputMode="decimal" name="value" min={0} max={9999} step={0.1} defaultValue={c.value} required className="mt-0.5 h-8 w-24 text-sm" />
          </label>
          <Button type="submit" size="sm" variant="secondary">
            保存
          </Button>
        </form>
        {c.manual && (
          <form action={setDayCarry}>
            <input type="hidden" name="storeId" value={s.storeId} />
            <input type="hidden" name="date" value={day} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="value" value="" />
            <Button type="submit" size="sm" variant="ghost">
              自動の計算に戻す
            </Button>
          </form>
        )}
        <p className="w-full text-[10px] text-ink-3">実際の進み具合に合わせて直すと、翌日からはこの枚数から繰り越します。</p>
      </div>
    </details>
  );
}

function LoadFooter({ s, ctx, set, filtered, day, returnTo, canFix }: { s: StoreSheet; ctx: CalendarContext; set: DayLoadSettings; filtered: boolean; day: string; returnTo: string; canFix: boolean }) {
  const cap = s.capacity;
  const counted = cap?.members.filter((m) => m.counted) ?? [];
  const excluded = cap?.members.filter((m) => !m.counted) ?? [];
  const onLeave = counted.filter((m) => (m.leave ?? 0) > 0);
  const kinds = `引取・現見・施工・採寸${set.countDelivery ? "・納品" : ""}`;
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-line bg-subtle/50 p-3 @4xl:grid-cols-[minmax(0,1fr)_auto] @4xl:items-center" data-testid="day-load">
      <div className="min-w-0 space-y-2">
        <div className="overflow-x-auto">
          <table className="text-xs" aria-label="その日の枚数の合計">
            <thead>
              <tr className="text-[10px] text-ink-3">
                <th className="pr-3 text-left font-medium">その日の枚数 ({kinds})</th>
                {SHEET_ITEMS.map((k) => (
                  <th key={k} className="px-2 text-right font-semibold text-ink-2">
                    {SHEET_ITEM_LABEL[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tnum">
              {(["omote", "fresh"] as const).map((part) => (
                <tr key={part}>
                  <th className="pr-3 text-left font-normal text-ink-2">{part === "omote" ? "表 (表替え・張替え)" : "新 (新調)"}</th>
                  {SHEET_ITEMS.map((k) => (
                    <td key={k} className="px-2 text-right">
                      {sheetNum(s.counted[k][part]) || "0"}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-line font-semibold">
                <th className="pr-3 text-left">合計</th>
                {SHEET_ITEMS.map((k) => (
                  <td key={k} className="px-2 text-right" data-testid={`day-total-${k}`}>
                    {sheetNum(itemTotal(s.counted, k)) || "0"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {set.perEventKinds.length > 0 && (
          <p className="text-xs text-ink-2" data-testid="day-fixed">
            {perEventKindsLabel(set.perEventKinds)}: {s.fixed.events} 件 × {sheetNum(set.perEvent) || "0"} 枚 = <span className="font-semibold text-ink tnum">{sheetNum(s.fixed.load) || "0"}</span> 枚
            <span className="ml-1 text-[11px] text-ink-3">(1 件の仕事量の換算。枚数の欄には入れません)</span>
          </p>
        )}
        <p className="text-xs text-ink-2">
          換算作業量{s.carry ? " (その日)" : ""} = {workloadFormula(s.counted, set.weights, { events: s.fixed.events, per: set.perEvent })} ={" "}
          <span className="text-sm font-semibold text-ink tnum" data-testid="day-workload">
            {sheetNum(s.dayWorkload) || "0"}
          </span>{" "}
          枚
        </p>
        {s.carry && (
          <p className="text-xs text-ink-2" data-testid="day-carry">
            前日繰越 = <span className="font-semibold text-ink tnum">{sheetNum(s.carry.value) || "0"}</span> 枚
            <span className="ml-1 text-[11px] text-ink-3">{s.carry.manual ? "(手で直した値)" : "(前日の超過分)"}</span>
            {canFix && <CarryFix s={s} day={day} returnTo={returnTo} />}
            <span className="mt-0.5 block">
              作業量の合計 = {sheetNum(s.dayWorkload) || "0"} + {sheetNum(s.carry.value) || "0"} ={" "}
              <span className="text-sm font-semibold text-ink tnum" data-testid="day-total-load">
                {sheetNum(s.workload) || "0"}
              </span>{" "}
              枚
            </span>
          </p>
        )}
        {cap && (
          <p className="text-xs text-ink-2">
            対応可能枚数 = 対象 {sheetNum(cap.people) || "0"} 人 × {sheetNum(cap.perPerson)} 枚 = <span className="text-sm font-semibold text-ink tnum" data-testid="day-capacity">{sheetNum(cap.capacity) || "0"}</span> 枚
            <span className="ml-1 text-[11px] text-ink-3">
              ({cap.manual ? `人数は設定で ${sheetNum(cap.base)} 人` : `対象: ${counted.map((m) => shortName(m.name)).join("・") || "なし"}`}
              {excluded.length > 0 && !cap.manual && ` / 対象外: ${excluded.map((m) => shortName(m.name)).join("・")}`}
              {onLeave.length > 0 && set.subtractLeave && ` / 休み: ${onLeave.map((m) => `${shortName(m.name)} (${m.leaveLabel})`).join("・")}`})
            </span>
          </p>
        )}
        {filtered && <p className="text-[11px] text-warn-ink">担当者・種別で絞り込み中のため、表示している予定だけの合計です (前日繰越はすべての予定から計算)。</p>}
        {s.leaves.length > 0 && (
          <p className="text-[11px] text-ink-3">
            休暇・不在:{" "}
            {s.leaves.map((e, i) => (
              <span key={e.id}>
                {i > 0 && "、"}
                <Link href={eventHref(e)} data-ev={e.id} className="hover:underline">
                  {staffNames(ctx, e.assigneeIds).map(shortName).join("・") || e.title} ({timeLabel(e)})
                </Link>
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="flex justify-start @4xl:justify-end">
        <Verdict s={s} carry={Boolean(s.carry)} />
      </div>
    </div>
  );
}

export function DaySheetView({
  sheets,
  ctx,
  set,
  companyWide,
  addHref,
  settingsHref,
  filtered,
  day,
  returnTo,
  canFixCarry,
}: {
  sheets: StoreSheet[];
  ctx: CalendarContext;
  set: DayLoadSettings;
  companyWide: ScheduleEvent[];
  addHref?: (storeId: string) => string;
  settingsHref?: string;
  filtered: boolean;
  day: string;
  returnTo: string;
  /** 前日繰越を直せる店舗か (自店舗・本部・管理者) */
  canFixCarry: (storeId: string) => boolean;
}) {
  return (
    <div className="space-y-4" data-testid="day-sheet">
      {sheets.length > 1 && (
        <nav aria-label="店舗の作業量" className="flex flex-wrap gap-2">
          {sheets.map((s) => {
            const store = ctx.stores.get(s.storeId);
            return (
              <a key={s.storeId} href={`#sheet-${s.storeId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-panel px-2.5 py-1.5 text-xs shadow-xs hover:bg-subtle">
                <span className="h-2 w-2 rounded-full" style={{ background: store?.color }} aria-hidden />
                <span className="font-medium text-ink">{store?.shortName ?? store?.name}</span>
                <span className="text-ink-2 tnum">{s.capacity ? `${sheetNum(s.workload) || "0"} / ${sheetNum(s.capacity.capacity) || "0"} 枚` : `${s.rows.length} 件`}</span>
                <Verdict s={s} size="sm" />
              </a>
            );
          })}
        </nav>
      )}
      {companyWide.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-panel px-3 py-2 text-xs text-ink-2">
          <Globe className="h-3.5 w-3.5 text-ink-3" aria-hidden />
          <span className="font-semibold text-ink">全社の予定</span>
          {companyWide.map((e) => (
            <Link key={e.id} href={eventHref(e)} data-ev={e.id} className="inline-flex items-center gap-1 hover:underline">
              <KindMark kind={e.kind} />
              {timeLabel(e)} {titleOf(ctx, e)}
            </Link>
          ))}
        </p>
      )}
      {sheets.map((s) => {
        const store = ctx.stores.get(s.storeId);
        const left = s.rows.filter((r) => r.side === "left");
        const right = s.rows.filter((r) => r.side === "right");
        return (
          <section key={s.storeId} id={`sheet-${s.storeId}`} className="scroll-mt-24 rounded-2xl border border-line bg-panel p-3 shadow-card @3xl:p-4" data-testid={`day-sheet-store-${s.storeId}`}>
            <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h3 className="flex items-center gap-1.5 text-base font-semibold text-ink">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: store?.color }} aria-hidden />
                {store?.name}
              </h3>
              <span className="text-xs text-ink-3 tnum">予定 {s.rows.length} 件</span>
              {s.capacity && (
                <span className="text-xs text-ink-2 tnum">
                  作業量 <span className="font-semibold text-ink">{sheetNum(s.workload) || "0"}</span>
                  {s.carry && s.carry.value > 0 && <span className="text-ink-3"> (繰越 {sheetNum(s.carry.value)} を含む)</span>} / 対応可能 <span className="font-semibold text-ink">{sheetNum(s.capacity.capacity) || "0"}</span> 枚
                </span>
              )}
              <Verdict s={s} size="sm" carry={Boolean(s.carry)} />
              <span className="ml-auto flex items-center gap-3">
                {settingsHref && (
                  <Link href={settingsHref} className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
                    <Settings2 className="h-3.5 w-3.5" aria-hidden />
                    人数・換算・繰越の設定
                  </Link>
                )}
                {addHref && (
                  <Link href={addHref(s.storeId)} className="inline-flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1 text-xs font-medium text-ink hover:bg-subtle">
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    予定を追加
                  </Link>
                )}
              </span>
            </header>
            <div className="grid grid-cols-1 gap-4 @7xl:grid-cols-2">
              <SideTable side="left" rows={left} totals={s.totals.left} ctx={ctx} set={set} />
              <SideTable side="right" rows={right} totals={s.totals.right} ctx={ctx} set={set} />
            </div>
            <LoadFooter s={s} ctx={ctx} set={set} filtered={filtered} day={day} returnTo={returnTo} canFix={canFixCarry(s.storeId)} />
          </section>
        );
      })}
      {sheets.length === 0 && <p className="rounded-2xl border border-line bg-panel px-4 py-12 text-center text-sm text-ink-3">表示する店舗がありません</p>}
    </div>
  );
}
