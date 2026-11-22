import "server-only";
import { PDFDocument } from "pdf-lib";

/**
 * 地図の画像 (ゼンリン GIS の「画像出力」でコピー・保存した画像など) を 1 ページの PDF にする
 * ------------------------------------------------------------
 * 住宅地図は PDF で保存・表示する (src/lib/maps/pdf.ts の確認・プレビュー・ダウンロードを共通にするため)。
 * 画像は画素を変えずに PDF に入れる (縮小・再圧縮しない)。用紙は画像の縦横の比のまま、A3 に収まる大きさにする。
 * 同じ画像からは同じ PDF ができる (作成日時を入れない) ので、同じ地図の二重登録の確認 (SHA-256) が使える
 */

export type MapImageKind = "png" | "jpeg";

/** ファイルの先頭のバイトで画像の種類を見分ける (拡張子・申告された種類は信用しない) */
export function detectMapImage(bytes: Uint8Array): MapImageKind | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** A3 (297 × 420 mm) の長い辺・短い辺 (ポイント) */
const A3_LONG = 1190.55;
const A3_SHORT = 841.89;

export async function imageToPdf(bytes: Uint8Array, kind: MapImageKind): Promise<{ pdf: Buffer; width: number; height: number }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const img = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const { width, height } = img;
  if (!width || !height) throw new Error("画像の大きさを読み取れません");
  // 横長は A3 横、縦長は A3 縦に収める (小さい画像は拡大しない)
  const [maxW, maxH] = width >= height ? [A3_LONG, A3_SHORT] : [A3_SHORT, A3_LONG];
  const scale = Math.min(1, maxW / width, maxH / height);
  const w = Math.round(width * scale * 100) / 100;
  const h = Math.round(height * scale * 100) / 100;
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  const out = await doc.save({ useObjectStreams: false });
  return { pdf: Buffer.from(out), width, height };
}
