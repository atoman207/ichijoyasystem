"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Ban, CheckCircle2, Trash2, TriangleAlert } from "lucide-react";
import { deleteCustomer } from "@/lib/actions/customers";
import { Badge, Button, buttonClass, Card, CardHeader } from "@/components/ui";
import { SearchBox, useSearch } from "@/components/features/LinkSearch";
import type { CustomerHit } from "@/lib/link-search";

/** 削除の理由の候補 */
const CUSTOMER_DELETE_REASONS = ["二重に登録", "誤って登録", "練習・テストの登録"] as const;

/** 残すほうのお客様の候補 (重複の可能性がある顧客・検索の結果) */
export interface MergeCandidate {
  id: string;
  code: string;
  name: string;
  address?: string;
  phone?: string;
  storeName: string;
  /** 重複の理由 (電話番号が同じ など) */
  note?: string;
}

/**
 * 顧客の削除 (二重に登録した・誤って登録したお客様。お客様のご要望 2026-11-27)。顧客の画面の「重複の可能性がある顧客」の下 (#delete)。
 * 売上の紐付いたお客様は理由を出して削除させない。記録があれば「残すほうのお客様」を選び、記録を移してから削除する。
 * 押すと「本当に削除しますか？」の確認 → src/lib/actions/customers.ts の deleteCustomer (店長以上はすぐに削除・店舗スタッフは店長の承認)
 */
export function DeleteCustomerCard({
  customer,
  mode,
  blockers,
  records,
  candidates,
  pending,
}: {
  customer: { id: string; code: string; name: string; address?: string; phone?: string };
  /** direct = すぐに削除 (店長以上) / request = 店長の承認で削除 (店舗スタッフ) */
  mode: "direct" | "request";
  /** 削除できない理由 (売上・請求書など) */
  blockers: string[];
  /** 統合先に移す記録 */
  records: { label: string; count: number }[];
  candidates: MergeCandidate[];
  /** 承認待ちの削除の申請 (申請した人・統合先) */
  pending?: string;
}) {
  const needsTarget = records.length > 0;
  const [target, setTarget] = useState<MergeCandidate | undefined>(candidates.length === 1 && needsTarget ? candidates[0] : undefined);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(CUSTOMER_DELETE_REASONS[0]);
  const s = useSearch<CustomerHit>("/api/customers/search");
  const hits = s.items.filter((h) => h.id !== customer.id);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const recordText = records.map((r) => `${r.label} ${r.count} 件`).join("・");
  const blocked = blockers.length > 0;

  return (
    <Card id="delete" className={clsx(blocked ? "border-line" : "border-critical/30")}>
      <CardHeader
        title="このお客様を削除する (二重登録・誤登録)"
        icon={<Trash2 />}
        description={
          blocked
            ? "売上が紐付いているお客様は削除できません。"
            : needsTarget
              ? "同じお客様を二重に登録したときは、残すほうのお客様を選ぶと、このお客様の記録をすべて移してから削除します。"
              : "誤って登録したお客様を削除します。このお客様には問い合わせ・見積・受注・予定などの記録はありません。"
        }
      />
      {blocked ? (
        <div className="rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2" data-testid="customer-delete-blocked">
          <p className="flex items-center gap-1.5 font-medium text-ink">
            <Ban className="h-4 w-4 text-ink-3" aria-hidden />
            このお客様は削除できません
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="mt-1 text-ink-3">二重に登録したお客様の売上を移したいときは、本部・管理者にご相談ください。</p>
        </div>
      ) : pending ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{pending}</p>
      ) : (
        <div className="space-y-3">
          {needsTarget && (
            <div className="space-y-2">
              <p className="text-xs text-ink-2">
                このお客様の記録: <span className="font-medium text-ink">{recordText}</span>
              </p>
              <fieldset className="space-y-1.5">
                <legend className="label">残すほうのお客様 (記録の移し先)</legend>
                {candidates.length > 0 && (
                  <ul className="space-y-1.5">
                    {candidates.map((c) => (
                      <CandidateRow key={c.id} c={c} selected={target?.id === c.id} onPick={() => setTarget(c)} />
                    ))}
                  </ul>
                )}
                <div className="pt-1">
                  <SearchBox value={s.q} onChange={s.setQ} busy={s.busy} label="残すほうのお客様を検索" placeholder="ほかのお客様を検索 (お名前・フリガナ・住所・電話番号)" />
                  {s.error && <p className="mt-1 text-xs text-critical-ink">{s.error}</p>}
                  {s.q.trim() && !s.busy && hits.length === 0 && !s.error && <p className="mt-1 text-xs text-ink-3">「{s.q.trim()}」に当たるお客様はいません。</p>}
                  {hits.length > 0 && (
                    <ul className="mt-1.5 max-h-64 space-y-1.5 overflow-y-auto">
                      {hits.map((h) => {
                        const c: MergeCandidate = { id: h.id, code: h.code, name: h.name, address: h.address, phone: h.phone, storeName: h.storeName };
                        return <CandidateRow key={h.id} c={c} selected={target?.id === h.id} onPick={() => setTarget(c)} />;
                      })}
                    </ul>
                  )}
                </div>
              </fieldset>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={needsTarget && !target}
              className={clsx(buttonClass("secondary", "sm"), "text-critical-ink hover:bg-critical-soft disabled:opacity-50")}
              data-testid="customer-delete-open"
            >
              <Trash2 className="h-4 w-4 text-critical" aria-hidden />
              {needsTarget ? (target ? `記録を ${target.name} 様に移して削除` : "残すほうのお客様を選んでください") : mode === "direct" ? "このお客様を削除" : "削除を申請"}
            </button>
            {mode === "request" && <span className="text-xs text-ink-3">店長の承認のあとに削除されます</span>}
          </div>
        </div>
      )}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
            <button type="button" tabIndex={-1} aria-label="閉じる" className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
            <div role="alertdialog" aria-modal="true" aria-labelledby={`del-cust-${customer.id}`} className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-line bg-panel p-4 shadow-pop sm:rounded-2xl" data-testid="customer-delete-confirm">
              <p id={`del-cust-${customer.id}`} className="flex items-center gap-2 text-base font-semibold text-critical-ink">
                <TriangleAlert className="h-5 w-5" aria-hidden />
                本当に削除しますか？
              </p>
              <div className="mt-2 rounded-lg bg-subtle px-3 py-2 text-sm">
                <div className="text-xs text-ink-3">削除するお客様</div>
                <div className="font-medium text-ink">
                  {customer.name} 様 <span className="font-mono text-xs text-ink-3">{customer.code}</span>
                </div>
                <div className="text-xs text-ink-3">{[customer.address, customer.phone].filter(Boolean).join(" · ") || "住所・電話の登録なし"}</div>
              </div>
              {target && needsTarget && (
                <div className="mt-2 rounded-lg border border-good/40 bg-good-soft/40 px-3 py-2 text-sm">
                  <div className="text-xs text-ink-3">残すお客様 (記録の移し先)</div>
                  <div className="font-medium text-ink">
                    {target.name} 様 <span className="font-mono text-xs text-ink-3">{target.code}</span>
                  </div>
                  <div className="text-xs text-ink-3">{[target.address, target.phone, target.storeName].filter(Boolean).join(" · ")}</div>
                </div>
              )}
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-ink-2">
                {needsTarget && target ? (
                  <>
                    <li className="font-medium text-ink">
                      このお客様の記録 ({recordText}) を {target.name} 様に移してから、このお客様の登録を削除します。
                    </li>
                    <li>電話番号 ({target.name} 様にない番号) は {target.name} 様の「ほかの電話番号」に、メモ・タグも {target.name} 様に追加します。お名前・住所は {target.name} 様の登録のままです。</li>
                  </>
                ) : (
                  <li>このお客様の登録を削除します。顧客の一覧・検索に出なくなります。</li>
                )}
                <li>削除した人・日時・理由と、削除の前の登録内容は変更履歴に残ります。</li>
                {mode === "request" && <li className="font-medium text-ink">店長の承認のあとに削除されます (それまでは一覧に残ります)。</li>}
              </ul>
              <form action={deleteCustomer.bind(null, customer.id)} className="mt-3 space-y-2">
                {target && needsTarget && <input type="hidden" name="targetId" value={target.id} />}
                <fieldset>
                  <legend className="label">削除の理由</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {[...CUSTOMER_DELETE_REASONS, "その他"].map((r) => (
                      <label key={r} className={clsx("cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs", choice === r ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line text-ink-2")}>
                        <input type="radio" name="reasonChoice" value={r === "その他" ? "" : r} checked={choice === r} onChange={() => setChoice(r)} className="sr-only" />
                        {r}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <input name="reason" maxLength={150} required={choice === "その他"} placeholder={choice === "その他" ? "理由を入れてください" : "補足 (任意。例: C-01234 と同じお客様)"} className="field" aria-label="削除の理由の補足" />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button type="submit" variant="danger" size="sm" data-testid="customer-delete-submit">
                    {mode === "direct" ? (needsTarget ? "記録を移して削除する" : "削除する") : "削除を申請する (店長の承認)"}
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
    </Card>
  );
}

function CandidateRow({ c, selected, onPick }: { c: MergeCandidate; selected: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        className={clsx("flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs", selected ? "border-good bg-good-soft/50" : "border-line bg-panel hover:bg-subtle")}
      >
        <CheckCircle2 className={clsx("mt-0.5 h-4 w-4 shrink-0", selected ? "text-good" : "text-ink-3/50")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium text-ink">{c.name} 様</span>
            <span className="font-mono text-ink-3">{c.code}</span>
            {selected && <Badge tone="good" dot={false}>残す</Badge>}
          </span>
          <span className="block text-ink-2">{c.address || "住所未登録"}</span>
          <span className="block text-ink-3">
            {c.phone || "電話未登録"} · {c.storeName}
            {c.note ? ` · ${c.note}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}
