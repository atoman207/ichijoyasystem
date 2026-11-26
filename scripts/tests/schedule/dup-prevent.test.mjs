/**
 * お客様のご要望 2026-11-26「■ 二重登録の防止と見積から受注への動線改善」のテスト
 * ① どこから受注を登録しても、同じ案件の登録済みの引き取り・納品の予定 (手入力・予定表の取込・引取から足した納品) を使い回して二重にしない
 *   (src/lib/db/handover-events.ts)。「新しく追加する」を選んだときだけ使い回さない (existingEvents = add)
 * ③ 見積を受注にする画面の日程の案は 手書きの日時 → 登録済みの予定 (引き継ぐ) → 訪問の日、なければ未定 (src/lib/quote-order-plan.ts)
 * ① 案件を決めずに開いた見積の作成で、お客様の案件を選べる (caseId = 案件 / new)。② 見積を登録したら「受注登録へ進む」(?next=1)
 * データは一時フォルダーの JSON (サンプルデータ)。名前は架空
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-dup-prevent-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
// PDF のフォントは作業フォルダーの src/assets/fonts から読む
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.symlinkSync(path.join(root, "src/assets"), path.join(work, "src/assets"));
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "dup-prevent-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-dup-prevent",
  CRON_SECRET: "test-cron-dup-prevent",
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
const plus = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const d1 = plus(today, 1);
const d5 = plus(today, 5);
const d9 = plus(today, 9);
await store.mutate((x) => {
  const mk = (id, role) => x.users.push({ id, name: `試験 ${id}`, email: `${id}@example.test`, role, title: role, storeId: S, active: true, createdAt: now, updatedAt: now });
  mk("u_dp_mgr", "store_manager");
  mk("u_dp_staff", "store_staff");
  const cust = (id) => x.customers.push({ id, code: `C-8${id.slice(-4)}`, name: `架空 ${id}`, kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町2", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  const inq = (id, cid) => x.inquiries.push({ id, number: `INQ-2026-${id.slice(-4)}`, customerId: cid, storeId: S, channel: "phone", category: "fusuma", summary: "板戸の張替え", detail: "", status: "in_progress", receivedAt: now, createdBy: "u_dp_staff", createdAt: now, updatedAt: now, media: "repeat" });
  const quote = (id, cid, inqId, extra = {}) => x.quotes.push({ id, number: `Q-2026-${id.slice(-4)}`, version: 1, customerId: cid, inquiryId: inqId, storeId: S, title: `襖 ${id}`, category: "fusuma", items: [{ id: "qi", name: "襖張替え", spec: "板戸 片面", qty: 2, unit: "枚", unitPrice: 25500, amount: 51000 }], subtotal: 51000, discount: 0, tax: 0, total: 51000, taxIncluded: true, status: "approved", createdBy: "u_dp_staff", createdAt: now, updatedAt: now, ...extra });
  const ev = (id, kind, date, extra) => x.schedule.push({ id, title: `（テスト町）架空 ${id}`, kind, date, storeId: S, assigneeIds: ["u_dp_staff"], source: "manual", createdBy: "u_dp_staff", createdAt: now, updatedAt: now, ...extra });
  // A: 問い合わせ → 現見の予定 (d1 10:00) → その予定から納品の予定 (d5 午後。予定表の「納品予定を追加」= pair:) と、手入力の納品 (d5) を重ねて登録してしまった案件
  cust("c_dp_a1"); inq("inq_dp_a1", "c_dp_a1"); quote("q_dp_a1", "c_dp_a1", "inq_dp_a1");
  ev("ev_dp_a_visit", "onsite_quote", d1, { inquiryId: "inq_dp_a1", customerId: "c_dp_a1", startTime: "10:00" });
  ev("ev_dp_a_deliv", "delivery", d5, { inquiryId: "inq_dp_a1", customerId: "c_dp_a1", slot: "pm" });
  // B: 同じ形で「新しく追加する」を選ぶ
  cust("c_dp_b1"); inq("inq_dp_b1", "c_dp_b1"); quote("q_dp_b1", "c_dp_b1", "inq_dp_b1");
  ev("ev_dp_b_visit", "onsite_quote", d1, { inquiryId: "inq_dp_b1", customerId: "c_dp_b1", startTime: "10:00" });
  ev("ev_dp_b_deliv", "delivery", d5, { inquiryId: "inq_dp_b1", customerId: "c_dp_b1" });
  // C: 問い合わせのない案件 (見積 q_dp_c0 から始まった案件) に追加した見積 q_dp_c1 (caseId)。引き取りの予定は最初の見積にひも付いている
  cust("c_dp_c1"); quote("q_dp_c0", "c_dp_c1", undefined, { status: "sent" }); quote("q_dp_c1", "c_dp_c1", undefined, { caseId: "q_dp_c0" });
  ev("ev_dp_c_pick", "pickup", d9, { quoteId: "q_dp_c0", customerId: "c_dp_c1", startTime: "13:00" });
  // D: 予定のない見積 (日程は未定)
  cust("c_dp_d1"); quote("q_dp_d1", "c_dp_d1", undefined);
  // E: 案件を決めずに見積を作る (進行中の案件が 1 件あるお客様)
  cust("c_dp_e1"); inq("inq_dp_e1", "c_dp_e1");
  ev("ev_dp_e_visit", "survey", d1, { inquiryId: "inq_dp_e1", customerId: "c_dp_e1" });
});
const u = (id) => db().users.find((x) => x.id === id);
const QA = await imp("lib/actions/quotes.ts");
const QP = await imp("lib/quote-order-plan.ts");
const evOf = (orderId) => db().schedule.filter((e) => e.orderId === orderId);
const planOf = (qid) => QP.quoteOrderPlan(db(), u("u_dp_mgr"), db().quotes.find((q) => q.id === qid));

section("1. 受注にする画面の日程の案: 登録済みの予定を引き継ぐ・使い回す予定を出す");
{
  const p = planOf("q_dp_a1");
  eq([p.initial[0]?.item, p.initial[0]?.pickupDate, p.initial[0]?.deliveryDate, p.initial[0]?.deliverySlot], ["fusuma", d1, d5, "pm"], "引取日 = 現見の日・納品日 = 登録済みの納品の予定の日 (午後も)");
  eq(p.existing.map((e) => `${e.kind}:${e.date}`), [`delivery:${d5}`], "使い回す登録済みの予定 (納品) を出す");
  eq(p.visits.map((v) => v.date), [d1], "訪問 (現見) の予定も出す");
  ok(/登録済みの予定/.test(p.inheritedText ?? ""), "引き継いだことを知らせる");
  const pd = planOf("q_dp_d1");
  eq([pd.initial[0]?.pickupDate ?? "", pd.initial[0]?.deliveryDate ?? "", pd.existing.length], ["", "", 0], "予定も手書きの日時もなければ 引取日・納品日 は未定 (空)");
  const pc = planOf("q_dp_c1");
  eq([pc.initial[0]?.pickupDate, pc.initial[0]?.pickupStart, pc.existing.map((e) => e.id)], [d9, "13:00", ["ev_dp_c_pick"]], "問い合わせのない案件に追加した見積も、案件の最初の見積の引き取りの予定 (日時) を引き継ぐ");
}

section("2. 受注にする: 登録済みの予定を使い回して二重にしない");
{
  const before = db().schedule.length;
  const p = planOf("q_dp_a1");
  const r = await act(u("u_dp_mgr"), () => QA.convertQuoteToOrder("q_dp_a1", form({ handovers: JSON.stringify(p.initial.map((x) => ({ id: x.id, item: x.item, pickupDate: x.pickupDate, pickupStart: x.pickupStart, deliveryDate: x.deliveryDate, deliverySlot: x.deliverySlot }))), existingEvents: "reuse" })));
  const o = db().orders.find((x) => x.quoteId === "q_dp_a1");
  ok(Boolean(o), `受注を登録 ${r.err ?? ""}`);
  eq(db().schedule.length, before, "予定の件数は増えない (現見は受注の現見・手入力の納品は受注の納品に)");
  eq(evOf(o.id).map((e) => e.id).sort(), ["ev_dp_a_deliv", "ev_dp_a_visit"].sort(), "受注の予定は登録済みの 2 件 (同じ ID)");
  const dv = db().schedule.find((e) => e.id === "ev_dp_a_deliv");
  eq([dv.source, dv.kind, dv.date, dv.orderId === o.id], ["order", "delivery", d5, true], "手入力の納品の予定が受注の納品の予定になる");
}

section("3. 「登録済みの予定はそのまま残して新しく追加する」");
{
  const before = db().schedule.length;
  const p = planOf("q_dp_b1");
  await act(u("u_dp_mgr"), () => QA.convertQuoteToOrder("q_dp_b1", form({ handovers: JSON.stringify(p.initial.map((x) => ({ id: x.id, item: x.item, pickupDate: x.pickupDate, deliveryDate: x.deliveryDate }))), existingEvents: "add" })));
  const o = db().orders.find((x) => x.quoteId === "q_dp_b1");
  eq(evOf(o.id).map((e) => e.kind).sort(), ["delivery", "pickup"], "受注の予定は新しく 2 件");
  eq([db().schedule.find((e) => e.id === "ev_dp_b_visit")?.kind, db().schedule.find((e) => e.id === "ev_dp_b_visit")?.source, db().schedule.find((e) => e.id === "ev_dp_b_deliv")?.source], ["onsite_quote", "manual", "manual"], "登録済みの予定はそのまま残る");
  eq(db().schedule.length, before + 2, "予定は 2 件増える");
}

section("4. 問い合わせのない案件に追加した見積の受注も、案件の予定を使い回す");
{
  const p = planOf("q_dp_c1");
  await act(u("u_dp_mgr"), () => QA.convertQuoteToOrder("q_dp_c1", form({ handovers: JSON.stringify(p.initial.map((x) => ({ id: x.id, item: x.item, pickupDate: x.pickupDate, pickupStart: x.pickupStart }))) })));
  const o = db().orders.find((x) => x.quoteId === "q_dp_c1");
  const pick = db().schedule.find((e) => e.id === "ev_dp_c_pick");
  eq([pick?.orderId === o?.id, pick?.source, pick?.startTime], [true, "order", "13:00"], "案件の最初の見積の引き取りの予定が受注の引き取りになる");
}

section("5. 案件を決めずに見積を作る (caseId = 案件 / new)・見積を登録したら「受注登録へ進む」");
{
  const items = JSON.stringify([{ name: "畳表替え", spec: "さくら", qty: 6, unit: "畳", unitPrice: 9900 }]);
  const newQuoteId = (r) => (r.path?.startsWith("/quotes/") ? r.path.split("/")[2] : null);
  const IA = await imp("lib/actions/inquiries.ts");
  let cases;
  globalThis.__testUser = u("u_dp_mgr");
  try {
    cases = await IA.loadCustomerCases("c_dp_e1");
  } finally {
    globalThis.__testUser = undefined;
  }
  eq(cases?.open.map((c) => c.id), ["inq_dp_e1"], "お客様の進行中の案件 (見積の作成の画面の「どの案件の見積か」の候補)");
  let r = await act(u("u_dp_mgr"), () => QA.createQuote(form({ customerId: "c_dp_e1", title: "表替え", items, intent: "submit", caseId: "inq_dp_e1" })));
  const q1 = db().quotes.find((q) => q.id === newQuoteId(r));
  eq([q1?.inquiryId, r.sp?.get("next")], ["inq_dp_e1", "1"], "選んだ案件 (問い合わせ) につながる・見積の画面は「受注登録へ進む」を出す (?next=1)");
  r = await act(u("u_dp_mgr"), () => QA.createQuote(form({ customerId: "c_dp_e1", title: "別の工事", items, intent: "submit", caseId: "new" })));
  const q2 = db().quotes.find((q) => q.id === newQuoteId(r));
  eq([Boolean(q2), q2?.inquiryId ?? null, q2?.caseId ?? null], [true, null, null], "「新規案件として登録」(new) は案件につながない");
  const p1 = planOf(q1.id);
  eq(p1.visits.map((v) => v.date), [d1], "案件につないだ見積は、案件の訪問の予定 (見積) を受注にする画面に出す");
}

section("6. 予定表から移行した案件の仮のお客様: 撮影した見積書の内容で 既存のお客様に紐付ける / 新しいお客様として登録する");
{
  await store.mutate((x) => {
    const ph = (id, name) => x.customers.push({ id, code: `C-7${id.slice(-4)}`, name, kana: "", phone: "", postalCode: "", address: "", area: "テスト町", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: ["予定表から登録"], notes: "", createdAt: now, updatedAt: now });
    ph("c_dp_ph1", "架空");
    ph("c_dp_ph2", "仮名");
    x.customers.push({ id: "c_dp_real", code: "C-70099", name: "架空 太郎", kana: "カクウ タロウ", phone: "0968-00-0001", postalCode: "", address: "熊本県テスト市テスト町5-1", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
    const inq = (id, cid) => x.inquiries.push({ id, number: `INQ-2026-${id.slice(-4)}`, customerId: cid, storeId: S, channel: "phone", category: "tatami", summary: "予定表から", detail: "", status: "in_progress", receivedAt: now, createdBy: "u_dp_staff", createdAt: now, updatedAt: now, media: "unknown", source: "import", sourceRef: `sheet:case:${id}` });
    inq("inq_dp_ph1", "c_dp_ph1");
    inq("inq_dp_ph2", "c_dp_ph2");
    const ev = (id, kind, date, inqId, cid) => x.schedule.push({ id, title: `（テスト町）${id}`, kind, date, storeId: S, assigneeIds: ["u_dp_staff"], source: "import", sourceRef: `sheet:${date}|koshi|${kind}|${id}`, inquiryId: inqId, customerId: cid, createdBy: "u_dp_staff", createdAt: now, updatedAt: now });
    ev("ev_dp_ph1_pick", "pickup", d1, "inq_dp_ph1", "c_dp_ph1");
    ev("ev_dp_ph1_deliv", "delivery", d1, "inq_dp_ph1", "c_dp_ph1");
    ev("ev_dp_ph2_pick", "pickup", d5, "inq_dp_ph2", "c_dp_ph2");
  });
  const R = await imp("lib/reception.ts");
  const blank = { callType: "", callTypeReason: "", customerName: "架空 太郎", kana: "", phone: "", otherPhone: "", email: "", postalCode: "", address: "テスト市テスト町5-1", category: "", summary: "", detail: "", desiredDate: "", urgency: "", callback: "", mediaText: "", storeHint: "", staffName: "", receivedAt: "", caseHint: "", companyName: "", memoText: "", uncertainFields: [], siteAddress: "", appointments: [] };
  const m = R.matchReception(db(), u("u_dp_mgr"), blank);
  eq([m.customers[0]?.customer.id, m.customers[0]?.level], ["c_dp_real", "address"], "読み取った住所で既存のお客様が最初の候補 (住所の一致)");
  const items = JSON.stringify([{ name: "畳表替え", spec: "さくら", qty: 6, unit: "畳", unitPrice: 9900 }]);
  const newQuoteId = (r) => (r.path?.startsWith("/quotes/") ? r.path.split("/")[2] : null);
  const before = db().schedule.length;
  let r = await act(u("u_dp_mgr"), () => QA.createQuote(form({ customerId: "c_dp_real", placeholderId: "c_dp_ph1", placeholderAction: "link", inquiryId: "inq_dp_ph1", title: "表替え", items, intent: "submit" })));
  const q = db().quotes.find((x) => x.id === newQuoteId(r));
  eq([q?.customerId, q?.inquiryId, db().inquiries.find((i) => i.id === "inq_dp_ph1")?.customerId], ["c_dp_real", "inq_dp_ph1", "c_dp_real"], `既存のお客様に紐付け: 見積・問い合わせが既存のお客様に ${r.err ?? ""}`);
  eq(["ev_dp_ph1_pick", "ev_dp_ph1_deliv"].map((id) => db().schedule.find((e) => e.id === id)?.customerId), ["c_dp_real", "c_dp_real"], "予定表の予定も既存のお客様に (予定は増えない)");
  ok(!db().customers.some((c) => c.id === "c_dp_ph1") && db().auditLogs.some((l) => l.entity === "customer" && l.entityId === "c_dp_ph1" && l.action === "delete"), "仮のお客様は記録が残らないので削除 (変更履歴つき)");
  ok(/架空 太郎 様に紐付けました/.test(r.msg ?? ""), "紐付けたことを知らせる");
  const p = planOf(q.id);
  eq(p.existing.map((e) => e.id).sort(), ["ev_dp_ph1_deliv", "ev_dp_ph1_pick"].sort(), "受注にする画面に予定表の引き取り・納品の予定");
  await act(u("u_dp_mgr"), () => QA.convertQuoteToOrder(q.id, form({ handovers: JSON.stringify(p.initial.map((x) => ({ id: x.id, item: x.item, pickupDate: x.pickupDate, deliveryDate: x.deliveryDate }))) })));
  const o = db().orders.find((x) => x.quoteId === q.id);
  eq([db().schedule.length, evOf(o.id).map((e) => e.id).sort()], [before, ["ev_dp_ph1_deliv", "ev_dp_ph1_pick"].sort()], "受注は予定表の予定をそのまま使う (新しい予定は作らない)");

  r = await act(u("u_dp_mgr"), () => QA.createQuote(form({ customerId: "c_dp_ph2", placeholderId: "c_dp_ph2", placeholderAction: "promote", promoteName: "仮名 花子", promoteKana: "カリナ ハナコ", promotePhone: "+81 90-0000-0002", promoteAddress: "熊本県テスト市テスト町9-9", inquiryId: "inq_dp_ph2", title: "表替え", items, intent: "submit" })));
  const q2 = db().quotes.find((x) => x.id === newQuoteId(r));
  const c2 = db().customers.find((c) => c.id === "c_dp_ph2");
  eq([q2?.customerId, c2?.name, c2?.kana, c2?.phone, c2?.address, c2?.tags.includes("予定表から登録")], ["c_dp_ph2", "仮名 花子", "カリナ ハナコ", "090-0000-0002", "熊本県テスト市テスト町9-9", false], `新しいお客様として登録: 仮のお客様を読み取った内容で正式に (電話は国内の形) ${r.err ?? ""}`);
  eq(db().customers.filter((c) => c.name === "仮名 花子").length, 1, "新しい顧客は足さない (二重にならない)");
  ok(db().auditLogs.some((l) => l.entity === "customer" && l.entityId === "c_dp_ph2" && l.changes?.some((c) => c.field === "name")), "変更履歴 (お名前・電話・住所・タグ)");
  r = await act(u("u_dp_mgr"), () => QA.createQuote(form({ customerId: "c_dp_ph2", placeholderId: "c_dp_ph2", placeholderAction: "promote", promoteName: "", inquiryId: "inq_dp_ph2", title: "もう一度", items, intent: "submit" })));
  ok(Boolean(newQuoteId(r)), "正式に登録したあとは仮のお客様ではないので、そのまま見積を作る");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
