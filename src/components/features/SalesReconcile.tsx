"use client";

import { useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";
import { applySalesReconcile, previewSalesReconcile, type SalesReconcilePreview } from "@/lib/actions/sales-ledger";

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/**
 * 売上台帳 (店舗別の xlsx) と販売管理ソフトの売上明細で二重になった受注をまとめる (src/lib/sales-reconcile.ts)。
 * 「確認する」で組と年ごとの売上の変化を見てから、同じ内容のときだけ「この内容でまとめる」
 */
export function SalesReconcile() {
  const [preview, setPreview] = useState<SalesReconcilePreview | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [pending, start] = useTransition();

  const check = () =>
    start(async () => {
      setError("");
      setDone("");
      const r = await previewSalesReconcile();
      if (!r.ok) return setError(r.error);
      setPreview(r.data);
    });
  const apply = () =>
    start(async () => {
      if (!preview) return;
      setError("");
      const r = await applySalesReconcile(preview.hash);
      if (!r.ok) return setError(r.error);
      setPreview(null);
      setDone(r.data.pairs ? `${r.data.pairs} 組をまとめました (受注 ${r.data.ordersRemoved} 件を売上台帳の受注へ。お客様の統合 ${r.data.customersMerged})。` : "まとめる組はありませんでした。");
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs leading-relaxed text-ink-3">
        売上台帳から移行した受注と、販売管理ソフトの伝票から作った受注のうち、同じ売上が 2 件になっているもの (台帳の日付が月末にまとめてある・字体や会社名の書き方の違い・税込と税抜の扱いの違いで照合から漏れたもの) を見つけて 1 件にします。
        台帳の受注の店舗・金額 (台帳の月の集計と同じ) を残し、伝票の明細・施工担当・お客様の情報を移します。確認の段階ではデータは変わりません。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("secondary", "sm")} disabled={pending} onClick={check}>
          {pending && !preview ? "確認しています…" : "確認する"}
        </button>
        {preview && preview.pairs > 0 && (
          <button type="button" className={buttonClass("primary", "sm")} disabled={pending} onClick={apply}>
            {pending ? "まとめています…" : "この内容でまとめる"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-critical-ink" role="alert">{error}</p>}
      {done && <p className="text-xs text-good-ink" role="status">{done}</p>}
      {preview && (
        <div className="space-y-2">
          <p className="text-xs text-ink-2">
            {preview.pairs ? `${preview.pairs} 組 (伝票の受注 ${preview.ordersRemoved} 件・${yen(preview.amountRemoved)}) をまとめます。売上の合計は、二重だった分だけ減ります。` : "まとめる組はありません (二重になった受注は見つかりませんでした)。"}
          </p>
          {preview.years.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead>
                  <tr className="bg-subtle text-left text-ink-2">
                    <th className="px-3 py-1.5 font-medium">年</th>
                    <th className="px-3 py-1.5 text-right font-medium">組</th>
                    <th className="px-3 py-1.5 text-right font-medium">売上 (今)</th>
                    <th className="px-3 py-1.5 text-right font-medium">まとめたあと</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.years.map((y) => (
                    <tr key={y.year} className="border-t border-line">
                      <td className="px-3 py-1">{y.year}</td>
                      <td className="px-3 py-1 text-right">{y.pairs}</td>
                      <td className="px-3 py-1 text-right">{yen(y.before)}</td>
                      <td className="px-3 py-1 text-right font-medium">{yen(y.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.samples.length > 0 && (
            <details className="rounded-lg border border-line p-2">
              <summary className="cursor-pointer text-xs font-medium text-ink-2">組の例 (新しい月から {preview.samples.length} 組)</summary>
              <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-2">
                {preview.samples.map((s, i) => (
                  <li key={i}>
                    <span className="font-medium text-ink">{s.month}</span> 台帳: {s.ledger} ／ 伝票: {s.slips}
                    <span className="block text-ink-3">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
