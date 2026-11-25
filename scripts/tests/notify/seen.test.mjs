/**
 * ヘッダーの数字の「確認済み」のテスト (お客様のご要望 2026-11-26: 通知を確認したら数字が小さくなり、すべて確認したら消える)
 *   node scripts/tests/notify/seen.test.mjs   (npm run test:notify)
 * - src/lib/notify-seen.ts: キー・確認したことになる画面・数え方
 * - src/components/layout/seen-store.ts: ブラウザーへの保存・ほかのタブ・上限・以前の保存の削除 (localStorage は偽物)
 * - src/lib/db/queries.ts の notificationsFor・reception.ts の pendingReceptionIds: 数字と記録の ID の数が同じ
 * データは一時フォルダーの JSON (サンプルデータ)。AI・外部への送信は使わない
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-notify-seen-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "notify-seen-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  CHAT_DB_PATH: path.join(work, "chat.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-notify-seen",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)) delete process.env[k];
process.chdir(work);
const stubs = path.join(root, "scripts/tests/ops-reports/stubs");
const jiti = createJiti(import.meta.url, {
  alias: {
    "next/navigation": path.join(stubs, "next-navigation.cjs"),
    "next/cache": path.join(stubs, "next-cache.cjs"),
    "@/lib/auth/session": path.join(stubs, "session.cjs"),
    "@": path.join(root, "src"),
    "server-only": path.join(root, "scripts/tests/maps/empty.cjs"),
  },
  moduleCache: true,
});
const imp = (p) => jiti.import(path.join(root, "src", p));

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

// ---------------------------------------------------------------------------
section("キーと確認したことになる画面 (notify-seen.ts)");
const S = await imp("lib/notify-seen.ts");
eq(S.seenKey("inq", "q_1"), "inq:q_1", "印なしのキー");
eq(S.seenKey("ev", "e_1", "2026-11-26T01:00:00Z"), "ev:e_1@2026-11-26T01:00:00Z", "印つきのキー");
eq(S.seenKey("ks", "src1", ""), "ks:src1", "空の印は付けない");
eq(S.viewPaths("inq:q_1"), ["/inquiries/q_1"], "問い合わせ → その問い合わせの画面");
eq(S.viewPaths("ev:e_1@2026-11-26T01:00:00Z"), ["/schedule/e_1", "/schedule/e_1/edit"], "予定の印は画面に入れない");
eq(S.viewPaths("cf:a_1+b_2"), ["/schedule/a_1", "/schedule/b_2", "/schedule?conflicts=1"], "重複の組 → どちらかの予定・重複の一覧");
eq(S.viewPaths("unknown:x"), [], "知らない種類は画面なし");
eq(S.viewPaths("broken"), [], "形の違うキーは画面なし");

const sp = (q) => new URLSearchParams(q);
ok(S.pathMatches("/approvals?tab=mine", "/approvals", sp("tab=mine")), "承認の一覧 (あなたの承認待ち) に当たる");
ok(S.pathMatches("/approvals?tab=", "/approvals", sp("")), "承認の一覧 (タブの指定なし = 既定) に当たる");
ok(!S.pathMatches("/approvals?tab=mine", "/approvals", sp("tab=history")), "承認の履歴のタブは当たらない");
ok(!S.pathMatches("/approvals?tab=", "/approvals", sp("tab=history")), "タブの指定ありは「指定なし」に当たらない");
ok(!S.pathMatches("/inquiries/q_1", "/inquiries/q_10", sp("")), "ID の前方一致では当たらない");
ok(S.pathMatches("/schedule?conflicts=1", "/schedule", sp("view=list&user=me&store=all&conflicts=1")), "ほかの検索の値があっても当たる");

const keys = ["inq:q_1", "inq:q_2", "apv:a_1", "apv:a_2", "inv:i_1", "cf:e_1+e_2", "lv:l_1", "chg:c_1@2026-11-26T00:00:00Z"];
eq(S.keysViewedAt(keys, "/inquiries/q_2", sp("")), ["inq:q_2"], "問い合わせを 1 件開く → その 1 件だけ確認済み");
eq(S.keysViewedAt(keys, "/inquiries", sp("status=new")), [], "問い合わせの一覧を開いただけでは確認済みにしない");
eq(S.keysViewedAt(keys, "/approvals", sp("tab=mine")), ["apv:a_1", "apv:a_2"], "承認の一覧 → 一覧に出ている承認待ちをすべて確認済み");
eq(S.keysViewedAt(keys, "/schedule/e_2", sp("")), ["cf:e_1+e_2"], "重複している予定の片方を開く → その重複を確認済み");
eq(S.keysViewedAt(keys, "/leave", sp("")), ["lv:l_1"], "休暇の承認 (既定のタブ) → 確認済み");
eq(S.keysViewedAt(keys, "/notices", sp("")), ["chg:c_1@2026-11-26T00:00:00Z"], "変更のお知らせの一覧 → 確認済み");

const seen = new Set(["inq:q_1", "apv:a_1"]);
eq(S.unseenCount(["inq:q_1", "inq:q_2"], seen), 1, "数字 = 確認していない記録の数 (2 件のうち 1 件を確認 → 1)");
eq(S.unseenCount(["inq:q_1"], seen), 0, "すべて確認 → 0 (数字を出さない)");
eq(S.unseenCount(undefined, seen), 0, "キーなし → 0");

// ---------------------------------------------------------------------------
section("ブラウザーへの保存 (seen-store.ts。localStorage・window は偽物)");
const storage = new Map();
const winListeners = new Set();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.window = {
  addEventListener: (type, fn) => type === "storage" && winListeners.add(fn),
  removeEventListener: (type, fn) => type === "storage" && winListeners.delete(fn),
};
const Store = await imp("components/layout/seen-store.ts");
const KEY = "ichijoya:seen:u_test";
storage.set(KEY, JSON.stringify(["inq:old"]));
const snap1 = Store.seenSnapshot(KEY);
ok(snap1.has("inq:old"), "保存してある確認済みを読む");
ok(Store.seenSnapshot(KEY) === snap1, "変わらなければ同じ Set (useSyncExternalStore が繰り返し描画しない)");
let notified = 0;
const unsub = Store.subscribeSeen(KEY, () => notified++);
Store.addSeen(KEY, ["inq:q_1", "inq:q_1", "apv:a_1"]);
const snap2 = Store.seenSnapshot(KEY);
ok(snap2 !== snap1 && snap2.has("inq:q_1") && snap2.has("apv:a_1"), "確認済みにすると新しい Set");
eq(JSON.parse(storage.get(KEY)), ["inq:old", "inq:q_1", "apv:a_1"], "確認した順に保存 (重複なし)");
eq(notified, 1, "画面に知らせる");
Store.addSeen(KEY, ["inq:q_1"]);
eq(notified, 1, "確認済みのものをまた押しても何もしない");
// ほかのタブ
storage.set(KEY, JSON.stringify(["inq:old", "inq:q_1", "apv:a_1", "inv:i_9"]));
for (const fn of winListeners) fn({ key: KEY });
ok(Store.seenSnapshot(KEY).has("inv:i_9"), "ほかのタブで確認した記録を読み直す");
eq(notified, 2, "ほかのタブの変更も画面に知らせる");
for (const fn of winListeners) fn({ key: "other-key" });
eq(notified, 2, "ほかのキーの変更は無視");
// 上限
Store.addSeen(KEY, Array.from({ length: 3005 }, (_, i) => `inq:many_${i}`));
const saved = JSON.parse(storage.get(KEY));
eq(saved.length, 3000, "多すぎるときは 3,000 件まで");
ok(!saved.includes("inq:old") && saved.includes("inq:many_3004"), "古いものから捨てる");
unsub();
eq(winListeners.size, 0, "購読をやめると storage のイベントも外す");
storage.set("ichijoya:read-notifications:u_test", "[]");
Store.dropLegacyRead("u_test");
ok(!storage.has("ichijoya:read-notifications:u_test"), "以前の既読の保存 (通知の文面ごと) を消す");
// localStorage が使えない
globalThis.localStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};
const KEY2 = "ichijoya:seen:u_private";
eq(Store.seenSnapshot(KEY2).size, 0, "使えない環境: 空から始める");
Store.addSeen(KEY2, ["apv:a_5"]);
ok(Store.seenSnapshot(KEY2).has("apv:a_5"), "使えない環境: 画面を開いている間は覚える");
Store.dropLegacyRead("u_private");
ok(true, "使えない環境: 以前の保存を消すときも止まらない");
delete globalThis.localStorage;
delete globalThis.window;

// ---------------------------------------------------------------------------
section("数字と記録の ID (queries.ts・reception.ts。サンプルデータ)");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const { notificationsFor } = await imp("lib/db/queries.ts");
const { pendingReceptionCount, pendingReceptionIds } = await imp("lib/reception.ts");
const users = db().users.filter((u) => u.active);
let checked = 0;
for (const role of ["admin", "store_manager", "store_staff"]) {
  const u = users.find((x) => x.role === role);
  if (!u) continue;
  const n = notificationsFor(u);
  eq(n.overdueInvoiceIds.length, n.overdueInvoices, `${role}: 期日超過の請求の ID の数 = 件数 (${n.overdueInvoices})`);
  eq(n.newInquiryIds.length, n.newInquiries, `${role}: 未対応の問い合わせの ID の数 = 件数 (${n.newInquiries})`);
  eq(n.conflictPairs.length, n.myConflicts, `${role}: 重複の組の数 = 件数 (${n.myConflicts})`);
  ok(n.conflictPairs.every((p) => /^[^+]+\+[^+]+$/.test(p)), `${role}: 重複の組は「予定 ID + 予定 ID」`);
  ok(n.assignedEvents.every((e) => typeof e.stamp === "string"), `${role}: 担当になった予定に変更日時の印`);
  eq(pendingReceptionIds(db(), u).length, pendingReceptionCount(db(), u), `${role}: 確認待ちの受付の ID の数 = 件数`);
  ok(new Set(n.overdueInvoiceIds).size === n.overdueInvoiceIds.length && new Set(n.newInquiryIds).size === n.newInquiryIds.length, `${role}: ID は重複しない`);
  checked++;
}
ok(checked >= 2, `ロールごとに確かめた (${checked} ロール)`);
const someInv = db().invoices.find((i) => i.status === "overdue" || i.status === "issued");
if (someInv) ok(S.viewPaths(S.seenKey("inv", someInv.id)).includes(`/invoices/${someInv.id}`), "請求書のキー → その請求書の画面");

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} 件 OK${fails.length ? ` / ${fails.length} 件 NG` : ""}`);
if (fails.length) {
  for (const f of fails) console.log("  NG:", f);
  process.exit(1);
}
