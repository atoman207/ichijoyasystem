"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import clsx from "clsx";
import Link from "@/components/ui/Link";
import { Camera, ClipboardCheck, FileImage, FileText, ImagePlus, Keyboard, LoaderCircle, Printer, Receipt as ReceiptIcon } from "lucide-react";
import { Button, buttonClass } from "@/components/ui";
import { captureCaseQuote } from "@/lib/actions/capture";
import { issueCaseInvoice } from "@/lib/actions/day-docs";
import { setReceiptWanted } from "@/lib/actions/receipts";
import { deleteAttachment } from "@/lib/actions/attachments";
import { prepareFile } from "@/components/attachments/image-prep";
import { AttachmentUploader } from "@/components/attachments/AttachmentUploader";
import { AttachmentGallery } from "@/components/attachments/AttachmentGallery";
import { ReceiptForm } from "@/components/finance/ReceiptForm";
import { QuoteToOrderForm } from "./QuoteToOrderForm";
import { PdfLink } from "@/components/features/PdfLink";
import type { QuickWork } from "./quick-types";
import { reopenHref } from "@/lib/maps/links";

/**
 * 予定表の小さな画面の「この案件で」(お客様のご要望 2026-11-25: 予定表 → 案件 → 見積書撮影・登録 → 受注登録 → 日程登録 → 資料登録 → 帳票出力 を画面を移らずに)
 * ② 手書きの見積書を撮影 → AI で読み取り → 見積の作成 (保存すると予定表に戻る)
 * ③④ 受注にする: 品目ごとの引取日・納品日 (施工日) を手書きの日時から入れた案で、直して受注と一緒に予定表に載せる (同じ品目を分けて納品も)
 * ⑤ 資料・写真: 種類 (現場図面・採寸図・現場の写真・施工前・施工後・資料) を選んでその場で撮影・登録、登録済みの図面に番号・線を書き込む
 * ⑥⑦⑧ 帳票: 見積書・請求書・領収書の出力 (出力の記録つき)、請求書の発行、領収書の内訳つきの発行・発行する / しない
 */

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

function Block({ title, icon, children, testId, defaultOpen = false, badge }: { title: string; icon: ReactNode; children: ReactNode; testId?: string; defaultOpen?: boolean; badge?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-line first:border-t-0" data-testid={testId}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-subtle/60">
        {icon}
        <span className="min-w-0 flex-1">{title}</span>
        {badge}
        <span className="text-[11px] font-normal text-accent">{open ? "閉じる" : "開く"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/**
 * ② 手書きの見積書を撮影 (スマートフォン・タブレットは端末のカメラ、ほかは写真・PDF を選ぶ)、または手入力で見積を作成
 * (お客様のご要望 2026-11-26「■1」: どこから見積作成に入っても 撮影・AI の読み取り / 手入力 の 2 通り。どちらも保存のあとこの予定表に戻る)
 */
function CaptureQuote({ eventId, returnTo, capture }: { eventId: string; returnTo: string; capture: NonNullable<QuickWork["capture"]> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const cam = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const manual = `/quotes/new?${new URLSearchParams({ ...(capture.customerId ? { customerId: capture.customerId } : {}), ...(capture.inquiryId ? { inquiryId: capture.inquiryId } : {}), ...(capture.caseId ? { caseId: capture.caseId } : {}), returnTo })}`;
  const send = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setError("");
    try {
      const p = await prepareFile(f);
      const fd = new FormData();
      fd.set("file", p.file, p.file.name);
      if (p.thumb) fd.set("thumb", p.thumb, "thumb.jpg");
      if (p.takenAt) fd.set("takenAt", p.takenAt);
      fd.set("returnTo", returnTo);
      fd.set("eventId", eventId);
      if (capture.inquiryId) fd.set("inquiryId", capture.inquiryId);
      if (capture.customerId) fd.set("customerId", capture.customerId);
      if (capture.caseId) fd.set("caseId", capture.caseId);
      start(async () => {
        await captureCaseQuote(fd);
      });
    } catch {
      setError("写真を読み込めませんでした。もう一度撮影してください。");
    } finally {
      if (cam.current) cam.current.value = "";
      if (pick.current) pick.current.value = "";
    }
  };
  return (
    <div className="px-3 py-2.5" data-testid="case-capture">
      {pending ? (
        <p className="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-xs font-medium text-accent-ink" aria-live="polite">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          見積書を AI で読み取っています (20〜40 秒)。終わると見積の作成の画面が開きます…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className={clsx(buttonClass("primary", "md"), "cursor-pointer")}>
            <Camera />
            手書きの見積書を撮影
            <input ref={cam} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => send(e.target.files)} />
          </label>
          <label className={clsx(buttonClass("secondary", "sm"), "cursor-pointer")}>
            <FileImage />
            写真・PDF を選ぶ
            <input ref={pick} type="file" accept="image/*,application/pdf,.pdf" className="sr-only" onChange={(e) => send(e.target.files)} />
          </label>
          <Link href={manual} className={buttonClass("secondary", "sm")} data-testid="case-quote-manual">
            <Keyboard />
            手入力で見積を作成
          </Link>
        </div>
      )}
      {capture.placeholder && (
        <p className="mb-1.5 rounded-lg bg-warn-soft px-3 py-2 text-[11px] leading-relaxed text-warn-ink" data-testid="case-capture-placeholder">
          この案件のお客様は予定表から仮に登録したお客様です (名字と地区だけ)。見積書を撮影すると、読み取ったお名前・電話・住所で「既存のお客様に紐付ける」か「新しいお客様として登録する」を選べます (住所が一致するお客様を先に出します)。そのあと見積・受注を登録すると、この予定にそのままつながります (予定は増えません)。
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">撮影すると AI が品名・数量・単価・引取日・納品日を読み取り (読めない行も空の行で残します)、この案件の見積の作成の画面を開きます。手入力はシステムの見積書の書式に直接入力します。どちらも保存すると、この予定表に戻ります。</p>
      {error && <p className="mt-1 text-[11px] text-critical-ink">{error}</p>}
    </div>
  );
}

export function CaseWorkSection({ work, eventId, returnTo: listReturn, onReload }: { work: QuickWork; eventId: string; returnTo: string; onReload: () => void }) {
  // 保存のあとは同じ予定の小さな画面を開き直す (結果 = 受注・領収書の印刷などをその場で続けられるように)
  const returnTo = reopenHref(listReturn, eventId);
  const t = work.toOrder;
  const docs = work.docs;
  const files = work.files;
  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-accent/30 bg-panel" data-testid="event-quick-work">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-3 py-1.5">
        <span className="text-xs font-semibold text-ink">この案件で</span>
        <span className="text-[11px] text-ink-3">{work.caseLabel}</span>
        <span className="ml-auto flex flex-wrap gap-2 text-[11px]">
          {work.quote && (
            <Link href={work.quote.href} className="text-accent hover:underline">
              見積 {work.quote.number} ({work.quote.status})
            </Link>
          )}
          {work.order && (
            <Link href={work.order.href} className="text-accent hover:underline">
              受注 {work.order.number} ({work.order.status})
            </Link>
          )}
        </span>
      </div>

      {work.capture &&
        (work.capture.additional ? (
          // 見積・受注のある案件の別の見積 (追加工事・別の案)。いつもは閉じておく
          <details className="border-b border-line" data-testid="case-capture-more">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-accent hover:bg-subtle/60">＋ この案件に別の見積を作る (追加工事・仕様や金額の違う案)</summary>
            <CaptureQuote eventId={eventId} returnTo={returnTo} capture={work.capture} />
          </details>
        ) : (
          <CaptureQuote eventId={eventId} returnTo={returnTo} capture={work.capture} />
        ))}

      {t && (
        <Block title={t.onsite ? "現場で受注にする (日程も一緒に登録)" : "受注にする (日程も一緒に登録)"} icon={<ClipboardCheck className="h-3.5 w-3.5 text-accent" aria-hidden />} testId="case-to-order" badge={<span className="text-[11px] font-normal text-ink-2 tnum">{yen(t.total)}</span>}>
          <QuoteToOrderForm plan={t} returnTo={returnTo} />
        </Block>
      )}
      {work.orderBlocked && <p className="border-t border-line px-3 py-2 text-[11px] text-ink-3">{work.orderBlocked}</p>}

      {files && (
        <Block title={`資料・写真 (図面・採寸図・施工前後)${files.items.length ? ` ${files.items.length + files.more} 件` : ""}`} icon={<ImagePlus className="h-3.5 w-3.5 text-accent" aria-hidden />} testId="case-files" defaultOpen>
          {files.canAdd && <AttachmentUploader parentType={files.parentType} parentId={files.parentId} accept={files.accept} categories onDone={onReload} note={`${files.parentLabel}に登録します。写真は自動で縮小します。登録済みの図面は写真を押して「書き込む」で番号・線を書けます。`} />}
          {files.items.length > 0 ? (
            <div className="mt-2">
              <AttachmentGallery items={files.items} deleteAction={deleteAttachment} returnTo={returnTo} onChanged={onReload} />
              {files.more > 0 && <p className="mt-1 text-[11px] text-ink-3">ほか {files.more} 件は案件の画面で見られます。</p>}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-ink-3">まだ登録されていません。</p>
          )}
        </Block>
      )}

      {docs && (
        <Block title="帳票 (見積書・納品書・請求書・領収書)" icon={<Printer className="h-3.5 w-3.5 text-accent" aria-hidden />} testId="case-docs">
          <div className="space-y-2.5 text-xs">
            <div className="flex flex-wrap gap-1.5">
              {docs.quote && docs.quote.canPrint && (
                <PdfLink href={`/api/pdf/quotes/${docs.quote.id}`} returnTo={returnTo} className={buttonClass("secondary", "sm")}>
                  <FileText />
                  見積書 {docs.quote.number}
                  {docs.quote.draft ? " (承認前)" : ""}
                  {docs.quote.outputs ? ` · 出力 ${docs.quote.outputs} 回` : ""}
                </PdfLink>
              )}
              {docs.delivery && docs.delivery.canPrint && (
                <PdfLink href={`/api/pdf/delivery/${docs.delivery.orderId}`} returnTo={returnTo} className={buttonClass("secondary", "sm")} testId="case-delivery-note">
                  <FileText />
                  納品書
                  {docs.delivery.outputs ? ` · 出力 ${docs.delivery.outputs} 回` : ""}
                </PdfLink>
              )}
              {docs.invoice && docs.invoice.canPrint && (
                <PdfLink href={`/api/pdf/invoices/${docs.invoice.id}`} returnTo={returnTo} className={buttonClass("secondary", "sm")}>
                  <FileText />
                  請求書 {docs.invoice.number} {yen(docs.invoice.total)}
                  {docs.invoice.outputs ? ` · 出力 ${docs.invoice.outputs} 回` : ""}
                </PdfLink>
              )}
            </div>
            {docs.invoiceIssue &&
              (docs.invoiceIssue.ok ? (
                <form action={issueCaseInvoice.bind(null, docs.invoiceIssue.orderId)} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <Button type="submit" size="sm" variant="secondary">
                    請求書を発行 ({yen(docs.invoiceIssue.total)})
                  </Button>
                  {docs.invoiceIssue.pre && <span className="text-[11px] text-ink-3">施工完了の前に発行します (納品・施工の日にお渡し。売上は施工完了の日)。</span>}
                </form>
              ) : (
                <p className="text-[11px] text-ink-3">
                  請求書は未発行です{docs.invoiceIssue.reason ? ` (${docs.invoiceIssue.reason})` : ""}。
                  {docs.invoiceIssue.needsSetup && (
                    <a href={`/orders/${docs.invoiceIssue.orderId}?returnTo=${encodeURIComponent(returnTo)}#work-staff`} className="ml-1 font-medium text-accent underline">
                      作業の担当・ポスティングを登録する
                    </a>
                  )}
                </p>
              ))}
            {docs.receipt && (
              <div className="space-y-1.5 rounded-lg border border-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ReceiptIcon className="h-3.5 w-3.5 text-ink-3" aria-hidden />
                  <span className="font-semibold text-ink">領収書</span>
                  <span className={docs.receipt.wanted ? "text-good-ink" : "text-ink-3"}>{docs.receipt.wanted ? "発行する" : "発行しない"}</span>
                  <span className="text-[11px] text-ink-3">({docs.receipt.reason})</span>
                  {docs.receipt.canSetWanted && (
                    <form action={setReceiptWanted.bind(null, docs.receipt.orderId)} className="ml-auto flex items-center gap-1">
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <select name="wanted" defaultValue={docs.receipt.auto ? "" : docs.receipt.wanted ? "1" : "0"} className="field h-8 w-auto py-0.5 text-xs" aria-label="領収書を発行するか">
                        <option value="">自動 (支払方法から)</option>
                        <option value="1">発行する</option>
                        <option value="0">発行しない</option>
                      </select>
                      <button type="submit" className="rounded px-1.5 py-1 text-[11px] text-accent hover:bg-accent-soft">
                        変える
                      </button>
                    </form>
                  )}
                </div>
                {docs.receipt.checks.map((c) => (
                  <p key={c.text} className={c.tone === "warn" ? "text-[11px] text-warn-ink" : "text-[11px] text-ink-2"}>
                    {c.tone === "warn" ? "⚠ " : ""}
                    {c.text}
                  </p>
                ))}
                {docs.receipt.issued.length > 0 && (
                  <ul className="space-y-1">
                    {docs.receipt.issued.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{r.number}</span>
                        <span className="tnum">{yen(r.amount)}</span>
                        <span className="text-ink-3">{r.parts}</span>
                        {r.status === "void" ? (
                          <span className="text-critical-ink">取り消し</span>
                        ) : (
                          <PdfLink href={`/api/pdf/receipts/${r.id}`} returnTo={returnTo} className={clsx(buttonClass(r.outputs ? "secondary" : "primary", "sm"), "ml-auto")}>
                            <Printer />
                            {r.outputs ? `再発行 (${r.outputs + 1} 回目)` : "印刷"}
                          </PdfLink>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {docs.receipt.form ? (
                  <ReceiptForm {...docs.receipt.form} returnTo={returnTo} today={new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })} compact />
                ) : (
                  !docs.invoice && <p className="text-[11px] text-ink-3">請求書を発行すると、領収書を発行できます。</p>
                )}
                {docs.invoice && (
                  <Link href={`${docs.invoice.href}#receipts`} className="inline-flex text-[11px] text-accent hover:underline">
                    領収書の取り消し・入金の記録・出力の記録は請求書の画面で
                  </Link>
                )}
              </div>
            )}
            <Link href={docs.batchHref} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline">
              <Printer className="h-3.5 w-3.5" aria-hidden />
              この日の請求書・領収書をまとめて印刷
            </Link>
          </div>
        </Block>
      )}
    </div>
  );
}
