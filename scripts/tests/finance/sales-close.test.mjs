/**
 * お客様のご要望 2026-11-27「■1 売上確定・請求書発行の動線」のテスト
 *   node scripts/tests/finance/sales-close.test.mjs   (npm run test:finance)
 * 帳票の「売上確定・請求書発行」の画面 (src/lib/actions/sales.ts): 施工内容・明細と金額・担当者・ポスティング → 売上確定 + 請求書の発行。
 * 確定のあとの修正: 施工内容・担当者・ポスティングはそのまま、明細・金額は一般社員 = 店長の承認・店長以上 = 承認なしで、受注・請求書 (入金前・案件ごと) に反映。
 * データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-sales-close-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
// PDF のフォントは作業フォルダーの src/assets/fonts から読む
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "sales-close-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-sales-close",
  CRON_SECRET: "test-cron-sales-close",
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
async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { msg: null, err: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { path: u.pathname, url: e.url, msg: u.searchParams.get("msg"), err: u.searchParams.get("err"), sp: u.searchParams };
    }
    throw e;
  } finally {
    globalThis.__testUser = undefined;
  }
}
const form = (obj) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, String(x));
    else if (v !== undefined && v !== null) fd.set(k, String(v));
  }
  return fd;
};

const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const S = db().stores.find((s) => s.kind === "store").id;
const now = new Date().toISOString();
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const items = (price = 10000) => [{ id: "qi_a", name: "畳表替え", spec: "さくら", qty: 6, unit: "畳", unitPrice: price, amount: 6 * price }];
await store.mutate((x) => {
  // 同じ店舗のほかの店長がいると承認者がその人になるので、テスト用の店長だけにする
  for (const u of x.users) if (u.storeId === S && u.role === "store_manager") u.active = false;
  const mk = (id, role) => x.users.push({ id, name: `試験 ${id}`, email: `${id}@example.test`, role, title: role, storeId: S, active: true, createdAt: now, updatedAt: now });
  mk("u_sc_mgr", "store_manager");
  mk("u_sc_staff", "store_staff");
  const cust = (id, extra = {}) => x.customers.push({ id, code: `C-6${id.slice(-4)}`, name: `架空 ${id}`, kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町3", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now, ...extra });
  const quote = (id, cid, price = 10000) => x.quotes.push({ id, number: `Q-2026-${id.slice(-4)}`, version: 1, customerId: cid, storeId: S, title: `表替え ${id}`, category: "tatami", items: items(price), subtotal: 6 * price, discount: 0, tax: Math.floor((6 * price * 10) / 110), total: 6 * price, taxIncluded: true, status: "accepted", createdBy: "u_sc_staff", createdAt: now, updatedAt: now, orderId: `o${id.slice(1)}` });
  const order = (id, qid, cid, price = 10000) => x.orders.push({ id, number: `O-2026-${id.slice(-4)}`, quoteId: qid, customerId: cid, storeId: S, title: `表替え ${qid}`, category: "tatami", contractDate: today, total: 6 * price, status: "scheduled", workerIds: ["u_sc_staff"], siteAddress: "熊本県テスト市テスト町3", progressNotes: [], createdBy: "u_sc_staff", createdAt: now, updatedAt: now });
  cust("c_sc_a"); quote("q_sc_a", "c_sc_a"); order("o_sc_a", "q_sc_a", "c_sc_a");
  cust("c_sc_b", { billingTerms: { batch: true, closingDay: 20, payMonthOffset: 1, payDay: 10 } }); quote("q_sc_b", "c_sc_b"); order("o_sc_b", "q_sc_b", "c_sc_b");
  cust("c_sc_c"); quote("q_sc_c", "c_sc_c"); order("o_sc_c", "q_sc_c", "c_sc_c");
});
const u = (id) => db().users.find((x) => x.id === id);
const SA = await imp("lib/actions/sales.ts");
const AA = await imp("lib/actions/approvals.ts");
const ord = (id) => db().orders.find((x) => x.id === id);
const invOf = (o) => db().invoices.find((i) => i.id === o.invoiceId && i.status !== "void");
const staffFields = { workStaffSent: "1", "workStaff.survey": "u_sc_staff", "workStaff.pickup": "u_sc_staff", "workStaff.delivery": "u_sc_staff", "workStaff.install.none": "1" };
const posting = { postingSent: "1", "posting.status": "done", "posting.user": ["u_sc_staff"], "posting.count": ["50"], "posting.date": today };
const lines = (price) => JSON.stringify([{ id: "qi_a", name: "畳表替え", spec: "さくら", qty: 6, unit: "畳", unitPrice: price }]);

section("1. 売上確定・請求書発行 (一般社員も。施工内容・担当者・ポスティング・明細そのまま)");
{
  let r = await act(u("u_sc_staff"), () => SA.saveSales("o_sc_a", form({ intent: "confirm", workDetails: "和室6畳 表替え", linesSent: "1", items: lines(10000), discount: "0", ...staffFields })));
  ok(/ポスティング/.test(r.err ?? ""), `ポスティングが未入力なら確定しない (${r.err})`);
  eq(ord("o_sc_a").status, "scheduled", "確定していない (入力はまとめて取り消し)");
  r = await act(u("u_sc_staff"), () => SA.saveSales("o_sc_a", form({ intent: "confirm", workDetails: "和室6畳 表替え", linesSent: "1", items: lines(10000), discount: "0", ...staffFields, ...posting, returnTo: "/schedule?qe=ev_x" })));
  const o = ord("o_sc_a");
  const inv = invOf(o);
  eq([o.status, o.salesDate, o.completedAt, o.workDetails, inv?.total, o.posting?.entries], ["invoiced", today, today, "和室6畳 表替え", 60000, [{ userId: "u_sc_staff", count: 50 }]], `売上確定 + 請求書の発行 ${r.err ?? ""}`);
  ok(Boolean(o.workStaff?.confirmedAt) && o.workStaff.none?.includes("install"), "作業の担当を確定 (施工は「なし」)");
  eq(r.path, "/schedule", "予定表の小さな画面から開いたら確定のあとそこに戻る (ボタンが「請求書」になる)");
  r = await act(u("u_sc_staff"), () => SA.saveSales("o_sc_a", form({ intent: "confirm", ...staffFields, ...posting })));
  ok(/すでに売上確定済み/.test(r.err ?? ""), "二度は確定しない");
}

section("2. まとめ請求のお客様は確定だけ (請求書は締め日)");
{
  const r = await act(u("u_sc_staff"), () => SA.saveSales("o_sc_b", form({ intent: "confirm", ...staffFields, ...posting })));
  const o = ord("o_sc_b");
  eq([o.status, Boolean(o.invoiceId)], ["completed", false], `売上確定・請求書は発行しない ${r.err ?? ""}`);
  ok(/まとめ請求/.test(r.msg ?? ""), "まとめ請求のため締め日に発行と知らせる");
}

section("3. 確定のあとの修正 (一般社員): 担当者・施工内容はそのまま、金額は店長の承認");
{
  let r = await act(u("u_sc_staff"), () => SA.saveSales("o_sc_a", form({ intent: "save", workDetails: "和室6畳 表替え (縁 マス菊)", linesSent: "1", items: lines(11000), discount: "0", reason: "単価の入力の誤り", ...staffFields, "workStaff.install": "u_sc_mgr", "workStaff.install.none": "", ...posting })));
  const o = ord("o_sc_a");
  const ap = db().approvals.find((a) => a.type === "quote_amend" && a.targetId === "q_sc_a" && a.status === "pending");
  eq([o.workDetails, o.workStaff?.install, o.total, invOf(o)?.total], ["和室6畳 表替え (縁 マス菊)", ["u_sc_mgr"], 60000, 60000], `施工内容・担当者はすぐ反映、金額はまだ ${r.err ?? ""}`);
  eq([ap?.requiredRole, ap?.storeId], ["store_manager", S], "金額の修正は店長の承認 (差額にかかわらず。金額の基準で管理者に回さない)");
  ok(/店長へ申請/.test(r.msg ?? ""), "店長へ申請したと知らせる");
  r = await act(u("u_sc_mgr"), () => AA.decideApproval(ap.id, "approved", form({ returnTo: "/approvals" })));
  const o2 = ord("o_sc_a");
  const q = db().quotes.find((x) => x.id === "q_sc_a");
  eq([q.version, q.total, o2.total, invOf(o2)?.total, invOf(o2)?.items?.[0]?.unitPrice, invOf(o2)?.number === invOf(o)?.number], [2, 66000, 66000, 66000, 11000, true], `店長の承認で 見積の版・受注・請求書 (同じ番号) に反映 ${r.err ?? ""}`);
  ok(db().auditLogs.some((l) => l.entity === "invoice" && l.entityId === o2.invoiceId && /売上の修正/.test(l.summary)), "請求書の変更履歴");
}

section("4. 店長以上は自分の権限で金額を直す");
{
  await act(u("u_sc_mgr"), () => SA.saveSales("o_sc_c", form({ intent: "confirm", ...staffFields, ...posting })));
  const r = await act(u("u_sc_mgr"), () => SA.saveSales("o_sc_c", form({ intent: "save", linesSent: "1", items: lines(9000), discount: "0", ...staffFields, ...posting })));
  const o = ord("o_sc_c");
  eq([o.total, invOf(o)?.total, db().approvals.filter((a) => a.type === "quote_amend" && a.targetId === "q_sc_c" && a.status === "pending").length], [54000, 54000, 0], `承認なしで受注・請求書に反映 ${r.err ?? ""}`);
}

section("5. 入金の記録がある請求書は金額を直さない");
{
  await store.mutate((x) => {
    const o = x.orders.find((y) => y.id === "o_sc_c");
    const inv = x.invoices.find((i) => i.id === o.invoiceId);
    inv.paidAmount = 1000;
    inv.status = "partial";
  });
  const r = await act(u("u_sc_mgr"), () => SA.saveSales("o_sc_c", form({ intent: "save", linesSent: "1", items: lines(8000), discount: "0", ...staffFields, ...posting })));
  ok(/入金の記録/.test(r.err ?? "") && ord("o_sc_c").total === 54000, `断る (${r.err})`);
  const r2 = await act(u("u_sc_mgr"), () => SA.saveSales("o_sc_c", form({ intent: "save", linesSent: "1", items: lines(9000), discount: "0", ...staffFields, "workStaff.install": "u_sc_staff", "workStaff.install.none": "", ...posting })));
  ok(!r2.err && ord("o_sc_c").workStaff?.install?.includes("u_sc_staff"), "金額を変えない修正 (担当者) はできる");
}

section("6. 承認待ちの金額の変更があるときの売上確定");
{
  await store.mutate((x) => {
    x.customers.push({ id: "c_sc_d", code: "C-60099", name: "架空 d", kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町4", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
    x.quotes.push({ id: "q_sc_d", number: "Q-2026-SC-D", version: 1, customerId: "c_sc_d", storeId: S, title: "表替え d", category: "tatami", items: items(10000), subtotal: 60000, discount: 0, tax: 5454, total: 60000, taxIncluded: true, status: "accepted", createdBy: "u_sc_staff", createdAt: now, updatedAt: now, orderId: "o_sc_d" });
    x.orders.push({ id: "o_sc_d", number: "O-2026-SC-D", quoteId: "q_sc_d", customerId: "c_sc_d", storeId: S, title: "表替え d", category: "tatami", contractDate: today, total: 60000, status: "scheduled", workerIds: [], siteAddress: "", progressNotes: [], createdBy: "u_sc_staff", createdAt: now, updatedAt: now });
  });
  const r = await act(u("u_sc_staff"), () => SA.saveSales("o_sc_d", form({ intent: "confirm", linesSent: "1", items: lines(20000), discount: "0", ...staffFields, ...posting })));
  const o = ord("o_sc_d");
  eq([o.status, Boolean(o.invoiceId), Boolean(o.posting)], ["scheduled", false, true], `差額の大きい変更は承認待ちのため確定しない (担当者・ポスティングは保存) ${r.err ?? ""}`);
  ok(/承認されたら、もう一度/.test(r.msg ?? ""), "承認のあとに確定するよう知らせる");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
