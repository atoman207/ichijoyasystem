/**
 * お客様のご要望 2026-11-24 (予定表・問い合わせ・顧客の操作) のテスト
 *   node scripts/tests/schedule/schedule-customer.test.mjs   (npm run test:schedule)
 * 1. 予定表の件名「（町名）お客様」: 町名の取り出し・業者の案件は現場の住所・移行した予定表の地区 (src/lib/schedule-label.ts。■1)
 * 2. 問い合わせを既存の顧客にひも付けたあとは、予定にひも付けた顧客のお名前・情報 (■3)
 * 3. 問い合わせ ⇄ 既存の顧客のひも付け・付け替え・予定表の仮の顧客の削除 (src/lib/customer-link.ts・actions/inquiries.ts。■3 ■5 ■6)
 * 4. 検索: 既存の顧客・ひも付けられる問い合わせ・一覧の電話と住所 (src/lib/link-search.ts。■5 ■6)
 * 5. 予定表の上での変更 (日時・内容・種類。actions/schedule.ts の quickUpdateScheduleEvent。■4)
 * 6. 顧客の画面から取り込んだ受付 (お客様が決まっている。■6 の追記)
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-schedule-customer-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "schedule-customer-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-schedule-customer",
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

/* ================================================================== */
section("1. 予定表の件名「（町名）お客様」");
const L = await imp("lib/schedule-label.ts");
eq(
  ["熊本市中央区坪井5丁目2-27", "合志市須屋1234-5", "菊池郡菊陽町曲手100", "玉名市下1984", "熊本市北区植木町岩野10", "玉名郡長洲町梅田263-3", "合志市福原100-1", "築地", "", "熊本市東区保田窪5丁目25-6 サンハイツ101"].map(L.shortTown),
  ["坪井", "須屋", "菊陽町曲手", "玉名市下", "植木町岩野", "長洲町梅田", "福原", "築地", "", "保田窪"],
  "住所 → 町名 (市・区を外す。町・村はそのまま。町名が 1 文字なら市を付ける・建物名は入れない)",
);
eq([L.splitAreaTitle("(清水万石) 田中"), L.splitAreaTitle("（築地）村田"), L.splitAreaTitle("村田 様")], [{ area: "清水万石", rest: "田中" }, { area: "築地", rest: "村田" }, { rest: "村田 様" }], "件名の頭の地区 (半角・全角の括弧)");
const ind = { type: "individual", address: "合志市須屋1234-5", area: "須屋" };
const corp = { type: "corporate", address: "熊本市中央区水前寺1丁目2-3", area: "" };
eq(
  [
    L.eventTown({ customer: ind }),
    L.eventTown({ customer: ind, siteAddress: "合志市御代志100" }),
    L.eventTown({ customer: ind, location: "合志市須屋1234-5", siteAddress: "合志市御代志100" }),
    L.eventTown({ customer: ind, location: "菊池市隈府50" }),
  ],
  ["須屋", "御代志", "御代志", "隈府"],
  "個人: この予定だけの場所 → 施工場所 → お客様の住所 (予定の場所がお客様の住所のままなら施工場所)",
);
eq(
  [
    L.eventTown({ customer: corp }),
    L.eventTown({ customer: corp, location: "熊本市中央区水前寺1丁目2-3" }),
    L.eventTown({ customer: corp, siteAddress: "熊本市東区築地1-2" }),
    L.eventTown({ customer: corp, location: "熊本市中央区水前寺1丁目2-3", inquiryAddress: "熊本市南区城南町宮地5" }),
  ],
  ["", "", "築地", "城南町宮地"],
  "業者 (法人) の案件は、業者自身の住所ではなく現場の住所 (施工場所・問い合わせで聞いた住所) の町名。現場が分からなければ空",
);
eq([L.withCustomerName("ヤマダ 様", "山田 太郎", ["ヤマダ"]), L.withCustomerName("山田 太郎 様", "山田 太郎", ["ヤマダ"]), L.withCustomerName("会議", "山田 太郎", ["ヤマダ"])], ["山田 太郎 様", "山田 太郎 様", "会議"], "受付のお名前で始まる件名だけ、ひも付けた顧客のお名前にする");

const lab = L.eventLabeler({
  customers: [
    { id: "c1", name: "山田 太郎", kana: "", type: "individual", address: "合志市福原100-1", area: "福原", tags: [] },
    { id: "c2", name: "株式会社サンプル工務店", kana: "", type: "corporate", address: "熊本市中央区水前寺1丁目2-3", tags: [] },
  ],
  inquiries: [{ id: "i1", number: "INQ-1", customerId: "c1", contactName: "ヤマダ", intake: { name: "ヤマダ", address: "合志市福原100-1" } }],
  quotes: [{ id: "q2", customerId: "c2", siteAddress: "熊本市東区築地1-2", inquiryId: undefined }],
  orders: [],
});
eq(lab.label({ title: "ヤマダ 様 見積り (現地調査)", kind: "survey", inquiryId: "i1", location: "合志市福原100-1" }).text, "（福原）山田 太郎 様", "問い合わせ (ヤマダ) を既存の顧客 (山田 太郎) にひも付けたあとは、顧客のお名前と町名");
eq(lab.label({ title: "株式会社サンプル工務店 様 現地調査", kind: "survey", quoteId: "q2", customerId: "c2", location: "熊本市中央区水前寺1丁目2-3" }).text, "（築地）株式会社サンプル工務店 様", "業者の案件は見積の施工場所の町名 (業者の住所の水前寺ではない)");
eq(lab.label({ title: "株式会社サンプル工務店 様 打合せ", kind: "visit", customerId: "c2", location: "熊本市中央区水前寺1丁目2-3" }).area, undefined, "業者の案件で現場が分からなければ町名を出さない (業者の住所は出さない)");
eq(lab.label({ title: "(清水万石) 田中 引き取り", kind: "pickup" }).text, "（清水万石）田中", "移行した予定表の地区はそのまま (括弧をそろえる)");
eq(lab.label({ title: "[仮 第2候補] 山田 様 採寸", kind: "measure", inquiryId: "i1" }).text, "[仮 第2候補] （福原）山田 様", "仮押さえの印は先頭のまま");
eq(lab.customerOf({ inquiryId: "i1", customerId: "c_old" })?.id, "c1", "予定のお客様は案件から引く (予定に残った前の顧客より、問い合わせのいまの顧客)");

/* ================================================================== */
section("2〜3. 問い合わせ ⇄ 既存の顧客のひも付け");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const fmt = await imp("lib/format.ts");
const today = fmt.toDateKey(new Date());
const d = (n) => fmt.addDays(today, n);
const admin = db().users.find((u) => u.active && u.role === "admin");
const staff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const other = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId !== "koshi" && u.storeId !== "hq");
const nowIso = new Date().toISOString();
const real = db().customers.find((c) => c.storeId === "koshi" && c.type === "individual" && c.phone && c.address);
await store.mutate((x) => {
  x.customers.push({ id: "c_ph", code: "T-PH", name: "山田", kana: "", type: "individual", phone: "", postalCode: "", address: "福原", area: "福原", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "unknown", tags: ["予定表から登録"], notes: "", createdAt: nowIso, updatedAt: nowIso });
  x.inquiries.push(
    { id: "inq_free", number: "INQ-T-1", contactName: "ヤマダ", contactPhone: real.phone, channel: "phone", storeId: "koshi", category: "amido", summary: "網戸の張り替え", detail: "", status: "in_progress", receivedAt: nowIso, createdBy: staff.id, updatedAt: nowIso, intake: { name: "ヤマダ", phone: real.phone, address: "合志市福原100-1" } },
    { id: "inq_ph", number: "INQ-T-2", customerId: "c_ph", contactName: "山田", channel: "phone", storeId: "koshi", category: "tatami", summary: "畳 表替え6", detail: "", status: "in_progress", receivedAt: nowIso, createdBy: staff.id, updatedAt: nowIso, area: "福原", source: "import", sourceRef: "sheet:case:test" },
    { id: "inq_quoted", number: "INQ-T-3", contactName: "見積済", channel: "phone", storeId: "koshi", category: "tatami", summary: "見積済み", detail: "", status: "quoted", receivedAt: nowIso, createdBy: staff.id, updatedAt: nowIso, quoteId: x.quotes.find((q) => q.storeId === "koshi").id },
  );
  x.schedule.push(
    { id: "ev_free", title: "ヤマダ 様 見積り (現地調査)", kind: "survey", date: d(3), slot: "am", storeId: "koshi", assigneeIds: [staff.id], inquiryId: "inq_free", location: "合志市福原100-1", source: "manual", createdBy: staff.id, createdAt: nowIso },
    { id: "ev_ph", title: "(福原) 山田 引き取り", kind: "pickup", date: d(4), storeId: "koshi", assigneeIds: [staff.id], inquiryId: "inq_ph", customerId: "c_ph", location: "福原", source: "import", sourceRef: "sheet:2026-12-01|hagi|(福原)山田", createdBy: "system", createdAt: nowIso },
  );
});
const A = await imp("lib/actions/inquiries.ts");
let r = await act(staff, () => A.linkInquiryFromForm(form({ inquiryId: "inq_free", customerId: real.id, returnTo: "/inquiries/inq_free" })));
eq([r.err, r.path, db().inquiries.find((i) => i.id === "inq_free").customerId, db().schedule.find((e) => e.id === "ev_free").customerId], [null, "/inquiries/inq_free", real.id, real.id], "未登録の問い合わせを既存の顧客に紐づける → 予定もそのお客様に");
const L2 = await imp("lib/schedule-label.ts");
ok(L2.eventLabeler(db()).label(db().schedule.find((e) => e.id === "ev_free")).text.includes(real.name), `予定表の件名がひも付けた顧客のお名前 (${L2.eventLabeler(db()).label(db().schedule.find((e) => e.id === "ev_free")).text})`);
ok(db().commLogs.some((c) => c.relatedId === "inq_free" && c.customerId === real.id), "問い合わせのやりとりの記録もお客様の履歴に");

r = await act(staff, () => A.linkInquiryFromForm(form({ inquiryId: "inq_ph", customerId: real.id, returnTo: `/customers/${real.id}` })));
eq([r.err, r.path, db().inquiries.find((i) => i.id === "inq_ph").customerId, db().schedule.find((e) => e.id === "ev_ph").customerId], [null, `/customers/${real.id}`, real.id, real.id], "顧客の画面から: 予定表の仮の顧客の問い合わせを付け替える (予定も移る・顧客の画面に戻る)");
ok(!db().customers.some((c) => c.id === "c_ph"), "記録がなくなった仮の顧客 (予定表から登録) は削除");
ok(db().auditLogs.some((l) => l.entity === "customer" && l.entityId === "c_ph" && l.action === "delete"), "仮の顧客の削除は変更履歴 (delete・entityId) に残す (試験期間の引き継ぎが削除を運ぶ)");
ok(/付け替え/.test(db().auditLogs.filter((l) => l.entity === "inquiry" && l.entityId === "inq_ph").at(-1)?.summary ?? ""), "問い合わせの変更履歴に「顧客を付け替え」");

r = await act(staff, () => A.linkInquiryFromForm(form({ inquiryId: "inq_free", customerId: real.id, returnTo: "/inquiries/inq_free" })));
ok(/すでに/.test(r.err ?? ""), "同じお客様にもう一度紐づけようとすると断る");
const second = db().customers.find((c) => c.storeId === "koshi" && c.id !== real.id && c.type === "individual");
r = await act(staff, () => A.linkInquiryFromForm(form({ inquiryId: "inq_free", customerId: second.id, returnTo: "/inquiries/inq_free" })));
eq([r.err, db().inquiries.find((i) => i.id === "inq_free").customerId, db().customers.some((c) => c.id === real.id)], [null, second.id, true], "見積の前なら別のお客様に付け替えられる (本物の顧客は消さない)");
await store.mutate((x) => {
  x.inquiries.find((i) => i.id === "inq_quoted").customerId = second.id;
});
r = await act(staff, () => A.linkInquiryFromForm(form({ inquiryId: "inq_quoted", customerId: real.id, returnTo: "/inquiries/inq_quoted" })));
ok(/見積を作成した案件/.test(r.err ?? ""), "見積を作った案件のお客様は付け替えない");
if (other) {
  r = await act(other, () => A.linkInquiryFromForm(form({ inquiryId: "inq_free", customerId: real.id, returnTo: "/inquiries/inq_free" })));
  ok(Boolean(r.err), "ほかの店舗のスタッフは紐づけを変えられない");
}

/* ================================================================== */
section("4. 検索");
const S = await imp("lib/link-search.ts");
const byPhone = S.searchCustomers(db(), staff, real.phone);
eq(byPhone[0]?.id, real.id, "電話番号で既存の顧客を探す (いちばん上)");
const sei = real.name.split(/\s+/)[0];
ok(S.searchCustomers(db(), staff, sei).some((c) => c.id === real.id), `お名前 (${sei}) で探す`);
// 紐付けはお客様の記録を変えないため、顧客の一覧で見られるお客様 (閲覧の範囲の初期設定 = 全社員が全店舗) から探す (お客様のご要望 2026-11-24)
const anyStore = (list) => new Set(list.map((c) => db().customers.find((x) => x.id === c.id).storeId));
ok(anyStore(S.searchCustomers(db(), staff, sei, 200)).size > 1 || db().customers.every((c) => !c.name.startsWith(sei) || c.storeId === "koshi"), "店舗スタッフもほかの店舗のお客様を探せる (閲覧の範囲の初期設定)");
await store.mutate((d) => d.settings.push({ id: "access_policy", value: { figures: "all", customers: "open", grantDays: 7 }, updatedAt: "2026-01-01T00:00:00Z" }));
ok(S.searchCustomers(db(), staff, sei).every((c) => db().customers.find((x) => x.id === c.id).storeId === "koshi"), "閲覧の範囲を「進行中の案件だけ」にすると、店舗スタッフは自店舗のお客様だけ");
await store.mutate((d) => (d.settings = d.settings.filter((x) => x.id !== "access_policy")));
eq(S.searchCustomers(db(), staff, ""), [], "空の検索は候補なし");
await store.mutate((x) => {
  x.inquiries.push({ id: "inq_cand", number: "INQ-T-4", contactName: real.name.split(/\s+/)[0], contactPhone: real.phone, channel: "phone", storeId: "koshi", category: "tatami", summary: "畳の相談", detail: "", status: "new", receivedAt: nowIso, createdBy: staff.id, updatedAt: nowIso });
});
const cands = S.linkableInquiries(db(), staff, real, "");
eq([cands[0]?.id, cands[0]?.reason], ["inq_cand", "電話番号が一致"], "顧客の画面の候補: 電話番号が一致する未登録の問い合わせ");
ok(!cands.some((c) => c.id === "inq_free" || c.id === "inq_quoted"), "ほかのお客様にひも付いた問い合わせ・見積の後の問い合わせは候補にしない");
ok(S.linkableInquiries(db(), staff, real, "INQ-T-4").some((c) => c.id === "inq_cand"), "番号で探す");
const inqFree = db().inquiries.find((i) => i.id === "inq_cand");
eq(S.inquiryContact(inqFree, undefined), { phone: real.phone, address: "" }, "一覧: 名前と電話だけの受付は住所が空");
eq(S.inquiryContact({ contactPhone: "090", intake: { address: "合志市福原1" } }, { phone: "", address: "福原", area: "福原", tags: ["予定表から登録"] }), { phone: "090", address: "合志市福原1" }, "一覧: 仮の顧客なら受付で聞いた電話・住所");

/* ================================================================== */
section("5. 予定表の上での変更 (日時・内容・種類)");
const SA = await imp("lib/actions/schedule.ts");
const back = `/schedule?view=week&date=${d(3)}&_r=abc`;
r = await act(staff, () => SA.quickUpdateScheduleEvent("ev_free", form({ returnTo: back, kind: "onsite_quote", date: d(5), timeMode: "time", startTime: "13:00", endTime: "14:30", title: "ヤマダ 様 現見", memo: "網戸 大5 小2" })));
const ev = db().schedule.find((e) => e.id === "ev_free");
eq([r.err, r.path, ev.kind, ev.date, ev.startTime, ev.endTime, ev.slot, ev.title, ev.memo, ev.assigneeIds], [null, "/schedule", "onsite_quote", d(5), "13:00", "14:30", undefined, "ヤマダ 様 現見", "網戸 大5 小2", [staff.id]], "日時・種類 (現見)・件名・メモを変える (担当者はそのまま)・予定表に戻る");
ok(/予定を更新しました/.test(r.msg ?? ""), "保存のメッセージ");
r = await act(staff, () => SA.quickUpdateScheduleEvent("ev_free", form({ returnTo: back, timeMode: "pm" })));
eq([db().schedule.find((e) => e.id === "ev_free").slot, db().schedule.find((e) => e.id === "ev_free").startTime], ["pm", undefined], "時刻 → 午後");
await store.mutate((x) => {
  x.schedule.push({ id: "ev_busy", title: "会議", kind: "meeting", date: d(5), startTime: "13:00", endTime: "14:00", storeId: "koshi", assigneeIds: [staff.id], source: "manual", createdBy: staff.id, createdAt: nowIso });
});
// 午前・午後だけの予定どうしは順に回るので重複にしない (calendar.ts の timeOverlap)。時刻の重なりで確かめる
r = await act(staff, () => SA.quickUpdateScheduleEvent("ev_free", form({ returnTo: back, timeMode: "time", startTime: "13:30", endTime: "14:30", memo: "x" })));
ok(/重複/.test(r.err ?? ""), "担当者の予定と時間が重なるときは「重複を承知で保存する」なしでは保存しない");
r = await act(staff, () => SA.quickUpdateScheduleEvent("ev_free", form({ returnTo: back, timeMode: "time", startTime: "13:30", endTime: "14:30", memo: "x", allowOverlap: "1" })));
eq([r.err, db().schedule.find((e) => e.id === "ev_free").memo], [null, "x"], "重複を承知で保存");
ok(db().auditLogs.some((l) => l.entity === "schedule" && l.entityId === "ev_free" && l.action === "update" && (l.changes ?? []).some((c) => c.field === "kind")), "変更履歴に種類の変更 (変更前・変更後)");
if (other) {
  r = await act(other, () => SA.quickUpdateScheduleEvent("ev_free", form({ returnTo: back, timeMode: "am" })));
  ok(/権限/.test(r.err ?? ""), "ほかの店舗の担当でない社員は変えられない");
}

/* ================================================================== */
section("6. 顧客の画面から取り込んだ受付");
const R = await imp("lib/reception.ts");
eq(R.receptionMetaOf({ extracted: { _source: "photo", _customerId: real.id } }).customerId, real.id, "受付の記録にお客様 (_customerId)");
const RA = await imp("lib/actions/reception.ts");
r = await act(staff, () => RA.createReception(form({ source: "text", channel: "phone", storeId: "koshi", customerId: real.id, text: "網戸の張り替え 大5枚 小2枚。12月中に施工希望。" })));
const doc = db().documents.filter((x) => x.kind === "reception").at(-1);
eq([r.err, R.receptionMetaOf(doc).customerId], [null, real.id], "取り込んだ受付にお客様が残る");
r = await act(staff, () => RA.registerReception(form({ id: doc.id, intent: "inquiry", customerId: real.id, media: "repeat", summary: "網戸の張り替え", confirmedUncertain: "on" })));
const inq = db().inquiries.find((i) => i.sourceRef === `reception:${doc.id}`);
eq([r.err, inq?.customerId, inq?.contactName], [null, real.id, real.name], "確かめて「問い合わせとして登録」→ そのお客様の問い合わせ");
r = await act(other ?? staff, () => RA.createReception(form({ source: "text", channel: "phone", customerId: "nope", text: "テストの受付です。" })));
ok(Boolean(r.err), "見つからないお客様の受付は断る");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
