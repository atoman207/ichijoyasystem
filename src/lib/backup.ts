import "server-only";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * バックアップ (このサーバー = VPS に保存する)
 * ------------------------------------------------------------
 * 実行するのは deploy/backup.sh (毎日 3:30 の自動実行と同じもの): データベース (pg_dump)・添付ファイル・写真・
 * チャットボットを /var/backups/ichijoya に保存する。管理者は 設定 → データ管理 からいつでも実行できる。
 * 画面は結果のファイル (backup-status.json・backup-history.jsonl) とバックアップのフォルダーを読むだけ
 */

const env = (k: string) => (process.env[k] ?? "").trim();

export function backupDir(): string {
  return env("BACKUP_DIR") || "/var/backups/ichijoya";
}

function statusFile(): string {
  return env("BACKUP_STATUS_FILE") || "/var/lib/ichijoya/backup-status.json";
}

function historyFile(): string {
  return path.join(path.dirname(statusFile()), "backup-history.jsonl");
}

function scriptPath(): string {
  return path.join(process.cwd(), "deploy", "backup.sh");
}

export interface BackupStatus {
  at: string;
  startedAt?: string;
  status: "ok" | "failed" | "running";
  trigger?: "auto" | "manual";
  by?: string;
  pid?: number;
  dbFile?: string;
  dbBytes?: number;
  files?: number;
  filesBytes?: number;
  kept?: number;
  diskUsed?: string;
  seconds?: number;
  message?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 最後のバックアップ (実行中ならその状態)。実行中のまま止まったもの (再起動など) は失敗として扱う */
export function readBackupStatus(): BackupStatus | null {
  const s = readJson<BackupStatus>(statusFile());
  if (!s) return null;
  if (s.status === "running" && !alive(s.pid)) return { ...s, status: "failed", message: "途中で止まりました (サーバーの再起動など)。もう一度実行してください" };
  return s;
}

/** 最近の実行結果 (新しい順) */
export function backupHistory(limit = 10): BackupStatus[] {
  try {
    const lines = fs.readFileSync(historyFile(), "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as BackupStatus;
        } catch {
          return null;
        }
      })
      .filter((x): x is BackupStatus => Boolean(x));
  } catch {
    return [];
  }
}

export interface BackupFile {
  name: string;
  bytes: number;
  at: string;
  manual: boolean;
}

/** 保存してあるデータベースのバックアップ (新しい順) */
export function listBackups(): BackupFile[] {
  const dir = path.join(backupDir(), "db");
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^ichijoya-.*\.dump$/.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, bytes: st.size, at: st.mtime.toISOString(), manual: name.endsWith("-manual.dump") };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** 保存してあるチャットボットのバックアップ (新しい順) */
export function listChatbotBackups(): BackupFile[] {
  const dir = path.join(backupDir(), "chatbot");
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^chatbot-[\w-]+\.sqlite$/.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, bytes: st.size, at: st.mtime.toISOString(), manual: false };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** 添付ファイル・写真のバックアップ (storage/) のファイル数と大きさ */
export function storageBackupStats(): { files: number; bytes: number } | null {
  const root = path.join(backupDir(), "storage");
  if (!fs.existsSync(root)) return null;
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  };
  try {
    walk(root);
    return { files, bytes };
  } catch {
    return null;
  }
}

/**
 * ダウンロードできるバックアップのファイル (データベース・チャットボット)。
 * 一覧にある名前と完全に一致するものだけを返す (../ などでほかのファイルを指定されないように)
 */
export function backupFileFor(kind: "db" | "chatbot", name: string): { path: string; name: string; bytes: number } | null {
  const f = (kind === "db" ? listBackups() : listChatbotBackups()).find((x) => x.name === name);
  // バックアップの保存先 (BACKUP_DIR) はアプリの外。ビルドのファイルの追跡 (トレース) の対象にしない
  return f ? { path: path.join(/*turbopackIgnore: true*/ backupDir(), kind, f.name), name: f.name, bytes: f.bytes } : null;
}

/** 添付ファイル・写真のバックアップ (storage/) 一式を tar.gz にして流す (その場で作る。サーバーには残さない) */
export function storageArchive(): { stream: NodeJS.ReadableStream; name: string } | null {
  const dir = path.join(backupDir(), "storage");
  if (!fs.existsSync(dir)) return null;
  const child = spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
  const d = new Date(Date.now() + 9 * 3600_000).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return { stream: child.stdout, name: `ichijoya-files-${d}.tar.gz` };
}

/** ディスクの空き (バックアップの保存先) */
export function backupDisk(): { freeBytes: number; totalBytes: number } | null {
  try {
    const st = fs.statfsSync(fs.existsSync(backupDir()) ? backupDir() : "/");
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

/** このサーバーでバックアップを実行できるか (VPS の設定ファイル・スクリプト・保存先がそろっているか) */
export function backupAvailable(): { ok: true } | { ok: false; reason: string } {
  if (env("VERCEL") === "1") return { ok: false, reason: "Vercel では実行できません (サーバー = VPS でのみ使えます)" };
  if (!fs.existsSync(scriptPath())) return { ok: false, reason: "バックアップのスクリプト (deploy/backup.sh) が見つかりません" };
  try {
    fs.accessSync("/etc/ichijoya/ichijoya.env", fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "サーバーの設定ファイル (/etc/ichijoya/ichijoya.env) を読めません (VPS でのみ使えます)" };
  }
  try {
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.accessSync(backupDir(), fs.constants.W_OK);
  } catch {
    return { ok: false, reason: `保存先 ${backupDir()} に書き込めません` };
  }
  return { ok: true };
}

/** バックアップを始める (終わるのを待たない。結果は状態のファイルに出る) */
export function startBackup(byName: string): { ok: true } | { ok: false; error: string } {
  const avail = backupAvailable();
  if (!avail.ok) return { ok: false, error: avail.reason };
  const cur = readBackupStatus();
  if (cur?.status === "running") return { ok: false, error: "バックアップを実行中です。終わるまでお待ちください。" };
  let out: number | "ignore" = "ignore";
  try {
    fs.mkdirSync("/var/log/ichijoya", { recursive: true });
    out = fs.openSync("/var/log/ichijoya/backup.log", "a");
  } catch {
    out = "ignore";
  }
  try {
    const child = spawn("bash", [scriptPath(), "--manual", byName.replace(/[\r\n]/g, " ").slice(0, 60)], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    });
    child.on("error", (err) => console.error("[backup] failed to start:", err.message));
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `バックアップを開始できませんでした: ${(err as Error).message}` };
  } finally {
    if (typeof out === "number") fs.closeSync(out);
  }
}
