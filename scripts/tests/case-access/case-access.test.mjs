// 実行: npm run test:case-access (または node scripts/tests/case-access/case-access.test.mjs)
// 進行中の案件の全社員での閲覧と、入金完了・全処理完了の案件の変更の制限 (src/lib/case-access.ts) のテスト。
// データはこのファイルの中の架空の記録だけ。データベース・ファイルには触れない
import path from "node:path";
import { createJiti } from "jiti";

process.env.TZ = "Asia/Tokyo";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const A = await jiti.import(path.join(root, "src/lib/case-access.ts"));
const P = await jiti.import(path.join(root, "src/lib/auth/permissions.ts"));
const ATT = await jiti.import(path.join(root, "src/lib/attachments.ts"));

let pass = 0;
const fails = [];
const ok = (cond, msg) => (cond ? (pass++, console.log("  ✓", msg)) : (fails.push(msg), console.log("  ✗", msg)));
const eq = (a, b, msg) => {
  const c = JSON.stringify(a) === JSON.stringify(b);
  ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log("\n■ " + t);

const user = (id, role, storeId) => ({ id, name: id, email: `${id}@example.test`, role, storeId, active: true });
const koshiStaff = user("u_k", "store_staff", "koshi");
const nishiStaff = user("u_n", "store_staff", "nishi");
const nishiManager = user("u_nm", "store_manager", "nishi");
const hq = user("u_hq", "hq_staff", "hq");
const admin = user("u_admin", "admin", "hq");

const cust = (id, storeId) => ({ id, code: id, name: `顧客${id}`, kana: "", phone: "", postalCode: "", address: "", storeId, type: "individual", preferredChannel: "phone", tags: [], notes: "", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" });
const order = (id, customerId, status, extra = {}) => ({ id, number: id, customerId, storeId: "koshi", title: "畳", category: "tatami", contractDate: "2030-05-01", total: 100000, status, workerIds: [], progressNotes: [], createdBy: "u_k", createdAt: "2030-05-01T00:00:00.000Z", updatedAt: "2030-05-01T00:00:00.000Z", ...extra });
const quote = (id, customerId, status, extra = {}) => ({ id, number: id, customerId, storeId: "koshi", title: "畳", category: "tatami", status, items: [], subtotal: 0, tax: 0, total: 50000, discount: 0, version: 1, createdBy: "u_k", createdAt: "2030-04-01T00:00:00.000Z", updatedAt: "2030-04-01T00:00:00.000Z", ...extra });
const inquiry = (id, customerId, status, extra = {}) => ({ id, number: id, customerId, contactName: "", channel: "phone", storeId: "koshi", summary: "相談", status, receivedAt: "2030-03-01T00:00:00.000Z", category: "tatami", createdAt: "2030-03-01T00:00:00.000Z", ...extra });

function sampleDb() {
  return {
    customers: [cust("c_open", "koshi"), cust("c_paid", "koshi"), cust("c_quote", "koshi"), cust("c_inq", "koshi"), cust("c_none", "koshi")],
    orders: [
      order("o_open", "c_open", "scheduled", { quoteId: "q_ordered" }),
      order("o_paid", "c_paid", "paid", { invoiceId: "inv_paid" }),
      order("o_closed", "c_open", "completed", { closedAt: "2030-06-01T00:00:00.000Z" }),
      order("o_billed", "c_open", "invoiced", { invoiceId: "inv_open" }),
      order("o_fullpaid", "c_paid", "completed", { invoiceId: "inv_full" }),
      order("o_import", "c_paid", "paid", { source: "import" }),
    ],
    quotes: [
      quote("q_ordered", "c_open", "accepted", { orderId: "o_open" }),
      quote("q_sent", "c_quote", "sent", { inquiryId: "i_quoted" }),
      quote("q_lost", "c_none", "rejected"),
      quote("q_of_paid", "c_paid", "accepted", { orderId: "o_paid" }),
    ],
    inquiries: [inquiry("i_new", "c_inq", "new"), inquiry("i_lost", "c_none", "lost"), inquiry("i_quoted", "c_quote", "quoted", { quoteId: "q_sent" })],
    invoices: [
      { id: "inv_open", number: "INV1", orderId: "o_billed", customerId: "c_open", storeId: "koshi", status: "issued", total: 100000, paidAmount: 0, issueDate: "2030-06-01", dueDate: "2030-06-30" },
      { id: "inv_paid", number: "INV2", orderId: "o_paid", customerId: "c_paid", storeId: "koshi", status: "paid", total: 100000, paidAmount: 100000, issueDate: "2030-06-01", dueDate: "2030-06-30" },
      { id: "inv_full", number: "INV3", orderId: "o_fullpaid", customerId: "c_paid", storeId: "koshi", status: "paid", total: 100000, paidAmount: 100000, issueDate: "2030-06-01", dueDate: "2030-06-30" },
    ],
    payments: [
      { id: "pay1", invoiceId: "inv_paid", amount: 100000, method: "cash", paidOn: "2030-06-10" },
      { id: "pay2", invoiceId: "inv_full", amount: 100000, method: "transfer", paidOn: "2030-06-10" },
    ],
    schedule: [],
    commLogs: [],
    attachments: [],
    expenses: [],
    purchases: [],
    documents: [],
  };
}

/* ------------------------------------------------------------------ */
section("進行中の案件の判定");
{
  const db = sampleDb();
  const o = (id) => db.orders.find((x) => x.id === id);
  ok(A.isOpenOrder(db, o("o_open")), "施工予定の受注は進行中");
  ok(A.isOpenOrder(db, o("o_billed")), "請求済み・未入金の受注は進行中 (入金完了まで)");
  ok(!A.isOpenOrder(db, o("o_paid")), "入金済みの受注は進行中ではない");
  ok(!A.isOpenOrder(db, o("o_fullpaid")), "入金が全額そろった受注は進行中ではない");
  ok(!A.isOpenOrder(db, o("o_closed")), "全処理完了の受注は進行中ではない");
  ok(!A.isOpenOrder(db, o("o_import")), "移行した完了済みの売上は進行中ではない");
  const q = (id) => db.quotes.find((x) => x.id === id);
  ok(A.isOpenQuote(db, q("q_sent")), "提出済み・回答待ちの見積は進行中");
  ok(!A.isOpenQuote(db, q("q_lost")), "失注の見積は進行中ではない");
  ok(A.isOpenQuote(db, q("q_ordered")), "受注した見積は受注の状態に従う (施工予定 → 進行中)");
  ok(!A.isOpenQuote(db, q("q_of_paid")), "入金済みの受注の見積は進行中ではない");
  const i = (id) => db.inquiries.find((x) => x.id === id);
  ok(A.isOpenInquiry(db, i("i_new")), "新しい問い合わせは進行中");
  ok(!A.isOpenInquiry(db, i("i_lost")), "失注の問い合わせは進行中ではない");
  ok(A.isOpenInquiry(db, i("i_quoted")), "見積を出した問い合わせは見積の状態に従う");
  const inv = (id) => db.invoices.find((x) => x.id === id);
  ok(A.isOpenInvoice(db, inv("inv_open")), "未入金の請求書は進行中");
  ok(!A.isOpenInvoice(db, inv("inv_paid")), "入金済みの請求書は進行中ではない");
  const c = (id) => db.customers.find((x) => x.id === id);
  ok(A.hasOpenCase(db, c("c_open")), "進行中の受注があるお客様");
  ok(A.hasOpenCase(db, c("c_inq")), "進行中の問い合わせがあるお客様");
  ok(!A.hasOpenCase(db, c("c_paid")), "入金済みの案件だけのお客様は進行中なし");
  ok(!A.hasOpenCase(db, c("c_none")), "失注だけのお客様は進行中なし");
  eq([...A.openCaseCustomerIds(db)].sort(), ["c_inq", "c_open", "c_quote"], "進行中の案件があるお客様の一覧 (まとめて計算しても同じ)");
}

/* ------------------------------------------------------------------ */
section("閲覧の範囲 (edit / view / none)");
{
  const db = sampleDb();
  const o = (id) => db.orders.find((x) => x.id === id);
  eq(A.orderAccess(db, koshiStaff, o("o_paid")), "edit", "自店舗の社員は完了した案件も見られる (従来どおり)");
  eq(A.orderAccess(db, nishiStaff, o("o_open")), "view", "ほかの店舗の社員: 進行中の受注は閲覧のみ");
  eq(A.orderAccess(db, nishiManager, o("o_billed")), "view", "ほかの店舗の店長: 請求済み・未入金も閲覧のみ");
  eq(A.orderAccess(db, nishiStaff, o("o_paid")), "none", "ほかの店舗の社員: 入金済みの受注は見られない (通常の権限に戻る)");
  eq(A.orderAccess(db, nishiStaff, o("o_closed")), "none", "ほかの店舗の社員: 全処理完了の受注は見られない");
  eq(A.orderAccess(db, hq, o("o_paid")), "edit", "本部スタッフは全店舗 (従来どおり)");
  eq(A.quoteAccess(db, nishiStaff, db.quotes.find((x) => x.id === "q_sent")), "view", "ほかの店舗の見積 (回答待ち) は閲覧のみ");
  eq(A.quoteAccess(db, nishiStaff, db.quotes.find((x) => x.id === "q_lost")), "none", "ほかの店舗の失注の見積は見られない");
  eq(A.inquiryAccess(db, nishiStaff, db.inquiries.find((x) => x.id === "i_new")), "view", "ほかの店舗の新しい問い合わせは閲覧のみ");
  eq(A.invoiceAccess(db, nishiStaff, db.invoices.find((x) => x.id === "inv_open")), "view", "ほかの店舗の未入金の請求書は閲覧のみ");
  eq(A.invoiceAccess(db, nishiStaff, db.invoices.find((x) => x.id === "inv_paid")), "none", "ほかの店舗の入金済みの請求書は見られない");
  eq(A.customerAccess(db, nishiStaff, db.customers.find((x) => x.id === "c_open")), "view", "進行中の案件があるほかの店舗のお客様は閲覧のみ");
  eq(A.customerAccess(db, nishiStaff, db.customers.find((x) => x.id === "c_paid")), "none", "入金済みの案件だけのほかの店舗のお客様は見られない");
  eq(A.orderAccess(db, { ...nishiStaff, active: false }, o("o_open")), "none", "無効のアカウントは見られない");
}

/* ------------------------------------------------------------------ */
section("お客様の画面 (閲覧のみ) は進行中の案件だけ");
{
  const db = sampleDb();
  const t = {
    inquiries: db.inquiries.filter((i) => i.customerId === "c_open"),
    quotes: db.quotes.filter((q) => q.customerId === "c_open"),
    orders: db.orders.filter((o) => o.customerId === "c_open"),
    invoices: db.invoices.filter((i) => i.customerId === "c_open"),
    comms: [
      { id: "cm1", relatedType: "order", relatedId: "o_open", at: "2030-05-02T00:00:00.000Z" },
      { id: "cm2", relatedType: "order", relatedId: "o_closed", at: "2030-05-02T00:00:00.000Z" },
      { id: "cm3", at: "2029-01-01T00:00:00.000Z" },
      { id: "cm4", at: "2030-05-03T00:00:00.000Z" },
    ],
    events: [{ id: "e1", orderId: "o_open" }, { id: "e2", orderId: "o_closed" }],
    lifetime: 300000,
  };
  const f = A.openCaseTimeline(db, t);
  eq(f.orders.map((o) => o.id).sort(), ["o_billed", "o_open"], "受注は進行中のものだけ (全処理完了は出さない)");
  eq(f.invoices.map((i) => i.id), ["inv_open"], "請求書は進行中の受注のものだけ");
  eq(f.comms.map((c) => c.id), ["cm1", "cm4"], "やりとりは進行中の案件と、その期間のお客様あての記録だけ");
  eq(f.events.map((e) => e.id), ["e1"], "予定は進行中の案件のものだけ");
  eq(f.lifetime, 0, "売上の累計は出さない");
}

/* ------------------------------------------------------------------ */
section("入金完了・全処理完了の案件の変更の制限");
{
  const db = sampleDb();
  const o = (id) => db.orders.find((x) => x.id === id);
  eq(A.completedCaseLock(db, koshiStaff, o("o_open")), { locked: false, reason: "" }, "進行中の案件は変更できる");
  eq(A.completedCaseLock(db, koshiStaff, o("o_billed")), { locked: false, reason: "" }, "請求済み・未入金の案件は (金額以外) 変更できる");
  eq(A.completedCaseLock(db, koshiStaff, o("o_paid")), { locked: true, reason: "入金済みの案件" }, "入金済み: 店舗の社員は変更できない");
  eq(A.completedCaseLock(db, koshiStaff, o("o_fullpaid")), { locked: true, reason: "入金が完了した案件" }, "入金が全額そろった案件も変更できない");
  eq(A.completedCaseLock(db, koshiStaff, o("o_closed")), { locked: true, reason: "全処理完了にした案件" }, "全処理完了: 変更できない");
  eq(A.completedCaseLock(db, koshiStaff, o("o_import")).reason, "移行した完了済みの売上", "移行した売上も変更できない");
  ok(A.completedCaseLock(db, hq, o("o_paid")).locked, "本部スタッフも変更できない");
  eq(A.completedCaseLock(db, admin, o("o_paid")), { locked: false, reason: "入金済みの案件" }, "管理者は変更できる (理由は表示する)");
  ok(A.quoteCompletedLock(db, koshiStaff, db.quotes.find((x) => x.id === "q_of_paid")).locked, "入金済みの受注の見積も変更できない");
  ok(!A.quoteCompletedLock(db, koshiStaff, db.quotes.find((x) => x.id === "q_sent")).locked, "受注前の見積は変更できる");
  ok(/管理者に依頼/.test(A.completedLockMessage("入金済みの案件")), "断りの文は管理者への依頼を案内する");
}

/* ------------------------------------------------------------------ */
section("写真・資料 (添付ファイル)");
{
  const db = sampleDb();
  const parent = (type, id) => ATT.resolveParent(db, type, id);
  ok(ATT.canViewParent(nishiStaff, db, parent("order", "o_open")), "ほかの店舗の進行中の案件の写真は見られる");
  ok(!ATT.canAddToParent(nishiStaff, db, parent("order", "o_open")), "ほかの店舗の案件には写真を追加できない");
  ok(!ATT.canViewParent(nishiStaff, db, parent("order", "o_paid")), "ほかの店舗の入金済みの案件の写真は見られない");
  ok(ATT.canAddToParent(koshiStaff, db, parent("order", "o_paid")), "自店舗の社員は完了後も写真を追加できる");
  ok(ATT.canViewParent(nishiStaff, db, parent("customer", "c_open")), "進行中の案件があるお客様の資料は見られる");
}

/* ------------------------------------------------------------------ */
section("権限の関数");
ok(P.canViewOpenCases(nishiStaff) && P.canViewOpenCases(nishiManager), "店舗のロールも進行中の案件を見られる");
ok(P.canEditCompletedCase(admin) && !P.canEditCompletedCase(hq) && !P.canEditCompletedCase(nishiManager), "完了した案件の変更は管理者だけ");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
