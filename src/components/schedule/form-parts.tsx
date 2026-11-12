"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarCheck, CircleCheck, LoaderCircle, Search, TriangleAlert, UserPlus, Users, X } from "lucide-react";
import type { StoreId } from "@/lib/db/types";
import { checkScheduleConflicts } from "@/lib/actions/schedule";
import { longDate, type BusyInfo, type ConflictQuery, type ConflictReport } from "@/lib/calendar";
import { Avatar } from "@/components/ui";
import { shortName } from "./parts";

/**
 * 予定の入力フォームの部品 (クライアント)
 * - useConflictReport: 入力中の日時・担当者で、担当者の既存予定との重複と空き状況をサーバーに問い合わせる
 * - AssigneePicker: 担当者の選択 (店舗ごと・名前で絞り込み・その日の空き状況つき)
 * - ConflictPanel: 担当者のその日の予定と重複の一覧。重複がある場合は「承知で登録」の確認を求める
 */

export interface FormUser {
  id: string;
  name: string;
  title: string;
  storeId: StoreId;
}

export interface FormStore {
  id: StoreId;
  name: string;
  shortName: string;
  color: string;
}

/** 入力が止まって 350ms 後に重複を確認する。結果は問い合わせ内容と対応づけ、古い結果は使わない */
export function useConflictReport(query: ConflictQuery | null): { report: ConflictReport | null; fresh: boolean; checking: boolean } {
  const key = query ? JSON.stringify(query) : "";
  const [state, setState] = useState<{ key: string; report: ConflictReport } | null>(null);
  const [pending, setPending] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    if (!key) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      setPending(key);
      checkScheduleConflicts(JSON.parse(key) as ConflictQuery)
        .then((report) => {
          if (seq.current === id) setState({ key, report });
        })
        .catch(() => {
          /* 通信エラー時は登録時のサーバー側の確認に任せる */
        })
        .finally(() => {
          if (seq.current === id) setPending("");
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [key]);
  const fresh = Boolean(key) && state?.key === key;
  return { report: key ? (state?.report ?? null) : null, fresh, checking: Boolean(key) && (!fresh || pending === key) };
}

function busyLabel(b: BusyInfo | undefined): { text: string; cls: string } | null {
  if (!b) return null;
  if (b.overlap) return { text: "時間が重なる予定あり", cls: "text-critical-ink" };
  if (b.leave) return { text: "休暇・不在", cls: "text-warn-ink" };
  if (b.count > 0) return { text: `予定 ${b.count} 件`, cls: "text-ink-3" };
  return { text: "空き", cls: "text-good-ink" };
}

export function AssigneePicker({
  users,
  stores,
  selected,
  onChange,
  busy,
  currentUserId,
  storeId,
  label = "担当者",
  required,
  hint,
  name = "assigneeIds",
}: {
  users: FormUser[];
  stores: FormStore[];
  selected: string[];
  onChange: (ids: string[]) => void;
  busy?: Record<string, BusyInfo>;
  currentUserId: string;
  /** 「店舗のメンバー」で一括追加する店舗 */
  storeId: StoreId;
  label?: string;
  required?: boolean;
  hint?: string;
  /** 送信する項目名 (選択中の ID を hidden で送る) */
  name?: string;
}) {
  const [q, setQ] = useState("");
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const storeName = (id: StoreId) => stores.find((s) => s.id === id)?.shortName ?? "";
  const groups = useMemo(() => {
    const order = [storeId, ...stores.map((s) => s.id).filter((s) => s !== storeId)];
    return order
      .map((sid) => ({ store: stores.find((s) => s.id === sid), users: users.filter((u) => u.storeId === sid) }))
      .filter((g) => g.users.length > 0);
  }, [users, stores, storeId]);
  const needle = q.trim();
  const match = (u: FormUser) => !needle || u.name.replace(/\s/g, "").includes(needle.replace(/\s/g, "")) || u.title.includes(needle);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const storeMembers = users.filter((u) => u.storeId === storeId).map((u) => u.id);

  return (
    <fieldset className="min-w-0">
      <legend className="label flex w-full flex-wrap items-center gap-2">
        <span>
          {label}
          {required && <span className="ml-1 text-critical">*</span>}
          <span className="ml-1.5 font-normal text-ink-3">{selected.length} 人選択中</span>
        </span>
      </legend>
      {selected.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((id) => {
          const u = byId.get(id);
          if (!u) return null;
          const b = busy?.[id];
          return (
            <span key={id} className={clsx("inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-0.5 text-xs", b?.overlap ? "border-critical/40 bg-critical-soft text-critical-ink" : "border-line bg-subtle text-ink")}>
              <Avatar name={u.name} id={u.id} size={20} />
              {u.name}
              <span className="text-[10px] text-ink-3">{storeName(u.storeId)}</span>
              {b?.overlap && <TriangleAlert className="h-3 w-3" aria-label="時間が重なる予定あり" />}
              <button type="button" onClick={() => toggle(id)} className="rounded-full p-0.5 text-ink-3 hover:bg-panel hover:text-ink" aria-label={`${u.name} を担当者から外す`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        {selected.length === 0 && <span className="text-xs text-ink-3">まだ選ばれていません</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!selected.includes(currentUserId) && byId.has(currentUserId) && (
          <button type="button" onClick={() => onChange([...selected, currentUserId])} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-subtle">
            <UserPlus className="h-3.5 w-3.5" />
            自分を追加
          </button>
        )}
        {storeMembers.some((id) => !selected.includes(id)) && (
          <button type="button" onClick={() => onChange([...new Set([...selected, ...storeMembers])])} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-subtle">
            <Users className="h-3.5 w-3.5" />
            {storeName(storeId)}のメンバー全員
          </button>
        )}
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="rounded-lg px-2 py-1 text-xs text-ink-3 hover:bg-subtle hover:text-ink">
            すべて外す
          </button>
        )}
      </div>
      <div className="mt-2 rounded-xl border border-line">
        <div className="relative border-b border-line">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="名前・役割で絞り込み (例: 施工)"
            aria-label="担当者を名前・役割で絞り込み"
            className="h-9 w-full rounded-t-xl bg-transparent pr-3 pl-8 text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1.5">
          {groups.map((g) => {
            const list = g.users.filter(match);
            if (list.length === 0) return null;
            return (
              <div key={g.store?.id} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[11px] font-semibold text-ink-3">
                  <span className="h-2 w-2 rounded-full" style={{ background: g.store?.color }} aria-hidden />
                  {g.store?.name}
                </div>
                {list.map((u) => {
                  const on = selected.includes(u.id);
                  const b = busyLabel(busy?.[u.id]);
                  return (
                    <label key={u.id} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-subtle", on && "bg-accent-soft/60")}>
                      <input type="checkbox" checked={on} onChange={() => toggle(u.id)} className="h-4 w-4 accent-accent" />
                      <Avatar name={u.name} id={u.id} size={22} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ink">{u.name}</span>
                        <span className="block truncate text-[10px] text-ink-3">{u.title}</span>
                      </span>
                      {b && <span className={clsx("shrink-0 text-[11px] whitespace-nowrap", b.cls)}>{b.text}</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}
          {groups.every((g) => g.users.filter(match).length === 0) && <p className="px-2 py-4 text-center text-xs text-ink-3">該当する社員がいません</p>}
        </div>
      </div>
      {hint && <p className="mt-1 text-[11px] text-ink-3">{hint}</p>}
    </fieldset>
  );
}

/** 担当者のその日の予定と、重複の確認 */
export function ConflictPanel({
  report,
  fresh,
  checking,
  hasAssignees,
  ackChecked,
  onAck,
  ackLabel,
}: {
  report: ConflictReport | null;
  fresh: boolean;
  checking: boolean;
  hasAssignees: boolean;
  ackChecked: boolean;
  onAck: (v: boolean) => void;
  ackLabel: string;
}) {
  const conflicts = fresh ? (report?.conflicts ?? []) : [];
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex items-center gap-2">
        <CalendarCheck className="h-4 w-4 text-accent" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">担当者の空き状況</h2>
        {checking && hasAssignees && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-3">
            <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
            確認中
          </span>
        )}
      </div>
      {!hasAssignees && <p className="text-xs leading-relaxed text-ink-3">担当者を選ぶと、その日の予定と重複 (ダブルブッキング) をここで確認できます。担当者一覧には全社員のその日の空き状況が表示されます。</p>}
      {hasAssignees && report && (
        <>
          <p className="text-[11px] text-ink-3">{longDate(report.day)} の予定{report.occurrences > 1 ? ` (繰り返し ${report.occurrences} 回分の重複を確認)` : ""}</p>
          <ul className="space-y-2">
            {report.agenda.map((row) => (
              <li key={row.userId} className="rounded-xl border border-line p-2">
                <div className="flex items-center gap-2">
                  <Avatar name={row.userName} id={row.userId} size={22} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{row.userName}</span>
                  <span className="text-[10px] text-ink-3">{row.store}</span>
                </div>
                {row.items.length === 0 ? (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-good-ink">
                    <CircleCheck className="h-3 w-3" aria-hidden />
                    予定なし (終日空き)
                  </p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {row.items.map((it) => (
                      <li key={it.eventId} className={clsx("flex items-start gap-1.5 text-[11px] leading-snug", it.conflict ? "text-critical-ink" : "text-ink-2")}>
                        {it.conflict ? <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-label="重複" /> : <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden />}
                        <span className="shrink-0 tnum">{it.time}</span>
                        <Link href={`/schedule/${it.eventId}`} target="_blank" className="min-w-0 hover:underline">
                          {it.title}
                          <span className="text-ink-3"> ({it.kindLabel}{it.store ? `・${it.store}` : ""})</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {conflicts.length > 0 && (
        <div className="rounded-xl border border-critical/30 bg-critical-soft/60 p-3 text-xs text-critical-ink" role="alert">
          <p className="flex items-center gap-1.5 font-semibold">
            <TriangleAlert className="h-4 w-4" aria-hidden />
            担当者の予定が {conflicts.length} 件重複しています
          </p>
          <ul className="mt-2 space-y-1">
            {conflicts.slice(0, 8).map((c) => (
              <li key={`${c.userId}-${c.eventId}-${c.day}`} className="leading-snug">
                <span className="font-medium">{shortName(c.userName)}</span> {c.when}{" "}
                <Link href={`/schedule/${c.eventId}`} target="_blank" className="underline-offset-2 hover:underline">
                  「{c.title}」
                </Link>
                <span className="text-critical-ink/80"> {c.kindLabel}{c.store ? `・${c.store}` : ""}</span>
              </li>
            ))}
            {conflicts.length > 8 && <li>ほか {conflicts.length - 8} 件</li>}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-critical-ink/90">日時や担当者を変えると解消できます。同じ案件の予定どうし (施工中の引き取り・納品など) は重複として扱いません。</p>
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg bg-panel/80 px-2 py-1.5 text-ink">
            <input type="checkbox" checked={ackChecked} onChange={(e) => onAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#d03b3b]" />
            <span className="text-xs">{ackLabel}</span>
          </label>
          {ackChecked && <input type="hidden" name="allowOverlap" value="1" />}
        </div>
      )}
      {hasAssignees && fresh && conflicts.length === 0 && (
        <p className="flex items-center gap-1.5 rounded-xl bg-good-soft px-3 py-2 text-xs text-good-ink">
          <CircleCheck className="h-4 w-4" aria-hidden />
          担当者の予定との重複はありません
        </p>
      )}
    </div>
  );
}
