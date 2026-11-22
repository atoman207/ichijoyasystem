// 実行: npm run test:registry (または node scripts/tests/registry/registry.test.mjs)
// データ台帳の回帰テスト: 読み取り (表計算・Word・PowerPoint・zip・PDF の文字)・分類と見られる人 (個人情報の除外・全店の数字は本部以上・店舗の資料)・
// 資料庫 (保存・人が変えた扱いが残る・全文検索・範囲)・社内資料への登録 (追加・更新なし・削除・手で登録した資料に触れない)・
// 社内の活動の集計 (変更履歴の閲覧範囲)・AI の道具 (範囲外を出さない)・統合データモデル (v_activity・変更履歴の範囲)・スクリプト (読み取り → 社内資料)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { imp, ok, eq, section, summary, root, work, zipStore } from "./harness.mjs";

const XLSX = createRequire(import.meta.url)(path.join(root, "node_modules/xlsx"));
const E = await imp("lib/registry/extract.ts");
const C = await imp("lib/registry/classify.ts");
const B = await imp("lib/registry/build.ts");
const M = await imp("lib/registry/materials-db.ts");
const P = await imp("lib/registry/promote.ts");
const A = await imp("lib/registry/activity.ts");
const PERM = await imp("lib/auth/permissions.ts");
const PT = await imp("lib/auth/permission-table.ts");
const K = await imp("lib/knowledge.ts");
const MODEL = await imp("lib/datastore/model.ts");
const store = await imp("lib/db/store.ts");
const TOOLS = await imp("lib/assistant/registry-tool.ts");
const AGENT = await imp("lib/assistant/agent.ts");

const db = store.getDb();
const admin = db.users.find((u) => u.active && u.role === "admin");
const hq = db.users.find((u) => u.active && u.role === "hq_staff");
const koshiMgr = db.users.find((u) => u.active && u.role === "store_manager" && u.storeId === "koshi");
const chuoMgr = db.users.find((u) => u.active && u.role === "store_manager" && u.storeId === "chuo");
const koshiStaff = db.users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");

function xlsxBuffer(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", bookSST: true });
}
const docxBuffer = (xml) => zipStore([["[Content_Types].xml", "<Types/>"], ["word/document.xml", `<w:document><w:body>${xml}</w:body></w:document>`]]);
const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

/* ================================================================== */
section("読み取り: 表・Word・PowerPoint・zip・文字");
{
  const t = E.rowsToText([["", "", ""], ["地区", "", "お客様名", "", ""], ["松橋町", "", "川村", "", ""], ["松橋町", "", "川村"], ["", "", "見出し"], [new Date("2026-05-27T00:00:00Z"), 1500]]);
  eq(t.split("\n"), ["地区 |  | お客様名", "松橋町 |  | 川村", "| 見出し", "2026-05-27 | 1500"], "空の行・後ろの空のセルを除き、同じ行の続きは 1 行・先頭の空のセルは「| 」・日付は YYYY-MM-DD");
  ok(E.rowsToText(Array.from({ length: 5000 }, (_, i) => [`行${i}`, "あいうえおかきくけこ"]), 2000).includes("…(以下"), "長い表は上限で打ち切り、打ち切ったことを書く");

  const xs = E.xlsxSections(xlsxBuffer([["価格表", [["品名", "単価"], ["表替え", 13200]]], ["空", []]]));
  eq(xs.map((s) => s.title), ["価格表", "空"], ".xlsx はシートごとの節 (ライブラリなし)");
  ok(xs[0].text.includes("表替え | 13200"), ".xlsx の値を読む");

  const w = E.docxText(docxBuffer(`${p("社内規定")}${p("第1条 &amp; 目的")}<w:tbl><w:tr><w:tc>${p("項目")}</w:tc><w:tc>${p("内容")}</w:tc></w:tr><w:tr><w:tc>${p("休日")}</w:tc><w:tc>${p("日曜")}</w:tc></w:tr></w:tbl>`));
  eq(w.split("\n"), ["社内規定", "第1条 & 目的", "項目 | 内容", "休日 | 日曜"], ".docx の段落と表 (表の行はセルを「 | 」でつなぐ)・文字の参照を戻す");

  const pp = E.pptxSections(zipStore([["ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>二枚目</a:t></a:r></a:p></p:sld>"], ["ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>一枚目</a:t></a:r></a:p></p:sld>"]]));
  eq(pp.map((s) => `${s.title}:${s.text}`), ["スライド 1:一枚目", "スライド 2:二枚目"], ".pptx はスライドの順に節");

  const sjisName = Buffer.from([0x8e, 0x91, 0x97, 0xbf, 0x2e, 0x70, 0x64, 0x66]); // 「資料.pdf」(Shift_JIS)
  eq(E.zipNames(zipStore([[sjisName, "x"]], { utf8: false })), ["資料.pdf"], "zip の名前: UTF-8 の印がなく UTF-8 として正しくないときは Shift_JIS");
  eq(E.zipNames(zipStore([["フォルダ/中身.xlsx", "x"]], { utf8: false })), ["フォルダ/中身.xlsx"], "zip の名前: 印がなくても UTF-8 として正しければ UTF-8 (Mac の zip)");

  const pages = E.textSections("冊子", `${"一".repeat(4000)}\f${"二".repeat(4000)}\f${"三".repeat(100)}`, { pages: true });
  eq(pages.map((s) => s.title), ["1 ページ", "2〜3 ページ"], "PDF の文字はページの区切りで節 (短いページはまとめる)");
  eq(E.extractBuiltin("x.xls", Buffer.from("")), null, "古い形式 (.xls) はライブラリなしでは読まない (null)");
  eq(E.kindOfExt("HEIC"), "image", "種類: 画像");
}

/* ================================================================== */
section("分類: 規則・個人情報の除外・全店の数字は本部以上・店舗の資料");
{
  const c = (rel, kind = "spreadsheet") => C.classifyPath(rel, kind);
  eq(c("15_人事・労務/個人の情報（取り込まない）/慶弔リスト.xlsx").action, "exclude", "慶弔リスト (ご家族の情報) は取り込まない");
  eq(c("15_人事・労務/個人の情報（取り込まない）/武蔵ヶ丘病院健診申込書.xlsx").action, "exclude", "健康診断の申込は取り込まない");
  eq(c("15_人事・労務/個人の情報（取り込まない）/有給管理表2026.7.xlsx").action, "exclude", "有給の管理表は取り込まない (有給・休日出勤の画面で取り込む)");
  ok(c("08_経営・計画/経営審査関係/工事履歴書様式2号.xls").action !== "exclude", "工事履歴書は「履歴書」(個人) と区別する");
  eq(c("03_売上・実績/店舗別の売上台帳/合志店　売上.xlsx").action, "structured", "売上台帳は取込済みのデータ (要約だけ)");
  const manual = c("01_社内ルール・マニュアル/社内総合マニュアル.xlsx");
  eq([manual.action, manual.visibility], ["knowledge", "all"], "社内総合マニュアルは社内資料 (全員)");
  eq(C.sheetPolicy(manual, "【営業】23：業者価格表").visibility, "hq", "マニュアルの業者価格表のシートは本部以上");
  eq(C.sheetPolicy(manual, "【共通】01：経営理念").category, "社内ルール", "シートごとの分類");
  eq(c("05_販促・広告/計画・分析/年間チラシ計画.xlsx").visibility, "hq", "全店の数字 (チラシ計画・個人の売上目標) は本部以上");
  eq(c("02_お客様対応・アンケート/アンケート/お客様アンケート集計表.xlsx").visibility, "hq", "アンケートの KPI (全店の数字) は本部以上");
  eq(C.sheetPolicy(c("02_お客様対応・アンケート/アンケート/お客様アンケート集計表.xlsx"), "クレーム手直し処理オペレーション").visibility, "manager", "クレーム手直しの処理の手順は店長以上");
  eq(c("07_議事録・会議/議事録.xlsx").visibility, "manager", "議事録は店長以上");
  const koshiFlyer = c("05_販促・広告/折込・ポスティング/2025年度/合志/R7.11月6.7日ポス合志店スタッフ40485枚【按分】.xlsx");
  eq([koshiFlyer.visibility, koshiFlyer.storeId, koshiFlyer.recordDate], ["manager", "koshi", "2025-11-06"], "店舗の折込の資料: 店長以上・店舗・日付 (令和)");
  eq(c("05_販促・広告/折込・ポスティング/ハイコムポスティング(株)　通常エリア表【2024年11月4日更新】.xlsx").visibility, "hq", "店舗が決まらない折込の資料は本部以上");
  eq(C.sheetPolicy(koshiFlyer, "エリアマスタ").keep, false, "様式の部品 (マスタ) のシートは取り込まない");
  eq(C.dateFromName("議事録 2026.8.18"), "2026-08-18", "日付: 西暦");
  eq(C.dateFromName("2026.10.xlsx"), "2026-10-01", "日付: 年月だけ → 1 日");
  eq(C.dateFromName("見積"), undefined, "日付なし");
  eq(c("20_写真/その他/IMG_0001.HEIC", "image").action, "ledger", "写真は台帳だけ");
  // source/ の分野のフォルダー
  const f = (rel, kind = "spreadsheet") => { const x = c(rel, kind); return [x.ruleId, x.action, x.category, x.visibility]; };
  eq(f(`${"15_人事・労務/個人の情報（取り込まない）"}/何かの名簿.xlsx`).slice(1), ["exclude", "人事・労務", "admin"], "個人の情報のフォルダーに置いた資料は、名前が何でも取り込まない");
  eq(f("15_人事・労務/個人の情報（取り込まない）/従業員写真/a.JPG", "image").slice(1, 2), ["exclude"], "社員の写真も取り込まない");
  eq(f("12_商品・価格/新しい資料.xlsx"), ["folder:商品・価格", "materials", "商品・価格", "hq"], "あとから置いた資料は分野のフォルダーの扱い");
  eq(f("01_社内ルール・マニュアル/旅費規程/出張旅費規程.docx", "document").slice(1), ["materials", "社内ルール", "manager"], "社内ルールのフォルダー");
  eq(f("05_販促・広告/チラシ/表面 (1).png", "image").slice(1), ["ledger", "販促・広告", "manager"], "資料のフォルダーの写真は台帳だけ (分類・見られる人はそのフォルダー)");
  eq(f("07_議事録・会議/会議資料　平島.xlsx")[0], "meeting", "会議資料は議事録のフォルダーにあっても会議資料 (議事録の規則は名前だけを見る)");
  eq(f("07_議事録・会議/議事録.xlsx")[0], "minutes", "議事録");
  eq(f("04_予定表・作業日報/休日カレンダー.xlsx").slice(1), ["structured", "予定・作業日報", "manager"], "休日カレンダーは取込済み (会社の休業日)");
  eq(f("04_予定表・作業日報/予定表/過去/2022.6.xlsx")[0], "schedule-sheet", "予定表のフォルダー (過去分も)");
  eq(f("03_売上・実績/販売管理ソフトの売上明細/2026.11.13 11時時点.CSV", "spreadsheet").slice(0, 2), ["sales-csv", "structured"], "売上明細の CSV は取込済み");
  eq(f("30_書類の見本/合志店.pdf", "pdf")[0], "top-pdf", "書類の見本");
  eq(f("99_その他/winmail.dat", "other").slice(1), ["ledger", "その他", "hq"], "その他");
  eq(C.classifyPath("05_販促・広告/折込・ポスティング/2025年度/合志/x.xlsx", "spreadsheet").storeId, "koshi", "店舗のフォルダー (合志) は分野のフォルダーの下でも店舗");
  ok(C.SOURCE_FOLDERS.every((x) => !C.storeFromPath(x.folder) && C.FOLDER_LABEL[x.folder] === x.label), "分野のフォルダー名に店舗の名前を入れない (店舗の判定を変えない)・表示名");
  ok(C.SOURCE_FOLDERS.every((x) => C.classifyPath(`${x.folder}/まだ規則のない資料.xlsx`, "spreadsheet").ruleId !== "generic"), "どの分野のフォルダーに置いても規則に当たる");
  const readme = fs.existsSync(path.join(root, "source/README.md")) ? fs.readFileSync(path.join(root, "source/README.md"), "utf8") : "";
  ok(readme && C.SOURCE_FOLDERS.every((x) => readme.includes(`\`${x.folder}/\``)), "source/README.md (コミットする説明) にすべての分野のフォルダー");
  const blank = C.piiSignals("生年月日\n年　月　日\n口座番号");
  eq(blank.markers, [], "空の様式 (生年月日・口座番号の欄だけ) は個人情報としない");
  eq(C.piiSignals("生年月日 昭和50年3月1日").markers, ["生年月日"], "生年月日の値があれば個人情報");
  const phones = Array.from({ length: 9 }, (_, i) => `096-111-${1000 + i}`).join("\n");
  eq(C.piiVisibility(C.piiSignals(phones), "all").visibility, "hq", "電話番号が多い資料は本部以上に上げる");
  ok(C.classificationKey(manual) !== C.classificationKey({ ...manual, visibility: "hq" }), "分類の指紋: 見られる人が変わると変わる (読み直しの判定)");
  const red = C.redactSecrets("利用者ID：abc123 パス：別紙でログイン\nPW: 1234567\nhttps://zoom.us/j/9123?pwd=eXyZ.1\nミーティング ID: 612 345 6789\nID等は管理者のみで管理\n認定支援機関ID番号 | 1 | 0\nID:Pabc123で地図だし");
  ok(!/abc123|1234567|eXyZ|612 345|Pabc123/.test(red.text) && red.count === 5, "ID・パスワード・暗証番号・URL の pwd の値を伏せる");
  ok(red.text.includes("パス：別紙でログイン") && red.text.includes("ID等は管理者のみで管理") && red.text.includes("ID番号 | 1 | 0") && red.text.includes("で地図だし"), "値のない書き方・日本語の説明は伏せない");
  const sec = B.buildDoc({ id: "d_sec", origin: "client", folder: "01_社内ルール・マニュアル", folderLabel: "社内ルール・マニュアル", path: "社内総合マニュアル.xlsx", name: "社内総合マニュアル.xlsx", ext: "xlsx", kind: "spreadsheet", sections: [{ title: "【事務】11：通常業務", text: "elTAX にログイン 利用者ID：abc123 PW：xyz789 → 納税 → 個人住民税" }, { title: "【共通】01：経営理念", text: "畳をとおして心と暮らしを豊かに" }] }, manual);
  const secChunk = sec.chunks.find((x) => x.section.includes("通常業務"));
  ok(!secChunk.body.includes("abc123") && !secChunk.body.includes("xyz789") && secChunk.visibility === "hq", "資料庫には伏せた文字だけを入れ、その節は本部以上にする");
  eq(sec.chunks.find((x) => x.section.includes("経営理念")).visibility, "all", "伏せ字のない節はそのまま");
  ok(sec.doc.pii?.secrets === 2 && sec.doc.pii.reason.includes("伏せ字"), "伏せた数と理由を台帳に残す");
}

/* ================================================================== */
section("処理: 節・会議ごとの分割・取込済みは要約だけ・同じ内容");
{
  const minutes = B.buildDoc(
    { id: "d_min", origin: "client", folder: "07_議事録・会議", folderLabel: "議事録・会議", path: "議事録.xlsx", name: "議事録.xlsx", ext: "xlsx", kind: "spreadsheet", sections: [{ title: "議事録", text: "| ※書き方の注意: 見出しに日付を書く (はじめに)\n10月DM 2026.8.18\n| ①10月のDM内容決定 | 表替え13200→9900\n店長会議 2026.9.2\n| 年末の段取り" }] },
    C.classifyPath("07_議事録・会議/議事録.xlsx", "spreadsheet"),
  );
  const titles = minutes.chunks.map((x) => x.section);
  ok(titles.includes("10月DM 2026.8.18") && titles.includes("店長会議 2026.9.2"), "議事録は会議ごとの節");
  eq(minutes.chunks.find((x) => x.section === "店長会議 2026.9.2")?.recordDate, "2026-09-02", "会議の日付を節に持つ");
  ok(minutes.chunks.every((x) => x.knowledge && x.visibility === "manager"), "議事録の節は社内資料に登録 (店長以上)");

  const sales = B.buildDoc(
    { id: "d_sales", origin: "client", folder: "03_売上・実績", folderLabel: "売上・実績", path: "店舗別の売上台帳/合志店　売上.xlsx", name: "合志店　売上.xlsx", ext: "xlsx", kind: "spreadsheet", sections: [{ title: "2024.1", text: "山田 太郎 | 090-1111-2222 | 表替え" }], sheetRows: { "2024.1": 312 } },
    C.classifyPath("03_売上・実績/店舗別の売上台帳/合志店　売上.xlsx", "spreadsheet"),
  );
  eq(sales.chunks.length, 1, "取込済みのデータは要約の節だけ");
  ok(sales.chunks[0].body.includes("2024.1 (312 行)") && !sales.chunks[0].body.includes("山田"), "要約はシート名と行数 (お客様の名前・電話は入れない)");

  const ex = B.buildDoc({ id: "d_ex", origin: "client", folder: "15_人事・労務", folderLabel: "人事・労務", path: "個人の情報（取り込まない）/慶弔リスト.xlsx", name: "慶弔リスト.xlsx", ext: "xlsx", kind: "spreadsheet", sections: [{ title: "シート1", text: "" }] }, C.classifyPath("15_人事・労務/個人の情報（取り込まない）/慶弔リスト.xlsx", "spreadsheet"));
  eq([ex.doc.status, ex.chunks.length], ["skipped", 0], "取り込まない資料は中身なし");
  const dup = B.buildDoc({ id: "d_dup", origin: "client", folder: "07_議事録・会議", folderLabel: "議事録・会議", path: "x.xlsx", name: "x.xlsx", ext: "xlsx", kind: "spreadsheet", sections: null, duplicateOf: { id: "d_min", path: "07_議事録・会議/議事録.xlsx" } }, C.classifyPath("07_議事録・会議/議事録.xlsx", "spreadsheet"));
  eq([dup.doc.duplicateOf, dup.chunks.length], ["d_min", 0], "同じ内容のファイルは先の資料を指し、中身は持たない");
  const long = B.splitText(Array.from({ length: 400 }, (_, i) => `${i}行目 ${"あ".repeat(30)}`).join("\n"));
  ok(long.length > 1 && long.every((x) => x.length <= B.CHUNK_CHARS), "長い節は検索の単位の大きさに分ける");
}

/* ================================================================== */
section("資料庫: 保存・人が変えた扱いが残る・全文検索と範囲");
const mdb = M.openMaterials();
{
  const put = (id, rel, sections, extra = {}) => {
    const cls = { ...C.classifyPath(rel, "spreadsheet"), ...extra };
    const { doc, chunks } = B.buildDoc({ id, origin: "client", folder: rel.split("/")[0], folderLabel: rel.split("/")[0], path: rel.split("/").slice(1).join("/"), name: rel.split("/").pop(), ext: "xlsx", kind: "spreadsheet", sha1: id, sections }, cls);
    M.upsertDoc(mdb, doc, chunks);
  };
  put("d_manual", "01_社内ルール・マニュアル/社内総合マニュアル.xlsx", [
    { title: "【現場】31：畳", text: "畳の表替えの手順\n1. 古い畳表をはがす (縁も外す)\n2. 新しい畳表を張る (框から順に)\n3. 縁を縫い付ける" },
    { title: "【営業】23：業者価格表", text: "業者価格 表替え 8000円 / 新調 15000円 / 裏返し 5000円 (税抜・1 枚あたり)" },
  ]);
  put("d_koshi", "05_販促・広告/折込・ポスティング/2025年度/合志/R7.11月6.7日ポス合志店スタッフ40485枚【按分】.xlsx", [{ title: "入力", text: "合志店 ポスティング 40485枚 スタッフチラシ" }]);
  put("d_chuo", "05_販促・広告/折込・ポスティング/2025年度/中央/（店舗別）中央R7.7月3.4　38804　メニュー.xlsx", [{ title: "入力", text: "中央店 ポスティング 38804枚 メニューチラシ" }]);
  put("d_minutes", "07_議事録・会議/議事録.xlsx", [{ title: "議事録", text: "10月DM 2026.8.18\n| 表替え13200→9900 申込期限10月20日" }]);

  const vis = (u) => PERM.knowledgeVisibilities(u);
  eq(vis(koshiStaff), ["all"], "店舗スタッフの見られる人: 全員の資料だけ");
  eq(vis(hq), ["all", "manager", "hq"], "本部スタッフ: 本部以上まで");
  const s1 = M.searchMaterials(mdb, "畳表 手順", { visibilities: vis(koshiStaff) });
  ok(s1[0]?.doc.id === "d_manual" && s1[0].chunk.section === "【現場】31：畳", "全文検索: 3 文字以上は索引、2 文字は部分一致で当たる");
  ok(!M.searchMaterials(mdb, "業者価格", { visibilities: vis(koshiStaff) }).length, "見られない節 (業者価格表 = 本部以上) は店舗スタッフに出さない");
  ok(M.searchMaterials(mdb, "業者価格", { visibilities: vis(hq) }).length === 1, "本部スタッフには出す");
  const ks = M.searchMaterials(mdb, "ポスティング", { visibilities: vis(koshiMgr), storeId: "koshi" });
  eq(ks.map((h) => h.doc.id), ["d_koshi"], "店舗の資料は所属店舗のものだけ (合志店の店長に中央店の資料を出さない)");
  eq(M.searchMaterials(mdb, "ポスティング", { visibilities: vis(hq) }).length, 2, "本部はすべての店舗の資料");
  ok(M.searchMaterials(mdb, "表替えの価格はいくら？", { visibilities: vis(koshiMgr) }).some((h) => h.doc.id === "d_minutes"), "質問の文 (助詞つき) でも言葉に分けて探す");

  M.setKnowledgeIds(mdb, "d_minutes", ["kn_x"]);
  M.setOverride(mdb, "d_minutes", { visibility: "hq", note: "全店の数字あり" }, admin.id);
  put("d_minutes", "07_議事録・会議/議事録.xlsx", [{ title: "議事録", text: "10月DM 2026.8.18\n| 表替え13200→9900 申込期限10月20日 (読み直し)" }]);
  const again = M.getDoc(mdb, "d_minutes");
  eq([again.override?.visibility, again.override?.note, again.knowledgeIds], ["hq", "全店の数字あり", ["kn_x"]], "読み直しても人が変えた扱い・社内資料の ID は残る");
  ok(!M.searchMaterials(mdb, "申込期限", { visibilities: vis(koshiMgr) }).length, "人が変えた見られる人 (本部以上) で検索の範囲も変わる");
  M.setOverride(mdb, "d_chuo", { action: "exclude" }, admin.id);
  eq(M.getChunks(mdb, "d_chuo").length, 0, "取り込まないにすると中身を消す");
  M.setOverride(mdb, "d_minutes", { visibility: null }, admin.id);
  eq(M.getDoc(mdb, "d_minutes").override?.visibility, undefined, "空欄で自動の判定に戻す");
  const st = M.materialsStats(mdb);
  ok(st.docs === 4 && st.byAction.knowledge === 2 && st.byAction.exclude === 1, "内訳 (扱いは人が変えたものを数える)");
  eq(M.listDocs(mdb, { q: "議事録" }).rows.map((d) => d.id), ["d_minutes"], "一覧の絞り込み (名前)");
}

/* ================================================================== */
section("社内資料への登録: 追加・変わらなければ更新なし・節が減れば削除・手で登録した資料に触れない");
{
  const ctx = { userId: admin.id, now: new Date().toISOString(), newId: () => store.newId("kn") };
  const manualCount = db.knowledge.filter((k) => !k.sourceRef?.startsWith("material:")).length;
  const work1 = { knowledge: db.knowledge.map((k) => ({ ...k })) };
  const r1 = P.promoteFromMaterials(work1, mdb, ctx);
  const mine = work1.knowledge.filter((k) => k.sourceRef?.startsWith("material:"));
  ok(r1.added === mine.length && mine.length >= 3, `資料の節を社内資料に登録 (${mine.length} 件)`);
  const price = mine.find((k) => k.title.includes("業者価格表"));
  eq(price?.visibility, "hq", "社内資料の見られる人は節の見られる人 (業者価格表 = 本部以上)");
  ok(mine.every((k) => k.source === "file" && k.body.startsWith("出典: クライアント資料")), "出典を本文の先頭に書く");
  eq(mine.find((k) => k.title.includes("議事録"))?.recordDate, "2026-08-18", "議事録の社内資料に会議の日付");
  const r2 = P.promoteFromMaterials(work1, mdb, ctx);
  eq([r2.added, r2.updated, r2.removed], [0, 0, 0], "もう一度そろえても変わらない");
  M.setOverride(mdb, "d_manual", { action: "materials" }, admin.id);
  const r3 = P.promoteFromMaterials(work1, mdb, ctx);
  ok(r3.removed >= 2 && !work1.knowledge.some((k) => k.sourceRef?.startsWith("material:d_manual#")), "社内資料に登録しない扱いにすると、その資料の社内資料を消す");
  eq(work1.knowledge.filter((k) => !k.sourceRef?.startsWith("material:")).length, manualCount, "画面で登録した社内資料・シートの同期には触らない");
  M.setOverride(mdb, "d_manual", { action: null }, admin.id);
  const long = { id: "d_long", origin: "upload", folder: "x", folderLabel: "x", path: "長い.txt", name: "長い.txt", ext: "txt", kind: "text", action: "knowledge", category: "マニュアル", visibility: "all", status: "ok", chars: 0, sections: 1, sheetNames: [], knowledgeIds: [] };
  const chunks = B.splitText("あ".repeat(20000)).map((body, i, a) => ({ id: `d_long:${i}`, docId: "d_long", seq: i, section: "", part: i + 1, parts: a.length, visibility: "all", category: "マニュアル", knowledge: true, head: "長い", body }));
  const drafts = P.knowledgeDrafts(long, chunks);
  ok(drafts.length === 3 && drafts.every((d) => d.body.length <= P.KNOWLEDGE_ENTRY_MAX + 200) && drafts[0].title.endsWith("(1/3)"), "長い節は 8,000 文字ごとに分けて登録");
}

/* ================================================================== */
section("権限: データ台帳は本部以上・資料は見られる人と店舗");
{
  ok(PERM.canViewRegistry(admin) && PERM.canViewRegistry(hq) && !PERM.canViewRegistry(koshiMgr) && !PERM.canViewRegistry(koshiStaff), "データ台帳を見るのは管理者・本部スタッフ");
  ok(PERM.canManageRegistry(hq) && !PERM.canManageRegistry(koshiMgr), "資料の扱いを変えるのは管理者・本部スタッフ");
  ok(PERM.canViewMaterial(koshiMgr, { visibility: "manager", storeId: "koshi" }) && !PERM.canViewMaterial(koshiMgr, { visibility: "manager", storeId: "chuo" }), "店長はほかの店舗の資料を見ない");
  ok(!PERM.canViewMaterial(koshiStaff, { visibility: "manager" }) && PERM.canViewMaterial(koshiStaff, { visibility: "all" }), "店舗スタッフは全員の資料だけ");
  ok(PT.PERMISSION_TABLE.some((r) => r.action.startsWith("データ台帳")), "権限の一覧に載せる");
}

/* ================================================================== */
section("社内の活動: 変更履歴の閲覧範囲で数える");
{
  const now = new Date();
  const today = A.jstParts(now.toISOString()).date;
  const base = { entityLabel: "テスト", summary: "テストの操作", changes: [] };
  // 操作の時刻は今 (1 時間前にすると、0 時台に実行したとき前の日になり「今日」に入らない)
  const add = (id, userId, action, entity, storeId, hoursAgo = 0) => db.auditLogs.push({ id, at: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), userId, action, entity, entityId: id, storeId, ...base });
  add("t_a1", koshiMgr.id, "create", "customer", "koshi");
  add("t_a2", chuoMgr.id, "delete", "order", "chuo");
  add("t_a3", hq.id, "update", "settings", undefined);
  add("t_a4", chuoMgr.id, "login", "session", "chuo");
  const all = A.activityReport(db, admin, { from: today, to: today, q: "テストの操作" }, now);
  eq(all.total, 4, "管理者はすべての操作");
  eq(all.notable.deletes, 1, "削除を数える");
  const koshi = A.activityReport(db, koshiStaff, { from: today, to: today, q: "テストの操作" }, now);
  eq(koshi.recent.map((r) => r.userId), [koshiMgr.id], "店舗スタッフは所属店舗の案件・顧客などの操作だけ (ほかの店舗・設定・ログインは出さない)");
  ok(koshi.scoped && !all.scoped, "範囲が絞られていることを返す");
  const hqView = A.activityReport(db, hq, { from: today, to: today, q: "テストの操作" }, now);
  ok(!hqView.recent.some((r) => r.action === "login" && r.userId !== hq.id), "本部スタッフにほかの人のログインは出さない");
  ok(A.activityText(all).includes("削除 1"), "AI に渡す文に注意して見るものを書く");
  eq(all.byDay.length, 1, "日ごとの件数 (期間の日数)");
  const week = A.activityReport(db, admin, {}, now);
  eq(week.byDay.length, 7, "期間を省くと 7 日");
}

/* ================================================================== */
section("統合データモデル: v_activity と変更履歴の範囲");
{
  ok(MODEL.VIEWS.some((v) => v.name === "v_activity"), "統合ビューに v_activity");
  const staffScope = MODEL.scopeStatements(koshiStaff).find((s) => s.includes("view audit_logs"));
  ok(staffScope && staffScope.includes("store_id = 'koshi'") && staffScope.includes("entity != 'session'") && staffScope.includes("'customer'"), "店舗スタッフの変更履歴は所属店舗・対象を絞って覆う (ログインは除く)");
  const mgrScope = MODEL.scopeStatements(koshiMgr).find((s) => s.includes("view audit_logs"));
  ok(mgrScope && !mgrScope.includes("entity in"), "店長は所属店舗の変更履歴すべて");
  eq(MODEL.scopeStatements(admin).length, 0, "全店舗を見られる人は覆わない");
  // 実際の SQLite で v_activity を作って数える
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const sq = new DatabaseSync(":memory:");
  sq.exec("create table audit_logs (id text, at text, user_id text, action text, entity text, entity_id text, entity_label text, summary text, store_id text); create table users (id text, name text); create table stores (id text, name text);");
  sq.exec(MODEL.LABELS_SQL);
  const ins = sq.prepare("insert into _labels values (?,?,?)");
  for (const r of MODEL.labelRows()) ins.run(...r);
  sq.prepare("insert into users values (?,?)").run(koshiMgr.id, koshiMgr.name);
  sq.prepare("insert into stores values ('koshi','合志店')").run();
  sq.prepare("insert into audit_logs values ('l1','2026-11-19T23:30:00.000Z',?, 'delete','order','o1','O-1','削除','koshi')").run(koshiMgr.id);
  sq.exec(`create temp view v_activity as ${MODEL.VIEWS.find((v) => v.name === "v_activity").sql}`);
  const row = sq.prepare("select date, hour, user_name, action_label, entity_label, store_name from v_activity").get();
  eq([row.date, row.hour, row.user_name, row.action_label, row.entity_label, row.store_name], ["2026-11-20", 8, koshiMgr.name, "削除", "受注・施工", "合志店"], "v_activity: 日本時間の日付・時、人・操作・対象の日本語名");
  ok(MODEL.dataModelText(admin).includes("v_activity"), "データ辞書に v_activity");
}

/* ================================================================== */
section("AI の道具: 資料庫の検索・資料を読む・データ台帳 (範囲外を出さない)");
{
  const tool = (name) => TOOLS.registryTools.find((t) => t.def.name === name);
  ok(["search_materials", "read_material", "data_registry"].every((n) => tool(n) && AGENT.TOOL_PROGRESS_LABEL[n]), "3 つの道具と途中の知らせの名前");
  const r1 = await tool("search_materials").run(db, hq, { query: "業者価格" }, new Date());
  ok(r1.text.includes("業者価格表") && r1.text.includes("[開く](/registry/materials/d_manual)"), "本部スタッフは業者価格表を見つける (リンクつき)");
  const r2 = await tool("search_materials").run(db, koshiStaff, { query: "業者価格" }, new Date());
  ok(!r2.text.includes("業者価格表") && r2.summary.endsWith("0 件"), "店舗スタッフには本部以上の節を出さない");
  const r3 = await tool("search_materials").run(db, koshiMgr, { query: "ポスティング" }, new Date());
  ok(r3.text.includes("合志") && !r3.text.includes("中央店 ポスティング"), "店長の検索は所属店舗の資料だけ");
  const priceChunk = M.getChunks(mdb, "d_manual").find((c) => c.section.includes("業者価格表"));
  const r4 = await tool("read_material").run(db, koshiStaff, { chunk_id: priceChunk.id }, new Date());
  ok(r4.text.includes("範囲の外") && !r4.text.includes("8000円"), "見られない節は read_material でも読ませない");
  const r5 = await tool("read_material").run(db, admin, { chunk_id: priceChunk.id }, new Date());
  ok(r5.text.includes("8000円") && r5.text.includes("この資料の節"), "管理者は節の全文と節の一覧");
  const r6 = await tool("data_registry").run(db, koshiMgr, { view: "catalog" }, new Date());
  ok(r6.summary === "権限なし" && !r6.text.includes("件・"), "全データの一覧は店舗のロールに出さない");
  const r7 = await tool("data_registry").run(db, admin, { view: "catalog" }, new Date());
  ok(r7.text.includes("顧客") && r7.text.includes("データの置き場所") && r7.text.includes("資料庫"), "管理者には全データの一覧・置き場所・資料庫");
  const r8 = await tool("data_registry").run(db, koshiMgr, { view: "activity", store: "中央店" }, new Date());
  ok(r8.text.includes("範囲外"), "店長がほかの店舗の活動を聞いたら断る");
  const r9 = await tool("data_registry").run(db, admin, { view: "activity", q: "テストの操作" }, new Date());
  ok(r9.text.includes("操作の件数: 4 件"), "管理者の活動の集計");
  const r10 = await tool("data_registry").run(db, koshiStaff, { view: "materials" }, new Date());
  ok(/見られるクライアント資料は \d+ 件/.test(r10.text) && !r10.text.includes("フォルダ:"), "店舗のロールには資料庫の内訳を出さず、見られる件数だけ");
}

/* ================================================================== */
section("社内資料の抜粋: 長い資料は質問の言葉のあたりを渡す");
{
  const body = `出典: マニュアル\n${"前置きの文章。".repeat(800)}\n■ 網戸の張り替え\n網戸の張り替えは 1 枚 2,750 円から。\n${"後ろの文章。".repeat(400)}`;
  const ex = K.knowledgeExcerpt(body, "網戸 張り替え 料金", 1500);
  ok(ex.startsWith("出典: マニュアル") && ex.includes("2,750 円") && ex.length <= 1600, "冒頭 (出典) と、質問の言葉が多いあたり");
  eq(K.knowledgeExcerpt("短い本文", "網戸", 1500), "短い本文", "短い資料は全文");
}

/* ================================================================== */
section("スクリプト: クライアント資料のフォルダー (source/) を読み取り、社内資料をそろえる (サンプルデータ)");
{
  const SRC = await imp("lib/registry/source.ts");
  const dir = path.join(work, "client", "source");
  const P15 = "15_人事・労務/個人の情報（取り込まない）";
  for (const d of ["01_社内ルール・マニュアル", P15, "07_議事録・会議", "_index/download-logs/08_事務"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "01_社内ルール・マニュアル", "社内総合マニュアル.xlsx"), xlsxBuffer([["【共通】01：経営理念", [["理念"], ["畳をとおして「心」と「暮らし」を豊かに"], ["ビジョン: 日本一安心して頼める畳屋になる"]]], ["【営業】23：業者価格表", [["品名", "業者価格", "備考"], ["表替え", 8000, "税抜・1 枚"], ["新調", 15000, "税抜・1 枚"]]]]));
  fs.writeFileSync(path.join(dir, P15, "慶弔リスト.xlsx"), xlsxBuffer([["シート1", [["年月日", "名前"], ["2024.1.15", "テスト 太郎"]]]]));
  fs.writeFileSync(path.join(dir, "07_議事録・会議", "議事録.xlsx"), xlsxBuffer([["議事録", [["10月DM 2026.8.18"], ["", "①10月のDM内容決定", "表替え13200→9900 (申込期限 10月20日)"]]]]));
  fs.writeFileSync(path.join(dir, "07_議事録・会議", "議事録 のコピー.xlsx"), fs.readFileSync(path.join(dir, "07_議事録・会議", "議事録.xlsx")));
  fs.writeFileSync(path.join(dir, "_index/download-logs/08_事務", "_download-log.md"), "# ログ");
  fs.writeFileSync(path.join(dir, "README.md"), "# source");
  fs.writeFileSync(path.join(dir, "07_議事録・会議", "Thumbs.db"), "x");
  // 整理したときの索引 (整理する前の場所 from を持つ。ID は整理する前と同じ計算)
  const crypto = await import("node:crypto");
  const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, f))).digest("hex");
  const legacy = (from) => `mf_${crypto.createHash("sha1").update(from).digest("hex").slice(0, 12)}`;
  const entries = [
    ["01_社内ルール・マニュアル/社内総合マニュアル.xlsx", "08_事務/社内総合マニュアル.xlsx"],
    [`${P15}/慶弔リスト.xlsx`, "08_事務/慶弔リスト.xlsx"],
    ["07_議事録・会議/議事録.xlsx", "07_販促/議事録.xlsx"],
    ["07_議事録・会議/議事録 のコピー.xlsx", "07_販促/議事録 のコピー.xlsx"],
  ].map(([p, from]) => ({ path: p, from, role: "material", id: legacy(from), sha1: sha(p) }));
  SRC.writeManifest(dir, { version: 1, organizedAt: "2026-11-21T00:00:00.000Z", from: "other/client-materials", entries: [...entries, { path: "_index/download-logs/08_事務/_download-log.md", from: "08_事務/_download-log.md", role: "download-log" }] });
  ok(fs.readFileSync(path.join(dir, "_index/manifest.csv"), "utf8").includes("other/client-materials/08_事務/社内総合マニュアル.xlsx"), "索引の CSV に整理する前の場所");

  const mfile = path.join(work, "script-materials.sqlite");
  const report = path.join(work, "report");
  const env = { ...process.env, ICHIJOYA_MATERIALS_DB_PATH: mfile };
  const scan = () => execFileSync("node", [path.join(root, "scripts/registry/scan-materials.mjs"), "--dir", dir, "--db", mfile, "--report", report], { cwd: work, env, encoding: "utf8" });
  const out = scan();
  ok(/読み直し 4・変わらず 0/.test(out), "4 件を読む (索引・取得の記録・README・OS の管理ファイルは読まない)");
  const md = fs.readFileSync(path.join(report, "scan-report.md"), "utf8");
  ok(md.includes("慶弔リスト.xlsx — 慶弔") && md.includes("社内総合マニュアル.xlsx — マニュアル"), "報告: 社内資料に登録する資料と取り込まない資料");
  const out2 = scan();
  ok(/読み直し 0・変わらず 4/.test(out2) && /あとから追加 0・場所が変わった 0/.test(out2), "2 回目は変わったファイルだけ読む");
  let sdb = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(mfile, { readOnly: true });
  const manualRow = sdb.prepare("select id, folder, folder_label, path, orig_path from docs where name = '社内総合マニュアル.xlsx'").get();
  eq([manualRow.id, manualRow.folder, manualRow.folder_label, manualRow.path, manualRow.orig_path], [legacy("08_事務/社内総合マニュアル.xlsx"), "01_社内ルール・マニュアル", "社内ルール・マニュアル", "社内総合マニュアル.xlsx", "08_事務/社内総合マニュアル.xlsx"], "ID は整理する前と同じ・場所は source/ の分野のフォルダー・整理する前の場所も持つ");
  const dupRows = sdb.prepare("select duplicate_of from docs where path in ('議事録.xlsx', '議事録 のコピー.xlsx')").all();
  ok(dupRows.length === 2 && dupRows.filter((r) => r.duplicate_of).length === 1, "同じ内容のコピーは 1 件だけ中身を持ち、もう 1 件は先の資料を指す");
  ok(!sdb.prepare("select count(*) n from chunks c join docs d on d.id = c.doc_id where d.name = '慶弔リスト.xlsx'").get().n, "取り込まない資料の中身は資料庫に入らない");
  sdb.close();
  const dataFile = "registry-script-db.json";
  const penv = { ...env, DATA_FILE_NAME: dataFile };
  const promote = (...a) => execFileSync("node", [path.join(root, "scripts/registry/promote-knowledge.mjs"), "--json", "--db", mfile, ...a], { cwd: work, env: penv, encoding: "utf8" });
  const dry = promote();
  ok(/追加 3・更新 0・削除 0/.test(dry) && dry.includes("確認だけ") === false && dry.includes("--apply"), "確認だけ (書き込まない): 追加 3");
  const applied = promote("--apply");
  ok(/書き込みました \(サンプルデータ\): 追加 3/.test(applied), "サンプルデータに書き込む");
  const saved = JSON.parse(fs.readFileSync(path.join(work, "data", dataFile), "utf8"));
  const kn = saved.knowledge.filter((k) => k.sourceRef?.startsWith("material:"));
  eq(kn.map((k) => k.visibility).sort(), ["all", "hq", "manager"], "社内資料の見られる人: 理念 = 全員・業者価格表 = 本部以上・議事録 = 店長以上");
  ok(kn.some((k) => k.body.includes("01_社内ルール・マニュアル/社内総合マニュアル.xlsx")), "社内資料の出典は source/ の場所");
  ok(saved.auditLogs.some((l) => l.entity === "knowledge" && l.summary.includes("クライアント資料から社内資料を登録")), "変更履歴に残す");
  ok(/追加 0・更新 0・削除 0/.test(promote()), "もう一度そろえても変わらない");

  // 人がファイルを動かす・新しい資料を置く → ID を引き継ぐ・新しい資料は分野のフォルダーの扱い・索引も新しくなる
  fs.mkdirSync(path.join(dir, "01_社内ルール・マニュアル", "マニュアル"), { recursive: true });
  fs.renameSync(path.join(dir, "01_社内ルール・マニュアル", "社内総合マニュアル.xlsx"), path.join(dir, "01_社内ルール・マニュアル", "マニュアル", "社内総合マニュアル.xlsx"));
  fs.mkdirSync(path.join(dir, "12_商品・価格"), { recursive: true });
  fs.writeFileSync(path.join(dir, "12_商品・価格", "新商品の案内.xlsx"), xlsxBuffer([["案内", [["新商品", "和紙畳 (テスト)"]]]]));
  const out3 = scan();
  ok(/読み直し 2・変わらず 3/.test(out3) && /あとから追加 1・場所が変わった 1/.test(out3), "動かした資料と新しい資料だけ読む");
  const man = SRC.readManifest(dir);
  const movedEntry = man.entries.find((e) => e.path === "01_社内ルール・マニュアル/マニュアル/社内総合マニュアル.xlsx");
  eq([movedEntry?.id, movedEntry?.from], [legacy("08_事務/社内総合マニュアル.xlsx"), "08_事務/社内総合マニュアル.xlsx"], "索引: 動かした資料は ID と整理する前の場所を引き継ぐ");
  const addedEntry = man.entries.find((e) => e.path === "12_商品・価格/新商品の案内.xlsx");
  ok(addedEntry?.id?.startsWith("ms_") && addedEntry.addedAt && !addedEntry.from, "索引: あとから置いた資料 (ms_ の ID)");
  ok(man.entries.some((e) => e.role === "download-log"), "索引: 取得の記録の行は残す");
  sdb = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(mfile, { readOnly: true });
  eq(sdb.prepare("select count(*) n from docs").get().n, 5, "資料庫: 動かした資料は同じ行 (増えない)");
  const addedRow = sdb.prepare("select folder, category, visibility, rule_id from docs where id = ?").get(addedEntry.id);
  eq([addedRow.folder, addedRow.category, addedRow.visibility, addedRow.rule_id], ["12_商品・価格", "商品・価格", "hq", "folder:商品・価格"], "資料庫: 新しい資料は分野のフォルダーの扱い");
  sdb.close();
  ok(/追加 0・更新 2・削除 0/.test(promote()), "動かしても同じ社内資料を更新する (出典の場所だけ。追加・削除にならない)");

  // Supabase に登録する行 (source_items・source_texts。画像・フォルダーは場所だけ)
  const SS = await imp("lib/registry/supabase-sync.ts");
  const SCHEMA = await imp("lib/db/schema.ts");
  const { buildTablesSql, buildSchemaSql } = await import(path.join(root, "scripts/import/schema-sql.mjs"));
  fs.mkdirSync(path.join(dir, "20_写真", "その他"), { recursive: true });
  fs.writeFileSync(path.join(dir, "20_写真", "その他", "a.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const mdb2 = M.openMaterials(mfile);
  ok(SS.buildSourceRows(mdb2, dir).problems.some((x) => x.includes("まだ読み取っていない: 20_写真/その他/a.jpg")), "読み取っていないファイルがあれば書かない (先に読み取り)");
  M.closeMaterials();
  scan();
  const mdb3 = M.openMaterials(mfile);
  const rows = SS.buildSourceRows(mdb3, dir, { sourceFileIds: new Set([legacy("07_販促/議事録.xlsx")]) });
  eq(rows.problems, [], "読み取りが新しければ問題なし");
  const item = (p) => rows.items.find((i) => i.path === p);
  const img = item("20_写真/その他/a.jpg");
  eq([img?.entry, img?.content, img?.kind, rows.texts.some((t) => t.itemId === img?.id)], ["file", "path_only", "image", false], "画像は場所だけ (中身の行なし)");
  const fol = item("20_写真/その他");
  eq([fol?.entry, fol?.content, fol?.kind, fol?.parentPath, fol?.visibility], ["folder", "path_only", "folder", "20_写真", "manager"], "フォルダーも場所だけ (見られる人は分野のフォルダー)");
  eq(item("15_人事・労務/個人の情報（取り込まない）")?.visibility, "admin", "個人の情報のフォルダーは管理者のみ");
  const kei = item(`${P15}/慶弔リスト.xlsx`);
  eq([kei?.content, kei?.sheetNames, kei?.summary, rows.texts.some((t) => t.itemId === kei?.id)], ["excluded", null, null, false], "個人の情報は中身もシート名も持たない");
  const manualItem = item("01_社内ルール・マニュアル/マニュアル/社内総合マニュアル.xlsx");
  const manualTexts = rows.texts.filter((t) => t.itemId === manualItem?.id);
  eq([manualItem?.content, manualItem?.originalPath, manualTexts.length, manualTexts.map((t) => t.visibility).sort()], ["text", "08_事務/社内総合マニュアル.xlsx", M.getChunks(mdb3, manualItem.id).length, ["all", "hq"]], "文書は中身の節 (節ごとの見られる人)・整理する前の場所");
  eq(item("07_議事録・会議/議事録.xlsx")?.sourceFileId, legacy("07_販促/議事録.xlsx"), "資料台帳 (source_files) にある資料は同じ ID でつなぐ");
  eq([item("README.md")?.entry, item("README.md")?.visibility, item("_index/manifest.json")?.visibility, item("07_議事録・会議/Thumbs.db")?.entry], ["system", "all", "admin", "system"], "システムのファイル (README・索引・OS の管理ファイル) も場所だけ");
  eq(new Set(rows.items.map((i) => i.id)).size, rows.items.length, "行の ID は重ならない");
  eq(new Set(rows.items.map((i) => i.path)).size, rows.items.length, "場所は重ならない");
  const snk = SS.snakeRow(manualItem, { registeredAt: "x" });
  ok("original_path" in snk && "row_hash" in snk && snk.registered_at === "x" && !("originalPath" in snk), "Supabase の列名 (snake_case)");
  const cols = new Set(SCHEMA.SUPABASE_ONLY_TABLES[0].columns.map(([f]) => f));
  ok(Object.keys(manualItem).every((k) => cols.has(k)) && ["registeredAt", "updatedAt"].every((k) => cols.has(k)), "行の項目は source_items の列と合う");
  const tcols = new Set(SCHEMA.SUPABASE_ONLY_TABLES[1].columns.map(([f]) => f));
  ok(Object.keys(manualTexts[0]).every((k) => tcols.has(k)) && tcols.size === Object.keys(manualTexts[0]).length, "中身の行は source_texts の列と合う");
  // 比べる: 同じなら書かない・変わった行だけ・中身の指紋が変わった資料だけ書き直す・なくなった行は消す
  const cur = rows.items.map((i) => ({ id: i.id, rowHash: i.rowHash, contentHash: i.contentHash }));
  const same = SS.diffSourceRows(cur, rows.items);
  eq([same.insert.length, same.update.length, same.remove.length, same.textsFor.length], [0, 0, 0, 0], "同じなら何も書かない");
  const changed = SS.diffSourceRows([...cur.map((c) => (c.id === manualItem.id ? { ...c, rowHash: "old", contentHash: "old" } : c)), { id: "gone", rowHash: "x", contentHash: "y" }], rows.items);
  eq([changed.update.map((i) => i.id), changed.textsFor, changed.remove], [[manualItem.id], [manualItem.id], ["gone"]], "変わった行・中身・なくなった行だけ");
  eq(SS.diffSourceRows([], rows.items).insert.length, rows.items.length, "初めては全部追加");
  M.closeMaterials();
  const off = execFileSync("node", [path.join(root, "scripts/registry/sync-supabase.mjs"), "--offline", "--dir", dir, "--db", mfile], { cwd: work, env, encoding: "utf8" });
  ok(/登録する行: \d+ \(ファイル 6・フォルダー \d+・システムのファイル \d+\)/.test(off) && /取り込まない 1/.test(off), "スクリプト (接続なしの確認): ファイル・フォルダー・システムのファイルの件数");
  // 表の定義: Supabase にだけ置く表 (アプリはメモリに読み込まない)
  ok(SCHEMA.SUPABASE_ONLY_TABLES.every((t) => !SCHEMA.TABLES.some((x) => x.table === t.table || x.collection === t.collection)), "source_items・source_texts はアプリの表 (メモリに読み込む表) に入れない");
  ok(!("sourceItems" in store.getDb()) && !("sourceTexts" in store.getDb()), "アプリのデータ (メモリ) に入らない");
  const ddl = buildTablesSql(SCHEMA.SUPABASE_ONLY_TABLES);
  ok(/create table if not exists source_items/.test(ddl) && /create table if not exists source_texts/.test(ddl) && /alter table source_texts enable row level security/.test(ddl) && !/create table if not exists orders/.test(ddl), "同期のスクリプトが作るのはこの 2 つの表だけ (RLS 有効)");
  const full = buildSchemaSql();
  ok(full.indexOf("create table if not exists source_items") > full.indexOf("create table if not exists source_files") && /revoke all on table source_texts from anon, authenticated/.test(full), "db:migrate の定義にも入る (RLS・権限)");

  // 整理する前の並びを前提にした取込のための再現
  const view = SRC.legacyView(dir);
  ok(fs.realpathSync(path.join(view, "08_事務/社内総合マニュアル.xlsx")) === fs.realpathSync(path.join(dir, "01_社内ルール・マニュアル/マニュアル/社内総合マニュアル.xlsx")) && fs.existsSync(path.join(view, "08_事務/_download-log.md")), "整理する前の並びを一時フォルダーに再現できる (取得の記録も)");
  fs.rmSync(view, { recursive: true, force: true });
  eq(SRC.findSourceFiles(dir, /(^|\/)慶弔リスト\.xlsx$/).map((f) => path.relative(dir, f)), [`${P15}/慶弔リスト.xlsx`], "名前で source/ の資料を探す");
  eq(SRC.locateByOrigin(dir, "07_販促/議事録.xlsx"), path.join(dir, "07_議事録・会議", "議事録.xlsx"), "整理する前の場所から、いまの場所");
}

/* ================================================================== */
section("source/ (実際のクライアント資料。あれば): 索引とファイルが合っている・どのファイルも規則に当たる");
{
  const SRC = await imp("lib/registry/source.ts");
  const real = SRC.sourceDir(root);
  const man = fs.existsSync(real) ? SRC.readManifest(real) : null;
  if (man) {
    const files = SRC.listSourceFiles(real);
    const inIndex = new Set(man.entries.filter((e) => e.role === "material").map((e) => e.path.normalize("NFC")));
    const notIndexed = files.filter((f) => !inIndex.has(f.rel.normalize("NFC")));
    const missing = [...inIndex].filter((p) => !fs.existsSync(path.join(real, ...p.split("/"))));
    ok(!missing.length, `索引の資料はすべてある (${inIndex.size} 件${missing.length ? `。ない: ${missing.slice(0, 3).join("、")}` : ""})`);
    ok(true, `索引にまだない資料 ${notIndexed.length} 件 (次の読み取りで索引に入る)`);
    const ids = man.entries.filter((e) => e.id).map((e) => e.id);
    eq(new Set(ids).size, ids.length, "索引の ID は重ならない");
    const generic = files.filter((f) => C.classifyPath(f.rel, E.kindOfExt((/\.([^./]+)$/.exec(f.rel)?.[1] ?? "").toLowerCase())).ruleId === "generic");
    ok(!generic.length, `どのファイルも規則か分野のフォルダーに当たる${generic.length ? ` (当たらない: ${generic.slice(0, 3).map((f) => f.rel).join("、")})` : ""}`);
    const top = new Set(files.map((f) => f.rel.split("/")[0]));
    ok([...top].every((t) => C.SOURCE_FOLDERS.some((x) => x.folder === t)), `資料は分野のフォルダーにだけある (${[...top].filter((t) => !C.SOURCE_FOLDERS.some((x) => x.folder === t)).join("、") || "ほかなし"})`);
    const personal = files.filter((f) => f.rel.startsWith("15_人事・労務/個人の情報"));
    ok(personal.every((f) => C.classifyPath(f.rel, "spreadsheet").action === "exclude"), `個人の情報のフォルダー (${personal.length} 件) はすべて取り込まない`);
  } else ok(true, "source/ がないため省略");
}

M.closeMaterials();
summary();
