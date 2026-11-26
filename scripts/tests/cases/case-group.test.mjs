/**
 * 案件 (顧客 → 案件 → 問い合わせ・見積・受注) のテスト (お客様のご要望 2026-11-26「■4〜■8」)
 *   node scripts/tests/cases/case-group.test.mjs   (npm run test:cases)
 * - src/lib/case-group.ts: 案件の決め方 (caseId → 受注 ← 見積 ← 問い合わせ)・追加の問い合わせ・複数の見積と受注・移行した受注の案件・循環しない・状態と履歴
 * - src/lib/tel-wait.ts: TEL待ちの見積 (提出済み・お渡し済み、受注・失注・受注より前の見積は除く)
 * - src/lib/msg-link.ts: 結果の知らせのボタン (予定表で確認) と週の予定表の場所
 * データは手で作った小さな記録 (AI・外部への送信・データベースは使わない)
 */
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") }, moduleCache: true });
const imp = (p) => jiti.import(path.join(root, "src", p));
const G = await imp("lib/case-group.ts");
const T = await imp("lib/tel-wait.ts");
const L = await imp("lib/msg-link.ts");
const S = await imp("lib/case-status.ts");

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

const inq = (id, over = {}) => ({ id, number: `R-${id}`, customerId: "c1", contactName: "", channel: "phone", storeId: "koshi", category: "tatami", summary: `問い合わせ ${id}`, detail: "", status: "new", receivedAt: "2026-11-01T01:00:00Z", createdBy: "u1", updatedAt: "2026-11-01T01:00:00Z", ...over });
const quote = (id, over = {}) => ({ id, number: `Q-${id}`, version: 1, customerId: "c1", storeId: "koshi", title: `見積 ${id}`, category: "tatami", items: [], subtotal: 10000, discount: 0, tax: 1000, total: 11000, status: "sent", validUntil: "2026-12-31", createdBy: "u1", source: "manual", createdAt: "2026-11-02T01:00:00Z", updatedAt: "2026-11-02T01:00:00Z", issuedAt: "2026-11-02", ...over });
const order = (id, over = {}) => ({ id, number: `O-${id}`, customerId: "c1", storeId: "koshi", title: `受注 ${id}`, category: "tatami", contractDate: "2026-11-05", total: 11000, status: "in_progress", workerIds: [], siteAddress: "", progressNotes: [], createdBy: "u1", createdAt: "2026-11-05T01:00:00Z", updatedAt: "2026-11-05T01:00:00Z", ...over });
const baseDb = (over) => ({ inquiries: [], quotes: [], orders: [], customers: [{ id: "c1", name: "テスト様", kana: "", phone: "", address: "", storeId: "koshi", tags: [] }], invoices: [], payments: [], schedule: [], commLogs: [], ...over });

// ---------------------------------------------------------------------------
section("案件の決め方 (caseId → 受注 ← 見積 ← 問い合わせ)");
{
  const db = baseDb({
    inquiries: [inq("inq_1"), inq("inq_2", { caseId: "inq_1", receivedAt: "2026-11-10T01:00:00Z" }), inq("inq_9", { customerId: "c2" })],
    quotes: [quote("q_1", { inquiryId: "inq_1", orderId: "o_1" }), quote("q_2", { inquiryId: "inq_2", createdAt: "2026-11-11T01:00:00Z" }), quote("q_3", { caseId: "o_3" })],
    orders: [order("o_1", { quoteId: "q_1" }), order("o_2", { quoteId: "q_2", createdAt: "2026-11-12T01:00:00Z" }), order("o_3", { source: "import" })],
  });
  const map = G.buildCaseMap(db);
  eq(["inq_1", "q_1", "o_1"].map((id) => map.caseOf(id)), ["inq_1", "inq_1", "inq_1"], "受注 → 見積 → 問い合わせ のつながりは 1 つの案件 (案件の ID = 最初の問い合わせ)");
  eq(map.caseOf("inq_2"), "inq_1", "ほかの案件に追加した問い合わせ (caseId) はその案件");
  eq([map.caseOf("q_2"), map.caseOf("o_2")], ["inq_1", "inq_1"], "追加の問い合わせからの見積・受注 (追加工事) も同じ案件");
  const m = map.members("inq_1");
  eq([m.inquiries.length, m.quotes.length, m.orders.length], [2, 2, 2], "1 つの案件に問い合わせ 2・見積 2・受注 2");
  eq(map.caseOf("o_3"), "o_3", "見積のない受注 (移行した受注) は自分が案件");
  eq(map.caseOf("q_3"), "o_3", "問い合わせのない案件に足した見積は caseId でその案件");
  eq(map.caseOf("inq_9"), "inq_9", "ほかのお客様の問い合わせは別の案件");
  eq(map.caseOf("inq_unknown"), undefined, "ない記録は案件なし");
  eq(G.kindOfId("q_1"), "quote", "ID の頭で記録の種類");
  eq(G.caseHref("inq_1"), "/cases/inq_1", "案件の画面の場所");
}
{
  const db = baseDb({ inquiries: [inq("inq_a", { caseId: "inq_b" }), inq("inq_b", { caseId: "inq_a" }), inq("inq_c", { caseId: "inq_missing" })] });
  const map = G.buildCaseMap(db);
  ok(typeof map.caseOf("inq_a") === "string", "caseId が循環していても止まる");
  eq(map.caseOf("inq_c"), "inq_c", "ない案件を指す caseId は使わない (自分が案件)");
}
{
  const db = baseDb({ inquiries: [inq("inq_d", { deleted: { at: "2026-11-02T00:00:00Z", by: "u1", reason: "誤登録", before: "new" } })] });
  const map = G.buildCaseMap(db);
  eq(map.members("inq_d"), undefined, "削除した問い合わせは案件の記録に入れない");
}

// ---------------------------------------------------------------------------
section("案件の状態 (進行中・過去)・受注にならなかった見積は履歴");
{
  const db = baseDb({
    inquiries: [inq("inq_1", { status: "won", quoteId: "q_1" })],
    quotes: [quote("q_0", { inquiryId: "inq_1", createdAt: "2026-11-01T05:00:00Z" }), quote("q_1", { inquiryId: "inq_1", orderId: "o_1" })],
    orders: [order("o_1", { quoteId: "q_1", status: "in_progress" })],
  });
  const map = G.buildCaseMap(db);
  const s = G.summarizeCase(map.members("inq_1"), S.caseIndex(db), "2026-11-20");
  ok(s.open && s.stage === "in_progress", `施工中の受注があれば進行中 (${s.stageLabel})`);
  const hist = s.rows.find((r) => r.id === "q_0");
  ok(hist && hist.closed && /履歴/.test(hist.detail), "受注より前の、受注にならなかった見積は履歴 (案件を進行中にしない・削除しない)");
  eq([s.counts.quotes, s.counts.orders, s.amount, s.amountLabel], [2, 1, 11000, "受注"], "金額は受注だけ (見積の金額は入れない)");
  eq(s.number, "R-inq_1", "案件の番号 = 最初の記録の番号");
}
{
  const db = baseDb({
    inquiries: [inq("inq_1", { status: "won" }), inq("inq_2", { caseId: "inq_1", status: "new", summary: "手直しのご連絡" })],
    quotes: [quote("q_1", { inquiryId: "inq_1", orderId: "o_1" })],
    orders: [order("o_1", { quoteId: "q_1", status: "cancelled" })],
  });
  const map = G.buildCaseMap(db);
  const s = G.summarizeCase(map.members("inq_1"), S.caseIndex(db), "2026-11-20");
  ok(s.open, "終わった案件に追加の問い合わせ (クレーム・手直し) が来たら、その問い合わせが終わるまで進行中");
  const sums = G.customerCaseSummaries(db, "c1", "2026-11-20", map);
  eq([sums.open.length, sums.past.length], [1, 0], "お客様の案件: 進行中 1 件 (問い合わせ 2 件をまとめて 1 件)");
}

// ---------------------------------------------------------------------------
section("案件に見積を足すときのつながり (quoteLinkForCase)");
{
  const db = baseDb({ inquiries: [inq("inq_1"), inq("inq_2", { caseId: "inq_1" })], orders: [order("o_9", { source: "import" })] });
  eq(G.quoteLinkForCase(db, "inq_1"), { inquiryId: "inq_2", customerId: "c1", storeId: "koshi" }, "問い合わせのある案件は、いちばん新しい問い合わせにつなぐ");
  eq(G.quoteLinkForCase(db, "o_9"), { caseId: "o_9", customerId: "c1", storeId: "koshi" }, "問い合わせのない案件は caseId");
  eq(G.quoteLinkForCase(db, "inq_none"), undefined, "ない案件は undefined");
}

// ---------------------------------------------------------------------------
section("TEL待ち (tel-wait.ts)");
{
  const db = baseDb({
    inquiries: [inq("inq_1"), inq("inq_2", { customerId: "c1", nextActionDue: "2026-11-25", nextAction: "お電話" })],
    quotes: [
      quote("q_a", { inquiryId: "inq_1", issuedAt: "2026-11-02" }),
      quote("q_b", { inquiryId: "inq_1", issuedAt: "2026-11-03", createdAt: "2026-11-03T01:00:00Z" }),
      quote("q_c", { inquiryId: "inq_2", status: "draft", handedOver: true, issuedAt: undefined, updatedAt: "2026-11-15T01:00:00Z", createdAt: "2026-11-15T01:00:00Z" }),
      quote("q_d", { status: "rejected" }),
      quote("q_e", { status: "approved" }),
      quote("q_f", { inquiryId: "inq_3", createdAt: "2026-11-01T01:00:00Z" }),
      quote("q_g", { inquiryId: "inq_3", orderId: "o_g" }),
    ],
    orders: [order("o_g", { quoteId: "q_g", createdAt: "2026-11-06T01:00:00Z" })],
    commLogs: [{ id: "cl1", relatedType: "quote", relatedId: "q_b", at: "2026-11-04T02:00:00Z", body: "検討中とのこと", channel: "phone", userId: "u1" }],
  });
  db.inquiries.push(inq("inq_3"));
  const rows = T.telWaitRows(db, G.buildCaseMap(db), "2026-11-20");
  eq(rows.map((r) => r.quote.id), ["q_a", "q_b", "q_c"], "提出済み・手書きをお渡し済みだけ、お渡しした日の古い順 (失注・未提出・受注済み・受注より前の見積は除く)");
  eq(rows[0].days, 18, "お渡ししてからの日数");
  eq([rows[0].siblings, rows[1].siblings], [1, 1], "同じ案件のほかの TEL待ちの見積の数");
  eq(rows[1].lastLog?.body, "検討中とのこと", "最後のやりとり (案件のどの記録でも)");
  eq(rows[2].next, { date: "2026-11-25", text: "お電話" }, "次の連絡 (問い合わせの次のアクションの期日)");
  ok(rows.every((r) => r.caseId && r.caseNumber), "案件の ID と番号つき (案件を開く)");
  ok(!T.isTelWaitQuote(quote("q_x", { status: "accepted" }), new Set()), "お客様が承諾した見積は TEL待ちではない (受注の登録へ)");
}

// ---------------------------------------------------------------------------
section("結果の知らせのボタン (msg-link.ts・予定表で確認)");
{
  const m = L.msgWithLink("予定を登録しました。", { href: "/schedule?view=week&date=2026-11-27&store=koshi", label: "予定表で確認" });
  eq(L.splitMsgLink(m), { text: "予定を登録しました。", link: { label: "予定表で確認", href: "/schedule?view=week&date=2026-11-27&store=koshi" } }, "文の最後の印をボタンにする");
  eq(L.msgWithLink("保存しました。", { href: "//evil.example", label: "x" }), "保存しました。", "ほかのサイトへのリンクは付けない");
  eq(L.msgWithLink("保存しました。", { href: "https://evil.example", label: "x" }), "保存しました。", "http のリンクも付けない");
  eq(L.splitMsgLink("ただの文 [[リンク]](//evil)"), { text: "ただの文 [[リンク]](//evil)" }, "// で始まる印はボタンにしない");
  eq(L.splitMsgLink("保存しました。"), { text: "保存しました。" }, "印がなければそのまま");
  eq(L.scheduleWeekHref("2026-11-27", "chuo"), "/schedule?view=week&date=2026-11-27&store=chuo", "週の表示・その日を含む週・施工店舗だけ");
  eq(L.scheduleCheckLink([{ date: "2026-12-03" }, { date: "2026-11-30", pickup: true }, { date: "2026-11-28" }], "koshi")?.href, "/schedule?view=week&date=2026-11-30&store=koshi", "引き取りと納品があれば引き取りの日を基準");
  eq(L.scheduleCheckLink([{ date: "2026-12-03" }, { date: "2026-12-01" }], "koshi")?.href, "/schedule?view=week&date=2026-12-01&store=koshi", "引き取りがなければいちばん早い日");
  eq(L.scheduleCheckLink([{ date: "" }, { date: undefined }], "koshi"), undefined, "日付がなければボタンなし");
}

console.log(`\n${pass} 件 OK${fails.length ? ` / ${fails.length} 件 NG` : ""}`);
if (fails.length) {
  for (const f of fails) console.log("  NG:", f);
  process.exit(1);
}
