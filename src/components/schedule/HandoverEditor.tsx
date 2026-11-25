"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Link2, Plus, Split, Trash, Unlink } from "lucide-react";
import type { HandoverItem, OrderHandover, StoreId } from "@/lib/db/types";
import {
  HANDOVER_ITEM,
  HANDOVER_ITEMS,
  HANDOVER_ROLE_LABEL,
  HANDOVER_SLOT_LABEL,
  cleanHandovers,
  handoverDiff,
  handoverGroups,
  isLinkedItem,
  linkedCluster,
  newHandoverId,
  rowText,
  type HandoverFormRow,
} from "@/lib/handover";
import { shortDate } from "@/lib/calendar";
import { Button, Field, Input, Select } from "@/components/ui";
import { AssigneePicker, type FormStore, type FormUser } from "./form-parts";

/** 時間の指定: なし / 午前 (AM) / 午後 (PM) / 時刻 */
type TimeMode = "" | "am" | "pm" | "time";
const TIME_MODES: { value: TimeMode; label: string; title: string }[] = [
  { value: "", label: "指定なし", title: "時間は決めない (終日)" },
  { value: "am", label: "AM 午前", title: "午前 (時刻は未定)" },
  { value: "pm", label: "PM 午後", title: "午後 (時刻は未定)" },
  { value: "time", label: "時刻", title: "開始・終了の時刻を入れる" },
];

/** 画面の行 (保存する日程の欄 + 当日納品・時間の指定・同じ日程にまとめるか) */
type Row = HandoverFormRow & { same: boolean; pickupMode: TimeMode; deliveryMode: TimeMode; linked: boolean };

/** 襖・障子・網戸で同じ日程にする欄 (まとめた品目のどれかに入れると、まとめたほかの品目にも入る) */
const SHARED = ["pickupDate", "pickupMode", "pickupStart", "pickupEnd", "same", "deliveryDate", "deliveryMode", "deliveryStart", "deliveryEnd"] as const;
type SharedKey = (typeof SHARED)[number];
type PickupKey = "pickupDate" | "pickupMode" | "pickupStart" | "pickupEnd";
const pickShared = (r: Row): Pick<Row, SharedKey> => Object.fromEntries(SHARED.map((k) => [k, r[k]])) as Pick<Row, SharedKey>;

const isInstall = (r: Pick<Row, "item">) => HANDOVER_ITEM[r.item].mode === "install";
const hm = (t?: string) => (t ? t.replace(/^0(\d)/, "$1") : "");
const modeOf = (start: string, slot: string): TimeMode => (start ? "time" : slot === "am" || slot === "pm" ? slot : "");

/** 画面の行 → 保存する日程 (当日納品は納品日 = 引取日。時間は選んだ指定の分だけ) */
function toPlan(rows: Row[]): OrderHandover[] {
  return rows.map((r) => {
    const out: OrderHandover = { id: r.id, item: r.item };
    if (r.label.trim()) out.label = r.label.trim();
    const set = (k: keyof OrderHandover, v: string) => {
      if (v) (out as unknown as Record<string, string>)[k] = v;
    };
    set("pickupDate", r.pickupDate);
    if (r.pickupMode === "time") {
      set("pickupStart", r.pickupStart);
      set("pickupEnd", r.pickupStart ? r.pickupEnd : "");
    } else if (r.pickupMode) set("pickupSlot", r.pickupMode);
    if (isInstall(r)) {
      set("deliveryDate", r.deliveryDate);
    } else {
      set("deliveryDate", r.same ? r.pickupDate : r.deliveryDate);
      if (r.deliveryMode === "time") {
        set("deliveryStart", r.deliveryStart);
        set("deliveryEnd", r.deliveryStart ? r.deliveryEnd : "");
      } else if (r.deliveryMode) set("deliverySlot", r.deliveryMode);
    }
    return out;
  });
}

/** 同じ日程にまとめている襖・障子・網戸の行 (2 行以上のときだけ。行の並びの順) */
function linkedIds(rs: Row[]): string[] {
  const ids = rs.filter((r) => isLinkedItem(r.item) && r.linked).map((r) => r.id);
  return ids.length >= 2 ? ids : [];
}

/** 時間の指定 (指定なし・AM 午前・PM 午後・時刻) と、時刻のときの開始・終了 */
function TimeChoice({
  what,
  index,
  mode,
  start,
  end,
  onMode,
  onStart,
  onEnd,
}: {
  what: string;
  index: number;
  mode: TimeMode;
  start: string;
  end: string;
  onMode: (m: TimeMode) => void;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
}) {
  return (
    <div className="min-w-0">
      <span className="label">時間</span>
      <div role="radiogroup" aria-label={`${what}の時間 ${index}`} className="grid grid-cols-4 overflow-hidden rounded-lg border border-line">
        {TIME_MODES.map((m) => (
          <button
            key={m.value || "none"}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            title={m.title}
            onClick={() => onMode(m.value)}
            className={`h-9 min-w-0 whitespace-nowrap border-l border-line px-1 text-xs font-medium first:border-l-0 ${mode === m.value ? "bg-accent text-white" : "bg-panel text-ink-2 hover:bg-subtle"}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === "time" && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="開始">
            <Input type="time" step={300} value={start} onChange={(e) => onStart(e.target.value)} aria-label={`${what}の開始時刻 ${index}`} />
          </Field>
          <Field label="終了">
            <Input type="time" step={300} value={end} onChange={(e) => onEnd(e.target.value)} aria-label={`${what}の終了時刻 ${index}`} />
          </Field>
        </div>
      )}
      {mode === "time" && !start && <p className="mt-1 text-[11px] text-ink-3">開始時刻を入れてください (空欄のあいだは時間の指定なし)。</p>}
    </div>
  );
}

/**
 * 受注の画面の「引取・納品の日程」(品目ごとの引取日・納品日。src/lib/handover.ts)。
 * - 引取日・納品日は日付 + 時間 (指定なし・AM 午前・PM 午後・時刻)
 * - 襖・障子・網戸は同じ日程にまとめ、1 つの品目に入れた日程をほかの品目にも入れる。品目ごとに外して別の日程にできる
 * - 予定表に載る予定 (引き取り・納品・施工) と、承認が要る変更を保存の前に見せる
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
  submitLabel,
  hidden,
  extra,
  planNote,
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
  /** 保存のボタンの文字 (受注登録と同時に日程を入れるとき: 「受注登録して予定表に載せる」) */
  submitLabel?: string;
  /** フォームに足す値 (受注登録: returnTo・onsite など) */
  hidden?: Record<string, string>;
  /** 日程の欄の上に出す欄 (受注登録のメモなど) */
  extra?: ReactNode;
  /** 予定表に載る予定の下に出す説明 (受注登録: 訪問の予定が「現見」に切り替わるか) */
  planNote?: (rows: OrderHandover[]) => ReactNode;
}) {
  const [rows, setRows] = useState<Row[]>(() => {
    const base: Row[] = initial.map((r) => ({
      ...r,
      same: !isInstall(r) && (r.pickupDate ? r.deliveryDate === r.pickupDate : HANDOVER_ITEM[r.item].sameDay),
      pickupMode: modeOf(r.pickupStart, r.pickupSlot),
      deliveryMode: modeOf(r.deliveryStart, r.deliverySlot),
      linked: false,
    }));
    // 開いたとき: 襖・障子・網戸のうち同じ日程の行をまとめる (違う日程の行は個別のまま)
    const cluster = new Set(linkedCluster(toPlan(base)));
    return base.map((r) => ({ ...r, linked: cluster.has(r.id) }));
  });
  const [workers, setWorkers] = useState(workerIds);
  const [site, setSite] = useState(siteAddress);
  const savedById = useMemo(() => new Map(saved.map((r) => [r.id, r])), [saved]);

  const plan = useMemo(() => toPlan(rows), [rows]);
  const check = useMemo(() => cleanHandovers(plan), [plan]);
  const diff = useMemo(() => handoverDiff(saved, check.error ? saved : check.rows), [saved, check]);
  const groups = useMemo(() => (check.error ? [] : handoverGroups(check.rows)), [check]);
  const links = useMemo(() => linkedIds(rows), [rows]);
  const leaderId = links[0];
  const tategu = rows.filter((r) => isLinkedItem(r.item));

  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /**
   * 日程の欄を変える。まとめた襖・障子・網戸の行は、まとめたほかの行にも同じ値を入れる。
   * 引き取りの日時 (pickupKey) は、まだ日程を保存していないほかの品目 (畳など) の空欄 (または同じ値) にも入れる
   * (1 回の訪問でまとめて引き取ることが多いため。まとめた襖・障子・網戸は全部が当てはまるときだけ全部に)
   */
  const edit = (id: string, patch: Partial<Row>, pickupKey?: PickupKey) =>
    setRows((rs) => {
      const src = rs.find((r) => r.id === id);
      if (!src) return rs;
      const linked = new Set(linkedIds(rs));
      const together = linked.has(id) ? linked : new Set([id]);
      const spread = new Set<string>();
      if (pickupKey) {
        const old = src[pickupKey];
        const passes = (r: Row) => !isInstall(r) && !savedById.get(r.id)?.pickupDate && (r[pickupKey] === "" || r[pickupKey] === old);
        const others = rs.filter((r) => !together.has(r.id));
        const otherLinked = others.filter((r) => linked.has(r.id));
        if (otherLinked.length && otherLinked.every(passes)) otherLinked.forEach((r) => spread.add(r.id));
        others.filter((r) => !linked.has(r.id) && passes(r)).forEach((r) => spread.add(r.id));
      }
      return rs.map((r) => (together.has(r.id) ? { ...r, ...patch } : spread.has(r.id) && pickupKey ? { ...r, [pickupKey]: patch[pickupKey] } : r));
    });
  const setPickup = (id: string, key: PickupKey, value: string) => edit(id, { [key]: value } as Partial<Row>, key);

  /** この品目だけ別の日程にする (まとめから外す。今の日程はそのまま残る) */
  const unlink = (id: string) => update(id, { linked: false });
  /** ほかの襖・障子・網戸と同じ日程にする (まとめた行の日程を写す) */
  const relink = (id: string) =>
    setRows((rs) => {
      const src = rs.find((r) => r.id !== id && isLinkedItem(r.item) && r.linked) ?? rs.find((r) => r.id !== id && isLinkedItem(r.item));
      if (!src) return rs;
      return rs.map((r) => (r.id === id ? { ...r, ...pickShared(src), linked: true } : r.id === src.id ? { ...r, linked: true } : r));
    });

  /** 品目を変える。襖・障子・網戸になった行は、まだ日程がなければほかの襖・障子・網戸の日程を入れてまとめる */
  const setItem = (id: string, item: HandoverItem) =>
    setRows((rs) => {
      const cur = rs.find((r) => r.id === id);
      if (!cur) return rs;
      const install = HANDOVER_ITEM[item].mode === "install";
      let next: Row = { ...cur, item, same: install ? false : cur.pickupDate && cur.deliveryDate ? cur.deliveryDate === cur.pickupDate : HANDOVER_ITEM[item].sameDay };
      let srcId: string | undefined;
      if (!isLinkedItem(item)) next.linked = false;
      else if (!isLinkedItem(cur.item)) {
        const src = rs.find((r) => r.id !== id && isLinkedItem(r.item) && r.linked) ?? rs.find((r) => r.id !== id && isLinkedItem(r.item));
        const p = toPlan([next])[0];
        if (src && !p.pickupDate && !p.deliveryDate) {
          next = { ...next, ...pickShared(src), linked: true };
          srcId = src.id;
        } else if (src) {
          const same = JSON.stringify(SHARED.map((k) => next[k])) === JSON.stringify(SHARED.map((k) => src[k]));
          next.linked = same;
          if (same) srcId = src.id;
        } else next.linked = true;
      }
      return rs.map((r) => (r.id === id ? next : r.id === srcId ? { ...r, linked: true } : r));
    });

  const addRow = () => {
    const first = rows.find((r) => !isInstall(r));
    setRows((rs) => [
      ...rs,
      {
        id: newHandoverId(),
        item: "other",
        label: "",
        pickupDate: first?.pickupDate ?? "",
        pickupStart: first?.pickupStart ?? "",
        pickupEnd: first?.pickupEnd ?? "",
        pickupSlot: "",
        pickupMode: first?.pickupMode ?? "",
        deliveryDate: "",
        deliveryStart: "",
        deliveryEnd: "",
        deliverySlot: "",
        deliveryMode: "",
        same: false,
        linked: false,
      },
    ]);
  };

  /**
   * 同じ品目を分けて納品する (お客様のご要望 2026-11-25「④」: 襖・障子・網戸の納品を 2 日に分けるなど)。
   * 引き取りは同じ日時のまま、納品日が空の 2 回目の行を足す。名前に数量を書き分ける (例: 襖 4枚 / 襖 2枚)
   */
  const splitRow = (id: string) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      if (i < 0) return rs;
      const src = rs[i];
      const base = src.label.trim() || HANDOVER_ITEM[src.item].label;
      const n = rs.filter((r) => r.item === src.item).length + 1;
      const copy: Row = { ...src, id: newHandoverId(), label: `${base.replace(/\s*\(\d+回目\)$/, "")} (${n}回目)`, same: false, deliveryDate: "", deliveryStart: "", deliveryEnd: "", deliverySlot: "", deliveryMode: "", linked: false };
      return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
    });

  /** 行の印: 保存済みの日付のある引き取り・納品 (施工) が変わった = 変更 (承認)、日付のなかったところに入れた = 登録 (すぐ反映) */
  const status = (r: Row): { text: string; tone: string } | null => {
    const s = savedById.get(r.id);
    const p = plan.find((x) => x.id === r.id);
    if (!p) return null;
    const registered = { text: "登録 (すぐ反映)", tone: "bg-info-soft text-info-ink" };
    if (!s) return p.pickupDate || p.deliveryDate ? registered : null;
    const c = cleanHandovers([p]).rows[0] ?? p;
    const sides = isInstall(r)
      ? [["pickupDate", "pickupStart", "pickupEnd", "pickupSlot", "deliveryDate"] as const]
      : [["pickupDate", "pickupStart", "pickupEnd", "pickupSlot"] as const, ["deliveryDate", "deliveryStart", "deliveryEnd", "deliverySlot"] as const];
    let reg = false;
    let chg = isInstall(s) !== isInstall(r) && Boolean(s.pickupDate || s.deliveryDate);
    for (const fields of sides) {
      if (fields.every((f) => (s[f] ?? "") === (c[f] ?? ""))) continue;
      if (s[fields[0]]) chg = true;
      else reg = true;
    }
    if (chg) return { text: own ? "変更 (承認不要)" : "変更 (承認が必要)", tone: "bg-warn-soft text-warn-ink" };
    return reg ? registered : null;
  };

  const nameOf = (id: string) => {
    const r = rows.find((x) => x.id === id);
    return r ? r.label.trim() || HANDOVER_ITEM[r.item].label : "";
  };
  const blocked = Boolean(pendingNote) || Boolean(check.error);

  return (
    <form action={action} className="@container space-y-4">
      <input type="hidden" name="handovers" value={JSON.stringify(plan)} />
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {extra}
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
          const n = i + 1;
          const inGroup = links.includes(r.id);
          const follower = inGroup && r.id !== leaderId;
          const others = links.filter((x) => x !== r.id).map(nameOf);
          const groupNames = (links.length ? links : tategu.filter((x) => x.id !== r.id).map((x) => x.id)).filter((x) => x !== r.id).map(nameOf);
          return (
            <div key={r.id} className="rounded-xl border border-line p-3" data-testid="handover-row">
              <div className="flex flex-wrap items-end gap-2">
                <Field label={`品目 ${n}`} className="w-full @md:w-44">
                  <Select value={r.item} onChange={(e) => setItem(r.id, e.target.value as HandoverItem)} aria-label={`品目 ${n}`}>
                    {HANDOVER_ITEMS.map((k) => (
                      <option key={k} value={k}>{HANDOVER_ITEM[k].label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="名前 (予定表の件名・数量など)" className="min-w-0 flex-1">
                  <Input value={r.label} onChange={(e) => update(r.id, { label: e.target.value })} placeholder={def.label} maxLength={40} aria-label={`名前 ${n}`} />
                </Field>
                {st && <span className={`mb-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${st.tone}`}>{st.text}</span>}
                {!isInstall(r) && (
                  <button type="button" onClick={() => splitRow(r.id)} className="mb-1 inline-flex items-center gap-1 rounded px-2 py-2 text-[11px] text-ink-2 hover:bg-subtle hover:text-ink" aria-label={`品目 ${n} を分けて納品する`} title="同じ品目の納品を 2 回に分ける (引き取りは同じ)">
                    <Split className="h-4 w-4" />
                    分けて納品
                  </button>
                )}
                <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} className="mb-1 rounded p-2 text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label={`品目 ${n} を削除`}>
                  <Trash className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-[11px] text-ink-3">{def.hint}</p>

              {/* 襖・障子・網戸: 同じ日程にまとめる / 個別の日程 */}
              {isLinkedItem(r.item) && tategu.length >= 2 && !follower && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]" data-testid={inGroup ? "handover-link-leader" : "handover-link-single"}>
                  {inGroup ? (
                    <>
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent-ink">
                        <Link2 className="h-3.5 w-3.5" aria-hidden />
                        {others.join("・")}にも同じ日程が入ります
                      </span>
                      <button type="button" onClick={() => unlink(r.id)} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-ink-2 hover:bg-subtle" aria-label={`品目 ${n} だけ別の日程にする`}>
                        <Unlink className="h-3.5 w-3.5" aria-hidden />
                        この品目だけ別の日程にする
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="rounded-full bg-subtle px-2 py-0.5 font-medium text-ink-2">この品目だけ別の日程</span>
                      <button type="button" onClick={() => relink(r.id)} className="inline-flex items-center gap-1 rounded-full border border-accent/40 px-2 py-0.5 text-accent-ink hover:bg-accent-soft/50" aria-label={`品目 ${n} をほかの襖・障子・網戸と同じ日程にする`}>
                        <Link2 className="h-3.5 w-3.5" aria-hidden />
                        {groupNames.join("・")}と同じ日程にする
                      </button>
                    </>
                  )}
                </div>
              )}

              {isInstall(r) ? (
                <div className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
                  <Field label="施工開始日">
                    <Input type="date" value={r.pickupDate} onChange={(e) => update(r.id, { pickupDate: e.target.value })} aria-label={`施工開始日 ${n}`} />
                  </Field>
                  <Field label="施工終了日" hint="1 日で終わるときは空欄">
                    <Input type="date" value={r.deliveryDate} min={r.pickupDate || undefined} onChange={(e) => update(r.id, { deliveryDate: e.target.value })} aria-label={`施工終了日 ${n}`} />
                  </Field>
                  <TimeChoice
                    what="施工"
                    index={n}
                    mode={r.pickupMode}
                    start={r.pickupStart}
                    end={r.pickupEnd}
                    onMode={(m) => update(r.id, { pickupMode: m })}
                    onStart={(v) => update(r.id, { pickupStart: v })}
                    onEnd={(v) => update(r.id, { pickupEnd: v })}
                  />
                </div>
              ) : follower ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-accent/40 bg-accent-soft/30 px-3 py-2" data-testid="handover-linked">
                  <div className="min-w-0 text-xs text-ink-2">
                    <span className="inline-flex items-center gap-1 font-medium text-accent-ink">
                      <Link2 className="h-3.5 w-3.5" aria-hidden />
                      {nameOf(leaderId!)}と同じ日程
                    </span>{" "}
                    <span data-testid="handover-linked-text">{rowText(plan.find((p) => p.id === r.id) ?? { id: r.id, item: r.item })}</span>
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => unlink(r.id)} aria-label={`品目 ${n} だけ別の日程にする`}>
                    <Unlink /> この品目だけ別の日程にする
                  </Button>
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-1 gap-3 @2xl:grid-cols-2">
                  <fieldset className="min-w-0 space-y-2 rounded-lg bg-subtle/60 p-2">
                    <legend className="px-1 text-xs font-medium text-ink">引き取り</legend>
                    <Field label="引取日">
                      <Input type="date" value={r.pickupDate} onChange={(e) => setPickup(r.id, "pickupDate", e.target.value)} aria-label={`引取日 ${n}`} />
                    </Field>
                    <TimeChoice
                      what="引き取り"
                      index={n}
                      mode={r.pickupMode}
                      start={r.pickupStart}
                      end={r.pickupEnd}
                      onMode={(m) => setPickup(r.id, "pickupMode", m)}
                      onStart={(v) => setPickup(r.id, "pickupStart", v)}
                      onEnd={(v) => setPickup(r.id, "pickupEnd", v)}
                    />
                  </fieldset>
                  <fieldset className="min-w-0 space-y-2 rounded-lg bg-subtle/60 p-2">
                    <legend className="px-1 text-xs font-medium text-ink">納品</legend>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink">
                      <input type="checkbox" checked={r.same} onChange={(e) => edit(r.id, { same: e.target.checked })} className="h-4 w-4 accent-accent" aria-label={`当日納品 ${n}`} />
                      当日納品 (引取日に納品)
                    </label>
                    <Field label="納品日">
                      <Input
                        type="date"
                        value={r.same ? r.pickupDate : r.deliveryDate}
                        min={r.pickupDate || undefined}
                        readOnly={r.same}
                        onChange={(e) => edit(r.id, { deliveryDate: e.target.value })}
                        className={r.same ? "bg-subtle text-ink-2" : undefined}
                        aria-label={`納品日 ${n}`}
                      />
                    </Field>
                    <TimeChoice
                      what="納品"
                      index={n}
                      mode={r.deliveryMode}
                      start={r.deliveryStart}
                      end={r.deliveryEnd}
                      onMode={(m) => edit(r.id, { deliveryMode: m })}
                      onStart={(v) => edit(r.id, { deliveryStart: v })}
                      onEnd={(v) => edit(r.id, { deliveryEnd: v })}
                    />
                    {!r.same && !r.deliveryDate && r.pickupDate && <p className="text-[11px] text-ink-3">納品日が決まったら入れてください (空欄のあいだは引き取りだけが予定表に載ります)。</p>}
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
          <span className="text-[11px] text-ink-3">
            襖・障子・網戸は 1 つの品目に入れた日程がほかの品目にも入ります (別の日にする品目は「この品目だけ別の日程にする」)。引き取りの日時は、まだ日程のないほかの品目にも同じ値が入ります。同じ品目の納品を 2 日に分けるときは「分けて納品」(名前に枚数を書き分けてください)。
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel px-3 py-2">
        <div className="text-xs font-medium text-ink">予定表に載る予定</div>
        {groups.length ? (
          <ul className="mt-1 space-y-0.5 text-xs text-ink-2" data-testid="handover-preview">
            {groups.map((g) => (
              <li key={`${g.role}${g.date}${g.start ?? ""}${g.slot ?? ""}${g.rowIds.join()}`}>
                <span className="font-medium text-ink">
                  {shortDate(g.date)}
                  {g.endDate ? `〜${shortDate(g.endDate)}` : ""}
                  {g.start ? ` ${hm(g.start)}${g.end ? `–${hm(g.end)}` : ""}` : g.slot ? ` ${HANDOVER_SLOT_LABEL[g.slot]}` : ""}
                </span>{" "}
                {HANDOVER_ROLE_LABEL[g.role]}: {g.labels.join("・")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-ink-3">日付を入れると、ここに予定表に載る予定 (引き取り・納品の日だけ) が出ます。</p>
        )}
        {check.error && <p className="mt-1 text-xs text-critical-ink">{check.error}</p>}
        {!check.error && planNote?.(check.rows)}
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
          {diff.needsApproval && !own ? "保存して変更を申請" : (submitLabel ?? "保存する")}
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
          <input type="checkbox" name="allowOverlap" value="1" className="h-4 w-4 accent-accent" />
          重複を承知で保存する (担当者・店長と調整済み)
        </label>
      </div>
    </form>
  );
}
