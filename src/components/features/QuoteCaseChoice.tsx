"use client";

import { useEffect, useRef, useState } from "react";
import type { CaseOption } from "@/lib/case-choice";
import { loadCustomerCases } from "@/lib/actions/inquiries";
import { CaseChoice } from "@/components/inquiries/CaseChoice";

type Cases = { open: CaseOption[]; past: CaseOption[]; pastTotal: number } | null;

/**
 * 見積の作成の画面で、案件を決めずに開いたとき (ヘッダーの「新規」・見積の一覧・お客様の画面・撮影した見積書から) の
 * 「どの案件の見積か」(お客様のご要望 2026-11-26「① 二重登録の防止」: 問い合わせ・顧客・案件・予定表のどこから見積を登録しても、同じ案件の予定にひも付ける)。
 * 同じフォームの「お客様」(select name=customerId) を選ぶたびに、そのお客様の進行中の案件と最近の完了した案件を読む (loadCustomerCases。お客様ごとに 1 回)。
 * 進行中の案件が 1 件ならその案件を最初から選ぶ (src/components/inquiries/InquiryForm.tsx と同じ)。送る値は hidden の caseId ("new" = 新しい案件)。
 * createQuote が quoteLinkForCase でつなぐ
 */
export function QuoteCaseChoice({ initialCustomerId, initialCustomerName }: { initialCustomerId?: string; initialCustomerName?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [customer, setCustomer] = useState<{ id: string; name: string } | undefined>(initialCustomerId ? { id: initialCustomerId, name: initialCustomerName ?? "" } : undefined);
  const [cases, setCases] = useState<Record<string, Cases>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});

  // 同じフォームのお客様の選択を見る (外のフォームの部品の変更を受け取る)
  useEffect(() => {
    const select = ref.current?.closest("form")?.querySelector<HTMLSelectElement>('select[name="customerId"]');
    if (!select) return;
    const read = () => {
      const id = select.value;
      // 候補の表示は「お名前 (顧客コード) · 住所」(src/lib/duplicates.ts の customerOptionLabel)
      const name = (select.selectedOptions[0]?.textContent ?? "").replace(/\s*\([^)]*\).*$/, "").trim();
      setCustomer(id ? { id, name } : undefined);
    };
    select.addEventListener("change", read);
    return () => select.removeEventListener("change", read);
  }, []);

  const customerId = customer?.id ?? "";
  // 選んだお客様の案件を読む
  useEffect(() => {
    if (!customerId || cases[customerId] !== undefined) return;
    let live = true;
    loadCustomerCases(customerId)
      .then((r) => live && setCases((m) => ({ ...m, [customerId]: r })))
      .catch(() => live && setCases((m) => ({ ...m, [customerId]: null })));
    return () => {
      live = false;
    };
  }, [customerId, cases]);

  const loaded = customerId ? cases[customerId] : undefined;
  const loading = Boolean(customerId) && loaded === undefined;
  const suggestedId = loaded && loaded.open.length === 1 && loaded.open[0].canAdd ? loaded.open[0].id : undefined;
  const raw = customerId ? (choices[customerId] ?? suggestedId ?? "new") : "new";
  const value = loaded && (raw === "new" || [...loaded.open, ...loaded.past].some((c) => c.id === raw && c.canAdd)) ? raw : "new";
  const hasCases = Boolean(loaded && (loaded.open.length > 0 || loaded.past.length > 0));

  return (
    <div ref={ref} data-testid="quote-case-choice">
      {loading && (
        <>
          <input type="hidden" name="caseId" value="new" />
          <p className="text-xs text-ink-3">お客様の案件を確かめています…</p>
        </>
      )}
      {!loading && hasCases && loaded && (
        <CaseChoice
          value={value}
          onChange={(v) => setChoices((m) => ({ ...m, [customerId]: v }))}
          open={loaded.open}
          past={loaded.past}
          pastTotal={loaded.pastTotal}
          customerName={customer?.name || "このお客様"}
          suggestedId={suggestedId}
          what="見積"
        />
      )}
      {!loading && !hasCases && <input type="hidden" name="caseId" value="new" />}
    </div>
  );
}
