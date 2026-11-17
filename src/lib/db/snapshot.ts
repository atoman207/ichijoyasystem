import "server-only";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TABLES } from "./schema";
import { DATA_VERSION } from "./migrate";

/**
 * データの控え (このサーバーのディスク)。再起動のたびに Supabase から全件 (約 10 万行) を読み直さないためのもの
 * ------------------------------------------------------------
 * - 中身: あるリビジョンの時点の全テーブルの行 (gzip の 1 行 1 レコード)。バックアップではない (バックアップは deploy/backup.sh)
 * - 起動時: 控えを読み、そのリビジョンの変更の記録 (app_changes) の時刻が控えと一致するときだけ使う。
 *   そのあとの変更は変更の記録から取り直す。一致しない・古すぎる・表の定義が変わったときは Supabase から全件を読む
 * - 保存: 全件の読み込みのあとと、10 分ごと (変更があったとき)
 * - 置き場所: DB_CACHE_DIR。なければ本番サーバーは /srv/ichijoya/data/cache、それ以外は data/cache。
 *   DB_SNAPSHOT=off で使わない
 */

export interface SnapshotHeader {
  v: 1;
  revision: number;
  /** そのリビジョンの変更の記録の時刻 (データベースを復元したときなどに、控えが使えるかを確かめる) */
  loggedAt: string;
  savedAt: string;
  schema: string;
  meta: Record<string, unknown>;
}

export function snapshotEnabled(): boolean {
  return !/^(off|false|0|no)$/i.test(process.env.DB_SNAPSHOT?.trim() ?? "");
}

function snapshotFile(): string {
  const env = process.env.DB_CACHE_DIR?.trim();
  const dir = env ? path.resolve(env) : fs.existsSync("/srv/ichijoya") ? "/srv/ichijoya/data/cache" : path.join(process.cwd(), "data", "cache");
  return path.join(dir, `db-${process.env.NODE_ENV === "production" ? "production" : "development"}.ndjson.gz`);
}

/** 表の定義 (列が増えた・変わったら控えは使わない) */
export function schemaHash(): string {
  const h = createHash("sha256");
  h.update(String(DATA_VERSION));
  for (const t of TABLES) h.update(`${t.collection}|${t.table}|${t.columns.map(([f, s]) => `${f}:${s}`).join(",")}\n`);
  return h.digest("hex").slice(0, 16);
}

/** 控えを書く (一時ファイルに書いてから名前を変える)。rows: [コレクション, 行の JSON 文字列の一覧] */
export async function writeSnapshot(header: SnapshotHeader, rows: [string, string[]][]): Promise<number> {
  const file = snapshotFile();
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  function* lines() {
    yield JSON.stringify(header) + "\n";
    for (const [name, list] of rows) {
      // 1 行ずつ渡すと遅いため、ある程度まとめて渡す
      let buf = "";
      for (const s of list) {
        buf += `${name}\t${s}\n`;
        if (buf.length > 1 << 20) {
          yield buf;
          buf = "";
        }
      }
      if (buf) yield buf;
    }
  }
  try {
    await pipeline(Readable.from(lines()), zlib.createGzip({ level: 4 }), fs.createWriteStream(tmp, { mode: 0o600 }));
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return (await fsp.stat(file)).size;
}

/** 控えを読む (ない・壊れている・表の定義が違うときは null) */
export async function readSnapshot(): Promise<{ header: SnapshotHeader; rows: Map<string, string[]> } | null> {
  const file = snapshotFile();
  if (!fs.existsSync(file)) return null;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let header: SnapshotHeader | null = null;
    const rows = new Map<string, string[]>(TABLES.map((t) => [t.collection, []]));
    for await (const line of rl) {
      if (!header) {
        header = JSON.parse(line) as SnapshotHeader;
        if (header.v !== 1 || header.schema !== schemaHash()) {
          rl.close();
          return null;
        }
        continue;
      }
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const list = rows.get(line.slice(0, tab));
      if (list) list.push(line.slice(tab + 1));
    }
    return header ? { header, rows } : null;
  } catch (err) {
    console.warn("[db] snapshot unreadable, ignoring:", (err as Error).message);
    return null;
  }
}
