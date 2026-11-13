"use client";

import { useState, useTransition } from "react";
import { decodeCsv } from "@/lib/csv";
import { parseSalesCsv, type SalesImportReport, type SalesSlip } from "@/lib/sales-ledger";
import { importSalesSlips, salesLedgerFingerprints } from "@/lib/actions/sales-ledger";

/** 1 回に送る量 (Server Actions の上限 4.5 MB より小さく) */
const CHUNK_BYTES = 3_000_000;

type Preview = { fileName: string; encoding: string; rows: number; repaired: number; skipped: { line: number; reason: string }[]; total: number; added: SalesSlip[]; changed: SalesSlip[]; latest: string };

const SUM_KEYS = ["customersCreated", "customersUpdated", "customersMerged", "ordersCreated", "ordersUpdated", "ordersLinked", "storeByDefault", "taxExcluded"] as const;

/** 得意先ごとのまとまりを崩さずに、送る量で分ける (同じ得意先・同じ日の伝票は一緒に照合するため) */
function chunks(slips: SalesSlip[]): SalesSlip[][] {
  const byCustomer = new Map<string, SalesSlip[]>();
  for (const s of slips) {
    const list = byCustomer.get(s.customerCode);
    if (list) list.push(s);
    else byCustomer.set(s.customerCode, [s]);
  }
  const out: SalesSlip[][] = [];
  let cur: SalesSlip[] = [];
  let size = 0;
  for (const group of byCustomer.values()) {
    const bytes = new Blob([JSON.stringify(group)]).size;
    if (cur.length && size + bytes > CHUNK_BYTES) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(...group);
    size += bytes;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 販売管理ソフトの「売上明細」CSV を取り込む (追加・変更された伝票だけを反映) */
export function SalesLedgerImport() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<SalesImportReport | null>(null);
  const [pending, start] = useTransition();

  async function onFile(f: File | undefined) {
    setPreview(null);
    setResult(null);
    setError("");
    if (!f) return;
    setProgress("CSV を読み込んでいます…");
    try {
      const { text, encoding } = decodeCsv(new Uint8Array(await f.arrayBuffer()));
      const parsed = parseSalesCsv(text);
      const fp = await salesLedgerFingerprints();
      if (!fp.ok) throw new Error(fp.error);
      const added = parsed.slips.filter((s) => !(s.no in fp.data));
      const changed = parsed.slips.filter((s) => s.no in fp.data && fp.data[s.no] !== s.fingerprint);
      const latest = parsed.slips.reduce((a, s) => (s.date > a ? s.date : a), "");
      setPreview({ fileName: f.name, encoding, rows: parsed.rows, repaired: parsed.repaired, skipped: parsed.skipped, total: parsed.slips.length, added, changed, latest });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress("");
    }
  }

  function onCommit() {
    if (!preview) return;
    const parts = chunks([...preview.added, ...preview.changed]);
    setError("");
    start(async () => {
      const sum: SalesImportReport = { slips: 0, unchanged: 0, customersCreated: 0, customersUpdated: 0, customersMerged: 0, ordersCreated: 0, ordersUpdated: 0, ordersLinked: 0, storeByDefault: 0, staffMatched: [], staffUnmatched: [], taxExcluded: 0 };
      for (let i = 0; i < parts.length; i++) {
        setProgress(`取り込んでいます… (${i + 1}/${parts.length})`);
        const r = await importSalesSlips(parts[i], { fileName: preview.fileName, part: i + 1, parts: parts.length });
        if (!r.ok) {
          setProgress("");
          setError(`${r.error}${i > 0 ? ` (${i}/${parts.length} まで反映済み。同じファイルをもう一度選ぶと残りを取り込みます)` : ""}`);
          return;
        }
        sum.slips += r.data.slips;
        for (const k of SUM_KEYS) sum[k] += r.data[k];
        sum.staffUnmatched = [...new Set([...sum.staffUnmatched, ...r.data.staffUnmatched])];
      }
      setProgress("");
      setResult(sum);
      setPreview(null);
    });
  }

  const todo = preview ? preview.added.length + preview.changed.length : 0;

  return (
    <div className="space-y-4">
      <div>
        <input type="file" accept=".csv,text/csv" disabled={pending} onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-accent-ink" data-testid="sales-ledger-file" />
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">販売管理ソフトから書き出した「売上明細」の CSV (Shift_JIS のままで可)。全期間のファイルを毎回選んでかまいません。前回から追加・変更された伝票だけを反映します。</p>
      </div>

      {progress && <p className="text-sm text-ink-2" role="status">{progress}</p>}
      {error && <p role="alert" className="rounded-xl bg-critical-soft px-4 py-3 text-sm text-critical-ink">{error}</p>}

      {preview && (
        <div className="space-y-3" data-testid="sales-ledger-preview">
          <div className="rounded-xl border border-line bg-subtle/50 p-3 text-xs leading-relaxed text-ink-2">
            <div className="font-medium text-ink">{preview.fileName} · 文字コード {preview.encoding}</div>
            <div>
              {preview.rows.toLocaleString()} 行 → 伝票 {preview.total.toLocaleString()} 枚 (最新の売上日 {preview.latest || "-"})
              {preview.repaired > 0 && ` · 列のずれを補正 ${preview.repaired.toLocaleString()} 行`}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-good-soft px-2.5 py-0.5 text-good-ink">追加 {preview.added.length.toLocaleString()}</span>
              <span className="rounded-full bg-info-soft px-2.5 py-0.5 text-info-ink">変更 {preview.changed.length.toLocaleString()}</span>
              <span className="rounded-full bg-neutral-soft px-2.5 py-0.5 text-ink-2">取込済み {(preview.total - todo).toLocaleString()}</span>
            </div>
            {preview.skipped.length > 0 && (
              <div className="mt-1 text-warn-ink">
                読み取れない行 {preview.skipped.length} 行 (取り込みません): {preview.skipped.slice(0, 5).map((s) => `${s.line} 行目`).join("、")}
                {preview.skipped.length > 5 && " ほか"}
              </div>
            )}
          </div>
          <button type="button" onClick={onCommit} disabled={pending || todo === 0} className="inline-flex h-10 items-center rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {todo === 0 ? "新しい伝票はありません" : pending ? "取り込んでいます…" : `取り込む (伝票 ${todo.toLocaleString()} 枚)`}
          </button>
        </div>
      )}

      {result && (
        <div className="rounded-xl bg-good-soft px-4 py-3 text-sm leading-relaxed text-good-ink" data-testid="sales-ledger-result">
          <div className="font-medium">取り込みました (伝票 {result.slips.toLocaleString()} 枚)。変更履歴に「取込」として記録しました。</div>
          <div className="text-xs">
            顧客: 新規 {result.customersCreated}・更新 {result.customersUpdated}・売上台帳の顧客を統合 {result.customersMerged} / 受注: 新規 {result.ordersCreated}・更新 {result.ordersUpdated}・売上台帳の受注にひも付け {result.ordersLinked}
            {result.taxExcluded > 0 && ` / 税抜の伝票を税込に換算 ${result.taxExcluded}`}
            {result.storeByDefault > 0 && ` / 店舗を判定できず本社扱い ${result.storeByDefault}`}
          </div>
          {result.staffUnmatched.length > 0 && <div className="mt-1 text-xs">社員に登録のない担当者 (経過メモに氏名を残しました): {result.staffUnmatched.join("、")}</div>}
        </div>
      )}
    </div>
  );
}
