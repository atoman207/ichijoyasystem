"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Eraser, Hash, LoaderCircle, Pencil, Save, Undo2, X } from "lucide-react";
import { prepareFile } from "./image-prep";

/**
 * 登録済みの図面・写真に、スマートフォン・タブレットの画面で直接書き込んで保存する (お客様のご要望 2026-11-25「⑤」)
 * ------------------------------------------------------------
 * - ペン (赤・青・黒、細・太) と「番号」(押した場所に ① ② ③ … を順に置く。襖・障子・網戸の番号を図面に振る)。1 つ前に戻す・全部消す
 * - 保存すると、書き込んだ画像を同じ記録の新しい写真として登録する (元の写真は残す。台帳の derivedFrom)。種類 (現場図面など) は元の写真と同じ
 * - 画面に合わせて表示し、書き込みは元の画像の大きさ (長い辺 2400px まで) で描く
 */

type Tool = "pen" | "number";
type Op = { kind: "line"; color: string; width: number; pts: [number, number][] } | { kind: "number"; color: string; n: number; x: number; y: number; r: number };

const COLORS = [
  { id: "#dc2626", label: "赤" },
  { id: "#2563eb", label: "青" },
  { id: "#111827", label: "黒" },
];
const MAX_SIDE = 2400;

function draw(ctx: CanvasRenderingContext2D, img: HTMLImageElement, ops: Op[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  for (const op of ops) {
    if (op.kind === "line") {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      op.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (op.pts.length === 1) ctx.lineTo(op.pts[0][0] + 0.1, op.pts[0][1] + 0.1);
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.strokeStyle = op.color;
      ctx.lineWidth = Math.max(2, op.r * 0.14);
      ctx.beginPath();
      ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = op.color;
      ctx.font = `bold ${Math.round(op.r * (op.n >= 10 ? 1.05 : 1.3))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(op.n), op.x, op.y + op.r * 0.05);
    }
  }
}

export function AnnotateDialog({ attachmentId, fileName, parentType, parentId, onClose, onSaved }: { attachmentId: string; fileName: string; parentType: string; parentId: string; onClose: () => void; onSaved: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [ops, setOps] = useState<Op[]>([]);
  const [tool, setTool] = useState<Tool>("number");
  const [color, setColor] = useState(COLORS[0].id);
  const [thick, setThick] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const live = useRef<Op | null>(null);

  // 元の画像を読む (同じサイトの /api/attachments/<ID>。権限はサーバーで確かめる)
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      imgRef.current = img;
      setSize({ w: Math.round(img.naturalWidth * scale), h: Math.round(img.naturalHeight * scale) });
    };
    img.onerror = () => setError("画像を読み込めませんでした。");
    img.src = `/api/attachments/${encodeURIComponent(attachmentId)}`;
  }, [attachmentId]);

  useEffect(() => {
    const c = canvas.current;
    const img = imgRef.current;
    if (!c || !img || !size) return;
    const ctx = c.getContext("2d");
    if (ctx) draw(ctx, img, live.current ? [...ops, live.current] : ops, size.w, size.h);
  }, [ops, size]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, saving]);

  const base = size ? Math.max(size.w, size.h) : 1000;
  const lineWidth = Math.max(3, Math.round(base * (thick ? 0.009 : 0.004)));
  const radius = Math.max(14, Math.round(base * 0.022));
  const nextNumber = ops.filter((o) => o.kind === "number").length + 1;

  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * (size?.w ?? 1), ((e.clientY - r.top) / r.height) * (size?.h ?? 1)];
  };
  const redrawLive = () => {
    const c = canvas.current;
    const img = imgRef.current;
    const ctx = c?.getContext("2d");
    if (ctx && img && size) draw(ctx, img, live.current ? [...ops, live.current] : ops, size.w, size.h);
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!size) return;
    e.preventDefault();
    const [x, y] = point(e);
    if (tool === "number") {
      setOps((o) => [...o, { kind: "number", color, n: nextNumber, x, y, r: radius }]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    live.current = { kind: "line", color, width: lineWidth, pts: [[x, y]] };
    redrawLive();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!live.current || live.current.kind !== "line") return;
    e.preventDefault();
    live.current.pts.push(point(e));
    redrawLive();
  };
  const onUp = () => {
    const op = live.current;
    live.current = null;
    if (op) setOps((o) => [...o, op]);
  };

  async function save() {
    const c = canvas.current;
    if (!c || !ops.length) return;
    setSaving(true);
    setError("");
    try {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.88));
      if (!blob) throw new Error("画像を作れませんでした。");
      const name = `${fileName.replace(/\.[^.]+$/, "")}_書き込み.jpg`;
      const p = await prepareFile(new File([blob], name, { type: "image/jpeg" }));
      const fd = new FormData();
      fd.set("parentType", parentType);
      fd.set("parentId", parentId);
      fd.set("derivedFrom", attachmentId);
      fd.set("file", p.file, p.file.name);
      if (p.thumb) fd.set("thumb", p.thumb, "thumb.jpg");
      if (p.width) fd.set("width", String(p.width));
      if (p.height) fd.set("height", String(p.height));
      const res = await fetch("/api/attachments", { method: "POST", body: fd });
      const body = res.headers.get("content-type")?.includes("application/json") ? ((await res.json()) as { ok: boolean; error?: string }) : null;
      if (!body?.ok) throw new Error(body?.error ?? "保存できませんでした (ログインの有効期限が切れた可能性があります)。");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存できませんでした。");
      setSaving(false);
    }
  }

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="図面・写真に書き込む" className="fixed inset-0 z-[60] flex flex-col bg-black/90 text-white" data-testid="annotate-dialog">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
        <span className="mr-1 min-w-0 max-w-[40%] truncate text-sm font-medium">{fileName}</span>
        <div className="flex gap-1 rounded-lg bg-white/10 p-0.5">
          <button type="button" onClick={() => setTool("number")} aria-pressed={tool === "number"} className={clsx("inline-flex h-9 items-center gap-1 rounded-md px-2.5", tool === "number" ? "bg-white text-ink" : "hover:bg-white/20")} title="押した場所に番号を置く">
            <Hash className="h-4 w-4" aria-hidden />番号 ({nextNumber})
          </button>
          <button type="button" onClick={() => setTool("pen")} aria-pressed={tool === "pen"} className={clsx("inline-flex h-9 items-center gap-1 rounded-md px-2.5", tool === "pen" ? "bg-white text-ink" : "hover:bg-white/20")}>
            <Pencil className="h-4 w-4" aria-hidden />ペン
          </button>
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="色">
          {COLORS.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={color === c.id} onClick={() => setColor(c.id)} className={clsx("h-8 w-8 rounded-full border-2", color === c.id ? "border-white" : "border-transparent")} style={{ background: c.id }} aria-label={c.label} />
          ))}
        </div>
        {tool === "pen" && (
          <button type="button" onClick={() => setThick((t) => !t)} className="inline-flex h-9 items-center rounded-md bg-white/10 px-2.5 hover:bg-white/20">
            {thick ? "太い線" : "細い線"}
          </button>
        )}
        <button type="button" onClick={() => setOps((o) => o.slice(0, -1))} disabled={!ops.length} className="inline-flex h-9 items-center gap-1 rounded-md bg-white/10 px-2.5 hover:bg-white/20 disabled:opacity-40">
          <Undo2 className="h-4 w-4" aria-hidden />戻す
        </button>
        <button type="button" onClick={() => setOps([])} disabled={!ops.length} className="inline-flex h-9 items-center gap-1 rounded-md bg-white/10 px-2.5 hover:bg-white/20 disabled:opacity-40">
          <Eraser className="h-4 w-4" aria-hidden />全部消す
        </button>
        <span className="flex-1" />
        <button type="button" onClick={save} disabled={!ops.length || saving} className="inline-flex h-9 items-center gap-1 rounded-md bg-accent px-3 font-medium hover:bg-accent-hover disabled:opacity-50" data-testid="annotate-save">
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
          保存 (新しい写真として)
        </button>
        <button type="button" onClick={onClose} disabled={saving} className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 hover:bg-white/20" aria-label="閉じる">
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
      {error && <p className="mx-3 mb-2 rounded-lg bg-critical px-3 py-1.5 text-xs">{error}</p>}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-2 pb-3">
        {size ? (
          <canvas
            ref={canvas}
            width={size.w}
            height={size.h}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="max-h-full max-w-full bg-white"
            style={{ touchAction: "none", aspectRatio: `${size.w} / ${size.h}` }}
            aria-label="書き込む場所 (指・ペンでなぞる / 番号は押した場所に置く)"
          />
        ) : (
          !error && <LoaderCircle className="h-8 w-8 animate-spin text-white/70" aria-label="読み込み中" />
        )}
      </div>
      <p className="px-3 pb-3 text-center text-[11px] text-white/60">「番号」で押した場所に ① ② ③ … を置けます (襖・障子・網戸の番号)。保存すると元の写真は残したまま、書き込んだ写真を新しく登録します。</p>
    </div>,
    document.body,
  );
}
