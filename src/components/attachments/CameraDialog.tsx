"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Check, CircleAlert, LoaderCircle, RefreshCw, RotateCcw, RotateCw, X } from "lucide-react";

/**
 * パソコンのカメラ (内蔵カメラ・USB の Web カメラ・書画カメラ) で書類・写真を撮影するダイアログ。
 * ------------------------------------------------------------
 * - スマートフォン・タブレットは端末のカメラのアプリ (<input capture>) の方がきれいに撮れるので、こちらはパソコン用
 *   (どちらを使うかは useTouchDevice で決める。書類取込は CaptureUploader、写真の登録は AttachmentUploader)
 * - ブラウザーのカメラ (getUserMedia) で映像を出し、シャッターでその瞬間の画像 (カメラの解像度のまま) を JPEG にする。
 *   縮小は送る前に image-prep.ts の prepareFile が行う
 * - 撮った画像は 90 度ずつ回転できる (横向きのカメラで縦の書類を撮ったとき)
 * - multiple = 続けて何枚も撮って最後にまとめて渡す (写真の登録)。そうでなければ 1 枚で閉じる (書類取込)
 * - 選んだカメラはブラウザーに覚える (次も同じカメラ。書画カメラをつないだパソコン向け)
 * - カメラの許可は https (または localhost) のページだけ。next.config.ts の Permissions-Policy は camera=(self)
 */

const CAMERA_KEY = "ichijoya.camera";

const COARSE = "(pointer: coarse)";
function subscribePointer(cb: () => void) {
  const mq = window.matchMedia(COARSE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/** 主な入力がタッチ (スマートフォン・タブレット) なら true、マウス (パソコン) なら false。サーバーでの描画では null */
export function useTouchDevice(): boolean | null {
  return useSyncExternalStore(subscribePointer, () => window.matchMedia(COARSE).matches, () => null);
}

/** パソコンにカメラがつながっているか (true / false、調べる前・調べられないときは null)。USB のカメラの抜き差しにも追従する */
export function useCameraPresence(enabled: boolean): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!enabled || !md?.enumerateDevices) return;
    let alive = true;
    const check = () =>
      md.enumerateDevices().then(
        (list) => alive && setPresent(list.some((d) => d.kind === "videoinput")),
        () => alive && setPresent(null),
      );
    check();
    md.addEventListener?.("devicechange", check);
    return () => {
      alive = false;
      md.removeEventListener?.("devicechange", check);
    };
  }, [enabled]);
  return enabled ? present : null;
}

function readSaved(): string | undefined {
  try {
    return localStorage.getItem(CAMERA_KEY) || undefined;
  } catch {
    return undefined;
  }
}
function save(id: string | undefined) {
  try {
    if (id) localStorage.setItem(CAMERA_KEY, id);
    else localStorage.removeItem(CAMERA_KEY);
  } catch {
    // 保存できなくても撮影はできる
  }
}

/** カメラを開けなかった理由 (利用者に分かる言葉で) */
function cameraError(e: unknown): string {
  if (typeof window !== "undefined" && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
    return "このブラウザーではカメラを使えません。Chrome・Edge・Safari の新しい版でお試しください。";
  }
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "カメラの使用が許可されていません。アドレスバーの左にあるカメラ (または鍵) のアイコンから、このサイトのカメラを「許可」にして「もう一度」を押してください。";
    case "NotFoundError":
    case "OverconstrainedError":
      return "カメラが見つかりません。USB の Web カメラ・書画カメラをつないでから「もう一度」を押すか、「ファイルを選ぶ」から取り込んでください。";
    case "NotReadableError":
    case "AbortError":
      return "カメラを開けませんでした。ほかのアプリ (Zoom・Teams など) がカメラを使っていたら閉じて、「もう一度」を押してください。";
    default:
      return "カメラを開けませんでした。「もう一度」を押すか、「ファイルを選ぶ」から取り込んでください。";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
function shotName(d = new Date(), seq = 0) {
  const s = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `camera-${s}${seq ? `-${seq}` : ""}.jpg`;
}

/** 画像を quarter × 90 度 (時計回り) 回して JPEG にする */
function encode(src: HTMLCanvasElement, quarter: number): Promise<Blob> {
  const q = ((quarter % 4) + 4) % 4;
  let canvas = src;
  if (q) {
    canvas = document.createElement("canvas");
    canvas.width = q % 2 ? src.height : src.width;
    canvas.height = q % 2 ? src.width : src.height;
    const g = canvas.getContext("2d")!;
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((q * Math.PI) / 2);
    g.drawImage(src, -src.width / 2, -src.height / 2);
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.92));
}

interface Shot {
  canvas: HTMLCanvasElement;
  quarter: number;
  url: string;
}

export function CameraDialog({
  onClose,
  onDone,
  multiple = false,
  title = "カメラで撮影",
  hint = "書類を明るい場所に置き、カメラの正面 (真上) から、用紙全体が枠に入るように撮影してください。",
}: {
  onClose: () => void;
  /** 撮影した画像 (multiple でなければ 1 枚) */
  onDone: (files: File[]) => void;
  multiple?: boolean;
  title?: string;
  hint?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const shutterRef = useRef<HTMLButtonElement>(null);
  /** 開くカメラ (空 = ブラウザーに任せる)。変えると映像を取り直す */
  const [requested, setRequested] = useState<string | undefined>(readSaved);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ phase: "starting" | "live" | "error"; error?: string }>({ phase: "starting" });
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([]);
  const [active, setActive] = useState<{ id: string; size: string }>({ id: "", size: "" });
  const [shot, setShot] = useState<Shot | null>(null);
  const [taken, setTaken] = useState<{ file: File; url: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // ダイアログを開く (Esc・背景のクリックで閉じる)
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    const cancel = () => onClose();
    d?.addEventListener("close", cancel);
    return () => d?.removeEventListener("close", cancel);
  }, [onClose]);

  // カメラの映像を出す
  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    const open = async (deviceId: string | undefined): Promise<MediaStream> => {
      const video: MediaTrackConstraints = { width: { ideal: 4096 }, height: { ideal: 3072 } };
      if (deviceId) video.deviceId = { exact: deviceId };
      else video.facingMode = { ideal: "environment" };
      return navigator.mediaDevices.getUserMedia({ video, audio: false });
    };
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
        try {
          stream = await open(requested);
        } catch (e) {
          // 覚えていたカメラが外されたときは、ほかのカメラで開き直す
          if (!requested || !(e instanceof DOMException) || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(e.name)) throw e;
          save(undefined);
          stream = await open(undefined);
        }
        if (!alive) return;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => undefined);
        }
        const track = stream.getVideoTracks()[0];
        const s = track?.getSettings() ?? {};
        setActive({ id: s.deviceId ?? "", size: s.width && s.height ? `${s.width}×${s.height}` : "" });
        const list = await navigator.mediaDevices.enumerateDevices();
        if (!alive) return;
        const vids = list.filter((d) => d.kind === "videoinput");
        setCameras(vids.map((d, i) => ({ id: d.deviceId, label: d.label || `カメラ ${i + 1}` })));
        setState({ phase: "live" });
        requestAnimationFrame(() => shutterRef.current?.focus());
      } catch (e) {
        if (alive) setState({ phase: "error", error: cameraError(e) });
      }
    })();
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [requested, attempt]);

  // 画像の URL を片付ける
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);
  const takenRef = useRef(taken);
  useEffect(() => {
    takenRef.current = taken;
  }, [taken]);
  useEffect(() => () => takenRef.current.forEach((t) => URL.revokeObjectURL(t.url)), []);

  function chooseCamera(id: string) {
    save(id);
    setState({ phase: "starting" });
    setRequested(id);
  }

  function retry() {
    setState({ phase: "starting" });
    setAttempt((n) => n + 1);
  }

  async function shoot() {
    const v = videoRef.current;
    if (!v || !v.videoWidth || busy) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    setBusy(true);
    try {
      const blob = await encode(canvas, 0);
      setShot({ canvas, quarter: 0, url: URL.createObjectURL(blob) });
    } finally {
      setBusy(false);
    }
  }

  async function rotate(by: number) {
    if (!shot || busy) return;
    setBusy(true);
    try {
      const quarter = shot.quarter + by;
      const blob = await encode(shot.canvas, quarter);
      setShot({ canvas: shot.canvas, quarter, url: URL.createObjectURL(blob) });
    } finally {
      setBusy(false);
    }
  }

  function retake() {
    setShot(null);
    requestAnimationFrame(() => shutterRef.current?.focus());
  }

  async function accept() {
    if (!shot || busy) return;
    setBusy(true);
    try {
      const blob = await encode(shot.canvas, shot.quarter);
      const file = new File([blob], shotName(new Date(), multiple ? taken.length + 1 : 0), { type: "image/jpeg", lastModified: Date.now() });
      if (!multiple) {
        onDone([file]);
        return;
      }
      setTaken((t) => [...t, { file, url: URL.createObjectURL(blob) }]);
      setShot(null);
      requestAnimationFrame(() => shutterRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  function removeTaken(i: number) {
    setTaken((t) => {
      URL.revokeObjectURL(t[i].url);
      return t.filter((_, j) => j !== i);
    });
  }

  const live = state.phase === "live" && !shot;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="camera-dialog-title"
      className="m-auto flex max-h-[calc(100dvh-1.5rem)] w-[min(60rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0 text-ink shadow-pop backdrop:bg-ink/60"
      onClick={(e) => {
        // 背景 (ダイアログの外側) を押したら閉じる
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 id="camera-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
          <Camera className="h-4 w-4 text-accent" aria-hidden />
          {title}
          {multiple && taken.length > 0 && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-ink">{taken.length} 枚</span>}
        </h2>
        <button type="button" onClick={() => dialogRef.current?.close()} className="rounded-lg p-1.5 text-ink-3 hover:bg-subtle hover:text-ink" aria-label="閉じる">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex min-h-[16rem] flex-1 items-center justify-center overflow-hidden bg-[#111]">
        {/* 映像は撮影後も止めない (すぐに撮り直せるように) */}
        <video ref={videoRef} muted playsInline className={`max-h-[62dvh] w-full object-contain ${shot ? "hidden" : ""}`} aria-label="カメラの映像" />
        {shot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot.url} alt="撮影した画像" className="max-h-[62dvh] w-full object-contain" />
        )}
        {live && (
          <div aria-hidden className="pointer-events-none absolute inset-[7%] rounded-xl border-2 border-dashed border-white/55">
            <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-0.5 text-[11px] text-white">書類を枠の中に</span>
          </div>
        )}
        {state.phase === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-white/90" role="status">
            <LoaderCircle className="h-6 w-6 animate-spin" aria-hidden />
            カメラを準備しています…
            <span className="text-xs text-white/70">ブラウザーがカメラの使用の許可を求めたら「許可」を押してください</span>
          </div>
        )}
        {state.phase === "error" && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-white">
            <CircleAlert className="h-7 w-7 text-serious" aria-hidden />
            <p className="max-w-md leading-relaxed">{state.error}</p>
            <button type="button" onClick={retry} className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-subtle">
              <RefreshCw className="h-4 w-4" aria-hidden /> もう一度
            </button>
          </div>
        )}
      </div>

      {multiple && taken.length > 0 && (
        <ul className="flex gap-2 overflow-x-auto border-t border-line bg-subtle px-3 py-2" aria-label="撮影した写真">
          {taken.map((t, i) => (
            <li key={t.url} className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.url} alt={`${i + 1} 枚目`} className="h-14 w-14 rounded-lg border border-line object-cover" />
              <button type="button" onClick={() => removeTaken(i)} className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-panel p-0.5 text-ink-3 hover:text-critical" aria-label={`${i + 1} 枚目を消す`}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2.5 border-t border-line px-4 py-3">
        {shot ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={retake} disabled={busy} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3.5 text-sm hover:bg-subtle disabled:opacity-60">
              <Camera className="h-4 w-4" aria-hidden /> 撮り直す
            </button>
            <button type="button" onClick={() => rotate(-1)} disabled={busy} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 text-sm hover:bg-subtle disabled:opacity-60" aria-label="左に回転">
              <RotateCcw className="h-4 w-4" aria-hidden /> 左に回転
            </button>
            <button type="button" onClick={() => rotate(1)} disabled={busy} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 text-sm hover:bg-subtle disabled:opacity-60" aria-label="右に回転">
              <RotateCw className="h-4 w-4" aria-hidden /> 右に回転
            </button>
            <button type="button" onClick={accept} disabled={busy} className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60" autoFocus>
              <Check className="h-4 w-4" aria-hidden /> {multiple ? "この写真を追加" : "この写真を使う"}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {cameras.length > 1 && (
              <label className="flex min-w-0 items-center gap-2 text-xs text-ink-2">
                <span className="shrink-0">カメラ</span>
                <select className="field h-9 min-w-0 max-w-[16rem] py-1 text-xs" value={active.id} onChange={(e) => chooseCamera(e.target.value)} disabled={state.phase === "starting"}>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
            )}
            {active.size && state.phase === "live" && <span className="text-[11px] text-ink-3 tnum">{active.size}</span>}
            <div className="ml-auto flex items-center gap-2">
              {multiple && taken.length > 0 && (
                <button type="button" onClick={() => onDone(taken.map((t) => t.file))} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-soft">
                  <Check className="h-4 w-4" aria-hidden /> {taken.length} 枚を登録する
                </button>
              )}
              <button ref={shutterRef} type="button" onClick={shoot} disabled={!live || busy} className="inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-6 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
                <Camera className="h-5 w-5" aria-hidden /> 撮影
              </button>
            </div>
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-ink-3">
          {shot ? "文字がはっきり読めるか確かめてください。ぼやけていたら「撮り直す」を押します。" : `${hint} ノートパソコンの内蔵カメラより、USB の書画カメラ・Web カメラの方がきれいに撮れます。`}
        </p>
      </div>
    </dialog>
  );
}
