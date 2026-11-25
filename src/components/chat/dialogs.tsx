"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Bell, BellOff, Check, CircleAlert, Hash, Lock, MessageSquare, Plus, Search, Smartphone, Volume2, VolumeX, X } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import { archiveChatChannel, createChatChannel, makeChatTask, openDirect, remindChatMessage, setChatChannelNotify, setChatPrefs, shareChatMessage, testChatPush, updateChatChannel } from "@/lib/actions/chat";
import { matchName } from "@/lib/chat/text";
import { DM_MAX_MEMBERS, type ChatChannelView, type ChatDueChoice, type ChatMessageView, type ChatPrefs, type ChatTaskInput } from "@/lib/chat/types";
import { disablePush, enablePush, isIos, isStandalone, playChime, pushState, type PushState } from "./client";
import { Modal, nameOf, UserAvatar, type Dir } from "./parts";

const ROLE_ORDER: Record<string, number> = { admin: 0, hq_staff: 1, store_manager: 2, store_staff: 3 };

/* ================================================================== */
/* 社員を選ぶ                                                           */
/* ================================================================== */

export function PeoplePicker({ dir, value, onChange, max, exclude = [], prefer = [], label = "社員を検索 (名前・読み)" }: { dir: Dir; value: string[]; onChange: (ids: string[]) => void; max?: number; exclude?: string[]; prefer?: string[]; label?: string }) {
  const [q, setQ] = useState("");
  const all = useMemo(() => [...dir.users.values()].filter((u) => !exclude.includes(u.id)), [dir.users, exclude]);
  const pref = new Set(prefer);
  const list = all
    .map((u) => ({ u, score: matchName(q, u.name, u.kana) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(pref.has(b.u.id)) - Number(pref.has(a.u.id)) || (a.u.storeId === b.u.storeId ? 0 : a.u.storeId.localeCompare(b.u.storeId)) || (ROLE_ORDER[a.u.role] ?? 9) - (ROLE_ORDER[b.u.role] ?? 9) || a.u.kana.localeCompare(b.u.kana, "ja"))
    .map((x) => x.u);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : max && value.length >= max ? value : [...value, id]);
  const storeName = (id: string) => dir.stores.find((s) => s.id === id)?.name ?? "";
  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-1 text-xs font-medium text-accent-ink">
              <UserAvatar dir={dir} id={id} size={18} />
              {nameOf(dir, id)}
              <button type="button" onClick={() => toggle(id)} className="rounded-full p-0.5 hover:bg-accent/15" aria-label={`${nameOf(dir, id)} を外す`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="relative block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={label} className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" />
      </label>
      <ul className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-line">
        {list.length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-3">該当する社員がいません</li>}
        {list.map((u) => {
          const on = value.includes(u.id);
          return (
            <li key={u.id}>
              <button type="button" onClick={() => toggle(u.id)} className={clsx("flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-subtle", on && "bg-accent-soft/60")} aria-pressed={on}>
                <UserAvatar dir={dir} id={u.id} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{u.name}</span>
                  <span className="block truncate text-[11px] text-ink-3">{[storeName(u.storeId), u.title].filter(Boolean).join(" · ")}</span>
                </span>
                <span className={clsx("flex h-5 w-5 items-center justify-center rounded-md border", on ? "border-accent bg-accent text-white" : "border-line-strong")}>{on && <Check className="h-3.5 w-3.5" />}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ================================================================== */
/* 業務依頼の入力 (送るときの「業務依頼として送る」と「業務依頼にする」)       */
/* ================================================================== */

const DUE: { id: ChatDueChoice; label: string }[] = [
  { id: "none", label: "期限なし" },
  { id: "noon", label: "本日12時まで" },
  { id: "today", label: "本日中" },
  { id: "tomorrow", label: "明日中" },
  { id: "custom", label: "日時を指定" },
];

export function TaskFields({ dir, value, onChange, prefer }: { dir: Dir; value: ChatTaskInput; onChange: (v: ChatTaskInput) => void; prefer: string[] }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs font-medium text-ink-2">
          依頼先 <span className="text-critical">*</span>
        </div>
        <PeoplePicker dir={dir} value={value.assigneeIds} onChange={(assigneeIds) => onChange({ ...value, assigneeIds })} exclude={[dir.me.id]} prefer={prefer} label="依頼先を検索 (名前・読み)" />
      </div>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">期限</span>
          <select value={value.due} onChange={(e) => onChange({ ...value, due: e.target.value as ChatDueChoice })} className="h-9 w-full rounded-xl border border-line bg-panel px-2.5 text-sm outline-none focus:border-accent">
            {DUE.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {value.due === "custom" && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">期限の日時</span>
            <input type="datetime-local" value={value.dueCustom ?? ""} onChange={(e) => onChange({ ...value, dueCustom: e.target.value })} className="h-9 w-full rounded-xl border border-line bg-panel px-2.5 text-sm outline-none focus:border-accent" />
          </label>
        )}
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-2">件名 (空ならメッセージの 1 行目)</span>
        <input value={value.title} maxLength={80} onChange={(e) => onChange({ ...value, title: e.target.value })} className="h-9 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none focus:border-accent" placeholder="例: 合志店の在庫の確認" />
      </label>
      <p className="text-[11px] leading-relaxed text-ink-3">依頼先は「確認しました」→「報告」、依頼した人が報告を確かめて「完了」にするまで、チャットのボタンの「要対応」に残ります。業務依頼は「社内連絡・業務依頼」にも残り、依頼した人の店舗の社員・本部・管理者も見られます。</p>
    </div>
  );
}

export const emptyTask = (): ChatTaskInput => ({ title: "", assigneeIds: [], due: "none" });

export function TaskDialog({ dir, m, prefer, onClose, onDone }: { dir: Dir; m: ChatMessageView; prefer: string[]; onClose: () => void; onDone: (threadId: string) => void }) {
  const [v, setV] = useState<ChatTaskInput>(emptyTask);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!v.assigneeIds.length) return setErr("依頼先を 1 人以上選んでください。");
    setBusy(true);
    setErr("");
    try {
      const r = await makeChatTask(m.id, v);
      if (!r.ok || !r.data) setErr(r.error ?? "業務依頼を作れませんでした。");
      else onDone(r.data.threadId);
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="業務依頼にする"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            やめる
          </Button>
          <Button type="button" onClick={submit} disabled={busy} data-testid="chat-task-submit">
            {busy ? "依頼しています…" : "業務を依頼する"}
          </Button>
        </>
      }
    >
      <div className="@container">
        <p className="mb-3 line-clamp-3 rounded-xl bg-subtle px-3 py-2 text-xs text-ink-2">{m.body ? m.body.replace(/<@[^>]+>|<![^>]+>/g, "@…") : "(資料・写真)"}</p>
        {err && <ErrorLine text={err} />}
        <TaskFields dir={dir} value={v} onChange={setV} prefer={prefer} />
      </div>
    </Modal>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mb-3 flex items-start gap-1.5 rounded-xl bg-critical-soft px-3 py-2 text-xs text-critical-ink" role="alert">
      <CircleAlert className="mt-px h-4 w-4 shrink-0" />
      {text}
    </p>
  );
}

/* ================================================================== */
/* DM・チャンネル                                                       */
/* ================================================================== */

export function NewDmDialog({ dir, onClose, onOpen }: { dir: Dir; onClose: () => void; onOpen: (channelId: string) => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await openDirect(ids);
      if (!r.ok || !r.data) setErr(r.error ?? "DM を開けませんでした。");
      else onOpen(r.data.channelId);
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="新しい DM (個別のメッセージ)"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            やめる
          </Button>
          <Button type="button" onClick={submit} disabled={busy || !ids.length} data-testid="chat-dm-open">
            {ids.length > 1 ? `${ids.length} 人で始める` : "DM を開く"}
          </Button>
        </>
      }
    >
      {err && <ErrorLine text={err} />}
      <p className="mb-3 text-xs text-ink-3">相手を選んでください (1 人なら 1 対 1、{DM_MAX_MEMBERS} 人までのグループもできます)。DM は参加している本人同士だけが見られます (管理者も見られません)。</p>
      <PeoplePicker dir={dir} value={ids} onChange={setIds} max={DM_MAX_MEMBERS} exclude={[dir.me.id]} />
    </Modal>
  );
}

export function ChannelDialog({ dir, channel, onClose, onSaved }: { dir: Dir; channel?: ChatChannelView; onClose: () => void; onSaved: (channelId: string, archived?: boolean) => void }) {
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [visibility, setVisibility] = useState<"public" | "private">(channel?.visibility ?? "public");
  const [ids, setIds] = useState<string[]>(channel ? channel.memberIds.filter((x) => x !== dir.me.id) : []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const editing = Boolean(channel);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string; data?: { channelId: string } }>, after: (r: { data?: { channelId: string } }) => void) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "保存できませんでした。");
      else after(r);
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(
      () => (channel ? updateChatChannel(channel.id, { name, topic, memberIds: ids, visibility }).then((r) => ({ ...r, data: { channelId: channel.id } })) : createChatChannel({ name, topic, memberIds: ids, visibility })),
      (r) => onSaved(r.data!.channelId),
    );
  const addStore = (storeId: string) => setIds((x) => [...new Set([...x, ...[...dir.users.values()].filter((u) => u.storeId === storeId && u.id !== dir.me.id).map((u) => u.id)])]);
  const needMembers = visibility === "private" && !ids.length;
  return (
    <Modal
      title={editing ? `#${channel!.name} の設定` : "チャンネルを作成"}
      wide
      onClose={onClose}
      footer={
        <>
          {editing && (
            <Button type="button" variant="danger" onClick={() => confirm(`#${channel!.name} をアーカイブしますか？\nメッセージは残りますが、一覧に出なくなり、送れなくなります。`) && run(() => archiveChatChannel(channel!.id, true), () => onSaved(channel!.id, true))} disabled={busy}>
              アーカイブ
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="secondary" onClick={onClose}>
            やめる
          </Button>
          <Button type="button" onClick={save} disabled={busy || !name.trim() || needMembers} data-testid="chat-channel-save">
            {editing ? "保存する" : "作成する"}
          </Button>
        </>
      }
    >
      {err && <ErrorLine text={err} />}
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">
            名前 <span className="text-critical">*</span>
          </span>
          <span className="relative block">
            <Hash className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="例: 新商品の勉強会" className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" />
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">説明 (任意)</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder="何のためのチャンネルか" className="h-9 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" />
        </label>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-2">公開範囲</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ["public", "公開", "社員なら誰でも「チャンネルを探す」から見つけて参加できます", Hash],
                ["private", "非公開", "メンバーだけが見られます (招待した人だけ)", Lock],
              ] as const
            ).map(([v, label, desc, Icon]) => (
              <label key={v} className={clsx("flex cursor-pointer items-start gap-2.5 rounded-xl border p-3", visibility === v ? "border-accent bg-accent-soft/50" : "border-line hover:bg-subtle")}>
                <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1 accent-accent" />
                <span>
                  <span className="flex items-center gap-1 text-sm font-semibold text-ink">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                  <span className="block text-[11px] text-ink-3">{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink-2">
            メンバー {visibility === "private" ? <span className="text-critical">*</span> : <span className="font-normal text-ink-3">(任意。公開のチャンネルはあとから参加できます)</span>}
            <span className="font-normal text-ink-3">店舗の全員を追加:</span>
            {dir.stores.map((s) => (
              <button key={s.id} type="button" onClick={() => addStore(s.id)} className="rounded-full border border-line px-2 py-0.5 text-[11px] font-normal hover:bg-subtle">
                + {s.name}
              </button>
            ))}
          </div>
          <PeoplePicker dir={dir} value={ids} onChange={setIds} exclude={[dir.me.id]} />
          <p className="mt-1.5 text-[11px] text-ink-3">あなたも自動でメンバーになります。メンバーはあとから「メンバー」の画面で追加できます。</p>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* チャンネルを探す・共有・すばやく移動                                   */
/* ================================================================== */

export interface BrowseRow {
  id: string;
  kind: string;
  name: string;
  topic: string;
  color?: string;
  visibility?: "public" | "private";
  memberCount: number;
  joined: boolean;
  lastAt?: string;
  messages: number;
}

/** チャンネルを探す (全社・店舗・店長・公開のチャンネル。参加する・開く) */
export function BrowseDialog({ onClose, onOpen, onCreate }: { onClose: () => void; onOpen: (id: string, join: boolean) => void; onCreate: () => void }) {
  const [list, setList] = useState<BrowseRow[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/chat/browse", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { channels?: BrowseRow[]; error?: string }) => (j.channels ? setList(j.channels) : setErr(j.error ?? "読み込めませんでした。")))
      .catch(() => setErr("読み込めませんでした。"));
  }, []);
  const shown = (list ?? []).filter((c) => !q.trim() || matchName(q, c.name) > 0 || c.topic.includes(q.trim()));
  return (
    <Modal
      title="チャンネルを探す"
      wide
      onClose={onClose}
      footer={
        <Button type="button" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          チャンネルを作成
        </Button>
      }
    >
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="チャンネルの名前・説明で探す" className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" autoFocus />
      </label>
      {err && <ErrorLine text={err} />}
      {!list && !err && <p className="py-6 text-center text-sm text-ink-3">読み込んでいます…</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {list && shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-3">見つかりません</li>}
        {shown.map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-subtle/60">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: c.color ?? (c.kind === "custom" ? "#64748b" : "#4a5ae8") }}>
              <Hash className="h-4 w-4" />
            </span>
            <button type="button" onClick={() => onOpen(c.id, false)} className="min-w-0 flex-1 text-left">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                {c.name}
                {c.joined && <span className="rounded-full bg-good-soft px-1.5 py-px text-[10px] font-medium text-good-ink">参加中</span>}
              </span>
              <span className="block truncate text-[11px] text-ink-3">
                メンバー {c.memberCount} 人 · メッセージ {c.messages} 件{c.topic ? ` · ${c.topic}` : ""}
              </span>
            </button>
            {c.joined ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(c.id, false)}>
                開く
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => onOpen(c.id, true)} data-testid="chat-browse-join">
                参加する
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** メッセージを別のチャンネル・DM に共有する (転送) */
export function ShareDialog({ dir, m, channels, onClose, onDone }: { dir: Dir; m: ChatMessageView; channels: ChatChannelView[]; onClose: () => void; onDone: (channelId: string) => void }) {
  const targets = channels.filter((c) => c.canPost && !c.archived);
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await shareChatMessage(m.id, target, comment);
      if (!r.ok) setErr(r.error ?? "共有できませんでした。");
      else onDone(target);
    } catch {
      setErr("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="メッセージを共有"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            やめる
          </Button>
          <Button type="button" onClick={submit} disabled={busy || !target} data-testid="chat-share-send">
            共有する
          </Button>
        </>
      }
    >
      {err && <ErrorLine text={err} />}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-2">共有先 (チャンネル・DM)</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 w-full rounded-xl border border-line bg-panel px-2.5 text-sm outline-none focus:border-accent">
          {targets.map((c) => (
            <option key={c.id} value={c.id}>
              {c.kind === "dm" ? `DM: ${c.name}` : `# ${c.name}`}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-ink-2">ひとこと (任意)</span>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent" placeholder="例: これを見ておいてください" />
      </label>
      <div className="mt-3 rounded-xl border border-line bg-subtle/50 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-ink-3">
          <UserAvatar dir={dir} id={m.userId} size={18} />
          <span className="font-semibold text-ink">{nameOf(dir, m.userId)}</span>
        </div>
        <p className="line-clamp-4 text-[13px] whitespace-pre-wrap text-ink-2">{m.body.replace(/<@([^>]+)>/g, (_, id: string) => `@${nameOf(dir, id)}`).replace(/<![^>]+>/g, "@…") || "(資料・写真)"}</p>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">共有先のメンバーに、このメッセージの写しが届きます。資料・写真は元のチャンネル・DM を見られる人だけが開けます。</p>
    </Modal>
  );
}

export interface SwitchItem {
  key: string;
  kind: "channel" | "dm" | "person";
  label: string;
  sub?: string;
  id: string;
}

/** すばやく移動 (Ctrl / ⌘ + K): チャンネル・DM・社員の名前で探して開く */
export function QuickSwitcher({ dir, channels, onClose, onPick }: { dir: Dir; channels: ChatChannelView[]; onClose: () => void; onPick: (item: SwitchItem) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const items: SwitchItem[] = [
    ...channels.map<SwitchItem>((c) => ({ key: `c:${c.id}`, kind: c.kind === "dm" ? "dm" : "channel", label: c.name, sub: c.kind === "dm" ? "DM" : c.topic, id: c.id })),
    ...[...dir.users.values()].filter((u) => u.id !== dir.me.id).map<SwitchItem>((u) => ({ key: `p:${u.id}`, kind: "person", label: u.name, sub: [dir.stores.find((s) => s.id === u.storeId)?.name, u.title].filter(Boolean).join(" · "), id: u.id })),
  ];
  const shown = items
    .map((x) => ({ x, s: matchName(q, x.label, x.kind === "person" ? dir.users.get(x.id)?.kana : "") }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || (a.x.kind === "person" ? 1 : 0) - (b.x.kind === "person" ? 1 : 0))
    .slice(0, 12)
    .map((r) => r.x);
  return (
    <Modal title="移動先を探す (Ctrl / ⌘ + K)" onClose={onClose}>
      <input
        value={q}
        onChange={(e) => (setQ(e.target.value), setI(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setI((x) => Math.min(shown.length - 1, x + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setI((x) => Math.max(0, x - 1));
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing && shown[i]) {
            e.preventDefault();
            onPick(shown[i]);
          }
        }}
        placeholder="チャンネル・DM・社員の名前"
        className="h-10 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15"
        autoFocus
        data-testid="chat-switcher-input"
      />
      <ul className="mt-2" role="listbox">
        {shown.map((x, k) => (
          <li key={x.key} role="option" aria-selected={k === i}>
            <button type="button" onClick={() => onPick(x)} onMouseEnter={() => setI(k)} className={clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", k === i ? "bg-accent-soft" : "hover:bg-subtle")}>
              {x.kind === "person" ? <UserAvatar dir={dir} id={x.id} size={24} presence /> : <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-soft text-ink-2">{x.kind === "dm" ? <MessageSquare className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{x.label}</span>
                {x.sub && <span className="block truncate text-[11px] text-ink-3">{x.sub}</span>}
              </span>
              <span className="text-[10px] text-ink-3">{x.kind === "person" ? "DM を開く" : "開く"}</span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-6 text-center text-xs text-ink-3">見つかりません</li>}
      </ul>
    </Modal>
  );
}

/** 重要メッセージの確認の状態 (確認した人・まだの人・まだの人への再通知) */
export function AckDialog({ dir, m, onClose, onReminded }: { dir: Dir; m: ChatMessageView; onClose: () => void; onReminded: (count: number) => void }) {
  const a = m.ack!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const canRemind = (m.userId === dir.me.id || dir.me.role === "admin") && (a.pendingIds?.length ?? 0) > 0;
  const remind = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await remindChatMessage(m.id);
      if (!r.ok) setErr(r.error ?? "知らせられませんでした。");
      else onReminded(r.data?.count ?? 0);
    } catch {
      setErr("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`確認の状態 (${a.done} / ${a.total} 人)`}
      onClose={onClose}
      footer={
        canRemind ? (
          <Button type="button" onClick={remind} disabled={busy} data-testid="chat-remind">
            まだの人にもう一度知らせる ({a.pendingIds!.length} 人)
          </Button>
        ) : undefined
      }
    >
      {err && <ErrorLine text={err} />}
      {a.remindedAt && <p className="mb-2 text-[11px] text-ink-3">最後に再通知した日時: {new Date(a.remindedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-critical-ink">まだ ({a.pendingIds?.length ?? 0} 人)</h3>
          <ul className="space-y-1.5">
            {(a.pendingIds ?? []).map((id) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <UserAvatar dir={dir} id={id} size={24} />
                {nameOf(dir, id)}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-good-ink">確認済み ({a.ackedIds?.length ?? 0} 人)</h3>
          <ul className="space-y-1.5">
            {(a.ackedIds ?? []).map((id) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <UserAvatar dir={dir} id={id} size={24} />
                {nameOf(dir, id)}
                <Check className="h-4 w-4 text-good" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* 通知の設定                                                           */
/* ================================================================== */

export function PrefsDialog({ prefs, vapidKey, channels, onClose, onPrefs, onChannelNotify }: { prefs: ChatPrefs; vapidKey: string; channels: ChatChannelView[]; onClose: () => void; onPrefs: (p: ChatPrefs) => void; onChannelNotify: (id: string, level: "all" | "priority") => void }) {
  const [p, setP] = useState(prefs);
  const [ps, setPs] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void pushState().then((x) => setPs(x.state));
  }, []);
  const savePrefs = async (next: ChatPrefs) => {
    setP(next);
    const r = await setChatPrefs(next).catch(() => null);
    if (r?.ok && r.data) onPrefs(r.data);
  };
  const enable = async () => {
    setBusy(true);
    setMsg(null);
    const r = await enablePush(vapidKey);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "この端末で通知を受け取れるようになりました。「テストの通知を送る」で確かめられます。" } : { ok: false, text: r.error ?? "登録できませんでした。" });
    setPs((await pushState()).state);
    if (r.ok) setP((x) => ({ ...x, push: true }));
  };
  const disable = async () => {
    setBusy(true);
    await disablePush();
    setBusy(false);
    setPs((await pushState()).state);
    setMsg({ ok: true, text: "この端末での通知を止めました。" });
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    const r = await testChatPush().catch(() => null);
    setBusy(false);
    setMsg(r?.ok ? { ok: true, text: `テストの通知を送りました (${r.data?.sent ?? 0} 台)。届かないときは端末の通知の設定を確かめてください。` } : { ok: false, text: r?.error ?? "送れませんでした。" });
  };
  const ios = typeof window !== "undefined" && isIos();
  const standalone = typeof window !== "undefined" && isStandalone();
  const shown = channels.filter((c) => !c.archived);
  return (
    <Modal title="チャットの通知の設定" wide onClose={onClose}>
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Smartphone className="h-4 w-4 text-accent" />
            プッシュ通知 (システムを閉じていても通知)
          </h3>
          <div className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">この端末:</span>
              {ps === "loading" && <Badge>確かめています…</Badge>}
              {ps === "on" && <Badge tone="good">通知を受け取ります</Badge>}
              {ps === "off" && <Badge tone="neutral">まだ受け取りません</Badge>}
              {ps === "denied" && <Badge tone="critical">通知がブロックされています</Badge>}
              {ps === "ios-home" && <Badge tone="warn">ホーム画面に追加が必要</Badge>}
              {ps === "unsupported" && <Badge tone="warn">このブラウザーは非対応</Badge>}
              <span className="flex-1" />
              {(ps === "off" || ps === "denied") && (
                <Button type="button" size="sm" onClick={enable} disabled={busy} data-testid="chat-push-enable">
                  この端末で通知を受け取る
                </Button>
              )}
              {ps === "on" && (
                <>
                  <Button type="button" size="sm" variant="secondary" onClick={test} disabled={busy}>
                    テストの通知を送る
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={disable} disabled={busy}>
                    この端末では受け取らない
                  </Button>
                </>
              )}
            </div>
            {msg && <p className={clsx("mt-2 text-xs", msg.ok ? "text-good-ink" : "text-critical-ink")}>{msg.text}</p>}
            {ps === "denied" && <p className="mt-2 text-xs text-ink-3">ブラウザー (iPhone は 設定 → 通知 → 一畳屋) で、このサイトの通知を「許可」にしてから、もう一度押してください。</p>}
            {(ps === "ios-home" || (ios && !standalone)) && (
              <p className="mt-2 text-xs leading-relaxed text-ink-3">iPhone・iPad は、Safari で開いて「共有」→「ホーム画面に追加」で追加したアプリ (一畳屋のアイコン) から開き、この画面で「この端末で通知を受け取る」を押すと、LINE と同じようにロック画面に通知が届きます (iOS 16.4 以降)。</p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">通知を受け取る端末ごとに 1 回押します (パソコン・スマートフォン・タブレット)。音とバイブレーションは端末の通知の設定に従います。</p>
            <label className="mt-3 flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={p.push} onChange={(e) => void savePrefs({ ...p, push: e.target.checked })} className="h-4 w-4 accent-accent" />
              プッシュ通知を使う (オフにすると、登録したすべての端末に送りません)
            </label>
          </div>
        </section>
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
            {p.sound ? <Volume2 className="h-4 w-4 text-accent" /> : <VolumeX className="h-4 w-4 text-ink-3" />}
            画面を開いているときの通知音
          </h3>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={p.sound} onChange={(e) => void savePrefs({ ...p, sound: e.target.checked })} className="h-4 w-4 accent-accent" data-testid="chat-sound" />
              通知音を鳴らす
            </label>
            <span className="flex-1" />
            <Button type="button" size="sm" variant="ghost" onClick={() => playChime("priority")}>
              自分あての音
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => playChime("normal")}>
              通常の音
            </Button>
          </div>
        </section>
        <section>
          <h3 className="mb-1 text-sm font-semibold text-ink">チャンネル・DM ごとの通常のメッセージ</h3>
          <p className="mb-2 text-[11px] leading-relaxed text-ink-3">「すべて」= 新しいメッセージのたびに通知音・プッシュ通知。「自分あてだけ」= 通常のメッセージは数字も音も出しません。業務依頼・重要メッセージ・自分へのメンションは、どちらでも必ずお知らせします (赤い数字・自分あての音)。</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {shown.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.kind === "dm" ? c.name : `# ${c.name}`}</span>
                <div className="flex rounded-lg border border-line p-0.5 text-xs">
                  <button type="button" onClick={() => onChannelNotify(c.id, "all")} className={clsx("inline-flex items-center gap-1 rounded-md px-2 py-1", c.notify === "all" ? "bg-accent text-white" : "text-ink-2 hover:bg-subtle")}>
                    <Bell className="h-3.5 w-3.5" />
                    すべて
                  </button>
                  <button type="button" onClick={() => onChannelNotify(c.id, "priority")} className={clsx("inline-flex items-center gap-1 rounded-md px-2 py-1", c.notify === "priority" ? "bg-accent text-white" : "text-ink-2 hover:bg-subtle")}>
                    <BellOff className="h-3.5 w-3.5" />
                    自分あてだけ
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}

/** チャンネルの通知 (すべて / 自分あてだけ) を変える */
export async function changeNotify(channelId: string, level: "all" | "priority"): Promise<boolean> {
  const r = await setChatChannelNotify(channelId, level).catch(() => null);
  return Boolean(r?.ok);
}
