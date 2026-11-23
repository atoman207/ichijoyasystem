// 実行: npm run test:finance (または node scripts/tests/finance/finance.test.mjs)
// 売上計上日 = 施工完了日の仕訳、法人のまとめ請求 (締め日・入金の割り当て)、売掛一覧・買掛一覧、会計データに出す支払方法のテスト
// (src/lib/billing.ts・src/lib/ar-ap.ts・src/lib/accounting.ts・src/lib/case-status.ts)。
// データはこのファイルの中の架空の記録だけ。データベース・ファイルには触れない
import path from "node:path";
import { createJiti } from "jiti";

process.env.TZ = "Asia/Tokyo";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const B = await jiti.import(path.join(root, "src/lib/billing.ts"));
const AR = await jiti.import(path.join(root, "src/lib/ar-ap.ts"));
const ACC = await jiti.import(path.join(root, "src/lib/accounting.ts"));
const CS = await jiti.import(path.join(root, "src/lib/case-status.ts"));

let pass = 0;
const fails = [];
const ok = (cond, msg) => (cond ? (pass++, console.log("  ✓", msg)) : (fails.push(msg), console.log("  ✗", msg)));
const eq = (a, b, msg) => {
  const c = JSON.stringify(a) === JSON.stringify(b);
  ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log("\n■ " + t);

const T = "2030-01-01T00:00:00.000Z";
const cust = (id, type, extra = {}) => ({ id, code: `C-${id}`, name: `顧客${id}`, kana: "", phone: "", postalCode: "", address: `住所${id}`, storeId: "koshi", type, preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: T, updatedAt: T, ...extra });
const order = (id, customerId, status, extra = {}) => ({ id, number: `ORD-${id}`, customerId, storeId: "koshi", title: `工事${id}`, category: "tatami", contractDate: "2030-05-01", total: 110000, status, workerIds: [], siteAddress: "", progressNotes: [], createdBy: "u1", createdAt: T, updatedAt: T, ...extra });
const quote = (id, total, tax) => ({ id, number: `Q-${id}`, customerId: "c_ind", storeId: "koshi", title: "見積", category: "tatami", status: "accepted", items: [], subtotal: total - tax, discount: 0, tax, total, version: 1, createdBy: "u1", createdAt: T, updatedAt: T });
const inv = (id, orderId, extra = {}) => ({ id, number: `INV-${id}`, orderId, customerId: "c_ind", storeId: "koshi", issueDate: "2030-06-05", dueDate: "2030-06-20", subtotal: 100000, tax: 10000, total: 110000, paidAmount: 0, status: "issued", createdBy: "u1", createdAt: T, updatedAt: T, ...extra });
const pay = (id, invoiceId, date, amount, method = "transfer") => ({ id, invoiceId, date, amount, method, recordedBy: "u1", createdAt: T });
const supplier = (id, payMethod, extra = {}) => ({ id, name: `仕入先${id}`, category: "", paymentTerms: "", closingDay: 31, payMonthOffset: 1, payDay: 31, payMethod, ...extra });
const purchase = (id, supplierId, extra = {}) => ({ id, number: `PUR-${id}`, supplierId, storeId: "koshi", invoiceDate: "2030-06-10", dueDate: "2030-07-31", amount: 33000, taxAmount: 3000, description: "材料", status: "approved", source: "manual", registeredBy: "u1", createdAt: T, updatedAt: T, ...extra });

function sampleDb() {
  return {
    stores: [{ id: "koshi", name: "合志店" }, { id: "nishi", name: "西店" }, { id: "hq", name: "本社" }],
    customers: [cust("c_ind", "individual"), cust("c_corp", "corporate", { billingTerms: { batch: true, closingDay: 20, payMonthOffset: 1, payDay: 31 } }), cust("c_corp2", "corporate")],
    quotes: [quote("q1", 110000, 10000)],
    orders: [
      // 個人: 6/1 完了・6/5 請求・6/25 入金
      order("o1", "c_ind", "paid", { quoteId: "q1", completedAt: "2030-06-01", salesDate: "2030-06-01", invoiceId: "i1" }),
      // 個人: 5/31 完了・請求書は 6/2 (月をまたぐ。売上は 5 月)
      order("o2", "c_ind", "invoiced", { completedAt: "2030-05-31", salesDate: "2030-05-31", invoiceId: "i2", total: 55000 }),
      // 個人: 完了・未請求
      order("o3", "c_ind", "completed", { completedAt: "2030-06-15", salesDate: "2030-06-15", total: 22000 }),
      // 移行データ (入金済み・請求書なし): 仕訳・売掛に出さない
      order("o_imp", "c_ind", "paid", { source: "import", completedAt: "2030-06-03", salesDate: "2030-06-03", total: 99000 }),
      // キャンセル: 出さない
      order("o_can", "c_ind", "cancelled", { completedAt: "2030-06-04", salesDate: "2030-06-04", total: 44000 }),
      // 法人 (20日締め): 5/25・6/10 は 6/20 締め、6/22 は 7/20 締め
      order("b1", "c_corp", "completed", { completedAt: "2030-06-10", salesDate: "2030-06-10", total: 33000 }),
      order("b0", "c_corp", "completed", { completedAt: "2030-05-25", salesDate: "2030-05-25", total: 11000 }),
      order("b2", "c_corp", "completed", { completedAt: "2030-06-22", salesDate: "2030-06-22", total: 22000 }),
      order("b_imp", "c_corp", "completed", { source: "import", completedAt: "2030-06-01", salesDate: "2030-06-01", total: 5000 }),
      // 法人の西店の案件 (別の請求書)
      order("b_nishi", "c_corp", "completed", { storeId: "nishi", completedAt: "2030-06-12", salesDate: "2030-06-12", total: 7700 }),
      // 締めの設定のない法人
      order("c2o", "c_corp2", "completed", { completedAt: "2030-06-11", salesDate: "2030-06-11", total: 8800 }),
    ],
    invoices: [
      inv("i1", "o1", { issueDate: "2030-06-05", paidAmount: 110000, status: "paid" }),
      inv("i2", "o2", { issueDate: "2030-06-02", dueDate: "2030-06-16", subtotal: 50000, tax: 5000, total: 55000 }),
      // 受注のない請求書 (移行の対応づけの漏れ): 発行日で計上
      inv("i_orphan", "o_missing", { issueDate: "2030-06-07", total: 3300, subtotal: 3000, tax: 300 }),
      // 無効の請求書: 出さない
      inv("i_void", "o3", { status: "void", issueDate: "2030-06-16", total: 22000 }),
    ],
    payments: [pay("p1", "i1", "2030-06-25", 110000)],
    suppliers: [supplier("s_bulk", "bulk_transfer", { bankInfo: "テスト銀行 本店 普通 0000000" }), supplier("s_debit", "debit"), supplier("s_none", undefined)],
    purchases: [
      purchase("pb1", "s_bulk", { invoiceDate: "2030-06-10", status: "paid", paidAt: "2030-07-31", payMethod: "bulk_transfer" }),
      purchase("pb2", "s_bulk", { invoiceDate: "2030-06-20", amount: 11000, taxAmount: 1000 }),
      purchase("pd1", "s_debit", { invoiceDate: "2030-06-15", status: "paid", paidAt: "2030-06-27", payMethod: "debit", amount: 5500, taxAmount: 500 }),
      purchase("pc1", "s_none", { invoiceDate: "2030-06-18", status: "paid", paidAt: "2030-06-18", payMethod: "cash", amount: 2200, taxAmount: 200 }),
      purchase("pt1", "s_none", { invoiceDate: "2030-06-19", status: "paid", paidAt: "2030-06-30", payMethod: "transfer", amount: 4400, taxAmount: 400 }),
      purchase("pr", "s_bulk", { status: "rejected", amount: 999999 }),
    ],
    expenses: [],
    cashEntries: [],
    settings: [],
    schedule: [],
  };
}

section("請求の締め (締め日・期間・支払期限)");
eq(B.closingPeriod("2030-06", 20), { from: "2030-05-21", to: "2030-06-20" }, "20日締めの 6 月: 5/21〜6/20");
eq(B.closingPeriod("2030-03", 31), { from: "2030-03-01", to: "2030-03-31" }, "末日締めの 3 月: 3/1〜3/31");
eq(B.closingPeriod("2030-02", 31), { from: "2030-02-01", to: "2030-02-28" }, "末日締めの 2 月: 2/1〜2/28");
eq(B.closingPeriod("2030-01", 20), { from: "2029-12-21", to: "2030-01-20" }, "20日締めの 1 月: 前の年の 12/21 から");
eq(B.closingPeriod("2030-03", 30), { from: "2030-03-01", to: "2030-03-30" }, "30日締めの 3 月: 2 月末の翌日から");
eq(B.closingDateCovering("2030-06-25", 20), "2030-07-20", "6/25 は 7/20 締め");
eq(B.closingDateCovering("2030-06-20", 20), "2030-06-20", "6/20 は 6/20 締め");
eq(B.closingDateCovering("2030-12-25", 20), "2031-01-20", "12/25 は翌年 1/20 締め");
eq(B.batchDueDate("2030-06-20", { batch: true, closingDay: 20, payMonthOffset: 1, payDay: 31 }), "2030-07-31", "20日締め 翌月末払い: 6/20 → 7/31");
eq(B.batchDueDate("2030-01-31", { batch: true, closingDay: 31, payMonthOffset: 1, payDay: 31 }), "2030-02-28", "末日締め 翌月末払い: 1/31 → 2/28");
eq(B.batchDueDate("2030-06-30", { batch: true, closingDay: 31, payMonthOffset: 0, payDay: 31 }), "2030-06-30", "末日締め 当月末払い");
eq(B.termsText({ batch: true, closingDay: 20, payMonthOffset: 1, payDay: 31 }), "20日締め 翌月末日払い", "条件の表示");
eq(B.normalizeTerms({ batch: true, closingDay: 99, payMonthOffset: 7, payDay: 0 }), { batch: true, closingDay: 31, payMonthOffset: 1, payDay: 31, note: undefined }, "範囲外の値は既定にそろえる");
ok(B.usesBatchBilling({ billingTerms: { batch: true, closingDay: 20, payMonthOffset: 1, payDay: 31 } }) && !B.usesBatchBilling({ billingTerms: { batch: false, closingDay: 20, payMonthOffset: 1, payDay: 31 } }) && !B.usesBatchBilling({}), "まとめ請求の判定 (batch = true のときだけ)");

section("まとめ請求の候補");
{
  const db = sampleDb();
  const groups = B.batchGroups(db, "2030-06", () => true);
  const koshi = groups.find((g) => g.customer.id === "c_corp" && g.storeId === "koshi");
  const nishi = groups.find((g) => g.customer.id === "c_corp" && g.storeId === "nishi");
  eq(koshi?.orders.map((x) => x.order.id), ["b0", "b1"], "6/20 締めまでの完了 (売上計上日の順)。6/22 の案件と移行データは入らない");
  eq(koshi?.orders.map((x) => x.earlier), [false, false], "5/25 は 5/21〜6/20 の期間の中");
  eq([koshi?.from, koshi?.to, koshi?.dueDate, koshi?.total], ["2030-05-21", "2030-06-20", "2030-07-31", 44000], "期間・支払期限・合計");
  ok(Boolean(nishi) && nishi.orders.length === 1, "ほかの店舗の案件は別のまとめ (請求書は店舗ごと)");
  ok(!groups.some((g) => g.customer.id === "c_ind" || g.customer.id === "c_corp2"), "個人・締めの設定のない法人は候補にしない");
  const july = B.batchGroups(db, "2030-07", () => true).find((g) => g.customer.id === "c_corp" && g.storeId === "koshi");
  eq(july?.orders.map((x) => [x.order.id, x.earlier]), [["b0", true], ["b1", true], ["b2", false]], "前の締めで請求しなかった案件は次の締めにも出る (前の締めの未請求)");
  const noTerms = B.corporateWithoutTerms(db, () => true);
  eq(noTerms.map((r) => [r.customer.id, r.count]), [["c_corp2", 1]], "締めが未設定の法人のお客様の案内");
  const onlyKoshi = B.batchGroups(db, "2030-06", (s) => s === "koshi");
  ok(!onlyKoshi.some((g) => g.storeId === "nishi"), "店舗の範囲で絞る");
}

section("まとめ請求の金額と入金の割り当て");
{
  const lines = [{ orderId: "a", amount: 11000 }, { orderId: "b", amount: 33000 }, { orderId: "c", amount: 5000, noTax: true }];
  eq(B.batchAmounts(lines), { subtotal: 45000, tax: 4000, total: 49000 }, "合計 = 行の合計。消費税は 10% 対象の合計から 1 回だけ (内税・切り捨て)。税抜 = 合計 − 消費税");
  eq(B.batchAmounts([{ amount: 10005 }, { amount: 10005 }]), { subtotal: 18191, tax: 1819, total: 20010 }, "端数は請求書で 1 回だけ切り捨て");
  const batchInv = { orderId: "a", orderIds: ["a", "b", "c"], orderLines: lines, total: 49000 };
  eq([...B.allocatePaid(batchInv, 20000).entries()], [["a", 11000], ["b", 9000], ["c", 0]], "一部の入金は古い案件から埋める");
  eq([...B.allocatePaid(batchInv, 50000).entries()], [["a", 11000], ["b", 33000], ["c", 6000]], "多い入金の残りは最後の案件に");
  eq([...B.allocatePaid({ orderId: "x", total: 1000 }, 400).entries()], [["x", 400]], "1 件の請求書は全額をその受注に");
  eq(B.invoiceOrderIds({ orderId: "x" }), ["x"], "従来の請求書の対象 = orderId");
  ok(B.isBatchInvoice({ orderIds: ["a"], periodTo: "2030-06-20" }) && !B.isBatchInvoice({ orderId: "x" }), "まとめ請求の判定");
  const db = sampleDb();
  const built = B.batchLines(db, db.customers[1], [db.orders.find((o) => o.id === "b1"), db.orders.find((o) => o.id === "b0")]);
  eq(built.map((l) => [l.number, l.salesDate, l.amount]), [["ORD-b0", "2030-05-25", 11000], ["ORD-b1", "2030-06-10", 33000]], "案件ごとの行は売上計上日の順");
  // 入金で受注を入金済みに
  const orders = [{ id: "a", total: 11000, status: "invoiced" }, { id: "b", total: 33000, status: "invoiced" }, { id: "c", total: 5000, status: "invoiced" }];
  const done = B.settleInvoiceOrders({ orders }, { ...batchInv, status: "partially_paid", paidAmount: 20000 }, T);
  eq([done, orders.map((o) => o.status)], [["a"], ["paid", "invoiced", "invoiced"]], "割り当てが届いた案件だけ入金済み");
  const single = [{ id: "x", total: 1000, status: "invoiced" }];
  B.settleInvoiceOrders({ orders: single }, { orderId: "x", total: 1000, status: "partially_paid", paidAmount: 400 }, T);
  eq(single[0].status, "invoiced", "1 件の請求書: 一部入金では入金済みにしない");
  B.settleInvoiceOrders({ orders: single }, { orderId: "x", total: 1000, status: "paid", paidAmount: 1000 }, T);
  eq(single[0].status, "paid", "1 件の請求書: 全額で入金済み (従来どおり)");
}

section("案件の状態 (まとめ請求の入金)");
{
  const db = sampleDb();
  const lines = B.batchLines(db, db.customers[1], [db.orders.find((o) => o.id === "b0"), db.orders.find((o) => o.id === "b1")]);
  const bi = { id: "ib", number: "INV-ib", orderId: "b0", orderIds: ["b0", "b1"], orderLines: lines, periodFrom: "2030-05-21", periodTo: "2030-06-20", customerId: "c_corp", storeId: "koshi", issueDate: "2030-06-20", dueDate: "2030-07-31", subtotal: 40000, tax: 4000, total: 44000, paidAmount: 20000, status: "partially_paid", taxIncluded: true, createdBy: "u1", createdAt: T, updatedAt: T };
  db.invoices.push(bi);
  db.payments.push(pay("pb", "ib", "2030-07-10", 20000));
  for (const o of db.orders) if (o.id === "b0" || o.id === "b1") Object.assign(o, { invoiceId: "ib", status: "invoiced" });
  const ix = CS.caseIndex(db);
  const r0 = CS.orderCase(db.orders.find((o) => o.id === "b0"), ix, "2030-07-15");
  const r1 = CS.orderCase(db.orders.find((o) => o.id === "b1"), ix, "2030-07-15");
  eq([r0.billing, r0.payment, r0.paid], ["billed", "paid", 11000], "1 件目: 請求済・入金済 (割り当て 11,000)");
  eq([r1.billing, r1.payment, r1.paid], ["billed", "partial", 9000], "2 件目: 請求済・一部入金 (割り当て 9,000)");
  const r2 = CS.orderCase(db.orders.find((o) => o.id === "b2"), ix, "2030-07-15");
  ok(r2.billing === "unbilled" && r2.detail.includes("締め日にまとめて請求") && r2.tasks.includes("締め日のまとめ請求"), "まとめ請求のお客様の未請求の案件は「締め日にまとめて請求」");
  const r3 = CS.orderCase({ ...db.orders.find((o) => o.id === "o3"), billing: "required" }, ix, "2030-07-15");
  ok(r3.tasks.includes("請求書の発行"), "個人のお客様の未請求は「請求書の発行」のまま");
  // 売掛 (割り当てと同じ)
  const { customers } = AR.receivablesAsOf(db, "2030-07-15");
  const corp = customers.find((c) => c.customerId === "c_corp");
  eq(corp?.lines.filter((l) => l.kind === "order").map((l) => [l.id, l.balance, l.invoiced]), [["b0", 0, true], ["b1", 24000, true], ["b_nishi", 7700, false], ["b2", 22000, false]].filter((x) => x[1] !== 0), "まとめ請求の売掛: 入金の割り当てのあとの残高、請求済み / 未請求");
}

section("会計データの仕訳: 売上は売上計上日 (= 施工完了日)");
{
  const db = sampleDb();
  const june = ACC.buildJournal(db, { from: "2030-06-01", to: "2030-06-30" });
  const sales = june.filter((r) => r.kind === "sales");
  eq(sales.map((r) => [r.date, r.ref, r.debit.amount]).sort(), [
    ["2030-06-01", "ORD-o1", 110000],
    ["2030-06-07", "INV-i_orphan", 3300],
    ["2030-06-10", "ORD-b1", 33000],
    ["2030-06-11", "ORD-c2o", 8800],
    ["2030-06-12", "ORD-b_nishi", 7700],
    ["2030-06-15", "ORD-o3", 22000],
    ["2030-06-22", "ORD-b2", 22000],
  ].sort(), "6 月の売上: 施工完了日で計上 (未請求も含む)。移行データ・キャンセル・無効の請求書は出さない。受注のない請求書は発行日");
  ok(!sales.some((r) => r.ref === "ORD-o2" || r.ref === "INV-i2"), "5/31 完了・6/2 請求の売上は 5 月 (請求書の発行日の月ではない)");
  const may = ACC.buildJournal(db, { from: "2030-05-01", to: "2030-05-31", kinds: ["sales"] });
  eq(may.map((r) => r.ref).sort(), ["ORD-b0", "ORD-o2"], "5 月の売上");
  const o1 = sales.find((r) => r.ref === "ORD-o1");
  eq([o1.debit.account, o1.credit.account, o1.credit.taxAmount, o1.debit.dept], ["売掛金", "売上高", 10000, "合志店"], "借方 売掛金 / 貸方 売上高・消費税は見積の税・部門は店舗");
  const o3 = sales.find((r) => r.ref === "ORD-o3");
  eq(o3.credit.taxAmount, 2000, "見積のない受注の消費税は 10% の内税");
  const t = ACC.journalTotals(june);
  ok(t.debit === t.credit && t.count === june.length, `借方と貸方の合計が一致 (${t.debit})`);
  ok(june.some((r) => r.kind === "receipt" && r.date === "2030-06-25" && r.credit.account === "売掛金"), "入金は入金日 (貸方 売掛金)");
  const koshiOnly = ACC.buildJournal(db, { from: "2030-06-01", to: "2030-06-30", storeId: "nishi", kinds: ["sales"] });
  eq(koshiOnly.map((r) => r.ref), ["ORD-b_nishi"], "店舗 (部門) で絞る");
  const generic = ACC.genericRows(june);
  ok(generic.length === june.length + 1 && generic[1].length === ACC.GENERIC_HEADER.length, "汎用の CSV の行と項目の数");
  const yayoi = ACC.yayoiRows(june);
  ok(yayoi.every((r) => r.length === 25 && r[0] === 2000), "弥生会計の形式は 25 項目");
}

section("会計データ: 出す仕入の支払 (既定 = 総合振込と現金)");
{
  const db = sampleDb();
  eq(ACC.accountingScope(db), { paymentMethods: ["bulk_transfer", "cash"], nonBulkPurchases: "include" }, "既定の設定");
  const rows = ACC.buildJournal(db, { from: "2030-06-01", to: "2030-07-31" });
  eq(rows.filter((r) => r.kind === "payment").map((r) => r.ref).sort(), ["PUR-pb1", "PUR-pc1"], "支払の仕訳: 総合振込と現金だけ (口座振替・都度振込は通帳から)");
  eq(rows.filter((r) => r.kind === "purchase").map((r) => r.ref).sort(), ["PUR-pb1", "PUR-pb2", "PUR-pc1", "PUR-pd1", "PUR-pt1"], "仕入の計上はすべて (却下を除く)");
  const ex = ACC.excludedPayments(db, { from: "2030-06-01", to: "2030-07-31" });
  eq([ex.count, ex.amount, ex.byMethod.map((m) => m.method).sort()], [2, 9900, ["debit", "transfer"]], "出さない支払の件数・金額 (画面の確認用)");
  db.settings.push({ id: ACC.ACCOUNTING_SCOPE_ID, value: { paymentMethods: ["bulk_transfer"], nonBulkPurchases: "exclude" }, updatedAt: T });
  const rows2 = ACC.buildJournal(db, { from: "2030-06-01", to: "2030-07-31" });
  eq(rows2.filter((r) => r.kind === "payment").map((r) => r.ref), ["PUR-pb1"], "総合振込だけにした設定");
  eq(rows2.filter((r) => r.kind === "purchase").map((r) => r.ref).sort(), ["PUR-pb1", "PUR-pb2"], "ほかの方法の仕入の計上も出さない設定 (支払方法の分からない仕入は出す・仕入先の既定で判定)");
  ok(rows2.every((r) => r.debit.amount === r.credit.amount), "どの行も借方 = 貸方");
  db.cashEntries.push({ id: "ce1", number: "CASH-1", storeId: "koshi", date: "2030-06-18", direction: "out", amount: 2200, account: "仕入 (現金払い)", description: "", source: "purchase", sourceId: "pc1", recordedBy: "u1", createdAt: T, updatedAt: T });
  const rows3 = ACC.buildJournal({ ...db, settings: [] }, { from: "2030-06-01", to: "2030-06-30" });
  ok(rows3.filter((r) => r.ref === "PUR-pc1" && r.kind === "payment").length === 1 && !rows3.some((r) => r.kind === "cash"), "現金の支払は 1 回だけ (現金出納帳の自動の行を重ねない)");
}

section("売掛一覧 (基準日) と仕訳の売掛金が一致する");
{
  const db = sampleDb();
  for (const asOf of ["2030-05-31", "2030-06-20", "2030-06-30", "2030-07-31"]) {
    const { totals } = AR.receivablesAsOf(db, asOf);
    const j = ACC.buildJournal(db, { from: "2000-01-01", to: asOf });
    const ar = j.reduce((a, r) => a + (r.debit.account === "売掛金" ? r.debit.amount : 0) - (r.credit.account === "売掛金" ? r.credit.amount : 0), 0);
    eq(totals.balance, ar, `${asOf}: 売掛一覧の合計 = 仕訳の売掛金の残高 (${ar})`);
  }
  const { customers, totals } = AR.receivablesAsOf(db, "2030-06-30");
  const ind = customers.find((c) => c.customerId === "c_ind");
  eq([ind.balance, ind.invoiced, ind.uninvoiced], [55000 + 22000 + 3300, 55000 + 3300, 22000], "個人: 請求済み (未入金) と未請求に分ける (6/25 の入金は消込済み)");
  ok(ind.lines.find((l) => l.id === "o2").overdue, "支払期限を過ぎた請求済みの売掛");
  eq(ind.lines.find((l) => l.id === "o2").bucket, 0, "経過日数 30 日 = 30日以内の区分");
  eq(AR.receivablesAsOf(db, "2030-08-15").customers.find((c) => c.customerId === "c_ind").lines.find((l) => l.id === "o2").bucket, 2, "経過日数 76 日 = 61〜90日の区分");
  ok(!customers.some((c) => c.lines.some((l) => l.id === "o_imp" || l.id === "o_can")), "移行データ・キャンセルは売掛に入れない");
  const before = AR.receivablesAsOf(db, "2030-06-24").customers.find((c) => c.customerId === "c_ind");
  ok(before.lines.some((l) => l.id === "o1" && l.balance === 110000), "基準日より後の入金は消し込まない");
  ok(totals.buckets.reduce((a, v) => a + v, 0) === totals.balance && totals.invoiced + totals.uninvoiced === totals.balance, "年齢の区分の合計・請求済み + 未請求 = 残高");
  const koshi = AR.receivablesAsOf(db, "2030-06-30", (s) => s === "nishi");
  eq(koshi.customers.map((c) => [c.customerId, c.balance]), [["c_corp", 7700]], "店舗の範囲で絞る");
}

section("買掛一覧 (基準日・支払方法)");
{
  const db = sampleDb();
  const bulk = AR.payablesAsOf(db, "2030-06-30", { method: "bulk" });
  eq(bulk.suppliers.map((s) => [s.name, s.balance, s.count, s.method]), [["仕入先s_bulk", 44000, 2, "bulk_transfer"]], "総合振込の分だけ (税理士に渡す一覧)。7/31 に払う分は 6/30 時点では残高");
  const all = AR.payablesAsOf(db, "2030-06-30", { method: "all" });
  eq(all.total, 44000, "6/30 時点: 口座振替 (6/27)・現金 (6/18)・都度振込 (6/30) は支払済み");
  const mid = AR.payablesAsOf(db, "2030-06-26", { method: "all" });
  eq(mid.suppliers.map((s) => s.name).sort(), ["仕入先s_bulk", "仕入先s_debit", "仕入先s_none"], "6/26 時点では口座振替・都度振込の分も残高");
  eq(AR.payablesAsOf(db, "2030-06-26", { method: "debit" }).total, 5500, "支払方法で絞る (口座振替)");
  eq(AR.payablesAsOf(db, "2030-08-01", { method: "all" }).total, 11000, "支払済みは消える");
  eq(AR.payablesAsOf(db, "2030-06-30", { method: "all", payMonth: "2030-07" }).count, 2, "支払予定の月で絞る");
  eq(AR.payablesAsOf(db, "2030-06-30", { method: "all", payMonth: "2030-08" }).count, 0, "支払予定の月に当たらない");
  ok(!all.suppliers.some((s) => s.lines.some((l) => l.purchase.id === "pr")), "却下した仕入は入れない");
  db.purchases.push(purchase("pu", "s_none", { invoiceDate: "2030-06-29", amount: 1000 }));
  const unset = AR.payablesAsOf(db, "2030-06-30", { method: "unset" });
  eq([unset.total, unset.unsetSuppliers], [1000, 1], "支払方法が未設定の仕入先 (まだ払っていない分)");
  eq(AR.apMethodFilter("zzz"), "bulk", "知らない絞り込みは総合振込だけ (既定)");
  eq(AR.purchaseMethodOf({ status: "approved", payMethod: undefined }, { payMethod: "bulk_transfer" }), "bulk_transfer", "未払の仕入の支払方法 = 仕入先のいつもの支払方法");
  eq(AR.purchaseMethodOf({ status: "paid", payMethod: "cash" }, { payMethod: "bulk_transfer" }), "cash", "支払済みの仕入は支払完了の方法");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
