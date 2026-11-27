// 実行: node scripts/tests/finance/greeting.test.mjs (npm run test:finance に含む)
// 近隣挨拶文の下書き (お客様のご要望 2026-11-27「■3」) と予定の種別「リフォーム」(「■1」)・作業の担当の「見積」(「■2」)
import { imp, ok, eq, section, summary } from "../hr/harness.mjs";

const G = await imp("lib/greeting.ts");
const WS = await imp("lib/work-staff.ts");
const C = await imp("lib/constants.ts");
const WR = await imp("lib/ops-reports/work-report.ts");

section("日付の書き方");
eq(G.jpDate("2031-12-20"), "12月20日（土）", "12月20日（曜日）");
eq(G.datesText(["2031-12-22", "2031-12-20"]), "12月20日（土）・12月22日（月）", "飛び飛びの日は「・」");
eq(G.datesText(["2031-12-20", "2031-12-21", "2031-12-22"]), "12月20日（土）〜12月22日（月）", "続いた 3 日以上は「〜」");

section("案件からの下書き (顧客名・担当者名・工事日程)");
{
  const now = "2031-12-01T00:00:00Z";
  const db = {
    users: [{ id: "u1", name: "架空 太郎", active: true }],
    customers: [{ id: "c1", name: "見本 花子", type: "individual", address: "熊本県合志市須屋1234-5 テストハイツ307号" }],
    quotes: [{ id: "q1", customerId: "c1", estimatorId: "u1", items: [{ id: "a", name: "クロス張替え", qty: 30, unit: "㎡" }, { id: "b", name: "畳 表替え", spec: "きずな", qty: 6, unit: "畳" }, { id: "c", name: "襖", spec: "両面 のぞみ177", qty: 4, unit: "枚" }] }],
    orders: [{ id: "o1", quoteId: "q1", customerId: "c1", category: "reform", status: "scheduled", createdBy: "u1", siteAddress: "" }],
    schedule: [
      { id: "e1", kind: "reform", date: "2031-12-20", orderId: "o1", work: "クロス張替え" },
      { id: "e2", kind: "delivery", date: "2031-12-22", slot: "pm", orderId: "o1" },
      { id: "e3", kind: "pickup", date: "2031-11-01", orderId: "o1" },
      { id: "e4", kind: "meeting", date: "2031-12-21", orderId: "o1" },
    ],
  };
  const d = G.greetingDraft(db, db.orders[0], "2031-12-10", { name: "株式会社　テスト", postalCode: "", address: "", tel: "", services: "" });
  eq(d.customer, "307号 見本", "顧客名 = 部屋番号 + 名字");
  eq(d.staff, "架空", "担当者名 = 見積担当の名字");
  eq(d.dates, "12月20日（土）・12月22日（月）", "工事予定日 = これからの工事・納品の日 (会議・過ぎた予定は除く)");
  eq(d.lines.split("\n"), ["12/20　クロス張替え（終日）", "12/22午後　畳・建具納品"], "工事日程の行 (予定の作業内容・終日 / 午後・明細の品目)");
  eq([d.work, d.time, d.title], ["内装工事", "8:00〜17:00", "工事開始のご挨拶"], "工事の種類・予定時間・表題の初期値");
  ok(d.bubble.includes("{担当}") && d.body.includes("ご協力の程"), "吹き出しとお願いの文");
  const corp = G.greetingDraft({ ...db, customers: [{ ...db.customers[0], type: "corporate", name: "テスト建設 株式会社" }] }, db.orders[0], "2031-12-10", d.company);
  eq(corp.customer, "307号 テスト建設 株式会社", "法人はお名前のまま");
}

section("予定の種別「リフォーム」・作業の担当の「見積」");
eq([C.SCHEDULE_KIND.reform.label, C.SCHEDULE_KIND.reform.group], ["リフォーム", "case"], "予定の種別にリフォーム (案件の予定)");
eq(WS.workRoleOfKind("reform"), "install", "リフォームの予定の担当 = 作業の担当の施工");
eq(WR.LINE_KIND_OF.reform, "install", "作業日報では施工の欄");
eq(WS.WORK_ROLE_LABEL.survey, "見積", "「現地見積」→「見積」");

summary();
