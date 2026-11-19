import "server-only";
import crypto from "node:crypto";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";

/**
 * 住宅地図の PDF の確認 (登録・一括取込の前に必ず通す)
 * ------------------------------------------------------------
 * - 種類: 先頭 1024 バイト以内に「%PDF-」、末尾 2048 バイト以内に「%%EOF」(途中までしか保存されていないファイルを断る)
 * - 大きさ: 9 MB まで (nginx の 1 回の送信の上限 10 MB の内側)
 * - 中身: pdf-lib で読めること (壊れていないこと) とページ数。暗号化 (印刷・コピーの制限) された PDF も受け付ける
 * - 危険な中身 (JavaScript・外部プログラムの起動・埋め込みファイル・リッチメディア) を含む PDF は断る
 *   (社内の画面でそのまま表示するため。住宅地図の PDF には通常含まれない)
 */

export const MAP_PDF_MAX_BYTES = 9 * 1024 * 1024;
const BAD_NAMES = new Set(["/JavaScript", "/JS", "/Launch", "/EmbeddedFile", "/EmbeddedFiles", "/RichMedia", "/XFA"]);

export interface PdfInspection {
  ok: boolean;
  error?: string;
  sha256: string;
  size: number;
  pages?: number;
  encrypted?: boolean;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function scanForBadNames(doc: PDFDocument): string | null {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    const stack: unknown[] = dict ? [dict] : obj instanceof PDFArray ? [obj] : [];
    let guard = 0;
    while (stack.length && guard++ < 2000) {
      const cur = stack.pop();
      if (cur instanceof PDFDict) {
        for (const [k, v] of cur.entries()) {
          if (BAD_NAMES.has(k.asString())) return k.asString();
          if (v instanceof PDFName && BAD_NAMES.has(v.asString())) return v.asString();
          if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v);
        }
      } else if (cur instanceof PDFArray) {
        for (const v of cur.asArray()) {
          if (v instanceof PDFName && BAD_NAMES.has(v.asString())) return v.asString();
          if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v);
        }
      }
    }
  }
  return null;
}

export async function inspectPdf(bytes: Buffer, maxBytes = MAP_PDF_MAX_BYTES): Promise<PdfInspection> {
  const base = { sha256: sha256(bytes), size: bytes.length };
  if (bytes.length === 0) return { ...base, ok: false, error: "空のファイルです。" };
  if (bytes.length > maxBytes) return { ...base, ok: false, error: `${(bytes.length / 1048576).toFixed(1)} MB あります。1 ファイル ${Math.floor(maxBytes / 1048576)} MB までにしてください (住宅地図は必要なページだけを PDF にしてください)。` };
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) return { ...base, ok: false, error: "PDF ではありません (ファイルの中身が PDF の形式ではありません)。" };
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) return { ...base, ok: false, error: "PDF の終わりがありません。ダウンロードや保存が途中で止まった可能性があります。元のファイルを確認してください。" };
  // 圧縮されていない部分の文字列で先に確かめる (速い)
  const raw = bytes.toString("latin1");
  for (const name of ["/JavaScript", "/Launch", "/EmbeddedFile", "/RichMedia"]) {
    if (raw.includes(name)) return { ...base, ok: false, error: `PDF に ${name.slice(1)} が含まれているため登録できません (スクリプト・埋め込みファイルを含む PDF は社内で開くと危険なため)。` };
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (err) {
    return { ...base, ok: false, error: `PDF を読み込めません。ファイルが壊れている可能性があります (${(err as Error).message.slice(0, 80)})。` };
  }
  const pages = doc.getPageCount();
  if (pages < 1) return { ...base, ok: false, error: "PDF にページがありません。" };
  const bad = scanForBadNames(doc);
  if (bad) return { ...base, ok: false, error: `PDF に ${bad.slice(1)} が含まれているため登録できません (スクリプト・埋め込みファイルを含む PDF は社内で開くと危険なため)。` };
  return { ...base, ok: true, pages, encrypted: doc.isEncrypted };
}
