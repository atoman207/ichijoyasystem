/**
 * お客様のご要望 2026-11-23 (■1 品目・単位の自動選択 / ■2 予定表の仕事内容・数量 / ■3 畳製造予定) のテスト
 *   node scripts/tests/schedule/work-production.test.mjs   (npm run test:schedule)
 * 1. 明細の種類・単位・品目の自動選択 (src/lib/line-kind.ts。11/23 にお客様が入れた見積の書き方)
 * 2. 仕事内容の省略表記「タ12 フ6 シ4 ア2」・へり無し畳 (src/lib/work-summary.ts)
 * 3. 登録済みの見積の単位・品目をそろえる (src/lib/quote-line-normalize.ts)
 * 4. 予定ごとの仕事内容 (src/lib/schedule-work.ts): 受注の引取・納品の予定・移行した予定表・見積の予定 (現地調査)
 * 5. 畳製造予定 (src/lib/production/plan.ts) と操作 (繰り越し・日付の変更・未定・元の日に戻す・製造済み・手で追加・削除)。
 *    製造日を変えても予定表の引取日・納品日は変わらない
 * 6. ヘッダーの件数の印 (src/lib/notify-live.ts): 承認の申請が増えると変わる
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-work-production-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "work-production-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-work-production",
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

/* ================================================================== */
section("1. 明細の種類・単位・品目の自動選択");
const L = await imp("lib/line-kind.ts");
const unit = (n, s, pc) => L.autoUnit(n, s, pc) ?? "-";
const cat = (n, s, pc) => L.autoItemCategory(n, s, pc) ?? "-";
// お客様のご指示の単位: 畳 → 畳 / 襖・障子・網戸 → 枚 / 引手・取手 → 個 (仕様を優先) / カーテン → ヶ所 / 仏間 (襖) → 式 / 縁 → 畳 / リフォーム → 式
eq([unit("畳表替え", "きずな"), unit("畳 新調", "国産"), unit("へり無し畳 新調 (琉球畳風)")], ["畳", "畳", "畳"], "畳 → 畳 (表替え・新調・へり無し)");
eq([unit("襖貼替え", "みやこ 310"), unit("障子張替え（サッシ）", "ストライク"), unit("アミ戸", "18メッシュ グレー 大"), unit("網戸張替え")], ["枚", "枚", "枚", "枚"], "襖・障子・網戸 → 枚");
eq([unit("襖", "引き手 S-186（黒）"), unit("引手", "そのまま"), unit("取手", "K-8"), unit("襖", "取っ手 交換")], ["個", "個", "個", "個"], "引手・取手 → 個 (品名が「襖」でも仕様の「引き手」を優先)");
eq([unit("カーテン", "2 窓"), unit("ロールスクリーン")], ["ヶ所", "ヶ所"], "カーテン → ヶ所");
eq([unit("襖", "仏一式 あかつき689"), unit("フスマ", "仏間 のぞみ117"), unit("仏間 襖")], ["式", "式", "式"], "仏間 (襖) → 式");
eq([unit("畳", "縁 マス菊"), unit("畳縁", "アラベスク510"), unit("ヘリ", "倉四季90"), unit("へり", "マス菊"), unit("縁", "浮6")], ["畳", "畳", "畳", "畳", "畳"], "縁 → 畳 (品名が「畳」でも仕様の「縁」)");
eq([unit("クロス張替え 6畳"), unit("フローリング工事"), unit("内装リフォーム")], ["式", "式", "式"], "リフォーム → 式 (「6畳」は部屋の広さ)");
eq([unit("諸経費"), unit("DM値引"), unit("金券値引き"), unit("マイトスタット", "敷き込み"), unit("ベニア交換")], ["-", "-", "-", "-", "-"], "値引き・諸経費・分からないものは単位を変えない");
eq([unit("畳表替え めぐみ　縁代込", "中国産 上級"), cat("畳表替え めぐみ　縁代込")], ["畳", "tatami"], "「縁代込」は縁ではなく畳の行");
eq([unit("襖張替え 引手込み")], ["枚"], "「引手込み」は襖の行");
eq([cat("襖", "両面 みやこ317"), cat("引手", "そのまま"), cat("襖", "仏一式"), cat("障子"), cat("網戸"), cat("畳", "縁 マス菊"), cat("カーテン"), cat("クロス張替え"), cat("諸経費"), cat("DM値引")], ["fusuma", "fusuma", "fusuma", "fusuma", "fusuma", "tatami", "curtain", "reform", "-", "-"], "品目: 襖・障子・網戸・引手・仏間 → 襖 (障子・網戸を含む)、縁 → 畳、カーテン、リフォーム。値引き・諸経費は自動のまま");
eq([L.lineKind("品名なし", "", "fusuma")?.kind, L.lineKind("品名なし", "", "tatami")?.kind], ["fusuma", "tatami"], "言葉で決まらなければ商品マスタの分類");
eq([L.lineKind("へり無し畳 新調")?.herinashi, L.lineKind("畳表替え", "銀白 半畳")?.half, L.lineKind("琉球畳")?.herinashi], [true, true, true], "へり無し・半畳の印");
ok(["m", "㎡", "畳", "枚", "個", "ヶ所", "式"].every((u) => L.UNIT_OPTIONS.includes(u)), "単位の選択肢に m・㎡ と指示の単位がある");
ok(L.isPieceUnit("枚") && L.isPieceUnit("式") && !L.isPieceUnit("m") && !L.isPieceUnit("㎡"), "m・㎡ は枚数として数えない");

/* ================================================================== */
section("2. 仕事内容の省略表記");
const W = await imp("lib/work-summary.ts");
const lines = [
  { name: "畳表替え", spec: "きずな", qty: 12, unit: "畳" },
  { name: "畳縁", spec: "アラベスク", qty: 12, unit: "畳" },
  { name: "襖", spec: "両面", qty: 4, unit: "枚" },
  { name: "襖", spec: "天袋", qty: 2, unit: "枚" },
  { name: "襖", spec: "引き手 S-186", qty: 21, unit: "個" },
  { name: "障子張替え", qty: 4, unit: "枚" },
  { name: "網戸", qty: 2, unit: "枚" },
  { name: "諸経費", qty: 1, unit: "式" },
  { name: "DM値引", qty: 10, unit: "式" },
];
eq(W.workText(W.countsFromLines(lines)), "タ12 フ6 シ4 ア2", "畳 12・襖 6・障子 4・網戸 2 →「タ12 フ6 シ4 ア2」(縁・引手・値引き・諸経費は数えない)");
const withHeri = W.countsFromLines([{ name: "畳表替え", qty: 6, unit: "畳" }, { name: "へり無し畳 新調", spec: "半畳", qty: 6, unit: "枚" }]);
// 2026-11-26「■9」: 新調は「タ新6」と分ける。へり無しの注記は畳の最後の部品に付ける
eq(W.workText(withHeri), "タ6 タ新6(縁無半6)", "へり無し畳は「(縁無…)」で目立たせる (12 のうち 6。新調 6 は「タ新6」)");
eq(W.workTokens(withHeri).find((t) => t.note)?.note, "(縁無半6)", "へり無し畳の注記は別の部品 (色を付ける)");
eq(W.workText(W.countsFromLines([{ name: "へり無し畳 新調", qty: 8, unit: "枚" }])), "タ新8(縁無)", "すべてへり無しの新調なら「タ新8(縁無)」");
eq(W.workText(W.countsFromLines([{ name: "襖", spec: "仏間一式", qty: 1, unit: "式" }])), "フ", "仏間 (一式) は枚数なしの「フ」");
eq(W.workText(W.countsFromText("(清水万石) 谷本 引き取り\n畳 表替え12 / 襖 張替3 / 障子 張替6 / 網戸 張替3")), "タ12 フ3 シ6 ア3", "移行した予定表の 1 行目「畳 表替え12 / 襖 張替3 …」");
eq(W.workText(W.countsFromText("倉本 様 引き取り (畳 表替え 6枚・襖 4面)")), "タ6 フ4", "受注の予定の件名「(畳 表替え 6枚・襖 4面)」");
eq(W.workText(W.countsFromText("1~3 縁無半9(表or新) 現見になるかも")), "タ9(縁無半)", "メモの「縁無半9」");
eq(W.workText(W.countsFromText("11:00 施工完了報告書持参 縁無半 9/29納品")), "タ(縁無半)", "「縁無半 9/29」の 9 は日付 (枚数にしない)");
eq(W.workText(W.countsFromText("AM 縁無から縁付 台車OK")), "", "「縁無から縁付」はへり無し畳にしない");
eq(W.workText(W.countsFromText("13:30-14:00 タ6フ1見積", { shorthand: true })), "タ6 フ1", "見積の予定のメモの省略「タ6フ1」");
eq(W.workText(W.countsFromText("1-2 タ4半見積", { shorthand: true })), "タ4.5", "「タ4半」= 4 畳半");
eq(W.workText(W.countsFromText("8:30-9 見積 カーテン シ ア", { shorthand: true })), "シ ア カーテン", "数量のない品目は記号だけ");
eq(W.workText(W.countsFromText("下見 障子 襖(幅180cm?) シート アラベスク フローリング", { shorthand: true })), "フ シ", "カタカナの言葉 (シート・アラベスク・フローリング) は省略の記号にしない");
eq(W.workText(W.countsFromText("和室6畳 クロス", { shorthand: true })), "", "「6畳」は部屋の広さ");
eq([W.stripKindWords("(清水万石) 谷本 引き取り", "pickup"), W.stripKindWords("(中) 髙木 現地調査・見積", "survey"), W.stripKindWords("倉本 様 納品 (畳 表替え 6枚)", "delivery"), W.stripKindWords("(池田) 國本 顧客訪問", "visit"), W.stripKindWords("山田 様 施工", "install"), W.stripKindWords("会議", "meeting")], ["(清水万石) 谷本", "(中) 髙木", "倉本 様", "(池田) 國本", "山田 様 施工", "会議"], "件名の右の「引き取り」「納品」などは出さない (施工・社内の予定はそのまま)");

/* ================================================================== */
// 2026-11-26「■9 予定表の施工内容の表示」: 新調は「新」を付けて張替えと分ける
{
  const lines = (name, qty, unit = "枚") => W.workText(W.countsFromLines([{ name, qty, unit }]));
  eq(lines("畳 表替え", 6, "畳"), "タ6", "畳表替え6畳: タ6");
  eq(lines("畳 新調", 6, "畳"), "タ新6", "畳新調6畳: タ新6");
  eq(lines("襖 張替え", 2), "フ2", "襖張替え2枚: フ2");
  eq(lines("襖 新調", 2), "フ新2", "襖新調2枚: フ新2");
  eq(lines("障子 新調", 2), "シ新2", "障子新調2枚: シ新2");
  eq(lines("網戸 新調", 2), "ア新2", "網戸新調2枚: ア新2");
  const mixed = W.countsFromLines([
    { name: "畳 表替え", qty: 6, unit: "畳" },
    { name: "畳 新調", qty: 4, unit: "畳" },
    { name: "襖 張替え", qty: 2, unit: "枚" },
    { name: "襖 新調", qty: 2, unit: "枚" },
  ]);
  eq(W.workText(mixed), "タ6 タ新4 フ2 フ新2", "張替えと新調の混在: タ6 タ新4 フ2 フ新2");
  eq(W.workText(W.countsFromText("タ6 タ新4 フ2 フ新2", { shorthand: true })), "タ6 タ新4 フ2 フ新2", "手入力の「タ6 タ新4 フ2 フ新2」も同じ形で読み戻せる");
  eq(W.workText(W.countsFromText("畳 表替え6・新調2")), "タ6 タ新2", "移行した予定表の「畳 表替え6・新調2」: タ6 タ新2");
  eq(W.workDescription(mixed), "畳 6・畳 新調 4・襖 2・襖 新調 2", "読み上げ・ツールチップも新調を分ける");
  ok(W.workTokens(mixed).filter((t) => t.fresh).length === 2, "新調の部品に印 (fresh)");
}
// 2026-11-26「予定表の作業内容の表示」: 見積・現場管理・施工などの自由な作業内容
{
  for (const t of ["タ6 タ新4 フ2 フ新2", "タ12(縁無6) フ6", "畳 表替え8 / 襖 張替2", "畳 表替え6・新調2", "タ4半", "縁無半12"]) ok(W.isCountsOnlyText(t), `数量だけの文: ${t} (作業量に数える)`);
  for (const t of ["タ3間、フ1部屋", "養生、廃材撤去", "クロス工事、畳下床板2間", "よろしく", ""]) ok(!W.isCountsOnlyText(t), `自由な作業内容: ${t || "(空)"} (そのまま表示)`);
  eq(W.workNoteOf({ work: "養生、廃材撤去" }), "養生、廃材撤去", "自由な作業内容は表示用の文");
  eq(W.workNoteOf({ work: "タ6 タ新4" }), undefined, "数量だけの文は表示用の文にしない (数量として出す)");
  eq(W.workNoteOf({}), undefined, "作業内容なし");
}

section("3. 登録済みの見積の単位・品目をそろえる");
const N = await imp("lib/quote-line-normalize.ts");
const fakeDb = {
  products: [{ id: "p_t", category: "tatami", name: "畳表替え さくら", unit: "畳" }],
  itemCategories: [],
  orders: [{ id: "o1", quoteId: "q1" }],
  invoices: [{ id: "i1", orderId: "o1", items: [] }],
  quotes: [
    {
      id: "q1",
      number: "Q-1",
      category: "tatami",
      createdAt: "2026-11-23T01:00:00.000Z",
      items: [
        { id: "a", name: "襖", spec: "両面", qty: 4, unit: "式", unitPrice: 1, amount: 4 },
        { id: "b", name: "襖", spec: "引き手 S-186", qty: 21, unit: "式", unitPrice: 1, amount: 21 },
        { id: "c", name: "畳", spec: "表替え さくら", qty: 12, unit: "畳", unitPrice: 1, amount: 12, productId: "p_t" },
        { id: "d", name: "畳", spec: "縁 マス菊", qty: 12, unit: "式", unitPrice: 1, amount: 12 },
        { id: "e", name: "引手", spec: "そのまま", qty: 8, unit: "式", unitPrice: 0, amount: 0, itemCategory: "other" },
        { id: "f", name: "クロス", qty: 20, unit: "m", unitPrice: 1, amount: 20 },
        { id: "g", name: "諸経費", qty: 1, unit: "式", unitPrice: 1, amount: 1 },
      ],
    },
    { id: "q2", number: "Q-2", category: "tatami", createdAt: "2026-11-21T01:00:00.000Z", items: [{ id: "x", name: "襖", qty: 4, unit: "式", unitPrice: 1, amount: 4 }] },
  ],
};
fakeDb.invoices[0].items = fakeDb.quotes[0].items.map((i) => ({ ...i }));
const fixes = N.planLineFixes(fakeDb, { from: "2026-11-22T15:00:00.000Z", to: "2026-11-23T15:00:00.000Z" });
eq(fixes.map((f) => `${f.line}:${f.field}:${f.before ?? ""}→${f.after}`), ["1:unit:式→枚", "1:itemCategory:→fusuma", "2:unit:式→個", "2:itemCategory:→fusuma", "4:unit:式→畳", "5:unit:式→個", "6:itemCategory:→reform"], "今日の見積だけ・単位は数を数える単位だけ (m は残す)・手で選んだ品目と商品マスタの行の品目は変えない");
N.applyLineFixes(fakeDb, fixes, "2026-11-23T10:00:00.000Z");
eq(fakeDb.quotes[0].items.map((i) => i.unit), ["枚", "個", "畳", "畳", "個", "m", "式"], "見積の単位をそろえた");
eq(fakeDb.invoices[0].items.map((i) => i.unit), ["枚", "個", "畳", "畳", "個", "m", "式"], "同じ明細の請求書もそろえた");
eq(fakeDb.quotes[1].items[0].unit, "式", "前の日の見積は変えない");
eq(N.planLineFixes(fakeDb, { from: "2026-11-22T15:00:00.000Z", to: "2026-11-23T15:00:00.000Z" }).length, 0, "もう一度実行しても直すものはない");

/* ================================================================== */
section("4. 予定ごとの仕事内容");
const store = await imp("lib/db/store.ts");
await store.syncDb();
const db = () => store.getDb();
const fmt = await imp("lib/format.ts");
const today = fmt.toDateKey(new Date());
const d = (n) => fmt.addDays(today, n);
const admin = db().users.find((u) => u.active && u.role === "admin");
const staff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const cust = db().customers.find((c) => c.storeId === "koshi");
const nowIso = new Date().toISOString();
await store.mutate((x) => {
  x.quotes.push({
    id: "q_wp",
    number: "Q-WP-1",
    customerId: cust.id,
    storeId: "koshi",
    category: "tatami",
    title: "表替え・襖",
    status: "accepted",
    items: [
      { id: "i1", name: "畳表替え", spec: "さくら", qty: 12, unit: "畳", unitPrice: 19800, amount: 237600 },
      { id: "i2", name: "へり無し畳 新調", spec: "半畳", qty: 6, unit: "枚", unitPrice: 13000, amount: 78000 },
      { id: "i3", name: "畳縁", spec: "マス菊", qty: 12, unit: "畳", unitPrice: 550, amount: 6600 },
      { id: "i4", name: "襖", spec: "両面", qty: 6, unit: "枚", unitPrice: 5500, amount: 33000 },
      { id: "i5", name: "襖", spec: "引き手", qty: 8, unit: "個", unitPrice: 880, amount: 7040 },
    ],
    subtotal: 362240,
    discount: 0,
    tax: 36224,
    total: 398464,
    createdBy: admin.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  x.orders.push({
    id: "o_wp",
    number: "O-WP-1",
    quoteId: "q_wp",
    customerId: cust.id,
    storeId: "koshi",
    category: "tatami",
    title: "表替え・襖",
    status: "scheduled",
    total: 398464,
    contractDate: today,
    workerIds: [],
    progressNotes: [],
    createdBy: admin.id,
    createdAt: nowIso,
    updatedAt: nowIso,
    handovers: [
      { id: "hv_tat", item: "tatami_omote", label: "畳 表替え 12畳", pickupDate: d(5), pickupStart: "09:00", pickupEnd: "10:00", deliveryDate: d(5), deliveryStart: "16:00" },
      { id: "hv_new", item: "tatami_new", label: "畳 新調 6枚", pickupDate: d(5), pickupStart: "09:00", pickupEnd: "10:00", deliveryDate: d(9) },
      { id: "hv_fus", item: "fusuma", label: "襖 6枚", pickupDate: d(5), pickupStart: "09:00", pickupEnd: "10:00", deliveryDate: d(7) },
    ],
  });
  // 移行した予定表の引き取り (受注にひも付かない) と見積の予定 (現地調査)
  x.schedule.push(
    { id: "ev_imp", title: "(須屋) 佐藤 引き取り", kind: "pickup", date: d(6), storeId: "koshi", assigneeIds: [], source: "import", memo: "畳 表替え6 / 襖 張替7\n8:30~10 縁無半4 11/26納品" },
    { id: "ev_imp_d", title: "(須屋) 佐藤 納品", kind: "delivery", date: d(8), storeId: "koshi", assigneeIds: [], source: "import", memo: "畳 表替え6" },
    { id: "ev_sv", title: "(薄場) 安永 現地調査・見積", kind: "survey", date: d(6), storeId: "nishi", assigneeIds: [], source: "import", memo: "13:30-14:00 タ6フ1見積" },
  );
});
const sched = await imp("lib/db/schedule.ts");
await store.mutate((x) => {
  sched.syncOrderEvent(x, x.orders.find((o) => o.id === "o_wp"), admin.id);
});
const SW = await imp("lib/schedule-work.ts");
const evs = db().schedule.filter((e) => e.orderId === "o_wp" || e.id.startsWith("ev_imp") || e.id === "ev_sv");
const wk = SW.scheduleWork(db(), evs);
const textOf = (pred) => W.workText(wk.get(evs.find(pred)?.id));
eq(textOf((e) => e.orderId === "o_wp" && e.kind === "pickup"), "タ12 タ新6(縁無半6) フ6", "受注の引き取り (畳・新調・襖をまとめて): タ12 タ新6(縁無半6) フ6");
eq(textOf((e) => e.orderId === "o_wp" && e.kind === "delivery" && e.date === d(5)), "タ12", "当日納品は畳の表替えだけ: タ12");
eq(textOf((e) => e.orderId === "o_wp" && e.kind === "delivery" && e.date === d(9)), "タ新6(縁無半)", "後日の新調の納品: タ新6(縁無半)");
eq(textOf((e) => e.orderId === "o_wp" && e.kind === "delivery" && e.date === d(7)), "フ6", "襖の納品: フ6");
eq(textOf((e) => e.id === "ev_imp"), "タ6(縁無半4) フ7", "移行した予定表の引き取り (1 行目の枚数 + メモの縁無)");
eq(textOf((e) => e.id === "ev_sv"), "タ6 フ1", "見積の予定 (現地調査) のメモの省略");

/* ================================================================== */
section("5. 畳製造予定");
const P = await imp("lib/production/plan.ts");
const q = { from: d(0), to: d(14), today };
const rows = () => P.productionRows(db(), q);
const rowOf = (key) => rows().find((r) => r.key === key);
const tat = rows().filter((r) => r.orderId === "o_wp");
eq(tat.map((r) => [r.key, r.date, r.qty, r.herinashiSeen]), [["ho:hv_tat", d(5), 18, true]], "受注の畳 (表替え・新調・引取日が同じ) は 1 行: 引取日に 18 畳 (縁無あり)");
ok(/畳表替え さくら 12畳/.test(tat[0].spec) && /へり無し畳 新調 半畳 6枚/.test(tat[0].spec) && /畳縁 マス菊/.test(tat[0].spec), `仕様に畳と縁の明細 (${tat[0].spec})`);
eq([tat[0].baseLabel, tat[0].deliveryDate, tat[0].mode, tat[0].status], ["引取日", d(5), "auto", "planned"], "元の日 = 引取日・納品日 (早いほう)・自動・予定");
const imp1 = rowOf("ev:ev_imp");
eq([imp1?.date, imp1?.qty, imp1?.herinashi, imp1?.deliveryDate, imp1?.spec], [d(6), 6, 4, d(8), "畳 表替え6 / 縁無半4"], "移行した予定表の引き取り: 6 畳 (縁無半 4)・納品日は同じお客様の納品の予定");
ok(!rows().some((r) => r.key === "ev:ev_sv"), "現地調査の予定は製造予定にしない");

const actions = await imp("lib/actions/production.ts");
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
const eventsBefore = JSON.stringify(db().schedule.filter((e) => e.orderId === "o_wp" || e.id.startsWith("ev_imp")).map((e) => [e.id, e.date, e.startTime, e.endTime]).sort());
const back = "/schedule/production";

let r = await act(staff, () => actions.updateProduction(form({ key: "ho:hv_tat", op: "carry", back })));
const carried = P.nextWorkDay(db(), d(5));
ok(r.msg?.includes("繰り越しました") && rowOf("ho:hv_tat")?.date === carried, `店舗スタッフが翌営業日 (${carried}) へ繰り越し: ${r.msg ?? r.err}`);
eq([rowOf("ho:hv_tat")?.mode, rowOf("ho:hv_tat")?.baseDate], ["manual", d(5)], "繰り越した行は「日付を変更」・元の日 (引取日) はそのまま");
r = await act(staff, () => actions.updateProduction(form({ key: "ho:hv_tat", op: "date", date: d(11), back })));
eq(rowOf("ho:hv_tat")?.date, d(11), "日付を変更");
ok(rowOf("ho:hv_tat")?.warnings.some((w) => w.includes("納品日")), "製造日が納品日より後なら注意");
r = await act(staff, () => actions.updateProduction(form({ key: "ho:hv_tat", op: "undecided", back })));
eq([rowOf("ho:hv_tat")?.mode, rowOf("ho:hv_tat")?.date], ["undecided", undefined], "製造日未定");
ok(P.productionView(rows(), q).undecided.some((x) => x.key === "ho:hv_tat"), "製造日未定の一覧に出る");
r = await act(staff, () => actions.updateProduction(form({ key: "ho:hv_tat", op: "auto", back })));
eq([rowOf("ho:hv_tat")?.mode, rowOf("ho:hv_tat")?.date], ["auto", d(5)], "元の日 (引取日) に戻す");
r = await act(staff, () => actions.updateProduction(form({ key: "ev:ev_imp", op: "done", back })));
eq(rowOf("ev:ev_imp")?.status, "done", "製造済み");
r = await act(staff, () => actions.updateProduction(form({ key: "ev:ev_imp", op: "reopen", back })));
eq(rowOf("ev:ev_imp")?.status, "planned", "未製造に戻す");
const eventsAfter = JSON.stringify(db().schedule.filter((e) => e.orderId === "o_wp" || e.id.startsWith("ev_imp")).map((e) => [e.id, e.date, e.startTime, e.endTime]).sort());
eq(eventsAfter, eventsBefore, "製造日を変えても予定表の引取日・納品日の予定は変わらない");
ok(db().auditLogs.filter((a) => a.entity === "production").length >= 6, "操作ごとに変更履歴");
const rec = db().tatamiProduction.find((x) => x.sourceKey === "ho:hv_tat");
eq(rec.history.map((h) => h.action), ["carry", "move", "undecided", "auto"], "行の記録 (繰り越し → 日付の変更 → 未定 → 元の日)");

// 引取日があとで変わると、日付を変えていない行は一緒に動き、手で決めた行は残して注意
await act(staff, () => actions.updateProduction(form({ key: "ev:ev_imp", op: "date", date: d(7), back })));
await store.mutate((x) => {
  const o = x.orders.find((o2) => o2.id === "o_wp");
  o.handovers = o.handovers.map((h) => ({ ...h, pickupDate: d(6), deliveryDate: h.item === "tatami_omote" ? d(6) : h.deliveryDate }));
  const e = x.schedule.find((e2) => e2.id === "ev_imp");
  e.date = d(8);
});
eq(rowOf("ho:hv_tat")?.date, d(6), "引取日が変わると、日付を変えていない製造予定も動く");
ok(rowOf("ev:ev_imp")?.date === d(7) && rowOf("ev:ev_imp")?.warnings.some((w) => w.includes("引取日が変わりました")), "手で決めた製造日は残し、引取日が変わったことを知らせる");

// 繰り越し: 前日までの未完了は今日へ (まとめて)
eq(P.carryTarget(db(), d(-1), today), db().holidays.some((h) => h.date === today) ? P.nextWorkDay(db(), today) : today, "前日までの未完了の繰り越し先は今日");

// 手で足す・削除
r = await act(staff, () => actions.addProduction(form({ back, storeId: "koshi", title: "置き畳 (展示用)", spec: "表 さくら", qty: "4", herinashi: "4", date: d(3) })));
const man = rows().find((x) => x.source === "manual");
ok(r.msg?.includes("追加しました") && man?.date === d(3) && man.qty === 4 && man.herinashiSeen, `手で追加 (${r.msg ?? r.err})`);
r = await act(staff, () => actions.addProduction(form({ back, storeId: "koshi", title: "在庫の畳", undecided: "1" })));
ok(rows().some((x) => x.source === "manual" && x.name === "在庫の畳" && x.mode === "undecided"), "製造日未定で追加");
r = await act(staff, () => actions.addProduction(form({ back, storeId: "koshi", title: "" })));
ok(Boolean(r.err), "案件・内容がなければ断る");
r = await act(staff, () => actions.deleteProduction(form({ back, id: man.record.id })));
ok(r.msg?.includes("削除") && !rows().some((x) => x.key === man.key), "手で足した行は削除できる");
r = await act(staff, () => actions.deleteProduction(form({ back, id: rec.id })));
ok(Boolean(r.err) && db().tatamiProduction.some((x) => x.id === rec.id), "自動の行は削除できない (外すだけ)");
r = await act(staff, () => actions.updateProduction(form({ key: "ho:hv_tat", op: "cancel", back })));
ok(!P.productionView(rows(), q).inRange.some((x) => x.key === "ho:hv_tat"), "外した行は一覧に出ない");
r = await act(staff, () => actions.updateProduction(form({ key: "ho:hv_tat", op: "restore", back })));
ok(P.productionView(rows(), q).inRange.some((x) => x.key === "ho:hv_tat"), "予定に戻す");
r = await act(staff, () => actions.updateProduction(form({ key: "ho:unknown", op: "carry", back })));
ok(Boolean(r.err), "ない行の操作は断る");

// 受注の施工完了・納品済み → 製造済みとみなす
await store.mutate((x) => {
  x.orders.find((o) => o.id === "o_wp").status = "completed";
});
eq([rowOf("ho:hv_tat")?.status, rowOf("ho:hv_tat")?.autoDone], ["done", true], "施工完了の受注は製造済みとみなす");
const byDay = P.productionByDay(rows());
ok([...byDay.values()].every((t) => t.count >= 1), "日ごとの合計 (予定表のリンク)");

/* ================================================================== */
{
  // 使う材料 (畳表・畳縁・畳床の畳数。お客様のご質問 2026-11-23「その日に使う材料や減りが分かるところある？」)
  const room = (o) => ({ id: "r", work: "omote", qty: 6, ...o });
  const m = P.productionMaterials([
    { status: "planned", qty: 12, roomsSource: "order", rooms: [room({ omote: "きずな", heri: "マス菊" }), room({ work: "new", qty: 4, omote: "きずな", herinashi: true, doko: "建材床", dokoThickness: "55mm" })] },
    { status: "planned", qty: 6, roomsSource: "order", rooms: [room({ work: "ura", heri: "マス菊" })] },
    { status: "planned", qty: 8, roomsSource: "count", rooms: [] },
    { status: "cancelled", qty: 6, roomsSource: "order", rooms: [room({ omote: "銀白" })] },
    { status: "done", qty: 3, roomsSource: "auto", rooms: [room({ qty: 3 })] },
  ]);
  eq(m.omote, [{ name: "きずな", qty: 10 }, { name: "畳表 未確認", qty: 3 }], "畳表は表替え・新調の畳数 (裏返しは今の表。取り消した行は数えない。品名なしは未確認)");
  eq(m.heri, [{ name: "マス菊", qty: 12 }, { name: "縁 未確認", qty: 3 }], "畳縁は裏返しも数える (縁無は別)");
  eq([m.herinashi, m.doko, m.unknown], [4, [{ name: "建材床 55mm", qty: 4 }], 8], "縁無・畳床 (新調だけ・厚みつき)・仕様のない行の畳数");
}

section("6. ヘッダーの件数の印 (承認の申請が届いたら画面を新しくする)");
const live = await imp("lib/notify-live.ts");
const s1 = live.liveSignature(admin);
await store.mutate((x) => {
  x.approvals.push({ id: "ap_live", type: "quote", targetId: "q_wp", title: "テストの承認", amount: 1000, storeId: "koshi", requestedBy: staff.id, requiredRole: "admin", status: "pending", createdAt: new Date().toISOString() });
});
const s2 = live.liveSignature(admin);
ok(s1.sig !== s2.sig && s2.approvals === s1.approvals + 1, `承認の申請が増えると印と件数が変わる (${s1.approvals} → ${s2.approvals})`);
eq(live.liveSignature(admin).sig, s2.sig, "変わらなければ同じ印 (画面を読み直さない)");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
