"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Camera, FileText, Upload, X } from "lucide-react";
import type { DocumentKind, StoreId } from "@/lib/db/types";
import { DOCUMENT_KIND_LABEL } from "@/lib/constants";
import { prepareFile } from "@/components/attachments/image-prep";
import { CameraDialog, useCameraPresence, useTouchDevice } from "@/components/attachments/CameraDialog";

/** 送信できる大きさ (Vercel の 1 回の送信は 4.5 MB まで。写真は縮小してから送る) */
const MAX_BYTES = 4 * 1024 * 1024;

const SAMPLES: Record<DocumentKind, string[]> = {
  handwritten_quote: ["IMG_手書き見積_和室6畳.jpg", "IMG_手書き見積_襖と畳.jpg"],
  drawing: ["IMG_現場図面_1F和室.jpg"],
  site_document: ["施工仕様書_○○様邸.pdf", "作業指示書_工務店.jpg"],
  supplier_invoice: ["請求書_い草協同組合_11月.pdf", "請求書_九州畳材_11月.jpg"],
  receipt: ["receipt_eneos_給油.jpg", "receipt_ETC_高速代.png", "receipt_ホームセンター.jpg"],
  contract: ["契約書_畳表替え.pdf"],
  survey_postcard: ["アンケートはがき_No13338.jpg", "アンケートはがき_T698.jpg"],
  reception: ["受付メモ_来店.jpg"],
  other: ["書類.jpg"],
};

/** 画面ごとの文言 (金額の計算・書き写しの確認で使う) */
export interface UploaderLabels {
  submit?: string;
  pending?: string;
  sample?: string;
  drop?: string;
  dropNote?: string;
  note?: string;
}

function SubmitButton({ hasFile, pending, labels }: { hasFile: boolean; pending: boolean; labels: UploaderLabels }) {
  return (
    <button type="submit" disabled={pending} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60">
      {pending ? (labels.pending ?? "AI が読み取り中…") : hasFile ? (labels.submit ?? "アップロードして読み取る") : (labels.sample ?? "サンプル画像で読み取りを試す")}
    </button>
  );
}

/** 写真・PDF だけを受け付ける (ドラッグ・貼り付けで別の種類のファイルが来たとき) */
const acceptable = (f: File) => f.type.startsWith("image/") || f.type === "application/pdf" || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(f.name);

/**
 * 書類の撮影・取込 (書類取込・見積の金額の計算・受付のメモで共通)。
 * - スマートフォン・タブレット:「撮影する」= 端末のカメラのアプリ、「写真・ファイルを選ぶ」= アルバム・PDF
 * - パソコン:「カメラで撮影」= ブラウザーのカメラ (CameraDialog。Web カメラ・書画カメラ)、「ファイルを選ぶ」、
 *   ファイルのドラッグ、画像の貼り付け (Ctrl+V。画面に取込の欄が 1 つのときだけ)
 * 写真は送る前に縮小する (image-prep.ts)。選んだファイルは状態に持ち、送るときに FormData の file に入れる
 */
export function CaptureUploader({
  action,
  defaultKind,
  stores,
  defaultStoreId,
  canChooseStore,
  aiEnabled,
  fixedKind = false,
  hideStore = false,
  hidden,
  labels = {},
  zoneFirst = false,
  extra,
}: {
  action: (formData: FormData) => Promise<void>;
  defaultKind: DocumentKind;
  stores: { id: StoreId; name: string }[];
  defaultStoreId: StoreId;
  canChooseStore: boolean;
  aiEnabled: boolean;
  /** 書類の種類を選ばせない (defaultKind で送る) */
  fixedKind?: boolean;
  /** 店舗を選ばせない (書類の店舗を使う画面) */
  hideStore?: boolean;
  /** 一緒に送る値 (mode・書類の ID など) */
  hidden?: Record<string, string>;
  labels?: UploaderLabels;
  /** 撮影の欄 (点線の枠と「撮影する」) を一番上に置く (スマートフォンでもスクロールせずに撮影できるように。問合せ登録) */
  zoneFirst?: boolean;
  /** 撮影の欄のすぐ下に置く入力 (問合せ登録の入口など) */
  extra?: ReactNode;
}) {
  const touch = useTouchDevice();
  const pc = touch === false;
  const hasCamera = useCameraPresence(pc);
  const [kind, setKind] = useState<DocumentKind>(defaultKind);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sample, setSample] = useState<string>(SAMPLES[defaultKind][0]);
  const [camera, setCamera] = useState(false);
  const [dragging, setDragging] = useState(false);
  const shootRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const choose = useCallback((f: File | null | undefined) => {
    setError("");
    if (f && !acceptable(f)) {
      setError("写真 (JPEG・PNG など) か PDF を選んでください。");
      return;
    }
    setFile(f ?? null);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return f && f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
    });
  }, []);

  // パソコン: 画像の貼り付け (Ctrl+V)。文字の入力欄への貼り付けと、取込の欄が 2 つ以上ある画面では受け取らない
  useEffect(() => {
    if (!pc) return;
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable)) return;
      if (document.querySelectorAll("[data-capture-zone]").length !== 1) return;
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith("image/"));
      if (!f) return;
      e.preventDefault();
      const name = f.name && f.name !== "image.png" ? f.name : `paste-${Date.now()}.${f.type.split("/")[1] || "png"}`;
      choose(new File([f], name, { type: f.type, lastModified: Date.now() }));
      zoneRef.current?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [pc, choose]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  /** 写真は縮小し、縮小画像・撮影日時を添えて送る (元の画像は見積・経費・仕入の画面で表示する) */
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError("");
    startTransition(async () => {
      if (file) {
        const p = await prepareFile(file);
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

  /** 撮影: スマートフォンは端末のカメラ、パソコンはブラウザーのカメラ */
  function openCamera() {
    if (pc) setCamera(true);
    else shootRef.current?.click();
  }

  const title = labels.drop ?? "書類を撮影するか、写真・PDF を選んでください";
  const note = pc
    ? "パソコンのカメラ (Web カメラ・書画カメラ) で撮影するか、ファイルをここにドラッグ・貼り付け (Ctrl+V) してください。"
    : (labels.dropNote ?? "カメラで撮影した写真をそのまま取り込めます (写真は自動で縮小。PDF は 4MB まで)");
  const btn = "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-medium disabled:opacity-60";

  const selects = (
    <>
      {fixedKind ? <input type="hidden" name="kind" value={kind} /> : (
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
          {/* 受付メモは問い合わせの「受付を登録」で取り込む */}
          {(Object.keys(DOCUMENT_KIND_LABEL) as DocumentKind[]).filter((k) => k !== "reception").map((k) => (
            <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>
          ))}
        </select>
      </label>
      )}
      {!hideStore && (
      <label className="block">
        <span className="label">店舗</span>
        <select name="storeId" defaultValue={defaultStoreId} disabled={!canChooseStore} className="field">
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      )}
    </>
  );
  const zone = (
      <div
        ref={zoneRef}
        data-capture-zone
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${dragging ? "border-accent bg-accent-soft/60" : "border-line-strong"}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files?.[0]);
        }}
      >
        {/* スマートフォン: 端末のカメラ (capture) と、アルバム・ファイル (capture なし) を分ける */}
        <input ref={shootRef} type="file" accept="image/*" capture="environment" className="hidden" tabIndex={-1} aria-hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={pickRef} type="file" accept="image/*,application/pdf" className="hidden" tabIndex={-1} aria-hidden data-testid="capture-file" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="取り込む画像のプレビュー" className="max-h-64 rounded-lg object-contain" />
        ) : file ? (
          <div className="flex items-center gap-2 text-sm text-ink"><FileText className="h-8 w-8 text-ink-3" aria-hidden />PDF</div>
        ) : (
          <>
            <div className="flex gap-3 text-ink-3" aria-hidden><Camera className="h-8 w-8" /><Upload className="h-8 w-8" /></div>
            <p className="mt-3 text-sm font-medium text-ink">{title}</p>
            <p className="mt-1 text-xs text-ink-3">{note}</p>
          </>
        )}
        {file && <p className="mt-2 max-w-full truncate text-xs text-ink-2">{file.name}</p>}
        <div className="mt-4 flex w-full flex-wrap justify-center gap-2">
          <button type="button" onClick={openCamera} disabled={pending} className={`${btn} min-w-[9rem] bg-accent text-white hover:bg-accent-hover`}>
            <Camera className="h-4 w-4" aria-hidden />
            {file ? "撮り直す" : pc ? "カメラで撮影" : "撮影する"}
          </button>
          <button type="button" onClick={() => pickRef.current?.click()} disabled={pending} className={`${btn} border border-line bg-panel text-ink hover:bg-subtle`}>
            <Upload className="h-4 w-4" aria-hidden />
            {pc ? "ファイルを選ぶ" : "写真・ファイルを選ぶ"}
          </button>
          {file && (
            <button type="button" onClick={() => choose(null)} disabled={pending} className={`${btn} px-3 text-ink-2 hover:bg-subtle`}>
              <X className="h-4 w-4" aria-hidden /> 取り消す
            </button>
          )}
        </div>
        {pc && hasCamera === false && !file && (
          <p className="mt-2 text-[11px] text-ink-3">このパソコンにはカメラが見つかりません。USB の Web カメラ・書画カメラをつなぐと撮影できます (ファイルの取込はこのまま使えます)。</p>
        )}
      </div>
  );

  return (
    <form action={action} onSubmit={onSubmit} className="space-y-4">
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {!zoneFirst && selects}
      {zone}
      {zoneFirst && selects}
      {extra}

      {camera && (
        <CameraDialog
          onClose={() => setCamera(false)}
          onDone={(files) => {
            setCamera(false);
            choose(files[0]);
          }}
          hint={labels.dropNote ? `${labels.dropNote}。` : undefined}
        />
      )}

      {!file && (
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
      <SubmitButton hasFile={Boolean(file)} pending={pending} labels={labels} />
      <p className="text-[11px] leading-relaxed text-ink-3">
        {labels.note ?? (aiEnabled
          ? "AI が画像・PDF を読み取り、書類の種類ごとの項目 (日付・取引先・品名・数量・金額など) に整理します。結果は登録前に確認・修正できます。"
          : "AI の API キーが未設定のため、サンプルの読取結果が表示されます。キーを設定すると、撮影した画像・PDF を AI が読み取り、同じ画面に結果が表示されます。")}
      </p>
    </form>
  );
}
