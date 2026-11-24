/**
 * 受注の品目ごとの引取日・納品日 (src/lib/handover.ts・お客様のご要望 2026-11-23) のテスト
 *   node scripts/tests/schedule/handover.test.mjs   (npm run test:schedule)
 * 1. 明細から品目を見分ける (縁・引手・値引き・諸経費は品目にしない)
 * 2. 手書きの「引取日時」「納品日時」の読み取り (11/23 にお客様が入れた見積書の書き方)
 * 3. 日程の初期値 (表替えは当日納品、襖・障子・網戸・新調は後日)
 * 4. 入力の確かめ
 * 5. 登録と変更の区別 (はじめて入れる日程はすぐ反映、登録済みの日程の変更は承認)
 * 6. 予定表の予定 (引き取り・納品の日だけ。同じ時間の引き取りは 1 件。リフォームは施工期間)
 * 7. Server Action: 受注の画面で保存 → 予定表 / 変更の申請 → 承認 → 予定表が動く / 差戻し / 店長・管理者の申請 /
 *    予定表で日時を変えると申請 / 予定表から削除できない / 見積から受注にすると日程ができる
 * AI・外部への送信は使わない。データは一時フォルダーの JSON (サンプルデータ)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-handover-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "handover-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-handover",
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

const H = await imp("lib/handover.ts");
/** 行の要約: 品目|引取日|開始|終了|納品日|開始|終了 (後ろの空欄は省く) */
const brief = (rows) => rows.map((r) => [r.item, r.pickupDate ?? "", r.pickupStart ?? "", r.pickupEnd ?? "", r.deliveryDate ?? "", r.deliveryStart ?? "", r.deliveryEnd ?? ""].join("|").replace(/\|+$/, ""));

/* ================================================================== */
section("1. 明細から品目を見分ける");
eq(H.classifyLine("畳表替え きずな"), "tatami_omote", "畳表替え → 畳 表替え");
eq(H.classifyLine("表替え 銀白 100A 半畳"), "tatami_omote", "「表替え」だけでも畳 表替え");
eq(H.classifyLine("畳 新調 (国産)"), "tatami_new", "新調 → 畳 新調");
eq(H.classifyLine("畳 裏返し"), "tatami_ura", "裏返し → 畳 裏返し");
eq(H.classifyLine("フスマ 両面 のぞみ160"), "fusuma", "フスマ → 襖");
eq(H.classifyLine("雪見障子とガラス交換"), "shoji", "障子");
eq(H.classifyLine("アミ戸 18メ グレー 大"), "amido", "アミ戸 → 網戸");
eq([H.classifyLine("畳縁 アラベスク510"), H.classifyLine("ヘリ 倉 四季90"), H.classifyLine("引手 S-109"), H.classifyLine("DM値引"), H.classifyLine("諸経費"), H.classifyLine("金券値引き")], [undefined, undefined, undefined, undefined, undefined, undefined], "縁・ヘリ・引手・値引き・諸経費・金券は品目にしない");
eq(H.classifyLine("クロス張替え 6畳"), "reform", "クロス → リフォーム (施工期間)");
eq(H.classifyLine("品名なし", "fusuma"), "fusuma", "言葉で決まらなければ商品の分類");
eq([H.classifyLine("畳表替え 6畳間"), H.classifyLine("和室8畳 襖 張替え")], ["tatami_omote", "fusuma"], "「6畳」「8畳」は部屋の広さとして見る");
ok(H.hasHandoverItems([{ name: "畳表替え" }]) && !H.hasHandoverItems([{ name: "クロス張替え" }]) && H.hasHandoverItems([], "tatami") && !H.hasHandoverItems([], "cloth"), "引取・納品で載せる受注か (リフォームだけは今までどおり)");

/* ================================================================== */
section("2. 手書きの日時の読み取り (11/23 の見積書の書き方)");
const ref = "2026-11-23";
const p1 = H.parseScheduleText("12/2(水) 8:30-9:00 襖引取 12/4畳表替え AM", ref);
eq(p1.map((c) => [c.date, c.start ?? "", c.end ?? "", c.kinds.join()]), [["2026-12-02", "08:30", "09:00", "fusuma"], ["2026-12-04", "", "", "tatami"]], "日付が 2 つ → 日付ごとに分け、後ろの言葉がその日の品目");
const p2 = H.parseScheduleText("畳 一日仕上 15:00〜17:00、襖 12/4", ref);
eq(p2.map((c) => [c.date ?? "", c.start ?? "", c.end ?? "", c.kinds.join(), c.sameDay]), [["", "15:00", "17:00", "tatami", true], ["2026-12-04", "", "", "fusuma", false]], "読点で分け、畳は一日仕上 (当日)、襖は 12/4");
const p3 = H.parseScheduleText("12/11 8時半〜9時", ref);
eq([p3[0].date, p3[0].start, p3[0].end], ["2026-12-11", "08:30", "09:00"], "「8時半〜9時」");
const p4 = H.parseScheduleText("12/11 3時〜5時", ref);
eq([p4[0].start, p4[0].end], ["15:00", "17:00"], "「3時〜5時」は午後 (15:00–17:00)");
eq(H.parseScheduleText("1/10", ref)[0].date, "2027-01-10", "年をまたぐ (11 月に書いた 1/10 は翌年)");
eq(H.parseScheduleText("11/20", ref)[0].date, "2026-11-20", "少し前の日付は同じ年");
eq(H.parseScheduleText("翌日 PM", ref)[0].nextDay, true, "翌日");
eq(H.parseScheduleText("", ref), [], "空");
eq(H.parseScheduleText("12/3 畳、障子", ref).map((c) => [c.date, c.kinds.join()]), [["2026-12-03", "tatami"], ["2026-12-03", "shoji"]], "「12/3 畳、障子」: 読点のあとの品目も同じ日 (宮原様の書き方)");
const pm = H.parseScheduleText("12/12 PM2-5", ref)[0];
eq([pm.date, pm.start, pm.end], ["2026-12-12", "14:00", "17:00"], "「PM2-5」は 14:00–17:00 (馬氷様の書き方)");
eq(H.parseScheduleText("午前9〜11", ref)[0].start, "09:00", "「午前9〜11」");

/* ================================================================== */
section("3. 日程の初期値");
const s1 = H.suggestHandovers({ ref, lines: [{ name: "畳表替え", spec: "きずな", qty: 16, unit: "畳" }, { name: "襖張替え", spec: "みやこ", qty: 4, unit: "" }, { name: "DM値引", qty: 10 }, { name: "諸経費", qty: 1, unit: "式" }, { name: "畳縁", qty: 16, unit: "畳" }], pickupText: "12/2 8:30〜9:00", deliveryText: "畳 一日仕上 15:00〜17:00、襖 12/4" });
eq(brief(s1), ["tatami_omote|2026-12-02|08:30|09:00|2026-12-02|15:00|17:00", "fusuma|2026-12-02|08:30|09:00|2026-12-04"], "島田様の書き方: 畳は当日 15–17 時、襖は 12/4 納品・引き取りは同じ時間");
eq(s1.map((r) => H.handoverLabel(r)), ["畳 表替え 16畳", "襖"], "名前に数量 (単位がないときは出さない)");
const s2 = H.suggestHandovers({ ref, lines: [{ name: "襖 張替え", qty: 4, unit: "面" }, { name: "畳表替え", qty: 6, unit: "枚" }], pickupText: "12/2(水) 8:30-9:00 襖引取 12/4畳表替え AM", deliveryText: "12/4(金)" });
eq(brief(s2), ["fusuma|2026-12-02|08:30|09:00|2026-12-04", "tatami_omote|2026-12-04|||2026-12-04"], "倉本様の書き方: 襖は 12/2 引取 → 12/4 納品、畳は 12/4 引取・当日納品");
const s3 = H.suggestHandovers({ ref, lines: [{ name: "フスマ", qty: 6, unit: "面" }, { name: "障子", qty: 2, unit: "枚" }, { name: "アミ戸", qty: 1 }, { name: "引手", qty: 18 }], pickupDate: "2026-11-30" });
eq(brief(s3), ["fusuma|2026-11-30", "shoji|2026-11-30", "amido|2026-11-30"], "襖・障子・網戸: 引取日だけ (納品日は後日に入れる)");
const s4 = H.suggestHandovers({ ref, lines: [{ name: "畳 新調", qty: 6, unit: "枚" }, { name: "畳表替え", qty: 2, unit: "枚" }], pickupDate: "2026-12-05" });
eq(brief(s4), ["tatami_new|2026-12-05", "tatami_omote|2026-12-05|||2026-12-05"], "新調は後日 (空)、表替えは当日納品");
const s5 = H.suggestHandovers({ ref, lines: [{ name: "畳表替え", qty: 6, unit: "枚" }], pickupText: "12/2 9:00", pickupDate: "2026-12-03" });
eq(brief(s5), ["tatami_omote|2026-12-03|09:00||2026-12-03"], "入力した引取日は手書きの日付より優先 (時刻は手書きから)");
const s6 = H.suggestHandovers({ ref, lines: [{ name: "畳表替え", qty: 6, unit: "枚" }, { name: "クロス張替え", qty: 1, unit: "式" }], fallbackPickup: "2026-12-05", endDate: "2026-12-08" });
eq(brief(s6), ["tatami_omote|2026-12-05|||2026-12-05", "reform|2026-12-05|||2026-12-08"], "以前の施工期間から: 畳は開始日に当日納品、リフォームは期間");
eq(brief(H.suggestHandovers({ ref, lines: [], category: "fusuma", pickupDate: "2026-12-01" })), ["fusuma|2026-12-01"], "明細のない受注は種別から");

/* ================================================================== */
section("4. 入力の確かめ");
const row = (o) => ({ id: "hv_abc123", item: "tatami_omote", ...o });
ok(H.cleanHandovers([row({ pickupDate: "2026-12-02", deliveryDate: "2026-12-01" })]).error?.includes("納品日は引取日以降"), "納品日が引取日より前は誤り");
ok(H.cleanHandovers([row({ pickupStart: "09:00" })]).error?.includes("日付を入力"), "時間だけで日付がないのは誤り");
ok(H.cleanHandovers([row({ pickupDate: "2026-12-02", pickupStart: "10:00", pickupEnd: "09:00" })]).error?.includes("終了時刻"), "終わりが始まりより前は誤り");
ok(H.cleanHandovers([row({ pickupDate: "2026-12-02", pickupStart: "15:00", deliveryDate: "2026-12-02", deliveryStart: "09:00" })]).error?.includes("当日納品の時刻"), "当日納品が引き取りより前の時刻は誤り");
ok(H.cleanHandovers([row({ pickupDate: "2026-02-30" })]).error?.includes("日付"), "ない日付は誤り");
eq(H.cleanHandovers([{ id: "bad id", item: "fusuma", pickupDate: "2026-12-02", junk: 1 }, { item: "nope" }]).rows.map((r) => [r.id.startsWith("hv_"), r.item, Object.keys(r).join()]), [[true, "fusuma", "id,item,pickupDate"]], "正しくない ID は付け直し・知らない項目と品目のない行は省く");
eq(H.cleanHandovers([{ id: "hv_abc123", item: "reform", pickupDate: "2026-12-05", deliveryDate: "2026-12-05", deliveryStart: "09:00" }]).rows[0], { id: "hv_abc123", item: "reform", pickupDate: "2026-12-05" }, "施工: 終了日が開始日と同じなら省く・終了日の時刻は使わない");
ok(H.sameHandovers([{ item: "fusuma", id: "hv_abc123", pickupDate: "2026-12-02" }], [{ id: "hv_abc123", pickupDate: "2026-12-02", item: "fusuma" }]), "キーの順番が違っても同じ日程 (データベースの jsonb)");

/* ================================================================== */
section("5. 登録と変更の区別");
const base = [
  { id: "hv_tatami1", item: "tatami_omote", label: "畳 表替え 6枚", pickupDate: "2026-12-02", pickupStart: "08:30", pickupEnd: "09:00", deliveryDate: "2026-12-02", deliveryStart: "15:00" },
  { id: "hv_fusuma1", item: "fusuma", pickupDate: "2026-12-02", pickupStart: "08:30", pickupEnd: "09:00" },
];
let d = H.handoverDiff([], base);
ok(!d.needsApproval && d.registered.length === 2 && H.sameHandovers(d.immediate, base), "はじめての登録: すべてすぐ反映");
d = H.handoverDiff(base, base.map((r) => (r.id === "hv_fusuma1" ? { ...r, deliveryDate: "2026-12-04" } : r)));
ok(!d.needsApproval && d.registered.some((x) => x.includes("襖 の納品")) && d.immediate[1].deliveryDate === "2026-12-04", "空だった納品日を入れる: 登録 (承認なし)");
const fus = { ...base[1], deliveryDate: "2026-12-04" };
const base2 = [base[0], fus];
d = H.handoverDiff(base2, [base2[0], { ...fus, deliveryDate: "2026-12-05" }]);
ok(d.needsApproval && d.immediate[1].deliveryDate === "2026-12-04" && d.changed[0] === "襖 の納品: 12/4(金) → 12/5(土)", "登録済みの納品日の変更: 承認 (それまでは前の日)");
d = H.handoverDiff(base2, [{ ...base2[0], deliveryStart: "16:00" }, fus]);
ok(d.needsApproval && d.changed[0].includes("15:00 → 12/2(水) 16:00"), "時間だけの変更も承認");
d = H.handoverDiff(base2, [{ ...base2[0], label: "畳 表替え 8枚" }, fus]);
ok(!d.needsApproval && d.immediate[0].label === "畳 表替え 8枚", "名前だけの変更は承認なし");
d = H.handoverDiff(base2, [base2[0]]);
ok(d.needsApproval && d.immediate.length === 2 && d.changed[0].startsWith("襖 を削除"), "日程のある品目の削除: 承認 (それまでは残す)");
d = H.handoverDiff([...base2, { id: "hv_amido01", item: "amido" }], base2);
ok(!d.needsApproval && d.immediate.length === 2, "日程のない品目の削除は承認なし");
d = H.handoverDiff(base2, [{ ...base2[0], pickupDate: "2026-12-03", deliveryDate: "2026-12-03" }, { ...fus, deliveryStart: "10:00" }, { id: "hv_shoji01", item: "shoji", pickupDate: "2026-12-03" }]);
ok(d.needsApproval && d.changed.length === 3 && d.registered.length === 1 && d.immediate.length === 3 && d.immediate[0].pickupDate === "2026-12-02" && d.immediate[2].pickupDate === "2026-12-03", "登録と変更が混ざる: 新しい品目はすぐ・変更は承認");
eq(H.handoverChangeLines(base2, [{ ...base2[0], pickupDate: "2026-12-03", deliveryDate: "2026-12-03" }, { id: "hv_shoji01", item: "shoji", pickupDate: "2026-12-03" }]), ["畳 表替え 6枚 の引取: 12/2(水) 8:30–9:00 → 12/3(木) 8:30–9:00", "畳 表替え 6枚 の納品: 12/2(水) 15:00 → 12/3(木) 15:00", "障子 を追加: 引取 12/3(木) → 納品 未定", "襖 を削除 (引取 12/2(水) 8:30–9:00 → 納品 12/4(金))"], "変更の内容の文 (承認の画面・通知)");

/* ================================================================== */
section("6. 予定表の予定");
const g = H.handoverGroups(base2);
eq(g.map((x) => [x.role, x.date, x.start ?? "", x.labels.join("・")]), [["pickup", "2026-12-02", "08:30", "畳 表替え 6枚・襖"], ["delivery", "2026-12-02", "15:00", "畳 表替え 6枚"], ["delivery", "2026-12-04", "", "襖"]], "引き取りは 1 件にまとめ、納品は畳 (当日) と襖 (後日) の 2 件。間の日 (12/3) には何もない");
eq(H.handoverSpan(base2), { start: "2026-12-02", end: "2026-12-04" }, "受注の施工予定 (最初の日・最後の日)");
const gi = H.handoverGroups([{ id: "hv_reform1", item: "reform", label: "クロス", pickupDate: "2026-12-05", deliveryDate: "2026-12-08", pickupStart: "09:00", pickupEnd: "15:00" }]);
eq(gi.map((x) => [x.role, x.date, x.endDate, x.start]), [["install", "2026-12-05", "2026-12-08", "09:00"]], "リフォームは施工期間の予定 1 件 (今までどおり)");
eq(H.parseHandoverRef(H.handoverRef(g[0])), { role: "pickup", rowIds: ["hv_tatami1", "hv_fusuma1"] }, "予定の印 (sourceRef) の読み書き");
eq(H.applyEventMove(base2, { role: "delivery", rowIds: ["hv_fusuma1"] }, { date: "2026-12-06", start: "10:00", end: "11:00" })[1], { ...fus, deliveryDate: "2026-12-06", deliveryStart: "10:00", deliveryEnd: "11:00" }, "予定表で納品を動かす → その品目の納品だけ変わる");

/* ================================================================== */
section("6b. 午前 (AM)・午後 (PM) (お客様のご要望 2026-11-23「引取日・納品日の設定について（追加）」)");
eq(H.parseScheduleText("12/4 AM", ref).map((c) => [c.date, c.start ?? "", c.slot ?? ""]), [["2026-12-04", "", "am"]], "「12/4 AM」→ 午前");
eq(H.parseScheduleText("翌日 午後", ref).map((c) => [c.nextDay, c.slot]), [[true, "pm"]], "「翌日 午後」→ 翌日の午後");
eq(H.parseScheduleText("12/4 午前中", ref)[0].slot, "am", "「午前中」→ 午前");
eq(H.parseScheduleText("12/4 PM", ref)[0].slot, "pm", "「PM」→ 午後");
eq(H.parseScheduleText("12/4 午前9〜11", ref).map((c) => [c.start, c.end, c.slot ?? ""]), [["09:00", "11:00", ""]], "時刻があれば時刻 (午前・午後は使わない)");
eq(H.parseScheduleText("12/4 AM・PM", ref)[0].slot, undefined, "午前と午後の両方は決めない");
eq(H.parseScheduleText("12/4 アミ戸 CAMERA", ref)[0].slot, undefined, "英字の言葉の一部 (CAMERA の AM) は午前にしない");
const sAm = H.suggestHandovers({ ref, lines: [{ name: "畳表替え", qty: 6, unit: "枚" }, { name: "襖張替え", qty: 4, unit: "面" }], pickupText: "12/2 AM", deliveryText: "畳 当日 PM、襖 12/9 午前" });
eq(sAm.map((r) => [r.item, r.pickupDate, r.pickupSlot ?? "", r.deliveryDate ?? "", r.deliverySlot ?? ""]), [["tatami_omote", "2026-12-02", "am", "2026-12-02", "pm"], ["fusuma", "2026-12-02", "am", "2026-12-09", "am"]], "手書きの「AM」「PM」「午前」→ 引取・納品の時間帯");
// 入力の確かめ
const rowS = (o) => ({ id: "hv_slot01", item: "fusuma", ...o });
eq(H.cleanHandovers([rowS({ pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09", deliverySlot: "pm" })]).rows[0], { id: "hv_slot01", item: "fusuma", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09", deliverySlot: "pm" }, "午前・午後を保存できる");
eq(H.cleanHandovers([rowS({ pickupDate: "2026-12-02", pickupStart: "09:00", pickupSlot: "pm" })]).rows[0], { id: "hv_slot01", item: "fusuma", pickupDate: "2026-12-02", pickupStart: "09:00" }, "時刻と時間帯が両方あれば時刻 (時間帯は省く)");
ok(H.cleanHandovers([rowS({ pickupSlot: "am" })]).error?.includes("日付を入力"), "時間帯だけで日付がないのは誤り");
ok(H.cleanHandovers([rowS({ pickupDate: "2026-12-02", pickupSlot: "evening" })]).error?.includes("午前 (AM) か午後 (PM)"), "午前・午後以外の時間帯は誤り");
ok(H.cleanHandovers([rowS({ item: "tatami_omote", pickupDate: "2026-12-02", pickupSlot: "pm", deliveryDate: "2026-12-02", deliverySlot: "am" })]).error?.includes("当日納品の時間が引き取りの時間より前"), "当日納品: 引き取り 午後 → 納品 午前 は誤り");
ok(H.cleanHandovers([rowS({ item: "tatami_omote", pickupDate: "2026-12-02", pickupStart: "13:00", deliveryDate: "2026-12-02", deliverySlot: "am" })]).error?.includes("当日納品"), "当日納品: 引き取り 13:00 → 納品 午前 は誤り");
ok(!H.cleanHandovers([rowS({ item: "tatami_omote", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-02", deliverySlot: "pm" })]).error, "当日納品: 午前に引き取り → 午後に納品 はよい");
ok(!H.cleanHandovers([rowS({ item: "tatami_omote", pickupDate: "2026-12-02", pickupStart: "10:00", deliveryDate: "2026-12-02", deliverySlot: "am" })]).error, "当日納品: 10:00 に引き取り → 午前のうちに納品 はよい");
ok(!H.cleanHandovers([rowS({ item: "tatami_omote", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-03", deliverySlot: "am" })]).error, "別の日なら午前 → 午前 でもよい");
eq(H.cleanHandovers([{ id: "hv_reform2", item: "reform", pickupDate: "2026-12-05", pickupSlot: "pm", deliveryDate: "2026-12-07", deliverySlot: "am" }]).rows[0], { id: "hv_reform2", item: "reform", pickupDate: "2026-12-05", pickupSlot: "pm", deliveryDate: "2026-12-07" }, "施工: 各日の時間帯 (午後) を持つ・終了日の時間帯は使わない");
// 表示・登録と変更
const slotBase = [{ id: "hv_fus001", item: "fusuma", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09", deliverySlot: "pm" }];
eq(H.rowText(slotBase[0]), "引取 12/2(水) 午前 → 納品 12/9(水) 午後", "日程の文に午前・午後");
d = H.handoverDiff(slotBase, [{ ...slotBase[0], deliverySlot: "am" }]);
ok(d.needsApproval && d.changed[0] === "襖 の納品: 12/9(水) 午後 → 12/9(水) 午前", "登録済みの納品の午後 → 午前 の変更は承認");
d = H.handoverDiff([{ id: "hv_fus001", item: "fusuma", pickupDate: "2026-12-02" }], [{ id: "hv_fus001", item: "fusuma", pickupDate: "2026-12-02", deliveryDate: "2026-12-09", deliverySlot: "am" }]);
ok(!d.needsApproval && d.registered[0] === "襖 の納品: 12/9(水) 午前", "はじめて入れる納品 (午前) はすぐ反映");
// 予定表の予定
const gs = H.handoverGroups([
  { id: "hv_tat001", item: "tatami_omote", pickupDate: "2026-12-02", pickupSlot: "pm", deliveryDate: "2026-12-02", deliverySlot: "pm" },
  { id: "hv_fus001", item: "fusuma", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09", deliverySlot: "pm" },
  { id: "hv_sho001", item: "shoji", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09", deliverySlot: "pm" },
  { id: "hv_ami001", item: "amido", pickupDate: "2026-12-02", pickupStart: "10:00", deliveryDate: "2026-12-10" },
]);
eq(gs.map((x) => [x.role, x.date.slice(5), x.start ?? x.slot ?? "", x.labels.join("・")]), [["pickup", "12-02", "am", "襖・障子"], ["pickup", "12-02", "10:00", "網戸"], ["pickup", "12-02", "pm", "畳 表替え"], ["delivery", "12-02", "pm", "畳 表替え"], ["delivery", "12-09", "pm", "襖・障子"], ["delivery", "12-10", "", "網戸"]], "同じ日・同じ時間帯 (午前) の引き取りは 1 件、時間帯が違えば別の予定 (午前 → 10:00 → 午後の順)");
eq(H.applyEventMove(slotBase, { role: "delivery", rowIds: ["hv_fus001"] }, { date: "2026-12-10", slot: "am" })[0], { ...slotBase[0], deliveryDate: "2026-12-10", deliverySlot: "am" }, "予定表で納品を 12/10 午前へ → 品目の納品も午前");
eq(H.applyEventMove(slotBase, { role: "pickup", rowIds: ["hv_fus001"] }, { date: "2026-12-02", start: "09:00", end: "10:00", slot: "am" })[0], { id: "hv_fus001", item: "fusuma", pickupDate: "2026-12-02", pickupStart: "09:00", pickupEnd: "10:00", deliveryDate: "2026-12-09", deliverySlot: "pm" }, "時刻を入れたら午前・午後は外す");
ok(!H.sameHandovers(slotBase, [{ ...slotBase[0], deliverySlot: "am" }]) && H.sameHandovers(slotBase, [{ deliverySlot: "pm", ...slotBase[0] }]), "午前・午後の違いは違う日程として比べる");
eq(H.toFormRows(slotBase)[0].pickupSlot, "am", "受注の画面の初期値に時間帯");

/* ================================================================== */
section("6c. 襖・障子・網戸の同じ日程 (1 つの品目の日程をほかの品目にも)");
eq([H.isLinkedItem("fusuma"), H.isLinkedItem("shoji"), H.isLinkedItem("amido"), H.isLinkedItem("tatami_omote"), H.isLinkedItem("other")], [true, true, true, false, false], "まとめる品目は襖・障子・網戸");
const tg = [
  { id: "hv_fus001", item: "fusuma", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09" },
  { id: "hv_sho001", item: "shoji", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09" },
  { id: "hv_ami001", item: "amido", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-11", deliverySlot: "pm" },
  { id: "hv_tat001", item: "tatami_omote", pickupDate: "2026-12-02", pickupSlot: "am", deliveryDate: "2026-12-09" },
];
eq(H.linkedCluster(tg), ["hv_fus001", "hv_sho001"], "開いたとき: 同じ日程の襖・障子をまとめ、網戸 (納品が別の日) は個別・畳は対象外");
eq(H.linkedCluster([tg[0], tg[3]]), [], "襖・障子・網戸が 1 行ならまとめない");
eq(H.linkedCluster([tg[2], tg[0], tg[1]]), ["hv_fus001", "hv_sho001"], "いちばん多い組をまとめる (先の行が個別でも)");
eq(H.linkedCluster([{ id: "hv_fus001", item: "fusuma" }, { id: "hv_ami001", item: "amido" }]), ["hv_fus001", "hv_ami001"], "日程が空どうしもまとめる (あとで入れた日程がほかの品目にも入る)");
const sLink = H.suggestHandovers({ ref, lines: [{ name: "襖張替え", qty: 4, unit: "面" }, { name: "障子張替え", qty: 2, unit: "枚" }, { name: "網戸張替え", qty: 3, unit: "枚" }], pickupText: "12/2 AM", deliveryText: "襖 12/9 PM" });
eq(sLink.map((r) => [r.item, r.pickupSlot ?? "", r.deliveryDate ?? "", r.deliverySlot ?? ""]), [["fusuma", "am", "2026-12-09", "pm"], ["shoji", "am", "2026-12-09", "pm"], ["amido", "am", "2026-12-09", "pm"]], "手書きに襖の納品だけ → 障子・網戸にも同じ納品日 (同じ日程)");
eq(H.linkedCluster(sLink).length, 3, "初期値の襖・障子・網戸は 1 つにまとまる");
const sSplit = H.suggestHandovers({ ref, lines: [{ name: "襖張替え", qty: 4, unit: "面" }, { name: "網戸張替え", qty: 3, unit: "枚" }], pickupText: "12/2", deliveryText: "襖 12/9、網戸 12/12" });
eq(sSplit.map((r) => [r.item, r.deliveryDate]), [["fusuma", "2026-12-09"], ["amido", "2026-12-12"]], "品目ごとに書いてあれば品目ごとの日 (網戸だけ別の日)");
eq(H.linkedCluster(sSplit).length, 1, "別の日の網戸はまとめない");

/* ================================================================== */
section("7. Server Action (受注の画面・承認・予定表)");
const store = await imp("lib/db/store.ts");
const hvActions = await imp("lib/actions/handovers.ts");
const apActions = await imp("lib/actions/approvals.ts");
const schActions = await imp("lib/actions/schedule.ts");
const qActions = await imp("lib/actions/quotes.ts");
const notify = await imp("lib/notify/events.ts");
await store.syncDb();
const db = () => store.getDb();
const admin = db().users.find((u) => u.active && u.role === "admin");
const manager = db().users.find((u) => u.active && u.role === "store_manager" && u.storeId === "koshi");
const staff = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
ok(admin && manager && staff, "サンプルの社員 (管理者・合志店の店長・スタッフ)");

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

// 合志店のお客様の受注 (畳の表替え 6 枚 + 襖 4 面)。以前の形の「施工」の予定 (12/2〜12/4) がある
const cust = db().customers.find((c) => c.storeId === "koshi");
const now = new Date().toISOString();
const Y = Number(new Date().toISOString().slice(0, 4)) + 1;
const D = (md) => `${Y}-${md}`;
await store.mutate((d) => {
  d.quotes.push({ id: "q_hvtest", number: "Q-HV-1", version: 1, customerId: cust.id, storeId: "koshi", title: "畳表替え・襖張替え", category: "tatami", items: [{ id: "qi1", name: "畳表替え", spec: "きずな", qty: 6, unit: "枚", unitPrice: 13200, amount: 79200 }, { id: "qi2", name: "襖張替え", qty: 4, unit: "面", unitPrice: 14850, amount: 59400 }, { id: "qi3", name: "諸経費", qty: 1, unit: "式", unitPrice: 3300, amount: 3300 }], subtotal: 141900, discount: 0, tax: 12900, total: 141900, status: "approved", validUntil: D("12-31"), createdBy: staff.id, createdAt: now, updatedAt: now, orderId: "o_hvtest" });
  d.orders.push({ id: "o_hvtest", number: "O-HV-1", quoteId: "q_hvtest", customerId: cust.id, storeId: "koshi", title: "畳表替え・襖張替え", category: "tatami", contractDate: D("11-23"), total: 141900, status: "scheduled", scheduledStart: D("12-02"), scheduledEnd: D("12-04"), workerIds: [staff.id], siteAddress: cust.address ?? "", progressNotes: [], createdBy: staff.id, createdAt: now, updatedAt: now, siteInfo: { pickupAt: "12/2 8:30〜9:00", deliveryAt: "畳 一日仕上 15:00〜17:00、襖 12/4" } });
  d.schedule.push({ id: "ev_hvlegacy", title: `${cust.name} 様 畳表替え・襖張替え 施工`, kind: "install", date: D("12-02"), endDate: D("12-04"), startTime: "09:00", endTime: "15:00", storeId: "koshi", assigneeIds: [staff.id], customerId: cust.id, orderId: "o_hvtest", quoteId: "q_hvtest", source: "order", createdAt: now });
});
const order = () => db().orders.find((o) => o.id === "o_hvtest");
const events = () => db().schedule.filter((e) => e.orderId === "o_hvtest").sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
const evBrief = () => events().map((e) => [e.kind, e.date.slice(5), e.startTime ?? "", e.endDate ? e.endDate.slice(5) : ""].join(" ").trim());
const SP = await imp("lib/handover-save.ts");
ok(SP.usesHandoverPlan(db(), order()), "畳・襖の受注は品目ごとの日程で扱う");
const suggested = SP.suggestOrderHandovers(db(), order());
eq(brief(suggested), [`tatami_omote|${D("12-02")}|08:30|09:00|${D("12-02")}|15:00|17:00`, `fusuma|${D("12-02")}|08:30|09:00|${D("12-04")}`], "受注の画面の初期値 (手書きの日時から)");

// a) はじめての保存 (スタッフ): すぐ反映。以前の「施工」(12/2〜12/4 の毎日) は引き取り・納品の日だけに置き換わる
let r = await act(staff, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(suggested), workerIds: [staff.id] })));
ok(r.path === "/orders/o_hvtest" && r.msg?.includes("予定表に反映") && !r.err, "保存すると「予定表に反映しました」");
eq(evBrief(), ["pickup 12-02 08:30", "delivery 12-02 15:00", "delivery 12-04"], "予定表: 12/2 の引き取り (畳・襖 1 件)・12/2 の畳の納品・12/4 の襖の納品だけ (12/3 には出ない)");
ok(!events().some((e) => e.kind === "install") && events().some((e) => e.id === "ev_hvlegacy"), "以前の「施工」の予定は置き換え (予定の ID は使い回す)");
ok(events()[0].title.includes("引き取り (畳 表替え 6枚・襖 4面)") && events()[2].title.includes("納品 (襖 4面)"), "件名に品目と数量 (作業日報の枚数の読み取りに使える)");
eq([order().scheduledStart, order().scheduledEnd, order().status], [D("12-02"), D("12-04"), "scheduled"], "受注の施工予定は最初の日〜最後の日");
ok(!db().approvals.some((a) => a.type === "handover_change"), "はじめての登録は承認なし");
const workReport = await imp("lib/schedule-capacity.ts");
eq(workReport.workOf(events()[0]), { tatami: 6, fusuma: 4, shoji: 0, amido: 0 }, "引き取りの件名から枚数を読める (畳 6・襖 4)");

// b) スタッフが襖の納品日を変える → 店長への申請。予定表は前のまま
const plan1 = order().handovers;
const fusId = plan1.find((x) => x.item === "fusuma").id;
const moved = plan1.map((x) => (x.id === fusId ? { ...x, deliveryDate: D("12-05"), deliveryStart: "10:00" } : x));
r = await act(staff, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(moved), workerIds: [staff.id], reason: "お客様のご都合" })));
const ap1 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending");
ok(r.msg?.includes("店長へ申請") && ap1?.requiredRole === "store_manager" && ap1.requestComment === "お客様のご都合" && ap1.amount === 0, "登録済みの納品日の変更 → 店長への承認の申請");
eq(evBrief(), ["pickup 12-02 08:30", "delivery 12-02 15:00", "delivery 12-04"], "承認まで予定表は前の日程のまま");
ok(order().progressNotes.some((p) => p.body.includes("引取・納品日の変更を申請") && p.body.includes("12/4") && p.body.includes("12/5")), "進捗に申請の内容 (前 → 後)");
// 店長のメールの知らせを受け取る設定 (サンプルの社員はデモ用のため、テストだけ社外の宛先にする)
await store.mutate((d) => Object.assign(d.users.find((u) => u.id === manager.id), { notifyByEmail: true, notifyEmail: "manager-test@example.org" }));
const notice = notify.approvalRequestNotices(db(), ap1);
ok(notice.length > 0 && notice.every((n) => n.body.includes("襖 4面 の納品") && !n.body.includes("金額")), "承認の依頼の知らせ: 変更の内容 (金額は出さない)");

// c) 承認待ちのあいだは保存できない
r = await act(staff, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(moved.map((x) => ({ ...x, label: x.label }))), workerIds: [staff.id] })));
ok(r.err?.includes("承認待ち"), "承認待ちのあいだの保存は断る");

// d) 店長が承認 → 予定表の襖の納品が 12/5 10:00 へ
r = await act(manager, () => apActions.decideApproval(ap1.id, "approved", form({ returnTo: "/approvals" })));
ok(!r.err, `店長が承認${r.err ? ` (${r.err})` : ""}`);
eq(evBrief(), ["pickup 12-02 08:30", "delivery 12-02 15:00", "delivery 12-05 10:00"], "承認で予定表の襖の納品が 12/5 10:00 に動く");
ok(order().handovers.find((x) => x.id === fusId).deliveryDate === D("12-05") && order().scheduledEnd === D("12-05"), "受注の日程と施工予定の最後の日も 12/5");
ok(order().progressNotes.some((p) => p.body.includes("引取・納品日の変更が承認されました")), "進捗に承認");

// e) 差戻し: 反映しない
const back1 = order().handovers.map((x) => (x.item === "tatami_omote" ? { ...x, pickupDate: D("12-03"), deliveryDate: D("12-03") } : x));
await act(staff, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(back1), workerIds: [staff.id] })));
const ap2 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending");
r = await act(manager, () => apActions.decideApproval(ap2.id, "returned", form({ returnTo: "/approvals", comment: "職人の都合がつかない" })));
ok(!r.err && db().approvals.find((a) => a.id === ap2.id).status === "returned", "差戻し");
eq(evBrief(), ["pickup 12-02 08:30", "delivery 12-02 15:00", "delivery 12-05 10:00"], "差し戻した変更は予定表に反映しない");

// f) 店長本人の変更 → 承認不要ですぐ反映 (お客様の決定 2026-11-24「追加 ①」: 店長の見積・受注の登録・変更は管理者の承認不要。記録は残る)
const mv2 = order().handovers.map((x) => (x.item === "tatami_omote" ? { ...x, deliveryStart: "16:00", deliveryEnd: undefined } : x));
r = await act(manager, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(mv2), workerIds: [staff.id] })));
const ap3 = db().approvals.filter((a) => a.type === "handover_change").at(-1);
ok(!db().approvals.some((a) => a.type === "handover_change" && a.status === "pending") && ap3?.status === "approved" && ap3.decisionComment?.includes("店長の申請"), `店長本人の変更は承認を省略 (承認の記録あり: ${r.msg ?? r.err})`);
ok(events().some((e) => e.kind === "delivery" && e.date === D("12-02") && e.startTime === "16:00"), "店長の変更 → 畳の納品がすぐ 16:00 に");

// g) 管理者の変更は承認を省略してすぐ反映 (記録は残る)
const mv3 = order().handovers.map((x) => (x.item === "fusuma" ? { ...x, deliveryDate: D("12-06") } : x));
r = await act(admin, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(mv3), workerIds: [staff.id] })));
const ap4 = db().approvals.filter((a) => a.type === "handover_change").at(-1);
ok(r.msg?.includes("承認を省略") && ap4.status === "approved" && ap4.decisionComment?.includes("管理者の申請") && events().some((e) => e.kind === "delivery" && e.date === D("12-06")), "管理者の変更: 承認を省略して反映 (承認の記録あり)");

// h) 古い申請: 申請のあとに日程が変わったら承認で上書きしない
const mv4 = order().handovers.map((x) => (x.item === "fusuma" ? { ...x, deliveryDate: D("12-07") } : x));
await act(staff, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(mv4), workerIds: [staff.id] })));
const ap5 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending");
await store.mutate((d) => {
  const o = d.orders.find((x) => x.id === "o_hvtest");
  o.handovers = o.handovers.map((x) => (x.item === "tatami_omote" ? { ...x, label: "畳 表替え 6枚 (変更)", pickupStart: "08:00" } : x));
});
r = await act(manager, () => apActions.decideApproval(ap5.id, "approved", form({ returnTo: "/approvals" })));
ok(r.err?.includes("申請のあとに引取・納品の日程が変更"), "申請のあとに日程が変わっていたら承認しない (古い内容で上書きしない)");
await act(staff, () => apActions.cancelApproval(ap5.id, form({ returnTo: "/approvals" })));
ok(db().approvals.find((a) => a.id === ap5.id).status === "cancelled", "申請者は取り下げられる");
await act(admin, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(order().handovers), workerIds: [staff.id] })));

// i) 予定表で納品の予定の日時を変える → 申請 (予定はそのまま)・メモはその場で保存
const fusDelivery = events().find((e) => e.kind === "delivery" && e.title.includes("襖"));
const evForm = (e, over) =>
  form({ kind: e.kind, title: e.title, date: e.date, endDate: e.endDate ?? "", startTime: e.startTime ?? "", endTime: e.endTime ?? "", storeId: e.storeId, assigneeIds: e.assigneeIds, memo: e.memo ?? "", location: e.location ?? "", caseRef: `order:${e.orderId}`, allowOverlap: "1", ...over });
r = await act(staff, () => schActions.updateScheduleEvent(fusDelivery.id, evForm(fusDelivery, { date: D("12-08"), startTime: "13:00", endTime: "14:00", memo: "襖紙の色を確認" })));
const ap6 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending");
const after6 = db().schedule.find((e) => e.id === fusDelivery.id);
ok(r.msg?.includes("店長へ申請") && ap6 && after6.date === fusDelivery.date && after6.memo === "襖紙の色を確認", "予定表で日時を変える → 申請 (承認まで日時はそのまま)・メモは保存");
ok(H.handoverChangeLines(ap6.changes[0].before, ap6.changes[0].after).some((l) => l.includes("の納品") && l.includes("13:00–14:00")), "申請の内容は品目の納品の日時の変更");
await act(manager, () => apActions.decideApproval(ap6.id, "approved", form({ returnTo: "/approvals" })));
ok(db().schedule.find((e) => e.id === fusDelivery.id)?.date === D("12-08") && db().schedule.find((e) => e.id === fusDelivery.id)?.memo === "襖紙の色を確認", "承認で予定表の同じ予定が動く (手で書いたメモは残る)");

// j) 予定表から削除 = 受注の日程からその日時を外す申請 (お客様のご要望 2026-11-24。案件・品目は残る)。ここでは取り下げて次の確認へ
r = await act(staff, () => schActions.deleteScheduleEvent(fusDelivery.id, form({})));
const apDel = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending");
ok(apDel && /申請しました/.test(r.msg ?? "") && db().schedule.some((e) => e.id === fusDelivery.id), "連動する予定の予定表からの削除は、受注の日程の変更の申請 (承認まで予定は残る)");
await act(staff, () => apActions.cancelApproval(apDel.id, form({ returnTo: "/approvals" })));
ok(db().approvals.find((a) => a.id === apDel.id)?.status === "cancelled", "削除の申請を取り下げられる (予定はそのまま)");

// k) 品目の削除 (日程あり) は承認、承認で予定も消える
const onlyTatami = order().handovers.filter((x) => x.item !== "fusuma");
await act(staff, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(onlyTatami), workerIds: [staff.id] })));
const ap7 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending");
ok(ap7 && events().some((e) => e.title.includes("襖")), "品目の削除は申請 (承認まで予定は残る)");
await act(manager, () => apActions.decideApproval(ap7.id, "approved", form({ returnTo: "/approvals" })));
eq(evBrief(), ["pickup 12-02 08:00", "delivery 12-02 16:00"], "承認で襖の予定が消え、畳の引き取り・納品だけ");
ok(events()[0].title.includes("引き取り (畳 表替え 6枚 (変更))") && !events()[0].title.includes("襖"), "引き取りの件名も畳だけに");

// l) 古い「施工予定」のフォームからは保存できない
const oa = await imp("lib/actions/orders.ts");
r = await act(staff, () => oa.updateOrderSchedule("o_hvtest", form({ scheduledStart: D("12-10"), allDay: "1" })));
ok(r.err?.includes("引取・納品の日程"), "日程のある受注は「施工予定・担当」から変えられない");

// m) ほかの店舗のスタッフは保存できない
const other = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId !== "koshi");
if (other) {
  r = await act(other, () => hvActions.saveOrderHandovers("o_hvtest", form({ handovers: JSON.stringify(order().handovers) })));
  ok(Boolean(r.err), "ほかの店舗のスタッフは保存できない");
}

// n) 見積から受注にする: 入れた日が引取日、表替えは当日納品、襖は後日
await store.mutate((d) => {
  d.quotes.push({ id: "q_hvtest2", number: "Q-HV-2", version: 1, customerId: cust.id, storeId: "koshi", title: "畳表替え・網戸", category: "tatami", items: [{ id: "qi1", name: "畳表替え", qty: 4, unit: "枚", unitPrice: 13200, amount: 52800 }, { id: "qi2", name: "網戸 張替え", qty: 2, unit: "枚", unitPrice: 3300, amount: 6600 }], subtotal: 59400, discount: 0, tax: 5400, total: 59400, status: "approved", validUntil: D("12-31"), createdBy: staff.id, createdAt: now, updatedAt: now });
});
r = await act(staff, () => qActions.convertQuoteToOrder("q_hvtest2", form({ scheduledStart: D("12-10"), workerIds: [staff.id] })));
const o2 = db().orders.find((o) => o.quoteId === "q_hvtest2");
eq(brief(o2?.handovers ?? []), [`tatami_omote|${D("12-10")}|||${D("12-10")}`, `amido|${D("12-10")}`], "見積から受注: 引取日 12/10、畳は当日納品、網戸の納品日は後で");
eq(db().schedule.filter((e) => e.orderId === o2.id).map((e) => [e.kind, e.date.slice(5)]).sort(), [["delivery", "12-10"], ["pickup", "12-10"]], "契約承認の前でも引き取り・納品の予定を押さえる (施工の予定は作らない)");

// o) リフォームだけの受注は今までどおり (施工期間の予定)
await store.mutate((d) => {
  d.orders.push({ id: "o_hvreform", number: "O-HV-3", customerId: cust.id, storeId: "koshi", title: "クロス張替え", category: "cloth", contractDate: D("11-23"), total: 99000, status: "confirmed", workerIds: [staff.id], siteAddress: "", progressNotes: [], createdBy: staff.id, createdAt: now, updatedAt: now });
});
ok(!SP.usesHandoverPlan(db(), db().orders.find((o) => o.id === "o_hvreform")), "リフォームだけの受注は施工予定のまま");
r = await act(staff, () => oa.updateOrderSchedule("o_hvreform", form({ scheduledStart: D("12-14"), scheduledEnd: D("12-16"), startTime: "09:00", endTime: "17:00", workerIds: [staff.id], allowOverlap: "1" })));
eq(db().schedule.filter((e) => e.orderId === "o_hvreform").map((e) => [e.kind, e.date.slice(5), e.endDate?.slice(5)]), [["install", "12-14", "12-16"]], "リフォーム: 施工期間 (12/14〜12/16) の「施工」の予定 (今までどおり)");

// p) 午前・午後 (AM・PM) と襖・障子・網戸の同じ日程: 保存 → 予定表の予定は午前・午後 (時刻未定) で 1 件にまとまる
await store.mutate((d) => {
  d.quotes.push({ id: "q_hvtest4", number: "Q-HV-4", version: 1, customerId: cust.id, storeId: "koshi", title: "襖・障子・網戸", category: "fusuma", items: [{ id: "qi1", name: "襖張替え", qty: 4, unit: "枚", unitPrice: 4000, amount: 16000 }, { id: "qi2", name: "障子張替え", qty: 2, unit: "枚", unitPrice: 2000, amount: 4000 }, { id: "qi3", name: "網戸張替え", qty: 3, unit: "枚", unitPrice: 3000, amount: 9000 }], subtotal: 29000, discount: 0, tax: 2636, total: 29000, status: "approved", validUntil: D("12-31"), createdBy: staff.id, createdAt: now, updatedAt: now, orderId: "o_hvtest4" });
  d.orders.push({ id: "o_hvtest4", number: "O-HV-4", quoteId: "q_hvtest4", customerId: cust.id, storeId: "koshi", title: "襖・障子・網戸", category: "fusuma", contractDate: D("11-23"), total: 29000, status: "confirmed", workerIds: [staff.id], siteAddress: "", progressNotes: [], createdBy: staff.id, createdAt: now, updatedAt: now, siteInfo: { pickupAt: "12/15 AM", deliveryAt: "12/18 PM" } });
});
const o4 = () => db().orders.find((o) => o.id === "o_hvtest4");
const ev4 = () => db().schedule.filter((e) => e.orderId === "o_hvtest4").sort((a, b) => a.date.localeCompare(b.date));
const plan4 = SP.suggestOrderHandovers(db(), o4());
eq(plan4.map((x) => [x.item, x.pickupDate?.slice(5), x.pickupSlot, x.deliveryDate?.slice(5), x.deliverySlot]), [["fusuma", "12-15", "am", "12-18", "pm"], ["shoji", "12-15", "am", "12-18", "pm"], ["amido", "12-15", "am", "12-18", "pm"]], "初期値: 手書きの「12/15 AM」「12/18 PM」→ 3 品目とも同じ日程");
r = await act(staff, () => hvActions.saveOrderHandovers("o_hvtest4", form({ handovers: JSON.stringify(plan4), workerIds: [staff.id], allowOverlap: "1" })));
ok(!r.err && r.msg?.includes("予定表に反映"), "保存 (はじめての登録はすぐ反映)");
eq(ev4().map((e) => [e.kind, e.date.slice(5), e.startTime ?? "", e.slot ?? ""]), [["pickup", "12-15", "", "am"], ["delivery", "12-18", "", "pm"]], "予定表: 12/15 午前の引き取り 1 件・12/18 午後の納品 1 件 (3 品目をまとめる)");
const cal = await imp("lib/calendar.ts");
eq(ev4().map((e) => cal.timeLabel(e)), ["午前", "午後"], "予定表の時間の表示は「午前」「午後」");
ok(ev4()[0].title.includes("襖") && ev4()[0].title.includes("障子") && ev4()[0].title.includes("網戸"), "引き取りの件名に 3 品目");
// 網戸だけ 12/19 午前の納品に変える → 申請 → 承認で網戸の納品だけ別の予定に
const amiId = o4().handovers.find((x) => x.item === "amido").id;
r = await act(staff, () => hvActions.saveOrderHandovers("o_hvtest4", form({ handovers: JSON.stringify(o4().handovers.map((x) => (x.id === amiId ? { ...x, deliveryDate: D("12-19"), deliverySlot: "am" } : x))), workerIds: [staff.id], allowOverlap: "1" })));
const ap8 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending" && a.targetId === "o_hvtest4");
ok(ap8 && H.handoverChangeLines(ap8.changes[0].before, ap8.changes[0].after).join() === `網戸 3枚 の納品: ${H.sideText({ id: amiId, item: "amido", deliveryDate: D("12-18"), deliverySlot: "pm" }, "delivery")} → ${H.sideText({ id: amiId, item: "amido", deliveryDate: D("12-19"), deliverySlot: "am" }, "delivery")}`, "網戸だけの変更の申請 (午後 → 午前)");
await act(manager, () => apActions.decideApproval(ap8.id, "approved", form({ returnTo: "/approvals" })));
eq(ev4().map((e) => [e.kind, e.date.slice(5), e.slot ?? "", e.title.includes("網戸") ? "網戸" : "襖・障子"]), [["pickup", "12-15", "am", "網戸"], ["delivery", "12-18", "pm", "襖・障子"], ["delivery", "12-19", "am", "網戸"]], "承認: 引き取りは 3 品目のまま 1 件、納品は襖・障子 12/18 午後と網戸 12/19 午前の 2 件");
// 予定表で襖・障子の納品を午後 → 午前に変える → 申請 (予定表の時間帯の変更も申請になる)
const fsDel = ev4().find((e) => e.kind === "delivery" && e.date === D("12-18"));
r = await act(staff, () => schActions.updateScheduleEvent(fsDel.id, evForm(fsDel, { slot: "am", startTime: "", endTime: "" })));
const ap9 = db().approvals.find((a) => a.type === "handover_change" && a.status === "pending" && a.targetId === "o_hvtest4");
ok(r.msg?.includes("店長へ申請") && ap9 && db().schedule.find((e) => e.id === fsDel.id).slot === "pm", "予定表で午後 → 午前 → 申請 (承認まで午後のまま)");
await act(manager, () => apActions.decideApproval(ap9.id, "approved", form({ returnTo: "/approvals" })));
ok(db().schedule.find((e) => e.id === fsDel.id)?.slot === "am" && o4().handovers.filter((x) => x.item !== "amido").every((x) => x.deliverySlot === "am"), "承認: 予定と襖・障子の納品が午前に");

console.log(`\n${pass} passed, ${fails.length} failed`);
fs.rmSync(work, { recursive: true, force: true });
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
