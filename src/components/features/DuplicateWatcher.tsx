"use client";

import { useEffect, useRef, useState } from "react";
import Link from "@/components/ui/Link";
import { TriangleAlert, Users } from "lucide-react";
import type { DuplicateReport } from "@/lib/actions/customers";
import type { DuplicateInput } from "@/lib/duplicates";

const FIELDS = ["name", "kana", "phone", "email", "postalCode", "address"] as const;
const LEVEL_LABEL = { high: "重複の可能性が高い", check: "要確認", name: "氏名が同じ" } as const;

/**
 * 既存顧客との重複確認 (顧客の登録・編集フォームの中に置く)
 * - 入力が止まって 0.5 秒後に、全店舗の既存顧客と照合して候補を表示する
 * - 新規登録で確認が必要な候補 (電話・メール・氏名と住所の一致、同じ姓と地区) があるときは、
 *   「確認したうえで新規に登録する」にチェックするまで送信しない (入力内容は消えない)
 */
export function DuplicateWatcher({
  check,
  excludeId,
  requireConfirm,
  fields,
  hint,
}: {
  check: (input: DuplicateInput, excludeId?: string) => Promise<DuplicateReport>;
  excludeId?: string;
  requireConfirm: boolean;
  /** フォームの項目名が違うとき (例: 問い合わせの contactName → name) */
  fields?: Partial<Record<(typeof FIELDS)[number], string>>;
  /** 候補があるときに添える説明 */
  hint?: string;
}) {
  const names = FIELDS.map((k) => fields?.[k] ?? k);
  const ref = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<DuplicateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [warn, setWarn] = useState(false);
  // 送信時の判定で最新の照合結果を読むため (送信のハンドラは effect の中で一度だけ登録する)
  const reportRef = useRef<DuplicateReport | null>(null);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let last = "";
    const read = (): DuplicateInput => {
      const fd = new FormData(form);
      return Object.fromEntries(FIELDS.map((k) => [k, String(fd.get(fields?.[k] ?? k) ?? "")])) as unknown as DuplicateInput;
    };
    const run = async () => {
      const input = read();
      const key = JSON.stringify(input);
      if (key === last) return;
      last = key;
      if (!input.name.trim() && !input.phone?.trim() && !input.email?.trim()) {
        setReport(null);
        return;
      }
      const my = ++seq;
      setChecking(true);
      try {
        const r = await check(input, excludeId);
        if (my === seq) setReport(r);
      } catch {
        // 照合できなくても入力は続けられる (登録時にサーバーでも確認する)
      } finally {
        if (my === seq) setChecking(false);
      }
    };
    const onInput = (e: Event) => {
      const t = e.target as HTMLInputElement | null;
      if (!t || !names.includes(t.name)) return;
      clearTimeout(timer);
      timer = setTimeout(run, 500);
    };
    const onSubmit = (e: SubmitEvent) => {
      const r = reportRef.current;
      if (requireConfirm && r?.blocking && !confirmRef.current?.checked) {
        e.preventDefault();
        setWarn(true);
        confirmRef.current?.focus();
        ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    form.addEventListener("input", onInput);
    form.addEventListener("submit", onSubmit);
    // 編集画面・入力済みの値で開いたときも照合する
    timer = setTimeout(run, 100);
    return () => {
      clearTimeout(timer);
      form.removeEventListener("input", onInput);
      form.removeEventListener("submit", onSubmit);
    };
    // names は fields から作るので、fields が変わらない限り同じ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check, excludeId, requireConfirm, JSON.stringify(fields)]);

  const rows = report?.rows ?? [];
  const important = rows.filter((r) => r.level !== "name");
  const sameNames = rows.filter((r) => r.level === "name");
  return (
    <div ref={ref} aria-live="polite" data-testid="duplicate-check">
      {checking && !report && <p className="text-xs text-ink-3">既存の顧客と照合しています…</p>}
      {report && important.length === 0 && sameNames.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-good-ink"><Users className="h-3.5 w-3.5" aria-hidden />既存の顧客 (全店舗) に重複の候補はありません。</p>
      )}
      {(important.length > 0 || sameNames.length > 0) && (
        <div className={`rounded-xl border p-3 text-xs ${important.length ? "border-warn/50 bg-warn-soft/50" : "border-line bg-subtle/60"}`}>
          <div className="mb-2 flex items-center gap-1.5 font-semibold text-ink">
            <TriangleAlert className={`h-4 w-4 ${important.length ? "text-warn-ink" : "text-ink-3"}`} aria-hidden />
            {important.length ? "既存の顧客と重複している可能性があります" : "同じ氏名の顧客がいます (参考)"}
          </div>
          <ul className="space-y-1">
            {[...important, ...sameNames].map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${r.level === "high" ? "bg-critical-soft text-critical-ink" : r.level === "check" ? "bg-warn-soft text-warn-ink" : "bg-neutral-soft text-ink-2"}`}>{LEVEL_LABEL[r.level]}</span>
                {r.href ? (
                  <Link href={r.href} target="_blank" className="font-medium text-accent hover:underline">{r.code} {r.name}</Link>
                ) : (
                  <span className="font-medium text-ink">{r.code} {r.name}</span>
                )}
                <span className="text-ink-3">{r.storeName}{r.area ? ` · 地区 ${r.area}` : ""} · {r.reasons.join("・")}{!r.href ? " · 他店舗の顧客のため詳細は店舗に確認してください" : ""}</span>
              </li>
            ))}
          </ul>
          {report && report.sameNameTotal > sameNames.length && <p className="mt-1 text-ink-3">ほかに同じ氏名の顧客が {report.sameNameTotal - sameNames.length} 件あります。</p>}
          {hint && <p className="mt-2 text-ink-2">{hint}</p>}
          {requireConfirm && report?.blocking && (
            <label className={`mt-3 flex items-start gap-2 rounded-lg bg-panel px-3 py-2 text-sm text-ink ${warn ? "ring-2 ring-critical/50" : ""}`}>
              <input ref={confirmRef} type="checkbox" name="confirmDuplicate" value="1" className="mt-0.5 h-4 w-4" onChange={() => setWarn(false)} />
              <span>
                確認したうえで新規に登録する
                <span className="block text-[11px] text-ink-3">同じお客様の場合は登録せず、上の既存の顧客を開いて情報を更新してください。</span>
              </span>
            </label>
          )}
          {warn && <p role="alert" className="mt-2 text-critical-ink">重複の候補を確認し、チェックを入れてから登録してください。</p>}
        </div>
      )}
    </div>
  );
}
