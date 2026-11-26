/**
 * 見積の作成: 案件 (caseId) から作る・撮影から作る・1 つの案件の見積を複数受注にする のテスト
 * (お客様のご要望 2026-11-26「■1」「■4」「■6」)
 *   node scripts/tests/capture/quote-case.test.mjs   (npm run test:capture)
 * 1. createQuote の caseId: 問い合わせのある案件は問い合わせにつなぐ・ない案件は Quote.caseId・お客様が違えば断る・店舗は案件の店舗
 * 2. 同じ案件の見積を 2 つとも受注にできる (ほかの見積を変えない)・日程を入れた受注は「予定表で確認」のボタン
 * 3. 失注・削除で同じ問い合わせのほかの見積を巻き込まない
 * 4. captureCaseQuote (撮影 → 読み取り → 見積の作成の画面): 見積のある案件でも撮影できる・案件なしでも読み取ったお客様で開く・caseId を引き継ぐ
 * AI は呼ばない (キーを消す = サンプルの読取)。データは一時フォルダーの JSON
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-quote-case-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "quote-case-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-quote-case",
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
const section = (t) => console.log(`\n■ ${t}`);

const store = await imp("lib/db/store.ts");
const quotes = await imp("lib/actions/quotes.ts");
const capture = await imp("lib/actions/capture.ts");
const linkLib = await imp("lib/msg-link.ts");
await store.syncDb();
const db = () => store.getDb();

async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { path: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { path: u.pathname, params: u.searchParams, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
    }
    throw e;
  } finally {
    globalThis.__testUser = undefined;
  }
}
const form = (obj) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) fd.set(k, String(v));
  return fd;
};
const items = JSON.stringify([
  { name: "襖張替え", spec: "鳥の子", qty: 4, unit: "枚", unitPrice: 5500 },
  { name: "諸経費", qty: 1, unit: "式", unitPrice: 3300 },
]);
const newQuoteId = (r) => (r.path?.startsWith("/quotes/") ? r.path.split("/")[2] : null);

const admin = db().users.find((u) => u.active && u.role === "admin");
const customerIds = new Set(db().customers.map((c) => c.id));
const inq = db().inquiries.find((i) => i.customerId && customerIds.has(i.customerId) && !i.deleted && !i.quoteId && !db().quotes.some((q) => q.inquiryId === i.id));
ok(Boolean(admin && inq), "サンプルデータに管理者とお客様つきの問い合わせがある");

/* ================================================================== */
section("1. 案件 (caseId) から見積を作る");
const a = await act(admin, () => quotes.createQuote(form({ customerId: inq.customerId, title: "見本 A 案", items, intent: "submit", inquiryId: inq.id })));
const qa = db().quotes.find((q) => q.id === newQuoteId(a));
ok(Boolean(qa) && qa.inquiryId === inq.id && qa.status === "approved", `問い合わせから見積 A を作成 (管理者は承認済み) ${a.err ?? ""}`);

const b = await act(admin, () => quotes.createQuote(form({ customerId: inq.customerId, title: "見本 B 案", items, intent: "submit", caseId: inq.id })));
const qb = db().quotes.find((q) => q.id === newQuoteId(b));
ok(Boolean(qb) && qb.inquiryId === inq.id && !qb.caseId, `案件 (問い合わせのある案件) から作った見積 B は問い合わせにつながる ${b.err ?? ""}`);
ok(qb?.storeId === inq.storeId, "店舗は案件 (問い合わせ) の店舗");
const b2 = await act(admin, () => quotes.createQuote(form({ customerId: inq.customerId, title: "見本 B2 案", items, intent: "draft", caseId: qa.id })));
const qb2 = db().quotes.find((q) => q.id === newQuoteId(b2));
ok(qb2?.inquiryId === inq.id, "案件のほかの記録の ID (見積 A) を渡しても、案件の問い合わせにつながる");
const otherStoreId = db().stores.find((s) => s.id !== inq.storeId && s.id !== "hq")?.id;
const b3 = await act(admin, () => quotes.createQuote(form({ customerId: inq.customerId, title: "見本 B3 案", items, intent: "draft", caseId: inq.id, storeId: otherStoreId })));
ok(db().quotes.find((q) => q.id === newQuoteId(b3))?.storeId === otherStoreId, "全店舗のロールは案件の店舗から変えられる (画面の店舗の欄)");
await act(admin, () => quotes.deleteQuote(newQuoteId(b3)));

const other = db().customers.find((c) => c.id !== inq.customerId);
const wrong = await act(admin, () => quotes.createQuote(form({ customerId: other.id, title: "違うお客様", items, intent: "draft", caseId: inq.id })));
ok(wrong.err?.includes("案件のお客様と違う") && wrong.path === "/quotes/new" && wrong.params.get("caseId") === inq.id, "案件のお客様と違うお客様は断る (入力の画面に caseId を付けて戻す)");
const missing = await act(admin, () => quotes.createQuote(form({ customerId: inq.customerId, title: "x", items, intent: "draft", caseId: "inq_nothing" })));
ok(Boolean(missing.err?.includes("案件が見つかりません")), "ない案件は断る");

// 問い合わせのない案件 (見積・受注から始まった案件。移行した受注など): お客様の画面から作った見積 = その見積が案件の最初の記録
const loneCustomer = db().customers.find((c) => c.storeId !== "hq" && c.id !== inq.customerId);
const r0 = await act(admin, () => quotes.createQuote(form({ customerId: loneCustomer.id, title: "最初の見積", items, intent: "draft" })));
const lone = db().quotes.find((q) => q.id === newQuoteId(r0));
ok(Boolean(lone) && !lone.inquiryId && !lone.caseId, "問い合わせのない見積 (案件の最初の記録)");
const c = await act(admin, () => quotes.createQuote(form({ customerId: lone.customerId, title: "追加工事の見積", items, intent: "draft", caseId: lone.id })));
const qc = db().quotes.find((q) => q.id === newQuoteId(c));
ok(Boolean(qc) && qc.caseId === lone.id && !qc.inquiryId, `問い合わせのない案件に足した見積は Quote.caseId = 案件の ID ${c.err ?? ""}`);
ok(qc?.storeId === lone.storeId, "店舗は案件の店舗 (全店舗のロールで店舗を選ばないとき)");
const caseGroup = await imp("lib/case-group.ts");
ok(caseGroup.caseIdOf(db(), qc.id) === lone.id, "見積は案件 (最初の見積) のまとまりに入る");

const staff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === lone.storeId);
if (staff) {
  const s1 = await act(staff, () => quotes.createQuote(form({ customerId: lone.customerId, title: "店舗の社員の見積", items, intent: "draft", caseId: lone.id })));
  const qs1 = db().quotes.find((q) => q.id === newQuoteId(s1));
  ok(qs1?.caseId === lone.id && qs1?.storeId === lone.storeId, `店舗の社員も案件から作れる (店舗は案件の店舗) ${s1.err ?? ""}`);
}

/* ================================================================== */
section("2. 同じ案件の見積を 2 つとも受注にする");
const handovers = JSON.stringify([{ item: "fusuma", pickupDate: "2026-12-03", deliveryDate: "2026-12-07" }]);
const oa = await act(admin, () => quotes.convertQuoteToOrder(qa.id, form({ handovers })));
const orderA = db().orders.find((o) => o.quoteId === qa.id);
ok(Boolean(orderA) && oa.path === `/orders/${orderA.id}`, `見積 A を受注にする ${oa.err ?? ""}`);
const link = linkLib.splitMsgLink(oa.msg ?? "").link;
ok(link?.label === "予定表で確認" && link.href === linkLib.scheduleWeekHref("2026-12-03", orderA.storeId), `日程を入れた受注は「予定表で確認」のボタン (引き取りの日の週・受注の店舗) ${link?.href ?? oa.msg}`);
const qbAfter = db().quotes.find((q) => q.id === qb.id);
ok(qbAfter.status === "approved" && !qbAfter.orderId, "ほかの見積 (B) は変えない (失注・期限切れにしない)");
const ob = await act(admin, () => quotes.convertQuoteToOrder(qb.id, form({})));
const orderB = db().orders.find((o) => o.quoteId === qb.id);
ok(Boolean(orderB) && orderB.id !== orderA.id && !ob.err, `同じ案件の 2 つ目の見積 (B) も受注にできる ${ob.err ?? ""}`);
ok(!linkLib.splitMsgLink(ob.msg ?? "").link, "日程のない受注にはボタンを付けない");
ok(db().quotes.find((q) => q.id === qa.id).orderId === orderA.id && db().orders.filter((o) => o.quoteId === qa.id || o.quoteId === qb.id).length === 2, "受注は見積ごとに 1 件ずつ");
ok(db().quotes.some((q) => q.id === qb2.id && !q.orderId), "受注にならなかった見積 (B2) は履歴として残る");

/* ================================================================== */
section("3. 失注・削除で同じ問い合わせのほかの見積を巻き込まない");
const lost = await act(admin, () => quotes.markQuoteLost(qb2.id, form({ reason: "別の案に決まった" })));
ok(!lost.err && db().quotes.find((q) => q.id === qb2.id).status === "rejected", "見積 B2 を失注にする");
ok(db().inquiries.find((i) => i.id === inq.id).status !== "lost", "同じ問い合わせのほかの見積が受注なら、問い合わせは失注にしない");
const d = await act(admin, () => quotes.createQuote(form({ customerId: inq.customerId, title: "見本 D 案", items, intent: "draft", inquiryId: inq.id })));
const qd = newQuoteId(d);
ok(db().inquiries.find((i) => i.id === inq.id).quoteId === qd, "新しい見積 D が問い合わせの見積になる");
await act(admin, () => quotes.deleteQuote(qd));
const inqAfter = db().inquiries.find((i) => i.id === inq.id);
ok(Boolean(inqAfter.quoteId) && inqAfter.quoteId !== qd && db().quotes.some((q) => q.id === inqAfter.quoteId), "下書き D を消すと、問い合わせの見積は残っているいちばん新しい見積に戻る (空にしない)");

/* ================================================================== */
section("4. 撮影 → 読み取り → 見積の作成の画面 (captureCaseQuote)");
const p1 = await act(admin, () => capture.captureCaseQuote(form({ inquiryId: inq.id, customerId: inq.customerId, back: `/quotes/new?inquiryId=${inq.id}&method=photo` })));
ok(p1.path === "/quotes/new" && p1.params.get("documentId") && p1.params.get("inquiryId") === inq.id && !p1.params.get("returnTo"), `見積のある案件でも撮影できる (1 つの案件に見積を複数)・戻り先がなければ付けない ${p1.err ?? ""}`);
const p2 = await act(admin, () => capture.captureCaseQuote(form({ back: "/quotes/new?method=photo" })));
const doc2 = db().documents.find((x) => x.id === p2.params?.get("documentId"));
ok(p2.path === "/quotes/new" && doc2?.kind === "handwritten_quote" && (p2.params.get("cq") || p2.params.get("customerId")) && !doc2.extracted._case, `案件なしで撮影したら、読み取ったお客様 (電話番号・氏名) で見積の作成の画面を開く ${p2.err ?? ""}`);
const p3 = await act(admin, () => capture.captureCaseQuote(form({ caseId: lone.id, returnTo: `/cases/${lone.id}` })));
const doc3 = db().documents.find((x) => x.id === p3.params?.get("documentId"));
ok(p3.params?.get("caseId") === lone.id && p3.params.get("customerId") === lone.customerId && p3.params.get("returnTo") === `/cases/${lone.id}`, `問い合わせのない案件から撮影すると caseId・お客様・戻り先を引き継ぐ ${p3.err ?? ""}`);
ok(doc3?.extracted?._case?.caseId === lone.id && doc3.storeId === lone.storeId, "書類に案件を残す (読み取りの確認の画面から見積にするときも同じ案件)");
const p4 = await act(admin, () => capture.saveExtraction(form({ id: doc3.id, intent: "quote", confirmedUncertain: "on", data: JSON.stringify({ customerName: "見本", items: doc3.extracted.items }) })));
ok(p4.path === "/quotes/new" && p4.params.get("caseId") === lone.id && p4.params.get("returnTo") === `/cases/${lone.id}`, `読み取りの確認の画面の「見積を作成」も同じ案件・戻り先 ${p4.err ?? ""}`);
const p5 = await act(admin, () => capture.captureCaseQuote(form({ caseId: "o_nothing", back: "/quotes/new?caseId=o_nothing&method=photo" })));
ok(p5.err?.includes("案件が見つかりません") && p5.path === "/quotes/new" && p5.params.get("method") === "photo", "ない案件は撮影の前に断り、見積の作成の画面 (撮影) に戻す");
if (staff) {
  const otherStore = db().inquiries.find((i) => i.storeId !== staff.storeId && i.storeId !== "hq" && !i.deleted && i.customerId);
  if (otherStore) {
    const p6 = await act(staff, () => capture.captureCaseQuote(form({ inquiryId: otherStore.id, back: "/quotes/new?method=photo" })));
    ok(Boolean(p6.err?.includes("権限がありません")), "店舗の社員はほかの店舗の案件の見積を撮影から作れない");
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
