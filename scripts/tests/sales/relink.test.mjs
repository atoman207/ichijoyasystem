/**
 * 売上台帳から移行した受注を、ひも付いた販売管理ソフト (コンパス) の伝票の得意先のお客様に付け替える (src/lib/sales-relink.ts) のテスト
 * (お客様のご連絡 2026-11-28「コンパスには売上履歴があるが、新システムには売上履歴が見当たらない」)
 *   node scripts/tests/sales/relink.test.mjs   (npm run test:sales)
 * 1. 計画と書き込み: 名字と地区だけの台帳のお客様 (何人かの受注) → 伝票の得意先ごとに付け替え・つながる記録も・お客様の名前は変えない・
 *    得意先が 2 つの受注 / 得意先が未登録の受注は付け替えない・記録の残らない台帳のお客様は削除・2 回目は何もしない
 * 2. 開発担当用の手直し (/api/cron/data-fix?task=slip-customers): 確認だけ → 一覧の CSV → 書き込み
 * データは架空。外部への送信・AI は使わない
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-relink-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "relink-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-relink",
  CRON_SECRET: "test-cron-secret",
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

const RL = await imp("lib/sales-relink.ts");
const T = "2030-01-01T00:00:00.000Z";
const cust = (id, code, name, extra = {}) => ({ id, code, name, kana: "", phone: "", postalCode: "", address: "", storeId: "tamana", type: "individual", preferredChannel: "phone", tags: [], notes: "", createdAt: T, updatedAt: T, ...extra });
const note = (no) => ({ id: `pn_s${no}_fp${no}`, at: T, userId: "u", kind: "complete", body: `販売管理ソフトの売上明細より取込 (伝票№${no})` });
const ledgerNote = (id) => ({ id: `pn_${id}`, at: T, userId: "u", kind: "complete", body: "売上台帳より取込 (玉名店 売上.xlsx#2030.1!1)" });
const order = (id, number, customerId, total, slipNos) => ({ id, number, customerId, storeId: "tamana", title: "畳", category: "tatami", total, status: "paid", contractDate: "2030-01-10", salesDate: "2030-01-10", workerIds: [], progressNotes: [ledgerNote(id), ...slipNos.map(note)], createdBy: "u", createdAt: T, updatedAt: T, source: "import" });
const BUCKET = "c_aaaaaaaaaaa1"; // 「架空」(地区 みほん) = 得意先 3 人の受注を持つ台帳のお客様
const BUCKET2 = "c_aaaaaaaaaaa2"; // 伝票の受注だけを持つ台帳のお客様 (付け替えると空になる)
const makeDb = () => ({
  customers: [
    cust(BUCKET, "C-09001", "架空", { area: "みほん" }),
    cust(BUCKET2, "C-09002", "見本", { area: "みほん" }),
    cust("c_s501", "T-501", "架空 花子", { address: "架空市みほん2640" }), // 人が名前を直したお客様 (伝票では「架空 一郎」)
    cust("c_s502", "T-502", "架空 次郎", { address: "架空市みほん3021" }),
    cust("c_s503", "T-503", "見本 三郎", { address: "架空市みほん1834" }),
  ],
  orders: [
    order("o_l1", "O-2030-0001", BUCKET, 330000, ["100"]),
    order("o_l2", "O-2030-0002", BUCKET, 23430, ["200"]),
    order("o_l3", "O-2030-0003", BUCKET, 21650, ["300"]),
    order("o_l4", "O-2030-0004", BUCKET, 10000, []), // 伝票のない台帳の受注 (台帳だけ)
    order("o_l5", "O-2030-0005", BUCKET, 5000, ["400"]), // 得意先が未登録
    order("o_l6", "O-2030-0006", BUCKET, 7000, ["500", "600"]), // 得意先が 2 つ
    order("o_l7", "O-2030-0007", BUCKET2, 27700, ["700"]),
    { ...order("o_s800", "S-800", "c_s502", 1000, ["800"]), progressNotes: [note("800")] }, // 伝票から作った受注 (対象外)
  ],
  schedule: [{ id: "ev1", orderId: "o_l1", customerId: BUCKET, date: "2030-01-10", kind: "delivery", title: "納品", storeId: "tamana", assigneeIds: [] }],
  surveys: [{ id: "sv1", orderId: "o_l2", customerId: BUCKET, storeId: "tamana" }],
  attachments: [{ id: "a1", parentType: "order", parentId: "o_l3", customerId: BUCKET, storeId: "tamana", kind: "photo", fileName: "x.jpg", contentType: "image/jpeg", size: 1, storageKey: "k", uploadedBy: "u", uploadedAt: T }],
  commLogs: [
    { id: "cl1", relatedType: "order", relatedId: "o_l1", customerId: BUCKET, storeId: "tamana", channel: "phone", direction: "inbound", subject: "", body: "", at: T, userId: "u" },
    { id: "cl2", customerId: BUCKET, storeId: "tamana", channel: "phone", direction: "inbound", subject: "受注のないやりとり", body: "", at: T, userId: "u" },
  ],
  auditLogs: [],
});
const slips = [
  { no: "100", customerCode: "501" },
  { no: "200", customerCode: "502" },
  { no: "300", customerCode: "501" },
  { no: "400", customerCode: "999" },
  { no: "500", customerCode: "501" },
  { no: "600", customerCode: "502" },
  { no: "700", customerCode: "503" },
  { no: "800", customerCode: "502" },
];

/* ================================================================== */
section("1. 計画と書き込み (sales-relink.ts)");
{
  const db = makeDb();
  const plan = RL.planSlipRelink(db, slips);
  eq(plan.moves.map((m) => [m.orderNumber, m.toCode]), [["O-2030-0001", "T-501"], ["O-2030-0002", "T-502"], ["O-2030-0003", "T-501"], ["O-2030-0007", "T-503"]], "伝票の得意先ごとに付け替える (同じ台帳のお客様の受注が 3 人に分かれる)");
  eq(plan.ambiguous.map((a) => [a.orderNumber, a.codes]), [["O-2030-0006", ["501", "502"]]], "得意先が 2 つの受注は付け替えない (人が確かめる)");
  eq(plan.missingCustomer.map((a) => [a.orderNumber, a.code]), [["O-2030-0005", "999"]], "得意先のお客様が未登録の受注は付け替えない");
  eq(plan.emptied.map((c) => c.code), ["C-09002"], "記録が残らない台帳のお客様だけを削除の対象に (伝票のない受注・やりとりのある「架空」は残す)");
  ok(!plan.moves.some((m) => m.orderId === "o_s800" || m.orderId === "o_l4"), "伝票から作った受注・伝票のない台帳の受注は対象外");
  const audits = [];
  const r = RL.applySlipRelink(db, plan, { now: "2030-02-01T00:00:00.000Z", userId: "sys", audit: (e) => audits.push(e) });
  eq([r.moved, r.related, r.removed], [4, 4, 1], "受注 4 件・つながる記録 4 件 (予定・アンケート・資料・やりとり)・台帳のお客様 1 人を削除");
  const o = (id) => db.orders.find((x) => x.id === id);
  eq(["o_l1", "o_l2", "o_l3", "o_l4", "o_l5", "o_l6", "o_l7"].map((id) => o(id).customerId), ["c_s501", "c_s502", "c_s501", BUCKET, BUCKET, BUCKET, "c_s503"], "受注のお客様");
  eq([db.schedule[0].customerId, db.surveys[0].customerId, db.attachments[0].customerId, db.commLogs[0].customerId, db.commLogs[1].customerId], ["c_s501", "c_s502", "c_s501", "c_s501", BUCKET], "受注につながる記録も付け替え (受注のないやりとりは台帳のお客様のまま)");
  ok(!db.customers.some((c) => c.id === BUCKET2) && db.customers.some((c) => c.id === BUCKET), "空になった台帳のお客様だけを削除");
  const t501 = db.customers.find((c) => c.id === "c_s501");
  eq([t501.name, t501.address, t501.tags.includes("旧コード:C-09001"), t501.area], ["架空 花子", "架空市みほん2640", true, "みほん"], "お客様の名前・住所は変えない (人が直した名前のまま)・旧コードと地区を残す");
  eq([audits.filter((a) => a.entity === "order" && a.action === "update").length, audits.filter((a) => a.entity === "customer" && a.action === "delete").map((a) => a.entityId)], [4, [BUCKET2]], "変更履歴: 受注ごとの付け替えと、削除した台帳のお客様 (試験期間の引き継ぎが削除を運ぶ)");
  ok(audits.find((a) => a.entityId === "o_l1")?.changes?.[0]?.before === BUCKET, "変更履歴に変更前のお客様");
  eq(RL.planSlipRelink(db, slips).moves.length, 0, "2 回目は何もしない");
  // 計画のあとに人が付け替えた受注は飛ばす
  const db2 = makeDb();
  const p2 = RL.planSlipRelink(db2, slips);
  db2.orders.find((x) => x.id === "o_l2").customerId = "c_s503";
  eq(RL.applySlipRelink(db2, p2, { now: T, userId: "sys" }).moved, 3, "計画のあとに変わった受注は付け替えない");
  ok(RL.relinkCsv(RL.planSlipRelink(makeDb(), slips), () => undefined).split("\n")[1].startsWith("O-2030-0001,"), "一覧の CSV");
}

/* ================================================================== */
section("2. 開発担当用の手直し (/api/cron/data-fix?task=slip-customers)");
{
  const store = await imp("lib/db/store.ts");
  await store.syncDb();
  const route = await imp("app/api/cron/data-fix/route.ts");
  await store.mutate((d) => {
    const x = makeDb();
    d.customers.push(...x.customers);
    d.orders.push(...x.orders);
  });
  const head = "売上明細,,,,,,,,,,,,,,,,,\n伝票№,売上日,引上日,得意先コード,得意先名,得意先媒体名,TELNO,FAXNO,携帯電話,住所,施工場所,得意先区分,品目,商品コード,商品名,数量,単価,金額";
  const row = (no, code, name, addr) => `${no},2030/1/10,2030/1/10,${code},${name},チラシ,,,,${addr},,個人,畳,1,表替え,1,1000,1000`;
  const csv = [head, row(100, 501, "架空　一郎", "架空市みほん2640"), row(200, 502, "架空　次郎", "架空市みほん3021"), row(300, 501, "架空　一郎", "架空市みほん2640"), row(700, 503, "見本　三郎", "架空市みほん1834")].join("\n");
  const call = (qs, body = csv, auth = "Bearer test-cron-secret") => route.POST(new Request(`http://test.local/api/cron/data-fix?task=slip-customers${qs}`, { method: "POST", headers: { authorization: auth, "content-type": "text/csv" }, body }));
  let r = await call("", csv, "Bearer wrong");
  eq(r.status, 401, "鍵が違えば断る");
  r = await call("");
  let j = await r.json();
  eq([j.applied, j.moves, j.emptied, j.amount], [false, 4, 1, 330000 + 23430 + 21650 + 27700], "確認だけ: 付け替える受注・金額・空になる台帳のお客様");
  r = await call("&csv=1");
  ok((await r.text()).includes("T-501 架空 花子"), "一覧の CSV (付け替え先のお客様)");
  eq(store.getDb().orders.find((o) => o.id === "o_l1").customerId, BUCKET, "確認では書き込まない");
  r = await call("&apply=1");
  j = await r.json();
  eq([j.applied, j.result.moved, j.result.removed], [true, 4, 1], "書き込み");
  eq(store.getDb().orders.find((o) => o.id === "o_l1").customerId, "c_s501", "受注を得意先のお客様に付け替えた");
  ok(store.getDb().auditLogs.some((a) => a.entityId === "sales-relink") && store.getDb().auditLogs.some((a) => a.entity === "customer" && a.action === "delete" && a.entityId === BUCKET2), "変更履歴 (まとめと削除)");
  j = await (await call("")).json();
  eq(j.moves, 0, "2 回目は何もしない");
  r = await call("", "");
  eq(r.status, 400, "CSV がなければ断る");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
