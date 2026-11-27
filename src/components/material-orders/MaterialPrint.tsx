"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import { buttonClass } from "@/components/ui";
import type { PrintSheet } from "@/lib/material-orders/print-sheet";

export type { PrintSheet };

/**
 * 材料発注の画面から、案件の見積の内容・現場図面などをその場で印刷する (お客様のご要望 2026-11-27
 * 「材料発注画面から、該当案件の見積内容と現場図面を…別の画面に移動することなく直接印刷」)。
 * 「印刷」→ 画面の上に印刷の内容 (選べる) を出し →「印刷する」でブラウザーの印刷 (この内容だけを印刷する)。
 * 写真はそのまま、PDF の図面はページごとの画像 (/api/attachments/<ID>/page) にして 1 回で印刷する。
 * 内容はサーバーが作った PrintSheet (src/lib/material-orders/print-sheet.ts の printSheetOf)
 */

const ROOT_ID = "mo-print-root";

/** 印刷のときは、この画面 (印刷の内容) だけを出す */
const PRINT_CSS = `
@media print {
  body > *:not(#${ROOT_ID}) { display: none !important; }
  html, body { background: #fff !important; overflow: visible !important; height: auto !important; }
  #${ROOT_ID} { position: static !important; inset: auto !important; display: block !important; overflow: visible !important; background: #fff !important; padding: 0 !important; }
  #${ROOT_ID} .mo-no-print { display: none !important; }
  #${ROOT_ID} .mo-sheet { box-shadow: none !important; border: 0 !important; max-width: none !important; width: auto !important; margin: 0 !important; padding: 0 !important; border-radius: 0 !important; }
  #${ROOT_ID} .mo-page { break-before: page; page-break-before: always; }
  #${ROOT_ID} .mo-keep { break-inside: avoid; page-break-inside: avoid; }
  #${ROOT_ID} img { max-width: 100% !important; }
  @page { size: A4 portrait; margin: 10mm; }
}
`;

export function MaterialPrintButton({ sheet, label = "見積・図面を印刷", className }: { sheet: PrintSheet; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? `${buttonClass("secondary", "sm")} gap-1`} data-testid="material-print">
        <Printer className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>
      {open && <PrintDialog sheet={sheet} onClose={() => setOpen(false)} />}
    </>
  );
}

function PrintDialog({ sheet, onClose }: { sheet: PrintSheet; onClose: () => void }) {
  const [withQuote, setWithQuote] = useState(Boolean(sheet.quote));
  const [withPrices, setWithPrices] = useState(false);
  const [withMaterials, setWithMaterials] = useState(sheet.materials.length > 0);
  const [fileOn, setFileOn] = useState<Record<string, boolean>>(() => Object.fromEntries(sheet.files.filter((f) => f.kind !== "other").map((f) => [f.id, true])));
  const [pdfPages, setPdfPages] = useState<Record<string, number | "error">>({});
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const [waiting, setWaiting] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // PDF の図面のページ数 (ページごとの画像にして印刷する)
  useEffect(() => {
    let alive = true;
    for (const f of sheet.files.filter((x) => x.kind === "pdf")) {
      fetch(`/api/attachments/${encodeURIComponent(f.id)}/page?info=1`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: { pages: number }) => alive && setPdfPages((m) => ({ ...m, [f.id]: Math.max(0, Number(j.pages) || 0) })))
        .catch(() => alive && setPdfPages((m) => ({ ...m, [f.id]: "error" })));
    }
    return () => {
      alive = false;
    };
  }, [sheet.files]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // 印刷する画像 (写真・PDF のページ)。読み込みが終わってから印刷する (読み込み前の画像は白く印刷されるため)
  const images = useMemo(() => {
    const out: { key: string; src: string; label: string; name: string; page?: number; pages?: number }[] = [];
    for (const f of sheet.files) {
      if (!fileOn[f.id]) continue;
      if (f.kind === "image") out.push({ key: f.id, src: `/api/attachments/${encodeURIComponent(f.id)}`, label: f.label, name: f.name });
      if (f.kind === "pdf" && typeof pdfPages[f.id] === "number") {
        const n = pdfPages[f.id] as number;
        for (let p = 1; p <= n; p++) out.push({ key: `${f.id}:${p}`, src: `/api/attachments/${encodeURIComponent(f.id)}/page?p=${p}`, label: f.label, name: f.name, page: p, pages: n });
      }
    }
    return out;
  }, [sheet.files, fileOn, pdfPages]);
  const pdfWaiting = sheet.files.some((f) => f.kind === "pdf" && fileOn[f.id] && pdfPages[f.id] === undefined);
  const pending = images.filter((i) => !loaded.has(i.key)).length + (pdfWaiting ? 1 : 0);
  const done = (key: string) => setLoaded((s) => (s.has(key) ? s : new Set(s).add(key)));

  // 「印刷する」を押したあと、画像の読み込みを待ってから印刷する
  useEffect(() => {
    if (!waiting || pending > 0) return;
    const t = setTimeout(() => {
      setWaiting(false);
      window.print();
    }, 150);
    return () => clearTimeout(t);
  }, [waiting, pending]);

  const nothing = !withQuote && !withMaterials && !images.length;
  const check = "h-4 w-4 shrink-0";
  return createPortal(
    <div id={ROOT_ID} className="fixed inset-0 z-[90] overflow-y-auto bg-black/50 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="印刷の内容" data-testid="material-print-dialog">
      <style>{PRINT_CSS}</style>
      <div className="mo-sheet mx-auto w-full max-w-3xl rounded-none bg-white text-black shadow-pop sm:rounded-2xl">
        <div className="mo-no-print sticky top-0 z-10 space-y-2 rounded-none border-b border-line bg-panel p-3 sm:rounded-t-2xl">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-semibold text-ink">印刷する内容を選んでください</p>
            <button type="button" ref={closeRef} onClick={onClose} className="rounded-lg p-1.5 text-ink-2 hover:bg-subtle" aria-label="閉じる">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-ink">
            {sheet.quote && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className={check} checked={withQuote} onChange={(e) => setWithQuote(e.target.checked)} />
                見積の内容
              </label>
            )}
            {sheet.quote && withQuote && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className={check} checked={withPrices} onChange={(e) => setWithPrices(e.target.checked)} />
                単価・金額も入れる
              </label>
            )}
            {sheet.materials.length > 0 && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className={check} checked={withMaterials} onChange={(e) => setWithMaterials(e.target.checked)} />
                発注する材料
              </label>
            )}
            {sheet.files.filter((f) => f.kind !== "other").map((f) => (
              <label key={f.id} className="flex items-center gap-1.5">
                <input type="checkbox" className={check} checked={Boolean(fileOn[f.id])} onChange={(e) => setFileOn((m) => ({ ...m, [f.id]: e.target.checked }))} />
                {f.label}
                <span className="max-w-[10rem] truncate text-[11px] text-ink-3">{f.name}</span>
                {pdfPages[f.id] === "error" && <span className="text-[11px] text-warn-ink">(画像にできないため印刷できません)</span>}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setWaiting(true)} disabled={nothing || waiting} className={`${buttonClass("primary", "md")} gap-1.5`} data-testid="material-print-go">
              <Printer className="h-4 w-4" aria-hidden />
              {waiting && pending > 0 ? `画像を読み込んでいます (残り ${pending})…` : "印刷する"}
            </button>
            {waiting && pending > 0 && (
              <button type="button" onClick={() => { setWaiting(false); window.print(); }} className="text-xs text-accent hover:underline">
                待たずに印刷する
              </button>
            )}
            <span className="text-[11px] text-ink-3">下の内容をそのまま印刷します (A4 縦)。図面・写真は 1 枚ずつ新しいページになります</span>
          </div>
        </div>

        <div className="space-y-4 p-4 text-[13px] leading-relaxed sm:p-6">
          <header className="mo-keep border-b border-black/30 pb-2">
            <h1 className="text-lg font-bold">{sheet.title}</h1>
            {sheet.lines.map((l) => (
              <p key={l} className="text-xs">
                {l}
              </p>
            ))}
          </header>

          {sheet.quote && withQuote && (
            <section className="mo-keep">
              <h2 className="mb-1 text-sm font-bold">見積の内容 {sheet.quote.number}</h2>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-black/40 text-left">
                    <th className="py-1 pr-2">品名</th>
                    <th className="py-1 pr-2">仕様</th>
                    <th className="py-1 pr-2 text-right">数量</th>
                    {withPrices && <th className="py-1 pr-2 text-right">単価</th>}
                    {withPrices && <th className="py-1 text-right">金額</th>}
                  </tr>
                </thead>
                <tbody>
                  {sheet.quote.items.map((it, i) => (
                    <tr key={i} className="border-b border-black/15 align-top">
                      <td className="py-1 pr-2">{it.name}</td>
                      <td className="py-1 pr-2">{it.spec}</td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">
                        {it.qty}
                        {it.unit}
                      </td>
                      {withPrices && <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{it.unitPrice}</td>}
                      {withPrices && <td className="whitespace-nowrap py-1 text-right tabular-nums">{it.amount}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {withPrices && <p className="mt-1 text-right text-xs font-semibold">{sheet.quote.totals}</p>}
              {sheet.quote.site.length > 0 && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {sheet.quote.site.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-semibold">{k}</dt>
                      <dd className="whitespace-pre-wrap">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {sheet.quote.notes && <p className="mt-1 whitespace-pre-wrap text-xs">備考: {sheet.quote.notes}</p>}
            </section>
          )}

          {withMaterials && sheet.materials.length > 0 && (
            <section className="mo-keep">
              <h2 className="mb-1 text-sm font-bold">発注する材料</h2>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-black/40 text-left">
                    <th className="py-1 pr-2">状況</th>
                    <th className="py-1 pr-2">材料・品番</th>
                    <th className="py-1 pr-2 text-right">数量</th>
                    <th className="py-1 pr-2">必要な日</th>
                    <th className="py-1">発注先・メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.materials.map((m, i) => (
                    <tr key={i} className="border-b border-black/15 align-top">
                      <td className="whitespace-nowrap py-1 pr-2">{m.status}{m.orderedBy ? ` (${m.orderedBy})` : ""}</td>
                      <td className="py-1 pr-2">
                        {m.name}
                        {m.code ? ` ${m.code}` : ""}
                        {m.spec ? <span className="block text-[11px]">{m.spec}</span> : null}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{m.qty}</td>
                      <td className="whitespace-nowrap py-1 pr-2">{m.need ?? ""}</td>
                      <td className="py-1">{m.supplier ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {images.map((im, i) => (
            <figure key={im.key} className={`${i > 0 || withQuote || withMaterials ? "mo-page" : ""} mo-keep`}>
              <figcaption className="mb-1 text-xs font-semibold">
                {im.label}
                {im.pages && im.pages > 1 ? ` (${im.page} / ${im.pages} ページ)` : ""} <span className="font-normal">{im.name}</span> — {sheet.title}
              </figcaption>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={im.src} alt={`${im.label} ${im.name}`} onLoad={() => done(im.key)} onError={() => done(im.key)} className="mx-auto max-h-[250mm] w-auto max-w-full object-contain" />
            </figure>
          ))}
          {nothing && <p className="mo-no-print text-sm text-ink-3">印刷する内容を選んでください。</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
