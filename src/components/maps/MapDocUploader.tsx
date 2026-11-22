"use client";

import { useRef, useState, type ClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, FileUp, LoaderCircle } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { MAP_USE_PURPOSES, MAP_USE_PURPOSE_LABEL, MAP_USE_PURPOSE_NOTE } from "@/lib/maps/purpose";
import type { MapUsePurpose } from "@/lib/db/types";

/**
 * 住宅地図の登録・差し替え (1 ファイルずつ)。利用許諾の確認のチェックがないと送れない。
 * PDF (ゼンリン GIS の「印刷」) か画像 (「画像出力」の PNG・JPEG。この欄で Ctrl+V で貼り付けもできる)。画像はサーバーで PDF にして保存する。
 * 送信先は /api/maps/documents (権限・中身の確認はサーバーで行う)
 */
export function MapDocUploader({
  targetType,
  targetId,
  replaceId,
  replaceLabel,
  defaultShareable,
  compact,
}: {
  targetType: string;
  targetId: string;
  /** 差し替えのとき: 古い PDF の ID と名前 */
  replaceId?: string;
  replaceLabel?: string;
  defaultShareable?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(!compact);
  const [provider, setProvider] = useState<"zenrin" | "other">("zenrin");
  const [copyright, setCopyright] = useState("© ZENRIN CO., LTD.");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [purpose, setPurpose] = useState<MapUsePurpose>("internal");
  const [picked, setPicked] = useState("");

  /** ゼンリン GIS の画像出力で「画像をコピー」した地図を貼り付ける (Ctrl+V) */
  function onPaste(e: ClipboardEvent<HTMLFormElement>) {
    const item = [...e.clipboardData.items].find((i) => i.kind === "file" && /^image\/(png|jpeg)$/.test(i.type));
    const f = item?.getAsFile();
    if (!f || !fileRef.current) return;
    e.preventDefault();
    const ext = f.type === "image/jpeg" ? "jpg" : "png";
    const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(/[-: ]/g, "").slice(0, 12);
    const file = new File([f], `住宅地図_${stamp}.${ext}`, { type: f.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileRef.current.files = dt.files;
    setPicked(`${file.name} (貼り付けた画像・${Math.max(1, Math.round(file.size / 1024))} KB)`);
    setResult(null);
  }

  async function submit(form: HTMLFormElement) {
    if (busy) return;
    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setResult({ ok: false, text: "PDF か画像のファイルを選ぶか、コピーした地図の画像を貼り付けてください (Ctrl+V)。" });
      return;
    }
    if (file.size > 9 * 1024 * 1024) {
      setResult({ ok: false, text: `${(file.size / 1048576).toFixed(1)} MB あります。1 ファイル 9 MB までにしてください。` });
      return;
    }
    if (fd.get("licenseConfirmed") !== "1") {
      setResult({ ok: false, text: "利用許諾の確認にチェックしてください。" });
      return;
    }
    fd.set("targetType", targetType);
    fd.set("targetId", targetId);
    if (replaceId) fd.set("replaceId", replaceId);
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/maps/documents", { method: "POST", body: fd });
      const body = res.headers.get("content-type")?.includes("application/json") ? ((await res.json()) as { ok: boolean; error?: string; message?: string }) : null;
      if (!body) throw new Error(res.status === 413 ? "ファイルが大きすぎます (1 ファイル 9 MB まで)。" : "ログインの有効期限が切れた可能性があります。ログインし直してください。");
      if (!body.ok) throw new Error(body.error ?? "登録できませんでした。");
      const text = body.message ?? "登録しました。";
      setResult({ ok: true, text });
      form.reset();
      setPicked("");
      // 画面の上のお知らせ (msg) に結果を出す (差し替えると、この欄は新しい版の行に置き換わるため)
      const url = new URL(window.location.href);
      url.searchParams.delete("err");
      url.searchParams.set("msg", text);
      router.replace(`${url.pathname}${url.search}#map`, { scroll: false });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOpen(true)}>
        <FileUp />
        {replaceId ? "差し替える" : "住宅地図を登録 (PDF・画像)"}
      </button>
    );
  }

  return (
    <form
      className="space-y-2.5 rounded-xl border border-line bg-subtle/50 p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
      onPaste={onPaste}
    >
      <div className="font-semibold text-ink">{replaceId ? `「${replaceLabel ?? "住宅地図"}」を差し替える` : "住宅地図を登録"}</div>
      <label className="block">
        <span className="label">PDF か画像 (PNG・JPEG。9 MB まで)</span>
        <input ref={fileRef} type="file" name="file" accept="application/pdf,.pdf,image/png,image/jpeg,.png,.jpg,.jpeg" required onChange={(e) => setPicked(e.target.files?.[0]?.name ?? "")} className="mt-1 block w-full text-xs file:mr-2 file:rounded-lg file:border file:border-line file:bg-panel file:px-3 file:py-1.5" />
      </label>
      <p className="text-[11px] leading-relaxed text-ink-3">
        ゼンリン GIS の「印刷」で出力した PDF、または「画像出力」の地図を右クリック →「画像をコピー」して、この欄で Ctrl+V (Mac は ⌘+V) で貼り付けられます。画像は PDF にして保存します。
        {picked && <span className="mt-0.5 block font-medium text-ink-2">選んだファイル: {picked}</span>}
      </p>
      <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
        <label className="block">
          <span className="label">地図の提供元</span>
          <select
            name="provider"
            value={provider}
            onChange={(e) => {
              const v = e.target.value === "other" ? "other" : "zenrin";
              setProvider(v);
              if (v === "zenrin" && !copyright) setCopyright("© ZENRIN CO., LTD.");
            }}
            className="field mt-1"
          >
            <option value="zenrin">ゼンリン 住宅地図</option>
            <option value="other">その他の地図・案内図</option>
          </select>
        </label>
        <label className="block">
          <span className="label">版・発行年 (任意)</span>
          <input name="edition" maxLength={60} placeholder="例: 2025年版" className="field mt-1" />
        </label>
        <label className="block">
          <span className="label">表示名 (任意)</span>
          <input name="title" maxLength={120} placeholder="例: 合志市 p.123" className="field mt-1" />
        </label>
        <label className="block">
          <span className="label">著作権表示{provider === "zenrin" ? " (必須)" : ""}</span>
          <input name="copyrightNotice" value={copyright} onChange={(e) => setCopyright(e.target.value)} maxLength={200} required={provider === "zenrin"} className="field mt-1" />
        </label>
        {provider === "zenrin" && (
          <label className="block">
            <span className="label">出力したときの用途</span>
            <select name="usePurpose" value={purpose} onChange={(e) => setPurpose(e.target.value as MapUsePurpose)} className="field mt-1">
              {MAP_USE_PURPOSES.map((p) => <option key={p} value={p}>{MAP_USE_PURPOSE_LABEL[p]}</option>)}
            </select>
          </label>
        )}
        {provider === "zenrin" && (
          <label className="flex items-end gap-2 pb-2">
            <input type="checkbox" name="nameplate" value="1" className="mb-0.5" />
            <span>表札 (居住者名) の情報を含む</span>
          </label>
        )}
        {provider === "zenrin" && <p className="text-[11px] leading-relaxed text-ink-3 @xl:col-span-2">{MAP_USE_PURPOSE_NOTE[purpose]}</p>}
        <label className="block @xl:col-span-2">
          <span className="label">契約・許諾の番号やメモ (任意)</span>
          <input name="licenseRef" maxLength={100} placeholder="例: 契約番号・利用許諾の範囲" className="field mt-1" />
        </label>
      </div>
      <input type="hidden" name="kind" value={provider === "zenrin" ? "residential" : "other"} />
      <label className="flex items-start gap-2">
        <input type="checkbox" name="shareable" value="1" defaultChecked={defaultShareable} className="mt-0.5" />
        <span>近くの別の場所 (同じ地図の範囲) からも、この PDF を使ってよい (契約で認められているとき)</span>
      </label>
      <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft/60 p-2 text-warn-ink">
        <input type="checkbox" name="licenseConfirmed" value="1" required className="mt-0.5" />
        <span>この地図は、契約で「社内サーバーへの保存」と「社内の複数人での閲覧」が認められています (ログイン画面の自動操作・アカウントの使い回しで取得したものではありません)。</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className={buttonClass("primary", "sm")}>
          {busy ? <LoaderCircle className="animate-spin" /> : <FileUp />}
          {busy ? "確認しています…" : replaceId ? "差し替える" : "登録する"}
        </button>
        {compact && (
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpen(false)}>
            閉じる
          </button>
        )}
      </div>
      {result && (
        <p className={`flex items-start gap-1.5 ${result.ok ? "text-good-ink" : "text-critical-ink"}`} role={result.ok ? "status" : "alert"}>
          {result.ok ? <CircleCheck className="mt-px h-4 w-4 shrink-0" /> : <CircleAlert className="mt-px h-4 w-4 shrink-0" />}
          {result.text}
        </p>
      )}
    </form>
  );
}

/** PDF のプレビュー (押したときだけ読み込む。スマートフォンは新しいタブで開く方が見やすい) */
export function MapPdfPreview({ src, title }: { src: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "プレビューを閉じる" : "プレビュー"}
      </button>
      {open && <iframe src={src} title={title} className="mt-2 h-[28rem] w-full rounded-lg border border-line bg-white" />}
    </div>
  );
}
