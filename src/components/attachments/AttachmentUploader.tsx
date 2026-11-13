"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, CircleAlert, CircleCheck, LoaderCircle, Paperclip } from "lucide-react";
import { prepareFile } from "./image-prep";

/** 1 回に選べるファイルの数 */
const MAX_FILES = 20;

interface Row {
  name: string;
  state: "wait" | "send" | "done" | "error";
  error?: string;
}

/**
 * 写真・資料の登録 (スマートフォン・タブレットのカメラ / アルバム / ファイル)。
 * 写真は縮小してから 1 枚ずつ送り、すべて終わったら画面を更新する
 */
export function AttachmentUploader({ parentType, parentId, accept }: { parentType: string; parentId: string; accept: string }) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  async function upload(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length || busy) return;
    if (files.length > MAX_FILES) {
      setRows([{ name: `${files.length} 件`, state: "error", error: `1 回に登録できるのは ${MAX_FILES} 件までです。分けて登録してください。` }]);
      return;
    }
    setBusy(true);
    const next: Row[] = files.map((f) => ({ name: f.name, state: "wait" }));
    setRows([...next]);
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      next[i] = { ...next[i], state: "send" };
      setRows([...next]);
      try {
        const p = await prepareFile(files[i]);
        const fd = new FormData();
        fd.set("parentType", parentType);
        fd.set("parentId", parentId);
        fd.set("file", p.file, p.file.name);
        if (p.thumb) fd.set("thumb", p.thumb, "thumb.jpg");
        if (p.width) fd.set("width", String(p.width));
        if (p.height) fd.set("height", String(p.height));
        if (p.takenAt) fd.set("takenAt", p.takenAt);
        if (caption.trim()) fd.set("caption", caption.trim());
        const res = await fetch("/api/attachments", { method: "POST", body: fd });
        const body = res.headers.get("content-type")?.includes("application/json") ? ((await res.json()) as { ok: boolean; error?: string }) : null;
        if (!body) throw new Error(res.status === 413 ? "ファイルが大きすぎます (1 ファイル 4 MB まで)。" : "ログインの有効期限が切れた可能性があります。ログインし直してください。");
        if (!body.ok) throw new Error(body.error ?? "登録できませんでした。");
        next[i] = { ...next[i], state: "done" };
        ok += 1;
      } catch (err) {
        next[i] = { ...next[i], state: "error", error: err instanceof Error && err.message !== "Failed to fetch" ? err.message : "通信できませんでした。電波の良い場所で再度お試しください。" };
      }
      setRows([...next]);
    }
    setBusy(false);
    if (cameraRef.current) cameraRef.current.value = "";
    if (pickRef.current) pickRef.current.value = "";
    if (ok > 0) {
      setCaption("");
      router.refresh();
    }
    // 全件成功したら一覧を数秒後に閉じる
    if (ok === files.length) setTimeout(() => setRows((r) => (r === next ? [] : r)), 4000);
  }

  const done = rows.filter((r) => r.state === "done").length;
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-subtle/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className={`inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <Camera className="h-4 w-4" aria-hidden />
          カメラで撮影
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" disabled={busy} onChange={(e) => upload(e.target.files)} />
        </label>
        <label className={`inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-line bg-panel px-4 text-sm font-medium text-ink hover:bg-subtle ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <Paperclip className="h-4 w-4" aria-hidden />
          写真・資料を選ぶ (複数可)
          <input ref={pickRef} type="file" multiple accept={accept} className="sr-only" disabled={busy} onChange={(e) => upload(e.target.files)} data-testid="attachment-input" />
        </label>
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="メモ (任意。例: 施工前・和室6畳)"
          maxLength={200}
          className="field h-10 min-w-0 flex-1 basis-48"
          aria-label="写真・資料のメモ"
          disabled={busy}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">写真は自動で縮小して送ります (撮影日時・登録者を記録)。PDF・Excel・Word などは 1 ファイル 4 MB まで。1 回に {MAX_FILES} 件まで選べます。</p>
      {rows.length > 0 && (
        <div className="mt-3 rounded-lg bg-panel p-2 text-xs" aria-live="polite">
          <div className="mb-1 font-medium text-ink">{busy ? `登録中… ${done} / ${rows.length}` : `${done} / ${rows.length} 件を登録しました`}</div>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto">
            {rows.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                {r.state === "done" ? <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0 text-good" aria-label="完了" /> : r.state === "error" ? <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-critical" aria-label="失敗" /> : r.state === "send" ? <LoaderCircle className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-label="送信中" /> : <span className="mt-px h-3.5 w-3.5 shrink-0 rounded-full border border-line" aria-label="待機中" />}
                <span className="min-w-0 break-all text-ink-2">
                  {r.name}
                  {r.error && <span className="block text-critical-ink">{r.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
