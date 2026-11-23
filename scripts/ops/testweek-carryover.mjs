#!/usr/bin/env node
/**
 * 試験期間 (2026-11-23〜11-30) にテスト用のデータベースへ登録したデータを、本番のデータベースへ引き継ぐ
 * ------------------------------------------------------------
 *   node scripts/ops/testweek-carryover.mjs plan  [--since 2026-11-23] [--until 2026-11-23] [--exclude <番号・ID,...>] [--only <番号・ID,...>]
 *                                                 [--settings <設定の ID,...>] [--no-users] [--test <テスト用のデータベース>] [--base <期間の始まりの控え>] [--out <出力先>]
 *   node scripts/ops/testweek-carryover.mjs check --plan <出力先>/carryover-plan.json          … 本番のデータベースと突き合わせる (読むだけ)
 *   node scripts/ops/testweek-carryover.mjs apply --plan <出力先>/carryover-plan.json [--yes]   … 書く (--yes がなければ最後に取り消す = 予行)
 *   node scripts/ops/testweek-carryover.mjs apply --plan ... --target json:<file> --files-dest <dir> [--yes]   … JSON のデータベースに書く (試しのサーバー・確認用)
 *
 * 1. plan: テスト用のデータベースと「期間の始まりの本番の控え」(テスト用のデータベースの元になった ndjson.gz) を行ごとに比べ、
 *    期間中に増えた・変わった・消えた行を、ID の参照でつながる「まとまり」(1 件の問い合わせ・お客様・見積・受注… とその変更履歴・
 *    やりとり・写真・承認) に分ける。まとまりの最初の操作の日時が --since〜--until (日本時間の日付か日時) に入るものを引き継ぐ。
 *    --exclude / --only は まとまりの中の記録の番号 (I-2026-0001・Q-…・C-…)・ID のどれかで指定する。
 *    出力: 一覧 carryover-list.csv (Excel で開ける。引き継ぐ ○ / 引き継がない × と理由) と計画 carryover-plan.json (書く行と元の行)。
 *    - 引き継ぐ行が参照する、期間中に増えた行 (新しいお客様・仕入先など) は、ほかのまとまりでも自動で一緒に引き継ぐ (依存)
 *    - 変更履歴だけのまとまり (ログイン・閲覧) は引き継がない
 *    - 社員のパスワード・顔写真・通知先の変更は既定で引き継ぐ (--no-users で引き継がない)。社員のほかの項目は引き継がない
 *    - 設定 (settings)・店舗 (stores) の変更は --settings で ID を指定したものだけ
 *    - お客様名・件名・要約に「練習」「テスト」とある まとまりは練習として引き継がない (--keep-practice で引き継ぐ。--only で指定したものは引き継ぐ)
 * 2. check / apply: 本番のデータベース (.env.local の SUPABASE_DB_PASSWORD か SUPABASE_DB_URL。db:migrate と同じ接続) に
 *    1 つのトランザクションで、行を読む (for update) → 期間中に本番の側が変わった行・番号の重複・ファイルの重複があれば中止 →
 *    追加・更新・削除 → 書いた行を読み直して計画と照合 → 変更の記録 (record_changes。動いているサーバーは変わった行だけを取り直す) → commit。
 *    --yes がないときは最後に rollback (予行)。ファイル (写真・資料) は --yes のときだけ本番のディスク (FILE_STORAGE_DIR) へ写す
 *    (同じキーのファイルがあり中身が違えば中止。上書きしない)。結果は計画と同じ場所の carryover-result-*.json
 *
 * テスト用のデータベースの既定: 動いているテスト用のサーバーのデータ (/srv/ichijoya/testweek/data/testweek-db.json)、
 * なければ期間の終わりの控え (/var/backups/ichijoya/testweek-final-*.tar.gz の新しいもの。添付ファイルも控えから読む)。
 * 期間の始まりの控えの既定: /var/backups/ichijoya/testweek-baseline-*.ndjson.gz の新しいもの。
 * 手順は deploy/README.md の「試験期間のデータを本番に引き継ぐ」。テストは npm run test:carryover
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TABLES, snake } from "../../src/lib/db/schema.ts";
import { KIND_JA, SPECIAL_JA, USER_FIELDS, canonField, canonRow, carryoverCsv, diffRows, groupPlan, jst, normValue, parseWhen, readCarryoverReview, stable } from "../../src/lib/carryover.ts";

export { USER_FIELDS, canonRow, parseWhen };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKUPS = "/var/backups/ichijoya";
const LIVE_TEST = "/srv/ichijoya/testweek/data/testweek-db.json";

const DEFS = new Map(TABLES.map((t) => [t.collection, t]));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- 引数・読み込み

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) a._.push(s);
    else if (["--yes", "--no-users", "--json", "--quiet", "--keep-practice", "--ignore-review"].includes(s)) a[s.slice(2)] = true;
    else a[s.slice(2)] = argv[++i];
  }
  return a;
}

const list = (s) => (Array.isArray(s) ? s : s ? String(s).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : []);

function newest(dir, re) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => re.test(n)).sort().pop();
  return f ? path.join(dir, f) : null;
}

/** 期間の始まりの控え (ndjson.gz: 1 行目が見出し、2 行目から「コレクション<TAB>行の JSON」) の見出しと、行を 1 行ずつ返すもの */
export async function openBase(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  const first = await it.next();
  const head = first.done ? {} : JSON.parse(first.value);
  async function* lines() {
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      if (!n.value) continue;
      const t = n.value.indexOf("\t");
      yield [n.value.slice(0, t), JSON.parse(n.value.slice(t + 1))];
    }
  }
  return { head, lines: lines() };
}

/** テスト用のデータベース: JSON か、期間の終わりの控え (tar.gz。testweek-db.json と uploads/) */
function readTest(file, workDir) {
  if (/\.tar\.gz$|\.tgz$/.test(file)) {
    const dir = fs.mkdtempSync(path.join(workDir, "extract-"));
    execFileSync("tar", ["-xzf", file, "-C", dir], { stdio: "inherit" });
    const db = path.join(dir, "testweek-db.json");
    if (!fs.existsSync(db)) throw new Error(`${file} に testweek-db.json がありません`);
    return { db: JSON.parse(fs.readFileSync(db, "utf8")), files: path.join(dir, "uploads"), sha: sha256(fs.readFileSync(file)) };
  }
  const buf = fs.readFileSync(file);
  return { db: JSON.parse(buf.toString("utf8")), files: path.join(path.dirname(file), "uploads"), sha: sha256(buf) };
}

// ---------------------------------------------------------------- plan

export async function makePlan(opts) {
  const workDir = opts.out;
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const baseFile = opts.base ?? newest(BACKUPS, /^testweek-baseline-.*\.ndjson\.gz$/);
  if (!baseFile || !fs.existsSync(baseFile)) throw new Error("期間の始まりの控え (--base) が見つかりません");
  const testFile = opts.test ?? (fs.existsSync(LIVE_TEST) ? LIVE_TEST : newest(BACKUPS, /^testweek-final-.*\.tar\.gz$/));
  if (!testFile || !fs.existsSync(testFile)) throw new Error("テスト用のデータベース (--test) が見つかりません");
  const { db: test, files: filesDir, sha: testSha } = readTest(testFile, workDir);
  const { head, lines } = await openBase(baseFile);
  const filesFrom = opts.files ?? filesDir;
  const meta = test.meta ?? {};
  if (!opts.anyBase && meta.copyOfSavedAt && head.savedAt && meta.copyOfSavedAt !== head.savedAt) {
    throw new Error(`テスト用のデータベースの元 (${meta.copyOfSavedAt}) と控え (${head.savedAt}) が違います。別の控えを --base で指定してください`);
  }
  // 画面 (データ入出力 → 本番への引き継ぎ) の判断。引数の指定が優先 (--ignore-review で使わない)
  const review = opts["ignore-review"] ? { include: [], exclude: [], settings: [] } : readCarryoverReview(test);
  const since = parseWhen(opts.since ?? review.since) ?? (meta.copiedAt ? new Date(meta.copiedAt).toISOString() : null);
  const until = parseWhen(opts.until ?? review.until, true);
  const wantSettings = [...new Set([...list(opts.settings), ...review.settings])];
  const diff = await diffRows(TABLES, lines, test);
  const g = groupPlan(TABLES, diff, test, { since, until, exclude: list(opts.exclude), only: list(opts.only), settings: wantSettings, noUsers: Boolean(opts["no-users"]), keepPractice: Boolean(opts["keep-practice"]), review });
  const files = [];
  for (const s of g.fileCandidates) {
    const p = path.join(filesFrom, s);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const buf = fs.readFileSync(p);
    files.push({ key: s, size: buf.length, sha256: sha256(buf) });
  }
  const body = { rows: g.rows, users: g.users, files };
  const plan = {
    kind: "ichijoya-testweek-carryover",
    version: 1,
    createdAt: new Date().toISOString(),
    test: { path: testFile, sha256: testSha, files: filesFrom, copiedAt: meta.copiedAt ?? null },
    base: { path: baseFile, savedAt: head.savedAt, revision: head.revision },
    window: { since, until },
    options: { exclude: list(opts.exclude), only: list(opts.only), settings: wantSettings, users: !opts["no-users"] },
    review: { include: review.include.length, exclude: review.exclude.length, decidedAt: review.decidedAt ?? null, decidedBy: review.decidedBy ? ((test.users ?? []).find((u) => u.id === review.decidedBy)?.name ?? review.decidedBy) : null },
    groups: g.groups.map(({ idxs: _i, ...x }) => x),
    settings: g.settings,
    ...body,
    hash: sha256(stable(body)),
  };
  const planFile = path.join(workDir, "carryover-plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 1), { mode: 0o600 });
  const csvFile = path.join(workDir, "carryover-list.csv");
  fs.writeFileSync(csvFile, "﻿" + carryoverCsv(TABLES, plan), { mode: 0o600 });
  return { plan, planFile, csvFile };
}

// ---------------------------------------------------------------- 書き込み先 (本番の PostgreSQL / JSON)

async function pgTarget() {
  const { loadEnv } = await import("../import/env.mjs");
  const { connectDatabase, mask } = await import("../import/db-connect.mjs");
  loadEnv(ROOT);
  const { client, conn } = await connectDatabase((m) => console.log(m));
  console.log(`接続: ${mask(conn)}`);
  await client.query("set lock_timeout = '15s'; set statement_timeout = '120s'");
  await client.query("begin");
  const fromJsonb = (def, j) => {
    const e = {};
    for (const [f] of def.columns) if (j[snake(f)] !== null && j[snake(f)] !== undefined) e[f] = j[snake(f)];
    return e;
  };
  return {
    label: "本番のデータベース",
    async get(def, ids) {
      const out = new Map();
      for (let i = 0; i < ids.length; i += 500) {
        const r = await client.query(`select to_jsonb(t) as j from ${def.table} t where id = any($1::text[]) for update`, [ids.slice(i, i + 500)]);
        for (const { j } of r.rows) out.set(j.id, fromJsonb(def, j));
      }
      return out;
    },
    async uniqueOwner(def, field, value) {
      const r = await client.query(`select id from ${def.table} where ${snake(field)} = $1 limit 5`, [value]);
      return r.rows.map((x) => x.id);
    },
    async upsert(def, row) {
      const cols = def.columns.map(([f]) => f);
      const vals = def.columns.map(([f, spec]) => {
        const v = row[f];
        if (v === undefined || v === null) return null;
        return /^jsonb\b/.test(spec) ? JSON.stringify(v) : v;
      });
      const set = cols.filter((c) => c !== "id").map((c) => `${snake(c)} = excluded.${snake(c)}`).join(", ");
      await client.query(`insert into ${def.table} (${cols.map(snake).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (id) do update set ${set}`, vals);
    },
    async patch(def, id, fields) {
      const ks = Object.keys(fields);
      const vals = ks.map((k) => {
        const spec = def.columns.find(([f]) => f === k)[1];
        const v = fields[k];
        return v === undefined || v === null ? null : /^jsonb\b/.test(spec) ? JSON.stringify(v) : v;
      });
      const r = await client.query(`update ${def.table} set ${ks.map((k, i) => `${snake(k)} = $${i + 1}`).join(", ")} where id = $${ks.length + 1}`, [...vals, id]);
      if (r.rowCount !== 1) throw new Error(`${def.table} ${id} を更新できません`);
    },
    async remove(def, ids) {
      await client.query(`delete from ${def.table} where id = any($1::text[])`, [ids]);
    },
    async revision() {
      return Number((await client.query("select revision from app_meta where id = 1")).rows[0]?.revision ?? 0);
    },
    async record(log) {
      try {
        await client.query("savepoint rc");
        const r = await client.query("select public.record_changes($1::jsonb) as r", [JSON.stringify(log)]);
        return Number(r.rows[0].r);
      } catch (e) {
        if (!/record_changes/.test(String(e.message))) throw e;
        await client.query("rollback to savepoint rc");
        return Number((await client.query("select public.bump_revision() as r")).rows[0].r);
      }
    },
    async finish(commit) {
      try {
        await client.query(commit ? "commit" : "rollback");
      } finally {
        await client.end();
      }
    },
  };
}

function jsonTarget(file) {
  const db = JSON.parse(fs.readFileSync(file, "utf8"));
  const coll = (def) => (db[def.collection] ??= []);
  return {
    label: `JSON のデータベース (${file})`,
    async get(def, ids) {
      const want = new Set(ids);
      return new Map(coll(def).filter((r) => want.has(r.id)).map((r) => [r.id, r]));
    },
    async uniqueOwner(def, field, value) {
      return coll(def).filter((r) => normValue("text", r[field]) === normValue("text", value)).map((r) => r.id);
    },
    async upsert(def, row) {
      const c = coll(def);
      const i = c.findIndex((r) => r.id === row.id);
      if (i >= 0) c[i] = structuredClone(row);
      else c.push(structuredClone(row));
    },
    async patch(def, id, fields) {
      const r = coll(def).find((x) => x.id === id);
      if (!r) throw new Error(`${def.collection} ${id} がありません`);
      for (const [k, v] of Object.entries(fields)) {
        if (v === null || v === undefined) delete r[k];
        else r[k] = v;
      }
    },
    async remove(def, ids) {
      const s = new Set(ids);
      db[def.collection] = coll(def).filter((r) => !s.has(r.id));
    },
    async revision() {
      return Number(db.meta?.revision ?? 0);
    },
    async record() {
      db.meta = { ...(db.meta ?? {}), revision: Number(db.meta?.revision ?? 0) + 1, carriedOverAt: new Date().toISOString() };
      return db.meta.revision;
    },
    async finish(commit) {
      if (!commit) return;
      const tmp = `${file}.carryover.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    },
  };
}

// ---------------------------------------------------------------- check / apply

export async function runApply(opts) {
  const planFile = opts.plan;
  if (!planFile) throw new Error("--plan <carryover-plan.json> を指定してください");
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (plan.kind !== "ichijoya-testweek-carryover") throw new Error("引き継ぎの計画のファイルではありません");
  if (sha256(stable({ rows: plan.rows, users: plan.users, files: plan.files })) !== plan.hash) throw new Error("計画のファイルが作ったあとに書き換えられています (plan から作り直してください)");
  const write = opts.mode === "apply" && opts.yes === true;
  const target = opts.target?.startsWith("json:") ? jsonTarget(opts.target.slice(5)) : await pgTarget();
  const filesDest = opts["files-dest"] ?? (opts.target?.startsWith("json:") ? null : process.env.FILE_STORAGE_DIR?.trim() || "/srv/ichijoya/data/uploads");
  const filesFrom = opts.files ?? plan.test.files;
  const conflicts = [];
  const already = [];
  const log = {};
  const note = (def, kind, id) => {
    const l = (log[def.table] ??= {});
    (l[kind] ??= []).push(id);
  };
  let committed = false;
  const result = { at: new Date().toISOString(), target: target.label, mode: write ? "apply" : opts.mode === "apply" ? "rehearse" : "check", upserted: 0, deleted: 0, users: 0, files: 0 };
  try {
    result.revisionBefore = await target.revision();
    // 1. 本番の側の行を読み、期間の始まりの控えと同じかを確かめる
    const todo = [];
    for (const def of TABLES) {
      const r = plan.rows[def.collection];
      if (!r) continue;
      const ids = [...r.upsert.map((u) => u.id), ...r.delete.map((d) => d.id)];
      const cur = await target.get(def, ids);
      for (const u of r.upsert) {
        const now = canonRow(def, cur.get(u.id));
        const want = canonRow(def, u.row);
        if (now === want) {
          already.push(`${def.label} ${u.id}`);
          continue;
        }
        if (now !== canonRow(def, u.base)) {
          conflicts.push(`${def.label} ${u.row.number ?? u.row.code ?? u.id}: ${u.base ? "期間中に本番の側でも変わっています" : "本番に同じ ID の行があります"}`);
          continue;
        }
        for (const [f, spec] of def.columns) {
          if (!/\bunique\b/.test(spec) || /primary key/.test(spec) || u.row[f] === undefined || u.row[f] === null) continue;
          const owners = (await target.uniqueOwner(def, f, u.row[f])).filter((id) => id !== u.id);
          if (owners.length) conflicts.push(`${def.label} ${u.row.number ?? u.id}: ${f} = ${u.row[f]} が本番の別の行 (${owners.join(", ")}) と重複しています (12/1 以降に本番で登録した記録など)`);
        }
        todo.push({ def, op: "upsert", u });
      }
      for (const d of r.delete) {
        const now = canonRow(def, cur.get(d.id));
        if (now === null) {
          already.push(`${def.label} ${d.id} (削除済み)`);
          continue;
        }
        if (now !== canonRow(def, d.base)) conflicts.push(`${def.label} ${d.base.number ?? d.id}: 削除する行が期間中に本番の側で変わっています`);
        else todo.push({ def, op: "delete", d });
      }
    }
    const userDef = DEFS.get("users");
    const cur = await target.get(userDef, plan.users.map((p) => p.id));
    const userTodo = [];
    for (const p of plan.users) {
      const row = cur.get(p.id);
      if (!row) {
        conflicts.push(`社員 ${p.name}: 本番にアカウントがありません`);
        continue;
      }
      const set = {};
      for (const [f, { before, after }] of Object.entries(p.fields)) {
        const now = canonField(userDef, f, row[f]);
        if (now === canonField(userDef, f, after)) continue;
        if (now !== canonField(userDef, f, before)) conflicts.push(`社員 ${p.name}: ${f} が期間中に本番の側でも変わっています`);
        else set[f] = after;
      }
      if (Object.keys(set).length) userTodo.push({ id: p.id, name: p.name, set });
    }
    // 2. ファイル (写真・資料)
    const fileTodo = [];
    for (const f of plan.files) {
      const src = path.join(filesFrom, f.key);
      if (!fs.existsSync(src)) {
        conflicts.push(`ファイル ${f.key}: 引き継ぐファイルが見つかりません (${filesFrom})`);
        continue;
      }
      if (sha256(fs.readFileSync(src)) !== f.sha256) {
        conflicts.push(`ファイル ${f.key}: 計画を作ったあとに中身が変わっています`);
        continue;
      }
      if (!filesDest) continue;
      const dst = path.join(filesDest, f.key);
      if (fs.existsSync(dst)) {
        if (sha256(fs.readFileSync(dst)) !== f.sha256) conflicts.push(`ファイル ${f.key}: 本番に同じ名前の別のファイルがあります`);
        continue;
      }
      fileTodo.push({ src, dst, key: f.key });
    }
    result.conflicts = conflicts;
    result.already = already.length;
    if (conflicts.length) {
      result.ok = false;
      return report(result, plan, planFile, opts, todo, userTodo, fileTodo);
    }
    // 3. 書く (トランザクションの中。--yes がなければ最後に取り消す)
    for (const t of todo.filter((x) => x.op === "upsert")) {
      await target.upsert(t.def, t.u.row);
      note(t.def, "u", t.u.id);
      result.upserted++;
    }
    for (const u of userTodo) {
      await target.patch(userDef, u.id, u.set);
      note(userDef, "u", u.id);
      result.users++;
    }
    for (const def of [...TABLES].reverse()) {
      const ids = todo.filter((x) => x.op === "delete" && x.def === def).map((x) => x.d.id);
      if (!ids.length) continue;
      await target.remove(def, ids);
      for (const id of ids) note(def, "d", id);
      result.deleted += ids.length;
    }
    // 4. 書いた行を読み直して照合
    const mismatch = [];
    for (const def of TABLES) {
      const r = plan.rows[def.collection];
      if (!r) continue;
      const now = await target.get(def, [...r.upsert.map((u) => u.id), ...r.delete.map((d) => d.id)]);
      for (const u of r.upsert) if (canonRow(def, now.get(u.id)) !== canonRow(def, u.row)) mismatch.push(`${def.label} ${u.id}`);
      for (const d of r.delete) if (now.has(d.id)) mismatch.push(`${def.label} ${d.id} (削除)`);
    }
    const nowUsers = await target.get(userDef, plan.users.map((p) => p.id));
    for (const p of plan.users) for (const [f, { after }] of Object.entries(p.fields)) if (canonField(userDef, f, nowUsers.get(p.id)?.[f]) !== canonField(userDef, f, after)) mismatch.push(`社員 ${p.name} ${f}`);
    if (mismatch.length) {
      result.ok = false;
      result.conflicts = mismatch.map((m) => `書いた内容が計画と一致しません: ${m}`);
      return report(result, plan, planFile, opts, todo, userTodo, fileTodo);
    }
    if (Object.keys(log).length) result.revisionAfter = await target.record(log);
    // 5. ファイル → commit (ファイルを先に置く。commit できなければ置いたファイルを消す)
    const placed = [];
    if (write) {
      for (const f of fileTodo) {
        fs.mkdirSync(path.dirname(f.dst), { recursive: true, mode: 0o750 });
        fs.copyFileSync(f.src, f.dst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(f.dst, 0o640);
        placed.push(f.dst);
        result.files++;
      }
    }
    try {
      await target.finish(write);
      committed = write;
    } catch (e) {
      for (const p of placed) fs.rmSync(p, { force: true });
      throw e;
    }
    result.ok = true;
    return report(result, plan, planFile, opts, todo, userTodo, fileTodo);
  } finally {
    if (!committed) await target.finish(false).catch(() => {});
  }
}

function report(result, plan, planFile, opts, todo, userTodo, fileTodo) {
  const outFile = path.join(path.dirname(planFile), `carryover-result-${result.mode}-${result.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 1), { mode: 0o600 });
  if (!opts.quiet) {
    console.log(`\n${result.target} (${result.mode === "apply" ? "書き込み" : result.mode === "rehearse" ? "予行 (最後に取り消し)" : "確認だけ"})`);
    console.log(`  書く行: 追加・更新 ${todo.filter((t) => t.op === "upsert").length} / 削除 ${todo.filter((t) => t.op === "delete").length} / 社員 ${userTodo.length} 名 / ファイル ${fileTodo.length} 件 (すでに同じ: ${result.already})`);
    if (result.conflicts?.length) {
      console.log(`  中止: 突き合わせで ${result.conflicts.length} 件の問題 (本番のデータベースは変えていません)`);
      for (const c of result.conflicts.slice(0, 40)) console.log(`   - ${c}`);
    } else if (result.mode === "apply") console.log(`  完了: 追加・更新 ${result.upserted} 行・削除 ${result.deleted} 行・社員 ${result.users} 名・ファイル ${result.files} 件 (リビジョン ${result.revisionBefore} → ${result.revisionAfter ?? result.revisionBefore})`);
    else console.log(`  問題なし。${result.mode === "rehearse" ? "書き込み・照合まで通り、取り消しました" : "書き込みはしていません"}。本当に書くときは apply --plan ${planFile} --yes`);
    console.log(`  結果: ${outFile}`);
  }
  result.file = outFile;
  return result;
}

// ---------------------------------------------------------------- コマンド

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === "plan") {
    const out = a.out ?? path.join(BACKUPS, "carryover", new Date().toISOString().replace(/[:.]/g, "-"));
    const { plan, planFile, csvFile } = await makePlan({ ...a, out });
    const sel = plan.groups.filter((g) => g.selected);
    const rowsN = Object.values(plan.rows).reduce((n, r) => n + r.upsert.length + r.delete.length, 0);
    console.log(`期間: ${plan.window.since ? jst(plan.window.since) : "はじめ"} 〜 ${plan.window.until ? jst(plan.window.until) : "いま"} (日本時間)`);
    const rv = plan.review;
    console.log(`画面の判断: 引き継がない ${rv.exclude} 件・引き継ぐ ${rv.include} 件 / 最終判断 ${rv.decidedAt ? `${jst(rv.decidedAt)} (${rv.decidedBy ?? ""})` : "まだ (データ入出力 → 本番への引き継ぎ)"}`);
    console.log(`まとまり ${plan.groups.length} 件のうち 引き継ぐ ${sel.length} 件 (行 ${rowsN}・社員 ${plan.users.length} 名・ファイル ${plan.files.length} 件)`);
    const shown = plan.groups.filter((g) => g.selected || g.pulled.length || !g.reason.startsWith("変更履歴だけ"));
    for (const g of shown.slice(0, a.json ? 0 : 80)) console.log(`  ${g.selected ? "○" : g.pulled.length ? "△" : "×"} ${jst(g.first)} ${g.label}${g.reason ? ` … ${g.reason}` : ""}${g.pulled.length ? ` … 一部を一緒に引き継ぐ (${g.pulled.join("、")})` : ""}`);
    if (shown.length > 80) console.log(`  … ほか ${shown.length - 80} 件 (一覧の CSV を見てください)`);
    const noise = plan.groups.length - shown.length;
    if (noise) console.log(`  × 変更履歴だけのまとまり ${noise} 件 (ログイン・閲覧など。引き継がない)`);
    for (const s of plan.settings) console.log(`  ${s.selected ? "○" : "×"} ${SPECIAL_JA[s.coll] ?? s.coll} ${s.id} (${KIND_JA[s.kind]})${s.reason ? ` … ${s.reason}` : ""}`);
    console.log(`一覧: ${csvFile}\n計画: ${planFile}\n次: node scripts/ops/testweek-carryover.mjs check --plan ${planFile}`);
    return;
  }
  if (cmd === "check" || cmd === "apply") {
    const r = await runApply({ ...a, mode: cmd });
    process.exit(r.ok ? 0 : 1);
  }
  console.error(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).join("\n"));
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}
