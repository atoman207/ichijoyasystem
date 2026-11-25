"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Trash2, TriangleAlert } from "lucide-react";
import { deleteInquiry } from "@/lib/actions/inquiries";
import { INQUIRY_DELETE_REASONS } from "@/lib/inquiry-delete";
import { Button, buttonClass } from "@/components/ui";

/**
 * 問い合わせの削除のボタン (お客様のご要望 2026-11-25)。押すと「本当に削除しますか？」の確認の画面を出し、理由を選んで削除 (店長以上) / 削除を申請 (店舗スタッフ)。
 * 処理は src/lib/actions/inquiries.ts の deleteInquiry (記録は残し、通常の一覧・集計には出さない。検索では「削除済み」)
 */
export function DeleteInquiryButton({
  inquiryId,
  number,
  summary,
  customer,
  mode,
  events,
  returnTo,
  compact = false,
}: {
  inquiryId: string;
  number: string;
  summary: string;
  customer: string;
  /** direct = すぐに削除 (店長以上) / request = 店長の承認で削除 (店舗スタッフ) */
  mode: "direct" | "request";
  /** あわせて削除する予定の件数 */
  events: number;
  returnTo: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(INQUIRY_DELETE_REASONS[0]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={compact ? "rounded-md p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical-ink" : clsx(buttonClass("ghost", "sm"), "text-critical-ink hover:bg-critical-soft")}
        aria-label={`${number} を削除`}
        title={mode === "direct" ? "この問い合わせを削除" : "この問い合わせの削除を申請 (店長の承認)"}
        data-testid="inquiry-delete-open"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        {!compact && (mode === "direct" ? "この問い合わせを削除" : "削除を申請")}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
            <button type="button" tabIndex={-1} aria-label="閉じる" className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
            <div role="alertdialog" aria-modal="true" aria-labelledby={`del-inq-${inquiryId}`} className="relative w-full max-w-md rounded-t-2xl border border-line bg-panel p-4 shadow-pop sm:rounded-2xl" data-testid="inquiry-delete-confirm">
              <p id={`del-inq-${inquiryId}`} className="flex items-center gap-2 text-base font-semibold text-critical-ink">
                <TriangleAlert className="h-5 w-5" aria-hidden />
                本当に削除しますか？
              </p>
              <div className="mt-2 rounded-lg bg-subtle px-3 py-2 text-sm">
                <div className="font-mono text-xs text-ink-3">{number}</div>
                <div className="font-medium text-ink">{customer ? `${customer} 様 · ` : ""}{summary}</div>
              </div>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-ink-2">
                <li>問い合わせの一覧・集計には出なくなります。記録は残り、一覧で検索すると「削除済み」として確認できます。</li>
                {events > 0 && <li className="text-critical-ink">この問い合わせの予定 {events} 件も予定表から削除します。</li>}
                <li>削除した人・日時・理由は変更履歴に残ります。</li>
                {mode === "request" && <li className="font-medium text-ink">店長の承認のあとに削除されます (それまでは一覧に残ります)。</li>}
              </ul>
              <form action={deleteInquiry.bind(null, inquiryId)} className="mt-3 space-y-2">
                <input type="hidden" name="returnTo" value={returnTo} />
                <fieldset>
                  <legend className="label">削除の理由</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {[...INQUIRY_DELETE_REASONS, "その他"].map((r) => (
                      <label key={r} className={clsx("cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs", choice === r ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line text-ink-2")}>
                        <input type="radio" name="reasonChoice" value={r === "その他" ? "" : r} checked={choice === r} onChange={() => setChoice(r)} className="sr-only" />
                        {r}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <input name="reason" maxLength={150} required={choice === "その他"} placeholder={choice === "その他" ? "理由を入れてください" : "補足 (任意)"} className="field" aria-label="削除の理由の補足" />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button type="submit" variant="danger" size="sm" data-testid="inquiry-delete-submit">
                    {mode === "direct" ? "削除する" : "削除を申請する (店長の承認)"}
                  </Button>
                  <button type="button" onClick={() => setOpen(false)} className={buttonClass("secondary", "sm")} autoFocus>
                    やめる
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
