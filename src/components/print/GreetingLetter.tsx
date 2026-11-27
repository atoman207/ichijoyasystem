"use client";

import { useState } from "react";
import Link from "@/components/ui/Link";
import { Printer } from "lucide-react";
import type { GreetingDraft } from "@/lib/greeting";
import { IchijoyaMark } from "@/components/brand/Logo";

/**
 * 近隣挨拶文 (お客様のご要望 2026-11-27「■3」)。上 = 直す欄 (印刷しない) / 下 = A4 縦の挨拶文 (印刷する)。
 * 顧客名・担当者名・工事日程は案件から入れた値で、どれも直せる。保存はしない (開くたびに案件から作る)
 */

const GREEN = "#2f7d32";

export function GreetingLetter({ draft, backHref }: { draft: GreetingDraft; backHref: string }) {
  const [d, setD] = useState(draft);
  const set = <K extends keyof GreetingDraft>(k: K, v: GreetingDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setCo = (k: keyof GreetingDraft["company"], v: string) => setD((x) => ({ ...x, company: { ...x.company, [k]: v } }));
  const lines = d.lines.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bubble = d.bubble.replace(/\{担当\}/g, d.staff || "　　");
  const field = "field h-9 py-1 text-sm";
  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <style>{"@page { size: A4 portrait; margin: 12mm; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }"}</style>

      {/* 直す欄 (印刷しない) */}
      <div className="mx-auto mb-4 w-[210mm] max-w-full space-y-3 rounded-2xl border border-line bg-panel p-4 shadow-card print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={backHref} className="text-sm text-ink-2 hover:text-ink">
            ← 案件に戻る
          </Link>
          <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
            <Printer className="h-4 w-4" />
            印刷 / PDF 保存
          </button>
        </div>
        <p className="text-xs text-ink-3">案件の情報から入れています。直してから印刷してください (この画面の変更は保存されません。もう一度開くと案件の情報から作り直します)。</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] text-ink-3">表題</span>
            <input value={d.title} onChange={(e) => set("title", e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-3">顧客名 (「様邸」の前)</span>
            <input value={d.customer} onChange={(e) => set("customer", e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-3">工事予定日</span>
            <input value={d.dates} onChange={(e) => set("dates", e.target.value)} placeholder="例: 12月20日（火）・12月22日（木）" className={field} />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-3">予定時間</span>
            <input value={d.time} onChange={(e) => set("time", e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-3">工事の種類 (「…を行わせていただきます」)</span>
            <input value={d.work} onChange={(e) => set("work", e.target.value)} className={field} />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-3">担当者名</span>
            <input value={d.staff} onChange={(e) => set("staff", e.target.value)} className={field} />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[11px] text-ink-3">工事日程 (1 行 1 件)</span>
            <textarea value={d.lines} onChange={(e) => set("lines", e.target.value)} rows={4} className="field py-1.5 text-sm" placeholder="例: 12/20　クロス張替え（終日）" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[11px] text-ink-3">お願いの文</span>
            <textarea value={d.body} onChange={(e) => set("body", e.target.value)} rows={3} className="field py-1.5 text-sm" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[11px] text-ink-3">担当者のあいさつ ({"{担当}"} = 担当者名)</span>
            <input value={d.bubble} onChange={(e) => set("bubble", e.target.value)} className={field} />
          </label>
          <details className="sm:col-span-2">
            <summary className="cursor-pointer text-xs text-accent">会社の情報を直す</summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input value={d.company.name} onChange={(e) => setCo("name", e.target.value)} className={field} aria-label="会社名" />
              <input value={d.company.postalCode} onChange={(e) => setCo("postalCode", e.target.value)} className={field} aria-label="郵便番号" />
              <input value={d.company.address} onChange={(e) => setCo("address", e.target.value)} className={field} aria-label="住所" />
              <input value={d.company.tel} onChange={(e) => setCo("tel", e.target.value)} className={field} aria-label="電話" />
              <textarea value={d.company.services} onChange={(e) => setCo("services", e.target.value)} rows={2} className="field py-1.5 text-sm sm:col-span-2" aria-label="取り扱い" />
            </div>
          </details>
        </div>
      </div>

      {/* 挨拶文 (A4 縦) */}
      <article className="mx-auto flex min-h-[273mm] w-[186mm] max-w-full flex-col bg-white px-[10mm] py-[10mm] text-[#1f2a24] shadow print:min-h-[262mm] print:w-auto print:px-0 print:py-0 print:shadow-none" style={{ fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif' }}>
        <header className="text-center">
          <p className="text-[11pt] tracking-[0.3em] text-[#4b5a50]">近隣の皆様へ</p>
          <h1 className="mt-2 text-[34pt] leading-tight font-bold tracking-[0.12em]" style={{ color: GREEN }}>
            {d.title}
          </h1>
          <div className="mx-auto mt-3 h-[3px] w-24 rounded-full" style={{ background: GREEN }} />
        </header>

        <section className="mt-8 rounded-xl border-2 px-6 py-5 text-center" style={{ borderColor: GREEN }}>
          <p className="text-[12pt] tracking-[0.5em] text-[#4b5a50]">工事予定日</p>
          <p className="mt-2 text-[23pt] font-bold tracking-wide">{d.dates || "　"}</p>
          <p className="mt-3 inline-block rounded-md border border-dashed border-[#4b5a50] px-4 py-1 text-[14pt]">
            予定時間　<span className="font-bold tracking-wide">{d.time}</span>
          </p>
        </section>

        <section className="mt-8 space-y-4 text-[14.5pt] leading-[1.9]">
          <p>
            上記の予定期間で、<span className="mx-1 border-b border-[#1f2a24] px-2 font-bold">{d.customer || "　　　　"}</span>様邸にて
            <br />
            {d.work || "工事"}を行わせていただきます。
          </p>
          {lines.length > 0 && (
            <ul className="rounded-lg bg-[#f3f8f1] px-5 py-3 text-[13.5pt] leading-[2]">
              {lines.map((l, i) => (
                <li key={i} className="flex gap-2">
                  <span style={{ color: GREEN }}>●</span>
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12.5pt] leading-[2]">{d.body}</p>
        </section>

        <div className="mt-auto flex items-end justify-between gap-6 pt-8">
          <div className="relative max-w-[95mm] rounded-2xl border-2 px-4 py-3 text-[12pt] leading-[1.8]" style={{ borderColor: GREEN }}>
            {bubble}
            <span className="absolute -bottom-[9px] right-10 h-4 w-4 rotate-45 border-r-2 border-b-2 bg-white" style={{ borderColor: GREEN }} aria-hidden />
          </div>
          <div className="shrink-0 text-right text-[10.5pt] leading-[1.7]">
            <div className="mb-1 flex items-center justify-end gap-2">
              <IchijoyaMark className="h-10 w-10" />
              <span className="text-[15pt] font-bold tracking-wider">{d.company.name}</span>
            </div>
            {d.company.postalCode && <div>〒{d.company.postalCode.replace(/^(\d{3})(\d{4})$/, "$1-$2")}</div>}
            <div>{d.company.address}</div>
            {d.company.tel && <div>TEL　{d.company.tel}</div>}
            <div className="mt-2 text-[9.5pt] whitespace-pre-line text-[#4b5a50]">{d.company.services}</div>
          </div>
        </div>
      </article>
    </div>
  );
}
