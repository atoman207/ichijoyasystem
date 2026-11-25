"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import Link from "@/components/ui/Link";
import { ChevronLeft, ChevronRight, Download, FileText, PenLine, Trash2, X } from "lucide-react";
import type { AttachmentView } from "@/lib/attachments";
import { AnnotateDialog } from "./AnnotateDialog";

type DeleteAction = (id: string, formData: FormData) => Promise<void>;

function size(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function DeleteButton({ item, action, returnTo, compact = false }: { item: AttachmentView; action: DeleteAction; returnTo: string; compact?: boolean }) {
  if (!item.canDelete) return null;
  return (
    <form
      action={action.bind(null, item.id)}
      onSubmit={(e) => {
        if (!window.confirm(`「${item.fileName}」を削除します。よろしいですか？ (変更履歴に残ります)`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className={compact ? "rounded-md p-1 text-ink-3 hover:bg-critical-soft hover:text-critical-ink" : "inline-flex h-9 items-center gap-1 rounded-lg bg-white/10 px-3 text-xs text-white hover:bg-critical"} aria-label={`${item.fileName} を削除`}>
        <Trash2 className="h-4 w-4" aria-hidden />
        {!compact && "削除"}
      </button>
    </form>
  );
}

/**
 * 写真 (サムネイル + 拡大表示) と資料 (一覧)。資料の種類 (現場図面・採寸図など) で絞り込み、
 * 写真は「書き込む」で番号・線を書いて新しい写真として保存できる (お客様のご要望 2026-11-25「⑤」)
 */
export function AttachmentGallery({ items, deleteAction, returnTo, showParent = false, onChanged }: { items: AttachmentView[]; deleteAction?: DeleteAction; returnTo: string; showParent?: boolean; onChanged?: () => void }) {
  const router = useRouter();
  const cats = [...new Map(items.filter((i) => i.category).map((i) => [i.category!, i.categoryLabel ?? i.category!])).entries()];
  const [filter, setFilter] = useState<string>("");
  const shown = filter ? items.filter((i) => i.category === filter) : items;
  const photos = shown.filter((i) => i.kind === "photo");
  const files = shown.filter((i) => i.kind === "file");
  const [open, setOpen] = useState<number | null>(null);
  const [annotate, setAnnotate] = useState<AttachmentView | null>(null);
  const count = photos.length;
  const close = () => setOpen(null);
  const move = (d: number) => setOpen((i) => (i === null ? i : (i + d + count) % count));

  useEffect(() => {
    if (open === null) return;
    const step = (d: number) => setOpen((i) => (i === null ? i : (i + d + count) % count));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, count]);

  const current = open !== null ? photos[open] : null;

  return (
    <div className="space-y-4">
      {cats.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="資料の種類で絞り込む">
          {[["", "すべて"] as [string, string], ...cats].map(([k, label]) => (
            <button key={k || "all"} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)} className={clsx("rounded-full border px-2.5 py-0.5 text-[11px]", filter === k ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line text-ink-2 hover:border-accent/50")}>
              {label}
              {k ? ` (${items.filter((i) => i.category === k).length})` : ""}
            </button>
          ))}
        </div>
      )}
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 @xl:grid-cols-3 @3xl:grid-cols-4" aria-label="写真">
          {photos.map((p, i) => (
            <li key={p.id} className="group relative overflow-hidden rounded-xl border border-line bg-subtle">
              <button type="button" onClick={() => setOpen(i)} className="block w-full text-left focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25" aria-label={`${p.fileName} を拡大表示`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/attachments/${p.id}?size=thumb`} alt={p.caption || p.fileName} loading="lazy" className="aspect-[4/3] w-full object-cover transition group-hover:scale-[1.02]" />
                {p.categoryLabel && <span className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{p.categoryLabel}{p.derived ? "・書き込み" : ""}</span>}
                <span className="block px-2 py-1.5 text-[11px] leading-snug">
                  <span className="block truncate font-medium text-ink">{p.caption || p.fileName}</span>
                  <span className="block truncate text-ink-3">撮影 {p.takenLabel ?? "-"} · {p.uploaderName}</span>
                  {showParent && <span className="block truncate text-ink-3">{p.parentLabel}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="資料">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2">
              <FileText className="h-5 w-5 shrink-0 text-accent" aria-hidden />
              <div className="min-w-0 flex-1 text-xs">
                <a href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-accent hover:underline">{f.fileName}</a>
                <span className="block truncate text-ink-3">
                  {f.categoryLabel ? `${f.categoryLabel} · ` : ""}{size(f.size)} · 登録 {f.uploadedLabel} · {f.uploaderName}{f.caption ? ` · ${f.caption}` : ""}
                  {showParent && <> · <Link href={f.parentHref} className="hover:underline">{f.parentLabel}</Link></>}
                </span>
              </div>
              <a href={`/api/attachments/${f.id}?download=1`} className="rounded-md p-1 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={`${f.fileName} を保存`}><Download className="h-4 w-4" aria-hidden /></a>
              {deleteAction && <DeleteButton item={f} action={deleteAction} returnTo={returnTo} compact />}
            </li>
          ))}
        </ul>
      )}

      {/* 画面 (body) に直接出す (本文の枠の中だと fixed が本文の枠を基準にしてしまう。EventQuick.tsx と同じ) */}
      {current &&
        createPortal(
        <div role="dialog" aria-modal="true" aria-label={`写真 ${open! + 1} / ${photos.length}`} className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white" onClick={close}>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs" onClick={(e) => e.stopPropagation()}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{current.caption || current.fileName}</div>
              <div className="truncate text-white/70">
                {open! + 1} / {photos.length} · 撮影 {current.takenLabel ?? "-"} · 登録 {current.uploadedLabel} {current.uploaderName}
                {showParent && <> · <Link href={current.parentHref} className="underline">{current.parentLabel}</Link></>}
              </div>
            </div>
            {current.canAnnotate && (
              <button type="button" onClick={() => setAnnotate(current)} className="inline-flex h-9 items-center gap-1 rounded-lg bg-accent px-3 font-medium hover:bg-accent-hover" data-testid="annotate-open">
                <PenLine className="h-4 w-4" aria-hidden />
                書き込む (番号・線)
              </button>
            )}
            <a href={`/api/attachments/${current.id}?download=1`} className="inline-flex h-9 items-center gap-1 rounded-lg bg-white/10 px-3 hover:bg-white/20"><Download className="h-4 w-4" aria-hidden />保存</a>
            {deleteAction && <DeleteButton item={current} action={deleteAction} returnTo={returnTo} />}
            <button type="button" onClick={close} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20" aria-label="閉じる"><X className="h-5 w-5" aria-hidden /></button>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={current.id} src={`/api/attachments/${current.id}`} alt={current.caption || current.fileName} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
            {photos.length > 1 && (
              <>
                <button type="button" onClick={(e) => { e.stopPropagation(); move(-1); }} className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70" aria-label="前の写真"><ChevronLeft className="h-6 w-6" aria-hidden /></button>
                <button type="button" onClick={(e) => { e.stopPropagation(); move(1); }} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70" aria-label="次の写真"><ChevronRight className="h-6 w-6" aria-hidden /></button>
              </>
            )}
          </div>
        </div>,
          document.body,
        )}
      {annotate && (
        <AnnotateDialog
          attachmentId={annotate.id}
          fileName={annotate.fileName}
          parentType={annotate.parentType}
          parentId={annotate.parentId}
          onClose={() => setAnnotate(null)}
          onSaved={() => {
            setAnnotate(null);
            setOpen(null);
            if (onChanged) onChanged();
            else router.refresh();
          }}
        />
      )}
    </div>
  );
}
