// 実行: npm run test:ops-reports (または node scripts/tests/ops-reports/ops-reports.test.mjs)
// 作業日報 (F-11) と販促・媒体の分析 (F-13) の回帰テスト。
// 作業日報は 2031 年の予定、分析は 2019 年の問い合わせ (サンプルデータにない期間) だけを使い、サンプルデータに左右されないようにする
import fs from "node:fs";
import path from "node:path";
import { imp, act, form, ok, eq, section, summary, root } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const WR = await imp("lib/ops-reports/work-report.ts");
const PA = await imp("lib/ops-reports/promo-analysis.ts");
const PI = await imp("lib/ops-reports/promo-input.ts");
const M = await imp("lib/media.ts");
const P = await imp("lib/auth/permissions.ts");
const AI = await imp("lib/actions/inquiries.ts");
const AW = await imp("lib/actions/work-reports.ts");
const AP = await imp("lib/actions/promotions.ts");

const db = store.getDb();
const save = () => store.mutate(() => undefined);
db.schedule = db.schedule.filter((e) => e.date < "2031-01-01");
db.workReportDays = [];
db.promotions = [];
db.settings = db.settings.filter((s) => s.id !== WR.WORK_REPORT_SETTINGS_ID && s.id !== M.MEDIA_MAPPING_ID);
await save();

const admin = db.users.find((u) => u.role === "admin" && u.active);
const koshiStaff = db.users.filter((u) => u.active && u.storeId === "koshi" && u.role === "store_staff");
const [A, B] = koshiStaff;
const C = db.users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_manager") ?? admin;
const chuoStaff = db.users.find((u) => u.active && u.storeId === "chuo" && u.role === "store_staff");
const chuoMgr = db.users.find((u) => u.active && u.storeId === "chuo" && u.role === "store_manager");
const now = new Date().toISOString();
let seq = 0;
const ev = (x) => ({ id: `ev_ops${++seq}`, title: "テスト", kind: "pickup", storeId: "koshi", assigneeIds: [], source: "manual", createdAt: now, createdBy: admin.id, ...x });

/* ------------------------------------------------------------------ */
section("作業日報: 予定表の引取・納品の件数と一致する");
const cust = { id: "cust_ops1", code: "C-OPS1", name: "田中 一郎", kana: "タナカ", type: "individual", phone: "090-0000-1111", postalCode: "", address: "熊本県合志市須屋1000-1", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now };
const order = { id: "o_ops1", number: "OR-2031-9001", customerId: cust.id, storeId: "koshi", title: "畳", category: "tatami", contractDate: "2031-05-01", total: 66000, status: "confirmed", workerIds: [], siteAddress: cust.address, progressNotes: [{ id: "pn_ops1", at: now, userId: admin.id, kind: "note", body: "明細 (税込): 畳 きずな 6×¥11,000" }], createdBy: admin.id, createdAt: now, updatedAt: now };
await store.mutate((d) => {
  d.customers.push(cust);
  d.orders.push(order);
  d.schedule.push(
    ev({ date: "2031-05-07", startTime: "09:00", endTime: "10:00", title: "山田様 畳 表替え6", assigneeIds: [A.id] }),
    ev({ date: "2031-05-07", slot: "pm", title: "鈴木様 引取", memo: "襖 新調2 / 障子 張替4", assigneeIds: [A.id, B.id] }),
    ev({ date: "2031-05-08", title: "佐藤様 網戸 3", assigneeIds: [B.id] }),
    ev({ date: "2031-05-09", title: "田中様 引取", orderId: order.id, customerId: cust.id }),
    ev({ date: "2031-05-12", kind: "delivery", title: "田中様 納品", orderId: order.id, customerId: cust.id }),
    ev({ date: "2031-05-12", kind: "delivery", title: "山田様 納品", assigneeIds: [C.id] }),
    ev({ date: "2031-05-07", storeId: "chuo", title: "中央店 畳 表替え8" }),
    ev({ date: "2031-05-10", kind: "survey", title: "現地調査 伊藤様", assigneeIds: [B.id] }),
    ev({ date: "2031-05-13", kind: "measure", title: "採寸 木村様" }),
    ev({ date: "2031-05-11", kind: "install", title: "網戸 施工 小林様" }),
    ev({ date: "2031-06-01", title: "6月の引取 畳 表替え4" }),
    ev({ date: "2031-05-07", kind: "meeting", title: "店舗の会議" }),
  );
});
{
  const r = WR.buildWorkReport(db, "koshi", "2031-05");
  const schedPickups = db.schedule.filter((e) => e.storeId === "koshi" && e.kind === "pickup" && e.date >= "2031-05-01" && e.date <= "2031-05-31").length;
  const schedDeliveries = db.schedule.filter((e) => e.storeId === "koshi" && e.kind === "delivery" && e.date >= "2031-05-01" && e.date <= "2031-05-31").length;
  eq(r.totals.pickup.count, schedPickups, `引取の件数 = 予定表の引き取りの件数 (${schedPickups})`);
  eq(r.totals.delivery.count, schedDeliveries, `納品の件数 = 予定表の納品の件数 (${schedDeliveries})`);
  eq([r.scheduleCounts.pickup, r.scheduleCounts.delivery], [4, 2], "照合用の件数 (他店舗・翌月の予定・会議は数えない)");
  eq([r.totals.survey, r.totals.install], [2, 1], "見積 (現地調査 + 採寸) と施工の件数");
  eq(r.days.length, 31, "1 か月 = 31 日の行");
  const pu = r.totals.pickup.units;
  eq([pu.tatamiOmote, pu.tatamiNew, pu.fusumaRe, pu.fusumaNew, pu.shojiRe, pu.shojiNew, pu.amidoRe, pu.amidoNew], [12, 0, 0, 2, 4, 0, 3, 0], "引取の枚数 (件名の表替え6・メモの襖 新調2 / 障子 張替4・網戸 3・受注の明細の畳 6)");
  eq(r.totals.delivery.units.tatamiOmote, 6, "納品の枚数を受注の明細から読む (件名に枚数のない納品)");
  const d07 = r.days.find((d) => d.date === "2031-05-07");
  eq(d07.pickups.map((l) => l.site), ["山田様 畳 表替え6", "鈴木様 引取"], "現場名 (お客様のない予定は件名)");
  eq(d07.pickups[1].assignees, [A.name, B.name], "担当 = 予定の担当者");
  eq(d07.pickups[1].time, "午後", "時刻のない午後の予定");
  const tanaka = r.days.find((d) => d.date === "2031-05-09").pickups[0];
  eq([tanaka.site, tanaka.source, tanaka.orderNumber], ["田中 一郎 様", "order", order.number], "お客様の名前と受注の明細から読んだこと");
  eq(r.noQty.map((l) => l.title), ["山田様 納品"], "枚数がわからない予定を知らせる");
  eq([r.people, r.workDays, r.personDays], [3, 4, 4], "人 (引取・納品の担当者)・日 (引取・納品のあった日)・人日");
  eq([r.tatami.total, r.tatami.perPerson, r.tatami.perDay, r.tatami.perPersonDay], [12, 4, 3, 3], "畳 総数 ／人 ／日 ／人日");
}

section("作業日報: 係数 (襖類の係数後)");
{
  const r = WR.buildWorkReport(db, "koshi", "2031-05");
  eq(r.factors, { fusuma: 1, shoji: 0.5, amido: 0.4 }, "既定の係数 = 障子 0.5・網戸 0.4");
  eq(r.fusumaWeighted.total, 5.2, "襖類 (係数後) = 襖 2 + 障子 4 × 0.5 + 網戸 3 × 0.4");
  const res = await act(admin, () => AW.saveWorkReportSettings(form({ storeId: "koshi", month: "2031-05", fusuma: "1", shoji: "1", amido: "0.5" })));
  ok(res.msg && !res.err, "管理者は係数を変更できる");
  eq(WR.buildWorkReport(db, "koshi", "2031-05").fusumaWeighted.total, 7.5, "変更した係数で計算する (2 + 4 + 1.5)");
  const denied = await act(A, () => AW.saveWorkReportSettings(form({ storeId: "koshi", month: "2031-05", fusuma: "1", shoji: "2", amido: "2" })));
  ok(denied.err?.includes("本部スタッフ・管理者"), "店舗スタッフは係数を変更できない");
  const bad = await act(admin, () => AW.saveWorkReportSettings(form({ storeId: "koshi", month: "2031-05", fusuma: "1", shoji: "abc", amido: "0.4" })));
  ok(bad.err?.includes("0〜10"), "数でない係数は断る");
  await act(admin, () => AW.saveWorkReportSettings(form({ storeId: "koshi", month: "2031-05", reset: "1" })));
  eq(WR.readWorkReportSettings(db).factors, { fusuma: 1, shoji: 0.5, amido: 0.4 }, "既定に戻す");
  ok(db.auditLogs.some((l) => l.entity === "settings" && l.entityId === WR.WORK_REPORT_SETTINGS_ID && l.changes?.length), "係数の変更は変更履歴に changes つきで残る");
  ok(WR.isNewWork({ id: "fusuma", name: "襖 張替", category: "fusuma" }, "襖 新調2") && !WR.isNewWork({ id: "fusuma", name: "襖 張替", category: "fusuma" }, "襖 張替2 / 障子 新調1"), "襖の「新」は襖の近くの言葉で見分ける");
}

section("作業日報: 手入力 (チラシの配布人・枚数・地域、来店数)");
const monthForm = (days) => {
  const f = {};
  for (let d = 1; d <= 31; d++) {
    const date = `2031-05-${String(d).padStart(2, "0")}`;
    const x = days[date] ?? {};
    f[`v_${date}`] = x.visitors ?? "";
    f[`n_${date}`] = x.note ?? "";
    const fl = x.flyers ?? [];
    f[`fn_${date}`] = fl.length + 1;
    fl.forEach((y, i) => Object.assign(f, { [`f_${date}_${i}_by`]: y.by ?? "", [`f_${date}_${i}_copies`]: y.copies ?? "", [`f_${date}_${i}_area`]: y.area ?? "" }));
  }
  return form({ storeId: "koshi", month: "2031-05", ...f });
};
{
  const r1 = await act(A, () => AW.saveWorkReportMonth(monthForm({ "2031-05-07": { visitors: "12", note: "雨", flyers: [{ by: A.name, copies: "1,500", area: "合志市須屋" }, { by: "アルバイト 田中", copies: "800", area: "合志市幾久富" }] }, "2031-05-20": { visitors: "3" } })));
  ok(r1.msg?.includes("2 日分"), `店舗スタッフが自店舗の 2 日分を保存 (${r1.msg ?? r1.err})`);
  const row = db.workReportDays.find((w) => w.id === "wr_koshi_2031-05-07");
  eq([row?.visitors, row?.note, row?.flyers.length, row?.flyers[0].copies, row?.flyers[0].userIds], [12, "雨", 2, 1500, [A.id]], "来店数・メモ・配布 (枚数のカンマ・社員の名前の一致)");
  eq(row?.flyers[1].userIds, [], "社員でない配布人は名前だけ");
  const r = WR.buildWorkReport(db, "koshi", "2031-05");
  eq([r.totals.flyerCopies, r.totals.flyerLines, r.totals.visitors, r.totals.visitorDays], [2300, 2, 15, 2], "日報の合計に反映");
  const rows = WR.sheetRows(r);
  const d07 = rows.filter((x) => x.day.date === "2031-05-07");
  eq([d07.length, d07[0].span, d07[0].flyer?.copies, d07[1].flyer?.area], [2, 2, 1500, "合志市幾久富"], "表の行 (引取 2 件・チラシ 2 行の日は 2 行)");
  ok(db.auditLogs.some((l) => l.entity === "work_report" && l.action === "create" && l.changes?.some((c) => c.field === "visitors")), "変更履歴 (作成) に changes がある");

  const again = await act(A, () => AW.saveWorkReportMonth(monthForm({ "2031-05-07": { visitors: "12", note: "雨", flyers: [{ by: A.name, copies: "1500", area: "合志市須屋" }, { by: "アルバイト 田中", copies: "800", area: "合志市幾久富" }] }, "2031-05-20": { visitors: "3" } })));
  ok(again.msg?.includes("変更はありません"), "同じ内容の保存は変更なし");
  const badCopies = await act(A, () => AW.saveWorkReportMonth(monthForm({ "2031-05-08": { flyers: [{ by: B.name, copies: "", area: "合志市" }] } })));
  ok(badCopies.err?.includes("枚数"), "配布人だけで枚数のない行は断る");
  const badNum = await act(A, () => AW.saveWorkReportMonth(monthForm({ "2031-05-08": { visitors: "-3" } })));
  ok(badNum.err?.includes("来店数"), "負の来店数は断る");
  eq(db.workReportDays.filter((w) => w.storeId === "koshi").length, 2, "断った保存では何も変わらない");
  const other = await act(chuoStaff, () => AW.saveWorkReportMonth(monthForm({ "2031-05-08": { visitors: "1" } })));
  ok(other.err?.includes("権限"), "他店舗のスタッフは入力できない");
  const cleared = await act(A, () => AW.saveWorkReportMonth(monthForm({ "2031-05-07": { visitors: "12", note: "雨", flyers: [{ by: A.name, copies: "1500", area: "合志市須屋" }, { by: "アルバイト 田中", copies: "800", area: "合志市幾久富" }] } })));
  ok(cleared.msg?.includes("1 日分") && !db.workReportDays.some((w) => w.id === "wr_koshi_2031-05-20"), "空にした日は行を消す");
  ok(db.auditLogs.some((l) => l.entity === "work_report" && l.action === "delete" && l.entityId === "wr_koshi_2031-05-20"), "削除も変更履歴に残る");
}

section("作業日報: CSV の行数");
{
  const r = WR.buildWorkReport(db, "koshi", "2031-05");
  const lines = WR.workLinesCsvRows(r);
  const kinds = (k) => lines.slice(1).filter((x) => x[2] === k).length;
  eq([kinds("引取"), kinds("納品"), kinds("見積"), kinds("施工"), kinds("チラシ"), kinds("来店")], [4, 2, 2, 1, 2, 1], "明細の CSV: 区分ごとの行数 = 予定表の件数・手入力の行数");
  const sheet = WR.workReportCsvRows(r, "合志店");
  eq(sheet[1], WR.SHEET_HEADER, "日報の並びの CSV の見出し");
  const body = sheet.slice(2, 2 + WR.sheetRows(r).length);
  eq(body.filter((x) => x[2] !== "").length, 4, "日報の並びの CSV: 引取の現場名の行 = 引取の件数");
  eq(body.filter((x) => x[20] !== "").length, 2, "日報の並びの CSV: 納品の現場名の行 = 納品の件数");
  ok(sheet.some((x) => x[0] === "畳" && x[2] === 12), "見出しの集計 (畳 総数) を最後に付ける");
}

/* ------------------------------------------------------------------ */
section("媒体: 全社共通の分類と、選ばない問い合わせは保存できない");
{
  ok(M.MEDIA_KEYS.includes("unknown") && M.MEDIA_LABEL.unknown === "不明", "選択肢に「不明」がある");
  const before = db.inquiries.length;
  const base = { contactName: "媒体 テスト", contactPhone: "090-9999-0001", channel: "phone", category: "tatami", summary: "畳の表替え", receivedAt: "2019-05-10T10:00", storeId: "koshi" };
  const none = await act(A, () => AI.createInquiry(form(base)));
  ok(none.err?.includes("媒体") && none.path === "/inquiries/new", "媒体を選ばない問い合わせは保存できない");
  eq(db.inquiries.length, before, "保存されていない");
  const blank = await act(A, () => AI.createInquiry(form({ ...base, media: "" })));
  ok(blank.err?.includes("媒体"), "「選んでください」のままでも保存できない");
  const unknown = await act(A, () => AI.createInquiry(form({ ...base, media: "unknown" })));
  const created = db.inquiries.find((i) => unknown.path === `/inquiries/${i.id}`);
  eq(created?.media, "unknown", "「不明」なら保存できる");
  // 問い合わせの登録で顧客も登録するため (2026-11-25)、別のお客様として別の電話番号にする (同じ番号は重複の確認で止まる)
  const text = await act(A, () => AI.createInquiry(form({ ...base, contactName: "媒体 テスト2", contactPhone: "090-9999-0002", media: "チラシ" })));
  eq(db.inquiries.find((i) => text.path === `/inquiries/${i.id}`)?.media, "flyer", "言葉 (AI アシスタントなど) は対応表で分類に読み替える");
  // 失敗した保存は元に戻す (rollback) ので、毎回データベースから引き直す
  const find = (id) => db.inquiries.find((i) => i.id === id);
  const upd = await act(A, () => AI.updateInquiry(created.id, form({ status: "new", category: "tatami", media: "" })));
  ok(upd.err?.includes("媒体") && find(created.id).media === "unknown", "更新でも媒体を空にできない");
  const upd2 = await act(A, () => AI.updateInquiry(created.id, form({ status: "new", category: "tatami", media: "referral" })));
  ok(upd2.msg && find(created.id).media === "referral", "更新で媒体を変えられる");
  ok(db.auditLogs.some((l) => l.entity === "inquiry" && l.entityId === created.id && l.changes?.some((c) => c.field === "media" && c.before === "unknown" && c.after === "referral")), "媒体の変更は変更履歴に changes つきで残る");
  const page = fs.readFileSync(path.join(root, "src/app/(app)/inquiries/new/page.tsx"), "utf8");
  ok(/<MediaSelect name="media" required/.test(page), "登録の画面の媒体の欄は必須 (required)");
  const detail = fs.readFileSync(path.join(root, "src/app/(app)/inquiries/[id]/page.tsx"), "utf8");
  ok(/<MediaSelect name="media" defaultValue=\{inq\.media \?\? ""\} required/.test(detail), "更新の画面の媒体の欄も必須");
  // テストで作った 2019 年の問い合わせは分析のテストの前に消す
  await store.mutate((d) => {
    d.inquiries = d.inquiries.filter((i) => !i.contactName.startsWith("媒体 テスト"));
  });
}

section("媒体: 過去の値の読み替え (対応表)");
{
  const rules = M.DEFAULT_MEDIA_RULES;
  const map = (t) => M.mapMediaText(rules, t);
  eq(["R", "HP", "MAP", "以前頼んだことがある", "ダイレクトメール", "グーグルマップ", "インスタ", "点検", "パンフ", "ホームページ", "口コミ", "看板", "その他"].map(map), ["repeat", "web", "map", "repeat", "dm", "map", "sns", "dm", "paper", "web", "referral", "store", "other"], "見積書の媒体欄・アンケートの ⑥ の値");
  eq([map("r"), map("ｈｐ"), map("新聞折込"), map("知人の紹介"), map("玉名店"), map("")], ["repeat", "web", "flyer", "referral", null, null], "全角・小文字・含む・当てはまらない値");
  ok(!map("CMS") && map("CM") === "tv_radio", "短い略号は同じ値のときだけ");
  const ix = M.mediaIndex({ ...db, quotes: [{ id: "q_m1", siteInfo: { media: ["チラシ"] } }, { id: "q_m2" }], orders: [{ id: "o_m1", quoteId: "q_m2", status: "confirmed", siteInfo: { media: ["紹介"] } }, { id: "o_m3", status: "completed", customerId: "c_m3" }], surveys: [{ id: "s_m1", orderId: "o_m4", mediaList: ["グーグルマップ", "チラシ"] }], customers: [{ id: "c_m1", tags: ["媒体:ホームページ"] }, { id: "c_m3", tags: ["区分:一般", "媒体:R"] }] });
  eq(M.inquiryMedia(ix, { media: "event", quoteId: "q_m1", channel: "phone" }), { media: "event", source: "input" }, "入力があれば入力");
  eq(M.inquiryMedia(ix, { quoteId: "q_m1", channel: "phone" }).source, "quote", "見積の媒体欄から");
  eq(M.inquiryMedia(ix, { quoteId: "q_m2", channel: "phone" }).media, "referral", "受注の媒体欄から");
  eq(M.inquiryMedia(ix, { customerId: "c_m1", channel: "phone" }), { media: "web", source: "customer", raw: "媒体:ホームページ" }, "顧客の媒体 (販売管理ソフト) から");
  eq(M.inquiryMedia(ix, { channel: "referral" }).media, "referral", "入口が紹介なら紹介");
  eq(M.inquiryMedia(ix, { channel: "phone" }), { media: null, source: "none" }, "どれもなければ未分類");
  eq(M.surveyMediaKeys(ix, { mediaList: ["グーグルマップ", "チラシ", "Googleマップ"] }), ["map", "flyer"], "アンケートの複数回答 (重複を除く)");
  eq(M.orderMedia(ix, { id: "o_m3", customerId: "c_m3" }, () => undefined).media, "repeat", "問い合わせのない移行した受注も顧客の媒体から");

  const legacy = M.legacyMediaValues({ ...db, quotes: [], orders: [], surveys: [], customers: [{ id: "c1", tags: ["媒体:玉名店"] }, { id: "c2", tags: ["媒体:チラシ"] }] }, rules);
  eq(legacy.map((v) => [v.value, v.media]), [["玉名店", null], ["チラシ", "flyer"]], "過去の値の一覧 (読み替えられない値を先に)");
  const denied = await act(A, () => AP.saveMediaMapping(form({ count: 1, r_0_from: "玉名店", r_0_match: "exact", r_0_media: "store" })));
  ok(denied.err?.includes("本部スタッフ・管理者"), "店舗スタッフは対応表を変えられない");
  const rows = [...M.DEFAULT_MEDIA_RULES, { from: "玉名店", match: "exact", media: "store" }];
  const f = { count: rows.length };
  rows.forEach((r, i) => Object.assign(f, { [`r_${i}_from`]: r.from, [`r_${i}_match`]: r.match, [`r_${i}_media`]: r.media }));
  const saved = await act(admin, () => AP.saveMediaMapping(form(f)));
  ok(saved.msg, "管理者は対応表を保存できる");
  eq(M.mapMediaText(M.readMediaRules(db).rules, "玉名店"), "store", "保存した対応表で読み替える");
  await act(admin, () => AP.saveMediaMapping(form({ reset: "1" })));
  ok(!M.readMediaRules(db).configured, "既定に戻す");
}

/* ------------------------------------------------------------------ */
section("販促: 登録と地域ごとの部数");
let flyerId = "";
{
  const parsed = PI.parseAreas("合志市須屋 3,000部\n合志市幾久富\t2000\n合志市須屋 500\n\nだめな行");
  eq(parsed.areas, [{ area: "合志市須屋", copies: 3500 }, { area: "合志市幾久富", copies: 2000 }], "地域と部数の読み取り (カンマ・タブ・同じ地域の合計)");
  eq(parsed.errors.length, 1, "読めない行はエラー");
  const pf = { kind: "flyer", title: "2019年5月 合志店 新聞折込", storeId: "koshi", status: "done", startDate: "2019-05-01", areas: "合志市須屋 3000\n合志市幾久富 2000", copies: "", cost: "100,000" };
  const staffTry = await act(A, () => AP.createPromotion(form(pf)));
  ok(staffTry.err?.includes("権限"), "店舗スタッフは販促を登録できない");
  const chuoTry = await act(chuoMgr, () => AP.createPromotion(form(pf)));
  const chuoRow = db.promotions.find((p) => chuoTry.path === `/promotions/${p.id}`);
  eq(chuoRow?.storeId, "chuo", "店長は自店舗の販促として登録する (店舗の指定は使わない)");
  const res = await act(admin, () => AP.createPromotion(form(pf)));
  const p = db.promotions.find((x) => res.path === `/promotions/${x.id}`);
  flyerId = p?.id;
  eq([p?.copies, p?.areas.length, p?.media, p?.cost, p?.number], [5000, 2, "flyer", 100000, "PR-2019-0002"], "部数は地域の合計・媒体は種類から");
  const bad = await act(admin, () => AP.createPromotion(form({ ...pf, areas: "合志市須屋" })));
  ok(bad.err?.includes("地域と部数"), "部数のない地域は断る");
  const upd = await act(admin, () => AP.updatePromotion(p.id, form({ ...pf, status: "done", note: "反応を見る" })));
  ok(upd.msg && db.promotions.find((x) => x.id === p.id)?.note === "反応を見る", "販促を更新できる");
  ok(db.auditLogs.some((l) => l.entity === "promotion" && l.entityId === p.id && l.action === "update" && l.changes?.some((c) => c.field === "note")), "更新は変更履歴に changes つきで残る");
  await act(admin, () => AP.createPromotion(form({ ...pf, title: "2019年 計画分", status: "planned", startDate: "2019-09-01", areas: "", copies: "20000" })));
  const del = await act(admin, () => AP.deletePromotion(chuoRow.id));
  ok(del.msg && !db.promotions.some((x) => x.id === chuoRow.id), "ひも付きのない販促は削除できる");
}

section("販促: 地域ごとの部数あたりの問い合わせ");
const inqBase = (x) => ({ number: `INQ-2019-${String(++seq).padStart(4, "0")}`, contactName: "分析 テスト", channel: "phone", storeId: "koshi", category: "tatami", summary: "テスト", detail: "", status: "new", receivedAt: "2019-05-15T01:00:00.000Z", createdBy: admin.id, updatedAt: now, ...x });
await store.mutate((d) => {
  d.customers.push(
    { ...cust, id: "c_a1", code: "C-A1", name: "須屋 一", phone: "090-1111-0001", address: "熊本県合志市須屋1000-1" },
    { ...cust, id: "c_a2", code: "C-A2", name: "須屋 二", phone: "090-1111-0002", address: "合志市須屋2-3" },
    { ...cust, id: "c_a3", code: "C-A3", name: "幾久富 三", phone: "090-1111-0003", address: "合志市幾久富1500" },
    { ...cust, id: "c_a4", code: "C-A4", name: "東区 四", phone: "090-1111-0004", address: "熊本市東区月出1-1" },
  );
  d.quotes.push({ id: "q_a6", number: "Q-2019-0001", customerId: "c_a1", storeId: "koshi", title: "畳", category: "tatami", status: "accepted", items: [], subtotal: 0, tax: 0, total: 0, version: 1, createdBy: admin.id, createdAt: now, updatedAt: now, validUntil: "2019-06-30", siteInfo: { media: ["チラシ"] } });
  d.orders.push({ ...order, id: "o_a6", number: "OR-2019-0001", quoteId: "q_a6", customerId: "c_a1", contractDate: "2019-05-20", total: 50000, progressNotes: [] });
  d.inquiries.push(
    inqBase({ id: "inq_a1", customerId: "c_a1", media: "flyer" }),
    inqBase({ id: "inq_a2", customerId: "c_a2", media: "flyer", receivedAt: "2019-05-31T14:59:00.000Z" }),
    inqBase({ id: "inq_a3", customerId: "c_a3", media: "referral" }),
    inqBase({ id: "inq_a4", customerId: "c_a4", media: "flyer" }),
    inqBase({ id: "inq_a5", area: "合志市須屋", media: "unknown" }),
    inqBase({ id: "inq_a6", customerId: "c_a1", quoteId: "q_a6", status: "won" }),
    inqBase({ id: "inq_a7", media: "flyer", receivedAt: "2019-05-31T15:00:00.000Z" }),
    inqBase({ id: "inq_a8", storeId: "chuo", media: "flyer" }),
  );
  d.workReportDays.push({ id: "wr_koshi_2019-05-03", storeId: "koshi", date: "2019-05-03", visitors: 7, flyers: [{ distributor: "配布 太郎", userIds: [], copies: 1000, area: "熊本市東区" }], createdBy: admin.id, createdAt: now, updatedAt: now });
});
const period = { from: "2019-05-01", to: "2019-05-31", store: "koshi" };
{
  const r = PA.promoReport(db, admin, period);
  eq(r.facts.map((f) => f.id), ["inq_a1", "inq_a3", "inq_a4", "inq_a5", "inq_a6", "inq_a2"], "期間 (日本時間の受付日)・店舗の問い合わせ (5/31 23:59 は入り、6/1 0:00 は入らない)");
  const fa = Object.fromEntries(r.flyerAreas.map((a) => [a.area, a]));
  eq([fa["合志市須屋"]?.copies, fa["合志市須屋"]?.inquiries, fa["合志市須屋"]?.flyerInquiries, fa["合志市須屋"]?.per1000], [3000, 4, 3, 1], "合志市須屋: 3,000 部・問い合わせ 4 件 (うちチラシ 3 件 = 推定 1 件を含む)・1,000 部あたり 1 件");
  eq([fa["合志市幾久富"]?.copies, fa["合志市幾久富"]?.flyerInquiries, fa["合志市幾久富"]?.per1000], [2000, 0, 0], "合志市幾久富: 2,000 部・チラシの問い合わせ 0 件");
  eq([fa["熊本市東区"]?.copies, fa["熊本市東区"]?.fromWorkReports, fa["熊本市東区"]?.flyerInquiries, fa["熊本市東区"]?.per1000], [1000, 1000, 1, 1], "作業日報の配布 (熊本市東区 1,000 部) も部数に入り、市区町村の配布は町を含む");
  eq([r.totals.flyerCopies, r.totals.visitors], [6000, 7], "チラシの部数 (販促 5,000 + 日報 1,000)・来店数が分析に反映");
  const m = r.months.find((x) => x.month === "2019-05");
  eq([m.copies, m.visitors, m.inquiries, m.flyerInquiries], [6000, 7, 6, 4], "月別 (部数・来店数・問い合わせ・うちチラシ)");
  const six = r.facts.find((f) => f.id === "inq_a6");
  eq([six.media, six.source, six.won, six.sales, six.town], ["flyer", "quote", true, 50000, "合志市須屋"], "媒体のない問い合わせは見積の媒体欄から推定・成約と売上・町");
  eq(r.areas[0], { town: "合志市須屋", inquiries: 4, flyerInquiries: 3, won: 1, sales: 50000, copies: 3000 }, "町別");
  const flyerRow = r.media.find((x) => x.key === "flyer");
  eq([flyerRow.inquiries, flyerRow.input, flyerRow.estimated, flyerRow.won, flyerRow.sales, flyerRow.orders], [4, 3, 1, 1, 50000, 1], "媒体別 (入力と推定を分けて数える・受注は契約日)");
  eq([r.totals.inquiries, r.totals.input, r.totals.estimated, r.totals.unclassified], [6, 5, 1, 0], "合計 (入力・推定・未分類)");
  const y = r.years[r.years.length - 1];
  eq([r.years.length, y.flyerCopies, y.plannedCopies, y.visitors], [3, 6000, 20000, 7], "年度の比較 (3 年度): 期間の年度のチラシの実施・計画・来店数");
  const pr = r.promotions.find((x) => x.promotion.id === flyerId);
  ok(pr && pr.promotion.copies === 5000, "販促ごとの反応に期間内の販促");
}

section("分析の件数 (CSV) = 問い合わせ一覧の件数");
{
  const r = PA.promoReport(db, admin, period);
  const csv = PA.promoCsvRows(r, "media", (id) => id);
  const body = csv.slice(1, -1);
  eq(body.reduce((a, row) => a + row[1], 0), r.facts.length, "媒体別の CSV の問い合わせの合計 = 期間の問い合わせ");
  eq(csv[csv.length - 1][1], r.facts.length, "合計の行");
  // 問い合わせ一覧と同じ絞り込み (店舗 → 媒体・受付日。src/app/(app)/inquiries/page.tsx)
  const listRows = P.scopeByStore(admin, db.inquiries).filter((i) => i.storeId === "koshi");
  for (const row of r.media) {
    const n = PA.filterInquiries(db, listRows, { media: row.key, from: period.from, to: period.to }).length;
    if (n !== row.inquiries) ok(false, `媒体「${row.label}」: 一覧 ${n} 件 / 分析 ${row.inquiries} 件`);
  }
  ok(true, `すべての媒体で 一覧の件数 = 分析の件数 (${r.media.length} 分類)`);
  eq(PA.filterInquiries(db, listRows, { from: period.from, to: period.to }).length, r.totals.inquiries, "媒体の指定なし = 合計");
  const detail = PA.promoCsvRows(r, "inquiries", (id) => id);
  eq(detail.length - 1, r.facts.length, "問い合わせの明細の CSV の行数");
  const flyers = PA.promoCsvRows(r, "flyers", (id) => id);
  eq(flyers.length - 1, r.flyerAreas.length, "チラシの地域別の CSV の行数");
  // 店長は自店舗だけ
  const koshiMgr = db.users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_manager");
  if (koshiMgr) {
    const mr = PA.promoReport(db, koshiMgr, { from: period.from, to: period.to, store: "chuo" });
    eq(mr.scope.storeIds, ["koshi"], "店長は他店舗を指定しても自店舗だけ");
  }
  const all = PA.promoReport(db, admin, { from: period.from, to: period.to });
  ok(all.facts.some((f) => f.id === "inq_a8"), "全店舗の指定では他店舗の問い合わせも数える");
}

section("イベントの受付票をまとめて問い合わせとして登録");
{
  const sheet = PI.parseEventSheet("氏名\t電話\t住所\t内容\n山田 花子\t090-1111-0001\t合志市須屋1000\t和室6畳の表替え\n佐藤 一郎, 菊陽町光の森, 網戸\n\n, 096-000-0000");
  eq(sheet.rows.map((x) => [x.name, x.phone ?? "", x.address ?? "", x.summary ?? ""]), [["山田 花子", "090-1111-0001", "合志市須屋1000", "和室6畳の表替え"], ["佐藤 一郎", "", "菊陽町光の森", "網戸"]], "受付票の読み取り (見出し・タブ・カンマ・電話の省略)");
  eq(sheet.errors.length, 1, "氏名のない行はエラー");
  const ev = await act(admin, () => AP.createPromotion(form({ kind: "event", title: "2019 春の畳フェア", storeId: "koshi", status: "done", startDate: "2019-06-01", copies: "40" })));
  const evp = db.promotions.find((x) => ev.path === `/promotions/${x.id}`);
  eq(evp?.media, "event", "イベントの媒体はイベント");
  const denied = await act(A, () => AP.registerEventInquiries(evp.id, form({ date: "2019-06-01", sheet: "山田 花子, 090-1111-0001" })));
  ok(denied.err?.includes("権限"), "店舗スタッフは受付票の一括登録をできない");
  const before = db.inquiries.length;
  const res = await act(admin, () => AP.registerEventInquiries(evp.id, form({ date: "2019-06-01", category: "tatami", media: "event", assignedUserId: A.id, sheet: "山田 花子\t090-1111-0001\t合志市須屋1000\t和室6畳の表替え\n佐藤 一郎, 菊陽町光の森, 網戸\n鈴木 三郎" })));
  ok(res.msg?.includes("3 枚") && res.msg.includes("1 件"), `3 枚を登録・電話番号の一致した 1 件を顧客にひも付け (${res.msg ?? res.err})`);
  const added = db.inquiries.slice(before);
  eq([added.length, added.every((i) => i.channel === "event" && i.media === "event" && i.promotionId === evp.id && i.storeId === "koshi" && i.assignedUserId === A.id)], [3, true], "入口・媒体・きっかけの販促・店舗・担当");
  eq(added[0].customerId, "c_a1", "電話番号が同じ店舗の顧客と一致すればひも付ける");
  ok(new Set(added.map((i) => i.number)).size === 3, "番号は重複しない");
  const r = PA.promoReport(db, admin, { from: "2019-06-01", to: "2019-06-30", store: "koshi" });
  const row = r.promotions.find((x) => x.promotion.id === evp.id);
  eq([row?.inquiries, row?.per1000], [3, 75], "販促ごとの反応 (問い合わせ 3 件・1,000 あたり 75 件)");
  eq(r.media.find((x) => x.key === "event")?.inquiries, 3, "媒体別のイベント");
  const future = await act(admin, () => AP.registerEventInquiries(evp.id, form({ date: "2099-01-01", sheet: "未来 太郎" })));
  ok(future.err?.includes("未来"), "未来の受付日は断る");
  const delLinked = await act(admin, () => AP.deletePromotion(evp.id));
  ok(delLinked.err?.includes("ひも付いた問い合わせ") && db.promotions.some((x) => x.id === evp.id), "問い合わせがひも付いた販促は削除できない");
}

section("権限");
{
  ok(P.canViewWorkReport(A, "koshi") && !P.canViewWorkReport(A, "chuo") && P.canViewWorkReport(admin, "chuo"), "作業日報: 店舗ロールは自店舗、全店舗ロールは全店舗");
  ok(P.canEditWorkReport(A, "koshi") && !P.canEditWorkReport(A, "nishi"), "作業日報の手入力: 自店舗のメンバー");
  ok(!P.canViewPromoAnalysis(A) && P.canViewPromoAnalysis(C) && P.canViewPromoAnalysis(admin), "販促と媒体の分析: 店長・本部・管理者 (店舗スタッフは見ない)");
  ok(chuoMgr && P.canEditPromotion(chuoMgr, "chuo") && !P.canEditPromotion(chuoMgr, "koshi"), "販促の登録: 店長は自店舗");
  ok(!P.canManageOpsReportSettings(C) && P.canManageOpsReportSettings(admin), "係数・対応表: 本部スタッフ・管理者");
  const table = fs.readFileSync(path.join(root, "src/lib/auth/permission-table.ts"), "utf8");
  ok(table.includes("作業日報") && table.includes("販促・媒体"), "権限一覧 (設定の画面) に載っている");
  const layout = fs.readFileSync(path.join(root, "src/app/(app)/layout.tsx"), "utf8");
  const guard = fs.readFileSync(path.join(root, "src/lib/assistant/guard.ts"), "utf8");
  for (const href of ["/work-reports", "/promotions"]) {
    const m = new RegExp(`href: "${href}", label: "([^"]+)"`).exec(layout);
    ok(m && guard.includes(`{ href: "${href}", label: "${m[1]}"`), `メニュー ${href} が guard.ts の NAV_ITEMS と同じ`);
  }
}

summary();
