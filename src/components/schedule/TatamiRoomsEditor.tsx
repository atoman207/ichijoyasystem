"use client";

import { useMemo, useState } from "react";
import { Copy, Plus, RotateCcw, Trash } from "lucide-react";
import type { TatamiRoom } from "@/lib/db/types";
import { DOKO_TYPES, SIZE_CHOICES, THICKNESS_CHOICES, TATAMI_WORKS, TATAMI_WORK_LABEL, cleanRooms, newRoomId, roomPending, roomTotals, fmtQty, type TatamiWork } from "@/lib/tatami-spec";
import { Button, Field, Input, Select } from "@/components/ui";

type Row = Omit<TatamiRoom, "qty"> & { qty: string };

const toRow = (r: TatamiRoom): Row => ({ ...r, qty: r.qty > 0 ? String(r.qty) : "" });
const toRoom = (r: Row): TatamiRoom => ({ ...r, qty: Number(r.qty.normalize("NFKC")) || 0 });

/**
 * 畳の仕様 (部屋ごと) の入力 (畳製造予定・受注・見積の画面)。部屋ごとに 作業・畳数・畳表・畳縁 (縁無)・畳床 (種類・厚み)・寸法。
 * 空欄は未確定 (「寸法未確認」と出る)。あとから入れ・直せる。同じ畳表で縁だけ違う部屋は「複製」してから縁を直す
 */
export function TatamiRoomsEditor({
  action,
  initial,
  auto,
  hidden,
  works = TATAMI_WORKS,
  omoteChoices = [],
  heriChoices = [],
  submitLabel = "仕様を保存する",
  idPrefix,
}: {
  action: (formData: FormData) => void | Promise<void>;
  initial: TatamiRoom[];
  /** 見積の明細から自動で作った案 (「見積の明細から作り直す」) */
  auto?: TatamiRoom[];
  hidden?: Record<string, string>;
  /** 新しい部屋の作業の候補 (畳製造予定の行はその行の作業) */
  works?: TatamiWork[];
  omoteChoices?: string[];
  heriChoices?: string[];
  submitLabel?: string;
  idPrefix: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => initial.map(toRow));
  const rooms = useMemo(() => rows.map(toRoom), [rows]);
  const check = useMemo(() => cleanRooms(rooms), [rooms]);
  const totals = roomTotals(check.rooms);
  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => setRows((rs) => [...rs, { id: newRoomId(), work: works[0] ?? "omote", qty: "" }]);
  const copy = (id: string) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      if (i < 0) return rs;
      const c = { ...rs[i], id: newRoomId(), room: "" };
      return [...rs.slice(0, i + 1), c, ...rs.slice(i + 1)];
    });
  const list = (id: string) => `${idPrefix}-${id}`;

  return (
    <form action={action} className="@container space-y-3" data-testid="tatami-rooms-editor">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="rooms" value={JSON.stringify(check.rooms)} />
      <datalist id={list("doko")}>{DOKO_TYPES.map((d) => <option key={d} value={d} />)}</datalist>
      <datalist id={list("size")}>{SIZE_CHOICES.map((d) => <option key={d} value={d} />)}</datalist>
      <datalist id={list("thick")}>{THICKNESS_CHOICES.map((d) => <option key={d} value={d} />)}</datalist>
      <datalist id={list("omote")}>{omoteChoices.map((d) => <option key={d} value={d} />)}</datalist>
      <datalist id={list("heri")}>{heriChoices.map((d) => <option key={d} value={d} />)}</datalist>

      {rows.map((r, i) => {
        const n = i + 1;
        const pending = roomPending(toRoom(r));
        return (
          <div key={r.id} className="rounded-xl border border-line p-3" data-testid="tatami-room-row">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">部屋 {n}</span>
              {pending.length > 0 ? (
                pending.map((p) => (
                  <span key={p} className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold text-warn-ink">
                    {p}未確認
                  </span>
                ))
              ) : (
                <span className="rounded bg-good-soft px-1.5 py-0.5 text-[11px] font-semibold text-good-ink">仕様確定</span>
              )}
              <span className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => copy(r.id)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-ink-2 hover:bg-subtle" aria-label={`部屋 ${n} を複製`} title="同じ仕様の部屋を足す (縁だけ違う部屋など)">
                  <Copy className="h-3.5 w-3.5" /> 複製
                </button>
                <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} className="rounded p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label={`部屋 ${n} を削除`}>
                  <Trash className="h-4 w-4" />
                </button>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-6">
              <Field label="部屋" className="col-span-2 @2xl:col-span-2">
                <Input value={r.room ?? ""} onChange={(e) => update(r.id, { room: e.target.value })} placeholder="例: 1階 和室" maxLength={30} aria-label={`部屋 ${n} の名前`} />
              </Field>
              <Field label="作業">
                <Select value={r.work} onChange={(e) => update(r.id, { work: e.target.value as TatamiWork })} aria-label={`部屋 ${n} の作業`}>
                  {TATAMI_WORKS.map((w) => (
                    <option key={w} value={w}>
                      {TATAMI_WORK_LABEL[w]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="畳数" hint="半畳は 0.5">
                <Input type="number" inputMode="decimal" min={0} step={0.5} value={r.qty} onChange={(e) => update(r.id, { qty: e.target.value })} aria-label={`部屋 ${n} の畳数`} />
              </Field>
              <Field label="寸法" className="col-span-2 @2xl:col-span-2" hint="例: 本間・江戸間 (五八)・880×1760">
                <Input value={r.size ?? ""} onChange={(e) => update(r.id, { size: e.target.value })} list={list("size")} placeholder="未確認 (現地で採寸)" maxLength={40} aria-label={`部屋 ${n} の寸法`} />
              </Field>
              <Field label="畳表" className="col-span-2 @2xl:col-span-2">
                <Input
                  value={r.work === "ura" ? "" : (r.omote ?? "")}
                  onChange={(e) => update(r.id, { omote: e.target.value })}
                  list={list("omote")}
                  disabled={r.work === "ura"}
                  placeholder={r.work === "ura" ? "今の表を裏返す" : "例: きずな・さくら"}
                  maxLength={60}
                  aria-label={`部屋 ${n} の畳表`}
                />
              </Field>
              <Field label="畳縁" className="col-span-2 @2xl:col-span-2">
                <div className="flex items-center gap-2">
                  <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs text-ink">
                    <input type="checkbox" checked={Boolean(r.herinashi)} onChange={(e) => update(r.id, { herinashi: e.target.checked })} className="h-4 w-4 accent-accent" aria-label={`部屋 ${n} は縁無`} />
                    縁無
                  </label>
                  <Input value={r.herinashi ? "" : (r.heri ?? "")} onChange={(e) => update(r.id, { heri: e.target.value })} list={list("heri")} disabled={Boolean(r.herinashi)} placeholder={r.herinashi ? "縁無" : "例: マス菊・アラベスク510"} maxLength={60} aria-label={`部屋 ${n} の畳縁`} />
                </div>
              </Field>
              <Field label={r.work === "new" ? "畳床" : "畳床 (今の床)"} className="col-span-2 @2xl:col-span-2">
                <Input value={r.doko ?? ""} onChange={(e) => update(r.id, { doko: e.target.value })} list={list("doko")} placeholder={r.work === "new" ? "例: 本ワラ床・建材床・床暖房用畳床" : "今の床を使う (わら・建材など)"} maxLength={40} aria-label={`部屋 ${n} の畳床`} />
              </Field>
              {r.work === "new" && (
                <Field label="畳床の厚み" hint="建材床は現地の採寸で決まったら入れる">
                  <Input value={r.dokoThickness ?? ""} onChange={(e) => update(r.id, { dokoThickness: e.target.value })} list={list("thick")} placeholder="未確認" maxLength={20} aria-label={`部屋 ${n} の畳床の厚み`} />
                </Field>
              )}
              <Field label="メモ" className={r.work === "new" ? "col-span-2 @2xl:col-span-3" : "col-span-2 @2xl:col-span-4"}>
                <Input value={r.note ?? ""} onChange={(e) => update(r.id, { note: e.target.value })} placeholder="例: 半畳・炉あり・敷居の段差" maxLength={100} aria-label={`部屋 ${n} のメモ`} />
              </Field>
            </div>
          </div>
        );
      })}
      {!rows.length && <p className="text-xs text-ink-3">部屋がありません。「部屋を追加」で入れてください。</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={add}>
          <Plus /> 部屋を追加
        </Button>
        {auto && auto.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows(auto.map((r) => toRow({ ...r, id: newRoomId() })))} title="今の入力を消して、見積の明細と手書きの備考から入れ直します">
            <RotateCcw /> 見積の明細から作り直す
          </Button>
        )}
        <span className="text-xs text-ink-2 tnum">
          合計 {fmtQty(totals.qty)}畳{totals.herinashi ? ` (縁無 ${fmtQty(totals.herinashi)})` : ""}
          {totals.pending ? ` · 未確認のある部屋 ${totals.pending}` : ""}
        </span>
      </div>
      {check.error && <p className="text-xs text-critical-ink">{check.error}</p>}
      <Button type="submit" size="sm" disabled={Boolean(check.error)} data-testid="tatami-rooms-save">
        {submitLabel}
      </Button>
    </form>
  );
}
