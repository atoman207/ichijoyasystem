import "server-only";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { Database } from "@/lib/db/types";
import { TABLES } from "@/lib/db/schema";
import { storageDir } from "@/lib/storage";
import { diffRows, groupPlan, parseWhen, readCarryoverReview, type CarryGroupPlan, type CarryoverReview } from "@/lib/carryover";

/**
 * 画面 (データ入出力 → 本番への引き継ぎ /data/carryover) の計算。テスト用のサーバー (試験期間) で、
 * いまのデータベース (= テスト用のデータベース) と期間の始まりの本番の控えを比べる。計算は src/lib/carryover.ts (12/1 の引き継ぎの道具と同じ)。
 * 控えは 1 行ずつ読む (データの写しをもう 1 つメモリに持たない)。結果は 60 秒、データが変わらない間は使い回す
 */

const BACKUPS = "/var/backups/ichijoya";

/** 試験期間のテスト用のデータベースか (testweek-data.py build が meta.testWeek を付ける) */
export function isTestWeekDb(db: Pick<Database, "meta">): boolean {
  return (db.meta as Record<string, unknown> | undefined)?.testWeek === true;
}

/** 期間の始まりの本番の控え (CARRYOVER_BASELINE か /var/backups/ichijoya/testweek-baseline-*.ndjson.gz の新しいもの) */
export function baselineFile(): string | null {
  const env = process.env.CARRYOVER_BASELINE?.trim();
  if (env) return fs.existsSync(env) ? env : null;
  try {
    const f = fs.readdirSync(BACKUPS).filter((n) => /^testweek-baseline-.*\.ndjson\.gz$/.test(n)).sort().pop();
    return f ? path.join(BACKUPS, f) : null;
  } catch {
    return null;
  }
}

export interface CarryoverView {
  plan: CarryGroupPlan;
  review: CarryoverReview;
  baseline: { file: string; savedAt?: string; revision?: number };
  /** テスト用のデータベースの元と控えが違う (別の控え) */
  mismatch: boolean;
  files: number;
  computedAt: string;
}

const gv = globalThis as typeof globalThis & { __ichijoyaCarryover?: { key: string; at: number; view: CarryoverView } };

function fingerprint(db: Database, file: string): string {
  const st = fs.statSync(file);
  const rv = db.settings.find((s) => s.id === "carryover_review")?.updatedAt ?? "";
  const lens = TABLES.map((t) => ((db as unknown as Record<string, unknown[]>)[t.collection] ?? []).length).join(".");
  const lastLog = db.auditLogs[db.auditLogs.length - 1]?.id ?? "";
  return `${file}:${st.mtimeMs}:${lens}:${lastLog}:${rv}`;
}

export async function carryoverView(db: Database): Promise<CarryoverView | { error: string }> {
  const file = baselineFile();
  if (!file) return { error: "期間の始まりの本番の控え (testweek-baseline-*.ndjson.gz) が見つかりません。" };
  const key = fingerprint(db, file);
  const cached = gv.__ichijoyaCarryover;
  if (cached && cached.key === key && Date.now() - cached.at < 60_000) return cached.view;
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  const first = await it.next();
  const head = (first.done ? {} : JSON.parse(first.value)) as { savedAt?: string; revision?: number };
  async function* lines(): AsyncGenerator<[string, { id: string } & Record<string, unknown>]> {
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      if (!n.value) continue;
      const t = n.value.indexOf("\t");
      yield [n.value.slice(0, t), JSON.parse(n.value.slice(t + 1))];
    }
  }
  const test = db as unknown as Record<string, unknown>;
  const meta = (db.meta ?? {}) as Record<string, unknown>;
  const review = readCarryoverReview(test);
  const since = parseWhen(review.since) ?? (typeof meta.copiedAt === "string" ? new Date(meta.copiedAt).toISOString() : null);
  const until = parseWhen(review.until, true);
  const diff = await diffRows(TABLES, lines(), test);
  const plan = groupPlan(TABLES, diff, test, { since, until, settings: review.settings, review });
  const dir = storageDir();
  const files = plan.fileCandidates.filter((k) => {
    try {
      return fs.statSync(path.join(dir, k)).isFile();
    } catch {
      return false;
    }
  }).length;
  const view: CarryoverView = { plan, review, baseline: { file, savedAt: head.savedAt, revision: head.revision }, mismatch: Boolean(meta.copyOfSavedAt && head.savedAt && meta.copyOfSavedAt !== head.savedAt), files, computedAt: new Date().toISOString() };
  gv.__ichijoyaCarryover = { key, at: Date.now(), view };
  return view;
}
