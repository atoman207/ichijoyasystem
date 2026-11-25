/**
 * お客様のご要望 2026-11-25「顧客情報画面の表示優先順位と、予定表からの案件登録について」のテスト
 *   node scripts/tests/finance/receipts.test.mjs   (npm run test:finance)
 * 1. 領収書の計算 (src/lib/receipts.ts): 発行する・しない・初期値・内訳の確かめ (合計の不一致・二重発行)・入金の記録との突き合わせ
 * 2. 帳票の出力記録 (src/lib/doc-outputs.ts): 何回目 (再発行)・同じ人の 3 分以内は 1 回・まとめて印刷
 * 3. 施工完了の前の請求書 (src/lib/billing.ts の awaitsCompletion): 売掛・会計データは施工完了から
 * 4. 操作 (Server Actions): 領収書の発行・取り消し・入金の記録、発行する・しない、請求書の事前発行、施工完了で請求済、
 *    帳票をまとめて印刷 (請求書・領収書を発行してまとめる)、現場で受注 (見積の承認とあわせて・日程つき)、契約の承認で見積も承認
 * 5. 帳票の出力の権限 (閲覧のみの社員も出力できる・閲覧できない記録は出せない) と PDF (内訳・再発行の印字・まとめた PDF)
 * 6. 案件の一覧 (顧客の画面) と 同じ品目を分けて納品
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-receipts-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
// PDF のフォントは作業フォルダーの src/assets/fonts から読む
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "receipts-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-receipts",
  CRON_SECRET: "test-cron-receipts",
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

const R = await imp("lib/receipts.ts");
const OUT = await imp("lib/doc-outputs.ts");
const B = await imp("lib/billing.ts");
const AR = await imp("lib/ar-ap.ts");

/* ================================================================== */
section("1. 領収書の計算");
{
  eq([R.receiptWanted({ plannedPayment: "cash" }).wanted, R.receiptWanted({ plannedPayment: "visit" }).wanted, R.receiptWanted({ plannedPayment: "card" }).wanted, R.receiptWanted({ plannedPayment: "epay" }).wanted, R.receiptWanted({ plannedPayment: "transfer" }).wanted, R.receiptWanted({}).wanted], [true, true, false, false, false, false], "発行する: 現金・訪問集金 / しない: カード・電子決済 (ご希望があれば)・振込・未登録");
  eq([R.receiptWanted({ plannedPayment: "card", receiptWanted: true }).wanted, R.receiptWanted({ plannedPayment: "card", receiptWanted: true }).auto, R.receiptWanted({ plannedPayment: "cash", receiptWanted: false }).wanted], [true, false, false], "案件ごとに決めた値が優先 (カードでもご希望で発行・現金でも発行しない)");
  const inv = { id: "i1", total: 55000, tax: 5000, paidAmount: 0, status: "issued" };
  const d0 = R.receiptDraft({ receipts: [], payments: [] }, inv, { plannedPayment: "card" });
  eq([d0.amount, d0.parts, d0.beforePayment, d0.remaining], [55000, [{ method: "card", amount: 55000 }], true, 55000], "入金の前: 残りの全額を入金の予定方法 (カード) で");
  const pays = [
    { id: "p1", invoiceId: "i1", date: "2026-12-01", amount: 30000, method: "cash" },
    { id: "p2", invoiceId: "i1", date: "2026-12-01", amount: 25000, method: "paypay" },
  ];
  const d1 = R.receiptDraft({ receipts: [], payments: pays }, { ...inv, paidAmount: 55000 }, {});
  eq([d1.amount, d1.parts.sort((a, b) => a.method.localeCompare(b.method)), d1.beforePayment], [55000, [{ method: "cash", amount: 30000 }, { method: "epay", amount: 25000 }], false], "入金のあと: 入金の支払方法ごとの内訳 (現金 + 電子決済)");
  const issued = [{ id: "r1", invoiceId: "i1", status: "issued", amount: 30000, parts: [{ method: "cash", amount: 30000 }], createdAt: "2026-12-01T00:00:00Z" }];
  const d2 = R.receiptDraft({ receipts: issued, payments: pays }, { ...inv, paidAmount: 55000 }, {});
  eq([d2.amount, d2.parts, d2.remaining], [25000, [{ method: "epay", amount: 25000 }], 25000], "発行済みの分を引いた残り (電子決済 25,000)");
  eq(R.cleanParts([{ method: "cash", amount: "30,000円" }, { method: "voucher", amount: "０" }, { method: "bogus", amount: 5 }, { method: "other", amount: 1000, note: " 地域振興券 " }]), [{ method: "cash", amount: 30000 }, { method: "other", amount: 1000, note: "地域振興券" }], "内訳を整える (全角・カンマ・円・0 円の行・知らない支払方法を外す)");
  const db = { receipts: issued };
  ok(/合いません/.test(R.receiptError({ amount: 25000, parts: [{ method: "cash", amount: 20000 }] }, inv, db) ?? ""), "内訳の合計が領収金額と合わないと発行しない (アラート)");
  ok(/二重発行/.test(R.receiptError({ amount: 30000, parts: [{ method: "cash", amount: 30000 }] }, inv, db) ?? ""), "請求の金額を超える発行は二重発行として断る");
  eq(R.receiptError({ amount: 25000, parts: [{ method: "cash", amount: 15000 }, { method: "voucher", amount: 10000 }] }, inv, db), undefined, "残り 25,000 = 現金 15,000 + 商品券 10,000 は発行できる");
  ok(/名前/.test(R.receiptError({ amount: 25000, parts: [{ method: "other", amount: 25000 }] }, inv, db) ?? ""), "「その他」は名前が必要");
  ok(/無効/.test(R.receiptError({ amount: 1, parts: [{ method: "cash", amount: 1 }] }, { ...inv, status: "void" }, db) ?? ""), "無効の請求書は発行しない");
  eq(R.receiptError({ amount: 55000, parts: [{ method: "cash", amount: 55000 }] }, inv, db, { replacing: "r1" }), undefined, "作り直し (前の領収書を除いて数える)");
  const c1 = R.receiptChecks({ receipts: issued, payments: [] }, { ...inv, paidAmount: 0 }, { plannedPayment: "cash" });
  ok(c1.some((c) => c.tone === "warn" && /入金の記録は ¥0/.test(c.text)), "領収書を発行したが入金が未記録 → 知らせる");
  const c2 = R.receiptChecks({ receipts: issued, payments: [{ id: "p", invoiceId: "i1", date: "2026-12-01", amount: 30000, method: "transfer" }] }, { ...inv, paidAmount: 30000 }, {});
  ok(c2.some((c) => /支払方法と入金の記録が合いません/.test(c.text)), "領収書は現金・入金は振込 → 支払方法の違いを知らせる");
  const c3 = R.receiptChecks({ receipts: [], payments: pays }, { ...inv, paidAmount: 55000 }, { plannedPayment: "cash" });
  ok(c3.some((c) => c.tone === "info" && /領収書が未発行/.test(c.text)), "現金払いの案件で入金のうち領収書が未発行 → 知らせる");
  const h = R.receiptHeading({ name: "架空 太郎", type: "individual" }, { title: "畳工事代" }, { receiptName: "架空商事 御中" });
  eq([h.addressee, h.honorific, h.purpose], ["架空商事", "御中", "畳工事代として"], "宛名 (受注の領収書の宛名・敬称)・但し書き");
}

/* ================================================================== */
section("2. 帳票の出力記録 (何回目・再発行)");
{
  let n = 0;
  const id = () => `out_${++n}`;
  const db = { docOutputs: [], users: [] };
  const t0 = new Date("2026-12-01T00:00:00Z");
  const input = { kind: "receipt", refId: "r1", number: "R-2026-0001", storeId: "s1", via: "view" };
  eq(OUT.recordOutput(db, "u1", input, t0, id).reissue, 0, "1 回目 = 最初の出力");
  eq(OUT.recordOutput(db, "u1", input, new Date(t0.getTime() + 60_000), id).reissue, 0, "同じ人の 3 分以内 (PDF の表示の読み直し) は同じ回");
  eq(db.docOutputs.length, 1, "記録は 1 行のまま");
  eq(OUT.recordOutput(db, "u1", input, new Date(t0.getTime() + 5 * 60_000), id).reissue, 1, "3 分を過ぎたら再発行 1 回目");
  eq(OUT.recordOutput(db, "u2", input, new Date(t0.getTime() + 5 * 60_000 + 1000), id).reissue, 2, "ほかの人はすぐでも再発行 2 回目");
  eq(OUT.recordOutput(db, "u2", { ...input, via: "batch" }, new Date(t0.getTime() + 5 * 60_000 + 2000), id).reissue, 3, "まとめて印刷はいつも 1 回と数える");
  const q = { kind: "quote", refId: "q1", number: "Q-1", storeId: "s1", via: "view" };
  OUT.recordOutput(db, "u1", { ...q, version: 1 }, t0, id);
  eq(OUT.recordOutput(db, "u1", { ...q, version: 2 }, t0, id).reissue, 0, "見積は版ごとに数える (第 2 版は最初の出力)");
  eq(OUT.outputsOf(db, "receipt", "r1").length, 4, "出力の一覧");
}

/* ================================================================== */
section("3. 施工完了の前の請求書 (売掛・会計データは施工完了から)");
{
  const orders = new Map([
    ["o_open", { status: "scheduled", source: undefined }],
    ["o_done", { status: "completed", source: undefined }],
    ["o_imp", { status: "scheduled", source: "import" }],
  ]);
  const of = (id) => orders.get(id);
  eq([B.awaitsCompletion({ orderId: "o_open" }, of), B.awaitsCompletion({ orderId: "o_done" }, of), B.awaitsCompletion({ orderId: "o_imp" }, of), B.awaitsCompletion({ orderId: "missing" }, of)], [true, false, false, false], "施工完了の前の新システムの受注の請求書だけ");
  const T = "2030-01-01T00:00:00Z";
  const db = {
    customers: [{ id: "c1", code: "C-1", name: "架空", type: "individual" }],
    orders: [{ id: "o1", number: "O-1", customerId: "c1", storeId: "s1", title: "工事", status: "scheduled", total: 11000, contractDate: "2030-06-01", progressNotes: [], invoiceId: "i1", createdAt: T, updatedAt: T }],
    invoices: [{ id: "i1", number: "INV-1", orderId: "o1", customerId: "c1", storeId: "s1", issueDate: "2030-06-05", dueDate: "2030-06-19", subtotal: 10000, tax: 1000, total: 11000, paidAmount: 0, status: "issued", createdAt: T, updatedAt: T }],
    payments: [],
  };
  eq(AR.receivablesAsOf(db, "2030-06-30").totals.balance ?? AR.receivablesAsOf(db, "2030-06-30").customers.length, 0, "施工完了の前の請求書は売掛に入れない");
  db.orders[0] = { ...db.orders[0], status: "invoiced", completedAt: "2030-06-06", salesDate: "2030-06-06" };
  ok(AR.receivablesAsOf(db, "2030-06-30").customers.length === 1, "施工完了 (売上計上日) から売掛に入る");
}

/* ================================================================== */
section("4. 操作: 領収書・請求書の事前発行・まとめて印刷・現場で受注");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const S = db().stores.find((s) => s.kind === "store").id;
const S2 = db().stores.find((s) => s.kind === "store" && s.id !== S).id;
const now = new Date().toISOString();
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
await store.mutate((x) => {
  const mk = (id, role, storeId) => x.users.push({ id, name: `試験 ${id}`, email: `${id}@example.test`, role, title: role, storeId, active: true, createdAt: now, updatedAt: now });
  mk("u_rc_boss", "admin", S);
  mk("u_rc_mgr", "store_manager", S);
  mk("u_rc_staff", "store_staff", S);
  mk("u_rc_other", "store_staff", S2);
  x.customers.push({ id: "c_rc", code: "C-99901", name: "架空 太郎", kana: "カクウ タロウ", phone: "", postalCode: "", address: "熊本県テスト市テスト町1-2", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  x.quotes.push({ id: "q_rc1", number: "Q-2026-9901", version: 1, customerId: "c_rc", storeId: S, title: "畳と襖", category: "tatami", items: [{ id: "qi1", name: "畳 表替え", spec: "きずな", qty: 6, unit: "畳", unitPrice: 10000, amount: 60000 }, { id: "qi2", name: "襖 張替え", qty: 4, unit: "枚", unitPrice: 5000, amount: 20000 }], subtotal: 80000, discount: 0, tax: 0, total: 80000, taxIncluded: true, status: "accepted", siteInfo: { pickupAt: "12/5 午前", deliveryAt: "畳 当日 / 襖 12/9" }, createdBy: "u_rc_staff", createdAt: now, updatedAt: now, orderId: "o_rc1" });
  x.orders.push({ id: "o_rc1", number: "O-2026-9901", quoteId: "q_rc1", customerId: "c_rc", storeId: S, title: "畳と襖", category: "tatami", contractDate: today, total: 80000, status: "scheduled", plannedPayment: "cash", workerIds: ["u_rc_staff"], siteAddress: "", progressNotes: [], createdBy: "u_rc_staff", createdAt: now, updatedAt: now });
  x.schedule.push({ id: "ev_rc1", title: "（テスト町）架空 納品", kind: "delivery", date: today, storeId: S, assigneeIds: ["u_rc_staff"], orderId: "o_rc1", customerId: "c_rc", source: "manual", createdBy: "u_rc_staff", createdAt: now, updatedAt: now });
});
const u = (id) => db().users.find((x) => x.id === id);
const RA = await imp("lib/actions/receipts.ts");
const DDA = await imp("lib/actions/day-docs.ts");
const OA = await imp("lib/actions/orders.ts");
const QA = await imp("lib/actions/quotes.ts");
const DD = await imp("lib/day-docs.ts");
{
  // 帳票をまとめて印刷の一覧
  const rowsStaff = DD.dayDocRows(db(), u("u_rc_staff"), today, S);
  const row = rowsStaff.find((r) => r.key === "o_rc1");
  ok(Boolean(row), "その日の納品の案件が並ぶ");
  eq([row?.invoiceIssue?.ok, row?.receipt?.wanted.wanted, row?.receipt?.canIssue, row?.quote?.canPrint], [false, true, false, true], "店舗スタッフ: 請求書は発行できない (店長・本部・管理者)・領収書は現金払いで「発行する」・見積書は出力できる");
  const rowMgr = DD.dayDocRows(db(), u("u_rc_mgr"), today, S).find((r) => r.key === "o_rc1");
  eq([rowMgr?.invoiceIssue?.ok, rowMgr?.invoiceIssue?.pre, rowMgr?.receipt?.canIssue], [true, true, true], "店長: 施工完了の前でも請求書を発行して印刷できる (事前発行)");

  // まとめて印刷 (店長): 請求書と領収書を発行してまとめる
  const r1 = await act(u("u_rc_mgr"), () => DDA.prepareDayDocs(form({ date: today, store: S, case: ["o_rc1"], "orderId:o_rc1": "o_rc1", "quoteId:o_rc1": "q_rc1", "invoice:o_rc1": "1", "receipt:o_rc1": "1", "rwDefault:o_rc1": "1", "method:o_rc1": "cash", "quote:o_rc1": "1" })));
  const inv = db().invoices.find((i) => i.orderId === "o_rc1" && i.status !== "void");
  const rc = (db().receipts ?? []).filter((r) => r.invoiceId === inv?.id);
  ok(Boolean(inv) && inv.issueDate === today, "まとめて印刷: 請求書を発行 (発行日 = 選んだ日)");
  eq(db().orders.find((o) => o.id === "o_rc1").status, "scheduled", "施工完了の前の発行は受注の状態を変えない");
  eq([rc.length, rc[0]?.amount, rc[0]?.parts], [1, 80000, [{ method: "cash", amount: 80000 }]], "領収書を発行 (現金 80,000)");
  const docs = r1.sp?.get("docs") ?? "";
  eq(docs.split(",").map((d) => d.split(":")[0]), ["q", "i", "r"], "まとめる帳票: 見積書・請求書・領収書");
  const r2 = await act(u("u_rc_mgr"), () => DDA.prepareDayDocs(form({ date: today, store: S, case: ["o_rc1"], "orderId:o_rc1": "o_rc1", "invoice:o_rc1": "1", "receipt:o_rc1": "1", "rwDefault:o_rc1": "1" })));
  eq([(db().receipts ?? []).filter((r) => r.invoiceId === inv.id).length, db().invoices.filter((i) => i.orderId === "o_rc1").length], [1, 1], "もう一度押しても二重に発行しない (発行済みを印刷)");
  ok((r2.sp?.get("docs") ?? "").includes(`r:${rc[0].id}`), "2 回目は発行済みの領収書を印刷 (再発行)");

  // 領収書の発行 (内訳): 残りがないので断る
  const r3 = await act(u("u_rc_staff"), () => RA.issueReceipt(form({ invoiceId: inv.id, amount: "1000", parts: JSON.stringify([{ method: "cash", amount: 1000 }]), returnTo: `/invoices/${inv.id}` })));
  ok(/二重発行/.test(r3.err ?? ""), "請求の金額を超える発行は断る (二重発行)");
  // 取り消し → 内訳つきで作り直し
  const r4 = await act(u("u_rc_other"), () => RA.voidReceipt(rc[0].id, form({ reason: "内訳の誤り" })));
  ok(/取り消せる/.test(r4.err ?? ""), "ほかの店舗のスタッフは取り消せない");
  await act(u("u_rc_staff"), () => RA.voidReceipt(rc[0].id, form({ reason: "内訳の誤り" })));
  eq(db().receipts.find((r) => r.id === rc[0].id).status, "void", "店舗のスタッフが理由つきで取り消し");
  const r5 = await act(u("u_rc_staff"), () => RA.issueReceipt(form({ invoiceId: inv.id, amount: "80000", parts: JSON.stringify([{ method: "cash", amount: 50000 }, { method: "voucher", amount: 20000 }]), returnTo: `/invoices/${inv.id}` })));
  ok(/合いません/.test(r5.err ?? ""), "内訳の合計 70,000 ≠ 80,000 は断る");
  await act(u("u_rc_staff"), () => RA.issueReceipt(form({ invoiceId: inv.id, amount: "80000", parts: JSON.stringify([{ method: "cash", amount: 50000 }, { method: "voucher", amount: 20000 }, { method: "card", amount: 10000 }]), returnTo: `/invoices/${inv.id}` })));
  const live = db().receipts.filter((r) => r.invoiceId === inv.id && r.status === "issued");
  eq(live.map((r) => r.parts.map((p) => p.method).join("+")), ["cash+voucher+card"], "現金 + 商品券 + カードの内訳で作り直し");
  ok(db().auditLogs.some((l) => l.entity === "receipt" && l.entityId === live[0].id && /商品券/.test(l.summary)), "発行は変更履歴に内訳つきで残る");
  // 入金の記録
  await act(u("u_rc_staff"), () => RA.recordReceiptPayments(live[0].id, form({ date: today })));
  const inv2 = db().invoices.find((i) => i.id === inv.id);
  const ps = db().payments.filter((p) => p.invoiceId === inv.id);
  eq([inv2.paidAmount, inv2.status, ps.map((p) => p.method).sort()], [80000, "paid", ["card", "cash", "other"]], "領収書の内訳で入金を記録 (現金・商品券 = その他・カード)");
  ok(db().cashEntries?.some((c) => c.sourceId === ps.find((p) => p.method === "cash")?.id), "現金は現金出納帳にも記帳");
  eq(R.receiptChecks(db(), inv2, db().orders.find((o) => o.id === "o_rc1")).filter((c) => c.tone === "warn"), [], "入金の記録と領収書が合っている (知らせなし)");
  // 施工完了 → 請求済
  await act(u("u_rc_mgr"), () => OA.completeOrder("o_rc1", form({ completedAt: today })));
  eq(db().orders.find((o) => o.id === "o_rc1").status, "paid", "施工完了で受注は請求済 → 入金済みの状態に (事前発行の請求書)");
  // 発行する・しない
  await act(u("u_rc_staff"), () => RA.setReceiptWanted("o_rc1", form({ wanted: "0" })));
  eq(db().orders.find((o) => o.id === "o_rc1").receiptWanted, false, "案件ごとに「発行しない」にできる");
  await act(u("u_rc_staff"), () => RA.setReceiptWanted("o_rc1", form({ wanted: "" })));
  eq(db().orders.find((o) => o.id === "o_rc1").receiptWanted, undefined, "空 = 自動 (入金の予定方法から) に戻す");
}
{
  // 現場で受注 (見積は下書き → 見積の承認とあわせて申請)・品目ごとの日程つき
  await store.mutate((x) => {
    x.inquiries.push({ id: "inq_rc2", number: "INQ-2026-9902", customerId: "c_rc", storeId: S, channel: "phone", category: "tatami", summary: "現場見積", detail: "", status: "quoted", receivedAt: now, createdBy: "u_rc_staff", createdAt: now, updatedAt: now, quoteId: "q_rc2", media: "repeat" });
    x.quotes.push({ id: "q_rc2", number: "Q-2026-9902", version: 1, customerId: "c_rc", inquiryId: "inq_rc2", storeId: S, title: "畳 表替え", category: "tatami", items: [{ id: "qi3", name: "畳 表替え", qty: 4, unit: "畳", unitPrice: 10000, amount: 40000 }], subtotal: 40000, discount: 0, tax: 0, total: 40000, taxIncluded: true, status: "draft", createdBy: "u_rc_staff", createdAt: now, updatedAt: now });
  });
  const plan = [{ id: "hv_t1", item: "tatami_omote", label: "畳 表替え 4枚", pickupDate: "2026-12-05", pickupSlot: "am", deliveryDate: "2026-12-05" }];
  const r1 = await act(u("u_rc_staff"), () => QA.convertQuoteToOrder("q_rc2", form({ onsite: "0", handovers: JSON.stringify(plan), returnTo: "/schedule?qe=ev_x" })));
  ok(/承認済み・送付済み/.test(r1.err ?? ""), "現場で受注でなければ、承認前の見積は受注にできない (今までどおり)");
  const r2 = await act(u("u_rc_staff"), () => QA.convertQuoteToOrder("q_rc2", form({ onsite: "1", handovers: JSON.stringify(plan), workerIds: ["u_rc_staff"], returnTo: "/schedule?qe=ev_x" })));
  const o = db().orders.find((x) => x.quoteId === "q_rc2");
  const q = db().quotes.find((x) => x.id === "q_rc2");
  ok(Boolean(o), "現場で受注: 承認前の見積から受注を登録");
  eq([q.status, o.status, r2.path], ["pending_approval", "pending_approval", "/schedule"], "店舗スタッフ: 見積と契約の承認を申請 (予定表の小さな画面に戻る)");
  eq([o.handovers?.length, o.scheduledStart, o.scheduledEnd], [1, "2026-12-05", "2026-12-05"], "品目ごとの日程をそのまま受注の日程に");
  ok(db().schedule.some((e) => e.orderId === o.id && e.source === "order" && e.date === "2026-12-05"), "承認の前でも日程は予定表に載る");
  ok(/見積の承認も/.test(r2.msg ?? ""), "見積の承認もあわせて申請したことを知らせる");
  const AP = await imp("lib/approval-decide.ts");
  await store.mutate((x) => {
    const a = x.approvals.find((y) => y.type === "order" && y.targetId === o.id && y.status === "pending");
    a.status = "approved";
    a.decidedBy = "u_rc_mgr";
    a.decidedAt = now;
    AP.applyDecision(x, a, "approved", "u_rc_mgr", "");
  });
  const qa = db().approvals.find((y) => y.type === "quote" && y.targetId === "q_rc2");
  eq([db().quotes.find((x) => x.id === "q_rc2").status, qa?.status], ["accepted", "approved"], "契約の承認で見積の承認も済む");
  // 店長は承認なし
  await store.mutate((x) => {
    x.quotes.push({ id: "q_rc3", number: "Q-2026-9903", version: 1, customerId: "c_rc", storeId: S, title: "網戸", category: "amido", items: [{ id: "qi4", name: "網戸 張替え", qty: 2, unit: "枚", unitPrice: 3000, amount: 6000 }], subtotal: 6000, discount: 0, tax: 0, total: 6000, taxIncluded: true, status: "draft", createdBy: "u_rc_mgr", createdAt: now, updatedAt: now });
  });
  await act(u("u_rc_mgr"), () => QA.convertQuoteToOrder("q_rc3", form({ onsite: "1", handovers: JSON.stringify([{ id: "hv_a1", item: "amido", pickupDate: "2026-12-06" }, { id: "hv_a2", item: "amido", label: "網戸 (2回目)", pickupDate: "2026-12-06", deliveryDate: "2026-12-08" }]) })));
  const o3 = db().orders.find((x) => x.quoteId === "q_rc3");
  eq([db().quotes.find((x) => x.id === "q_rc3").status, o3?.status], ["accepted", "scheduled"], "店長: 見積も契約も承認を省略してその場で確定");
  eq(o3.handovers.map((h) => [h.item, h.deliveryDate ?? null]), [["amido", null], ["amido", "2026-12-08"]], "同じ品目を分けて納品 (網戸 2 回目は 12/8)");
}

/* ================================================================== */
section("5. 帳票の出力の権限と PDF");
{
  const DP = await imp("lib/doc-print.ts");
  const P = await imp("lib/auth/permissions.ts");
  const inv = db().invoices.find((i) => i.orderId === "o_rc1");
  eq([P.canOutputDocument(u("u_rc_staff"), "edit"), P.canOutputDocument(u("u_rc_other"), "view"), P.canOutputDocument(u("u_rc_other"), "none")], [true, true, false], "出力: 変更できる人・閲覧のみの人は出せる / 見られない人は出せない");
  const rcp = db().receipts.find((r) => r.invoiceId === inv.id && r.status === "issued");
  const first = await DP.renderTarget(db(), u("u_rc_other"), { kind: "receipt", id: rcp.id }, "view");
  ok(first.ok && first.fileName === `領収書_${rcp.number}.pdf`, "ほかの店舗のスタッフも (閲覧の範囲 = 全社員) 領収書を出力できる (最初の出力)");
  await DP.recordOutputs(u("u_rc_other"), [first.input]);
  const second = await DP.renderTarget(db(), u("u_rc_staff"), { kind: "receipt", id: rcp.id }, "view");
  ok(second.ok && /_再発行1\.pdf$/.test(second.fileName), "2 回目の出力は「再発行」");
  const voided = db().receipts.find((r) => r.status === "void");
  const v = await DP.renderTarget(db(), u("u_rc_staff"), { kind: "receipt", id: voided.id }, "view");
  ok(!v.ok && v.status === 409, "取り消した領収書は出力しない");
  const parts = [];
  for (const t of [{ kind: "invoice", id: inv.id }, { kind: "receipt", id: rcp.id }]) {
    const r = await DP.renderTarget(db(), u("u_rc_mgr"), t, "batch");
    if (r.ok) parts.push(r.bytes);
  }
  const merged = await DP.mergePdfs(parts);
  const { PDFDocument } = await import("pdf-lib");
  const pages = (await PDFDocument.load(merged)).getPageCount();
  ok(pages >= 2, `まとめて印刷: 請求書と領収書を 1 つの PDF に (${pages} ページ)`);
  const D = await imp("lib/pdf/data.ts");
  const pd = D.receiptRecordPdfData(db(), rcp, 2);
  eq([pd.parts.map((p) => p.label), pd.reissue, pd.reissueNo], [["現金", "商品券", "カード"], true, 2], "領収書の PDF: 支払方法ごとの内訳・再発行 2 回目");
}

/* ================================================================== */
section("6. 顧客の画面の案件の一覧・分けて納品");
{
  const CC = await imp("lib/customer-cases.ts");
  const Q = await imp("lib/db/queries.ts");
  const t = Q.customerTimeline(db(), "c_rc");
  const rows = CC.customerCaseRows(db(), t);
  const o1 = rows.find((r) => r.key === "o_rc1");
  eq([o1?.open, o1?.lines.length, o1?.links.map((l) => l.label.split(" ")[0])], [false, 2, ["受注", "見積", "請求書"]], "過去の案件: 明細 2 行・受注・見積・請求書へのリンク");
  ok(rows.some((r) => r.open), "進行中の案件も並ぶ");
  const H = await imp("lib/handover.ts");
  const g = H.handoverGroups([
    { id: "a", item: "fusuma", label: "襖 4枚", pickupDate: "2026-12-05", deliveryDate: "2026-12-09" },
    { id: "b", item: "fusuma", label: "襖 2枚 (2回目)", pickupDate: "2026-12-05", deliveryDate: "2026-12-12" },
    { id: "c", item: "tatami_omote", pickupDate: "2026-12-05", deliveryDate: "2026-12-05" },
  ]);
  eq(g.map((x) => `${x.role}:${x.date}:${x.labels.join("+")}`), ["pickup:2026-12-05:襖 4枚+襖 2枚 (2回目)+畳 表替え", "delivery:2026-12-05:畳 表替え", "delivery:2026-12-09:襖 4枚", "delivery:2026-12-12:襖 2枚 (2回目)"], "引取は同じ日にまとめ、畳は当日・襖は 2 日に分けて納品");
}


/* ================================================================== */
section("7. 請求書・領収書の表示 (入金済みを載せない・お名前のスペース・登録番号)");
{
  const PN = await imp("lib/person-name.ts");
  const idx = PN.nameIndex(["滝下 敬子", "田中 伸幸", "佐々木 一郎", "森 和也", "森田 誠", "原田 誠", "大河原 太郎", "山田 はな", "鈴木 智", "高橋 智"]);
  eq(PN.spacedPersonName("滝下伸幸", idx), "滝下 伸幸", "スペースのないお名前: 登録されている名字 (滝下) と名前 (伸幸) で分ける");
  eq(PN.spacedPersonName("滝下　敬子", idx), "滝下 敬子", "全角のスペースは半角 1 つに");
  eq([PN.spacedPersonName("森和也", idx), PN.spacedPersonName("森田誠", idx)], ["森 和也", "森田 誠"], "名字はいちばん長く一致するもの (森 / 森田)");
  eq(PN.spacedPersonName("大河原", idx), "大河原", "名字だけのお名前 (登録されている名字そのもの) は分けない");
  eq([PN.spacedPersonName("中村だんご", idx), PN.spacedPersonName("塚本商店", idx), PN.spacedPersonName("社長自宅", idx)], ["中村だんご", "塚本商店", "社長自宅"], "お店・会社・メモのようなお名前は分けない");
  eq(PN.spacedPersonName("山田はな", idx), "山田 はな", "漢字の名字 + ひらがなの名前 (どちらも一覧にあるとき)");
  eq([PN.spacedPersonName("佐々木一郎"), PN.spacedPersonName("一ノ瀬誠")], ["佐々木 一郎", "一ノ瀬 誠"], "一覧がなくても 3 文字の名字 (佐々木・一ノ瀬) は分ける");
  eq(PN.spacedPersonName("未知名前"), "未知名前", "確かでないお名前は分けない (顧客の情報にスペースを入れれば、そのとおりに印字)");
  eq(PN.addresseeName("架空商事株式会社", "御中", idx), "架空商事株式会社", "法人・施設 (御中) はそのまま");

  // 登録番号の設定 (data-fix の doc-bank) と PDF
  const DF = await imp("app/api/cron/data-fix/route.ts");
  const post = async (q, body) => (await DF.POST(new Request(`http://test.local/api/cron/data-fix?task=doc-bank&${q}`, { method: "POST", headers: { authorization: "Bearer test-cron-receipts", "content-type": "application/json" }, body: JSON.stringify(body) }))).json();
  const bad = await post("apply=1", { registrationNumber: "T123" });
  ok(Boolean(bad.error), "登録番号の形 (T + 13 桁) を確かめる");
  await post("apply=1", { registrationNumber: "T1234567890123" });
  const DS = await imp("lib/doc-settings.ts");
  eq([DS.documentSettings(db()).registrationNumber, DS.documentSettings(db()).bankAccounts.length], ["T1234567890123", 0], "登録番号だけを設定 (振込先などほかの項目はそのまま)");
  await store.mutate((x) => {
    x.customers.push({ id: "c_rc_nm", code: "C-99977", name: "架空伸幸", kana: "", phone: "", postalCode: "", address: "", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
    x.customers.push({ id: "c_rc_nm2", code: "C-99978", name: "架空 敬子", kana: "", phone: "", postalCode: "", address: "", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
    x.customers.push({ id: "c_rc_nm3", code: "C-99979", name: "試験 伸幸", kana: "", phone: "", postalCode: "", address: "", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  });
  const D = await imp("lib/pdf/data.ts");
  const RN = await imp("lib/pdf/render.ts");
  const paidInv = { ...db().invoices.find((i) => i.orderId === "o_rc1"), customerId: "c_rc_nm" };
  const data = D.invoicePdfData(db(), paidInv);
  eq([data.customerName, data.company.registrationNumber], ["架空 伸幸", "T1234567890123"], "請求書: お名前の名字と名前の間にスペース・登録番号");
  const rcp = db().receipts.find((r) => r.invoiceId === paidInv.id && r.status === "issued");
  const rd = D.receiptRecordPdfData(db(), { ...rcp, addressee: "架空伸幸", honorific: "様" }, 0);
  eq([rd.customerName, rd.company.registrationNumber], ["架空 伸幸", "T1234567890123"], "領収書: お名前のスペース・登録番号");
  const { execFileSync } = await import("node:child_process");
  let pdftotext = true;
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    pdftotext = false;
  }
  if (pdftotext) {
    const f = path.join(work, "inv.pdf");
    fs.writeFileSync(f, await RN.renderInvoicePdf(data));
    const text = execFileSync("pdftotext", ["-layout", f, "-"]).toString();
    ok(paidInv.paidAmount > 0 && !/入金済み/.test(text) && !/差引ご請求額/.test(text), "請求書の PDF: 入金済みの請求書でも「入金済み」「差引ご請求額」を載せない");
    ok(/T1234567890123/.test(text) && /架空 伸幸/.test(text), "請求書の PDF: 登録番号とスペースつきのお名前");
    const g = path.join(work, "rc.pdf");
    fs.writeFileSync(g, await RN.renderReceiptPdf(rd));
    const t2 = execFileSync("pdftotext", ["-layout", g, "-"]).toString();
    ok(/T1234567890123/.test(t2) && /架空 伸幸/.test(t2), "領収書の PDF: 登録番号とスペースつきのお名前");
  } else console.log("  (pdftotext がないため PDF の文字の確かめは省略)");
}


/* ================================================================== */
section("8. 納品書 (請求書と同じ書式・内容で表題が「納品書」)");
{
  const D = await imp("lib/pdf/data.ts");
  const RN = await imp("lib/pdf/render.ts");
  const DP = await imp("lib/doc-print.ts");
  const OUT = await imp("lib/doc-outputs.ts");
  const o1 = db().orders.find((o) => o.id === "o_rc1");
  const inv = db().invoices.find((i) => i.orderId === "o_rc1" && i.status !== "void");
  const dn = D.deliveryPdfData(db(), o1, today);
  const iv = D.invoicePdfData(db(), inv);
  eq([dn.delivery, dn.number, dn.total, dn.items.length, dn.dueDate], [true, o1.number, iv.total, iv.items.length, iv.dueDate], "請求書のある受注: 請求書と同じ内容 (番号は受注番号)");
  const o3 = db().orders.find((o) => o.quoteId === "q_rc3");
  const dn3 = D.deliveryPdfData(db(), o3, today);
  eq([dn3.total, dn3.items.map((x) => x.name), dn3.dueDate, dn3.issuedOn], [6000, ["網戸 張替え"], undefined, today], "請求書のない受注: 受注・見積の明細から (お支払期限なし)");
  const r = await DP.renderTarget(db(), u("u_rc_other"), { kind: "delivery", id: "o_rc1" }, "view");
  ok(r.ok && r.fileName === `納品書_${o1.number}.pdf` && r.input.doc === "delivery" && r.input.kind === "invoice", "閲覧のみの社員も出力できる (出力の記録は請求書と分けて doc = delivery)");
  await DP.recordOutputs(u("u_rc_other"), [r.input]);
  eq([OUT.outputsOf(db(), "invoice", "o_rc1", undefined, "delivery").length, OUT.outputsOf(db(), "invoice", "o_rc1").length], [1, 0], "納品書の出力は請求書の出力と別に数える");
  eq(OUT.outputLabel({ kind: "invoice", doc: "delivery" }), "納品書", "出力記録の帳票の名前");
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    const f = path.join(work, "dn.pdf");
    fs.writeFileSync(f, await RN.renderInvoicePdf(dn));
    const text = execFileSync("pdftotext", ["-layout", f, "-"]).toString();
    ok(/納\s*品\s*書/.test(text) && !/請\s*求\s*書/.test(text.split("\n").slice(0, 8).join("")) && /納品番号/.test(text) && /合計金額/.test(text) && /納品いたしました/.test(text), "PDF: 表題「納品書」・納品番号・合計金額・「下記のとおり納品いたしました。」");
  } catch {
    console.log("  (pdftotext がないため PDF の文字の確かめは省略)");
  }
  const DDA2 = await imp("lib/actions/day-docs.ts");
  const rr = await act(u("u_rc_mgr"), () => DDA2.prepareDayDocs(form({ date: today, store: S, case: ["o_rc1"], "orderId:o_rc1": "o_rc1", "delivery:o_rc1": "1", "invoice:o_rc1": "1" })));
  eq((rr.sp?.get("docs") ?? "").split(",").map((d) => d.split(":")[0]), ["d", "i"], "まとめて印刷: 納品書 → 請求書");
}


/* ================================================================== */
section("9. 帳票をシステムの画面の中で見る (スマートフォンで PDF のあと元の画面に戻れるように)");
{
  const DV = await imp("lib/doc-view.ts");
  const OUT = await imp("lib/doc-outputs.ts");
  const inv = db().invoices.find((i) => i.orderId === "o_rc1" && i.status !== "void");
  eq([DV.isDocSrc(`/api/pdf/invoices/${inv.id}`), DV.isDocSrc("/api/pdf/quotes/q_rc1?version=1"), DV.isDocSrc("/api/pdf/batch?docs=i%3Ainv_1%2Cr%3Arc_2&date=2026-12-01"), DV.isDocSrc("https://example.com/x.pdf"), DV.isDocSrc("/api/attachments/att_1"), DV.isDocSrc("/api/pdf/invoices/../../etc")], [true, true, true, false, false, false], "開けるのは帳票の PDF の場所だけ");
  const before = OUT.outputsOf(db(), "invoice", inv.id).length;
  const r = await DV.loadDoc(db(), u("u_rc_mgr"), `/api/pdf/invoices/${inv.id}`, { record: true });
  ok(r.ok && r.entry.pages >= 1 && /請求書/.test(r.entry.fileName), `請求書を開く (${r.ok ? r.entry.pages : 0} ページ)`);
  eq(OUT.outputsOf(db(), "invoice", inv.id).length, before + 1, "画面で開いたときも出力の記録を残す");
  const denied = await DV.loadDoc(db(), { ...u("u_rc_other"), active: false }, `/api/pdf/invoices/${inv.id}`, { record: false });
  ok(!denied.ok, "見られない人は開けない");
  const { execFileSync } = await import("node:child_process");
  let poppler = true;
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
  } catch {
    poppler = false;
  }
  if (poppler) {
    const png = await DV.docPagePng(db(), u("u_rc_mgr"), `/api/pdf/invoices/${inv.id}`, 1);
    ok(png.ok && png.png[0] === 0x89 && png.png[1] === 0x50, "ページを画像 (PNG) にする");
    const none = await DV.docPagePng(db(), u("u_rc_mgr"), `/api/pdf/invoices/${inv.id}`, 99);
    ok(!none.ok, "ないページは出さない");
  } else console.log("  (pdftoppm がないため画像の確かめは省略)");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
