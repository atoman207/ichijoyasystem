"use client";

import { useRef, useState, useTransition } from "react";
import { Camera, Eye, EyeOff, History, RotateCcw } from "lucide-react";
import { Avatar, Button } from "@/components/ui";
import { restoreAvatar, setAvatarVisible, updateOwnAvatar } from "@/lib/actions/accounts";
import type { AvatarPhotoView } from "@/lib/avatar-photos";

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

/**
 * 顔写真の登録・「表示しない / 表示する」・以前の写真に戻す (お客様のご要望 2026-11-26「顔写真は非表示にできても、元の写真データは削除できない。
 * 後からいつでも表示に戻せる」。src/lib/avatar-photos.ts)。写真を消すボタンはない。
 * 本人 (プロフィール) と、管理者がほかの社員 (アカウントの画面。userId・returnTo) で使う
 */
export function AvatarUploader({
  name,
  id,
  hidden = false,
  current,
  previous = [],
  self = true,
  returnTo,
}: {
  name: string;
  /** 社員 ID */
  id: string;
  /** 「表示しない」にしている */
  hidden?: boolean;
  /** 今の写真 (表示しないにしていても確認用の URL で出す) */
  current?: AvatarPhotoView;
  /** 以前の写真 (新しい順) */
  previous?: AvatarPhotoView[];
  /** 本人の写真か (文言だけ変える) */
  self?: boolean;
  returnTo?: string;
}) {
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
    fd.set("userId", id);
    if (returnTo) fd.set("returnTo", returnTo);
    start(() => updateOwnAvatar(fd));
  }

  const shown = preview?.url ?? current?.src;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative shrink-0" data-testid="avatar-current" data-hidden={hidden && !preview ? "1" : undefined}>
          <span className={hidden && !preview ? "block opacity-40 grayscale" : "block"}>
            <Avatar name={name} id={id} size={72} ring src={shown} />
          </span>
          {hidden && !preview && (
            <span className="absolute -bottom-1 left-1/2 inline-flex -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-full bg-ink-2 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              <EyeOff className="h-3 w-3" aria-hidden /> 非表示
            </span>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()} disabled={pending}>
              <Camera className="h-4 w-4" /> {current || preview ? "新しい写真を選ぶ" : "写真を選ぶ"}
            </Button>
            {preview && (
              <Button type="button" size="sm" onClick={save} disabled={pending}>
                {pending ? "保存中…" : "この写真で保存"}
              </Button>
            )}
            {preview && (
              <Button type="button" size="sm" variant="ghost" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(undefined); }} disabled={pending}>
                やめる
              </Button>
            )}
            {current && !preview && !hidden && (
              <Button type="button" size="sm" variant="ghost" onClick={() => start(() => setAvatarVisible(id, false))} disabled={pending} data-testid="avatar-hide">
                <EyeOff className="h-4 w-4" /> 表示しない
              </Button>
            )}
            {current && !preview && hidden && (
              <Button type="button" size="sm" onClick={() => start(() => setAvatarVisible(id, true))} disabled={pending} data-testid="avatar-show">
                <Eye className="h-4 w-4" /> 表示する
              </Button>
            )}
          </div>
          {hidden && !preview && (
            <p className="text-xs text-warn-ink">
              いまは顔写真を表示していません (名前の 1 文字の丸で表示しています)。写真は残っているので「表示する」でいつでも戻せます。
            </p>
          )}
          {current && !preview && <p className="text-[11px] text-ink-3">今の写真: {current.label}</p>}
          <p className="text-[11px] leading-relaxed text-ink-3">
            中央を正方形に切り抜き、256px に縮小して保存します。{self ? "ヘッダーや担当者の表示に使われます。" : "ヘッダー・予定表・チャットなどの担当者の表示に使われます。"}
            写真は削除されません。「表示しない」にしても、新しい写真に変えても、元の写真は残り、あとからいつでも表示に戻せます。
          </p>
          {error && <p role="alert" className="text-xs text-critical-ink">{error}</p>}
        </div>
      </div>

      {previous.length > 0 && (
        <div data-testid="avatar-previous">
          <p className="mb-2 flex items-center gap-1 text-xs font-semibold text-ink-2">
            <History className="h-3.5 w-3.5" aria-hidden /> 以前の写真 ({previous.length})
          </p>
          <ul className="flex flex-wrap gap-3">
            {previous.map((p) => (
              <li key={p.id} className="flex w-[92px] flex-col items-center gap-1 text-center">
                <Avatar name={name} id={id} size={48} src={p.src} />
                <span className="line-clamp-2 text-[10px] leading-tight text-ink-3" title={p.label}>{p.label}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => start(() => restoreAvatar(id, p.id))} disabled={pending} data-testid="avatar-restore">
                  <RotateCcw className="h-3.5 w-3.5" /> この写真に戻す
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
