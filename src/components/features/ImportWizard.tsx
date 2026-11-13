"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "@/components/ui/Link";
import { FileSpreadsheet, Link2, Upload } from "lucide-react";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { IMPORT_MAX_ROWS, IMPORT_SPEC, type ImportTarget } from "@/lib/data-io-spec";
import type { ImportReport, ImportOptions, RowStatus } from "@/lib/data-io";
import { commitImport, loadSheet, previewImport } from "@/lib/actions/data-io";

const STATUS: Record<RowStatus, { label: string; cls: string }> = {
  create: { label: "新規登録", cls: "bg-good-soft text-good-ink" },
  update: { label: "更新", cls: "bg-info-soft text-info-ink" },
  unchanged: { label: "変更なし・登録済み", cls: "bg-neutral-soft text-ink-2" },
  duplicate: { label: "重複の可能性", cls: "bg-warn-soft text-warn-ink" },
  error: { label: "エラー", cls: "bg-critical-soft text-critical-ink" },
};
const SHOW = 300;

/** CSV ファイル・Google スプレッドシートからの取込 (確認 → 実行) */
export function ImportWizard() {
  const [target, setTarget] = useState<ImportTarget>("customers");
  const [source, setSource] = useState<"file" | "sheet">("file");
  const [sheetUrl, setSheetUrl] = useState("");
  const [table, setTable] = useState<string[][] | null>(null);
  const [label, setLabel] = useState("");
  const [info, setInfo] = useState("");
  const [mode, setMode] = useState<ImportOptions["mode"]>("fill");
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<RowStatus | "all">("all");
  const [pending, start] = useTransition();

  const opts = { mode, allowDuplicates, sourceLabel: label };
  const reset = () => {
    setReport(null);
    setError("");
    setFilter("all");
  };
  const loaded = (t: string[][], l: string, i: string) => {
    setTable(t);
    setLabel(l);
    setInfo(i);
    reset();
  };

  async function onFile(f: File | undefined) {
    reset();
    setTable(null);
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return setError("ファイルが大きすぎます (4 MB まで)。ファイルを分けて取り込んでください。");
    const { text, encoding } = decodeCsv(new Uint8Array(await f.arrayBuffer()));
    const t = parseCsv(text);
    if (t.length < 2) return setError("見出しの行とデータの行がある CSV を選んでください。");
    loaded(t, `CSV ${f.name}`, `${f.name} · ${t.length - 1} 行 · 文字コード ${encoding}`);
  }

  function onSheet() {
    reset();
    start(async () => {
      const r = await loadSheet(sheetUrl);
      if (!r.ok) return setError(r.error);
      if (r.data.table.length < 2) return setError("シートに見出しの行とデータの行がありません。");
      loaded(r.data.table, r.data.label, `${r.data.label} · ${r.data.table.length - 1} 行`);
    });
  }

  function onPreview() {
    if (!table) return;
    setError("");
    start(async () => {
      const r = await previewImport(target, table, opts);
      if (!r.ok) return setError(r.error);
      setReport(r.data);
      setFilter("all");
    });
  }

  function onCommit() {
    if (!table || !report) return;
    start(async () => {
      const r = await commitImport(target, table, opts);
      if (!r.ok) return setError(r.error);
      setReport(r.data);
      setFilter("all");
    });
  }

  const rows = useMemo(() => (report ? report.rows.filter((r) => filter === "all" || r.status === filter) : []), [report, filter]);
  const doable = report ? report.counts.create + report.counts.update : 0;

  return (
    <div className="space-y-5">
      {/* 1. 取り込むデータと読み込み元 */}
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <fieldset>
          <legend className="label">取り込むデータ</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(IMPORT_SPEC) as ImportTarget[]).map((t) => (
              <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${target === t ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel"}`}>
                <input type="radio" name="target" value={t} checked={target === t} onChange={() => { setTarget(t); reset(); }} className="sr-only" />
                {IMPORT_SPEC[t].label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">{IMPORT_SPEC[target].description}</p>
        </fieldset>
        <fieldset>
          <legend className="label">読み込み元</legend>
          <div className="flex flex-wrap gap-2">
            <label className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${source === "file" ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel"}`}>
              <input type="radio" name="source" checked={source === "file"} onChange={() => setSource("file")} className="sr-only" />
              <Upload className="h-4 w-4" aria-hidden />CSV ファイル
            </label>
            <label className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${source === "sheet" ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel"}`}>
              <input type="radio" name="source" checked={source === "sheet"} onChange={() => setSource("sheet")} className="sr-only" />
              <FileSpreadsheet className="h-4 w-4" aria-hidden />Google スプレッドシート
            </label>
          </div>
          {source === "file" ? (
            <div className="mt-2">
              <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-accent-ink" data-testid="import-file" />
              <p className="mt-1 text-[11px] text-ink-3">UTF-8 / Shift_JIS (Excel の「CSV」保存) のどちらでも読めます。{IMPORT_MAX_ROWS.toLocaleString()} 行まで。</p>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" className="field min-w-0 flex-1 basis-64" aria-label="スプレッドシートの URL" />
              <button type="button" onClick={onSheet} disabled={pending || !sheetUrl.trim()} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-panel px-4 text-sm font-medium hover:bg-subtle disabled:opacity-50"><Link2 className="h-4 w-4" aria-hidden />読み込む</button>
              <p className="w-full text-[11px] text-ink-3">シートの共有設定を「リンクを知っている全員 (閲覧者)」にして、ブラウザのアドレス欄の URL を貼り付けます。開いているシート (gid) を読み込みます。</p>
            </div>
          )}
        </fieldset>
      </div>

      {table && (
        <div className="rounded-xl border border-line bg-subtle/50 p-3 text-xs">
          <div className="font-medium text-ink">読み込んだ表: {info}</div>
          <div className="mt-1 text-ink-3">見出し: {table[0].filter(Boolean).join(" / ")}</div>
        </div>
      )}

      {/* 2. 取込の方法 */}
      {table && target === "customers" && (
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          <fieldset className="rounded-xl border border-line p-3">
            <legend className="px-1 text-xs font-medium text-ink-2">既存の顧客 (顧客コードが一致する行) の更新</legend>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="mode" checked={mode === "fill"} onChange={() => { setMode("fill"); reset(); }} className="mt-1" /><span>空欄の項目だけ補う (おすすめ)<span className="block text-[11px] text-ink-3">登録済みの電話・住所などは変更しません</span></span></label>
            <label className="mt-2 flex items-start gap-2 text-sm"><input type="radio" name="mode" checked={mode === "overwrite"} onChange={() => { setMode("overwrite"); reset(); }} className="mt-1" /><span>入力のある項目で上書きする<span className="block text-[11px] text-ink-3">区分・担当店舗・希望連絡手段も変更します</span></span></label>
          </fieldset>
          <label className="flex items-start gap-2 rounded-xl border border-line p-3 text-sm">
            <input type="checkbox" checked={allowDuplicates} onChange={(e) => { setAllowDuplicates(e.target.checked); reset(); }} className="mt-1" />
            <span>重複の可能性がある行も新規に登録する<span className="block text-[11px] text-ink-3">確認の結果「重複の可能性」になった行を、別のお客様として登録します。確認が済んでいる場合だけチェックしてください</span></span>
          </label>
        </div>
      )}

      {error && <p role="alert" className="rounded-xl bg-critical-soft px-4 py-3 text-sm text-critical-ink">{error}</p>}

      {table && !report?.committed && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onPreview} disabled={pending} className="inline-flex h-10 items-center rounded-xl border border-line bg-panel px-5 text-sm font-medium hover:bg-subtle disabled:opacity-50">{pending && !report ? "確認しています…" : "内容を確認する"}</button>
          {report && (
            <button type="button" onClick={onCommit} disabled={pending || doable === 0 || report.missing.length > 0} className="inline-flex h-10 items-center rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
              {pending ? "取り込んでいます…" : `取り込む (新規 ${report.counts.create} 件・更新 ${report.counts.update} 件)`}
            </button>
          )}
        </div>
      )}

      {/* 3. 確認・結果 */}
      {report && (
        <div className="space-y-3" data-testid="import-report">
          {report.committed && <p className="rounded-xl bg-good-soft px-4 py-3 text-sm text-good-ink">取り込みました: 新規 {report.counts.create} 件・更新 {report.counts.update} 件。変更履歴に「取込」として記録しました。</p>}
          {report.missing.length > 0 && <p className="rounded-xl bg-critical-soft px-4 py-3 text-sm text-critical-ink">取り込めません: {report.missing.join("、")} の見出しがありません。ひな形の見出しに合わせてください。</p>}
          <div className="text-xs text-ink-2">
            <span className="font-medium text-ink">読み取った見出し:</span> {report.matched.map((m) => (m.header === m.column ? m.column : `${m.header} → ${m.column}`)).join(" / ") || "なし"}
            {report.ignored.length > 0 && <span className="text-ink-3"> · 取り込まない列: {report.ignored.join(" / ")}</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setFilter("all")} className={`rounded-full px-3 py-1 text-xs ${filter === "all" ? "bg-ink text-white" : "bg-subtle text-ink-2"}`}>すべて {report.total}</button>
            {(Object.keys(STATUS) as RowStatus[]).filter((s) => report.counts[s] > 0).map((s) => (
              <button key={s} type="button" onClick={() => setFilter(s)} className={`rounded-full px-3 py-1 text-xs ${filter === s ? "ring-2 ring-ink/40" : ""} ${STATUS[s].cls}`}>{STATUS[s].label} {report.counts[s]}</button>
            ))}
          </div>
          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[560px] text-xs">
                <thead><tr className="bg-subtle text-left text-ink-2"><th className="px-3 py-2 font-medium">行</th><th className="px-3 py-2 font-medium">判定</th><th className="px-3 py-2 font-medium">内容</th><th className="px-3 py-2 font-medium">説明</th></tr></thead>
                <tbody>
                  {rows.slice(0, SHOW).map((r) => (
                    <tr key={r.row} className="border-t border-line align-top">
                      <td className="px-3 py-1.5 tnum text-ink-3">{r.row}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                      <td className="px-3 py-1.5 text-ink">{r.href ? <Link href={r.href} className="text-accent hover:underline">{r.label}</Link> : r.label}</td>
                      <td className="px-3 py-1.5 text-ink-2">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > SHOW && <p className="border-t border-line px-3 py-2 text-xs text-ink-3">ほか {rows.length - SHOW} 行 (判定で絞り込むと確認できます)</p>}
            </div>
          )}
          {report.committed && (
            <button type="button" onClick={() => { setTable(null); setReport(null); setInfo(""); }} className="text-sm text-accent hover:underline">続けて別のファイルを取り込む</button>
          )}
        </div>
      )}
    </div>
  );
}
