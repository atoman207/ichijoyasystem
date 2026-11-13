"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "@/components/ui/Link";
import { ChevronLeft, ChevronRight, Download, FileText, Trash2, X } from "lucide-react";
import type { AttachmentView } from "@/lib/attachments";

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

/** 写真 (サムネイル + 拡大表示) と資料 (一覧) */
export function AttachmentGallery({ items, deleteAction, returnTo, showParent = false }: { items: AttachmentView[]; deleteAction: DeleteAction; returnTo: string; showParent?: boolean }) {
  const photos = items.filter((i) => i.kind === "photo");
  const files = items.filter((i) => i.kind === "file");
  const [open, setOpen] = useState<number | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const move = useCallback((d: number) => setOpen((i) => (i === null ? i : (i + d + photos.length) % photos.length)), [photos.length]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, close, move]);

  const current = open !== null ? photos[open] : null;

  return (
    <div className="space-y-4">
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 @xl:grid-cols-3 @3xl:grid-cols-4" aria-label="写真">
          {photos.map((p, i) => (
            <li key={p.id} className="group relative overflow-hidden rounded-xl border border-line bg-subtle">
              <button type="button" onClick={() => setOpen(i)} className="block w-full text-left focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25" aria-label={`${p.fileName} を拡大表示`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/attachments/${p.id}?size=thumb`} alt={p.caption || p.fileName} loading="lazy" className="aspect-[4/3] w-full object-cover transition group-hover:scale-[1.02]" />
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
                  {size(f.size)} · 登録 {f.uploadedLabel} · {f.uploaderName}{f.caption ? ` · ${f.caption}` : ""}
                  {showParent && <> · <Link href={f.parentHref} className="hover:underline">{f.parentLabel}</Link></>}
                </span>
              </div>
              <a href={`/api/attachments/${f.id}?download=1`} className="rounded-md p-1 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={`${f.fileName} を保存`}><Download className="h-4 w-4" aria-hidden /></a>
              <DeleteButton item={f} action={deleteAction} returnTo={returnTo} compact />
            </li>
          ))}
        </ul>
      )}

      {current && (
        <div role="dialog" aria-modal="true" aria-label={`写真 ${open! + 1} / ${photos.length}`} className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white" onClick={close}>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs" onClick={(e) => e.stopPropagation()}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{current.caption || current.fileName}</div>
              <div className="truncate text-white/70">
                {open! + 1} / {photos.length} · 撮影 {current.takenLabel ?? "-"} · 登録 {current.uploadedLabel} {current.uploaderName}
                {showParent && <> · <Link href={current.parentHref} className="underline">{current.parentLabel}</Link></>}
              </div>
            </div>
            <a href={`/api/attachments/${current.id}?download=1`} className="inline-flex h-9 items-center gap-1 rounded-lg bg-white/10 px-3 hover:bg-white/20"><Download className="h-4 w-4" aria-hidden />保存</a>
            <DeleteButton item={current} action={deleteAction} returnTo={returnTo} />
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
        </div>
      )}
    </div>
  );
}
