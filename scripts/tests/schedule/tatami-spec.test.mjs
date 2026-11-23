/**
 * 畳の仕様 (部屋ごとの畳数・畳表・畳縁・畳床・寸法。src/lib/tatami-spec.ts・お客様のご要望 2026-11-23) のテスト
 *   node scripts/tests/schedule/tatami-spec.test.mjs   (npm run test:schedule)
 * 1. 見積の明細と手書きの備考から部屋ごとの仕様を作る (11/23 にお客様が入れた見積書の書き方)
 * 2. 未確定の項目 (寸法未確認・畳床未確認・厚み未確認)・入力の確かめ・予定表の製造の表の行
 * 3. 畳製造予定: 受注の行の部屋 (この行の作業の部屋)・入れた仕様の畳数・見積と違うときの注意・移行した予定表の引き取り
 * 4. 画面の操作: 見積で入れる → 受注に引き継ぐ → 受注・畳製造予定で直す (ほかの作業の部屋は残す)・受注のない行
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-tatami-spec-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "tatami-spec-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-tatami-spec",
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
const T = await imp("lib/tatami-spec.ts");
const it = (name, spec, qty, unit = "畳", extra = {}) => ({ name, spec, qty, unit, ...extra });
const brief = (rooms) => rooms.map((r) => [r.room ?? "", r.work, r.qty, r.omote ?? "", r.herinashi ? "縁無" : (r.heri ?? ""), r.doko ?? "", r.dokoThickness ?? "", r.size ?? "", r.note ?? ""].join("|"));

/* ================================================================== */
section("1. 見積の明細から部屋ごとの仕様");
eq(brief(T.roomsFromLines({ items: [it("畳", "表替え さくら", 12), it("畳", "縁 マス菊", 12), it("襖", "両面 みやこ317", 4, "枚"), it("諸経費", "", 1, "式")], siteInfo: { sizes: "610" } })), ["|omote|12|さくら|マス菊|||610|"], "「畳 / 表替え さくら」「畳 / 縁 マス菊」: 畳表 さくら・縁 マス菊・寸法は備考の「610」(書かれたまま)");
eq(brief(T.roomsFromLines({ items: [it("畳表替え", "きずな", 16), it("畳縁", "アラベスク510", 16)], siteInfo: { sizes: "本間", straw: "A" } })), ["|omote|16|きずな|アラベスク510|今の床 (わら A)||本間 (京間)|"], "備考の「本間」「わら A」→ 寸法 本間・今の床 (わら A)");
eq(brief(T.roomsFromLines({ items: [it("表替え", "銀白 100A", 7), it("表替え", "銀白 100A 半畳", 2), it("ヘリ", "倉四季90", 8)], siteInfo: { material: "A" } })), ["|omote|7|銀白 100A|倉四季90|今の床 (建材 A)|||", "|omote|2|銀白 100A|倉四季90|今の床 (建材 A)|||半畳"], "半畳の行は別の部屋 (メモに半畳)・寸法なし");
eq(brief(T.roomsFromLines({ items: [it("畳表替え めぐみ 縁代込", "中国産 上級", 8)] })), ["|omote|8|めぐみ 中国産 上級|||||"], "「縁代込」は縁の品名が分からないので未確認");
eq(brief(T.roomsFromLines({ items: [it("畳 表替え", "きずな", 7), it("畳 新調", "きずな＋3型床", 7), it("縁", "マス菊", 14)], siteInfo: { sizes: "610 t=19" } })), ["|omote|7|きずな|マス菊|||610 t=19|", "|new|7|きずな|マス菊|建材床 (3型)||610 t=19|"], "新調「きずな＋3型床」→ 畳表 きずな・畳床 建材床 (3型)・厚みは未確認 (備考の数字からは決めない)");
eq(brief(T.roomsFromLines({ items: [it("1階 和室 畳表替え", "きずな 本間", 8), it("2階 洋室 へり無し畳 新調", "清流 床暖房用 30mm 880×1760", 4.5), it("畳縁", "マス菊", 8)] })), ["1階 和室|omote|8|きずな|マス菊|||本間 (京間)|", "2階 洋室|new|4.5|清流|縁無|床暖房用畳床|30mm|880×1760|"], "部屋の言葉・縁無・床暖房用・厚み・寸法 (mm)");
eq(brief(T.roomsFromLines({ items: [it("畳表替え", "さくら", 6), it("畳表替え", "さくら", 8), it("畳縁", "アラベスク510", 8), it("畳縁", "マス菊", 6)] })).map((x) => x.split("|")[4]), ["マス菊", "アラベスク510"], "縁が 2 行: 畳数の同じ部屋に当てる (畳表は同じで縁だけ違う部屋)");
eq(brief(T.roomsFromLines({ items: [it("畳 新調", "", 6, "畳", { dokoMaterialId: "mat_1" })], materialName: (id) => (id === "mat_1" ? "建材床 55mm 五八" : undefined) }))[0].split("|")[5], "建材床 55mm 五八", "見積の明細で選んだ畳床 (材料マスタ) を使う");
eq(T.roomsFromLines({ items: [it("畳表替え", "きずな", 1, "式")] })[0].qty, 0, "「一式」は畳数未確認");
eq(T.roomsFromLines({ items: [it("襖", "両面", 4, "枚"), it("障子", "", 2, "枚")] }), [], "畳の明細がなければ部屋なし");

/* ================================================================== */
section("2. 未確定の項目・入力の確かめ・予定表の製造の表");
const full = { id: "tr_full01", work: "new", qty: 6, omote: "きずな", heri: "マス菊", doko: "建材床", dokoThickness: "55mm", size: "本間" };
eq(T.roomPending(full), [], "全部入っていれば未確認なし");
eq(T.roomPending({ ...full, size: "", dokoThickness: "" }), ["厚み", "寸法"], "建材床の厚み・寸法がない → 厚み未確認・寸法未確認");
eq(T.roomPending({ ...full, doko: "" }), ["畳床"], "新調の畳床がない → 畳床未確認");
eq(T.roomPending({ ...full, doko: "本ワラ床", dokoThickness: "" }), [], "本ワラ床は厚みを聞かない");
eq(T.roomPending({ id: "tr_ura001", work: "ura", qty: 6, heri: "マス菊", size: "五八" }), [], "裏返し: 畳表・畳床は聞かない (今の表・今の床)");
eq(T.roomPending({ id: "tr_her001", work: "omote", qty: 4, omote: "さくら", herinashi: true, size: "五八" }), [], "縁無なら畳縁は聞かない");
eq(T.roomText({ id: "tr_x00001", work: "new", qty: 4.5, omote: "清流", herinashi: true, doko: "建材床" }, 0), "部屋 1 新調 4.5畳 / 表 清流 / 縁無 / 床 建材床 (厚み未確認) / 寸法未確認", "部屋の文 (変更履歴): 寸法未確認・厚み未確認");
let c = T.cleanRooms([{ id: "bad", work: "x", qty: "4.5", omote: " きずな ", herinashi: "1", heri: "マス菊", dokoThickness: "55" }, { work: "omote", qty: "" }]);
eq([c.rooms.length, c.rooms[0].work, c.rooms[0].qty, c.rooms[0].omote, c.rooms[0].herinashi, c.rooms[0].heri, c.rooms[0].dokoThickness, /^tr_/.test(c.rooms[0].id)], [1, "omote", 4.5, "きずな", true, undefined, "55mm", true], "確かめ: 作業の誤りは表替え・縁無なら縁を消す・厚みの数字に mm・空の行は省く・ID を付け直す");
ok(T.cleanRooms([{ work: "omote", qty: -1 }]).error?.includes("畳数"), "畳数がマイナスは誤り");
ok(T.cleanRooms(Array.from({ length: 31 }, () => ({ work: "omote", qty: 1 }))).error?.includes("30"), "部屋は 30 行まで");
eq(brief(T.roomsFromSheetMemo("畳 新調9\n10-12時 採寸\n製造: 新半 9枚 / 表 清流胡桃色 / 縁無9 / サイズ 285 / 床 建材 30mm\n製造: 裏 6枚 / 縁 麻の葉橙 / サイズ 61")), ["|new|9|清流胡桃色|縁無|建材床|30mm|285|半畳", "|ura|6||麻の葉橙|||61|"], "予定表の工場の製造の表の行 (メモの「製造: …」) → 部屋ごとの仕様");
ok(T.sameRooms([{ id: "tr_a00001", work: "omote", qty: 6, omote: "x" }], [{ omote: "x", qty: 6, work: "omote", id: "tr_a00001" }]), "同じ仕様の比べ方 (キーの順番を問わない)");

/* ================================================================== */
section("3. 畳製造予定の行の仕様");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const staff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const cust = db().customers.find((c) => c.storeId === "koshi");
const now = new Date().toISOString();
const Y = new Date().getFullYear() + 1;
const D = (md) => `${Y}-${md}`;
await store.mutate((d) => {
  d.quotes.push({ id: "q_ts1", number: "Q-TS-1", version: 1, customerId: cust.id, storeId: "koshi", title: "表替え・新調", category: "tatami", items: [{ id: "i1", name: "畳 表替え", spec: "きずな", qty: 8, unit: "畳", unitPrice: 10000, amount: 80000 }, { id: "i2", name: "畳 新調", spec: "さくら 建材床", qty: 6, unit: "畳", unitPrice: 20000, amount: 120000 }, { id: "i3", name: "縁", spec: "マス菊", qty: 14, unit: "畳", unitPrice: 500, amount: 7000 }], subtotal: 207000, discount: 0, tax: 18818, total: 207000, status: "approved", validUntil: D("12-31"), createdBy: staff.id, createdAt: now, updatedAt: now, siteInfo: { sizes: "五八" } });
});
const PL = await imp("lib/production/plan.ts");
const QA = await imp("lib/actions/quotes.ts");
const RA = await imp("lib/actions/tatami-rooms.ts");
const PA = await imp("lib/actions/production.ts");
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
    if (k === "rooms") fd.set(k, typeof v === "string" ? v : JSON.stringify(v));
    else if (Array.isArray(v)) for (const x of v) fd.append(k, String(x));
    else if (v !== undefined && v !== null) fd.set(k, String(v));
  }
  return fd;
};
// 見積の画面で仕様を入れる: 表替えを 2 部屋 (縁だけ違う)・新調の寸法と厚みは未確認のまま
const quoteSpec = [
  { id: "tr_q00001", room: "1階 和室", work: "omote", qty: 6, omote: "きずな", heri: "マス菊", size: "江戸間 (五八)" },
  { id: "tr_q00002", room: "仏間", work: "omote", qty: 2, omote: "きずな", heri: "紋縁 高麗", size: "江戸間 (五八)" },
  { id: "tr_q00003", room: "2階 洋室", work: "new", qty: 6, omote: "さくら", heri: "マス菊", doko: "建材床" },
];
let r = await act(staff, () => RA.saveQuoteTatamiRooms("q_ts1", form({ rooms: quoteSpec })));
ok(r.msg?.includes("保存しました") && db().quotes.find((q) => q.id === "q_ts1").tatamiRooms.length === 3, "見積の画面で部屋ごとの仕様を保存");
r = await act(staff, () => QA.convertQuoteToOrder("q_ts1", form({ scheduledStart: D("12-10"), workerIds: [staff.id] })));
const order = () => db().orders.find((o) => o.quoteId === "q_ts1");
ok(order() && order().tatamiRooms?.length === 3, "受注にすると見積の仕様を受注に引き継ぐ");
r = await act(staff, () => RA.saveQuoteTatamiRooms("q_ts1", form({ rooms: quoteSpec.slice(0, 1) })));
ok(r.err?.includes("受注の画面"), "受注にした見積の仕様は受注の画面で直す");
// 引取・納品の日程: 表替えは 12/10 引取、新調は 12/12 引取 (別の行)
const hv = order().handovers;
const newRow = hv.find((h) => h.item === "tatami_new");
await store.mutate((d) => {
  const o = d.orders.find((x) => x.quoteId === "q_ts1");
  o.handovers = o.handovers.map((h) => (h.item === "tatami_new" ? { ...h, pickupDate: D("12-12"), deliveryDate: D("12-20") } : h));
});
const rows = () => PL.productionRows(db(), { from: D("12-01"), to: D("12-31"), today: D("12-01") }).filter((x) => x.orderId === order().id);
const omoteRow = () => rows().find((x) => x.roomsTarget.works?.includes("omote"));
const newRowP = () => rows().find((x) => x.roomsTarget.works?.includes("new"));
eq([omoteRow()?.date, omoteRow()?.rooms.map((x) => x.room), omoteRow()?.qty, omoteRow()?.roomsSource], [D("12-10"), ["1階 和室", "仏間"], 8, "order"], "表替えの行 (12/10): 表替えの 2 部屋 (縁だけ違う)・畳数 8");
eq([newRowP()?.date, newRowP()?.rooms.map((x) => x.room), T.roomPending(newRowP().rooms[0])], [D("12-12"), ["2階 洋室"], ["厚み", "寸法"]], "新調の行 (12/12): 新調の部屋・厚み未確認・寸法未確認");
// 製造の現場が畳製造予定で新調の厚みと寸法を入れる → 受注の仕様に保存 (表替えの部屋は残す)
r = await act(staff, () => PA.saveProductionRooms(form({ key: newRowP().key, back: "/schedule/production", rooms: [{ ...quoteSpec[2], dokoThickness: "40", size: "880×1760" }] })));
ok(r.msg?.includes("保存しました"), "畳製造予定で仕様を保存");
eq(order().tatamiRooms.map((x) => [x.room, x.dokoThickness ?? "", x.size ?? ""]), [["1階 和室", "", "江戸間 (五八)"], ["仏間", "", "江戸間 (五八)"], ["2階 洋室", "40mm", "880×1760"]], "受注の仕様: 新調の部屋だけ直り、表替えの部屋は残る");
eq(T.roomPending(newRowP().rooms[0]), [], "新調の行の未確認がなくなる");
ok(db().auditLogs.some((a) => a.entity === "order" && a.entityId === order().id && a.changes?.some((c) => c.field === "tatamiRooms")), "受注の変更履歴に残す");
// 部屋の畳数の合計が見積と違う → 注意
r = await act(staff, () => RA.saveOrderTatamiRooms(order().id, form({ rooms: [{ ...quoteSpec[0], qty: 5 }, quoteSpec[1], { ...quoteSpec[2], dokoThickness: "40mm", size: "880×1760" }] })));
ok(r.msg?.includes("保存しました"), "受注の画面で仕様を保存");
eq([omoteRow().qty, omoteRow().warnings.some((w) => w.includes("見積の畳数 (8畳)"))], [7, true], "部屋の合計 (7畳) で数え、見積 (8畳) と違えば注意を出す");

section("3b. 移行した予定表の引き取り・受注のない行");
await store.mutate((d) => {
  d.schedule.push({ id: "ev_ts_sheet", title: "(須屋) 大岩 引き取り", kind: "pickup", date: D("12-15"), storeId: "koshi", assigneeIds: [], source: "import", sourceRef: "sheet:x", memo: "畳 表替え6 / 畳 新調4\n製造: 表 6枚 / 表 きずな / 縁 浮14 / サイズ 61\n製造: 新 4枚 / 表 さくら / 縁無4 / 床 建材", createdAt: now });
});
const evRow = () => PL.productionRows(db(), { from: D("12-01"), to: D("12-31"), today: D("12-01") }).find((x) => x.key === "ev:ev_ts_sheet");
eq([evRow()?.roomsSource, brief(evRow()?.rooms ?? [])], ["sheet", ["|omote|6|きずな|浮14|||61|", "|new|4|さくら|縁無|建材床|||"]], "予定表の製造の表から 2 部屋 (縁無・建材床)");
r = await act(staff, () => PA.saveProductionRooms(form({ key: "ev:ev_ts_sheet", back: "/schedule/production", rooms: [...evRow().rooms.slice(0, 1), { ...evRow().rooms[1], dokoThickness: "35mm", size: "61" }] })));
ok(r.msg?.includes("保存しました"), "受注のない行の仕様を保存 (製造予定の行に)");
eq([evRow()?.roomsSource, evRow()?.rooms[1].dokoThickness, evRow()?.qty, evRow()?.herinashi], ["record", "35mm", 10, 4], "保存した仕様を使う (畳数 10・縁無 4)");
ok(db().tatamiProduction.find((x) => x.sourceKey === "ev:ev_ts_sheet")?.history.some((h) => h.action === "edit"), "製造予定の行の記録に「仕様」");
const other = db().users.find((u) => u.active === false) ?? null;
if (other) {
  r = await act(other, () => PA.saveProductionRooms(form({ key: "ev:ev_ts_sheet", back: "/schedule/production", rooms: [] })));
  ok(Boolean(r.err), "無効の社員は保存できない");
}
r = await act(staff, () => PA.saveProductionRooms(form({ key: "ev:ev_ts_sheet", back: "/schedule/production", rooms: "{bad" })));
ok(r.err?.includes("形式"), "壊れた入力は断る");

section("3c. 仕様を入れていない受注 (見積の明細から自動)");
await store.mutate((d) => {
  d.quotes.push({ id: "q_ts2", number: "Q-TS-2", version: 1, customerId: cust.id, storeId: "koshi", title: "表替え", category: "tatami", items: [{ id: "i1", name: "畳表替え", spec: "なごみ", qty: 8, unit: "畳", unitPrice: 10000, amount: 80000 }, { id: "i2", name: "へり", spec: "マス菊", qty: 8, unit: "畳", unitPrice: 500, amount: 4000 }], subtotal: 84000, discount: 0, tax: 7636, total: 84000, status: "approved", validUntil: D("12-31"), createdBy: staff.id, createdAt: now, updatedAt: now, siteInfo: { sizes: "五八", material: "A" } });
});
await act(staff, () => QA.convertQuoteToOrder("q_ts2", form({ scheduledStart: D("12-11"), workerIds: [staff.id] })));
const o2 = db().orders.find((o) => o.quoteId === "q_ts2");
const row2 = PL.productionRows(db(), { from: D("12-01"), to: D("12-31"), today: D("12-01") }).find((x) => x.orderId === o2.id);
eq([o2.tatamiRooms, row2?.roomsSource, brief(row2?.rooms ?? [])], [undefined, "auto", ["|omote|8|なごみ|マス菊|今の床 (建材 A)||江戸間 (五八)|"]], "見積で入れていなければ、見積の明細と備考から自動 (保存はしない)");

console.log(`\n${pass} passed, ${fails.length} failed`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
