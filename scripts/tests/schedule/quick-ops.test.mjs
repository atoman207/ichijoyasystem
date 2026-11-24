/**
 * お客様のご要望 2026-11-24 (実際の操作の確認のなかで気づいた点 ①〜⑨) のテスト
 *   node scripts/tests/schedule/quick-ops.test.mjs   (npm run test:schedule)
 * ① 見積の消費税: 内税 (標準)・外税・非課税 (src/lib/quote-calc.ts・actions/quotes.ts・PDF)
 * ③ 住所からの担当店舗 (src/lib/store-area.ts。営業エリア = 管理会計の salesAreas)
 * ④ 本部の社員は全店舗の担当者の選択肢 (src/lib/staff-choices.ts)
 * ⑥ 予定表の担当者の略称・小さな画面での担当者の変更 (schedule-sheet/initials.ts の initialsByUser・quickUpdateScheduleEvent)
 * ⑦ 引取・現見 ⇄ 納品の組と「納品予定を追加」(src/lib/schedule-pair.ts・addPairedDelivery)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)。地域・人の名前は架空のもの
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-quick-ops-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "quick-ops-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-quick-ops",
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

const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const manager = db().users.find((u) => u.active && u.role === "store_manager" && u.storeId !== "hq");
const staffUser = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === manager.storeId);
const other = db().stores.find((s) => s.kind === "store" && s.id !== manager.storeId);
const third = db().stores.find((s) => s.kind === "store" && s.id !== manager.storeId && s.id !== other.id);

/* ================================================================== */
section("① 見積の消費税 (内税・外税・非課税)");
const QC = await imp("lib/quote-calc.ts");
const items = [{ amount: 10000 }, { amount: 5000 }];
eq(QC.quoteTotals(items, 1000, "included"), { subtotal: 15000, discount: 1000, tax: 1272, total: 14000 }, "内税: 合計 = 小計 − 値引き、消費税は内税 (10/110)");
eq(QC.quoteTotals(items, 1000, "excluded"), { subtotal: 15000, discount: 1000, tax: 1400, total: 15400 }, "外税: 合計に 10% を足す");
eq(QC.quoteTotals(items, 1000, "exempt"), { subtotal: 15000, discount: 1000, tax: 0, total: 14000 }, "非課税: 消費税 0");
eq([QC.quoteTotals(items, 0, true).total, QC.quoteTotals(items, 0, false).total], [15000, 16500], "以前の書き方 (true = 内税 / false = 外税) もそのまま");
eq([QC.parseTaxMode({ taxMode: "exempt" }), QC.parseTaxMode({ taxIncluded: "1" }), QC.parseTaxMode({}), QC.taxModeOf({ taxIncluded: true, taxExempt: true }), QC.taxModeOf({})], ["exempt", "included", "excluded", "exempt", "excluded"], "フォームと記録の税の書き方");
eq([QC.taxFields("included"), QC.taxFields("exempt"), QC.taxFields("excluded")], [{ taxIncluded: true }, { taxExempt: true }, {}], "記録に書く値");
const QA = await imp("lib/actions/quotes.ts");
const lines = JSON.stringify([{ name: "畳 表替え", spec: "", qty: 6, unit: "畳", unitPrice: 11000 }]);
const cust = db().customers.find((c) => c.storeId === manager.storeId);
let r = await act(admin, () => QA.createQuote(form({ customerId: cust.id, title: "業者様の見積", items: lines, discount: 0, taxMode: "exempt", intent: "draft", category: "tatami", storeId: manager.storeId })));
const draft = db().quotes.at(-1);
let q = draft;
eq([r.err, q.taxExempt, q.taxIncluded, q.tax, q.total], [null, true, undefined, 0, 66000], "非課税の見積を保存: 消費税 0・合計 = 明細の合計");
const PD = await imp("lib/pdf/data.ts");
eq(PD.quotePdfData(db(), q)?.taxExempt, true, "見積書の PDF も非課税");
r = await act(admin, () => QA.updateQuote(draft.id, form({ items: lines, discount: 0, taxMode: "included", intent: "draft", title: draft.title })));
q = db().quotes.find((x) => x.id === draft.id);
eq([q.taxExempt, q.taxIncluded, q.tax, q.total], [undefined, true, 6000, 66000], "内税に戻す: 消費税は内税");

/* ================================================================== */
section("③ 住所からの担当店舗");
const SA = await imp("lib/store-area.ts");
const A = await imp("lib/mgmt/areas.ts");
const day = "2026-01-01";
await store.mutate((x) => {
  x.salesAreas.push(
    { id: "sa_t1", municipality: "", town: "テスト郡", storeId: other.id, validFrom: day, source: "manual", createdBy: admin.id, createdAt: day },
    { id: "sa_t2", municipality: "", town: "見本市", storeId: third.id, validFrom: day, source: "import", createdBy: admin.id, createdAt: day },
    { id: "sa_t3", municipality: "", town: "見本市北区かがみ町", storeId: other.id, validFrom: day, source: "manual", createdBy: admin.id, createdAt: day },
  );
});
eq(SA.areaStoreOf(db(), "熊本県テスト郡ためし町1-2")?.storeId, other.id, "地域一覧にない地域 (郡) で担当店舗が決まる");
eq(SA.areaStoreOf(db(), "見本市中央区2-3")?.storeId, third.id, "市の名前で決まる");
eq(SA.areaStoreOf(db(), "熊本県見本市北区かがみ町5")?.storeId, other.id, "長く一致した地域 (区・町名) を優先");
eq([SA.areaStoreOf(db(), "どこか県どこか町"), SA.areaStoreOf(db(), "")], [undefined, undefined], "当たらない・空の住所は決めない");
await store.mutate((x) => {
  const row = (id, town, storeId) => ({ id, municipality: "", town, storeId, validFrom: day, source: "manual", createdBy: admin.id, createdAt: day });
  x.salesAreas.push(row("sa_t4", "ためし", other.id), row("sa_t5", "岡辺町", third.id), row("sa_t6", "みほん村", other.id), row("sa_t7", "みほん", third.id), row("sa_t8", "椿", other.id));
});
eq(SA.areaStoreOf(db(), "熊本県ためし市七城町岡辺1")?.storeId, other.id, "市の名前 (住所の頭) を、あとの町名 (ほかの店舗の町) より優先");
eq([SA.areaStoreOf(db(), "熊本県阿蘇郡みほん村2")?.storeId, SA.areaStoreOf(db(), "熊本市東区みほん1丁目")?.storeId], [other.id, third.id], "「○○村」と町名「○○」: 名前のまま当たった方");
eq([SA.areaStoreOf(db(), "熊本市北区椿5丁目")?.storeId, SA.areaStoreOf(db(), "熊本市北区大椿町")], [other.id, undefined], "1 文字の町名は市区のすぐあとだけ");
const pickA = SA.newCaseStore(db(), staffUser, { auto: true, address: "テスト郡ためし町1", requested: staffUser.storeId });
eq([pickA.storeId, pickA.byArea], [other.id, true], "店舗スタッフでも、住所の担当エリアの店舗にできる (自動)");
eq(SA.newCaseStore(db(), staffUser, { auto: false, address: "テスト郡ためし町1", requested: staffUser.storeId }).storeId, staffUser.storeId, "手で選んだ自店舗はそのまま");
eq(SA.newCaseStore(db(), staffUser, { auto: false, address: "テスト郡ためし町1", requested: third.id }).storeId, other.id, "店舗スタッフは担当エリア・自店舗以外を選べない (担当エリアにする)");
eq(SA.newCaseStore(db(), admin, { auto: false, address: "テスト郡ためし町1", requested: third.id }).storeId, third.id, "全店舗のロールは手で選んだ店舗");
eq(SA.newCaseStore(db(), staffUser, { auto: true, address: "どこか町" }).storeId, staffUser.storeId, "決まらないときは自店舗");
const IA = await imp("lib/actions/inquiries.ts");
r = await act(staffUser, () => IA.createInquiry(form({ contactName: "見本 次郎", contactPhone: "090-0000-1111", channel: "phone", media: "unknown", summary: "畳の表替え", address: "熊本県テスト郡ためし町3-4", storeId: staffUser.storeId, storeAuto: "1", category: "tatami" })));
const inq = db().inquiries.at(-1);
eq([r.err, inq.storeId, inq.intake?.address], [null, other.id, "熊本県テスト郡ためし町3-4"], "問い合わせの登録: 住所の担当エリアの店舗・住所を残す");
ok(/担当にしました/.test(r.msg ?? ""), `登録の知らせに担当店舗 (${r.msg})`);
// 地域一覧の取り込み直しで、手で足した地域は残す
const plan = A.planAreaImport(db(), [{ store: third.name, town: "べつの町", ref: "2行目" }]);
await store.mutate((x) => A.applyAreaImport(x, plan, "2026-06-01", admin.id, "2026-06-01T00:00:00Z", () => store.newId("sa"), "テスト"));
const openOn = (id) => db().salesAreas.find((a) => a.id === id && (!a.validTo || a.validTo >= "2026-06-01"));
eq([Boolean(openOn("sa_t1")), Boolean(openOn("sa_t2")), Boolean(openOn("sa_t3"))], [true, false, true], "地域一覧を取り込み直しても、手で足した地域 (郡・市など) は残す");

/* ================================================================== */
section("④ 本部の社員は全店舗の担当者の選択肢");
const SC = await imp("lib/staff-choices.ts");
const hqUser = db().users.find((u) => u.active && u.storeId === "hq");
const list = SC.staffForStore(db(), manager.storeId);
ok(hqUser && SC.isCommonStaff(db(), hqUser) && !SC.isCommonStaff(db(), manager), "本部の社員 = 全店舗共通");
ok(list.some((u) => u.id === hqUser.id) && list.filter((u) => u.storeId === manager.storeId).length > 0 && list[0].storeId === manager.storeId, "店舗の選択肢: 店舗の社員が先、本部の社員も出る");
ok(!list.some((u) => u.storeId === other.id), "ほかの店舗の社員は出さない (今の担当を除く)");
const otherMember = db().users.find((u) => u.active && u.storeId === other.id);
ok(SC.staffForStore(db(), manager.storeId, [otherMember.id]).some((u) => u.id === otherMember.id), "今の担当 (ほかの店舗) は残す");

/* ================================================================== */
section("⑥ 予定表の担当者の略称");
const IN = await imp("lib/schedule-sheet/initials.ts");
const people = [
  { id: "a", name: "山田 太郎", storeId: "s1", active: true, title: "施工" },
  { id: "b", name: "山本 花子", storeId: "s1", active: true, title: "営業" },
  { id: "c", name: "佐藤 一郎", storeId: "s2", active: true, title: "代表取締役 社長" },
  { id: "d", name: "鈴木", storeId: "s2", active: true, title: "施工" },
];
const ini = IN.initialsByUser(people);
eq(["a", "b", "c", "d"].map((k) => ini.get(k)), ["太", "花", "社", "鈴"], "名字の 1 文字目が重なる人は名前の 1 文字目・社長は「社」");
const find = IN.staffInitials(people);
ok(["a", "b", "c", "d"].every((k) => find(ini.get(k)).userId === k), "略称から同じ人に戻る (予定表のスプレッドシートの書き方と同じ)");

/* ================================================================== */
section("⑦ 引取・現見 ⇄ 納品 と「納品予定を追加」");
const SP = await imp("lib/schedule-pair.ts");
const SAct = await imp("lib/actions/schedule.ts");
const member = db().users.find((u) => u.active && u.storeId === inq.storeId);
let pickupId = "";
await store.mutate((x) => {
  pickupId = store.newId("ev");
  x.schedule.push({ id: pickupId, title: "見本 次郎 様 引き取り", kind: "pickup", date: "2031-04-10", slot: "am", storeId: inq.storeId, assigneeIds: [member.id], inquiryId: inq.id, source: "manual", createdBy: admin.id, createdAt: "2031-01-01T00:00:00Z" });
});
let pk = db().schedule.find((e) => e.id === pickupId);
let info = SP.eventPair(db(), pk);
eq([info.want, info.events.length], ["delivery", 0], "引取の予定: 納品を探す (まだない)");
eq(SP.pairRole("onsite_quote"), "delivery", "現見 (現場見積) も納品がセット");
eq([SP.pairRole("delivery"), SP.pairRole("survey")], ["origin", undefined], "納品は引取・現見を探す・見積は組なし");
r = await act(admin, () => SAct.addPairedDelivery(pickupId, form({ returnTo: "/schedule?view=week", date: "2031-04-12", timeMode: "pm", assigneeIds: [member.id, hqUser.id], memo: "2 階の和室" })));
const dv = db().schedule.find((e) => e.sourceRef === `pair:${pickupId}`);
eq([r.err, r.path, dv?.kind, dv?.date, dv?.slot, dv?.inquiryId, dv?.storeId, dv?.assigneeIds], [null, "/schedule", "delivery", "2031-04-12", "pm", inq.id, inq.storeId, [member.id, hqUser.id]], `納品予定を追加: 同じ案件・店舗の納品の予定 (${r.msg})`);
info = SP.eventPair(db(), pk);
eq(info.events.map((e) => e.id), [dv.id], "引取の予定から納品が見える");
eq(SP.eventPair(db(), dv).events.map((e) => e.id), [pickupId], "納品の予定から引取が見える");
r = await act(admin, () => SAct.addPairedDelivery(pickupId, form({ returnTo: "/schedule", date: "2031-04-13", timeMode: "allday", assigneeIds: [member.id] })));
ok(r.err && /もう納品の予定があります/.test(r.err), "納品の予定があるときは二重に足さない");
// 同じ案件 (問い合わせ) の別の予定 (移行した予定表の納品など) も組になる
let importedDv = "";
await store.mutate((x) => {
  importedDv = store.newId("ev");
  x.schedule.push({ id: importedDv, title: "見本 次郎 様", kind: "delivery", date: "2031-04-20", storeId: inq.storeId, assigneeIds: [member.id], inquiryId: inq.id, source: "import", createdBy: admin.id, createdAt: "2031-01-01T00:00:00Z" });
});
eq(SP.eventPair(db(), db().schedule.find((e) => e.id === pickupId)).events.map((e) => e.id), [dv.id, importedDv], "同じ案件の納品も出す (追加した納品が先)");

// 受注の引取・納品の日程と連動する引取: 納品日の決まっていない品目に納品日を入れる
const HE = await imp("lib/db/handover-events.ts");
const ord = db().orders.find((o) => ["confirmed", "scheduled"].includes(o.status) && !o.handovers?.length);
await store.mutate((x) => {
  const o = x.orders.find((y) => y.id === ord.id);
  o.handovers = [{ id: "hv_test1", item: "fusuma", label: "襖 張替え 4枚", pickupDate: "2031-05-01", pickupSlot: "am" }];
  HE.syncHandoverEvents(x, o, admin.id);
});
const hvPick = db().schedule.find((e) => e.orderId === ord.id && e.sourceRef === "handover:pickup:hv_test1");
info = SP.eventPair(db(), hvPick);
eq([Boolean(hvPick), info.undatedRows, info.order?.id], [true, ["hv_test1"], ord.id], "受注の引取の予定: 納品日の決まっていない品目");
const worker = db().users.find((u) => u.active && u.storeId === ord.storeId);
r = await act(admin, () => SAct.addPairedDelivery(hvPick.id, form({ returnTo: "/schedule", date: "2031-05-08", timeMode: "time", startTime: "13:00", endTime: "15:00", assigneeIds: [worker.id] })));
const o2 = db().orders.find((o) => o.id === ord.id);
const hvDel = db().schedule.find((e) => e.orderId === ord.id && e.sourceRef === "handover:delivery:hv_test1");
eq([r.err, o2.handovers[0].deliveryDate, o2.handovers[0].deliveryStart, hvDel?.date, hvDel?.startTime, hvDel?.assigneeIds], [null, "2031-05-08", "13:00", "2031-05-08", "13:00", [worker.id]], `受注の日程に納品日を入れ、納品の予定を作る (担当は選んだ人。${r.msg ?? r.err})`);
eq(SP.eventPair(db(), db().schedule.find((e) => e.id === hvPick.id)).events.map((e) => e.id), [hvDel.id], "同じ品目の納品と組になる");
// 予定表から足した納品は、あとで受注の日程を保存すると使い回す (二重にしない)
await store.mutate((x) => {
  const qid = x.orders.find((o) => o.id === ord.id).quoteId;
  const qq = x.quotes.find((y) => y.id === qid);
  if (qq) qq.inquiryId = inq.id;
  const o = x.orders.find((y) => y.id === ord.id);
  o.handovers = [...o.handovers, { id: "hv_test2", item: "tatami_omote", label: "畳 表替え 6枚", pickupDate: "2031-04-10", deliveryDate: "2031-04-12", deliverySlot: "pm" }];
  HE.syncHandoverEvents(x, o, admin.id);
});
const adopted = db().schedule.find((e) => e.id === dv.id);
eq([adopted?.source, adopted?.sourceRef], ["order", "handover:delivery:hv_test2"], "予定表から足した納品は受注の日程の納品の予定として使い回す");

// 小さな画面の担当者の変更 (最大 4 名・ほかの店舗の社員も)
const ev = db().schedule.find((e) => e.id === pickupId);
const helper = db().users.find((u) => u.active && u.storeId === third.id);
r = await act(admin, () => SAct.quickUpdateScheduleEvent(ev.id, form({ returnTo: "/schedule?_r=x", assigneesSent: "1", assigneeIds: [member.id, helper.id, hqUser.id], allowOverlap: "1" })));
eq([r.err, db().schedule.find((e) => e.id === ev.id).assigneeIds], [null, [member.id, helper.id, hqUser.id]], `小さな画面で担当者を変える (ほかの店舗・本部の社員も。${r.msg ?? r.err})`);
r = await act(admin, () => SAct.quickUpdateScheduleEvent(ev.id, form({ returnTo: "/schedule?_r=y", title: "見本 次郎 様 引き取り (変更)" })));
eq([db().schedule.find((e) => e.id === ev.id).assigneeIds.length, db().schedule.find((e) => e.id === ev.id).title], [3, "見本 次郎 様 引き取り (変更)"], "担当者を送らない保存では担当者は変わらない");

// 予定表の小さな画面のデータ (地図・担当者の選択肢・納品)
const route = await imp("app/api/schedule/events/[id]/route.ts");
globalThis.__testUser = admin;
const res = await route.GET(new Request("http://test.local/api/schedule/events/x"), { params: Promise.resolve({ id: pickupId }) });
globalThis.__testUser = undefined;
const data = await res.json();
eq([res.status, data.pair?.want, data.pair?.events.length > 0, data.staff[0].group, data.staff.some((s) => s.group === "common"), typeof data.map], [200, "delivery", true, "store", true, "object"], "小さな画面: 地図・担当者の選択肢 (予定の店舗が先・本部)・納品の予定");

/* ================================================================== */
section("問合せ登録の紐付け候補 (住所 → 電話 → 名字。ほかの店舗のお客様も)");
const CM = await imp("lib/customer-match.ts");
eq(
  [
    CM.addressMatch("見本町台33", "熊本県見本郡見本町台33"),
    CM.addressMatch("北区ためし万石5丁目9-17", "熊本市北区ためし万石5-9-17"),
    CM.addressMatch("熊本市ためし町岩野123の4", "熊本市北区ためし町岩野123-4"),
    CM.addressMatch("みほん台2127", "見本市みほん台2127-120"),
    CM.addressMatch("白見本2-3-81 ハイム見本1409", "熊本市南区白見本2丁目3-81 ハイム見本 1201号"),
    CM.addressMatch("白見本2-3-81 ハイム見本1409", "熊本市南区白見本2丁目3-81 ハイム見本1409号"),
    CM.addressMatch("みほん台2127", "見本市みほん台3000"),
    CM.addressMatch("みほん台2", "見本市みほん台2-1-5"),
    CM.addressMatch("ためし町1", "見本町1"),
  ],
  ["exact", "exact", "exact", "partial", "building", "exact", "town", "town", undefined],
  "住所の一致: 県・郡・市・区の省略・「の」・号の省略・同じ建物のほかの部屋・町名だけ",
);
eq(
  [
    CM.nameMatch({ name: "見本" }, { name: "見本 一郎", kana: "" }),
    CM.nameMatch({ name: "見本一郎" }, { name: "見本 一郎", kana: "" }),
    CM.nameMatch({ name: "見本 次郎様" }, { name: "見本 一郎", kana: "" }),
    CM.nameMatch({ name: "ミホン" }, { name: "見本 一郎", kana: "ミホン イチロウ" }),
    CM.nameMatch({ name: "みほん いちろう" }, { name: "見本 一郎", kana: "ミホン イチロウ" }),
    CM.nameMatch({ name: "林田" }, { name: "林", kana: "" }),
    CM.nameMatch({ name: "林" }, { name: "林", kana: "" }),
    CM.nameMatch({ name: "見本" }, { name: "試験 花子", kana: "" }),
  ],
  ["surname", "full", "surname", "surname", "full", undefined, "full", undefined],
  "名字の一致: 空白なし・敬称・かな (ふりがな)・1 文字の名字",
);
const RC = await imp("lib/reception.ts");
const far = db().stores.find((x) => x.kind === "store" && x.id !== staffUser.storeId);
const mkCust = (id, name, address, extra = {}) => ({ id, code: id.toUpperCase(), name, kana: "", type: "individual", phone: "", postalCode: "", address, storeId: far.id, tags: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra });
await store.mutate((x) => {
  x.customers.push(
    mkCust("cm_a", "見本 一郎", "熊本県見本郡見本町台33", { kana: "ミホン イチロウ" }),
    mkCust("cm_b", "見本", "", { area: "見本町" }),
    mkCust("cm_c", "試験 花子", "熊本県見本郡見本町台500"),
    mkCust("cm_d", "見本 二郎", "熊本県見本郡見本町台200"),
    mkCust("cm_e", "電話 太郎", "熊本県ほか市ほか町1", { phone: "090-1111-2222" }),
  );
});
const fields = (o) => ({ ...RC.receptionFieldsOf({ extracted: {} }), ...o });
let mr = RC.matchReception(db(), staffUser, fields({ customerName: "見本", address: "見本町台33", phone: "090-1111-2222" }));
eq(mr.customers.map((c) => `${c.level}:${c.customer.id}`).filter((x) => x.includes("cm_")), ["address:cm_a", "phone:cm_e", "name:cm_b", "name:cm_d"], "① 住所 → ② 電話 → ③ 名字 (お名前のまま一致・同じ町の方が先)。町名だけ同じほかの名字のお宅は出さない");
ok(/住所が一致・名字も一致/.test(mr.customers[0].reason) && mr.suggestion.customerId === "cm_a", `住所が一致するお客様を選んだ状態 (${mr.customers[0].reason})`);
ok(far.id !== staffUser.storeId, "ほかの店舗のお客様も候補に出る (顧客の一覧で見られるお客様)");
mr = RC.matchReception(db(), staffUser, fields({ customerName: "ミホン", address: "" }));
ok(mr.customers.some((c) => c.customer.id === "cm_a" && c.level === "name"), "かなのお名前はふりがなと比べる");
const LS = await imp("lib/link-search.ts");
eq(LS.searchCustomers(db(), staffUser, "北区見本町台33")[0]?.id ?? LS.searchCustomers(db(), staffUser, "見本町台33")[0]?.id, "cm_a", "検索: 住所 (県・郡の書き方が違っても) でほかの店舗のお客様も探せる");
const RAct = await imp("lib/actions/reception.ts");
r = await act(staffUser, () => RAct.createReception(form({ source: "text", channel: "phone", storeId: staffUser.storeId, text: "見本様より電話。見本町台33。畳の表替え。" })));
const rdoc = db().documents.filter((x) => x.kind === "reception").at(-1);
r = await act(staffUser, () => RAct.registerReception(form({ id: rdoc.id, quick: "inquiry:cm_a", media: "repeat", confirmedUncertain: "on" })));
const linked = db().inquiries.at(-1);
eq([r.err, linked.customerId], [null, "cm_a"], `ほかの店舗のお客様にワンタッチで紐付けて登録 (${r.msg ?? r.err})`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
