import "server-only";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MapDocument } from "@/lib/db/types";
import { readObject, storageDir } from "@/lib/storage";

/**
 * 住宅地図の PDF のページを画像 (PNG) にする (お客様のご要望 2026-11-24「① 登録済みPDF地図の表示」)
 * ------------------------------------------------------------
 * PDF をそのまま開くと、ホーム画面のアプリ (戻るボタンがない)・スマートフォンの新しいタブ (戻る履歴がない)・
 * Android (PDF を表示できず別のアプリで開く) で、元の画面に戻れなくなる。
 * そのため地図はシステムの画面 (/maps/documents/<ID>) の中に画像で出し、「元の画面に戻る」を置く。
 * 画像は poppler の pdftoppm で作る (サーバーに入っているとき。ないときは画面が PDF の表示に切り替える)。
 * 作った画像は控え (MAP_RENDER_CACHE_DIR。なければ保存先の隣の map-render-cache) に置き、2 回目からはそれを返す。
 * 控えのファイル名に PDF の SHA-256 を入れるので、中身が違えば作り直す。取り消した地図の控えは purgeMapRender で消す。
 * 控えはバックアップの対象外 (いつでも PDF から作り直せる)
 */

/** 画像の幅 (px): preview = 画面のカードの小さな表示 / view = 地図の画面 */
export const RENDER_WIDTH = { preview: 800, view: 2000 } as const;
export type RenderSize = keyof typeof RENDER_WIDTH;

/** 1 つの PDF で画像にするページの上限 (地図は 1〜数ページ。大きな PDF でサーバーを止めない) */
export const MAX_RENDER_PAGES = 20;

export function renderCacheDir(): string {
  const env = process.env.MAP_RENDER_CACHE_DIR?.trim();
  return env ? path.resolve(env) : path.join(/*turbopackIgnore: true*/ path.dirname(storageDir()), "map-render-cache");
}

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "");

function cacheFile(doc: MapDocument, page: number, size: RenderSize): string {
  return path.join(/*turbopackIgnore: true*/ renderCacheDir(), safeId(doc.id), `${(doc.sha256 || "x").slice(0, 16)}-p${page}-${RENDER_WIDTH[size]}.png`);
}

let available: Promise<boolean> | undefined;
/** pdftoppm が使えるか (1 回だけ確かめる) */
export function rendererAvailable(): Promise<boolean> {
  available ??= new Promise((resolve) => {
    execFile("pdftoppm", ["-v"], { timeout: 5000 }, (err) => resolve(!err || (err as NodeJS.ErrnoException).code !== "ENOENT"));
  });
  return available;
}

/* 同時に動かすのは 2 つまで (大きな PDF を何人もが同時に開いても、メモリを使い切らない) */
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function pdftoppm(pdf: Buffer, page: number, width: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("pdftoppm", ["-png", "-f", String(page), "-l", String(page), "-scale-to-x", String(width), "-scale-to-y", "-1", "-singlefile", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 60 * 1024 * 1024) child.kill("SIGKILL");
      else out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 2000) err += b.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const png = Buffer.concat(out);
      if (code === 0 && png.length > 8 && png[0] === 0x89 && png[1] === 0x50) resolve(png);
      else reject(new Error(`pdftoppm が失敗しました (${code ?? "中断"}) ${err.trim().slice(0, 200)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(pdf);
  });
}

/**
 * PDF の 1 ページを PNG にする (控えがあればそれを返す)。
 * null = PDF の本体がない。例外 = 画像にできない (pdftoppm がない・壊れた PDF・時間切れ)
 */
export async function renderMapPage(doc: MapDocument, page: number, size: RenderSize): Promise<Buffer | null> {
  if (!doc.storageKey) return null;
  const file = cacheFile(doc, page, size);
  const hit = await fsp.readFile(/*turbopackIgnore: true*/ file).catch(() => null);
  if (hit) return hit;
  const pdf = await readObject(doc.storageKey);
  if (!pdf) return null;
  const png = await slot(() => pdftoppm(pdf, page, RENDER_WIDTH[size]));
  // 控えに置く (一時ファイル → 名前の変更。失敗しても画像は返す)
  try {
    await fsp.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o750 });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await fsp.writeFile(/*turbopackIgnore: true*/ tmp, png, { mode: 0o640 });
    await fsp.rename(tmp, file);
  } catch (err) {
    console.warn("[maps] render cache write failed:", (err as Error).message);
  }
  return png;
}

/** 地図を取り消したとき: 控えの画像も消す */
export async function purgeMapRender(docId: string): Promise<void> {
  const id = safeId(docId);
  if (!id) return;
  await fsp.rm(path.join(/*turbopackIgnore: true*/ renderCacheDir(), id), { recursive: true, force: true }).catch(() => undefined);
}

/** ページの番号を 1〜ページ数 (上限 MAX_RENDER_PAGES) に収める。範囲外は null */
export function pageNumber(raw: string | null | undefined, doc: Pick<MapDocument, "pageCount">): number | null {
  const n = Number(raw ?? "1");
  if (!Number.isInteger(n) || n < 1) return null;
  const max = Math.min(MAX_RENDER_PAGES, Math.max(1, doc.pageCount ?? 1));
  return n <= max ? n : null;
}
