"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { Camera, Upload } from "lucide-react";
import type { DocumentKind, StoreId } from "@/lib/db/types";
import { DOCUMENT_KIND_LABEL } from "@/lib/constants";
import { prepareFile } from "@/components/attachments/image-prep";

/** 送信できる大きさ (Vercel の 1 回の送信は 4.5 MB まで。写真は縮小してから送る) */
const MAX_BYTES = 4 * 1024 * 1024;

const SAMPLES: Record<DocumentKind, string[]> = {
  handwritten_quote: ["IMG_手書き見積_和室6畳.jpg", "IMG_手書き見積_襖と畳.jpg"],
  drawing: ["IMG_現場図面_1F和室.jpg"],
  supplier_invoice: ["請求書_い草協同組合_11月.pdf", "請求書_九州畳材_11月.jpg"],
  receipt: ["receipt_eneos_給油.jpg", "receipt_ETC_高速代.png", "receipt_ホームセンター.jpg"],
  contract: ["契約書_畳表替え.pdf"],
  other: ["書類.jpg"],
};

function SubmitButton({ hasFile, pending }: { hasFile: boolean; pending: boolean }) {
  return (
    <button type="submit" disabled={pending} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60">
      {pending ? "AI が読み取り中…" : hasFile ? "アップロードして読み取る" : "サンプル画像で読み取りを試す"}
    </button>
  );
}

export function CaptureUploader({
  action,
  defaultKind,
  stores,
  defaultStoreId,
  canChooseStore,
  aiEnabled,
}: {
  action: (formData: FormData) => Promise<void>;
  defaultKind: DocumentKind;
  stores: { id: StoreId; name: string }[];
  defaultStoreId: StoreId;
  canChooseStore: boolean;
  aiEnabled: boolean;
}) {
  const [kind, setKind] = useState<DocumentKind>(defaultKind);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [sample, setSample] = useState<string>(SAMPLES[defaultKind][0]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  /** 写真は縮小し、縮小画像・撮影日時を添えて送る (元の画像は見積・経費・仕入の画面で表示する) */
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const f = inputRef.current?.files?.[0];
    setError("");
    startTransition(async () => {
      if (f) {
        const p = await prepareFile(f);
        if (p.file.size > MAX_BYTES) {
          setError(`ファイルが大きすぎます (${(p.file.size / 1048576).toFixed(1)} MB)。PDF などは 4 MB までにしてください。`);
          return;
        }
        fd.set("file", p.file, p.file.name);
        if (p.thumb) fd.set("thumb", p.thumb, "thumb.jpg");
        if (p.takenAt) fd.set("takenAt", p.takenAt);
      }
      await action(fd);
    });
  }

  function onFile(f: File | undefined) {
    if (!f) {
      setPreview(null);
      setFileName("");
      return;
    }
    setFileName(f.name);
    if (f.type.startsWith("image/")) {
      const url = URL.createObjectURL(f);
      setPreview(url);
    } else {
      setPreview(null);
    }
  }

  return (
    <form action={action} onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="label">書類の種類</span>
        <select
          name="kind"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as DocumentKind;
            setKind(k);
            setSample(SAMPLES[k][0]);
          }}
          className="field"
        >
          {(Object.keys(DOCUMENT_KIND_LABEL) as DocumentKind[]).map((k) => (
            <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">店舗</span>
        <select name="storeId" defaultValue={defaultStoreId} disabled={!canChooseStore} className="field">
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>

      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-line-strong px-4 py-8 text-center transition hover:border-accent hover:bg-accent-soft/40"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f && inputRef.current) {
            const dt = new DataTransfer();
            dt.items.add(f);
            inputRef.current.files = dt.files;
            onFile(f);
          }
        }}
      >
        <input ref={inputRef} type="file" name="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="プレビュー" className="max-h-56 rounded-lg object-contain" />
        ) : (
          <>
            <div className="flex gap-3 text-ink-3"><Camera className="h-8 w-8" /><Upload className="h-8 w-8" /></div>
            <p className="mt-3 text-sm font-medium text-ink">タップして撮影 / 画像・PDF を選択</p>
            <p className="mt-1 text-xs text-ink-3">スマートフォン・タブレットのカメラで撮影した写真をそのまま取り込めます (写真は自動で縮小。PDF は 4MB まで)</p>
          </>
        )}
        {fileName && <p className="mt-2 text-xs text-ink-2">{fileName}</p>}
      </div>

      {!fileName && (
        <label className="block">
          <span className="label">ファイルを選ばずに試す場合のサンプル名</span>
          <select name="sampleName" value={sample} onChange={(e) => setSample(e.target.value)} className="field">
            {SAMPLES[kind].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      )}

      {error && <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">{error}</p>}
      <SubmitButton hasFile={Boolean(fileName)} pending={pending} />
      <p className="text-[11px] leading-relaxed text-ink-3">
        {aiEnabled
          ? "Claude (vision) が画像を読み取り、社内所定の項目に構造化します。"
          : "このデモ環境では AI の API キーが未設定のため、サンプルの読取結果が表示されます。本番では撮影した画像を Claude (vision) が読み取り、同じ画面に結果が表示されます。"}
      </p>
    </form>
  );
}
