/**
 * 問い合わせの登録のときの「新規案件 / 既存の案件に追加」と、同じ情報を 1 回だけ入れる (お客様のご要望 2026-11-26「■2」「■5」) のテスト
 *   node scripts/tests/reception/case-choice.test.mjs   (npm run test:reception)
 * 1. 案件の候補 (src/lib/case-choice.ts): 進行中・最近の完了 (3 年以内)・追加できるか・初めに選ぶ案件
 * 2. 問合せ登録 (actions/reception.ts の registerReception): 案件に追加しても問い合わせを作る (caseId)・完了した案件へのクレーム・
 *    選んだ媒体・担当店舗・担当者を紐付けのあとも残す (_reg)・施工現場の住所の担当エリア・案件の予定の二重登録・「予定表で確認」のリンク・案件の画面から (caseId)
 * 3. 手入力の問い合わせ (actions/inquiries.ts の createInquiry・loadCustomerCases)
 * 4. 既存の案件に追加 (mergeInquiryIntoCase) と、付け替えのときに案件から外す (linkInquiryToCustomer)
 * データは一時フォルダーの JSON (サンプルデータ)。外部への送信・AI は使わない
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-case-choice-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "case-choice-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-case-choice",
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
const CG = await imp("lib/case-group.ts");
const F = await imp("lib/format.ts");
await store.syncDb();
const db = () => store.getDb();

const nowIso = new Date().toISOString();
const today = F.toDateKey(new Date());
const future = (n) => F.addDays(today, n);
const yearsAgo = (n) => `${Number(today.slice(0, 4)) - n}${today.slice(4)}`;
const koshi = db().stores.find((s) => s.id === "koshi");
const admin = db().users.find((u) => u.role === "admin" && u.active);
const koshiManager = db().users.find((u) => u.id === koshi.managerUserId && u.active);
const koshiStaff = db().users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_staff" && u.id !== koshiManager?.id);
const estimator = db().users.find((u) => u.active && u.storeId === "koshi" && u.id !== koshiStaff?.id && u.id !== koshiManager?.id) ?? koshiManager;
const otherStore = db().stores.find((s) => s.id !== "koshi" && s.kind !== "hq");
ok(admin && koshiManager && koshiStaff && otherStore, "サンプルデータ: 管理者・合志店の店長と社員・ほかの店舗がいる");

// お客様 1 人の案件: A = 問い合わせ → 見積 → 受注 (進行中) / B = 完了した受注 (1 年前) / C = 完了した受注 (5 年前) / D = ほかの店舗の受注 (進行中)
await store.mutate((d) => {
  const base = { kana: "", type: "individual", postalCode: "", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: nowIso, updatedAt: nowIso };
  d.customers.push({ ...base, id: "cust_cc1", code: "C-CC1", name: "案件 一郎", phone: "090-8301-0001", storeId: "koshi", address: "熊本県テスト市かがみ町1-2" });
  d.customers.push({ ...base, id: "cust_cc2", code: "C-CC2", name: "別人 二郎", phone: "090-8302-0002", storeId: "koshi", address: "熊本県テスト市かがみ町9-9" });
  const inqBase = { channel: "phone", category: "tatami", detail: "", createdBy: koshiStaff.id, updatedAt: nowIso, receivedAt: nowIso };
  d.inquiries.push({ ...inqBase, id: "inq_cc_a", number: "INQ-CC-A", customerId: "cust_cc1", contactName: "案件 一郎", storeId: "koshi", summary: "和室の表替え", status: "quoted", quoteId: "q_cc_a", media: "flyer", assignedUserId: koshiStaff.id });
  d.quotes.push({ id: "q_cc_a", number: "Q-CC-A", version: 1, customerId: "cust_cc1", inquiryId: "inq_cc_a", storeId: "koshi", title: "和室6畳 表替え", category: "tatami", items: [], subtotal: 60000, tax: 6000, total: 66000, status: "approved", validUntil: future(30), createdBy: koshiStaff.id, estimatorId: estimator.id, orderId: "o_cc_a", createdAt: nowIso, updatedAt: nowIso });
  const order = { category: "tatami", total: 66000, workerIds: [], progressNotes: [], createdBy: koshiManager.id, createdAt: nowIso, updatedAt: nowIso };
  d.orders.push({ ...order, id: "o_cc_a", number: "O-CC-A", quoteId: "q_cc_a", customerId: "cust_cc1", storeId: "koshi", title: "和室6畳 表替え", status: "scheduled", contractDate: today, scheduledStart: `${future(10)}T09:00:00+09:00` });
  d.orders.push({ ...order, id: "o_cc_b", number: "O-CC-B", customerId: "cust_cc1", storeId: "koshi", title: "襖 4枚 張替え", status: "paid", contractDate: yearsAgo(1), completedAt: yearsAgo(1), salesDate: yearsAgo(1), closedAt: `${yearsAgo(1)}T12:00:00+09:00`, createdAt: `${yearsAgo(1)}T09:00:00+09:00`, updatedAt: `${yearsAgo(1)}T12:00:00+09:00` });
  d.orders.push({ ...order, id: "o_cc_c", number: "O-CC-C", customerId: "cust_cc1", storeId: "koshi", title: "網戸 張替え", status: "paid", contractDate: yearsAgo(5), completedAt: yearsAgo(5), salesDate: yearsAgo(5), closedAt: `${yearsAgo(5)}T12:00:00+09:00`, createdAt: `${yearsAgo(5)}T09:00:00+09:00`, updatedAt: `${yearsAgo(5)}T12:00:00+09:00` });
  d.orders.push({ ...order, id: "o_cc_d", number: "O-CC-D", customerId: "cust_cc1", storeId: otherStore.id, title: "洋室 クロス", status: "confirmed", contractDate: today, createdBy: admin.id });
  // 案件 A の予定 (引き取り)
  d.schedule.push({ id: "ev_cc_a", title: "案件 一郎 引取", kind: "pickup", date: future(10), storeId: "koshi", assigneeIds: [koshiStaff.id], orderId: "o_cc_a", customerId: "cust_cc1", source: "order", createdBy: koshiStaff.id, createdAt: nowIso });
  // 営業エリア (社外秘の実データは使わない): テスト市みほん町 → ほかの店舗
  d.salesAreas.push({ id: "sa_cc1", municipality: "", town: "テスト市みほん町", storeId: otherStore.id, validFrom: "2020-01-01", source: "manual", createdBy: admin.id, createdAt: nowIso });
});

/* ================================================================== */
section("1. 案件の候補 (src/lib/case-choice.ts)");
{
  const o = CC.caseOptionsForCustomer(db(), koshiStaff, "cust_cc1", today);
  eq(o.open.map((c) => c.id).sort(), ["inq_cc_a", "o_cc_d"].sort(), "進行中の案件 (最初の記録の ID = 案件の ID)");
  eq(o.past.map((c) => c.id), ["o_cc_b"], "完了した案件は 3 年以内だけ (5 年前は出さない)");
  const a = o.open.find((c) => c.id === "inq_cc_a");
  eq([a.number, a.title, a.storeId, a.media, a.ownerId, a.canAdd, a.href], ["INQ-CC-A", "和室6畳 表替え", "koshi", "flyer", estimator.id, true, "/cases/inq_cc_a"], "案件の番号・工事内容・店舗・媒体・担当 (見積の担当者)・追加できる・案件の画面");
  ok(a.stageLabel && a.amount === 66000, "進み具合と金額");
  eq(o.open.find((c) => c.id === "o_cc_d").canAdd, false, "ほかの店舗の案件は店舗スタッフは追加できない");
  eq(CC.caseOptionsForCustomer(db(), koshiManager, "cust_cc1", today).open.find((c) => c.id === "o_cc_d").canAdd, true, "店長は全店舗の案件に追加できる (canEditCaseStore)");
  eq(CC.initialCaseChoice(o), "new", "進行中が 2 件なら新規案件のまま (人が選ぶ)");
  eq(CC.initialCaseChoice({ open: [a], past: [] }), "inq_cc_a", "進行中が 1 件だけならその案件を提案");
  eq(CC.initialCaseChoice(o, "o_cc_b"), "o_cc_b", "指定 (案件の画面から・前に選んだ) が候補にあればそれ");
  eq(CC.initialCaseChoice(o, "o_cc_d"), "new", "追加できない案件は選ばない");
  eq(CC.initialCaseChoice({ open: [a], past: [] }, "new"), "new", "前に新規案件を選んでいればそのまま");
  const bad = CC.caseForAdd(db(), koshiStaff, "o_cc_d");
  ok("error" in bad && bad.error.includes("追加できません"), "店舗スタッフがほかの店舗の案件に追加しようとすると断る");
  const viaOrder = CC.caseForAdd(db(), koshiStaff, "o_cc_a");
  eq([viaOrder.caseId, viaOrder.target?.id, viaOrder.media, viaOrder.category], ["inq_cc_a", "o_cc_a", "flyer", "tatami"], "記録の ID からも案件が決まる (受注 → 見積 → 問い合わせ)・連絡を残すのはいちばん進んだ記録 (受注)");
  eq(CC.caseForAdd(db(), koshiStaff, "q_cc_a", undefined, { record: true }).target?.id, "q_cc_a", "登録先で記録を選んだときはその記録に残す");
}

/* ================================================================== */
section("2. 問合せ登録: 案件に追加しても問い合わせを作る");
const newReception = async (user, text, extra = {}) => {
  const r = await act(user, () => RA.createReception(form({ source: "text", text, ...extra })));
  return r.path?.split("/").pop();
};
{
  // 案件の画面の「この案件に問い合わせを追加」から (caseId): お客様と案件が決まった状態
  const id = await newReception(koshiStaff, "案件一郎様から電話。090-8301-0001。引取の時間を午後にしてほしい", { caseId: "o_cc_a" });
  const doc = db().documents.find((d) => d.id === id);
  const meta = R.receptionMetaOf(doc);
  eq([meta.customerId, meta.reg.caseId, meta.channel], ["cust_cc1", "inq_cc_a", "phone"], "案件の画面から: お客様 = 案件のお客様・案件を選んだ状態・入口の初期値は電話");
  const before = db().inquiries.length;
  const notes = db().orders.find((o) => o.id === "o_cc_a").progressNotes.length;
  // 媒体を選ばなければ案件の媒体、担当者を選ばなければ案件の担当、担当店舗は案件の店舗
  const r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "inq_cc_a", summary: "引取の時間を午後に変更", storeId: "koshi", storeAuto: "1", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.sourceRef === `reception:${id}`);
  eq([r.err, r.path], [null, "/cases/inq_cc_a"], `案件に追加 → 案件の画面へ (${r.msg ?? r.err})`);
  ok(db().inquiries.length === before + 1 && inq?.caseId === "inq_cc_a" && inq.customerId === "cust_cc1", "問い合わせを 1 件作る (caseId = 案件)");
  eq([inq.media, inq.storeId, inq.assignedUserId, inq.status], ["flyer", "koshi", estimator.id, "new"], "媒体 = 案件の媒体・担当店舗 = 案件の店舗・担当者 = 案件の担当・状態は新規");
  ok(db().orders.find((o) => o.id === "o_cc_a").progressNotes.length === notes + 1, "受注の経過メモにも残す");
  const map = CG.buildCaseMap(db());
  eq(map.caseOf(inq.id), "inq_cc_a", "案件の記録に入る (case-group)");
  ok(CG.customerCaseSummaries(db(), "cust_cc1", today).open.find((c) => c.id === "inq_cc_a")?.counts.inquiries === 2, "案件の問い合わせが 2 件");
  ok(r.msg?.includes(inq.number) && r.msg.includes("INQ-CC-A"), "知らせに問い合わせ番号と案件番号");
}
{
  // 完了した案件へのクレーム・手直し (過去の案件を選んで紐付ける)
  const id = await newReception(koshiStaff, "案件一郎様から電話。090-8301-0001。去年張り替えた襖の引手が外れた");
  let r = await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_cc1", confirmedUncertain: "on" })));
  ok(!r.err && R.receptionMetaOf(db().documents.find((d) => d.id === id)).customerId === "cust_cc1", "お客様に紐付ける");
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "o_cc_b", summary: "襖の引手が外れた (手直し)", media: "repeat", storeId: "koshi", storeAuto: "1", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.sourceRef === `reception:${id}`);
  eq([r.err, r.path, inq?.caseId], [null, "/cases/o_cc_b", "o_cc_b"], "完了した案件を選んで問い合わせを追加 (クレーム・手直し)");
  ok(r.msg?.includes("完了した案件"), "知らせに「完了した案件」");
  ok(CG.customerCaseSummaries(db(), "cust_cc1", today).open.some((c) => c.id === "o_cc_b"), "対応中の問い合わせが入った完了の案件は、進行中に戻る");
}
{
  // ほかの店舗の案件・ほかのお客様の案件には追加しない。新規案件は caseId なし
  const id = await newReception(koshiStaff, "案件一郎様から電話。090-8301-0001。洋室のクロスの件");
  await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_cc1", confirmedUncertain: "on" })));
  let r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "o_cc_d", summary: "クロスの件", media: "repeat", confirmedUncertain: "on" })));
  ok(r.err?.includes("追加できません") && !db().inquiries.some((i) => i.sourceRef === `reception:${id}`), "店舗スタッフはほかの店舗の案件に追加できない (問い合わせも作らない)");
  eq(R.receptionMetaOf(db().documents.find((d) => d.id === id)).reg.caseId, "o_cc_d", "断っても選んだ値は残す (入力し直さない)");
  await store.mutate((d) => {
    d.orders.push({ id: "o_cc_x", number: "O-CC-X", customerId: "cust_cc2", storeId: "koshi", title: "別人の受注", status: "confirmed", category: "tatami", total: 1000, workerIds: [], progressNotes: [], contractDate: today, createdBy: koshiStaff.id, createdAt: nowIso, updatedAt: nowIso });
  });
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "o_cc_x", summary: "クロスの件", media: "repeat", confirmedUncertain: "on" })));
  ok(/紐付けたお客様の案件ではありません/.test(r.err ?? ""), "紐付けたお客様の案件でなければ断る");
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "new", summary: "洋室のクロスの張替え (新しいご依頼)", media: "repeat", storeId: "koshi", storeAuto: "1", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.sourceRef === `reception:${id}`);
  ok(!r.err && inq && !inq.caseId && r.path === `/inquiries/${inq.id}` && /新しい案件/.test(r.msg ?? ""), `新規案件として登録 (caseId なし) → 問い合わせの画面へ (${r.msg ?? r.err})`);
  eq(CG.caseIdOf(db(), inq.id), inq.id, "新しい問い合わせが新しい案件の始まり");
}

/* ================================================================== */
section("3. 媒体・担当店舗・担当者は 1 回だけ (紐付け・保存のあとも残す)");
{
  const id = await newReception(koshiStaff, "別人二郎様 090-8302-0002 網戸の張替え。ホームページを見た");
  // 確認の画面で選んでから「このお客様に紐付ける」
  let r = await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_cc2", media: "web", mediaPicked: "1", storeId: otherStore.id, storeAuto: "", assignedUserId: koshiManager.id, assigneePicked: "1", handoffSent: "1", confirmedUncertain: "on" })));
  let reg = R.receptionMetaOf(db().documents.find((d) => d.id === id)).reg;
  eq([r.err, reg.media, reg.storeId, reg.storeManual, reg.assigneeId, reg.handoff], [null, "web", otherStore.id, true, koshiManager.id, false], "紐付けたあとも選んだ媒体・担当店舗 (手で選んだ)・担当者・引き継ぎを残す");
  // 手で選んでいない値は残さない (開くたびに住所・案件から決め直す)
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "save", media: "flyer", mediaPicked: "", storeId: "koshi", storeAuto: "1", assignedUserId: koshiStaff.id, assigneePicked: "" })));
  reg = R.receptionMetaOf(db().documents.find((d) => d.id === id)).reg;
  eq([reg.media, reg.storeId, reg.storeManual, reg.assigneeId], [undefined, "koshi", false, undefined], "自動の値 (手で選んでいない媒体・担当者・住所から決めた店舗) は選んだ値として残さない");
  // 施工現場の住所の担当エリア (住所から自動。storeAuto = 1)
  r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "new", summary: "網戸の張替え", media: "web", storeId: "koshi", storeAuto: "1", siteAddress: "熊本県テスト市みほん町5-5", confirmedUncertain: "on" })));
  const inq = db().inquiries.find((i) => i.sourceRef === `reception:${id}`);
  eq([r.err, inq?.storeId, inq?.siteAddress], [null, otherStore.id, "熊本県テスト市みほん町5-5"], `担当店舗は施工現場の住所の担当エリア (${r.msg ?? r.err})`);
}
{
  // 手で選んだ店舗は住所で決め直さない
  const id = await newReception(koshiStaff, "別人二郎様 090-8302-0002 障子の張替え");
  await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_cc2", confirmedUncertain: "on" })));
  const r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", summary: "障子の張替え", media: "web", storeId: "koshi", storeAuto: "", siteAddress: "熊本県テスト市みほん町7-7", confirmedUncertain: "on" })));
  eq([r.err, db().inquiries.find((i) => i.sourceRef === `reception:${id}`)?.storeId], [null, "koshi"], "手で選んだ担当店舗はそのまま (住所の担当エリアより優先)");
}

/* ================================================================== */
section("4. 案件の予定の二重登録・「予定表で確認」");
{
  const id = await newReception(koshiStaff, "案件一郎様 090-8301-0001 引取の前に一度見てほしい");
  await act(koshiStaff, () => RA.registerReception(form({ id, quick: "link:cust_cc1", confirmedUncertain: "on" })));
  const appts = [
    { kind: "pickup", date: future(10), time: "", slot: "", text: "引取", register: true },
    { kind: "survey", date: future(5), time: "10:00", slot: "", text: "下見", register: true },
  ];
  const events = db().schedule.length;
  const r = await act(koshiStaff, () => RA.registerReception(form({ id, intent: "inquiry", caseId: "inq_cc_a", summary: "引取の前に下見", media: "flyer", storeId: "koshi", storeAuto: "1", appointments: JSON.stringify(appts), confirmedUncertain: "on" })));
  ok(!r.err && db().schedule.length === events + 1, `案件の受注の予定 (同じ日の引取) は登録せず、下見だけ登録 (${r.msg ?? r.err})`);
  ok(/同じ案件の予定/.test(r.msg ?? ""), "登録しなかった理由を知らせる");
  const link = `[[予定表で確認]](/schedule?view=week&date=${future(5)}&store=koshi)`;
  ok(r.msg?.endsWith(link), `知らせの最後に「予定表で確認」のリンク (${r.msg?.slice(-80)})`);
}

/* ================================================================== */
section("5. 手入力の問い合わせ (createInquiry)");
{
  const cases = await (async () => {
    globalThis.__testUser = koshiStaff;
    try {
      return await IA.loadCustomerCases("cust_cc1");
    } finally {
      globalThis.__testUser = undefined;
    }
  })();
  ok(cases?.open.some((c) => c.id === "inq_cc_a") && cases.past.length >= 0, "選んだお客様の案件を読む (loadCustomerCases)");
  const before = db().inquiries.length;
  let r = await act(koshiStaff, () => IA.createInquiry(form({ customerId: "cust_cc1", caseId: "inq_cc_a", channel: "phone", summary: "引取の日を確認したい", category: "tatami", storeId: "koshi", storeAuto: "1" })));
  const inq = db().inquiries.at(-1);
  eq([r.err, r.path, inq.caseId, inq.media, inq.storeId, db().inquiries.length], [null, "/cases/inq_cc_a", "inq_cc_a", "flyer", "koshi", before + 1], `既存の案件に問い合わせを追加 (媒体を選ばなければ案件の媒体) (${r.msg ?? r.err})`);
  r = await act(koshiStaff, () => IA.createInquiry(form({ contactName: "新規 三郎", contactPhone: "090-8303-0003", caseId: "inq_cc_a", channel: "phone", media: "web", summary: "x", category: "tatami" })));
  ok(r.err?.includes("お客様"), "新規のお客様を既存の案件には追加しない");
  r = await act(koshiStaff, () => IA.createInquiry(form({ customerId: "cust_cc1", caseId: "new", channel: "phone", summary: "新しいご依頼", category: "tatami", storeId: "koshi", storeAuto: "1" })));
  ok(r.err?.includes("媒体"), "新規案件は媒体が必須");
  r = await act(koshiStaff, () => IA.createInquiry(form({ customerId: "cust_cc1", caseId: "new", channel: "phone", media: "repeat", summary: "玄関の網戸", category: "amido", storeId: "koshi", storeAuto: "1", siteAddress: "熊本県テスト市みほん町3-3" })));
  const n = db().inquiries.at(-1);
  ok(!r.err && !n.caseId && n.storeId === otherStore.id && r.path === `/inquiries/${n.id}`, `新規案件: 担当店舗は施工現場の住所の担当エリア (${r.msg ?? r.err})`);
}

/* ================================================================== */
section("6. 既存の案件に追加 (mergeInquiryIntoCase)・付け替えで案件から外す");
{
  await store.mutate((d) => {
    d.inquiries.push({ id: "inq_cc_m", number: "INQ-CC-M", customerId: "cust_cc1", contactName: "案件 一郎", channel: "ai_chat", storeId: "koshi", category: "tatami", summary: "引き取りの日の確認", detail: "AI 相談: 引き取りの日を確認したい", status: "new", receivedAt: nowIso, createdBy: "system", updatedAt: nowIso });
    d.schedule.push({ id: "ev_cc_m", title: "確認の電話", kind: "visit", date: future(3), storeId: "koshi", assigneeIds: [koshiStaff.id], inquiryId: "inq_cc_m", customerId: "cust_cc1", source: "manual", createdBy: koshiStaff.id, createdAt: nowIso });
  });
  let r = await act(koshiStaff, () => IA.mergeInquiryIntoCase("inq_cc_m", form({ caseId: "inq_cc_m" })));
  ok(r.err?.includes("この問い合わせの案件"), "自分の案件には追加しない");
  r = await act(koshiStaff, () => IA.mergeInquiryIntoCase("inq_cc_m", form({ caseId: "inq_cc_a" })));
  const m = db().inquiries.find((i) => i.id === "inq_cc_m");
  eq([r.err, r.path, m.caseId, m.status], [null, "/cases/inq_cc_a", "inq_cc_a", "in_progress"], "問い合わせは消さず (完了にせず) 案件の問い合わせにする");
  const ev = db().schedule.find((e) => e.id === "ev_cc_m");
  eq([ev.orderId, ev.quoteId, ev.inquiryId], ["o_cc_a", "q_cc_a", "inq_cc_m"], "予定は案件の受注・見積の予定にもする (問い合わせのつながりは残す)");
  ok(db().commLogs.some((c) => c.relatedType === "order" && c.relatedId === "o_cc_a" && c.subject.includes("INQ-CC-M")), "内容は案件のやりとりに残す");
  // 付け替え: ほかのお客様にすると案件から外す
  r = await act(koshiStaff, () => IA.linkInquiryToCustomer("inq_cc_m", "cust_cc2", undefined, "inquiry"));
  const moved = db().inquiries.find((i) => i.id === "inq_cc_m");
  ok(!r.err && moved.customerId === "cust_cc2" && !moved.caseId && /案件 INQ-CC-A/.test(r.msg ?? ""), `ほかのお客様に付け替えると、前のお客様の案件から外す (${r.msg ?? r.err})`);
  ok(db().auditLogs.some((l) => l.entity === "inquiry" && l.entityId === "inq_cc_m" && (l.changes ?? []).some((c) => c.field === "caseId" && c.after === null)), "変更履歴に案件から外したことを残す");
  // 問い合わせから始まった案件にほかの記録があれば、別の案件には追加しない
  r = await act(koshiManager, () => IA.mergeInquiryIntoCase("inq_cc_a", form({ caseId: "o_cc_d" })));
  ok(r.err, "見積・受注のある問い合わせ (案件の最初の記録) は別の案件に追加しない");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
