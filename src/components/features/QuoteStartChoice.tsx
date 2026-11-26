"use client";

import { useState, type ReactNode } from "react";
import { Camera, Keyboard } from "lucide-react";

export type QuoteMethod = "photo" | "manual";

/**
 * 見積の作成の始め方 (お客様のご要望 2026-11-26「■1」: どの画面から「見積作成」に入っても 2 通りで登録できるように)
 * - 手書きの見積書を撮影して AI で読み取る (撮影 → 読み取り → 同じ画面に読み取った明細を入れて開き直す)
 * - 手入力で作成する (システムの見積書の書式に直接入力)
 * 手入力の欄は撮影を選んでいるあいだも消さずに隠すだけ (途中まで入れた内容が残る)
 */
export function QuoteStartChoice({ photo, manual, initial = "manual" }: { photo: ReactNode; manual: ReactNode; initial?: QuoteMethod }) {
  const [method, setMethod] = useState<QuoteMethod>(initial);
  const options: { value: QuoteMethod; title: string; desc: string; icon: ReactNode }[] = [
    { value: "photo", title: "手書きの見積書を撮影して AI で読み取る", desc: "現場で書いた見積書を撮影すると、明細 (品名・数量・単価)・お客様・引取日時などを読み取って見積の欄に入れます", icon: <Camera className="h-5 w-5" aria-hidden /> },
    { value: "manual", title: "手入力で作成する", desc: "システムの見積書の書式に、明細を直接入力します", icon: <Keyboard className="h-5 w-5" aria-hidden /> },
  ];
  return (
    <div className="@container">
      <div role="radiogroup" aria-label="見積の登録の方法" className="mb-4 grid grid-cols-1 gap-2 @xl:grid-cols-2" data-testid="quote-method">
        {options.map((o) => {
          const on = method === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMethod(o.value)}
              className={`flex min-h-11 items-start gap-3 rounded-2xl border px-4 py-3 text-left transition ${on ? "border-accent bg-accent-soft/60 ring-1 ring-accent" : "border-line bg-panel hover:bg-subtle"}`}
            >
              <span className={`mt-0.5 shrink-0 ${on ? "text-accent" : "text-ink-3"}`}>{o.icon}</span>
              <span className="min-w-0">
                <span className={`block text-sm font-semibold ${on ? "text-accent-ink" : "text-ink"}`}>{o.title}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-3">{o.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
      {method === "photo" && <div data-testid="quote-method-photo">{photo}</div>}
      <div hidden={method !== "manual"} data-testid="quote-method-manual">
        {manual}
      </div>
    </div>
  );
}
