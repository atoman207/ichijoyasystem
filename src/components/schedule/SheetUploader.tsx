"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui";

type Result = { name: string; ok: boolean; text: string };

/**
 * 予定表の月のファイル (.xlsx) を選んで読み込む (1 つずつ /api/schedule/sheet-import へ送る)。
 * 終わったら照合の画面 (/schedule/import?batch=…) を開く
 */
export function SheetUploader({ batch, from }: { batch?: string; from?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [drag, setDrag] = useState(false);
  /** 読み込めなかったファイルがあったときの、読み込めた分の照合の画面 */
  const [partial, setPartial] = useState<string | null>(null);
  const open = (id: string) => {
    router.push(`/schedule/import?batch=${id}${from ? `&from=${from}` : ""}`);
    router.refresh();
  };

  async function upload(files: File[]) {
    const list = files.filter((f) => f.size > 0);
    if (!list.length) return;
    let id = batch;
    const out: Result[] = [];
    setPartial(null);
    for (const f of list) {
      setBusy(`${f.name} を読み込んでいます…`);
      const fd = new FormData();
      fd.set("file", f);
      if (id) fd.set("batch", id);
      try {
        const res = await fetch("/api/schedule/sheet-import", { method: "POST", body: fd });
        const j = (await res.json().catch(() => ({}))) as { batch?: string; label?: string; days?: number; events?: number; error?: string; problems?: string[] };
        if (!res.ok || !j.batch) out.push({ name: f.name, ok: false, text: j.error ?? `読み込めませんでした (${res.status})` });
        else {
          id = j.batch;
          out.push({ name: f.name, ok: true, text: `${j.label}: ${j.days} 日分・${j.events} 件の書き込み${j.problems?.length ? ` (注意: ${j.problems.join(" / ")})` : ""}` });
        }
      } catch {
        out.push({ name: f.name, ok: false, text: "送信できませんでした。通信を確かめてもう一度お試しください。" });
      }
      setResults([...out]);
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    // すべて読み込めたら照合の画面へ。読み込めなかったファイルがあれば理由を見せたまま止める
    if (id && out.every((r) => r.ok)) open(id);
    else if (id && (out.some((r) => r.ok) || id === batch)) setPartial(id);
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload([...e.dataTransfer.files]);
        }}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center ${drag ? "border-accent bg-accent-soft/40" : "border-line bg-subtle/40"}`}
      >
        <FileSpreadsheet className="h-8 w-8 text-ink-3" aria-hidden />
        <p className="text-sm text-ink">予定表の月のファイル (.xlsx) をここに置くか、選んでください</p>
        <p className="text-[11px] text-ink-3">例: 2026.11.xlsx・2026.12.xlsx (複数まとめて選べます。ファイル名の「年.月」で月を見分けます)</p>
        <input
          ref={input}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          className="sr-only"
          aria-label="予定表のファイル"
          data-testid="sheet-file"
          onChange={(e) => void upload([...(e.target.files ?? [])])}
        />
        <Button type="button" variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
          {busy ? <Loader2 className="animate-spin" /> : <Upload />} {batch ? "月のファイルを足す" : "ファイルを選ぶ"}
        </Button>
        {busy && <p className="text-xs text-ink-2" role="status">{busy}</p>}
      </div>
      {results.length > 0 && (
        <ul className="space-y-0.5 text-xs" data-testid="sheet-upload-results">
          {results.map((r) => (
            <li key={r.name} className={r.ok ? "text-good-ink" : "text-critical-ink"}>
              {r.ok ? "✓" : "✗"} {r.name}: {r.text}
            </li>
          ))}
        </ul>
      )}
      {partial && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          読み込めなかったファイルは、直してもう一度選んでください。
          <Button type="button" size="sm" variant="secondary" onClick={() => open(partial)}>
            読み込めた分で照合を見る
          </Button>
        </div>
      )}
    </div>
  );
}
