/**
 * お客様のご要望 2026-11-24「追加のお願い」①〜④ のテスト
 *   node scripts/tests/schedule/intake-approval.test.mjs   (npm run test:schedule)
 * 1. 店長の顧客・見積・受注の登録・変更は承認不要、確定した売上・経費は承認のまま (permissions.ts の skipsApproval・approval-decide.ts)
 * 2. 問合せ登録 (受付) のワンタッチの紐付け: 既存のお客様 / 既存の案件 / 新しいお客様 (顧客も登録・二重登録の確認) (actions/reception.ts)
 * 3. 問い合わせを既存の案件にまとめる (actions/inquiries.ts の mergeInquiryIntoCase)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-intake-approval-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "intake-approval-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-intake-approval",
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
      return { path: u.pathname, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
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
const jst = (s) => new Date(`${s}+09:00`);

/* ================================================================== */
section("1. 店長の承認");
const P = await imp("lib/auth/permissions.ts");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const manager = db().users.find((u) => u.active && u.role === "store_manager");
const staff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === manager.storeId);
eq(["quote", "quote_amend", "order", "order_change", "handover_change", "customer_change", "expense", "purchase"].map((t) => P.skipsApproval(manager, t)), [true, true, true, true, true, true, false, false], "店長: 顧客・見積・受注は承認不要、経費・仕入の支払は承認");
eq([P.skipsApproval(manager), P.skipsApproval(admin), P.skipsApproval(staff, "quote")], [false, true, false], "種類なし (文書など) は管理者だけ・店舗スタッフは承認");
ok(P.canApplyCustomerChange(manager, "tamana") && P.canApplyCustomerChange(manager, manager.storeId) && !P.canApplyCustomerChange(staff, staff.storeId), "顧客の重要情報: 店長は全店舗で承認なし、店舗スタッフは設定どおり");
const OS = await imp("lib/ops-settings.ts");
ok(OS.userCanCreateCustomer(db(), manager) && OS.opsSettings(db()).customerCreators === "office_and_managers", "顧客の新規登録: 初期設定で店長もできる");
const QA = await imp("lib/actions/quotes.ts");
const draft = db().quotes.find((q) => q.status === "draft" && q.storeId === manager.storeId) ?? db().quotes.find((q) => q.status === "draft");
if (draft) {
  const r = await act(manager, () => QA.submitQuote(draft.id));
  const ap = db().approvals.filter((a) => a.type === "quote" && a.targetId === draft.id).at(-1);
  eq([r.err, ap?.status, ap?.decisionComment, db().quotes.find((q) => q.id === draft.id).status], [null, "approved", "店長の申請のため承認を省略", "approved"], `店長の見積の確定は承認不要 (${r.msg})`);
}
const AD = await imp("lib/approval-decide.ts");
const done = db().orders.find((o) => o.status === "completed" && o.storeId === manager.storeId) ?? db().orders.find((o) => o.status === "completed");
const live = db().orders.find((o) => ["confirmed", "scheduled"].includes(o.status) && o.storeId === manager.storeId) ?? db().orders.find((o) => ["confirmed", "scheduled"].includes(o.status));
ok(done && AD.touchesConfirmedSales(db(), { type: "order_change", targetId: done.id, changes: [] }), "施工完了した受注の契約内容の変更 = 確定した売上");
ok(live && !AD.touchesConfirmedSales(db(), { type: "order_change", targetId: live.id, changes: [{ field: "contractDate", before: "a", after: "b" }] }), "着工前の受注の契約日の変更は確定した売上ではない");
ok(live && AD.touchesConfirmedSales(db(), { type: "order_change", targetId: live.id, changes: [{ field: "salesDate", before: "a", after: "b" }] }), "売上計上日の変更は確定した売上");
const OA = await imp("lib/actions/orders.ts");
if (live) {
  const r = await act(manager, () => OA.requestOrderChange(live.id, form({ reason: "お客様のご都合", contractDate: "2026-11-20" })));
  const ap = db().approvals.filter((a) => a.type === "order_change" && a.targetId === live.id).at(-1);
  eq([r.err, ap?.status], [null, "approved"], `店長の契約内容の変更 (着工前) は承認不要 (${r.msg ?? r.err})`);
}
if (done) {
  await store.mutate((x) => {
    const o = x.orders.find((y) => y.id === done.id);
    o.storeId = manager.storeId;
    o.closedAt = undefined;
  });
  const r = await act(manager, () => OA.requestOrderChange(done.id, form({ reason: "契約日の誤り", contractDate: "2026-01-05" })));
  const ap = db().approvals.filter((a) => a.type === "order_change" && a.targetId === done.id).at(-1);
  ok(r.err || (ap?.status === "pending" && ap.requiredRole === "admin"), `施工完了した受注 (確定した売上) の変更は店長でも管理者の承認 (${r.msg ?? r.err})`);
}

/* ================================================================== */
section("2. 問合せ登録のワンタッチの紐付け");
const RA = await imp("lib/actions/reception.ts");
const R = await imp("lib/reception.ts");
const real = db().customers.find((c) => c.storeId === manager.storeId && c.type === "individual" && c.address && c.phone);
const newReception = async (user, text) => {
  const r = await act(user, () => RA.createReception(form({ source: "text", channel: "phone", storeId: user.storeId, text })));
  const doc = db().documents.filter((x) => x.kind === "reception").at(-1);
  return { r, doc };
};
let { doc } = await newReception(manager, `${real.name}様より電話。${real.phone}。住所は${real.address}。畳の表替え6畳。`);
const m = R.matchReception(db(), manager, R.receptionFieldsOf(doc));
ok(m.customers.some((c) => c.customer.id === real.id && c.level !== "name"), "住所・電話が同じお客様が候補 (「こちらのお客様に紐付けますか？」)");
// お客様のご要望 2026-11-25「問い合わせ登録時の顧客登録・紐付け」: 最初にお客様を決めて (紐付け・新規顧客の登録はその場で完了)、そのあと選び直さずに登録する
let r = await act(manager, () => RA.registerReception(form({ id: doc.id, quick: `link:${real.id}`, confirmedUncertain: "on" })));
let inq = db().inquiries.find((i) => i.sourceRef === `reception:${doc.id}`);
eq([r.err, inq, R.receptionMetaOf(db().documents.find((x) => x.id === doc.id)).customerId], [null, undefined, real.id], `「このお客様に紐付ける」でお客様が決まる (問い合わせはまだ) (${r.msg ?? r.err})`);
r = await act(manager, () => RA.registerReception(form({ id: doc.id, intent: "inquiry", summary: "畳の表替え6畳", media: "repeat", confirmedUncertain: "on" })));
inq = db().inquiries.find((i) => i.sourceRef === `reception:${doc.id}`);
eq([r.err, inq?.customerId], [null, real.id], "続けて「問い合わせとして登録する」(お客様を選び直さない)");
({ doc } = await newReception(manager, `${real.name}様より電話。${real.phone}。住所は${real.address}。網戸の張り替え。`));
r = await act(manager, () => RA.registerReception(form({ id: doc.id, quick: "new", media: "unknown", confirmedUncertain: "on" })));
ok(/同じお客様の可能性/.test(r.err ?? ""), "同じお客様の候補があるのに「新しいお客様」→「別のお客様です」の確認を求める (二重登録を防ぐ)");
const before = db().customers.length;
({ doc } = await newReception(manager, "山之内 新太郎様より電話。090-1357-2468。住所は熊本県合志市幾久富1909-123。襖4枚の張り替え。"));
// 確認の画面の欄 (AI が読んだ住所。AI なしのテストでは画面で直した値として送る) も一緒に送られる
r = await act(manager, () => RA.registerReception(form({ id: doc.id, quick: "new", confirmedUncertain: "on", customerName: "山之内 新太郎", phone: "090-1357-2468", address: "熊本県合志市幾久富1909-123" })));
const ncId = R.receptionMetaOf(db().documents.find((x) => x.id === doc.id)).customerId;
const nc = db().customers.find((c) => c.id === ncId);
ok(!r.err && db().customers.length === before + 1 && nc && /山之内/.test(nc.name) && nc.phone.replace(/\D/g, "") === "09013572468" && /幾久富/.test(nc.address) && /顧客として登録しました/.test(r.msg ?? ""), `「新規顧客として登録」でその場で顧客を保存 (${r.msg ?? r.err})`);
r = await act(manager, () => RA.registerReception(form({ id: doc.id, intent: "inquiry", summary: "襖4枚の張り替え", media: "flyer", confirmedUncertain: "on" })));
inq = db().inquiries.find((i) => i.sourceRef === `reception:${doc.id}`);
eq([r.err, inq?.customerId, db().customers.length], [null, nc?.id, before + 1], "続けて問い合わせを登録 (新しいお客様の履歴。顧客は増えない)");
const order = db().orders.find((o) => o.customerId === real.id && o.status !== "cancelled") ?? null;
if (order) {
  ({ doc } = await newReception(manager, `${real.name}様より電話。${real.phone}。来週の引き取りの時間を変えたい。`));
  r = await act(manager, () => RA.registerReception(form({ id: doc.id, quick: `case:order:${order.id}`, media: "repeat", confirmedUncertain: "on" })));
  // 既存の案件への追加も問い合わせを作る (お客様のご要望 2026-11-26「■5」: 問い合わせ一覧に、同じ案件の問い合わせもそれぞれ出す)
  const added = db().inquiries.find((i) => i.sourceRef === `reception:${doc.id}`);
  ok(!r.err && added?.caseId && db().commLogs.some((c) => c.relatedType === "inquiry" && c.relatedId === added.id && /受付/.test(c.subject)), `既存の案件 (${order.number}) にワンタッチで問い合わせを追加 (${r.msg ?? r.err})`);
}
if (staff) {
  await store.mutate((x) => {
    const s = x.settings.find((y) => y.id === "operations");
    if (s) s.value = { customerCreators: "office" };
    else x.settings.push({ id: "operations", value: { customerCreators: "office" }, updatedAt: new Date().toISOString() });
  });
  const clerk = OS.userCanCreateCustomer(db(), staff);
  ({ doc } = await newReception(staff, "高宮 二郎様より電話。080-2468-1357。住所は熊本県合志市須屋9999-1。障子の張り替え。"));
  const c0 = db().customers.length;
  // 問合せ登録からは、顧客を登録できない設定の社員でも新規顧客を登録する (問い合わせは必ずお客様に紐付けて残す。お客様のご要望 2026-11-25)
  r = await act(staff, () => RA.registerReception(form({ id: doc.id, intent: "inquiry", summary: "障子の張り替え", media: "unknown", confirmedUncertain: "on" })));
  ok(/先に上の「お客様・案件の確認」/.test(r.err ?? "") && !db().inquiries.some((i) => i.sourceRef === `reception:${doc.id}`), "お客様を決めずに問い合わせは登録しない (お客様のない問い合わせを作らない)");
  r = await act(staff, () => RA.registerReception(form({ id: doc.id, quick: "new", confirmedUncertain: "on", customerName: "高宮 二郎", phone: "080-2468-1357", address: "熊本県合志市須屋9999-1" })));
  ok(!clerk && !r.err && db().customers.length === c0 + 1, `顧客を登録できない設定の店舗スタッフも、問合せ登録では新規顧客を登録できる (${r.msg ?? r.err})`);
  r = await act(staff, () => RA.registerReception(form({ id: doc.id, intent: "inquiry", summary: "障子の張り替え", media: "unknown", confirmedUncertain: "on" })));
  inq = db().inquiries.find((i) => i.sourceRef === `reception:${doc.id}`);
  ok(!r.err && inq?.customerId && db().customers.find((c) => c.id === inq.customerId)?.name === "高宮 二郎", "問い合わせは新しいお客様に紐付けて保存");
}

/* ================================================================== */
section("3. 既存の案件にまとめる");
const IA = await imp("lib/actions/inquiries.ts");
const CG = await imp("lib/case-group.ts");
const nowIso = new Date().toISOString();
const target = db().orders.find((o) => o.customerId === real.id && !["cancelled", "paid"].includes(o.status)) ?? db().orders.find((o) => o.customerId === real.id);
await store.mutate((x) => {
  x.inquiries.push({ id: "inq_merge", number: "INQ-M-1", customerId: real.id, contactName: real.name, channel: "ai_chat", storeId: manager.storeId, category: "tatami", summary: "引き取りの日の確認", detail: "AI 相談: 引き取りの日を確認したい", status: "new", receivedAt: nowIso, createdBy: "system", updatedAt: nowIso });
  x.schedule.push({ id: "ev_merge", title: "確認の電話", kind: "visit", date: "2026-12-20", storeId: manager.storeId, assigneeIds: [manager.id], inquiryId: "inq_merge", customerId: real.id, source: "manual", createdBy: manager.id, createdAt: nowIso });
});
if (target) {
  r = await act(manager, () => IA.mergeInquiryIntoCase("inq_merge", form({ caseKey: `order:${target.id}` })));
  const merged = db().inquiries.find((i) => i.id === "inq_merge");
  // 2026-11-26「■4」「■5」: 問い合わせは消さず (完了にもせず) 案件の問い合わせにする (caseId)。問い合わせ一覧と案件の画面のどちらにも出る
  const caseOfTarget = CG.caseIdOf(db(), target.id);
  eq([r.err, r.path, merged.status, merged.caseId], [null, `/cases/${caseOfTarget}`, "in_progress", caseOfTarget], "問い合わせを既存の受注の案件に追加する → 問い合わせは対応中のまま案件の問い合わせに・案件の画面へ");
  ok(CG.buildCaseMap(db()).members(caseOfTarget)?.inquiries.some((i) => i.id === "inq_merge"), "案件の記録に問い合わせが入る");
  ok(db().commLogs.some((c) => c.relatedType === "order" && c.relatedId === target.id && /INQ-M-1/.test(c.subject)) && target.progressNotes.length >= 0 && db().orders.find((o) => o.id === target.id).progressNotes.some((n) => /INQ-M-1/.test(n.body)), "内容は受注のやりとり・経過メモに残る");
  eq(db().schedule.find((e) => e.id === "ev_merge").orderId, target.id, "問い合わせの予定は受注の予定に");
}
const other = db().customers.find((c) => c.id !== real.id && db().orders.some((o) => o.customerId === c.id));
await store.mutate((x) => {
  x.inquiries.push({ id: "inq_merge2", number: "INQ-M-2", customerId: real.id, contactName: real.name, channel: "ai_chat", storeId: manager.storeId, category: "tatami", summary: "x", detail: "", status: "new", receivedAt: nowIso, createdBy: "system", updatedAt: nowIso });
});
const otherOrder = other ? db().orders.find((o) => o.customerId === other.id) : undefined;
if (otherOrder) {
  r = await act(admin, () => IA.mergeInquiryIntoCase("inq_merge2", form({ caseKey: `order:${otherOrder.id}` })));
  ok(/同じお客様/.test(r.err ?? ""), "ほかのお客様の案件にはまとめない");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
