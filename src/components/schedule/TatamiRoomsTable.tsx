import clsx from "clsx";
import type { TatamiRoom } from "@/lib/db/types";
import { TATAMI_WORK_LABEL, fmtQty, needsThickness, roomLabel, roomPending } from "@/lib/tatami-spec";

/**
 * 畳の仕様 (部屋ごと) の表示 (畳製造予定・受注・見積の画面)。未確定の項目は「寸法未確認」などの印で出す。
 * 広い欄は表、狭い欄 (スマートフォン) は部屋ごとのカード (コンテナクエリ)
 */

function Pending({ children }: { children: string }) {
  return <span className="inline-flex items-center rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-warn-ink">{children}</span>;
}

function cells(r: TatamiRoom) {
  const omote = r.work === "ura" ? <span className="text-ink-3">今の表 (裏返し)</span> : r.omote ? r.omote : <Pending>畳表未確認</Pending>;
  const heri = r.herinashi ? <span className="rounded bg-critical-soft px-1 text-xs font-semibold text-critical-ink">縁無</span> : r.heri ? r.heri : <Pending>畳縁未確認</Pending>;
  const doko =
    r.work === "new" ? (
      r.doko ? (
        <span>
          {r.doko}
          {r.dokoThickness ? ` ${r.dokoThickness}` : needsThickness(r.doko) ? (
            <>
              {" "}
              <Pending>厚み未確認</Pending>
            </>
          ) : null}
        </span>
      ) : (
        <Pending>畳床未確認</Pending>
      )
    ) : (
      <span className="text-ink-2">{r.doko || "今の床"}</span>
    );
  const size = r.size ? r.size : <Pending>寸法未確認</Pending>;
  const qty = r.qty > 0 ? `${fmtQty(r.qty)}畳` : <Pending>畳数未確認</Pending>;
  return { omote, heri, doko, size, qty };
}

export function TatamiRoomsTable({ rooms, dim = false }: { rooms: TatamiRoom[]; dim?: boolean }) {
  if (!rooms.length) return null;
  return (
    <div className={clsx("@container", dim && "opacity-70")} data-testid="tatami-rooms">
      <table className="hidden w-full border-collapse text-xs @2xl:table">
        <thead>
          <tr className="border-b border-line text-left text-[11px] text-ink-3">
            <th className="py-1 pr-2 font-medium">部屋</th>
            <th className="py-1 pr-2 font-medium">作業</th>
            <th className="py-1 pr-2 text-right font-medium">畳数</th>
            <th className="py-1 pr-2 font-medium">畳表</th>
            <th className="py-1 pr-2 font-medium">畳縁</th>
            <th className="py-1 pr-2 font-medium">畳床</th>
            <th className="py-1 pr-2 font-medium">寸法</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((r, i) => {
            const c = cells(r);
            return (
              <tr key={r.id} className="border-b border-line/60 align-top last:border-0" data-testid="tatami-room">
                <td className="py-1 pr-2 font-medium text-ink">
                  {roomLabel(r, i)}
                  {r.note && <div className="text-[11px] font-normal text-ink-3">{r.note}</div>}
                </td>
                <td className="py-1 pr-2 whitespace-nowrap text-ink-2">{TATAMI_WORK_LABEL[r.work]}</td>
                <td className="py-1 pr-2 text-right font-semibold whitespace-nowrap text-ink tnum">{c.qty}</td>
                <td className="py-1 pr-2 text-ink">{c.omote}</td>
                <td className="py-1 pr-2 text-ink">{c.heri}</td>
                <td className="py-1 pr-2 text-ink">{c.doko}</td>
                <td className="py-1 pr-2 text-ink">{c.size}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="space-y-1.5 @2xl:hidden">
        {rooms.map((r, i) => {
          const c = cells(r);
          return (
            <li key={r.id} className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs" data-testid="tatami-room-card">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink">{roomLabel(r, i)}</span>
                <span className="text-ink-2">{TATAMI_WORK_LABEL[r.work]}</span>
                <span className="font-semibold text-ink tnum">{c.qty}</span>
                {r.note && <span className="text-[11px] text-ink-3">{r.note}</span>}
              </div>
              <dl className="mt-1 grid grid-cols-[3.5em_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                <dt className="text-ink-3">畳表</dt>
                <dd className="min-w-0 break-words text-ink">{c.omote}</dd>
                <dt className="text-ink-3">畳縁</dt>
                <dd className="min-w-0 break-words text-ink">{c.heri}</dd>
                <dt className="text-ink-3">畳床</dt>
                <dd className="min-w-0 break-words text-ink">{c.doko}</dd>
                <dt className="text-ink-3">寸法</dt>
                <dd className="min-w-0 break-words text-ink">{c.size}</dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 未確定の項目のある部屋の数 */
export const pendingRoomCount = (rooms: TatamiRoom[]) => rooms.filter((r) => roomPending(r).length > 0).length;
