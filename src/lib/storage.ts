import "server-only";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * ファイルの保存先 (添付ファイル・写真・書類取込の元画像・顔写真)
 * ------------------------------------------------------------
 * ファイルの本体はこのサーバー (VPS) のディスクにだけ保存する。Supabase (データベース) には
 * 台帳の文字の情報とファイルのパス (キー) だけを持つ (attachments.storage_key・users.avatar_key)。
 *
 * - 保存先: FILE_STORAGE_DIR。なければ本番サーバー (/srv/ichijoya がある) は /srv/ichijoya/data/uploads、
 *   それ以外 (手元の開発環境) は data/uploads。リリースのフォルダーの外に置くので、デプロイしても消えない。
 *   3000 番 (本番) と 3001 番 (開発) で同じフォルダーを使う
 * - キーは英数字だけ (<種別>/<年月>/<ID>.<拡張子>)。元のファイル名は台帳に持つ
 * - 画面からは /api/attachments/<ID> (権限を確かめてからこのフォルダーのファイルを返す)
 * - バックアップ: deploy/backup.sh がこのフォルダーを /var/backups/ichijoya/storage/ へ追加でコピーする (消したファイルも残る)
 * - 以前 Supabase Storage に置いていたファイルは scripts/ops/migrate-storage-to-vps.mjs でこのフォルダーへ移した
 */

export function storageDir(): string {
  const env = process.env.FILE_STORAGE_DIR?.trim();
  if (env) return path.resolve(env);
  if (fs.existsSync("/srv/ichijoya")) return "/srv/ichijoya/data/uploads";
  return path.join(process.cwd(), "data", "uploads");
}

function localPath(key: string): string {
  const dir = storageDir();
  const p = path.resolve(dir, key);
  if (!p.startsWith(dir + path.sep)) throw new Error("[storage] 不正なキーです");
  return p;
}

/**
 * ファイルを保存する。一時ファイルに書いてディスクへ確実に書き込んでから名前を変えるので、
 * 途中で止まっても中途半端なファイルは残らない。同じキーのファイルがあれば失敗にする (上書きしない)
 */
export async function putObject(key: string, body: Buffer): Promise<void> {
  const file = localPath(key);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fh = await fsp.open(tmp, "wx", 0o640);
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    // link は既にあると失敗する (上書きしない)。そのあと一時ファイルを消す
    await fsp.link(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`[storage] 同じキーのファイルが既にあります: ${key}`);
    throw new Error(`[storage] 保存に失敗しました: ${(err as Error).message}`);
  }
  await fsp.rm(tmp, { force: true });
}

/** 保存したファイルを読む (ないときは null) */
export async function readObject(key: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(localPath(key));
  } catch {
    return null;
  }
}

export async function removeObjects(keys: string[]): Promise<void> {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  await Promise.all(list.map((k) => fsp.rm(localPath(k), { force: true })));
}

/** 保存先の状態 (設定 → 本番運用の準備)。ファイルの数と合計の大きさ、ディスクの空き */
export async function storageStats(): Promise<{ dir: string; writable: boolean; files: number; bytes: number; freeBytes?: number }> {
  const dir = storageDir();
  let files = 0;
  let bytes = 0;
  async function walk(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !e.name.endsWith(".tmp")) {
        files++;
        bytes += (await fsp.stat(p).catch(() => null))?.size ?? 0;
      }
    }
  }
  await walk(dir);
  let writable = false;
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o750 });
    await fsp.access(dir, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  const st = await fsp.statfs(dir).catch(() => null);
  return { dir, writable, files, bytes, freeBytes: st ? st.bavail * st.bsize : undefined };
}
