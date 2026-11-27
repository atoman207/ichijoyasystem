/**
 * 試験期間のチャットを本番に引き継ぐ道具 (scripts/ops/testweek-chat-carryover.mjs) のテスト。お客様のご指示 2026-11-27
 *   node scripts/tests/chat/carryover.test.mjs   (npm run test:chat に含む)
 * テスト用 (元) と本番 (先) のチャットを本物の表の定義 (src/lib/chat/db.ts) で作り、期間中のメッセージ・12/1 からの本番のメッセージ・
 * 両方に入れたメンバーの変更・画像・既読を、控え (tar.gz。WAL のまま) から取り出して足す。名前・ID は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-chat-carry-test-"));
const SRC_DIR = path.join(work, "testweek-data");
const DST_DIR = path.join(work, "prod-data");
fs.mkdirSync(SRC_DIR, { recursive: true });
fs.mkdirSync(DST_DIR, { recursive: true });
for (const k of Object.keys(process.env)) if (/^(CHAT_DB_PATH|CHATBOT_DB_PATH|FILE_STORAGE_DIR)$/.test(k)) delete process.env[k];
process.env.TZ = "Asia/Tokyo";
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const D = await jiti.import(path.join(root, "src/lib/chat/db.ts"));
const R = await jiti.import(path.join(root, "src/lib/chat/repo.ts"));
const C = await import(path.join(root, "scripts/ops/testweek-chat-carryover.mjs"));

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fails.push(msg);
    console.log("  ✗", msg);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n■ ${t}`);

const openChat = (dir) => {
  D.closeChatDb();
  process.env.CHAT_DB_PATH = path.join(dir, "chat.sqlite");
  return D.chatDb();
};
const A = "u_test_a"; // 管理者 (架空)
const B = "u_test_b";
const DM = `dm:${A}+${B}`;
const dmDef = { id: DM, kind: "dm" };
const custom = { id: "c_test_room", kind: "custom" };
const send = (id, channel, userId, body, at, extra = {}) =>
  R.insertMessage({ id, channel, userId, body, at, important: false, recipients: [], mentionAll: false, mentionIds: [], files: [], links: [], uploadIds: [], ...extra });
// 既読の日時をそのまま入れる (R.markRead は今より先の日時にしないため、12/1 の日時を入れられない)
const setRead = (u, k, at) => D.chatDb().prepare("insert into reads (user_id, key, at) values (?, ?, ?) on conflict (user_id, key) do update set at = excluded.at").run(u, k, at);
const file = (dir, rel, text) => {
  const f = path.join(dir, "uploads", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

/* ---------- 期間の前: 両方に同じ管理者のメンバーと画像を入れた (11/26) ---------- */
const PRE = "2026-11-26T01:03:31.000Z";
for (const dir of [SRC_DIR, DST_DIR]) {
  openChat(dir);
  R.setMemberOverrides("store:koshi", [{ userId: A, op: "add" }, { userId: B, op: "add" }], "system", PRE);
  R.setMemberOverrides("managers", [{ userId: A, op: "add" }], "system", PRE);
  R.setChannelImage("store:koshi", { key: `chat/channel-images/store_koshi-${dir === SRC_DIR ? "src" : "dst"}.webp`, type: "image/webp" }, "system", PRE);
}
file(SRC_DIR, "chat/channel-images/store_koshi-src.webp", "src-image");
file(DST_DIR, "chat/channel-images/store_koshi-dst.webp", "dst-image");

/* ---------- 期間中 (テスト用のサーバー) ---------- */
openChat(SRC_DIR);
R.upsertChannel({ id: custom.id, kind: "custom", name: "現場の連絡", members: [A, B], createdBy: A, at: "2026-11-27T01:00:00.000Z", visibility: "public" });
R.ensureChannel({ id: DM, kind: "dm", members: [A, B], createdBy: A, at: "2026-11-27T01:00:00.000Z" });
send("m_src_1", custom, A, "期間中のお知らせ", "2026-11-27T01:01:00.000Z", { mentionIds: [B] });
send("m_src_2", custom, B, "スレッドの返信", "2026-11-27T01:02:00.000Z", { parentId: "m_src_1" });
send("m_src_3", dmDef, A, "期間中の DM", "2026-11-28T02:00:00.000Z", { files: [{ id: "f1", name: "写真.jpg", type: "image/jpeg", size: 8, key: "chat/2026-11/f1.jpg", photo: true }] });
R.toggleReaction("m_src_1", B, "👍", "2026-11-27T01:03:00.000Z");
R.setPin(custom.id, "m_src_1", A, true, "2026-11-27T01:04:00.000Z");
R.setStar(B, custom.id, true, "2026-11-27T01:05:00.000Z");
R.setChannelNotify(B, custom.id, "all");
setRead(B, custom.id, "2026-11-29T00:00:00.000Z");
setRead(A, DM, "2026-11-28T02:00:00.000Z");
R.setTyping(A, custom.id);
// 期間中に管理者が B を店長のチャンネルに足し、合志店の B を自動に戻した (行を消した)
R.setMemberOverrides("managers", [{ userId: B, op: "add" }], A, "2026-11-28T00:00:00.000Z");
R.setMemberOverrides("store:koshi", [{ userId: B, op: null }], A, "2026-11-28T00:00:00.000Z");
R.setChannelImage("store:chuo", { key: "chat/channel-images/store_chuo-src.webp", type: "image/webp" }, A, "2026-11-28T00:00:00.000Z");
file(SRC_DIR, "chat/2026-11/f1.jpg", "photo-01");
file(SRC_DIR, "chat/channel-images/store_chuo-src.webp", "chuo");
file(SRC_DIR, "chat/2026-11/same.bin", "same");
file(SRC_DIR, "chat/2026-11/clash.bin", "from-test-week");
const srcRev = D.currentRev();

/* ---------- 12/1 から (本番): 引き継ぐ前に同じ DM に書いた ---------- */
openChat(DST_DIR);
R.ensureChannel({ id: DM, kind: "dm", members: [A, B], createdBy: B, at: "2026-12-01T00:01:00.000Z" });
send("m_dst_1", dmDef, B, "12/1 の DM", "2026-12-01T00:02:00.000Z");
setRead(A, DM, "2026-12-01T00:03:00.000Z");
// 本番の古い既読 (期間中のほうが新しい)
setRead(B, custom.id, "2026-11-20T00:00:00.000Z");
file(DST_DIR, "chat/2026-11/same.bin", "same");
file(DST_DIR, "chat/2026-11/clash.bin", "prod");
const dstRevBefore = D.currentRev();
// 古い chat.sqlite に表がないとき (元の定義で作る)
D.chatDb().exec("drop table stars");
D.closeChatDb();

/* ---------- 控え (tar.gz) を作る: テスト用のサーバーは WAL のまま (接続を開いたまま) ---------- */
section("控え (tar.gz) から取り出す");
const live = new DatabaseSync(path.join(SRC_DIR, "chat.sqlite"));
live.exec("pragma wal_autocheckpoint = 0");
live.prepare("insert into messages (id, channel_id, user_id, body, at, rev) values ('m_src_wal', ?, ?, 'WAL にだけある', '2026-11-30T14:59:00.000Z', ?)").run(custom.id, B, srcRev + 1);
live.prepare("update meta set v = ? where k = 'rev'").run(String(srcRev + 1));
fs.writeFileSync(path.join(SRC_DIR, "testweek-db.json"), "{}");
file(SRC_DIR, "attachments/other.pdf", "not chat");
ok(fs.existsSync(path.join(SRC_DIR, "chat.sqlite-wal")) && fs.statSync(path.join(SRC_DIR, "chat.sqlite-wal")).size > 0, "テスト用のチャットは WAL に書いたまま");
const tarFile = path.join(work, "testweek-final-20261201.tar.gz");
const names = execFileSync("sh", ["-c", "find . -type f -printf '%P\\n' | sort"], { cwd: SRC_DIR, encoding: "utf8" });
execFileSync("tar", ["-czf", tarFile, "-T", "-"], { cwd: SRC_DIR, input: names });
live.close();
const prepWork = fs.mkdtempSync(path.join(work, "prep-"));
const src = C.prepareSource(tarFile, prepWork);
ok(fs.existsSync(path.join(src.files, "2026-11", "f1.jpg")), "uploads/chat のファイルを取り出す");
ok(!fs.existsSync(path.join(prepWork, "extract", "uploads", "attachments")) && !fs.existsSync(path.join(prepWork, "extract", "testweek-db.json")), "チャット以外 (データベース・ほかの添付) は取り出さない");
{
  const s = new DatabaseSync(src.db, { readOnly: true });
  eq(s.prepare("select body from messages where id = 'm_src_wal'").get()?.body, "WAL にだけある", "WAL にだけある行も写しに入る");
  s.close();
}

section("--stage の写し (控えを読めないときの予備)");
{
  const stageDir = path.join(work, "stage");
  const r1 = C.stageChat(SRC_DIR, stageDir);
  ok(r1 && fs.existsSync(path.join(stageDir, "chat.sqlite")) && fs.existsSync(path.join(stageDir, "stage.json")), "写しと日時 (stage.json) を残す");
  eq(r1.files.copied, 5, "uploads/chat のファイルを写す");
  const r2 = C.stageChat(SRC_DIR, stageDir);
  eq([r2.files.copied, r2.files.same], [0, 5], "2 回目はファイルを足すだけ");
  eq((fs.statSync(stageDir).mode & 0o777).toString(8), "700", "写しのフォルダーは本人だけが読める");
  const st = C.prepareSource(stageDir, fs.mkdtempSync(path.join(work, "prep-stage-")));
  const s2 = new DatabaseSync(st.db, { readOnly: true });
  eq(Number(s2.prepare("select count(*) n from messages").get().n), 4, "写しから元を作れる (WAL の行を含む 4 件)");
  s2.close();
  eq(C.stageChat(path.join(work, "none"), stageDir), undefined, "テスト用のチャットがなければ何もしない");
}

/* ---------- 予行 (写しに書く) と本番 ---------- */
section("予行 (本番は変えない)");
{
  const copy = path.join(prepWork, "target-copy.sqlite");
  const t = new DatabaseSync(path.join(DST_DIR, "chat.sqlite"), { readOnly: true });
  t.prepare("vacuum into ?").run(copy);
  t.close();
  const dry = C.copyFiles(src.files, path.join(DST_DIR, "uploads", "chat"), true);
  eq([dry.copied, dry.same, dry.conflicts], [3, 1, ["2026-11/clash.bin"]], "ファイル: 写す 3・同じもの 1・大きさの違う同じ名前 1 (数えるだけ)");
  ok(!fs.existsSync(path.join(DST_DIR, "uploads", "chat", "2026-11", "f1.jpg")), "予行ではファイルを写さない");
  const r = C.mergeChatDb(copy, src.db, { cutoff: "2026-11-30T15:00:00.000Z" });
  eq(r.tables.messages.added, 4, "予行: メッセージ 4 件を足す");
  const t2 = new DatabaseSync(path.join(DST_DIR, "chat.sqlite"), { readOnly: true });
  eq(Number(t2.prepare("select count(*) n from messages").get().n), 1, "予行のあとも本番のメッセージは 1 件のまま");
  eq(t2.prepare("select v from meta where k = ?").get(C.MARK), undefined, "予行では印を残さない");
  t2.close();
}

section("本番に書く");
const files = C.copyFiles(src.files, path.join(DST_DIR, "uploads", "chat"));
eq([files.copied, files.same, files.conflicts.length], [3, 1, 1], "ファイル: 3 件を写す");
eq(fs.readFileSync(path.join(DST_DIR, "uploads", "chat", "2026-11", "clash.bin"), "utf8"), "prod", "同じ名前の本番のファイルは上書きしない");
const res = C.mergeChatDb(path.join(DST_DIR, "chat.sqlite"), src.db, { cutoff: "2026-11-30T15:00:00.000Z", info: { source: "test" } });
eq(res.revOffset, dstRevBefore + 1, "rev は本番のいまの rev のあとから付け直す");
eq(res.rev, dstRevBefore + srcRev + 2, "meta の rev = 本番の rev + 元の rev + 1");
eq(res.tables.typing, undefined, "入力中は運ばない");
eq([res.tables.channel_members.added, res.tables.channel_members.removed], [1, 1], "メンバー: 期間中に足した B (店長) を足し、期間中に自動に戻した B (合志店) の本番の行を消す");
eq([res.tables.channel_meta.added, res.tables.channel_meta.kept], [1, 1], "画像: 期間中に入れた中央店を足し、同じ日時の合志店は本番のまま");
eq(res.tables.reads.updated, 1, "既読: 期間中のほうが新しい B の既読だけを新しくする");

openChat(DST_DIR);
const dm = R.channelMessages(DM).rows.map((m) => m.id);
eq(dm, ["m_src_3", "m_dst_1"], "1 対 1 の DM: 期間中と 12/1 のメッセージが同じチャンネルに日時の順で並ぶ");
eq(R.channelMessages(custom.id).rows.map((m) => m.id), ["m_src_1", "m_src_wal"], "追加したチャンネルのメッセージ (スレッドの返信は流れに出さない)");
eq(R.replies("m_src_1").map((m) => m.id), ["m_src_2"], "スレッドの返信");
eq(R.getMessage("m_src_1")?.replyCount, 1, "返信の数もそのまま");
eq(R.changedSince(custom.id, dstRevBefore).messages.map((m) => m.id), ["m_src_1", "m_src_wal"], "開いている画面 (本番の rev まで読んだ) が引き継いだ行を新しい行として読む");
ok(R.getMessage("m_dst_1").rev <= dstRevBefore, "12/1 からの本番の行の rev は変えない");
eq(R.getMessage("m_src_3")?.files?.[0]?.key, "chat/2026-11/f1.jpg", "資料の key はそのまま (ファイルは写した)");
const ov = R.memberOverrides();
eq([...(ov.get("managers")?.add ?? [])].sort(), [A, B], "店長のチャンネル: 期間中に足したメンバーが入る");
eq([...(ov.get("store:koshi")?.add ?? [])], [A], "合志店: 期間中に自動に戻した B は本番でも自動");
eq(R.channelMeta("store:koshi")?.imageKey, "chat/channel-images/store_koshi-dst.webp", "同じ日時の画像は本番のまま");
eq(R.channelMeta("store:chuo")?.imageKey, "chat/channel-images/store_chuo-src.webp", "期間中に入れた画像を足す");
eq(R.readsOf(A).get(DM), "2026-12-01T00:03:00.000Z", "本番のほうが新しい既読は本番のまま");
eq(R.readsOf(B).get(custom.id), "2026-11-29T00:00:00.000Z", "期間中の既読");
ok(R.starsOf(B).has(custom.id), "本番になかった表 (スター) も作って入れる");
eq(R.pinnedMessages(custom.id).map((m) => m.id), ["m_src_1"], "ピン留め");
eq(R.notifyFor(B, custom), "all", "チャンネルごとの通知の設定");
eq(R.typingIn(custom.id, B), [], "入力中は運ばない");
const next = D.tx((db) => D.nextRev(db));
ok(next > res.rev, "このあとの書き込みの rev は引き継いだ行より後");
D.closeChatDb();

section("2 回目は何もしない");
const again = C.mergeChatDb(path.join(DST_DIR, "chat.sqlite"), src.db, { cutoff: "2026-11-30T15:00:00.000Z" });
eq(again.already?.source, "test", "引き継ぎ済みの印 (meta の testweek_carryover) を返す");
{
  const t = new DatabaseSync(path.join(DST_DIR, "chat.sqlite"), { readOnly: true });
  eq(Number(t.prepare("select count(*) n from messages").get().n), 5, "メッセージは 5 件のまま (重ねない)");
  t.close();
}
let threw = "";
try {
  C.mergeChatDb(src.db, src.db);
} catch (e) {
  threw = String(e.message);
}
ok(threw.includes("同じ"), "元と先が同じファイルなら断る");

section("道具をコマンドで動かす (予行・本番・2 回目)");
{
  // 新しい先 (12/1 の前の本番と同じ: 管理者のメンバーと画像だけ)
  const DST2 = path.join(work, "prod2");
  fs.mkdirSync(DST2);
  openChat(DST2);
  R.setMemberOverrides("managers", [{ userId: A, op: "add" }], "system", PRE);
  D.closeChatDb();
  const cli = (...a) => execFileSync(process.execPath, [path.join(root, "scripts/ops/testweek-chat-carryover.mjs"), "--from", tarFile, "--to", DST2, ...a], { encoding: "utf8" });
  const dryOut = cli();
  ok(dryOut.includes("予行") && dryOut.includes("messages: 元 4 行 → 足す 4"), "予行: 足す行の数を出す");
  ok(!fs.existsSync(path.join(DST2, "uploads", "chat")), "予行: ファイルを写さない");
  const out = cli("--apply");
  ok(out.includes("引き継ぎました"), "--apply: 引き継ぐ");
  ok(fs.existsSync(path.join(DST2, "uploads", "chat", "2026-11", "f1.jpg")), "--apply: ファイルを写す");
  const out2 = cli("--apply");
  ok(out2.includes("引き継ぎ済み"), "2 回目: 何もしない");
  const t = new DatabaseSync(path.join(DST2, "chat.sqlite"), { readOnly: true });
  eq(Number(t.prepare("select count(*) n from messages").get().n), 4, "メッセージ 4 件");
  t.close();
}

D.closeChatDb();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} 件 合格 / ${fails.length} 件 不合格`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
