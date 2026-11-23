// 実行: npm run test:sales (または node scripts/tests/sales/reconcile.test.mjs)
// 売上台帳 (xlsx) と販売管理ソフトの売上明細 (CSV) の二重計上をまとめる処理 (src/lib/sales-reconcile.ts) のテスト。
// データはこのファイルの中の架空の記録だけ (名前・金額はすべてテスト用)。データベース・ファイルには触れない
import path from "node:path";
import { createJiti } from "jiti";

process.env.TZ = "Asia/Tokyo";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const R = await jiti.import(path.join(root, "src/lib/sales-reconcile.ts"));

let pass = 0;
const fails = [];
const ok = (cond, msg) => (cond ? (pass++, console.log("  ✓", msg)) : (fails.push(msg), console.log("  ✗", msg)));
const eq = (a, b, msg) => {
  const c = JSON.stringify(a) === JSON.stringify(b);
  ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log("\n■ " + t);

/* ------------------------------------------------------------------ */
section("名前のゆれ");
eq(R.nameKey("髙野 美子"), "高野美子", "髙 → 高・空白を除く");
eq(R.nameKey("(株)テスト建設"), "てすと建設", "(株) を除き、カタカナはひらがなに");
ok(R.similarNames("髙野", "高野 花子"), "字体の違いと姓だけの台帳");
ok(R.similarNames("試験一木新築", "(有)試験建設"), "法人名の書き方の違い (先頭の 2 文字)");
ok(!R.similarNames("田中", "山田 太郎"), "違う姓は一致しない");
ok(R.siteMentions("試験団地", "試験団地1棟畳取替業務委託"), "台帳の現場名が伝票の施工場所に書いてある");
ok(R.siteMentions("レンガの家", "架空協議会「れんがの家」"), "カタカナ・ひらがなの違い");
ok(!R.siteMentions("北", "南区北町"), "1 文字の現場名は使わない");

/* ------------------------------------------------------------------ */
const ledgerCustomer = (id, name) => ({ id, code: "", name, kana: "", phone: "", postalCode: "", address: "", storeId: "koshi", type: "individual", preferredChannel: "phone", tags: [], notes: "", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" });
const slipCustomer = (code, name, address = "") => ({ ...ledgerCustomer(`c_s${code}`, name), code: `T-${code}`, address });
const ledgerOrder = (id, customerId, storeId, date, total, area = "") => ({ id, number: id.toUpperCase(), customerId, storeId, title: "畳", category: "tatami", contractDate: date, total, status: "paid", workerIds: [], siteAddress: area, completedAt: date, salesDate: date, progressNotes: [{ id: `pn_${id}`, at: `${date}T09:00:00.000Z`, userId: "u1", kind: "complete", body: "売上台帳より取込 (テスト)" }], createdBy: "u1", createdAt: `${date}T09:00:00.000Z`, updatedAt: `${date}T09:00:00.000Z`, source: "import", sourceRef: `03_売上/テスト店 売上.xlsx#${date.slice(0, 7)}!1` });
const slipOrder = (no, customerId, storeId, date, total, site = "", workerIds = []) => ({ id: `o_s${no}`, number: `S-${no}`, customerId, storeId, title: "畳", category: "tatami", contractDate: date, total, status: "paid", workerIds, siteAddress: site, completedAt: date, salesDate: date, progressNotes: [{ id: `pn_s${no}_fp${no}`, at: `${date}T09:00:00.000Z`, userId: "u1", kind: "complete", body: `販売管理ソフトの売上明細より取込 (伝票№${no})\n明細 (税込): 畳 表替え 1×¥${total}=¥${total}` }], createdBy: "u1", createdAt: `${date}T09:00:00.000Z`, updatedAt: `${date}T09:00:00.000Z`, source: "import", sourceRef: `売上明細#伝票№${no}` });

function sampleDb() {
  const customers = [
    ledgerCustomer("c_aaaaaaaaaaa1", "髙野"),
    slipCustomer("9001", "高野 花子", "架空市北区1-1"),
    ledgerCustomer("c_aaaaaaaaaaa2", "試験団地"),
    slipCustomer("9002", "架空市長"),
    ledgerCustomer("c_aaaaaaaaaaa3", "現場A"),
    slipCustomer("9003", "株式会社 架空管理"),
    ledgerCustomer("c_aaaaaaaaaaa4", "現場B"),
    slipCustomer("9004", "別の人"),
    ledgerCustomer("c_aaaaaaaaaaa5", "見本"),
    slipCustomer("9005", "見本 一郎"),
    ledgerCustomer("c_aaaaaaaaaaa6", "重複"),
    slipCustomer("9006", "候補 一"),
    slipCustomer("9007", "候補 二"),
    slipCustomer("9008", "台帳にない人"),
  ];
  const orders = [
    // ① 台帳は月末の日付・字体の違い・伝票の店舗の推定違い → まとめる
    ledgerOrder("o_l1", "c_aaaaaaaaaaa1", "koshi", "2030-07-31", 156700, "北区"),
    slipOrder(1, "c_s9001", "chuo", "2030-07-04", 156700, "", ["u_worker"]),
    // ② 台帳は現場名、伝票は請求先。金額はちょうど税の分の差 (伝票を税抜と判定して 1.1 倍した) → まとめる (台帳の金額を残す)
    ledgerOrder("o_l2", "c_aaaaaaaaaaa2", "nishi", "2030-04-30", 4100690, "架空市"),
    slipOrder(2, "c_s9002", "chuo", "2030-04-30", 4510759, "試験団地1棟畳取替業務委託"),
    // ③ 名前の根拠なし・同じ店舗・同じ日・同じ金額の候補が 1 件 → まとめる
    ledgerOrder("o_l3", "c_aaaaaaaaaaa3", "tamana", "2030-05-10", 41800),
    slipOrder(3, "c_s9003", "tamana", "2030-05-10", 41800),
    // ④ 名前の根拠なし・店舗も地区も違う → まとめない
    ledgerOrder("o_l4", "c_aaaaaaaaaaa4", "nishi", "2030-06-30", 39600, "東町"),
    slipOrder(4, "c_s9004", "koshi", "2030-06-30", 39600, "西町"),
    // ⑤ 台帳の 1 行が伝票 2 枚 (同じお名前・同じ月・合計が同じ) → まとめる
    ledgerOrder("o_l5", "c_aaaaaaaaaaa5", "koshi", "2030-08-31", 30000),
    slipOrder(5, "c_s9005", "koshi", "2030-08-05", 10000),
    slipOrder(6, "c_s9005", "koshi", "2030-08-20", 20000),
    // ⑥ 名前の根拠なしで同じ金額の伝票が 2 枚 → どちらか決められないのでまとめない
    ledgerOrder("o_l6", "c_aaaaaaaaaaa6", "chuo", "2030-09-10", 22000),
    slipOrder(7, "c_s9006", "chuo", "2030-09-10", 22000),
    slipOrder(8, "c_s9007", "chuo", "2030-09-11", 22000),
    // ⑦ 台帳にない伝票 (台帳の前の年) → そのまま
    slipOrder(9, "c_s9008", "hq", "2010-03-03", 55000),
  ];
  return {
    customers,
    orders,
    attachments: [{ id: "att1", parentType: "order", parentId: "o_s1", storeId: "chuo", fileName: "写真.jpg" }],
    surveys: [{ id: "sv1", orderId: "o_s2", customerId: "c_s9002" }],
    inquiries: [{ id: "inq1", customerId: "c_aaaaaaaaaaa1", storeId: "koshi" }],
    threads: [{ id: "th1", orderIds: ["o_s5", "o_s6", "o_l1"] }],
    auditLogs: [{ id: "log1", entity: "order", entityId: "o_s1" }],
  };
}

/* ------------------------------------------------------------------ */
section("照合 (planReconcile)");
{
  const db = sampleDb();
  const before = JSON.stringify(db);
  const pairs = R.planReconcile(db);
  eq(JSON.stringify(db), before, "照合だけではデータを変えない");
  const find = (lid) => pairs.find((p) => p.ledgerIds.includes(lid));
  eq(find("o_l1")?.slipOrderIds, ["o_s1"], "① 月末の日付・字体の違い・店舗の推定違いでも組になる");
  ok(/お名前が一致/.test(find("o_l1")?.reason ?? ""), "① 理由: お名前が一致");
  eq(find("o_l2")?.slipOrderIds, ["o_s2"], "② 現場名が施工場所に書いてあり、差が税の分なら組になる");
  ok(/税の分/.test(find("o_l2")?.reason ?? "") && /現場名/.test(find("o_l2")?.reason ?? ""), "② 理由: 税の扱いの違い・現場名");
  eq(find("o_l3")?.slipOrderIds, ["o_s3"], "③ 同じ店舗・同じ日・同じ金額の候補が 1 件なら組になる");
  ok(!find("o_l4"), "④ 名前の根拠がなく店舗・地区も違う組はまとめない");
  eq(find("o_l5")?.slipOrderIds, ["o_s5", "o_s6"], "⑤ 台帳の 1 行 = 伝票 2 枚 (同じお名前・同じ月・合計が同じ)");
  ok(!find("o_l6"), "⑥ 同じ金額の候補が 2 枚あるときはまとめない");
  ok(!pairs.some((p) => p.slipOrderIds.includes("o_s9")), "⑦ 台帳にない伝票はそのまま");
  eq(pairs.length, 4, "組は 4 つ");
}

/* ------------------------------------------------------------------ */
section("まとめる (applyReconcile)");
{
  const db = sampleDb();
  const totalBefore = db.orders.reduce((a, o) => a + o.total, 0);
  const rep = R.applyReconcile(db, R.planReconcile(db), { now: "2030-12-01T00:00:00.000Z" });
  eq(rep.ordersRemoved, 5, "伝票の受注 5 件を消した (o_s1・o_s2・o_s3・o_s5・o_s6)");
  const ids = db.orders.map((o) => o.id).sort();
  eq(ids, ["o_l1", "o_l2", "o_l3", "o_l4", "o_l5", "o_l6", "o_s4", "o_s7", "o_s8", "o_s9"], "台帳の受注は残り、まとめた伝票の受注だけ消える");
  const l1 = db.orders.find((o) => o.id === "o_l1");
  eq(l1.storeId, "koshi", "台帳の店舗を残す");
  eq(l1.total, 156700, "台帳の金額を残す");
  ok(l1.progressNotes.some((n) => n.id === "pn_s1_fp1"), "伝票の明細 (経過メモ) を台帳の受注へ移す");
  ok(l1.workerIds.includes("u_worker"), "伝票の施工担当を移す");
  eq(l1.customerId, "c_s9001", "お客様は得意先 (コード・電話・住所のある方) にする");
  eq(db.orders.find((o) => o.id === "o_l2").total, 4100690, "② 台帳の金額 (店舗の月の集計と同じ) を残す");
  eq(db.attachments[0].parentId, "o_l1", "消した受注の添付を付け替える");
  eq(db.surveys[0].orderId, "o_l2", "消した受注のアンケートを付け替える");
  eq(db.threads[0].orderIds, ["o_l5", "o_l1"], "配列の参照も付け替える (重ならない)");
  eq(db.auditLogs[0].entityId, "o_s1", "変更履歴は当時のまま");
  ok(!db.customers.some((c) => c.id === "c_aaaaaaaaaaa1"), "1 つの得意先にまとめた台帳の顧客は消す");
  eq(db.inquiries[0].customerId, "c_s9001", "台帳の顧客を参照していた記録は得意先の顧客へ");
  ok(db.customers.some((c) => c.id === "c_aaaaaaaaaaa4"), "まとめなかった台帳の顧客は残す");
  const totalAfter = db.orders.reduce((a, o) => a + o.total, 0);
  eq(totalBefore - totalAfter, 156700 + 4510759 + 41800 + 30000, "二重の分だけ売上の合計が減る");
  eq(rep.remaining, { ledgerOnly: { n: 2, total: 39600 + 22000 }, slipOnly: { n: 4, total: 39600 + 22000 + 22000 + 55000 } }, "残った台帳だけ・伝票だけの受注");
  eq(R.planReconcile(db).length, 0, "もう一度照合しても組はない (何度実行しても同じ)");
  const m = R.monthlyBreakdown(db).find((r) => r.month === "2030-07");
  eq(m, { month: "2030-07", total: 156700, ledger: 156700, slipOnly: 0, ledgerOnly: 0, orders: 1 }, "月ごとの表");
}

section("売上の照合 (src/lib/sales-check.ts: 店舗別・月別・台帳だけの売上・旧システムの数字)");
{
  const SC = await jiti.import(path.join(root, "src/lib/sales-check.ts"));
  const db = sampleDb();
  db.stores = [{ id: "koshi", name: "合志店", shortName: "合志" }, { id: "chuo", name: "中央店", shortName: "中央" }, { id: "nishi", name: "西店", shortName: "西" }, { id: "tamana", name: "玉名店", shortName: "玉名" }, { id: "hq", name: "本社", shortName: "本社" }];
  // 新システムの受注 (12 月) と、照合の相手の数字
  db.orders.push({ ...ledgerOrder("o_new1", "c_aaaaaaaaaaa1", "koshi", "2030-07-15", 50000), id: "o_new1", source: undefined, sourceRef: undefined });
  db.settings = [{ id: "sales_reference", value: { label: "販売管理ソフト", rows: [{ month: "2030-07", storeId: "koshi", amount: 206700 }, { month: "2030-08", storeId: "koshi", amount: 29000 }] } }];
  const all = ["koshi", "chuo", "nishi", "tamana", "hq"];
  const c = SC.salesCheck(db, { from: "2030-01", to: "2030-12", stores: all });
  const jul = c.months.find((m) => m.month === "2030-07");
  eq([jul.byStore.koshi.ledger, jul.byStore.koshi.system, jul.byStore.chuo.duplicate], [156700, 50000, 156700], "7 月: 合志店の台帳 156,700・新システム 50,000、中央店の伝票は二重計上 (まとめると消える)");
  eq(jul.byStore.koshi.diff, 0, "まとめたあとの合志店 7 月 = 旧システムの数字 → 差 0 (一致)");
  eq(c.months.find((m) => m.month === "2030-08").byStore.koshi.diff, 1000, "8 月は 1,000 円の差");
  eq(c.totals.after, c.totals.current - c.totals.duplicate, "まとめたあと = いまの売上 − 二重計上");
  eq(c.ledgerOnly.map((o) => o.id).sort(), ["o_l4", "o_l6"], "台帳だけの売上 = 組にならなかった台帳の受注 (④・⑥)");
  eq(c.referenceLabel, "販売管理ソフト", "照合の相手の名前");
  const only = SC.salesCheck(db, { from: "2030-01", to: "2030-12", stores: ["chuo"] });
  ok(!only.months.some((m) => m.byStore.koshi), "店舗で絞ると、ほかの店舗の行は入らない");
  const csv = SC.salesCheckCsv(c, "ledger-only", db, all);
  eq(csv.length, 3, "台帳だけの売上の CSV (見出し + 2 行)");
  ok(SC.salesCheckCsv(c, "stores", db, all).at(-1)[0] === "合計", "店舗別の CSV に合計の行");
  const p = SC.parseSalesReference("月,店舗,金額\n2030-12,合志店,1,234,567\n2030/12\t中央\t¥2,000\n2030-13,西,1\n2030-12,どこか,1", db.stores);
  eq(p.rows.map((r) => [r.month, r.storeId, r.amount]), [["2030-12", "koshi", 1234567], ["2030-12", "chuo", 2000]], "カンマ区切りの金額 1,234,567・タブ区切り・短い店舗名・¥ を読む");
  eq(p.errors.length, 2, "読めない行 (存在しない月・店舗) は理由を返す");
  eq(SC.salesCheckPeriod({ year: "2029" }).from, "2029-01", "期間: 年");
  eq(SC.salesCheckPeriod({ from: "2030-12", to: "2030-01" }).from, "2030-01", "期間: 逆に入れても並べ替える");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
