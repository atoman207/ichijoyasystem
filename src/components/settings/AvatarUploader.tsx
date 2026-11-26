"use client";

import { useRef, useState, useTransition } from "react";
import { Camera, Trash2 } from "lucide-react";
import { Avatar, Button } from "@/components/ui";
import { removeOwnAvatar, updateOwnAvatar } from "@/lib/actions/accounts";

const EDGE = 256;

/** 中央を正方形に切り抜いて 256px の JPEG にする (位置情報などの Exif は消える) */
async function squareJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const side = Math.min(bmp.width, bmp.height);
    const canvas = document.createElement("canvas");
    canvas.width = EDGE;
    canvas.height = EDGE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, EDGE, EDGE);
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, EDGE, EDGE);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.86));
  } finally {
    bmp.close();
  }
}

export function AvatarUploader({ name, id, src }: { name: string; id: string; src?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob }>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  async function choose(file?: File) {
    setError(undefined);
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("写真 (画像) を選んでください。");
    try {
      const blob = await squareJpeg(file);
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ url: URL.createObjectURL(blob), blob });
    } catch {
      setError("この写真は読み込めませんでした (HEIC の場合は JPEG で保存し直してください)。");
    }
  }

  function save() {
    if (!preview) return;
    const fd = new FormData();
    fd.set("avatar", new File([preview.blob], "avatar.jpg", { type: "image/jpeg" }));
    start(() => updateOwnAvatar(fd));
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar name={name} id={id} size={72} ring src={preview?.url ?? src} />
      <div className="space-y-2">
        <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()} disabled={pending}>
            <Camera className="h-4 w-4" /> {src || preview ? "写真を選び直す" : "写真を選ぶ"}
          </Button>
          {preview && (
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              {pending ? "保存中…" : "この写真で保存"}
            </Button>
          )}
          {src && !preview && (
            <Button type="button" size="sm" variant="ghost" onClick={() => start(() => removeOwnAvatar())} disabled={pending}>
              <Trash2 className="h-4 w-4 text-critical" /> 削除
            </Button>
          )}
        </div>
        <p className="text-[11px] text-ink-3">中央を正方形に切り抜き、256px に縮小して保存します。ヘッダーや担当者の表示に使われます。</p>
        {error && <p role="alert" className="text-xs text-critical-ink">{error}</p>}
      </div>
    </div>
  );
}
