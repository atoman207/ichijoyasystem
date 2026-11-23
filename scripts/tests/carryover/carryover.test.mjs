// 実行: npm run test:carryover (または node scripts/tests/carryover/carryover.test.mjs)
// 試験期間のデータの本番への引き継ぎ (scripts/ops/testweek-carryover.mjs) のテスト。
// データはこのファイルの中の架空の記録だけ (一時フォルダーに作る)。本番・テスト用のデータベースには接続しない (書き込み先は JSON)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { makePlan, runApply, parseWhen } from "../../ops/testweek-carryover.mjs";

let pass = 0;
const fails = [];
const ok = (cond, msg) => (cond ? (pass++, console.log("  ✓", msg)) : (fails.push(msg), console.log("  ✗", msg)));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carryover-test-"));
const T0 = "2026-11-22T15:31:00.000Z"; // 期間の始まり (11/23 0:31 JST)
const at = (jst) => new Date(`${jst}+09:00`).toISOString();

// ---- 期間の始まりの本番 (控え)
const base = {
  stores: [{ id: "chuo", code: "02", name: "中央店", shortName: "中央", kind: "store", color: "#00f" }],
  users: [
    { id: "u_mgr", name: "店長 一", email: "mgr@example.test", role: "store_manager", storeId: "chuo", passwordHash: "h-old", kana: "", title: "店長", active: true },
    { id: "u_adm", name: "管理 二", email: "adm@example.test", role: "admin", storeId: "chuo", passwordHash: "h-adm", kana: "", title: "社長", active: true },
  ],
  customers: [{ id: "c_old0001", code: "C-00001", name: "既存 太郎", type: "individual", storeId: "chuo", preferredChannel: "phone", firstContactChannel: "phone", tags: [], contacts: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  inquiries: [{ id: "inq_old0001", number: "INQ-2026-0001", customerId: "c_old0001", contactName: "既存 太郎", channel: "phone", storeId: "chuo", category: "tatami", summary: "前からの問い合わせ", status: "new", receivedAt: "2026-11-01T00:00:00.000Z", createdBy: "u_mgr", updatedAt: "2026-11-01T00:00:00.000Z" }],
  quotes: [],
  auditLogs: [],
  attachments: [],
  suppliers: [],
  purchases: [],
  settings: [{ id: "knowledge_sync_state", value: { lastCronAt: "2026-11-22T14:00:00.000Z" }, updatedAt: "2026-11-22T14:00:00.000Z" }],
  meta: { version: 3, copyOfSavedAt: "2026-11-22T14:21:42.169Z", copiedAt: T0 },
};
const SAVED = "2026-11-22T14:21:42.169Z";
const baseFile = path.join(dir, "base.ndjson.gz");
const lines = [JSON.stringify({ v: 1, revision: 354, savedAt: SAVED })];
for (const [k, rows] of Object.entries(base)) if (Array.isArray(rows)) for (const r of rows) lines.push(`${k}\t${JSON.stringify(r)}`);
fs.writeFileSync(baseFile, zlib.gzipSync(lines.join("\n") + "\n"));

// ---- 期間の終わりのテスト用のデータベース
const test = structuredClone(base);
const t1 = at("2026-11-23T13:05:00"), t2 = at("2026-11-23T13:10:00"), t3 = at("2026-11-24T09:00:00"), t0 = at("2026-11-23T09:00:00");
// 会議 (11/23) の本番さながらの登録: 新しいお客様 → 問い合わせ (受付日は過去) → 見積 → 写真
test.customers.push({ id: "c_new0001", code: "C-00002", name: "会議 花子", type: "individual", storeId: "chuo", preferredChannel: "phone", firstContactChannel: "phone", tags: [], contacts: [], createdAt: t1, updatedAt: t1 });
test.inquiries.push({ id: "inq_new0001", number: "INQ-2026-0002", customerId: "c_new0001", contactName: "会議 花子", channel: "phone", storeId: "chuo", category: "tatami", summary: "表替え", status: "quoted", receivedAt: "2026-11-15T01:00:00.000Z", createdBy: "u_mgr", updatedAt: t1, quoteId: "q_new0001", media: "flyer" });
test.quotes.push({ id: "q_new0001", number: "Q-2026-0001", version: 1, customerId: "c_new0001", inquiryId: "inq_new0001", storeId: "chuo", title: "表替え 6 帖", category: "tatami", items: [{ name: "表替え", qty: 6, unitPrice: 8000 }], subtotal: 48000, discount: 0, tax: 4800, total: 52800, status: "approved", createdBy: "u_mgr", createdAt: t2, updatedAt: t2 });
test.attachments.push({ id: "att_new0001", parentType: "quote", parentId: "q_new0001", customerId: "c_new0001", storeId: "chuo", kind: "photo", fileName: "site.png", contentType: "image/png", size: 4, storageKey: "quote/2026-11/att_new0001.png", uploadedBy: "u_mgr", uploadedAt: t2 });
test.auditLogs.push({ id: "log_c1", at: t1, userId: "u_mgr", action: "create", entity: "customer", entityId: "c_new0001", summary: "顧客を登録" });
test.auditLogs.push({ id: "log_q1", at: t2, userId: "u_mgr", action: "create", entity: "quote", entityId: "q_new0001", summary: "見積を作成" });
// 既存のお客様の問い合わせ (既存の顧客の行も変わる)
test.customers[0] = { ...test.customers[0], notes: "会議で追記", updatedAt: t1 };
test.inquiries.push({ id: "inq_new0002", number: "INQ-2026-0003", customerId: "c_old0001", contactName: "既存 太郎", channel: "phone", storeId: "chuo", category: "fusuma", summary: "襖", status: "new", receivedAt: "2026-11-20T01:00:00.000Z", createdBy: "u_mgr", updatedAt: t1, media: "repeat" });
test.auditLogs.push({ id: "log_i2", at: t1, userId: "u_mgr", action: "create", entity: "inquiry", entityId: "inq_new0002", summary: "問い合わせを登録" });
// 練習 (除外する)
test.inquiries.push({ id: "inq_prac001", number: "INQ-2026-0004", contactName: "練習", channel: "phone", storeId: "chuo", category: "tatami", summary: "練習", status: "new", receivedAt: t1, createdBy: "u_mgr", updatedAt: t1, media: "unknown" });
test.auditLogs.push({ id: "log_p1", at: t1, userId: "u_mgr", action: "create", entity: "inquiry", entityId: "inq_prac001", summary: "問い合わせを登録" });
// 次の日の操作 (期間外)
test.inquiries.push({ id: "inq_next001", number: "INQ-2026-0005", contactName: "翌日", channel: "phone", storeId: "chuo", category: "tatami", summary: "翌日", status: "new", receivedAt: t3, createdBy: "u_mgr", updatedAt: t3, media: "web" });
test.auditLogs.push({ id: "log_n1", at: t3, userId: "u_mgr", action: "create", entity: "inquiry", entityId: "inq_next001", summary: "問い合わせを登録" });
// 期間より前 (11/23 の朝) に作った仕入先を、会議の日の仕入が参照する → 仕入先は依存で一緒に引き継ぐ
test.suppliers.push({ id: "sup_new0001", name: "新しい仕入先", createdAt: t0, updatedAt: t0 });
test.auditLogs.push({ id: "log_s1", at: t0, userId: "u_adm", action: "create", entity: "supplier", entityId: "sup_new0001", summary: "仕入先を登録" });
test.purchases.push({ id: "pur_new0001", number: "P-2026-0001", supplierId: "sup_new0001", storeId: "chuo", invoiceDate: "2026-11-23", dueDate: "2026-12-31", amount: 1000, status: "registered", registeredBy: "u_mgr", createdAt: t2, updatedAt: t2 });
test.auditLogs.push({ id: "log_pu1", at: t2, userId: "u_mgr", action: "create", entity: "purchase", entityId: "pur_new0001", summary: "仕入を登録" });
// ログインだけ・社員のプロフィール・設定
test.auditLogs.push({ id: "log_login", at: t1, userId: "u_mgr", action: "login", entity: "session", entityId: "u_mgr", summary: "ログイン" });
test.users[0] = { ...test.users[0], notifyEmail: "mgr-notify@example.test", role: "admin" }; // role は引き継がない項目
test.settings.push({ id: "operations", value: { customerCreators: "office_and_managers" }, updatedBy: "u_adm", updatedAt: t1 });
test.auditLogs.push({ id: "log_set1", at: t1, userId: "u_adm", action: "update", entity: "settings", entityId: "operations", summary: "顧客の新規登録ができる人" });
test.settings[0] = { ...test.settings[0], value: { lastCronAt: t3 }, updatedAt: t3 };

const testDir = path.join(dir, "test");
fs.mkdirSync(path.join(testDir, "uploads", "quote", "2026-11"), { recursive: true });
fs.writeFileSync(path.join(testDir, "uploads", "quote", "2026-11", "att_new0001.png"), "PNG!");
const testFile = path.join(testDir, "testweek-db.json");
fs.writeFileSync(testFile, JSON.stringify(test));

console.log("plan");
const out = path.join(dir, "plan");
const { plan, csvFile } = await makePlan({ test: testFile, base: baseFile, out, since: "2026-11-23 12:00", until: "2026-11-23", exclude: "INQ-2026-0004", settings: "operations" });
const sel = plan.groups.filter((g) => g.selected).map((g) => g.id).sort();
ok(JSON.stringify(sel) === JSON.stringify(["c_new0001", "inq_new0002", "pur_new0001"].sort()), `会議の日のまとまりだけを選ぶ (${sel.join(", ")})`);
ok(plan.groups.find((g) => g.id === "inq_prac001")?.reason.includes("除外"), "--exclude の番号で練習の問い合わせを除く");
ok(plan.groups.find((g) => g.id === "inq_next001")?.reason.includes("期間より後"), "次の日の問い合わせは期間外");
const g1 = plan.groups.find((g) => g.id === "c_new0001");
ok(g1 && g1.counts.inquiries?.add === 1 && g1.counts.quotes?.add === 1 && g1.counts.attachments?.add === 1 && g1.counts.auditLogs?.add === 2, "お客様・問い合わせ・見積・写真・変更履歴が 1 つのまとまり");
ok(g1?.first === t1, "まとまりの日時は操作の日時 (受付日の 11/15 ではない)");
const ids = (c) => (plan.rows[c]?.upsert ?? []).map((u) => u.id).sort();
ok(ids("suppliers").join() === "sup_new0001", "引き継ぐ仕入が参照する新しい仕入先は、期間外でも依存で一緒に引き継ぐ");
ok(ids("auditLogs").includes("log_s1"), "依存で引き継ぐ仕入先の変更履歴も一緒");
ok(ids("customers").join() === "c_new0001,c_old0001", "既存のお客様の変更も引き継ぐ");
ok(!ids("inquiries").includes("inq_prac001") && !ids("inquiries").includes("inq_next001"), "練習・期間外の行は計画に入らない");
ok(!ids("auditLogs").includes("log_login"), "ログインの記録は引き継がない");
ok(ids("settings").join() === "operations" && ids("auditLogs").includes("log_set1"), "指定した設定とその変更履歴だけ (サーバーの記録の設定は引き継がない)");
ok(plan.users.length === 1 && Object.keys(plan.users[0].fields).join() === "notifyEmail", "社員はプロフィールの項目だけ (ロールは引き継がない)");
ok(plan.files.length === 1 && plan.files[0].key === "quote/2026-11/att_new0001.png", "写真のファイルを計画に入れる");
ok(fs.readFileSync(csvFile, "utf8").startsWith("﻿\"引き継ぐ\""), "一覧の CSV (Excel 用の BOM つき)");
ok(parseWhen("2026-11-23", true) === "2026-11-23T14:59:59.999Z" && parseWhen("2026-11-23 13:00") === "2026-11-23T04:00:00.000Z", "日付・日時は日本時間");

console.log("apply (JSON)");
const freshTarget = (name, mutate) => {
  const db = structuredClone(base);
  mutate?.(db);
  const f = path.join(dir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(db));
  const d = path.join(dir, `${name}-uploads`);
  fs.mkdirSync(d, { recursive: true });
  return { f, d };
};
const quiet = { quiet: true };
const planFile = path.join(out, "carryover-plan.json");
{
  const { f, d } = freshTarget("t-ok");
  const r0 = await runApply({ ...quiet, mode: "apply", plan: planFile, target: `json:${f}`, "files-dest": d });
  ok(r0.ok && r0.mode === "rehearse" && JSON.parse(fs.readFileSync(f, "utf8")).quotes.length === 0 && !fs.existsSync(path.join(d, "quote")), "--yes がなければ予行 (データ・ファイルは変えない)");
  const r = await runApply({ ...quiet, mode: "apply", plan: planFile, target: `json:${f}`, "files-dest": d, yes: true });
  const db = JSON.parse(fs.readFileSync(f, "utf8"));
  ok(r.ok && db.quotes.length === 1 && db.inquiries.length === 3 && db.suppliers.length === 1 && db.purchases.length === 1, "書き込み: 見積・問い合わせ・仕入先・仕入");
  ok(db.customers.find((c) => c.id === "c_old0001").notes === "会議で追記", "既存のお客様の変更が入る");
  ok(db.users[0].notifyEmail === "mgr-notify@example.test" && db.users[0].role === "store_manager", "社員はプロフィールの項目だけ変わる");
  ok(db.settings.find((s) => s.id === "operations") && db.settings.find((s) => s.id === "knowledge_sync_state").value.lastCronAt === "2026-11-22T14:00:00.000Z", "指定した設定だけ入る");
  ok(fs.readFileSync(path.join(d, "quote/2026-11/att_new0001.png"), "utf8") === "PNG!", "写真のファイルを写す");
  const again = await runApply({ ...quiet, mode: "apply", plan: planFile, target: `json:${f}`, "files-dest": d, yes: true });
  ok(again.ok && again.upserted === 0 && again.files === 0 && again.already > 0, "2 回目は何もしない (同じ内容は飛ばす)");
}
{
  const { f, d } = freshTarget("t-changed", (db) => (db.customers[0].phone = "096-000-0000"));
  const r = await runApply({ ...quiet, mode: "apply", plan: planFile, target: `json:${f}`, "files-dest": d, yes: true });
  ok(!r.ok && r.conflicts.some((c) => c.includes("本番の側でも変わっています")) && JSON.parse(fs.readFileSync(f, "utf8")).quotes.length === 0, "期間中に本番の側が変わった行があれば、何も書かずに中止");
}
{
  const { f, d } = freshTarget("t-number", (db) => db.quotes.push({ id: "q_prod0001", number: "Q-2026-0001", customerId: "c_old0001", storeId: "chuo", title: "12/1 に本番で登録", category: "tatami", subtotal: 1, tax: 0, total: 1, status: "draft", createdBy: "u_mgr", createdAt: "2026-12-01T00:00:00.000Z", updatedAt: "2026-12-01T00:00:00.000Z" }));
  const r = await runApply({ ...quiet, mode: "check", plan: planFile, target: `json:${f}`, "files-dest": d });
  ok(!r.ok && r.conflicts.some((c) => c.includes("Q-2026-0001") && c.includes("重複")), "本番で同じ番号が使われていれば中止 (12/1 以降に本番で登録した記録)");
}
{
  const { f, d } = freshTarget("t-file");
  fs.mkdirSync(path.join(d, "quote/2026-11"), { recursive: true });
  fs.writeFileSync(path.join(d, "quote/2026-11/att_new0001.png"), "other");
  const r = await runApply({ ...quiet, mode: "check", plan: planFile, target: `json:${f}`, "files-dest": d });
  ok(!r.ok && r.conflicts.some((c) => c.includes("別のファイル")), "本番に同じ名前の別のファイルがあれば中止 (上書きしない)");
}
{
  const tampered = path.join(out, "tampered.json");
  const p = JSON.parse(fs.readFileSync(planFile, "utf8"));
  p.rows.quotes.upsert[0].row.total = 1;
  fs.writeFileSync(tampered, JSON.stringify(p));
  const { f } = freshTarget("t-tamper");
  await assert.rejects(runApply({ ...quiet, mode: "apply", plan: tampered, target: `json:${f}`, yes: true }), /書き換えられています/);
  ok(true, "作ったあとに書き換えた計画は使わない");
}
{
  // 練習の印 (名前に「練習」) は指定しなくても除く
  const pp = await makePlan({ test: testFile, base: baseFile, out: path.join(dir, "plan-practice"), since: "2026-11-23 12:00", until: "2026-11-23" });
  ok(pp.plan.groups.find((g) => g.id === "inq_prac001")?.reason.includes("練習") && !pp.plan.groups.find((g) => g.id === "inq_prac001").selected, "名前に「練習」とある問い合わせは指定しなくても除く");
  const pk = await makePlan({ test: testFile, base: baseFile, out: path.join(dir, "plan-keep"), since: "2026-11-23 12:00", until: "2026-11-23", "keep-practice": true });
  ok(pk.plan.groups.find((g) => g.id === "inq_prac001")?.selected, "--keep-practice なら練習の印があっても引き継ぐ");
  // 期間を指定しないと期間中のすべて (練習の除外だけ)
  const p2 = await makePlan({ test: testFile, base: baseFile, out: path.join(dir, "plan-all"), exclude: "inq_prac001" });
  const s2 = p2.plan.groups.filter((g) => g.selected).map((g) => g.id);
  ok(s2.includes("inq_next001") && s2.includes("sup_new0001") && !s2.includes("inq_prac001"), "期間の指定なし = 期間中のすべて");
  const p3 = await makePlan({ test: testFile, base: baseFile, out: path.join(dir, "plan-only"), only: "Q-2026-0001" });
  ok(p3.plan.groups.filter((g) => g.selected).map((g) => g.id).join() === "c_new0001", "--only は指定した記録のまとまりだけ");
}
{
  const other = path.join(dir, "other-base.ndjson.gz");
  fs.writeFileSync(other, zlib.gzipSync(`${JSON.stringify({ v: 1, revision: 1, savedAt: "2026-01-01T00:00:00.000Z" })}\n`));
  await assert.rejects(makePlan({ test: testFile, base: other, out: path.join(dir, "plan-x") }), /控え/);
  ok(true, "テスト用のデータベースの元と違う控えは使わない");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
