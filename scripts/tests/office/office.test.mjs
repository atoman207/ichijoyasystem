// 実行: npm run test:office (または node scripts/tests/office/office.test.mjs)
// 事務改善シート・慶弔リスト (取込・絞り込み・CSV)、縁在庫 (縁在庫表の取込・入庫・振り分け・使用・棚卸・規定量の通知・原価を出さない)、
// 権限、Google のサービスアカウント (JWT・トークン・Sheets API・CSV・共有されていないときの説明) の回帰テスト。
// Google には接続しない (ローカルのモックのサーバーと、テストで作った RSA の鍵)。サンプルデータの JSON は一時フォルダー
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { imp, ok, eq, section, summary, root, work } from "./harness.mjs";

const XLSX = createRequire(import.meta.url)(path.join(root, "node_modules/xlsx"));
const store = await imp("lib/db/store.ts");
const P = await imp("lib/auth/permissions.ts");
const PT = await imp("lib/auth/permission-table.ts");
const O = await imp("lib/office.ts");
const H = await imp("lib/heri-stock.ts");
const CSV = await imp("lib/csv.ts");
const DIO = await imp("lib/data-io.ts");
const GS = await imp("lib/google/sheets.ts");
const MODEL = await imp("lib/datastore/model.ts");

const db = store.getDb();
const admin = db.users.find((u) => u.active && u.role === "admin");
const hq = db.users.find((u) => u.active && u.role === "hq_staff");
const koshiMgr = db.users.find((u) => u.active && u.role === "store_manager" && u.storeId === "koshi");
const chuoMgr = db.users.find((u) => u.active && u.role === "store_manager" && u.storeId === "chuo");
const koshiStaff = db.users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const none = { clerkUserIds: [] };
const clerk = { clerkUserIds: [koshiStaff.id] };

function xlsxBuffer(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", bookSST: true });
}

/* ================================================================== */
section("権限: 事務改善は全員が見る・事務担当/本部/管理者が登録、慶弔は事務担当/本部/管理者だけ");
{
  ok(P.canViewOfficeImprovements(koshiStaff), "店舗スタッフも事務改善シートを見られる");
  ok(!P.canEditOfficeImprovements(koshiStaff, none) && !P.canEditOfficeImprovements(koshiMgr, none), "事務担当でない店舗ロールは事務改善を登録できない");
  ok(P.canEditOfficeImprovements(koshiStaff, clerk), "事務担当に選ばれた店舗スタッフは登録できる");
  ok(P.canEditOfficeImprovements(hq, none) && P.canEditOfficeImprovements(admin, none), "本部スタッフ・管理者は登録できる");
  ok(!P.canViewCondolences(koshiStaff, none) && !P.canViewCondolences(koshiMgr, none), "事務担当でない店舗ロールは慶弔リストを見られない (店長も)");
  ok(P.canViewCondolences(koshiStaff, clerk) && P.canViewCondolences(hq, none) && P.canViewCondolences(admin, none), "事務担当・本部・管理者は慶弔リストを見られる");
  ok(!P.canViewCondolences({ ...hq, active: false }, none), "無効の社員は見られない");
  const scope = MODEL.scopeStatements(koshiMgr).join("\n");
  ok(/create temp view condolences as select \* from main\.condolences where 0/.test(scope), "AI の SQL でも店舗ロールには慶弔リストを見せない");
  eq(MODEL.scopeStatements(hq), [], "全店舗ロールは SQL の範囲の制限なし (慶弔も見られる)");
}

section("権限: 縁在庫");
{
  ok(P.canViewHeriStock(koshiStaff), "全員が縁在庫を見られる");
  ok(P.canRecordHeriMove(koshiStaff, "use", { from: "store:koshi" }, none), "店舗スタッフは自店舗の在庫から使用を登録できる");
  ok(P.canRecordHeriMove(koshiStaff, "use", { from: "store:hq" }, none), "店舗スタッフは共通在庫から使用を登録できる");
  ok(!P.canRecordHeriMove(koshiStaff, "use", { from: "store:chuo" }, none), "ほかの店舗の在庫からは使用を登録できない");
  ok(!P.canRecordHeriMove(koshiStaff, "receive", { to: "store:hq" }, none) && !P.canRecordHeriMove(koshiMgr, "receive", { to: "store:hq" }, none), "入庫は事務担当・本部・管理者だけ");
  ok(P.canRecordHeriMove(koshiMgr, "transfer", { from: "store:hq", to: "store:koshi" }, none), "店長は共通在庫 → 自店舗に振り分けられる");
  ok(!P.canRecordHeriMove(koshiMgr, "transfer", { from: "store:hq", to: "store:chuo" }, none), "店長はほかの店舗へは振り分けられない");
  ok(P.canRecordHeriMove(koshiMgr, "count", { to: "store:koshi" }, none) && !P.canRecordHeriMove(koshiMgr, "count", { to: "store:hq" }, none), "店長の棚卸は自店舗だけ");
  ok(!P.canRecordHeriMove(koshiStaff, "count", { to: "store:koshi" }, none), "店舗スタッフは棚卸しない");
  ok(P.canRecordHeriMove(hq, "receive", { to: "store:hq" }, none) && P.canRecordHeriMove(koshiStaff, "receive", { to: "store:hq" }, clerk), "本部スタッフ・事務担当は入庫できる");
  ok(P.canManageHeriStock(hq, none) && !P.canManageHeriStock(koshiMgr, none), "品番の設定・取込は事務担当・本部・管理者");
  ok(P.canReverseHeriMove(koshiStaff, { createdBy: koshiStaff.id }, none) && !P.canReverseHeriMove(koshiStaff, { createdBy: hq.id }, none), "店舗スタッフは自分の登録だけ取り消せる");
  const groups = new Set(PT.PERMISSION_TABLE.map((r) => r.group));
  ok(groups.has("事務") && groups.has("縁在庫"), "設定の権限一覧に 事務・縁在庫 の行がある");
}

/* ================================================================== */
section("事務改善シート: .xlsx の取込 (空欄の年・月日は上の行を引き継ぐ。日付はシリアル値)");
const staffUser = koshiStaff;
const surname = staffUser.name.split(/\s+/)[0];
{
  const buf = xlsxBuffer([
    [
      "事務改善シート",
      [
        ["事務改善シート"],
        ["年", "月日", "担当", "項目", "内容", "⇒", "原因", "具体的改善策"],
        [2025, 45672, surname, "仕入帳", "入力漏れ", "", "見落とし", "2 度確認する"],
        ["", "", surname, "仕入帳", "品番の入力漏れ", "", "", ""],
        ["", 45678, "テスト担当", "買掛一覧", "支払額の確認漏れ", "", "前月と比べていない", "前月と見比べる"],
        ["", "3/1", "テスト担当", "売上", "見積書がない", "", "", ""],
        ["", "", "", "", "", "", "", ""],
        ["", "", "テスト担当", "請求書", "", "", "", ""],
        [2026, "1/5", surname, "請求書", "郵送忘れ, 「至急」", "", "", "予定に入れる"],
      ],
    ],
  ]);
  const tables = O.readUploadTables(buf);
  const plan = O.planImprovementImport(db, tables);
  eq(plan.problem, undefined, "見出しの行が見つかる");
  eq(plan.counts, { create: 5, duplicate: 0, error: 1 }, "5 行を登録、内容が空欄の行はエラー");
  const r = plan.records;
  eq(r.map((x) => x.date ?? null), ["2025-01-15", "2025-01-15", "2025-01-21", "2025-03-01", "2026-01-05"], "シリアル値・月日・空欄の引き継ぎ・年の切り替え");
  eq(r.map((x) => x.year), [2025, 2025, 2025, 2025, 2026], "年");
  eq(r[0].staffId, staffUser.id, "担当の姓が社員 1 人に決まるときはひも付ける");
  eq(r[2].staffId, undefined, "社員にない名前は文字だけ");
  eq(r[0].measure, "2 度確認する", "具体的改善策");
  eq(r[1].cause, undefined, "空欄の原因は空");
  const n = O.applyImprovementImport(db, admin, plan, "test.xlsx");
  eq(n, 5, "取込の実行で 5 件");
  ok(db.officeImprovements.every((x) => x.source === "import" && x.sourceRef?.startsWith("test.xlsx")), "取込元が残る");
  ok(db.auditLogs.some((l) => l.entity === "office_improvement" && l.action === "import"), "変更履歴に取込が残る");
  const again = O.planImprovementImport(db, O.readUploadTables(buf));
  eq(again.counts.duplicate, 5, "同じファイルをもう一度取り込んでも重複しない");
  // CSV の書き出し → そのまま取込 (同じ見出し) → すべて登録済み
  const csv = CSV.toCsv(O.improvementCsvRows(db.officeImprovements));
  const round = O.planImprovementImport(db, O.readUploadTables(Buffer.from(csv, "utf8")));
  eq([round.counts.create, round.counts.duplicate], [0, 5], "書き出した CSV を取り込むと全部登録済み (同じ見出しで往復できる)");
  ok(csv.includes('"郵送忘れ, 「至急」"'), "カンマを含む内容は CSV で囲む");
}

section("事務改善シート: 絞り込み");
{
  eq(O.filterImprovements(db.officeImprovements, { year: 2026 }).length, 1, "年");
  eq(O.filterImprovements(db.officeImprovements, { staff: "テスト担当" }).length, 2, "担当");
  eq(O.filterImprovements(db.officeImprovements, { item: "仕入帳" }).length, 2, "項目");
  eq(O.filterImprovements(db.officeImprovements, { q: "前月" }).length, 1, "検索 (原因・改善策も)");
  eq(O.filterImprovements(db.officeImprovements, {})[0].date, "2026-01-05", "新しい順");
  eq(O.yearsOf(db.officeImprovements.map((x) => x.year)), [2026, 2025], "年の選択肢");
}

/* ================================================================== */
section("慶弔リスト: .xlsx の取込 (「〃」・見出しのない列は備考・金額の書き方)");
{
  const buf = xlsxBuffer([
    [
      "シート1",
      [
        ["慶弔リスト"],
        ["年月日", "内容", "名前", "関係", "金額", "担当（参列者）", "備考", "", ""],
        ["2024.1.15", "通夜・葬儀", "テスト 一郎（喪主）", "取引先のご祖父様", "5,000円", "参列 A", "", "", ""],
        ["2024.3.18", "通夜・葬儀", "テスト 二郎（喪主）", "社員のお父様", "10,000円", "家族葬の為参列なし", "供花￥16500*１基", "弔電￥1760", "会場 X"],
        ["2025.10.16", "通夜", "　　　〃", "　　　〃", "10000円", "", "個人名", "", ""],
        ["2025.11.15", "参列なし", "テスト建具", "お母様亡くなられた", "", "参列 B", "", "", ""],
        ["2025.12.01", "結婚", "テスト 三郎", "社員", "3万円", "", "", "", ""],
        ["2025/13/40", "葬儀", "日付が変", "", "", "", "", "", ""],
      ],
    ],
  ]);
  const plan = O.planCondolenceImport(db, O.readUploadTables(buf));
  eq(plan.counts, { create: 5, duplicate: 0, error: 1 }, "5 行を登録、読めない日付はエラー");
  const r = plan.records;
  eq(r.map((x) => x.date), ["2024-01-15", "2024-03-18", "2025-10-16", "2025-11-15", "2025-12-01"], "2024.1.15 の形の日付");
  eq(r.map((x) => x.amount ?? null), [5000, 10000, 10000, null, null], "金額 (5,000円・10000円・空欄・読めない)");
  eq([r[2].name, r[2].relation], [r[1].name, r[1].relation], "「〃」は上の行と同じ名前・関係");
  ok(r[1].note.includes("供花") && r[1].note.includes("弔電") && r[1].note.includes("会場 X"), "見出しのない右の列 (弔電・会場) は備考に入る");
  ok(r[4].note?.includes("金額: 3万円"), "数として読めない金額は備考に残す");
  eq(r.map((x) => x.category), ["condolence", "condolence", "condolence", "condolence", "celebration"], "区分 (弔事・慶事) の推定");
  O.applyCondolenceImport(db, admin, plan, "keicho.xlsx");
  eq(db.condolences.length, 5, "5 件を登録");
  eq(O.planCondolenceImport(db, O.readUploadTables(buf)).counts.duplicate, 5, "もう一度取り込んでも重複しない");
  const csv = CSV.toCsv(O.condolenceCsvRows(db.condolences));
  const round = O.planCondolenceImport(db, O.readUploadTables(Buffer.from(csv, "utf8")));
  eq([round.counts.create, round.counts.duplicate], [0, 5], "書き出した CSV (区分の列つき) を取り込むと全部登録済み");
  eq(O.filterCondolences(db.condolences, { year: 2025, category: "condolence" }).length, 2, "年と区分で絞り込む");
  eq(O.filterCondolences(db.condolences, { q: "建具" }).length, 1, "検索");
}

section("クライアントの実際のシート (あれば。件数だけを確かめる)");
{
  const dir = path.join(root, "other/client-materials/08_事務");
  const kaizen = path.join(dir, "事務改善シート.xlsx");
  const keicho = path.join(dir, "慶弔リスト.xlsx");
  const heri = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).find((d) => d.name.startsWith("縁在庫表")) : undefined;
  if (fs.existsSync(kaizen) && fs.existsSync(keicho)) {
    const empty = { officeImprovements: [], condolences: [], users: db.users };
    const pk = O.planImprovementImport(empty, O.readUploadTables(fs.readFileSync(kaizen)));
    ok(pk.counts.create >= 30 && pk.counts.error === 0 && pk.records.every((x) => x.year >= 2024), `事務改善シート: ${pk.counts.create} 行を読める (エラー ${pk.counts.error})`);
    ok(pk.records.filter((x) => x.date).length >= 30, "事務改善シート: 月日 (シリアル値・引き継ぎ) を日付にできる");
    const pc = O.planCondolenceImport(empty, O.readUploadTables(fs.readFileSync(keicho)));
    ok(pc.counts.create >= 15 && pc.counts.error === 0, `慶弔リスト: ${pc.counts.create} 行を読める (エラー ${pc.counts.error})`);
    if (heri) {
      const items = H.parseHeriWorkbook(fs.readFileSync(path.join(dir, heri.name)));
      const counted = items.filter((i) => i.qty !== undefined);
      ok(counted.length >= 80 && items.some((i) => i.lineup), `縁在庫表: 数量のある品番 ${counted.length} 件・ラインナップ ${items.filter((i) => i.lineup).length} 件`);
      const plan = H.planHeriImport({ materials: [], stockMoves: [] }, items);
      ok(plan.lines.filter((l) => l.status === "error").length === 0, "縁在庫表: 取込の確認でエラーなし");
    }
    const lineupFile = path.join(dir, "通常ヘリ　ラインナップ.xlsx");
    if (fs.existsSync(lineupFile)) {
      const items = H.parseHeriWorkbook(fs.readFileSync(lineupFile));
      ok(items.length >= 20 && items.every((i) => i.lineup && i.qty === undefined), `通常ヘリ ラインナップ: ${items.length} 品番 (数量・価格は読まない)`);
    }
  } else ok(true, "クライアントの資料がないため省略");
}

/* ================================================================== */
section("縁在庫: 縁在庫表 (.xlsx) の取込");
const LINEUP = [[" ", "純金 1", "織部No.8", "鯔背\nNo.50", ""], [], ["", "", "", "", "￥7,700"], [], ["", "アラベスクV\nNo.510", "浮　13", "マス菊", "￥3,300"]];
const ARABESQUE = [["アラベスク", "在庫が少ない物は都度確認お願いします", "", ""], ["品番", "帖", "", ""], ["410", "0"], ["440", "80"], ["480", "25", "", "引当 6帖 (テスト)"]];
const URI = [["浮", "在庫が少ない物は都度確認お願いします"], ["品番", "帖"], ["1", "50"], ["2", "30"], [], ["集", "在庫が少ない物は都度確認お願いします"], ["品番", "帖"], ["1", "24"]];
const OTHER = [["その他", "在庫が少ない物は都度確認お願いします"], ["品番", "帖"], ["開運福太郎", "25"], ["麻の葉　ピンク", "0"]];
let mat480;
{
  const buf = xlsxBuffer([["通常ヘリラインナップ", LINEUP], ["アラベスク", ARABESQUE], ["浮・集", URI], ["その他", OTHER]]);
  const items = H.parseHeriWorkbook(buf);
  const lineup = items.filter((i) => i.lineup);
  eq(lineup.map((i) => `${i.series}|${i.no}`), ["純金|1", "織部|8", "鯔背|50", "アラベスクV|510", "浮|13", "通常ヘリ|マス菊"], "ラインナップの名前をシリーズと品番に分ける (価格は読まない)");
  const counted = items.filter((i) => i.qty !== undefined);
  eq(counted.map((i) => `${i.series}|${i.no}|${i.qty}`), ["アラベスク|410|0", "アラベスク|440|80", "アラベスク|480|25", "浮|1|50", "浮|2|30", "集|1|24", "その他|開運福太郎|25", "その他|麻の葉 ピンク|0"], "シリーズごとの品番と数量 (帖)");
  eq(counted.find((i) => i.no === "480").memo, "引当 6帖 (テスト)", "右側の書き込みはメモ");
  const plan = H.planHeriImport(db, items, H.COMMON_LOC, "2026-11-01");
  eq([plan.newMaterials, plan.counts], [14, 6], "新しい品番 14 件・数量を合わせる品番 6 件 (0 帖は調整なし)");
  const res = H.applyHeriImport(db, admin, plan, { loc: H.COMMON_LOC, date: "2026-11-01", sourceLabel: "縁在庫表.xlsx" });
  eq(res, { materials: 14, moves: 6 }, "取込の実行");
  const moves = db.stockMoves.filter((m) => m.note?.includes("縁在庫表の取込"));
  ok(moves.every((m) => m.kind === "adjust" && m.unitCost === 0 && m.amount === 0 && m.toLoc === "store:hq"), "取込は棚卸の調整 (単価 0・金額 0。管理会計の損益に入れない)");
  const rows = H.heriRows(db);
  mat480 = rows.find((r) => H.heriLabel(r.material) === "アラベスク 480").material;
  eq(rows.find((r) => r.material.id === mat480.id).common, 25, "共通在庫の数量");
  eq(mat480.note, "引当 6帖 (テスト)", "メモは品番のメモ");
  ok(rows.find((r) => H.heriLabel(r.material) === "マス菊").material.lineup && !rows.find((r) => H.heriLabel(r.material) === "マス菊").hasRecord, "ラインナップは品番だけ (記録なし)");
  eq(H.heriLabel(rows.find((r) => r.material.supplierCode === "開運福太郎").material), "開運福太郎", "「その他」のシリーズは品番だけを表示");
  const again = H.planHeriImport(db, items, H.COMMON_LOC, "2026-11-01");
  eq([again.newMaterials, again.counts], [0, 0], "同じ表をもう一度取り込んでも変わらない");
}

section("縁在庫: 入庫・振り分け・使用・棚卸 (マイナスにしない・原価は自動・画面と CSV に出さない)");
const today = "2026-11-10";
const run = (user, input) => H.recordHeriOp(db, user, { date: today, ...input });
{
  // 原価単価があれば受入の単価に使う (画面には出さない)
  db.materialCosts.push({ id: "mc_t1", materialId: mat480.id, unitCost: 300, kind: "standard", validFrom: "2026-01-01", createdBy: admin.id, createdAt: new Date().toISOString() });
  const r1 = run(hq, { op: "receive", materialId: mat480.id, qty: 10, to: H.COMMON_LOC, note: "納品書 123" });
  ok(typeof r1 === "object" && r1.move.kind === "receive" && r1.move.unitCost === 300 && r1.move.fromLoc === "supplier", "入庫 = 受入 (単価は原価単価から自動)");
  eq(H.heriQty(db, mat480.id, H.COMMON_LOC), 35, "共通在庫 25 + 10");
  const r2 = run(koshiMgr, { op: "transfer", materialId: mat480.id, qty: 5, from: H.COMMON_LOC, to: "store:koshi" });
  ok(typeof r2 === "object" && r2.move.kind === "transfer", "振り分け = 店舗間の移動");
  eq([H.heriQty(db, mat480.id, H.COMMON_LOC), H.heriQty(db, mat480.id, "store:koshi")], [30, 5], "共通在庫 30・合志店 5");
  const order = db.orders.find((o) => o.storeId === "koshi");
  const r3 = run(koshiStaff, { op: "use", materialId: mat480.id, qty: 2, from: "store:koshi", orderId: order.id });
  ok(typeof r3 === "object" && r3.move.toLoc === `order:${order.id}` && r3.move.orderId === order.id, "使用 (案件つき) = 店舗 → 案件");
  const r3b = run(koshiStaff, { op: "use", materialId: mat480.id, qty: 1, from: "store:koshi" });
  ok(typeof r3b === "object" && r3b.move.toLoc === H.USED_LOC, "案件を指定しない使用");
  const r4 = run(koshiStaff, { op: "use", materialId: mat480.id, qty: 5, from: "store:koshi" });
  ok(typeof r4 === "string" && r4.includes("2"), "在庫より多い使用は断る (マイナスにしない)");
  const r5 = run(koshiMgr, { op: "count", materialId: mat480.id, qty: 1, to: "store:koshi" });
  ok(typeof r5 === "object" && r5.move.kind === "adjust" && r5.move.fromLoc === "store:koshi" && r5.move.qty === 1, "棚卸: 数えた 1 帖と今の 2 帖の差 1 を調整 (減)");
  const r6 = run(koshiMgr, { op: "count", materialId: mat480.id, qty: 1, to: "store:koshi" });
  ok(typeof r6 === "object" && !r6.move && r6.message.includes("変更なし"), "同じ数量の棚卸は行を作らない");
  ok(typeof run(hq, { op: "receive", materialId: mat480.id, qty: -1 }) === "string" && typeof run(hq, { op: "transfer", materialId: mat480.id, qty: 1, from: H.COMMON_LOC, to: H.COMMON_LOC }) === "string", "数量・場所の誤りは断る");
  const csv = CSV.toCsv(H.heriCsvRows(db));
  ok(!/単価|金額|原価|300/.test(csv.split("\r\n")[0]) && !csv.includes(",300,"), "縁在庫の CSV に原価・単価・金額を入れない");
  ok(db.stockMoves.filter((m) => m.materialId === mat480.id).every((m) => m.status === "confirmed" || m.status === "reversed"), "縁在庫の画面の登録はすぐに確定 (申請にしない)");
  db.stockMoves.push({ id: "sm_draft", number: "SM-T-1", date: today, kind: "receive", materialId: mat480.id, qty: 100, unitCost: 0, amount: 0, fromLoc: "supplier", toLoc: H.COMMON_LOC, storeId: "hq", status: "draft", createdBy: koshiMgr.id, createdAt: new Date().toISOString() });
  eq(H.heriQty(db, mat480.id, H.COMMON_LOC), 30, "申請中 (下書き) の移動は数えない");
}

section("縁在庫: 規定量を下回ったときだけ通知 (本部スタッフと操作した店舗の店長へ社内連絡)");
{
  mat480.reorderLevel = 28;
  const r1 = run(koshiStaff, { op: "use", materialId: mat480.id, qty: 1, from: H.COMMON_LOC });
  ok(typeof r1 === "object" && !r1.alert, "30 → 29 (規定量 28 以上) は通知しない");
  const r2 = run(koshiStaff, { op: "use", materialId: mat480.id, qty: 2, from: H.COMMON_LOC });
  ok(typeof r2 === "object" && r2.alert && r2.alert.before === 29 && r2.alert.after === 27 && r2.alert.level === 28, "29 → 27 で規定量 28 を下回ったら通知");
  const before = db.threads.length;
  const n1 = H.heriAlertNotice(db, koshiStaff, [r2.alert], ["hq"]);
  eq(db.threads.length, before + 1, "社内連絡のスレッドを作る");
  ok(n1.thread.storeId === "hq" && n1.thread.title === H.HERI_ALERT_TITLE, "件名と店舗 (本社)");
  const to = new Set(n1.message.mentions);
  ok(db.users.filter((u) => u.active && u.role === "hq_staff").every((u) => to.has(u.id)), "本部スタッフ全員へメンション");
  ok(to.has(koshiMgr.id) && !to.has(chuoMgr.id), "操作した人の店舗の店長へ (ほかの店舗の店長には送らない)");
  ok(!to.has(koshiStaff.id), "操作した本人は宛先に入れない");
  ok(n1.message.body.includes("アラベスク 480") && n1.message.body.includes("規定量 28"), "本文に品番・数量・規定量");
  ok(P.canViewThread(koshiMgr, n1.thread) && !P.canViewThread(chuoMgr, n1.thread), "宛先の店長は見られる・ほかの店舗の店長には出ない");
  const r3 = run(koshiStaff, { op: "use", materialId: mat480.id, qty: 1, from: H.COMMON_LOC });
  ok(typeof r3 === "object" && !r3.alert, "すでに下回っているときは通知を重ねない");
  // 棚卸で戻して、もう一度下回ると、開いている同じスレッドに返信として足す
  run(hq, { op: "count", materialId: mat480.id, qty: 40, to: H.COMMON_LOC });
  const r4 = run(hq, { op: "count", materialId: mat480.id, qty: 10, to: H.COMMON_LOC });
  ok(typeof r4 === "object" && r4.alert, "棚卸で規定量を下回ったときも通知");
  const n2 = H.heriAlertNotice(db, hq, [r4.alert], ["hq"]);
  ok(n2.thread.id === n1.thread.id && db.threads.length === before + 1, "開いている同じ件名のスレッドに返信として足す");
  ok(H.heriBelow(db).some((r) => r.material.id === mat480.id), "規定量未満の一覧に出る (メニューのバッジ)");
}

section("縁在庫: 取消し (逆向きの行)・月次確定");
{
  const r = run(hq, { op: "receive", materialId: mat480.id, qty: 4, to: H.COMMON_LOC });
  const q0 = H.heriQty(db, mat480.id, H.COMMON_LOC);
  const rev = H.reverseHeriMove(db, hq, r.move.id, "数え間違い", today);
  ok(typeof rev === "object" && rev.move.reversalOf === r.move.id && r.move.status === "reversed", "取消しは逆向きの行を足し、元の行は残す");
  eq(H.heriQty(db, mat480.id, H.COMMON_LOC), q0 - 4, "取消しで数量が戻る");
  ok(typeof H.reverseHeriMove(db, hq, r.move.id, "二重", today) === "string", "取消し済みは取り消せない");
  db.periodCloses.push({ id: "2026-10", month: "2026-10", status: "closed", history: [], updatedAt: new Date().toISOString() });
  const closed = H.recordHeriOp(db, hq, { op: "receive", materialId: mat480.id, qty: 1, date: "2026-10-20", to: H.COMMON_LOC });
  ok(typeof closed === "string" && closed.includes("月次確定"), "月次確定した月の日付には登録しない");
}

section("縁在庫: CSV の取込 (書き出しと同じ見出し)");
{
  const csv = CSV.toCsv(H.heriCsvRows(db));
  const items = H.parseHeriCsv(csv);
  ok(Array.isArray(items) && items.length === H.heriRows(db, { includeInactive: true }).length, "書き出した CSV を読める");
  const plan = H.planHeriImport(db, items, H.COMMON_LOC);
  eq([plan.newMaterials, plan.counts], [0, 0], "書き出した CSV をそのまま取り込んでも変わらない");
  ok(typeof H.parseHeriCsv("a,b\n1,2") === "string", "品番の見出しがない CSV は断る");
}

/* ================================================================== */
section("Google のサービスアカウント: JWT・トークン・Sheets API・CSV (モックのサーバー)");
{
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const email = "ichijoya-test@example-project.iam.gserviceaccount.com";
  const keyJson = JSON.stringify({ type: "service_account", project_id: "example-project", private_key_id: "k1", private_key: pem, client_email: email, token_uri: "https://oauth2.googleapis.com/token" });
  const ID_OK = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const ID_DENIED = "1DeniedDeniedDeniedDeniedDenied00";
  const ID_PUBLIC = "1PublicOnlyPublicOnlyPublicOnly00";
  const VALUES = [["タイトル", "内容"], ["a,b", 'he said "hi"'], ["改行\nあり", "x"], ["1 列だけ"]];
  const calls = { token: 0, meta: 0, values: 0, export: 0, bad: [] };
  let lastAuth = "";
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.method === "POST" && u.pathname === "/token") {
        calls.token++;
        const p = new URLSearchParams(body);
        const jwt = p.get("assertion") ?? "";
        const [h, c, sig] = jwt.split(".");
        const header = JSON.parse(Buffer.from(h, "base64url").toString());
        const claims = JSON.parse(Buffer.from(c, "base64url").toString());
        const valid = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, "base64url"));
        const okClaims = p.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && header.alg === "RS256" && claims.iss === email && claims.scope === "https://www.googleapis.com/auth/spreadsheets.readonly" && claims.aud === "https://oauth2.googleapis.com/token" && claims.exp - claims.iat <= 3600 && claims.exp > claims.iat;
        if (!valid || !okClaims) { calls.bad.push({ valid, claims }); return json(400, { error: "invalid_grant", error_description: "bad jwt" }); }
        return json(200, { access_token: `tok${calls.token}`, expires_in: 3600, token_type: "Bearer" });
      }
      const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/]+)(\/values\/(.+))?$/);
      if (m) {
        lastAuth = req.headers.authorization ?? "";
        if (!/^Bearer tok\d+$/.test(lastAuth)) return json(401, { error: { code: 401 } });
        const id = decodeURIComponent(m[1]);
        if (id === ID_DENIED) return json(403, { error: { code: 403, status: "PERMISSION_DENIED" } });
        if (id === ID_PUBLIC) return json(404, { error: { code: 404, status: "NOT_FOUND" } });
        if (!m[2]) {
          calls.meta++;
          if (u.searchParams.get("fields") !== "sheets.properties(sheetId,title)") return json(400, {});
          return json(200, { sheets: [{ properties: { sheetId: 0, title: "シート1" } }, { properties: { sheetId: 123, title: "O'Brien の表" } }] });
        }
        calls.values++;
        const range = decodeURIComponent(m[3]);
        if (u.searchParams.get("valueRenderOption") !== "FORMATTED_VALUE") return json(400, {});
        if (range === "'O''Brien の表'") return json(200, { range, majorDimension: "ROWS", values: VALUES });
        if (range === "'シート1'") return json(200, { range, values: [["first"]] });
        return json(400, { error: "range" });
      }
      const e = u.pathname.match(/^\/spreadsheets\/d\/([^/]+)\/export$/);
      if (e) {
        calls.export++;
        if (e[1] === ID_PUBLIC || e[1] === ID_OK) { res.writeHead(200, { "Content-Type": "text/csv" }); return res.end("公開,シート\r\n1,2\r\n"); }
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<html>login</html>");
      }
      json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 本物の Google に接続しようとしたら失敗にする
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const s = String(url);
    if (/googleapis\.com|docs\.google\.com/.test(s)) throw new Error(`Google に接続しようとした: ${s}`);
    return realFetch(url, init);
  };
  process.env.GOOGLE_OAUTH_TOKEN_URL = `${base}/token`;
  process.env.GOOGLE_SHEETS_API_BASE = base;
  process.env.SHEETS_EXPORT_BASE = base;
  try {
    // 鍵なし: 公開の書き出しだけ
    GS.resetGoogleSheetsCache();
    eq(GS.googleSheetsStatus().configured, false, "鍵がなければ未設定");
    const pub = await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_PUBLIC}/edit#gid=0`);
    ok(pub.text.startsWith("公開,シート") && calls.token === 0 && calls.meta === 0, "鍵がなければ公開の書き出し (サービスアカウントは使わない)");

    // base64 の鍵
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = Buffer.from(keyJson).toString("base64");
    const st = GS.googleSheetsStatus();
    ok(st.configured && st.email === email && st.source === "GOOGLE_SERVICE_ACCOUNT_JSON", "base64 の鍵を読み、共有先のメールアドレスを出す");
    const r = await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_OK}/edit#gid=123`);
    eq(calls.bad, [], "JWT の署名 (RS256)・iss・scope・aud・有効期限 (1 時間以内) がモックの検証に通る");
    eq(CSV.parseCsv(r.text), [["タイトル", "内容"], ["a,b", 'he said "hi"'], ["改行\nあり", "x"], ["1 列だけ", ""]], "gid → シート名、値を CSV に (カンマ・引用符・改行を正しく囲み、行の長さをそろえる)");
    ok(r.text.includes('"a,b"') && r.text.includes('"he said ""hi"""') && r.text.includes('"改行\nあり"'), "CSV の囲み方 (RFC 4180)");
    ok(r.label.includes("O'Brien の表") && r.label.includes("サービスアカウント"), "ラベルにシート名");
    ok(lastAuth === "Bearer tok1", "アクセストークンを Authorization に付ける");
    await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_OK}/edit`);
    eq(calls.token, 1, "トークンは期限まで使い回す (2 回目の読み取りで取り直さない)");
    eq(calls.values, 2, "gid のないリンクは最初のシート");
    eq(calls.export, 1, "共有されているシートは公開の書き出しを使わない");

    // 共有されていない (403)・公開もされていない → 共有先のメールアドレスを日本語で
    let err;
    try {
      await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_DENIED}/edit#gid=0`);
    } catch (e) {
      err = e;
    }
    ok(err && err.message.includes(email) && err.message.includes("共有") && err.message.includes("閲覧者"), "403: サービスアカウントのメールアドレスに共有するよう日本語で伝える");
    // サービスアカウントでは 404 だが、リンクの共有のシート → 公開の書き出しで読む
    const viaPublic = await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_PUBLIC}/edit#gid=0`);
    ok(viaPublic.text.startsWith("公開,シート") && viaPublic.label.includes("リンクの共有"), "404 でもリンクの共有のシートは公開の書き出しで読む");

    // JSON そのまま・ファイル
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = keyJson;
    ok(GS.googleSheetsStatus().configured, "JSON そのままの鍵");
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const keyFile = path.join(work, "sa.json");
    fs.writeFileSync(keyFile, keyJson, { mode: 0o600 });
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE = keyFile;
    ok(GS.googleSheetsStatus().configured && GS.googleSheetsStatus().source === "GOOGLE_SERVICE_ACCOUNT_FILE", "鍵のファイル");
    const t0 = calls.token;
    await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_OK}/edit#gid=123`);
    eq(calls.token, t0 + 1, "鍵が変わったらトークンを取り直す");
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE = path.join(work, "missing.json");
    const bad = GS.googleSheetsStatus();
    ok(!bad.configured && bad.error?.includes("見つかりません"), "鍵のファイルがないときの説明");
    const fallback = await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_PUBLIC}/edit#gid=0`);
    ok(fallback.text.startsWith("公開,シート"), "鍵の設定が誤っていても、リンクの共有のシートは読める");
    delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "{not json";
    ok(GS.googleSheetsStatus().error?.includes("JSON"), "壊れた鍵は JSON として読めないと伝える");
    // 署名の検証: 違う鍵で作った JWT はモックが断る → 認証の失敗を日本語で
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: "service_account", private_key: other, client_email: email });
    let authErr;
    try {
      await DIO.fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID_OK}/edit#gid=123`);
    } catch (e) {
      authErr = e;
    }
    ok(authErr && authErr.message.includes("認証に失敗") && authErr.message.includes("invalid_grant"), "トークンの交換に失敗したら日本語で伝える");
    const jwt = GS.signJwt({ clientEmail: email, privateKey: pem }, 1_700_000_000);
    const [, claims] = jwt.split(".");
    eq(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: 1_700_000_000, exp: 1_700_003_600 }, "JWT の中身");
    eq(GS.valuesToCsv([]), "", "空のシートは空の CSV");
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    for (const k of ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_FILE", "GOOGLE_OAUTH_TOKEN_URL", "GOOGLE_SHEETS_API_BASE", "SHEETS_EXPORT_BASE"]) delete process.env[k];
  }
}

summary();
