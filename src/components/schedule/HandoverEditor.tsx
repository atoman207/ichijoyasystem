"use client";

import { useMemo, useState } from "react";
import { Plus, Trash } from "lucide-react";
import type { HandoverItem, OrderHandover, StoreId } from "@/lib/db/types";
import {
  HANDOVER_ITEM,
  HANDOVER_ITEMS,
  HANDOVER_ROLE_LABEL,
  cleanHandovers,
  handoverDiff,
  handoverGroups,
  newHandoverId,
  type HandoverFormRow,
} from "@/lib/handover";
import { shortDate } from "@/lib/calendar";
import { Button, Field, Input, Select } from "@/components/ui";
import { AssigneePicker, type FormStore, type FormUser } from "./form-parts";

type Row = HandoverFormRow & { same: boolean };

/** 引き取り・納品・施工の日程の欄 (先頭が日付) */
const SIDES = {
  pickup: ["pickupDate", "pickupStart", "pickupEnd"],
  delivery: ["deliveryDate", "deliveryStart", "deliveryEnd"],
  install: ["pickupDate", "pickupStart", "pickupEnd", "deliveryDate"],
} as const;

const isInstall = (r: Pick<Row, "item">) => HANDOVER_ITEM[r.item].mode === "install";
const hm = (t?: string) => (t ? t.replace(/^0(\d)/, "$1") : "");

/** 画面の行 → 保存する日程 (当日納品は納品日 = 引取日) */
function toPlan(rows: Row[]): OrderHandover[] {
  return rows.map((r) => {
    const out: OrderHandover = { id: r.id, item: r.item };
    if (r.label.trim()) out.label = r.label.trim();
    const set = (k: keyof OrderHandover, v: string) => {
      if (v) (out as unknown as Record<string, string>)[k] = v;
    };
    set("pickupDate", r.pickupDate);
    set("pickupStart", r.pickupStart);
    set("pickupEnd", r.pickupStart ? r.pickupEnd : "");
    if (isInstall(r)) {
      set("deliveryDate", r.deliveryDate);
    } else {
      set("deliveryDate", r.same ? r.pickupDate : r.deliveryDate);
      set("deliveryStart", r.deliveryStart);
      set("deliveryEnd", r.deliveryStart ? r.deliveryEnd : "");
    }
    return out;
  });
}

/**
 * 受注の画面の「引取・納品の日程」(品目ごとの引取日・納品日。src/lib/handover.ts)。
 * 予定表に載る予定 (引き取り・納品・施工) と、承認が要る変更を保存の前に見せる
 */
export function HandoverEditor({
  action,
  initial,
  saved,
  suggested,
  legacyNote,
  pendingNote,
  own,
  workerIds,
  siteAddress,
  users,
  stores,
  storeId,
  currentUserId,
}: {
  action: (formData: FormData) => void | Promise<void>;
  initial: HandoverFormRow[];
  /** 保存済みの日程 (登録と変更の区別に使う。未保存は空) */
  saved: OrderHandover[];
  /** 初期値は見積の明細・手書きの日時からの提案 (まだ保存していない) */
  suggested: boolean;
  /** 以前の形 (施工期間の「施工」の予定) で予定表に載っているときの説明 */
  legacyNote?: string;
  /** 承認待ちの変更があるときの説明 (保存できない) */
  pendingNote?: string;
  /** 管理者 (変更の承認を省略) */
  own: boolean;
  workerIds: string[];
  siteAddress: string;
  users: FormUser[];
  stores: FormStore[];
  storeId: StoreId;
  currentUserId: string;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((r) => ({ ...r, same: !isInstall(r) && (r.pickupDate ? r.deliveryDate === r.pickupDate : HANDOVER_ITEM[r.item].sameDay) })),
  );
  const [workers, setWorkers] = useState(workerIds);
  const [site, setSite] = useState(siteAddress);
  const savedById = useMemo(() => new Map(saved.map((r) => [r.id, r])), [saved]);

  const plan = useMemo(() => toPlan(rows), [rows]);
  const check = useMemo(() => cleanHandovers(plan), [plan]);
  const diff = useMemo(() => handoverDiff(saved, check.error ? saved : check.rows), [saved, check]);
  const groups = useMemo(() => (check.error ? [] : handoverGroups(check.rows)), [check]);

  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /**
   * 引き取りの日時: まだ日程を保存していない、ほかの品目の空欄 (または同じ値) にも同じ値を入れる
   * (1 回の訪問でまとめて引き取ることが多いため)
   */
  const setPickup = (id: string, field: "pickupDate" | "pickupStart" | "pickupEnd", value: string) =>
    setRows((rs) => {
      const old = rs.find((r) => r.id === id)?.[field] ?? "";
      return rs.map((r) => {
        if (r.id === id) return { ...r, [field]: value };
        if (isInstall(r) || savedById.get(r.id)?.pickupDate) return r;
        return r[field] === "" || r[field] === old ? { ...r, [field]: value } : r;
      });
    });

  const setItem = (id: string, item: HandoverItem) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, item, same: HANDOVER_ITEM[item].mode === "install" ? false : r.pickupDate && r.deliveryDate ? r.deliveryDate === r.pickupDate : HANDOVER_ITEM[item].sameDay } : r)));

  const addRow = () => {
    const first = rows.find((r) => !isInstall(r));
    setRows((rs) => [
      ...rs,
      { id: newHandoverId(), item: "other", label: "", pickupDate: first?.pickupDate ?? "", pickupStart: first?.pickupStart ?? "", pickupEnd: first?.pickupEnd ?? "", deliveryDate: "", deliveryStart: "", deliveryEnd: "", same: false },
    ]);
  };

  /** 行の印: 保存済みの日付のある引き取り・納品 (施工) が変わった = 変更 (承認)、日付のなかったところに入れた = 登録 (すぐ反映) */
  const status = (r: Row): { text: string; tone: string } | null => {
    const s = savedById.get(r.id);
    const p = plan.find((x) => x.id === r.id);
    if (!p) return null;
    const registered = { text: "登録 (すぐ反映)", tone: "bg-info-soft text-info-ink" };
    if (!s) return p.pickupDate || p.deliveryDate ? registered : null;
    const sides = isInstall(r) ? [SIDES.install] : [SIDES.pickup, SIDES.delivery];
    let reg = false;
    let chg = isInstall(s) !== isInstall(r) && Boolean(s.pickupDate || s.deliveryDate);
    for (const fields of sides) {
      if (fields.every((f) => (s[f] ?? "") === (p[f] ?? ""))) continue;
      if (s[fields[0]]) chg = true;
      else reg = true;
    }
    if (chg) return { text: own ? "変更 (承認不要)" : "変更 (承認が必要)", tone: "bg-warn-soft text-warn-ink" };
    return reg ? registered : null;
  };

  const blocked = Boolean(pendingNote) || Boolean(check.error);

  return (
    <form action={action} className="@container space-y-4">
      <input type="hidden" name="handovers" value={JSON.stringify(plan)} />
      {suggested && (
        <p className="rounded-lg bg-info-soft px-3 py-2 text-xs text-info-ink">
          見積の明細と手書きの「引取日時」「納品日時」から入れた案です。日程を確かめて「保存する」を押すと予定表に載ります。
        </p>
      )}
      {legacyNote && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{legacyNote}</p>}
      {pendingNote && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{pendingNote}</p>}

      <div className="space-y-3">
        {rows.map((r, i) => {
          const def = HANDOVER_ITEM[r.item];
          const st = status(r);
          return (
            <div key={r.id} className="rounded-xl border border-line p-3" data-testid="handover-row">
              <div className="flex flex-wrap items-end gap-2">
                <Field label={`品目 ${i + 1}`} className="w-full @md:w-44">
                  <Select value={r.item} onChange={(e) => setItem(r.id, e.target.value as HandoverItem)} aria-label={`品目 ${i + 1}`}>
                    {HANDOVER_ITEMS.map((k) => (
                      <option key={k} value={k}>{HANDOVER_ITEM[k].label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="名前 (予定表の件名・数量など)" className="min-w-0 flex-1">
                  <Input value={r.label} onChange={(e) => update(r.id, { label: e.target.value })} placeholder={def.label} maxLength={40} aria-label={`名前 ${i + 1}`} />
                </Field>
                {st && <span className={`mb-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${st.tone}`}>{st.text}</span>}
                <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} className="mb-1 rounded p-2 text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label={`品目 ${i + 1} を削除`}>
                  <Trash className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-[11px] text-ink-3">{def.hint}</p>
              {isInstall(r) ? (
                <div className="mt-2 grid grid-cols-2 gap-2 @xl:grid-cols-4">
                  <Field label="施工開始日">
                    <Input type="date" value={r.pickupDate} onChange={(e) => update(r.id, { pickupDate: e.target.value })} aria-label={`施工開始日 ${i + 1}`} />
                  </Field>
                  <Field label="施工終了日" hint="1 日で終わるときは空欄">
                    <Input type="date" value={r.deliveryDate} min={r.pickupDate || undefined} onChange={(e) => update(r.id, { deliveryDate: e.target.value })} aria-label={`施工終了日 ${i + 1}`} />
                  </Field>
                  <Field label="開始時刻">
                    <Input type="time" step={300} value={r.pickupStart} onChange={(e) => update(r.id, { pickupStart: e.target.value })} aria-label={`施工の開始時刻 ${i + 1}`} />
                  </Field>
                  <Field label="終了時刻">
                    <Input type="time" step={300} value={r.pickupEnd} onChange={(e) => update(r.id, { pickupEnd: e.target.value })} aria-label={`施工の終了時刻 ${i + 1}`} />
                  </Field>
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-1 gap-3 @2xl:grid-cols-2">
                  <fieldset className="min-w-0 rounded-lg bg-subtle/60 p-2">
                    <legend className="px-1 text-xs font-medium text-ink">引き取り</legend>
                    <div className="grid grid-cols-2 gap-2 @md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Field label="引取日" className="col-span-2 @md:col-span-1">
                        <Input type="date" value={r.pickupDate} onChange={(e) => setPickup(r.id, "pickupDate", e.target.value)} aria-label={`引取日 ${i + 1}`} />
                      </Field>
                      <Field label="開始">
                        <Input type="time" step={300} value={r.pickupStart} onChange={(e) => setPickup(r.id, "pickupStart", e.target.value)} aria-label={`引き取りの開始時刻 ${i + 1}`} />
                      </Field>
                      <Field label="終了">
                        <Input type="time" step={300} value={r.pickupEnd} onChange={(e) => setPickup(r.id, "pickupEnd", e.target.value)} aria-label={`引き取りの終了時刻 ${i + 1}`} />
                      </Field>
                    </div>
                  </fieldset>
                  <fieldset className="min-w-0 rounded-lg bg-subtle/60 p-2">
                    <legend className="px-1 text-xs font-medium text-ink">納品</legend>
                    <label className="mb-1 inline-flex cursor-pointer items-center gap-2 text-xs text-ink">
                      <input type="checkbox" checked={r.same} onChange={(e) => update(r.id, { same: e.target.checked })} className="h-4 w-4 accent-accent" aria-label={`当日納品 ${i + 1}`} />
                      当日納品 (引取日に納品)
                    </label>
                    <div className="grid grid-cols-2 gap-2 @md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Field label="納品日" className="col-span-2 @md:col-span-1">
                        <Input
                          type="date"
                          value={r.same ? r.pickupDate : r.deliveryDate}
                          min={r.pickupDate || undefined}
                          readOnly={r.same}
                          onChange={(e) => update(r.id, { deliveryDate: e.target.value })}
                          className={r.same ? "bg-subtle text-ink-2" : undefined}
                          aria-label={`納品日 ${i + 1}`}
                        />
                      </Field>
                      <Field label="開始">
                        <Input type="time" step={300} value={r.deliveryStart} onChange={(e) => update(r.id, { deliveryStart: e.target.value })} aria-label={`納品の開始時刻 ${i + 1}`} />
                      </Field>
                      <Field label="終了">
                        <Input type="time" step={300} value={r.deliveryEnd} onChange={(e) => update(r.id, { deliveryEnd: e.target.value })} aria-label={`納品の終了時刻 ${i + 1}`} />
                      </Field>
                    </div>
                    {!r.same && !r.deliveryDate && r.pickupDate && <p className="mt-1 text-[11px] text-ink-3">納品日が決まったら入れてください (空欄のあいだは引き取りだけが予定表に載ります)。</p>}
                  </fieldset>
                </div>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={addRow}>
            <Plus /> 品目を追加
          </Button>
          <span className="text-[11px] text-ink-3">引き取りの日時は、まだ日程のないほかの品目にも同じ値が入ります。</span>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel px-3 py-2">
        <div className="text-xs font-medium text-ink">予定表に載る予定</div>
        {groups.length ? (
          <ul className="mt-1 space-y-0.5 text-xs text-ink-2" data-testid="handover-preview">
            {groups.map((g) => (
              <li key={`${g.role}${g.date}${g.start ?? ""}${g.rowIds.join()}`}>
                <span className="font-medium text-ink">
                  {shortDate(g.date)}
                  {g.endDate ? `〜${shortDate(g.endDate)}` : ""}
                  {g.start ? ` ${hm(g.start)}${g.end ? `–${hm(g.end)}` : ""}` : ""}
                </span>{" "}
                {HANDOVER_ROLE_LABEL[g.role]}: {g.labels.join("・")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-ink-3">日付を入れると、ここに予定表に載る予定 (引き取り・納品の日だけ) が出ます。</p>
        )}
        {check.error && <p className="mt-1 text-xs text-critical-ink">{check.error}</p>}
      </div>

      {diff.needsApproval && (
        <div className="rounded-xl border border-warn/40 bg-warn-soft/40 px-3 py-2">
          <div className="text-xs font-medium text-warn-ink">{own ? "日程の変更 (管理者のため承認は不要です)" : "承認が必要な変更 (承認されるまで予定表は前の日程のままです)"}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-2">
            {diff.changed.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {!own && (
            <Field label="変更の理由 (承認者に伝わります)" className="mt-2">
              <Input name="reason" placeholder="例: お客様のご都合で納品を 12/5 に変更" maxLength={300} />
            </Field>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        <AssigneePicker users={users} stores={stores} selected={workers} onChange={setWorkers} currentUserId={currentUserId} storeId={storeId} label="担当 (引き取り・納品・施工)" name="workerIds" hint="予定表の予定の担当者になります。担当の変更は承認なしで反映します" />
        <Field label="現場住所">
          <Input name="siteAddress" value={site} onChange={(e) => setSite(e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={blocked}>
          {diff.needsApproval && !own ? "保存して変更を申請" : "保存する"}
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
          <input type="checkbox" name="allowOverlap" value="1" className="h-4 w-4 accent-accent" />
          担当者の予定と重なっても保存する (調整済み)
        </label>
      </div>
    </form>
  );
}
