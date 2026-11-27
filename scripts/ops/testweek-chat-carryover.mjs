#!/usr/bin/env node
/**
 * 試験期間 (2026-11-23〜11-30) のチャット (チャンネル・DM・資料・写真) を本番のチャットに引き継ぐ (お客様のご指示 2026-11-27)
 * ------------------------------------------------------------
 *   node scripts/ops/testweek-chat-carryover.mjs [--from <テスト用のデータのフォルダー | testweek-final-*.tar.gz>] [--to <本番のデータのフォルダー>] [--apply]
 *   node scripts/ops/testweek-chat-carryover.mjs --auto --apply     … 12/1 の定期実行 (ichijoya のユーザーの crontab)。試験期間が終わってから 1 回だけ
 *   node scripts/ops/testweek-chat-carryover.mjs --stage            … 11/30 の定期実行: テスト用のチャットの写しを STAGE に残す (期間の終わりの控えを読めないときの予備)
 *
 * - 元 (--from がないとき): /srv/ichijoya/testweek/data (end が消す前・控えを作れずに残したとき) → /var/backups/ichijoya の一番新しい
 *   testweek-final-*.tar.gz (12/1 0:00 の end が作る控え。chat.sqlite と uploads/chat/ だけを取り出す) → STAGE (--stage の写し)。
 *   2026-11-23 に入れた end は控えを root だけが読める形で作る (sudo bash deploy/testweek.sh schedule で入れ直すと ichijoya も読める)。
 *   読めなければ、期間の終わりの直前 (〜12/1 0:04 まで 1 分ごと) の写しから引き継ぐ
 * - 先: <--to>/chat.sqlite と <--to>/uploads/chat/ (既定 /srv/ichijoya/data = 本番の 3000 番と 3001 番が使うもの)。
 *   本番のサーバーは動いたままでよい (SQLite の取引の中で書く。画面はファイルから読むので、書いたらすぐに見える)
 * - 書き方: 本番にない行を足す (メッセージ・チャンネルの ID はランダムなので重ならない。1 対 1 の DM は同じ ID = 同じチャンネルにまとまる)。
 *   rev は本番のいまの rev のあとに付け直す (開いている画面も新しい行として読み直す)。
 *   日時のある行 (メンバーの変更・チャンネルの画像と説明・既読・通知の設定・オンライン) は新しいほうを残す。入力中 (typing) は運ばない。
 *   期間の前に両方に入れたメンバーの変更・画像で、テスト用のほうで消したものは本番でも消す (PRUNE)
 * - 資料・写真・チャンネルの画像のファイルは上書きしない (同じ名前 = 同じファイル。大きさが違うものは残して知らせる)。ファイルを先に写してから行を書く
 * - 2 回目は何もしない (本番の chat.sqlite の meta の testweek_carryover に結果を残す)
 * - --apply がなければ本番の写し (一時フォルダー) に書いて結果を出すだけ (本番は変えない)
 * - 業務依頼 (threads) はデータベースの記録なので、本番に引き継がなかった依頼はチャットでは普通のメッセージとして出る
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const MARK = "testweek_carryover";
/** 新しいほうを残す表と、その日時の列 */
const NEWER = { channel_members: "at", channel_meta: "updated_at", reads: "at", prefs: "updated_at", presence: "at" };
/**
 * 試験期間の始まりの前に本番とテスト用の両方に入れた行 (11/26〜27 の管理者のメンバー・チャンネルの画像) は、テスト用のほうが正しい:
 * 期間中に管理者が自動に戻した (行を消した) ものは、本番に残っている同じ行も消す (cutoff より前の日時の行だけ。12/1 からの本番の変更は残す)
 */
const PRUNE = new Set(["channel_members", "channel_meta"]);
/** 運ばない表 (meta は rev を付け直す。typing は数秒で消える) */
const SKIP = new Set(["meta", "typing"]);

const TESTWEEK_DATA = "/srv/ichijoya/testweek/data";
const BACKUPS = "/var/backups/ichijoya";
const SNIPPET = "/etc/nginx/snippets/ichijoya-host-testweek.conf";
/** --stage の写しの置き場所 (ichijoya だけが読める) */
const STAGE = "/var/backups/ichijoya/testweek-chat";
/** 試験期間の終わり (2026-12-01 0:00 日本時間) */
const END_AT = Date.parse("2026-11-30T15:00:00Z");

const q = (s) => `"${String(s).replaceAll('"', '""')}"`;
const jst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 19).replace("T", " ");

function tableNames(db, schema) {
  return db
    .prepare(`select name, sql from ${schema}.sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
    .all()
    .map((r) => ({ name: String(r.name), sql: String(r.sql) }));
}
const tableInfo = (db, schema, table) => db.prepare(`pragma ${schema}.table_info(${q(table)})`).all();

/**
 * 元のチャット (sourceFile) の行を、先のチャット (targetFile) に足す。先にすでに引き継いだ印があれば何もしない
 * opts.cutoff (ISO の日時): PRUNE の表で、元にない・この日時より前の先の行を消す。opts.info: 印に残す内容
 * @returns {{ already?: object, revOffset?: number, rev?: number, tables?: Record<string, { source: number, added: number, updated: number, kept: number, removed: number }> }}
 */
export function mergeChatDb(targetFile, sourceFile, opts = {}) {
  const { cutoff, info = {} } = opts;
  if (path.resolve(targetFile) === path.resolve(sourceFile)) throw new Error("元と先が同じファイルです");
  const db = new DatabaseSync(targetFile);
  try {
    db.exec("pragma busy_timeout = 10000");
    const hasMeta = db.prepare("select count(*) n from sqlite_master where type = 'table' and name = 'meta'").get().n > 0;
    if (!hasMeta) throw new Error(`${targetFile} はチャットのデータベースではありません (meta がない)`);
    const done = db.prepare("select v from meta where k = ?").get(MARK);
    if (done) return { already: JSON.parse(String(done.v)) };
    db.prepare("attach database ? as src").run(sourceFile);
    try {
      const srcTables = tableNames(db, "src");
      if (!srcTables.some((t) => t.name === "messages") || !srcTables.some((t) => t.name === "meta")) throw new Error(`${sourceFile} はチャットのデータベースではありません`);
      db.exec("begin immediate");
      try {
        const offset = Number(db.prepare("select v from main.meta where k = 'rev'").get()?.v ?? 0);
        const srcRev = Number(db.prepare("select v from src.meta where k = 'rev'").get()?.v ?? 0);
        const mainTables = new Set(tableNames(db, "main").map((t) => t.name));
        const tables = {};
        for (const t of srcTables) {
          if (SKIP.has(t.name)) continue;
          // 先にない表・列は元の定義で作る (古い chat.sqlite でも)
          if (!mainTables.has(t.name)) db.exec(t.sql);
          const srcCols = tableInfo(db, "src", t.name);
          const mainCols = new Set(tableInfo(db, "main", t.name).map((c) => String(c.name)));
          for (const c of srcCols) {
            if (mainCols.has(String(c.name))) continue;
            const dflt = c.dflt_value == null ? "" : ` default ${c.dflt_value}`;
            db.exec(`alter table main.${q(t.name)} add column ${q(c.name)} ${c.type}${c.notnull && dflt ? " not null" : ""}${dflt}`);
          }
          const info2 = tableInfo(db, "main", t.name);
          const pk = info2.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
          if (!pk.length) throw new Error(`${t.name} に主キーがありません`);
          const cols = srcCols.map((c) => String(c.name)).filter((c) => info2.some((m) => m.name === c));
          const exprs = cols.map((c) => (c === "rev" ? `s.${q(c)} + ${offset + 1}` : `s.${q(c)}`));
          const on = pk.map((c) => `m.${q(c)} = s.${q(c)}`).join(" and ");
          const source = Number(db.prepare(`select count(*) n from src.${q(t.name)}`).get().n);
          const added = Number(db.prepare(`select count(*) n from src.${q(t.name)} s where not exists (select 1 from main.${q(t.name)} m where ${on})`).get().n);
          const ts = NEWER[t.name];
          let updated = 0;
          const insert = `insert into main.${q(t.name)} (${cols.map(q).join(", ")}) select ${exprs.join(", ")} from src.${q(t.name)} s where true`;
          if (ts && cols.includes(ts)) {
            updated = Number(db.prepare(`select count(*) n from src.${q(t.name)} s join main.${q(t.name)} m on ${on} where s.${q(ts)} > m.${q(ts)}`).get().n);
            const set = cols.filter((c) => !pk.includes(c)).map((c) => `${q(c)} = excluded.${q(c)}`);
            db.exec(
              set.length
                ? `${insert} on conflict (${pk.map(q).join(", ")}) do update set ${set.join(", ")} where excluded.${q(ts)} > main.${q(t.name)}.${q(ts)}`
                : `${insert} on conflict do nothing`,
            );
          } else {
            db.exec(`${insert} on conflict do nothing`);
          }
          let removed = 0;
          if (cutoff && ts && PRUNE.has(t.name)) {
            const gone = `from main.${q(t.name)} where ${q(ts)} < ? and not exists (select 1 from src.${q(t.name)} s where ${pk.map((c) => `s.${q(c)} = main.${q(t.name)}.${q(c)}`).join(" and ")})`;
            removed = Number(db.prepare(`select count(*) n ${gone}`).get(cutoff).n);
            if (removed) db.prepare(`delete ${gone}`).run(cutoff);
          }
          tables[t.name] = { source, added, updated, kept: source - added - updated, removed };
        }
        const rev = offset + srcRev + 1;
        db.prepare("update main.meta set v = ? where k = 'rev'").run(String(rev));
        db.prepare("insert into main.meta (k, v) values (?, ?)").run(MARK, JSON.stringify({ at: new Date().toISOString(), ...info, revOffset: offset + 1, rev, tables }));
        db.exec("commit");
        return { revOffset: offset + 1, rev, tables };
      } catch (err) {
        try {
          db.exec("rollback");
        } catch {
          // 取り消し済み
        }
        throw err;
      }
    } finally {
      db.exec("detach database src");
    }
  } finally {
    db.close();
  }
}

/** ファイルを写す (上書きしない)。dryRun なら数えるだけ */
export function copyFiles(srcDir, dstDir, dryRun = false) {
  const out = { copied: 0, same: 0, conflicts: [] };
  if (!fs.existsSync(srcDir)) return out;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const from = path.join(srcDir, r);
        const to = path.join(dstDir, r);
        if (fs.existsSync(to)) {
          if (fs.statSync(to).size === fs.statSync(from).size) out.same++;
          else out.conflicts.push(r);
          continue;
        }
        if (!dryRun) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          try {
            fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          } catch (err) {
            // 同時に写した (同じファイル)
            if (err?.code !== "EEXIST") throw err;
            out.same++;
            continue;
          }
        }
        out.copied++;
      }
    }
  };
  walk("");
  return out;
}

/** SQLite の一貫した写しを作る (WAL の分も入る。元は読むだけ) */
function snapshot(file, to) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("pragma busy_timeout = 10000");
    db.prepare("vacuum into ?").run(to);
  } finally {
    db.close();
  }
}

/** 元を用意する: { db: 写しの chat.sqlite, files: uploads/chat のフォルダー, label } */
export function prepareSource(from, work) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    const file = path.join(from, "chat.sqlite");
    if (!fs.existsSync(file)) throw new Error(`${file} がありません`);
    const db = path.join(work, "source.sqlite");
    snapshot(file, db);
    return { db, files: path.join(from, "uploads", "chat"), label: from };
  }
  // 控え (tar.gz): chat.sqlite (-wal・-shm) と uploads/chat/ だけを取り出す
  const list = execFileSync("tar", ["-tzf", from], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
  const wanted = list.filter((n) => /^(\.\/)?chat\.sqlite(-wal|-shm)?$/.test(n) || /^(\.\/)?uploads\/chat\/.+[^/]$/.test(n));
  if (!wanted.some((n) => /^(\.\/)?chat\.sqlite$/.test(n))) throw new Error(`${from} にチャット (chat.sqlite) がありません`);
  const ex = path.join(work, "extract");
  fs.mkdirSync(ex, { recursive: true });
  const listFile = path.join(work, "wanted.txt");
  fs.writeFileSync(listFile, wanted.join("\n") + "\n");
  execFileSync("tar", ["-xzf", from, "-C", ex, "--no-same-owner", "-T", listFile], { stdio: ["ignore", "ignore", "inherit"] });
  const db = path.join(work, "source.sqlite");
  snapshot(path.join(ex, "chat.sqlite"), db);
  return { db, files: path.join(ex, "uploads", "chat"), label: from };
}

function latestFinal() {
  if (!fs.existsSync(BACKUPS)) return undefined;
  const files = fs
    .readdirSync(BACKUPS)
    .filter((n) => /^testweek-final-\d{8}\.tar\.gz$/.test(n))
    .sort()
    .map((n) => path.join(BACKUPS, n));
  return files.at(-1);
}

const readable = (f) => {
  try {
    fs.accessSync(f, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** --stage: テスト用のチャットの一貫した写しとファイルを dir に残す (前の写しを置き換える。ファイルは足すだけ) */
export function stageChat(fromDir, dir) {
  const live = path.join(fromDir, "chat.sqlite");
  if (!fs.existsSync(live)) return undefined;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `chat.sqlite.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  snapshot(live, tmp);
  fs.renameSync(tmp, path.join(dir, "chat.sqlite"));
  const files = copyFiles(path.join(fromDir, "uploads", "chat"), path.join(dir, "uploads", "chat"));
  const info = { at: new Date().toISOString(), from: fromDir, files };
  fs.writeFileSync(path.join(dir, "stage.json"), JSON.stringify(info, null, 2));
  return info;
}

async function testServerUp() {
  try {
    const res = await fetch("http://127.0.0.1:3300/api/health", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** --auto: 試験期間が終わったか・どこから読むか。まだなら理由 (次の定期実行で読み直す) */
async function autoSource() {
  if (Date.now() < END_AT) return { wait: "まだ試験期間です (12/1 0:00 まで)" };
  // 0:00 の end (サーバーを止める → 控え → 削除) が終わるのを待つ
  if (Date.now() < END_AT + 5 * 60e3) return { wait: "試験期間の終わりの処理 (0:00) が終わるのを待っています" };
  if (fs.existsSync(SNIPPET)) return { wait: "まだ画面がテスト用のサーバーを向いています (end の途中か、まだ動いていない)" };
  if (await testServerUp()) return { wait: "テスト用のサーバーがまだ動いています" };
  if (fs.existsSync(path.join(TESTWEEK_DATA, "chat.sqlite"))) return { from: TESTWEEK_DATA };
  const final = latestFinal();
  const finalNew = final && fs.statSync(final).mtimeMs >= END_AT;
  if (finalNew && readable(final)) return { from: final };
  const stage = path.join(STAGE, "stage.json");
  if (fs.existsSync(stage)) {
    const at = JSON.parse(fs.readFileSync(stage, "utf8")).at;
    // 期間の終わりの 1 時間前より新しい写しだけ (それより古ければ、控えを読めるようにしてもらう)
    if (Date.parse(at) >= END_AT - 3600e3) return { from: STAGE, note: `期間の終わりの控えを読めないため、${jst(new Date(at))} のテスト用のチャットの写しから引き継ぎます (それより後のメッセージは控え ${final ?? "なし"} にだけあります)` };
  }
  if (finalNew) return { wait: `期間の終わりの控え ${final} を読めません (root だけが読める)。sudo chown ichijoya: ${final} で読めるようにしてください` };
  return { wait: "期間の終わりの控え (testweek-final-*.tar.gz) がまだありません" };
}

function parseArgs(argv) {
  const out = { apply: false, auto: false, stage: false, to: "/srv/ichijoya/data" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--auto") out.auto = true;
    else if (a === "--stage") out.stage = true;
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`知らない指定: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
    return;
  }
  const log = (s) => console.log(`[${jst()}] ${s}`);
  if (args.stage) {
    const r = stageChat(args.from ?? TESTWEEK_DATA, STAGE);
    if (r) log(`写しを残しました: ${STAGE} (ファイル 写す ${r.files.copied} 件・同じもの ${r.files.same} 件)`);
    else log(`テスト用のチャットがありません (${args.from ?? TESTWEEK_DATA})`);
    return;
  }
  const target = path.join(args.to, "chat.sqlite");
  const targetFiles = path.join(args.to, "uploads", "chat");
  if (!fs.existsSync(target)) throw new Error(`${target} がありません (本番のサーバーを一度起動するか、チャットの画面を開いてから)`);
  // すでに引き継いでいれば何もしない (定期実行は毎回ここで終わる)
  {
    const t = new DatabaseSync(target, { readOnly: true });
    const done = t.prepare("select v from meta where k = ?").get(MARK);
    t.close();
    if (done) {
      if (!args.auto) log(`引き継ぎ済みです: ${done.v}`);
      return;
    }
  }
  let from = args.from;
  if (!from && args.auto) {
    const s = await autoSource();
    if (s.wait) return log(`待ちます: ${s.wait}`);
    from = s.from;
    if (s.note) log(`注意: ${s.note}`);
  }
  if (!from) {
    from = fs.existsSync(path.join(TESTWEEK_DATA, "chat.sqlite")) ? TESTWEEK_DATA : latestFinal() && readable(latestFinal()) ? latestFinal() : fs.existsSync(path.join(STAGE, "chat.sqlite")) ? STAGE : undefined;
    if (!from) throw new Error("元が見つかりません (--from で指定してください)");
  }
  if (args.apply && path.resolve(from) === TESTWEEK_DATA && (await testServerUp())) throw new Error("テスト用のサーバーが動いているあいだは書き込みません (試験期間の終わりのあとに実行してください)");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-chat-carry-"));
  try {
    const src = prepareSource(from, work);
    log(`元: ${src.label}`);
    log(`先: ${target}${args.apply ? "" : " (予行: 写しに書いて結果を出すだけ。本番は変えません)"}`);
    let into = target;
    if (!args.apply) {
      into = path.join(work, "target-copy.sqlite");
      snapshot(target, into);
    }
    const files = copyFiles(src.files, targetFiles, !args.apply);
    log(`ファイル (uploads/chat): 写す ${files.copied} 件・同じもの ${files.same} 件${files.conflicts.length ? `・大きさの違う同じ名前 ${files.conflicts.length} 件 (本番のまま): ${files.conflicts.slice(0, 5).join(", ")}` : ""}`);
    const res = mergeChatDb(into, src.db, { cutoff: new Date(END_AT).toISOString(), info: { source: src.label, files: { copied: files.copied, same: files.same, conflicts: files.conflicts.length } } });
    if (res.already) return log(`引き継ぎ済みです: ${JSON.stringify(res.already)}`);
    for (const [name, c] of Object.entries(res.tables)) if (c.source || c.removed) log(`  ${name}: 元 ${c.source} 行 → 足す ${c.added}・新しくする ${c.updated}・本番のまま ${c.kept}${c.removed ? `・消す ${c.removed}` : ""}`);
    log(`rev: ${res.revOffset} から付け直し、いまの rev = ${res.rev}`);
    log(args.apply ? "引き継ぎました" : "予行を終えました (--apply で本番に書きます)");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[${jst()}] エラー: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
