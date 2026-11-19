"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, LoaderCircle, Play, Square } from "lucide-react";
import { buttonClass } from "@/components/ui";

interface Job {
  id: string;
  kind: "normalize" | "pdf_import";
  dryRun: boolean;
  status: "running" | "done" | "cancelled";
  cursor: number;
  total: number;
  counts: Record<string, number>;
  folder?: string;
}

/**
 * 地図の一括処理の実行 (1 回分ずつ /api/maps/batch を呼び、終わるまで繰り返す)。
 * 途中で画面を閉じても、次に「続ける」で続きから再開できる
 */
export function BatchRunner({ current, folders, labels }: { current?: Job; folders: { name: string; pdfs: number; manifest: boolean }[]; labels: Record<string, string> }) {
  const router = useRouter();
  const [job, setJob] = useState<Job | undefined>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stop, setStop] = useState(false);

  async function call(body: Record<string, unknown>): Promise<Job> {
    const res = await fetch("/api/maps/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const r = (await res.json().catch(() => null)) as { ok: boolean; error?: string; job?: Job } | null;
    if (!r?.ok || !r.job) throw new Error(r?.error ?? "一括処理に失敗しました。");
    return r.job;
  }

  async function run(start?: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setStop(false);
    try {
      let j = start ? await call({ action: "start", ...start }) : job!;
      setJob(j);
      let guard = 0;
      while (j.status === "running" && guard++ < 5000) {
        if (stopRef.stop) break;
        j = await call({ action: "step", jobId: j.id });
        setJob(j);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      stopRef.stop = false;
    }
  }

  async function cancel() {
    if (!job) return;
    setBusy(true);
    try {
      const j = await call({ action: "cancel", jobId: job.id });
      setJob(j);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const running = job?.status === "running";
  const pct = job && job.total ? Math.round((job.cursor / job.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {job && (
        <div className="space-y-2 rounded-xl border border-line p-3 text-xs" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 font-medium text-ink">
            {job.kind === "normalize" ? "住所の正規化" : `住宅地図の一括取込 (${job.folder})`}
            {job.dryRun && <span className="rounded-full bg-info-soft px-2 py-0.5 text-info-ink">試し (書き込みなし)</span>}
            <span className="text-ink-3">{job.status === "running" ? "処理中" : job.status === "done" ? "完了" : "取り消し"}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div className="tnum text-ink-2">
            {job.cursor.toLocaleString()} / {job.total.toLocaleString()} 件 ({pct}%)
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            {Object.entries(job.counts).map(([k, v]) => (
              <li key={k}>
                {labels[k] ?? k}: <span className="tnum font-medium text-ink">{v.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {running && !busy && (
              <button type="button" className={buttonClass("primary", "sm")} onClick={() => void run()}>
                <Play />
                続ける
              </button>
            )}
            {running && busy && (
              <button type="button" className={buttonClass("secondary", "sm")} onClick={() => ((stopRef.stop = true), setStop(true))} disabled={stop}>
                <Square />
                {stop ? "止めています…" : "一時停止"}
              </button>
            )}
            {running && !busy && (
              <button type="button" className={buttonClass("danger", "sm")} onClick={() => void cancel()}>
                取り消す
              </button>
            )}
            {job.status !== "running" && (
              <a href={`/api/maps/batch/report?job=${job.id}`} className={buttonClass("secondary", "sm")}>
                報告 (CSV) をダウンロード
              </a>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-critical-ink" role="alert">
          <CircleAlert className="mt-px h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      <form
        className="space-y-2 rounded-xl border border-line p-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void run({ kind: "normalize", dryRun: fd.get("mode") !== "run", includeOrders: fd.get("includeOrders") === "1" });
        }}
      >
        <div className="font-semibold text-ink">① 顧客の住所の正規化 (場所の作成)</div>
        <p className="text-ink-3">元の住所の文字は変えません。番地まである住所だけを場所にし、同じ番地の記録は 1 つの場所を共有します。番地のない住所は「要確認」として報告します。</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="includeOrders" value="1" /> 進行中の受注の施工場所 (お客様の住所と違うもの) も含める
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mode" value="dry" defaultChecked /> 試し (書き込まずに報告だけ)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mode" value="run" /> 実行する
          </label>
        </div>
        <button type="submit" disabled={busy || running} className={buttonClass("primary", "sm")}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
          開始
        </button>
      </form>

      <form
        className="space-y-2 rounded-xl border border-line p-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void run({
            kind: "pdf_import",
            folder: String(fd.get("folder") ?? ""),
            dryRun: fd.get("mode") !== "run",
            shareable: fd.get("shareable") === "1",
            provider: fd.get("provider") === "other" ? "other" : "zenrin",
            copyrightNotice: String(fd.get("copyrightNotice") ?? ""),
            licenseRef: String(fd.get("licenseRef") ?? ""),
            licenseConfirmed: fd.get("licenseConfirmed") === "1",
          });
        }}
      >
        <div className="font-semibold text-ink">② 住宅地図の PDF の一括取込</div>
        <p className="text-ink-3">サーバーの取込フォルダーに置いた PDF を、manifest.csv (file, customer_code / customer_id / order_number / order_id / address) またはファイル名 (C-01234.pdf / O-2026-0012.pdf) で記録に結び付けます。ゼンリンから自動でダウンロードはしません。</p>
        {folders.length === 0 ? (
          <p className="text-warn-ink">取込フォルダーに PDF のフォルダーがありません。</p>
        ) : (
          <label className="block">
            <span className="label">フォルダー</span>
            <select name="folder" className="field mt-1" required>
              {folders.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} (PDF {f.pdfs} 件{f.manifest ? "・manifest.csv あり" : ""})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
          <label className="block">
            <span className="label">提供元</span>
            <select name="provider" className="field mt-1">
              <option value="zenrin">ゼンリン 住宅地図</option>
              <option value="other">その他の地図</option>
            </select>
          </label>
          <label className="block">
            <span className="label">著作権表示</span>
            <input name="copyrightNotice" defaultValue="© ZENRIN CO., LTD." maxLength={200} className="field mt-1" />
          </label>
          <label className="block">
            <span className="label">契約・許諾の番号 (任意)</span>
            <input name="licenseRef" maxLength={100} className="field mt-1" />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="shareable" value="1" /> 同じ PDF を複数の場所で共用してよい (契約で認められているとき)
        </label>
        <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft/60 p-2 text-warn-ink">
          <input type="checkbox" name="licenseConfirmed" value="1" className="mt-0.5" />
          <span>これらの PDF は、契約で「社内サーバーへの保存」と「社内の複数人での閲覧」が認められています (実行するときに必要)。</span>
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mode" value="dry" defaultChecked /> 試し (書き込まずに報告だけ)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mode" value="run" /> 実行する
          </label>
        </div>
        <button type="submit" disabled={busy || running || folders.length === 0} className={buttonClass("primary", "sm")}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
          開始
        </button>
      </form>
    </div>
  );
}

/** 一時停止の合図 (ループの中から読むため、再描画を待たない) */
const stopRef = { stop: false };
