import "server-only";
import { randomBytes } from "node:crypto";
import { putObject, readObject, removeObjects } from "@/lib/storage";
import type { SheetMonth } from "./parse";

/**
 * 予定表の取込の「読み込んだ月のファイル」(読み取った予定) をサーバーのディスクに一時保存する (storage.ts の imports/schedule-sheet/)。
 * 1 回の取込 (batch) に月のファイルを 1 つずつ足していき (1 回の送信は 1 ファイル。サーバーの受け取りの上限のため)、
 * 画面は保存した月から照合の計画を毎回作り直す。取り込んだら消す
 */

export const BATCH_RE = /^[0-9a-f]{16}$/;
const dir = (batch: string) => `imports/schedule-sheet/${batch}`;

export interface SheetBatchIndex {
  batch: string;
  by: string;
  at: string;
  /** 月 (YYYY-MM) → 読み込んだファイルの名前 */
  months: Record<string, { label: string; file: string; at: string; days: number; events: number; problems: string[] }>;
}

export const newBatchId = (): string => randomBytes(8).toString("hex");

/** 一時保存のファイルを書き直す (storage.ts は上書きしないので、消してから書く。読み込みは 1 ファイルずつ順に送るので重ならない) */
async function replaceObject(key: string, body: Buffer): Promise<void> {
  await removeObjects([key]);
  await putObject(key, body);
}
const monthKey = (m: Pick<SheetMonth, "year" | "month">) => `${m.year}-${String(m.month).padStart(2, "0")}`;

export async function readBatchIndex(batch: string): Promise<SheetBatchIndex | null> {
  if (!BATCH_RE.test(batch)) return null;
  const buf = await readObject(`${dir(batch)}/index.json`).catch(() => null);
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString("utf8")) as SheetBatchIndex;
    return v && typeof v.months === "object" ? v : null;
  } catch {
    return null;
  }
}

/** 月のファイルを 1 つ足す (同じ月は置き換え) */
export async function addMonthToBatch(batch: string, by: string, file: string, month: SheetMonth): Promise<SheetBatchIndex> {
  if (!BATCH_RE.test(batch)) throw new Error("取込の番号が正しくありません");
  const idx = (await readBatchIndex(batch)) ?? { batch, by, at: new Date().toISOString(), months: {} };
  const key = monthKey(month);
  await replaceObject(`${dir(batch)}/${key}.json`, Buffer.from(JSON.stringify(month)));
  idx.months[key] = { label: month.label, file: file.slice(0, 120), at: new Date().toISOString(), days: month.days.length, events: month.events.length, problems: month.problems.slice(0, 20) };
  await replaceObject(`${dir(batch)}/index.json`, Buffer.from(JSON.stringify(idx)));
  return idx;
}

/** 読み込んだ月 (年・月の順) */
export async function readBatchMonths(batch: string): Promise<{ index: SheetBatchIndex; months: SheetMonth[] } | null> {
  const index = await readBatchIndex(batch);
  if (!index) return null;
  const months: SheetMonth[] = [];
  for (const key of Object.keys(index.months).sort()) {
    const buf = await readObject(`${dir(batch)}/${key}.json`).catch(() => null);
    if (!buf) continue;
    try {
      months.push(JSON.parse(buf.toString("utf8")) as SheetMonth);
    } catch {
      /* 壊れた月は読まない */
    }
  }
  return { index, months };
}

/** 月を 1 つ外す */
export async function removeMonthFromBatch(batch: string, key: string): Promise<void> {
  const idx = await readBatchIndex(batch);
  if (!idx || !/^\d{4}-\d{2}$/.test(key)) return;
  delete idx.months[key];
  await removeObjects([`${dir(batch)}/${key}.json`]).catch(() => undefined);
  await replaceObject(`${dir(batch)}/index.json`, Buffer.from(JSON.stringify(idx)));
}

export async function removeBatch(batch: string): Promise<void> {
  const idx = await readBatchIndex(batch);
  if (!idx) return;
  await removeObjects([...Object.keys(idx.months).map((k) => `${dir(batch)}/${k}.json`), `${dir(batch)}/index.json`]).catch(() => undefined);
}
