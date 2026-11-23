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
import { TABLES, isTimestamp, snake } from "../../src/lib/db/schema.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKUPS = "/var/backups/ichijoya";
const LIVE_TEST = "/srv/ichijoya/testweek/data/testweek-db.json";
const TZ_OFFSET = "+09:00";

/** まとまりの間をつながない表 (マスタ・社員・設定)。参照されても まとまりは分けたまま (期間中に増えた行は依存として一緒に引き継ぐ) */
const NO_LINK = new Set(["stores", "users", "settings", "products", "holidays", "suppliers", "materials", "materialCosts", "boms", "itemCategories", "salesAreas", "mgmtRules", "expenseClasses", "faxNumbers", "knowledge"]);
/** 行ごとには引き継がず、別の扱いにする表 */
const SPECIAL = new Set(["users", "settings", "stores"]);
/** 社員の行で引き継ぐ項目 (パスワードの再設定・本人のプロフィール。アカウントの変更は期間中は止めている) */
export const USER_FIELDS = ["email", "passwordHash", "avatarKey", "avatarUpdatedAt", "kana", "phone", "notifyEmail", "notifyByEmail", "chatworkAccountId"];
/** 引き継がない設定 (サーバーの動きの記録。本番の側の値を残す) */
const RUNTIME_SETTINGS = new Set(["knowledge_sync_state", "line_groups", "survey_workbook_state"]);
/** 練習の記録の印 (お客様名・件名・要約に書いてもらう)。--keep-practice で印があっても引き継ぐ */
const PRACTICE = /練習|テスト/;
/** まとまりの名前に使う記録の優先順 */
const ROOT_ORDER = ["customers", "inquiries", "quotes", "orders", "invoices", "payments", "schedule", "expenses", "purchases", "purchaseOrders", "leaveRequests", "qualityIssues", "documents", "commLogs", "threads", "approvals", "attachments"];

const DEFS = new Map(TABLES.map((t) => [t.collection, t]));

// ---------------------------------------------------------------- 値の比べ方

/** 列の型にそろえた値 (Supabase から読んだ値と JSON の値を同じ形で比べる。null・未設定は「なし」) */
function normValue(spec, v) {
  if (v === undefined || v === null) return undefined;
  if (isTimestamp(spec) && typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  if (/^date\b/.test(spec) && typeof v === "string") return v.slice(0, 10);
  if (/^(numeric|bigint|integer)\b/.test(spec) && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (/^text\b(?!\[)/.test(spec) && (typeof v === "number" || typeof v === "boolean")) return String(v);
  if (/^jsonb\b/.test(spec)) return JSON.parse(JSON.stringify(v));
  return v;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stable(x))).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 行をデータベースの列だけにして正規化した文字列 (列にない項目は Supabase に入らないので比べない) */
export function canonRow(def, row) {
  if (!row) return null;
  const o = {};
  for (const [f, spec] of def.columns) {
    const v = normValue(spec, row[f]);
    if (v !== undefined) o[f] = v;
  }
  return stable(o);
}

function canonField(def, field, v) {
  const spec = def.columns.find(([f]) => f === field)?.[1] ?? "text";
  const n = normValue(spec, v);
  return n === undefined ? "null" : stable(n);
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- 引数・読み込み

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) a._.push(s);
    else if (["--yes", "--no-users", "--json", "--quiet", "--keep-practice"].includes(s)) a[s.slice(2)] = true;
    else a[s.slice(2)] = argv[++i];
  }
  return a;
}

const list = (s) => (s ? String(s).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : []);

function newest(dir, re) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => re.test(n)).sort().pop();
  return f ? path.join(dir, f) : null;
}

/** 日本時間の日付 (2026-11-23) か日時 → ISO。until の日付はその日の終わり */
export function parseWhen(s, end = false) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}${TZ_OFFSET}`).toISOString();
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}${TZ_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new Error(`日時を読めません: ${s}`);
  return d.toISOString();
}

/** 期間の始まりの控え (ndjson.gz: 1 行目が見出し、2 行目から「コレクション<TAB>行の JSON」) を表ごとの Map で読む */
async function readBase(file) {
  const out = new Map();
  let head = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (!head) {
      head = JSON.parse(line);
      continue;
    }
    const t = line.indexOf("\t");
    const k = line.slice(0, t);
    const r = JSON.parse(line.slice(t + 1));
    if (!out.has(k)) out.set(k, new Map());
    out.get(k).set(r.id, r);
  }
  return { head, rows: out };
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

function* strings(v) {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

/** 行の「操作の日時」(業務の日付 = 受付日・見積日などは使わない。システムが付けた日時だけ) */
function activityAt(node) {
  const r = node.row;
  if (node.coll === "auditLogs") return r.at ?? null;
  if (node.kind === "add") return r.createdAt ?? r.uploadedAt ?? r.requestedAt ?? r.updatedAt ?? null;
  if (node.kind === "mod" && r.updatedAt && r.updatedAt !== node.base?.updatedAt) return r.updatedAt;
  return null;
}

function rowLabel(db, node) {
  const r = node.row;
  const def = DEFS.get(node.coll);
  const num = r.number ?? r.code ?? "";
  const name = r.name ?? r.contactName ?? r.title ?? r.subject ?? r.summary ?? r.fileName ?? r.entityLabel ?? "";
  const found = r.customerId && node.coll !== "customers" ? db.customers?.find((c) => c.id === r.customerId)?.name : null;
  const cust = found && found !== name ? found : null;
  const verb = node.kind === "add" ? "" : node.kind === "mod" ? " (変更)" : " (削除)";
  return `${def?.label ?? node.coll} ${num} ${String(name).slice(0, 40)}${cust ? ` / ${cust} 様` : ""}${verb}`.replace(/\s+/g, " ").trim();
}

export async function makePlan(opts) {
  const workDir = opts.out;
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const baseFile = opts.base ?? newest(BACKUPS, /^testweek-baseline-.*\.ndjson\.gz$/);
  if (!baseFile || !fs.existsSync(baseFile)) throw new Error("期間の始まりの控え (--base) が見つかりません");
  const testFile = opts.test ?? (fs.existsSync(LIVE_TEST) ? LIVE_TEST : newest(BACKUPS, /^testweek-final-.*\.tar\.gz$/));
  if (!testFile || !fs.existsSync(testFile)) throw new Error("テスト用のデータベース (--test) が見つかりません");
  const { head, rows: base } = await readBase(baseFile);
  const { db: test, files: filesDir, sha: testSha } = readTest(testFile, workDir);
  const filesFrom = opts.files ?? filesDir;
  const meta = test.meta ?? {};
  if (!opts.anyBase && meta.copyOfSavedAt && head.savedAt && meta.copyOfSavedAt !== head.savedAt) {
    throw new Error(`テスト用のデータベースの元 (${meta.copyOfSavedAt}) と控え (${head.savedAt}) が違います。別の控えを --base で指定してください`);
  }
  const since = parseWhen(opts.since) ?? (meta.copiedAt ? new Date(meta.copiedAt).toISOString() : null);
  const until = parseWhen(opts.until, true);

  // 1. 行ごとの違い
  const nodes = [];
  const special = { users: [], settings: [] };
  for (const def of TABLES) {
    const b = base.get(def.collection) ?? new Map();
    const t = new Map((test[def.collection] ?? []).map((r) => [r.id, r]));
    const push = (kind, row, baseRow) => {
      if (SPECIAL.has(def.collection)) (def.collection === "users" ? special.users : special.settings).push({ coll: def.collection, kind, row, base: baseRow });
      else nodes.push({ coll: def.collection, id: row.id, kind, row, base: baseRow ?? null });
    };
    for (const [id, r] of t) {
      const br = b.get(id);
      if (!br) push("add", r, null);
      else if (canonRow(def, br) !== canonRow(def, r)) push("mod", r, br);
    }
    for (const [id, br] of b) if (!t.has(id)) push("del", br, br);
  }

  // 2. つながり (ID の参照) でまとまりに分ける
  const byId = new Map();
  nodes.forEach((n, i) => {
    if (!byId.has(n.id)) byId.set(n.id, []);
    byId.get(n.id).push(i);
  });
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    const x = find(a), y = find(b);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const deps = nodes.map(() => new Set());
  nodes.forEach((n, i) => {
    for (const s of strings(n.row)) {
      if (s === n.id || s.length < 4) continue;
      for (const j of byId.get(s) ?? []) {
        if (j === i) continue;
        if (nodes[j].kind === "add") deps[i].add(j);
        // 変更履歴は、その記録 (entityId) のまとまりに入れる (マスタの変更の履歴も)
        if ((!NO_LINK.has(nodes[j].coll) && !NO_LINK.has(n.coll)) || (n.coll === "auditLogs" && s === n.row.entityId)) union(i, j);
      }
    }
  });
  const groupsMap = new Map();
  nodes.forEach((n, i) => {
    const g = find(i);
    if (!groupsMap.has(g)) groupsMap.set(g, []);
    groupsMap.get(g).push(i);
  });

  const users = new Map((test.users ?? []).map((u) => [u.id, u.name]));
  const exclude = list(opts.exclude), only = list(opts.only);
  const matches = (idxs, tokens) => tokens.some((tok) => idxs.some((i) => nodes[i].id === tok || nodes[i].row.number === tok || nodes[i].row.code === tok));
  const groups = [];
  for (const idxs of groupsMap.values()) {
    const rank = (i) => {
      const r = ROOT_ORDER.indexOf(nodes[i].coll);
      return (r < 0 ? 99 : r) + (nodes[i].kind === "add" ? 0 : 100);
    };
    const root = [...idxs].sort((a, b) => rank(a) - rank(b) || a - b)[0];
    const times = idxs.map((i) => activityAt(nodes[i])).filter(Boolean).sort();
    const first = times[0] ?? null, last = times[times.length - 1] ?? null;
    const actors = new Set();
    for (const i of idxs) for (const k of ["createdBy", "userId", "uploadedBy", "requestedBy", "updatedBy", "decidedBy"]) if (nodes[i].row[k] && users.has(nodes[i].row[k]) && (nodes[i].kind !== "mod" || k === "updatedBy" || nodes[i].coll === "auditLogs")) actors.add(users.get(nodes[i].row[k]));
    const counts = {};
    for (const i of idxs) {
      const c = (counts[nodes[i].coll] ??= { add: 0, mod: 0, del: 0 });
      c[nodes[i].kind]++;
    }
    const store = idxs.map((i) => nodes[i].row.storeId).find(Boolean) ?? "";
    let selected = true, reason = "";
    if (idxs.every((i) => nodes[i].coll === "auditLogs")) (selected = false), (reason = "変更履歴だけ (ログイン・閲覧など)");
    else if (only.length && !matches(idxs, only)) (selected = false), (reason = "--only の指定にない");
    else if (exclude.length && matches(idxs, exclude)) (selected = false), (reason = "--exclude で除外");
    else if (!opts["keep-practice"] && !matches(idxs, only) && idxs.some((i) => nodes[i].kind === "add" && PRACTICE.test([nodes[i].row.name, nodes[i].row.contactName, nodes[i].row.title, nodes[i].row.summary].filter(Boolean).join(" "))))
      (selected = false), (reason = "名前・件名に「練習」「テスト」(練習の記録。引き継ぐなら --only で指定)");
    else if (!first && (since || until)) (selected = false), (reason = "操作の日時が分からない");
    else if (since && first < since) (selected = false), (reason = `期間より前 (${jst(first)})`);
    else if (until && first > until) (selected = false), (reason = `期間より後 (${jst(first)})`);
    groups.push({ id: nodes[root].id, label: rowLabel(test, nodes[root]), store, first, last, actors: [...actors], counts, idxs, selected, reason, pulled: [] });
  }
  groups.sort((a, b) => String(a.first ?? "~").localeCompare(String(b.first ?? "~")) || a.label.localeCompare(b.label));

  // 3. 引き継ぐ行 + 依存 (引き継ぐ行が参照する、期間中に増えた行)
  const chosen = new Set(groups.filter((g) => g.selected).flatMap((g) => g.idxs));
  const groupOf = new Map(groups.flatMap((g) => g.idxs.map((i) => [i, g])));
  const auditOf = new Map();
  nodes.forEach((n, i) => {
    if (n.coll !== "auditLogs" || !n.row.entityId) return;
    if (!auditOf.has(n.row.entityId)) auditOf.set(n.row.entityId, []);
    auditOf.get(n.row.entityId).push(i);
  });
  const queue = [...chosen];
  while (queue.length) {
    const i = queue.pop();
    for (const j of deps[i]) {
      if (chosen.has(j)) continue;
      chosen.add(j);
      queue.push(j);
      const g = groupOf.get(j);
      g.pulled.push(rowLabel(test, nodes[j]));
      // 一緒に引き継ぐ行の変更履歴も
      for (const k of auditOf.get(nodes[j].id) ?? []) if (!chosen.has(k)) chosen.add(k);
    }
  }

  // 4. 社員 (パスワード・プロフィール) と設定
  const userPatches = [];
  if (!opts["no-users"]) {
    for (const s of special.users) {
      if (s.kind !== "mod") continue;
      const fields = {};
      for (const f of USER_FIELDS) {
        if (canonField(DEFS.get("users"), f, s.row[f]) !== canonField(DEFS.get("users"), f, s.base[f])) fields[f] = { before: s.base[f] ?? null, after: s.row[f] ?? null };
      }
      if (Object.keys(fields).length) userPatches.push({ id: s.row.id, name: s.row.name, fields });
    }
  }
  const wantSettings = new Set(list(opts.settings));
  const settingRows = [];
  const settingList = [];
  // 期間中に増えた社員 (新規登録の申請) は、設定と同じく --settings users:<ID> で指定したものだけ
  for (const s of [...special.settings, ...special.users.filter((u) => u.kind === "add")]) {
    const key = `${s.coll}:${s.row.id}`;
    const want = (wantSettings.has(s.row.id) || wantSettings.has(key)) && !RUNTIME_SETTINGS.has(s.row.id);
    settingList.push({ coll: s.coll, id: s.row.id, kind: s.kind, selected: want, reason: want ? "" : RUNTIME_SETTINGS.has(s.row.id) ? "サーバーの動きの記録 (引き継がない)" : "--settings で指定したものだけ" });
    if (want && s.kind !== "del") {
      settingRows.push({ coll: s.coll, id: s.row.id, row: s.row, base: s.base ?? null });
      // 引き継ぐ設定の変更履歴も
      for (const k of auditOf.get(s.row.id) ?? []) {
        if (chosen.has(k)) continue;
        chosen.add(k);
        groupOf.get(k)?.pulled.push(`${SPECIAL_JA[s.coll] ?? s.coll} ${s.row.id} の変更履歴`);
      }
    }
  }

  // 5. 計画 (書く行・元の行・ファイル)
  const rows = {};
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const n = nodes[i];
    const r = (rows[n.coll] ??= { upsert: [], delete: [] });
    if (n.kind === "del") r.delete.push({ id: n.id, base: n.base });
    else r.upsert.push({ id: n.id, row: n.row, base: n.base });
  }
  for (const s of settingRows) (rows[s.coll] ??= { upsert: [], delete: [] }).upsert.push({ id: s.id, row: s.row, base: s.base });
  const files = [];
  const seen = new Set();
  const fileCandidates = [...Object.values(rows).flatMap((r) => r.upsert.map((u) => u.row)), ...userPatches.map((p) => Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, v.after])))];
  for (const row of fileCandidates) {
    for (const s of strings(row)) {
      if (seen.has(s) || !/^[\w.-]+(\/[\w.-]+)+$/.test(s) || s.includes("..")) continue;
      const p = path.join(filesFrom, s);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      seen.add(s);
      const buf = fs.readFileSync(p);
      files.push({ key: s, size: buf.length, sha256: sha256(buf) });
    }
  }
  const body = { rows, users: userPatches, files };
  const plan = {
    kind: "ichijoya-testweek-carryover",
    version: 1,
    createdAt: new Date().toISOString(),
    test: { path: testFile, sha256: testSha, files: filesFrom, copiedAt: meta.copiedAt ?? null },
    base: { path: baseFile, savedAt: head.savedAt, revision: head.revision },
    window: { since, until },
    options: { exclude, only, settings: [...wantSettings], users: !opts["no-users"] },
    groups: groups.map(({ idxs: _i, ...g }) => g),
    settings: settingList,
    ...body,
    hash: sha256(stable(body)),
  };
  const planFile = path.join(workDir, "carryover-plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 1), { mode: 0o600 });
  const csvFile = path.join(workDir, "carryover-list.csv");
  fs.writeFileSync(csvFile, "﻿" + csvOf(plan), { mode: 0o600 });
  return { plan, planFile, csvFile };
}

function jst(iso) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}

const KIND_JA = { add: "追加", mod: "変更", del: "削除" };
const SPECIAL_JA = { stores: "店舗", settings: "設定", users: "社員 (新規)" };
function csvOf(plan) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["引き継ぐ", "まとまりの ID", "内容", "店舗", "最初の操作 (日本時間)", "最後の操作", "操作した人", "行の内訳", "理由・注意"].map(q).join(",")];
  for (const g of plan.groups) {
    const detail = Object.entries(g.counts).map(([c, n]) => `${DEFS.get(c)?.label ?? c} ${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${KIND_JA[k]}${v}`).join("・")}`).join(" / ");
    const note = [g.reason, g.pulled.length ? `ほかのまとまりが参照するため一緒に引き継ぐ: ${g.pulled.join("、")}` : ""].filter(Boolean).join(" / ");
    lines.push([g.selected ? "○" : g.pulled.length ? "△ (一部)" : "×", g.id, g.label, g.store, jst(g.first), jst(g.last), g.actors.join("・"), detail, note].map(q).join(","));
  }
  for (const u of plan.users) lines.push(["○", u.id, `社員 ${u.name} (${Object.keys(u.fields).map((f) => (f === "passwordHash" ? "パスワード" : f)).join("・")})`, "", "", "", "", "社員 変更", "パスワードの再設定・本人のプロフィール"].map(q).join(","));
  for (const s of plan.settings) lines.push([s.selected ? "○" : "×", s.id, `${SPECIAL_JA[s.coll] ?? s.coll} ${s.id} (${KIND_JA[s.kind]})`, "", "", "", "", "", s.reason].map(q).join(","));
  return lines.join("\r\n") + "\r\n";
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
