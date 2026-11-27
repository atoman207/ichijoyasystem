/**
 * 予定表 (スプレッドシート) から移行した予定の「仮のお客様」と問合せ登録のテスト (お客様のご連絡 2026-11-27
 * 「問い合わせ登録で、既存の案件に紐付けられなかった」: 予定表の案件は名字と地区で仮に作ったお客様についているため、
 * 手書きの名字を読み違えて新しく登録したお客様・本当のお客様を選ぶと、予定表の案件が「このお客様の案件」に出なかった)
 *   node scripts/tests/reception/placeholder-case.test.mjs   (npm run test:reception)
 * 1. 照合 (src/lib/placeholder-match.ts): 名字と町名・町名と予定の日 (名字の読み違い)・電話番号。ほかの町の同じ名字は出さない
 * 2. 問合せ登録の候補 (matchReception): 仮のお客様に印・予定表の案件・注意の文
 * 3. 仮のお客様に紐付ける → メモの電話・住所で正式なお客様にする (読み違いの名字では書き換えない) → 予定表の案件に追加 (予定を二重にしない)
 * 4. 別のお客様 (二重に登録したお客様・本当のお客様) を選んだとき: 予定表の案件が候補に出る → 追加すると案件と予定を付け替え、仮のお客様を消す
 * 5. 手入力の問い合わせ (createInquiry)・問い合わせを案件にまとめる (mergeInquiryIntoCase) も同じ。仮でないほかのお客様の案件は断る
 * 6. 新規顧客として登録しようとすると、仮のお客様がいることを知らせる (二重に登録しない)
 * データは一時フォルダーの JSON (サンプルデータ)。名前・住所・電話は架空。外部への送信・AI は使わない
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-placeholder-case-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "placeholder-case-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-placeholder-case",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|AI_INTAKE_|PHONE_INTAKE_|AI_VOICE)/.test(k)) delete process.env[k];
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
    return { path: null, msg: null, err: null };
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
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) fd.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return fd;
};

const store = await imp("lib/db/store.ts");
const R = await imp("lib/reception.ts");
const RA = await imp("lib/actions/reception.ts");
const IA = await imp("lib/actions/inquiries.ts");
const CC = await imp("lib/case-choice.ts");
const PM = await imp("lib/placeholder-match.ts");
const PC = await imp("lib/placeholder-customer.ts");
const F = await imp("lib/format.ts");
await store.syncDb();
const db = () => store.getDb();

const nowIso = new Date().toISOString();
const today = F.toDateKey(new Date());
const future = (n) => F.addDays(today, n);
const koshi = db().stores.find((s) => s.id === "koshi");
const koshiManager = db().users.find((u) => u.id === koshi.managerUserId && u.active);
const koshiStaff = db().users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_staff" && u.id !== koshiManager?.id);
ok(koshiManager && koshiStaff, "サンプルデータ: 合志店の店長と社員がいる");

// 予定表の取込と同じ形の仮のお客様 (名字と地区だけ) と案件 (問い合わせ・予定)
const TAG = PM.PLACEHOLDER_TAG;
const base = { kana: "", type: "individual", phone: "", postalCode: "", preferredChannel: "phone", firstContactChannel: "phone", notes: "予定表から登録", createdAt: nowIso, updatedAt: nowIso, storeId: "koshi" };
const sheetCase = (d, n, customerId, days) => {
  d.inquiries.push({ id: `inq_ph${n}`, number: `INQ-PH-${n}`, customerId, contactName: "仮野", channel: "phone", storeId: "koshi", category: "tatami", summary: "畳 表替え6 (予定表から移行)", detail: "", status: "in_progress", receivedAt: nowIso, createdBy: "system", updatedAt: nowIso, source: "import", sourceRef: `sheet:case:みほん台|仮野${n}` });
  d.schedule.push({ id: `ev_ph${n}a`, title: "(みほん台) 仮野 納品", kind: "delivery", date: future(days), storeId: "koshi", assigneeIds: [], customerId, inquiryId: `inq_ph${n}`, source: "import", sourceRef: `sheet:${future(days)}|koshi|shiki||(みほん台)仮野`, createdBy: "system", createdAt: nowIso });
  d.schedule.push({ id: `ev_ph${n}b`, title: "(みほん台) 仮野邸 現場確認", kind: "site", date: future(days + 7), storeId: "koshi", assigneeIds: [], customerId, source: "import", sourceRef: `sheet:${future(days + 7)}|person|仮野`, createdBy: "system", createdAt: nowIso });
};
await store.mutate((d) => {
  d.customers.push({ ...base, id: "cust_ph1", code: "C-PH1", name: "仮野", area: "みほん台", address: "", tags: [TAG] });
  d.customers.push({ ...base, id: "cust_ph_other", code: "C-PHX", name: "仮野", area: "べつのまち", address: "", tags: [TAG] });
  sheetCase(d, 1, "cust_ph1", 3);
});

/* ================================================================== */
section("1. 照合 (placeholder-match.ts)");
{
  const ms = (who) => PM.placeholderMatches(db(), who).map((m) => m.customer.id);
  eq(ms({ name: "仮野 太郎", addresses: ["熊本県テスト郡テスト町みほん台1-2-3"] }), ["cust_ph1"], "名字と町名が一致 (ほかの町の同じ名字は出さない)");
  eq(ms({ name: "石野", addresses: ["みほん台"], dates: [future(3)] }), ["cust_ph1"], "名字を読み違えても、町名と予定の日 (納品の日) が合えば候補");
  eq(ms({ name: "石野", addresses: ["みほん台"] }), [], "名字が違い、予定の日もなければ候補にしない (同じ町のほかのお宅)");
  eq(ms({ name: "仮野" }), [], "名字だけ (町名なし) は候補にしない");
  const m = PM.placeholderMatches(db(), { name: "石野", addresses: ["みほん台"], dates: [future(3)] })[0];
  ok(m.reason.includes("予定表から移行") && m.reason.includes("町名") && m.reason.includes("予定の日") && m.reason.includes("仮野"), `理由: ${m.reason}`);
  eq([m.upcoming.count, m.upcoming.first], [2, future(3)], "これからの予定の件数と最初の日");
}

/* ================================================================== */
section("2. 問合せ登録の候補 (matchReception)");
{
  const f = R.normalizeReception({ customerName: "石野", address: "みほん台", phone: "096-111-2222", summary: "2階6畳 敷き合わせ", appointments: [{ kind: "delivery", date: future(3), text: "納品時" }] });
  const m = R.matchReception(db(), koshiStaff, f);
  const c = m.customers.find((x) => x.customer.id === "cust_ph1");
  ok(c?.placeholder && /予定の日/.test(c.reason), "仮のお客様が候補に出る (印つき・町名と予定の日)");
  ok(!m.customers.some((x) => x.customer.id === "cust_ph_other"), "ほかの町の仮のお客様は出さない");
  ok(m.cases.some((k) => k.id === "inq_ph1"), "予定表の案件も案件の候補に出る");
  ok(m.warnings.some((w) => w.includes("予定表") && w.includes("仮野")), "注意: 予定表から移行した予定のお客様がいる (新規顧客として登録しない)");
}

/* ================================================================== */
section("3. 仮のお客様に紐付け → 正式なお客様にして、予定表の案件に追加");
const newReception = async (user, text, extra = {}) => {
  const r = await act(user, () => RA.createReception(form({ source: "text", text, ...extra })));
  return r.path?.split("/").pop();
};
const memo = { customerName: "石野", address: "みほん台", phone: "096-111-2222", summary: "2階6畳 敷き合わせ (納品のとき)", appointments: [{ kind: "delivery", date: future(3), text: "納品時", register: true }] };
{
  const id = await newReception(koshiStaff, "石野様 みほん台 096-111-2222 2階6畳 敷き合わせ 納品時");
  ok(id, "受付を作る");
  // 新規顧客として登録しようとすると、仮のお客様がいることを知らせる
  let r = await act(koshiStaff, () => RA.registerReception(form({ id, quick: "new", ...memo, confirmedUncertain: "on" })));
  ok(r.err?.includes("予定表から移行した予定のお客様") && !db().customers.some((c) => c.name === "石野"), `新規顧客の登録の前に、仮のお客様を知らせる (二重にしない) (${r.err})`);
  // 仮のお客様に紐付ける: メモの電話番号を足して正式なお客様に (名字は読み違いなので書き換えない)
  r = await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_ph1", ...memo, confirmedUncertain: "on" })));
  const ph = db().customers.find((c) => c.id === "cust_ph1");
  ok(!r.err && R.receptionMetaOf(db().documents.find((d) => d.id === id)).customerId === "cust_ph1", `仮のお客様に紐付ける (${r.msg ?? r.err})`);
  eq([ph.name, ph.phone, PM.isPlaceholderCustomer(ph)], ["仮野", "096-111-2222", false], "メモの電話番号を足して正式なお客様にする (読み違いの名字「石野」では書き換えない)");
  ok(/正式なお客様/.test(r.msg ?? ""), "知らせ: 正式なお客様にした");
  const opts = CC.caseOptionsForCustomer(db(), koshiStaff, "cust_ph1", today, { placeholders: true });
  ok(opts.open.some((c) => c.id === "inq_ph1" && !c.placeholder), "予定表の案件が、このお客様の案件として出る");
  const events = db().schedule.length;
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "inq_ph1", ...memo, media: "unknown", storeId: "koshi", storeAuto: "1", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.sourceRef === `reception:${id}`);
  eq([r.err, inq?.caseId, inq?.customerId], [null, "inq_ph1", "cust_ph1"], `予定表の案件に問い合わせを追加 (${r.msg ?? r.err})`);
  eq(db().schedule.length, events, "メモの日程 (同じ案件・同じ日の納品) は予定表に二重に登録しない");
}

/* ================================================================== */
section("4. 別のお客様を選んだとき: 予定表の案件が候補に出て、追加すると付け替える");
await store.mutate((d) => {
  // 読み違いで新しく登録してしまったお客様 / 本当のお客様 (住所は番地まで)
  d.customers.push({ ...base, id: "cust_real", code: "C-REAL", name: "仮野 太郎", phone: "096-111-3333", address: "熊本県テスト郡テスト町みほん台1-2-3", tags: [], notes: "" });
  d.customers.push({ ...base, id: "cust_ph2", code: "C-PH2", name: "仮野", area: "みほん台", address: "", tags: [TAG] });
  sheetCase(d, 2, "cust_ph2", 5);
});
{
  const without = CC.caseOptionsForCustomer(db(), koshiStaff, "cust_real", today);
  ok(!without.open.some((c) => c.id === "inq_ph2"), "以前と同じ呼び方 (placeholders なし) では出ない");
  const opts = CC.caseOptionsForCustomer(db(), koshiStaff, "cust_real", today, { placeholders: true });
  const c = opts.open.find((x) => x.id === "inq_ph2");
  ok(c?.placeholder?.id === "cust_ph2" && c.canAdd && c.placeholder.next === future(5), "予定表の案件が「予定表から移行」の印つきで出る (次の予定の日)");
  eq(CC.initialCaseChoice(opts), "new", "予定表の案件は自動では選ばない (人が確かめて選ぶ)");
  const loaded = await act(koshiStaff, async () => {
    const r = await IA.loadCustomerCases("cust_real");
    ok(r?.open.some((x) => x.id === "inq_ph2" && x.placeholder), "手入力の問い合わせ・見積の画面の読み込み (loadCustomerCases) にも出る");
  });
  ok(!loaded.err, "loadCustomerCases");

  const id = await newReception(koshiStaff, "仮野様 096-111-3333 襖の納品の時間を確認したい");
  let r = await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_real", customerName: "仮野 太郎", phone: "096-111-3333", summary: "納品の時間の確認", confirmedUncertain: "on" })));
  ok(!r.err, "本当のお客様に紐付ける");
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "inq_ph2", customerName: "仮野 太郎", phone: "096-111-3333", summary: "納品の時間の確認", media: "unknown", storeId: "koshi", storeAuto: "1", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.sourceRef === `reception:${id}`);
  eq([r.err, r.path, inq?.caseId, inq?.customerId], [null, "/cases/inq_ph2", "inq_ph2", "cust_real"], `予定表の案件に追加できる (${r.msg ?? r.err})`);
  ok(/予定表から移行した案件/.test(r.msg ?? ""), "知らせ: 予定表から移行した案件をこのお客様の案件にした");
  eq(db().inquiries.find((i) => i.id === "inq_ph2").customerId, "cust_real", "予定表の案件 (問い合わせ) をこのお客様に付け替える");
  eq(["ev_ph2a", "ev_ph2b"].map((e) => db().schedule.find((x) => x.id === e)?.customerId), ["cust_real", "cust_real"], "案件の予定と、案件につながっていない予定もこのお客様に");
  ok(!db().customers.some((c) => c.id === "cust_ph2"), "記録が残らない仮のお客様は消す");
  ok(db().auditLogs.some((l) => l.entity === "customer" && l.entityId === "cust_ph2" && l.action === "delete"), "変更履歴に仮のお客様の削除");
}

/* ================================================================== */
section("5. 手入力の問い合わせ・案件にまとめる も同じ。仮でないほかのお客様の案件は断る");
await store.mutate((d) => {
  d.customers.push({ ...base, id: "cust_ph3", code: "C-PH3", name: "仮野", area: "みほん台", address: "", tags: [TAG] });
  sheetCase(d, 3, "cust_ph3", 8);
  d.customers.push({ ...base, id: "cust_ph4", code: "C-PH4", name: "仮野", area: "みほん台", address: "", tags: [TAG] });
  sheetCase(d, 4, "cust_ph4", 9);
  d.customers.push({ ...base, id: "cust_other", code: "C-OTH", name: "別の 人", phone: "096-999-0000", address: "熊本県テスト市べつ町1-1", tags: [], notes: "" });
  d.inquiries.push({ id: "inq_other", number: "INQ-OTH", customerId: "cust_other", contactName: "別の 人", channel: "phone", storeId: "koshi", category: "tatami", summary: "別の人の件", detail: "", status: "new", receivedAt: nowIso, createdBy: koshiStaff.id, updatedAt: nowIso, media: "flyer" });
  d.inquiries.push({ id: "inq_real_m", number: "INQ-REAL-M", customerId: "cust_real", contactName: "仮野 太郎", channel: "phone", storeId: "koshi", category: "tatami", summary: "納品の日の確認", detail: "", status: "new", receivedAt: nowIso, createdBy: koshiStaff.id, updatedAt: nowIso, media: "unknown" });
});
{
  let r = await act(koshiStaff, () => IA.createInquiry(form({ customerId: "cust_real", caseId: "inq_ph3", channel: "phone", media: "unknown", summary: "引取の時間", category: "tatami", storeId: "koshi", storeAuto: "1" })));
  const inq = db().inquiries.at(-1);
  eq([r.err, r.path, inq.caseId, db().inquiries.find((i) => i.id === "inq_ph3").customerId], [null, "/cases/inq_ph3", "inq_ph3", "cust_real"], `手入力の問い合わせ: 予定表の案件に追加して付け替え (${r.msg ?? r.err})`);
  ok(!db().customers.some((c) => c.id === "cust_ph3") && /予定表から移行した案件/.test(r.msg ?? ""), "仮のお客様を消して知らせる");
  r = await act(koshiStaff, () => IA.createInquiry(form({ customerId: "cust_real", caseId: "inq_other", channel: "phone", media: "unknown", summary: "x", category: "tatami", storeId: "koshi", storeAuto: "1" })));
  ok(/選んだお客様の案件ではありません/.test(r.err ?? "") && db().inquiries.find((i) => i.id === "inq_other").customerId === "cust_other", "仮でないほかのお客様の案件は今までどおり断る (付け替えない)");
  r = await act(koshiStaff, () => IA.mergeInquiryIntoCase("inq_real_m", form({ caseId: "inq_ph4" })));
  eq([r.err, db().inquiries.find((i) => i.id === "inq_real_m").caseId, db().inquiries.find((i) => i.id === "inq_ph4").customerId], [null, "inq_ph4", "cust_real"], `問い合わせを予定表の案件にまとめる (${r.msg ?? r.err})`);
  ok(!db().customers.some((c) => c.id === "cust_ph4"), "仮のお客様を消す");
}

/* ================================================================== */
section("5b. 見積の作成 (createQuote): 予定表の案件を選ぶと付け替えて、その案件の見積にする");
{
  const QA = await imp("lib/actions/quotes.ts");
  await store.mutate((d) => {
    d.customers.push({ ...base, id: "cust_ph7", code: "C-PH7", name: "仮野", area: "みほん台", address: "", tags: [TAG] });
    sheetCase(d, 7, "cust_ph7", 12);
  });
  const items = JSON.stringify([{ name: "畳表替え", spec: "", qty: 6, unit: "畳", unitPrice: 8000 }]);
  const r = await act(koshiManager, () => QA.createQuote(form({ customerId: "cust_real", title: "6畳 表替え", items, intent: "draft", caseId: "inq_ph7" })));
  const q = r.path?.startsWith("/quotes/") ? db().quotes.find((x) => x.id === r.path.split("/")[2]) : undefined;
  eq([r.err, q?.customerId, q?.inquiryId, db().inquiries.find((i) => i.id === "inq_ph7").customerId], [null, "cust_real", "inq_ph7", "cust_real"], `予定表の案件の見積として作成し、案件をこのお客様に付け替える (${r.msg ?? r.err})`);
  ok(!db().customers.some((c) => c.id === "cust_ph7"), "仮のお客様を消す");
}

/* ================================================================== */
section("6. 仮のお客様に足す内容 (fillPlaceholderFromFields)");
{
  await store.mutate((d) => {
    d.customers.push({ ...base, id: "cust_ph5", code: "C-PH5", name: "仮野", area: "みほん台", address: "みほん台", tags: [TAG] });
    d.customers.push({ ...base, id: "cust_ph6", code: "C-PH6", name: "仮野", area: "みほん台", address: "", tags: [TAG] });
  });
  let note;
  await store.mutate((d) => {
    const ph = d.customers.find((c) => c.id === "cust_ph5");
    note = PC.fillPlaceholderFromFields(d, koshiStaff, ph, { name: "仮野 花子", kana: "かりの はなこ", address: "熊本県テスト郡テスト町みほん台4-5-6" });
  });
  const ph5 = db().customers.find((c) => c.id === "cust_ph5");
  eq([ph5.name, ph5.kana, ph5.address, PM.isPlaceholderCustomer(ph5)], ["仮野 花子", "かりの はなこ", "熊本県テスト郡テスト町みほん台4-5-6", false], "仮の名字で始まる氏名・ふりがな・番地までの住所を足して正式なお客様に");
  ok(/正式なお客様/.test(note ?? ""), "知らせの文");
  await store.mutate((d) => {
    const ph = d.customers.find((c) => c.id === "cust_ph6");
    note = PC.fillPlaceholderFromFields(d, koshiStaff, ph, { name: "石野 一郎", kana: "いしの", address: "みほん台" });
  });
  const ph6 = db().customers.find((c) => c.id === "cust_ph6");
  eq([ph6.name, ph6.kana, ph6.address, PM.isPlaceholderCustomer(ph6), note], ["仮野", "", "", true, undefined], "名字が違う・番地のない住所では何も変えない (仮のまま)");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
