/**
 * ブラウザ側の写真の前処理 (送信前に縮小する)
 * ------------------------------------------------------------
 * - スマートフォンの写真 (3〜8 MB・1,200 万画素など) は、長い辺 2,576px かつ 375 万画素までの JPEG に縮小して送る。
 *   手書きの見積書の細い字・小さな数字を AI が読めるように、AI (Claude) が縮小せずに読む上限の大きさにそろえる
 *   (以前は長い辺 2,048px。お客様のご要望 2026-11-26「■1」で手書き見積書の読み取りの精度を上げるため)
 * - 送信の上限 (書類取込は 1 回 4 MB) に収まるように、縮小した写真が 3.5 MB を超えたら画質を下げて作り直す
 * - 一覧用の縮小画像 (長辺 480px) も作る
 * - 撮影日時は Exif の DateTimeOriginal (なければファイルの更新日時)。縮小すると Exif (位置情報を含む) は消える
 */

/** 長い辺の上限 (px) */
export const MAX_EDGE = 2576;
/** 画素数の上限 (375 万画素。4:3 の写真なら 2,236 × 1,677) */
export const MAX_PIXELS = 3_750_000;
/** 縮小した写真の大きさの上限 (送信の上限 4 MB より小さく) */
export const MAX_OUT_BYTES = 3.5 * 1024 * 1024;
const THUMB_EDGE = 480;
/** これより小さく、大きさ (長い辺・画素数) が上限の中の写真は縮小せずにそのまま送る */
const KEEP_BYTES = 1.5 * 1024 * 1024;
/** 画質 (大きすぎたら順に下げる) */
const QUALITIES = [0.88, 0.8, 0.72];

/** 送る写真の大きさ (長い辺と画素数の上限に収める。縦横比はそのまま。大きくはしない) */
export function fitSize(width: number, height: number, maxEdge = MAX_EDGE, maxPixels = MAX_PIXELS): { width: number; height: number; scale: number } {
  if (!(width > 0 && height > 0)) return { width: Math.max(1, Math.round(width) || 1), height: Math.max(1, Math.round(height) || 1), scale: 1 };
  const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

export interface PreparedFile {
  file: File;
  thumb?: Blob;
  width?: number;
  height?: number;
  takenAt?: string;
}

const RESIZABLE = ["image/jpeg", "image/png", "image/webp"];

export async function prepareFile(file: File): Promise<PreparedFile> {
  const takenAt = (await readExifDate(file)) ?? (file.lastModified ? new Date(file.lastModified).toISOString() : undefined);
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return { file, takenAt };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // HEIC など、このブラウザで読めない画像はそのまま送る
    return { file, takenAt };
  }
  const { width, height } = bmp;
  try {
    const thumb = await draw(bmp, fitSize(width, height, THUMB_EDGE, Infinity), 0.72);
    const size = fitSize(width, height);
    if (!RESIZABLE.includes(file.type) || (file.size <= KEEP_BYTES && size.scale === 1)) {
      return { file, thumb, width, height, takenAt };
    }
    // 大きすぎたら画質を下げ、それでも大きければ 8 割の大きさにして作り直す
    let target = size;
    let blob = await draw(bmp, target, QUALITIES[0]);
    for (let i = 1; blob.size > MAX_OUT_BYTES && i < QUALITIES.length; i++) blob = await draw(bmp, target, QUALITIES[i]);
    for (let n = 0; blob.size > MAX_OUT_BYTES && n < 3; n++) {
      target = fitSize(target.width * 0.8, target.height * 0.8, Infinity, Infinity);
      blob = await draw(bmp, target, QUALITIES[QUALITIES.length - 1]);
    }
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return { file: new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified }), thumb, width: target.width, height: target.height, takenAt };
  } finally {
    bmp.close();
  }
}

async function draw(bmp: ImageBitmap, size: { width: number; height: number }, quality: number): Promise<Blob> {
  const w = Math.max(1, Math.round(size.width));
  const h = Math.max(1, Math.round(size.height));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", quality));
}

/** JPEG の Exif から撮影日時 (DateTimeOriginal、なければ DateTime) を読む。読めなければ undefined */
export async function readExifDate(file: File): Promise<string | undefined> {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return undefined;
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return undefined;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off);
      const len = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) return parseTiff(buf, off + 10);
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch {
    // 壊れた Exif は無視する
  }
  return undefined;
}

function parseTiff(v: DataView, start: number): string | undefined {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o: number) => v.getUint16(start + o, little);
  const u32 = (o: number) => v.getUint32(start + o, little);
  const ascii = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(start + o + i));
    return s;
  };
  const readIfd = (ifd: number, want: number[]): Record<number, string | number> => {
    const out: Record<number, string | number> = {};
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      if (!want.includes(tag)) continue;
      const type = u16(e + 2);
      const n = u32(e + 4);
      out[tag] = type === 2 ? ascii(n > 4 ? u32(e + 8) : e + 8, n) : u32(e + 8);
    }
    return out;
  };
  const ifd0 = readIfd(u32(4), [0x0132, 0x8769]);
  const exif = typeof ifd0[0x8769] === "number" ? readIfd(ifd0[0x8769] as number, [0x9003]) : {};
  const raw = (exif[0x9003] ?? ifd0[0x0132]) as string | undefined;
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return undefined;
  // Exif の時刻はタイムゾーンを持たない (撮影した端末の現地時刻)。日本で撮影した前提で +09:00 とする
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`).toISOString();
}
