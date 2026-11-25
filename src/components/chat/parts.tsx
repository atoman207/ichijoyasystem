"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, CircleCheck, Copy, Download, FileSpreadsheet, FileText, FileVideo, ListTodo, Lock, MessageSquareReply, MoreHorizontal, Pencil, SmilePlus, Trash2, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { Avatar, Badge, StatusBadge } from "@/components/ui";
import { TASK_STATUS } from "@/lib/constants";
import { segments } from "@/lib/chat/text";
import { CHAT_REACTIONS, type ChatFile, type ChatMessageView, type ChatStoreRef, type ChatUser } from "@/lib/chat/types";
import { dueLabel, fileUrl, fullWhen, sizeLabel, timeLabel } from "./client";

/* ================================================================== */
/* 共通                                                                 */
/* ================================================================== */

export interface Dir {
  me: ChatUser;
  users: Map<string, ChatUser>;
  stores: ChatStoreRef[];
}

export const nameOf = (dir: Dir, id?: string) => (id ? (dir.users.get(id)?.name ?? "退職した社員") : "");

export function UserAvatar({ dir, id, size = 36 }: { dir: Dir; id: string; size?: number }) {
  const u = dir.users.get(id);
  return <Avatar name={u?.name ?? "?"} id={id} size={size} src={u?.avatar} />;
}

/** 画面の中央のダイアログ (背面を暗くして、押すと閉じる・Esc で閉じる) */
export function Modal({ title, onClose, children, wide = false, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input,textarea,select,button:not([data-close])")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  // 画面 (body) に直接出す (本文の枠の中だと fixed が本文の枠を基準にしてしまう)
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} className={clsx("relative flex max-h-[min(88dvh,760px)] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-panel shadow-pop animate-pop sm:rounded-2xl", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" data-close onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-subtle hover:text-ink" aria-label="閉じる">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-subtle/50 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ================================================================== */
/* 本文                                                                 */
/* ================================================================== */

export function MessageBody({ m, dir, className }: { m: Pick<ChatMessageView, "body" | "links">; dir: Dir; className?: string }) {
  const segs = segments(m.body, m.links);
  return (
    <div className={clsx("text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink", className)}>
      {segs.map((s, i) => {
        switch (s.kind) {
          case "text":
            return <span key={i}>{s.text}</span>;
          case "user": {
            const mine = s.id === dir.me.id;
            return (
              <span key={i} className={clsx("rounded px-0.5 font-medium", mine ? "bg-warn-soft text-warn-ink" : "bg-accent-soft text-accent-ink")}>
                @{nameOf(dir, s.id)}
              </span>
            );
          }
          case "all":
            return (
              <span key={i} className="rounded bg-warn-soft px-0.5 font-medium text-warn-ink">
                @全員
              </span>
            );
          case "store": {
            const st = dir.stores.find((x) => x.id === s.id);
            const mine = s.id === dir.me.storeId;
            return (
              <span key={i} className={clsx("rounded px-0.5 font-medium", mine ? "bg-warn-soft text-warn-ink" : "bg-accent-soft text-accent-ink")}>
                @{st?.name ?? "店舗"}
              </span>
            );
          }
          case "url":
            return (
              <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline-offset-2 hover:underline">
                {s.text}
              </a>
            );
          case "case":
            return (
              <Link key={i} href={s.href} className="font-medium text-accent underline-offset-2 hover:underline">
                {s.text}
              </Link>
            );
        }
      })}
    </div>
  );
}

/* ================================================================== */
/* 資料・写真                                                           */
/* ================================================================== */

function FileIcon({ f }: { f: ChatFile }) {
  if (f.video) return <FileVideo className="h-5 w-5" />;
  if (/sheet|excel|csv/.test(f.type)) return <FileSpreadsheet className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

export function FileList({ m, onOpenImage }: { m: Pick<ChatMessageView, "id" | "files" | "hiddenFiles">; onOpenImage: (files: ChatFile[], index: number) => void }) {
  if (!m.files.length && !m.hiddenFiles) return null;
  const photos = m.files.filter((f) => f.photo);
  const others = m.files.filter((f) => !f.photo);
  return (
    <div className="mt-1.5 space-y-1.5">
      {photos.length === 1 && (
        // 1 枚の写真は元の縦横の比のまま (小さい写真を引き伸ばさない)
        <button type="button" onClick={() => onOpenImage(photos, 0)} className="group/ph relative inline-block max-w-full overflow-hidden rounded-xl border border-line bg-subtle align-top" aria-label={`写真を開く: ${photos[0].name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ログインが必要な API から配信する */}
          <img src={fileUrl(m.id, photos[0], { thumb: photos[0].thumb })} alt={photos[0].name} loading="lazy" width={photos[0].width} height={photos[0].height} className="block h-auto max-h-80 w-auto max-w-[min(420px,100%)] min-w-[96px] object-contain transition group-hover/ph:opacity-90" />
          {photos[0].access === "managers" && <AccessTag />}
        </button>
      )}
      {photos.length > 1 && (
        <div className={clsx("grid max-w-[420px] gap-1.5", photos.length === 2 || photos.length === 4 ? "grid-cols-2" : "grid-cols-3")}>
          {photos.map((f, i) => (
            <button key={f.id} type="button" onClick={() => onOpenImage(photos, i)} className="group/ph relative overflow-hidden rounded-xl border border-line bg-subtle" aria-label={`写真を開く: ${f.name}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- ログインが必要な API から配信する */}
              <img src={fileUrl(m.id, f, { thumb: f.thumb })} alt={f.name} loading="lazy" className="block aspect-square w-full object-cover transition group-hover/ph:opacity-90" />
              {f.access === "managers" && <AccessTag />}
            </button>
          ))}
        </div>
      )}
      {others.map((f) =>
        f.video ? (
          <div key={f.id} className="max-w-[420px] overflow-hidden rounded-xl border border-line bg-ink/90">
            <video src={fileUrl(m.id, f)} controls preload="metadata" playsInline className="block max-h-72 w-full" />
            <div className="flex items-center gap-2 bg-panel px-2.5 py-1.5 text-xs text-ink-2">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              {f.access === "managers" && <Badge tone="warn" dot={false}>店長以上</Badge>}
              <a href={fileUrl(m.id, f, { download: true })} className="text-accent hover:underline">保存</a>
            </div>
          </div>
        ) : (
          <div key={f.id} className="flex max-w-[420px] items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2 shadow-xs">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
              <FileIcon f={f} />
            </span>
            <span className="min-w-0 flex-1">
              <a href={fileUrl(m.id, f)} target="_blank" rel="noopener" className="block truncate text-sm font-medium text-ink hover:text-accent hover:underline">
                {f.name}
              </a>
              <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                {sizeLabel(f.size)}
                {f.access === "managers" && (
                  <span className="inline-flex items-center gap-0.5 text-warn-ink">
                    <Lock className="h-3 w-3" />
                    店長以上だけ
                  </span>
                )}
              </span>
            </span>
            <a href={fileUrl(m.id, f, { download: true })} className="rounded-lg p-1.5 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={`${f.name} を保存`}>
              <Download className="h-4 w-4" />
            </a>
          </div>
        ),
      )}
      {m.hiddenFiles > 0 && (
        <p className="inline-flex items-center gap-1 rounded-lg bg-subtle px-2 py-1 text-[11px] text-ink-3">
          <Lock className="h-3 w-3" />
          店長以上だけが見られる資料が {m.hiddenFiles} 件あります
        </p>
      )}
    </div>
  );
}

function AccessTag() {
  return (
    <span className="absolute top-1 left-1 inline-flex items-center gap-0.5 rounded-md bg-ink/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
      <Lock className="h-3 w-3" />
      店長以上
    </span>
  );
}

/** 写真を大きく見る (前・次・保存) */
export function Lightbox({ messageId, files, index, onClose }: { messageId: string; files: ChatFile[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const f = files[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((x) => Math.min(files.length - 1, x + 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [files.length, onClose]);
  if (!f) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-ink/90" role="dialog" aria-modal="true" aria-label="写真">
      <div className="flex items-center gap-2 px-3 py-2 text-white">
        <span className="min-w-0 flex-1 truncate text-sm">{f.name}{files.length > 1 ? ` (${i + 1} / ${files.length})` : ""}</span>
        <a href={fileUrl(messageId, f, { download: true })} className="rounded-lg p-2 hover:bg-white/10" aria-label="保存">
          <Download className="h-5 w-5" />
        </a>
        <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="閉じる">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2" onClick={onClose}>
        {/* eslint-disable-next-line @next/next/no-img-element -- ログインが必要な API から配信する */}
        <img src={fileUrl(messageId, f)} alt={f.name} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        {i > 0 && (
          <button type="button" onClick={(e) => (e.stopPropagation(), setI(i - 1))} className="absolute left-2 rounded-full bg-white/15 p-2 text-white hover:bg-white/25" aria-label="前の写真">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {i < files.length - 1 && (
          <button type="button" onClick={(e) => (e.stopPropagation(), setI(i + 1))} className="absolute right-2 rounded-full bg-white/15 p-2 text-white hover:bg-white/25" aria-label="次の写真">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ================================================================== */
/* 1 件のメッセージ                                                      */
/* ================================================================== */

export interface MessageHandlers {
  onReply?: (m: ChatMessageView) => void;
  onReact: (m: ChatMessageView, emoji: string) => void;
  onEdit: (m: ChatMessageView) => void;
  onDelete: (m: ChatMessageView) => void;
  onTask: (m: ChatMessageView) => void;
  onAck: (m: ChatMessageView) => void;
  onAcks: (m: ChatMessageView) => void;
  onCopy: (m: ChatMessageView) => void;
  onOpenImage: (m: ChatMessageView, files: ChatFile[], index: number) => void;
}

export function TaskCard({ task, dir }: { task: NonNullable<ChatMessageView["task"]>; dir: Dir }) {
  const due = task.dueAt ?? (task.dueDate ? `${task.dueDate}T23:59:00+09:00` : undefined);
  return (
    <Link href={`/messages/${task.threadId}`} className="mt-1.5 flex max-w-[460px] items-start gap-2.5 rounded-xl border border-warn/30 bg-warn-soft/50 px-3 py-2 transition hover:border-warn/60 hover:bg-warn-soft">
      <ListTodo className="mt-0.5 h-4 w-4 shrink-0 text-warn-ink" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-ink">業務依頼</span>
          <StatusBadge value={task.status} map={TASK_STATUS} />
          {task.overdue && <Badge tone="critical" dot={false}>期限超過</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-ink">{task.title}</span>
        <span className="block text-[11px] text-ink-3">
          依頼先 {task.assigneeIds.map((id) => nameOf(dir, id)).join("・")}
          {due ? ` · 期限 ${dueLabel(due)}` : ""} · 開いて確認・報告
        </span>
      </span>
    </Link>
  );
}

function AckBar({ m, h, dir }: { m: ChatMessageView; h: MessageHandlers; dir: Dir }) {
  const a = m.ack;
  if (!a) return null;
  const all = a.total > 0 && a.done >= a.total;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {a.required && !a.mine && (
        <button type="button" onClick={() => h.onAck(m)} className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-warn px-3 text-xs font-semibold text-white shadow-xs transition hover:brightness-95" data-testid="chat-ack">
          <Check className="h-4 w-4" />
          確認しました
        </button>
      )}
      {a.mine && (
        <span className="inline-flex items-center gap-1 rounded-lg bg-good-soft px-2 py-1 text-[11px] font-medium text-good-ink">
          <CircleCheck className="h-3.5 w-3.5" />
          確認済み ({timeLabel(a.mine)})
        </span>
      )}
      <button type="button" onClick={() => h.onAcks(m)} disabled={!a.pendingIds} className={clsx("inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium", all ? "bg-good-soft text-good-ink" : "bg-subtle text-ink-2", a.pendingIds && "hover:bg-line/60")} title={a.pendingIds ? "確認した人・まだの人を見る" : undefined}>
        確認 {a.done} / {a.total} 人{all ? " (全員確認済み)" : ""}
        {a.pendingIds && !all && a.pendingIds.length <= 3 && <span className="text-ink-3">· まだ: {a.pendingIds.map((id) => nameOf(dir, id)).join("・")}</span>}
      </button>
    </div>
  );
}

function Reactions({ m, h, dir }: { m: ChatMessageView; h: MessageHandlers; dir: Dir }) {
  if (!m.reactions.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {m.reactions.map((r) => {
        const mine = r.userIds.includes(dir.me.id);
        return (
          <button key={r.emoji} type="button" onClick={() => h.onReact(m, r.emoji)} title={r.userIds.map((id) => nameOf(dir, id)).join("、")} className={clsx("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition", mine ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line bg-panel text-ink-2 hover:border-line-strong")}>
            <span>{r.emoji}</span>
            <span className="tnum">{r.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function ActionMenu({ m, h, dir, inThread, canDelete, onClose }: { m: ChatMessageView; h: MessageHandlers; dir: Dir; inThread: boolean; canDelete: boolean; onClose: () => void }) {
  const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-subtle";
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div className="w-60 rounded-xl border border-line bg-panel p-1.5 shadow-pop animate-pop" role="menu">
      <div className="mb-1 flex flex-wrap gap-0.5 border-b border-line px-1 pb-1.5">
        {CHAT_REACTIONS.map((e) => (
          <button key={e} type="button" onClick={run(() => h.onReact(m, e))} className="rounded-lg p-1.5 text-lg leading-none hover:bg-subtle" aria-label={`リアクション ${e}`}>
            {e}
          </button>
        ))}
      </div>
      {!inThread && h.onReply && (
        <button type="button" className={item} onClick={run(() => h.onReply!(m))}>
          <MessageSquareReply className="h-4 w-4 text-ink-3" />
          スレッドで返信
        </button>
      )}
      {!m.task && (
        <button type="button" className={item} onClick={run(() => h.onTask(m))}>
          <ListTodo className="h-4 w-4 text-ink-3" />
          業務依頼にする
        </button>
      )}
      <button type="button" className={item} onClick={run(() => h.onCopy(m))}>
        <Copy className="h-4 w-4 text-ink-3" />
        リンクをコピー
      </button>
      {m.userId === dir.me.id && (
        <button type="button" className={item} onClick={run(() => h.onEdit(m))}>
          <Pencil className="h-4 w-4 text-ink-3" />
          編集する
        </button>
      )}
      {canDelete && (
        <button type="button" className={clsx(item, "text-critical-ink")} onClick={run(() => h.onDelete(m))}>
          <Trash2 className="h-4 w-4" />
          削除する
        </button>
      )}
    </div>
  );
}

export function MessageItem({
  m,
  dir,
  h,
  compact,
  inThread = false,
  canDelete,
  highlight,
  editing,
  editor,
}: {
  m: ChatMessageView;
  dir: Dir;
  h: MessageHandlers;
  compact: boolean;
  inThread?: boolean;
  canDelete: boolean;
  highlight?: boolean;
  editing?: boolean;
  editor?: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const openMenu = () => {
    // 画面の下の方では上に開く (メッセージの一覧の下端で切れないように)
    const r = menuRef.current?.getBoundingClientRect();
    setMenuUp(Boolean(r && r.bottom + 330 > (window.visualViewport?.height ?? window.innerHeight)));
    setMenu((x) => !x);
  };
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [menu]);
  if (m.deleted) {
    if (!m.replyCount || inThread) return null;
  }
  const mentioned = !m.deleted && (m.mentions.includes(dir.me.id) || m.mentionAll);
  return (
    <div
      id={`m-${m.id}`}
      data-mid={m.id}
      data-at={m.at}
      className={clsx(
        "group relative flex gap-3 px-3 transition-colors @xl:px-4",
        compact ? "py-0.5" : "pt-2.5 pb-1",
        m.important ? "border-l-[3px] border-warn bg-warn-soft/35" : mentioned ? "border-l-[3px] border-accent/50 bg-accent-soft/25" : "border-l-[3px] border-transparent",
        highlight && "!bg-warn-soft/80",
        !editing && "hover:bg-subtle/70",
      )}
    >
      <div className="w-9 shrink-0">
        {!compact ? (
          <UserAvatar dir={dir} id={m.userId} />
        ) : (
          <span className="block pt-0.5 text-right text-[10px] text-ink-3 opacity-0 group-hover:opacity-100 tnum" title={fullWhen(m.at)}>
            {timeLabel(m.at)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[14px] font-semibold text-ink">{nameOf(dir, m.userId)}</span>
            <time className="text-[11px] text-ink-3 tnum" dateTime={m.at} title={fullWhen(m.at)}>
              {timeLabel(m.at)}
            </time>
            {m.important && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warn px-2 py-0.5 text-[10px] font-semibold text-white">
                <AlertTriangle className="h-3 w-3" />
                重要
              </span>
            )}
          </div>
        )}
        {m.deleted ? (
          <p className="text-[13px] text-ink-3 italic">このメッセージは削除されました</p>
        ) : editing ? (
          editor
        ) : (
          <>
            {m.body && <MessageBody m={m} dir={dir} />}
            {m.editedAt && <span className="text-[10px] text-ink-3">(編集済み)</span>}
            <FileList m={m} onOpenImage={(files, i) => h.onOpenImage(m, files, i)} />
            {m.task && <TaskCard task={m.task} dir={dir} />}
            <AckBar m={m} h={h} dir={dir} />
            <Reactions m={m} h={h} dir={dir} />
          </>
        )}
        {!inThread && m.replyCount > 0 && h.onReply && (
          <button type="button" onClick={() => h.onReply!(m)} className="mt-1 inline-flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft">
            <span className="flex -space-x-1.5">
              {m.replyUserIds.slice(-3).map((id) => (
                <UserAvatar key={id} dir={dir} id={id} size={18} />
              ))}
            </span>
            {m.replyCount} 件の返信
            {m.lastReplyAt && <span className="font-normal text-ink-3">· 最終 {timeLabel(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {!m.deleted && !editing && (
        <div ref={menuRef} className={clsx("absolute top-0.5 right-2 z-10", menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-70")}>
          <div className="flex items-center gap-0.5 rounded-xl border border-line bg-panel p-0.5 shadow-card">
            <button type="button" onClick={() => h.onReact(m, "👍")} className="rounded-lg p-1.5 text-sm leading-none hover:bg-subtle max-[480px]:hidden pointer-coarse:hidden" aria-label="リアクション 👍">
              👍
            </button>
            <button type="button" onClick={() => h.onReact(m, "✅")} className="rounded-lg p-1.5 text-sm leading-none hover:bg-subtle max-[480px]:hidden pointer-coarse:hidden" aria-label="リアクション ✅">
              ✅
            </button>
            {!inThread && h.onReply && (
              <button type="button" onClick={() => h.onReply!(m)} className="rounded-lg p-1.5 text-ink-2 hover:bg-subtle hover:text-ink pointer-coarse:hidden" aria-label="スレッドで返信" title="スレッドで返信">
                <MessageSquareReply className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={openMenu} className="rounded-lg p-1.5 text-ink-2 hover:bg-subtle hover:text-ink" aria-label="ほかの操作" aria-haspopup="menu" aria-expanded={menu} data-testid="chat-msg-menu">
              <span className="pointer-coarse:hidden">
                <MoreHorizontal className="h-4 w-4" />
              </span>
              <span className="hidden pointer-coarse:inline">
                <SmilePlus className="h-4 w-4" />
              </span>
            </button>
          </div>
          {menu && (
            <div className={clsx("absolute right-0 z-20", menuUp ? "bottom-full mb-1" : "top-full mt-1")}>
              <ActionMenu m={m} h={h} dir={dir} inThread={inThread} canDelete={canDelete} onClose={() => setMenu(false)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-[5] flex items-center gap-3 px-4 py-2" role="separator">
      <span className="h-px flex-1 bg-line" />
      <span className="rounded-full border border-line bg-panel px-3 py-0.5 text-[11px] font-medium text-ink-2 shadow-xs">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 px-4 py-1" role="separator" aria-label="ここから未読">
      <span className="h-px flex-1 bg-critical/60" />
      <span className="text-[11px] font-semibold text-critical-ink">ここから未読</span>
      <span className="h-px flex-1 bg-critical/60" />
    </div>
  );
}

