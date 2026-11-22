/**
 * 手書き見積書の読取と「金額を書く前に撮影」の計算のテスト
 *   node scripts/tests/capture/quote-calc.test.mjs   (npm run test:capture)
 * 1. 割合の値引きの読み取り (2割引・1割5分引・20%引)
 * 2. 計算 (数量 × 単価・金額だけの行・割合の値引き・税込 / 税抜・値引き) — お客様の見本の見積書 2 枚と同じ数字
 * 3. 書き写しの照合 (一致・違い・読み取れない・行の読み落とし)
 * 4. 読取結果の整形 (値引きの符号・消して書き直した箇所・計算の読み方の合計)
 * 5. Server Action (撮影 → 計算 → 数量の修正 → 書き写しの照合 → 確認画面) をサンプルの読取で通す
 * AI は呼ばない (キーを消す)。データは一時フォルダーの JSON
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-capture-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "capture-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-capture",
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

const C = await imp("lib/quote-sheet-calc.ts");
const O = await imp("lib/ai/ocr.ts");

/* ================================================================== */
section("1. 割合の値引きの読み取り");
eq(C.discountRate("カーテン2割引"), 0.2, "「2割引」は 0.2");
eq(C.discountRate("畳 1割5分引き"), 0.15, "「1割5分引き」は 0.15");
eq(C.discountRate("20%引"), 0.2, "「20%引」は 0.2");
eq(C.discountRate("１５％ＯＦＦ"), 0.15, "全角の「１５％ＯＦＦ」も読む");
eq(C.discountRate("DM値引"), undefined, "割合のない値引きは割合にしない");
eq(C.discountRate("畳表替え 2割増し"), undefined, "「2割増し」は値引きではない");
eq(C.rowRate({ name: "2割引", amount: -1000 }), undefined, "金額が書かれた値引きの行は書かれた金額を使う (割合で計算しない)");

/* ================================================================== */
section("2. 計算 (お客様の見本の見積書と同じ数字)");
// 見本 1 (税込): 18 行の畳・襖・障子 + 諸経費 = 753,500、値引き ▲13,500 → 740,000
const b = [
  { name: "畳表替え", spec: "さくら", qty: 18, unitPrice: 19800 },
  { name: "畳表替え", spec: "へり 織部8", qty: 18, unitPrice: 2200 },
  { name: "畳表替え", spec: "防ダニ", qty: 18, unitPrice: 2200 },
  { name: "襖張替え", spec: "朱雀153 押入片面", qty: 4, unitPrice: 23100 },
  { name: "襖張替え", spec: "朱雀164", qty: 2, unitPrice: 14300 },
  { name: "襖張替え", spec: "朱雀150", qty: 2, unitPrice: 15400 },
  { name: "襖張替え", spec: "朱雀178 仏間", qty: 1, unitPrice: 28600 },
  { name: "襖張替え PB", spec: "ちどり15 両面", qty: 2, unitPrice: 15950 },
  { name: "襖張替え PB", spec: "押入片面", qty: 2, unitPrice: 11000 },
  { name: "襖張替え PB", spec: "片面ガラ付", qty: 2, unitPrice: 12100 },
  { name: "引手", spec: "2寸丸 金", qty: 16, unitPrice: 1650 },
  { name: "引手", spec: "開き用丸引手", qty: 2, unitPrice: 3300 },
  { name: "下地補修", qty: 1, unitPrice: 1100 },
  { name: "障子", spec: "ワーロン 麻葉", qty: 2, unitPrice: 11000 },
  { name: "諸経費", amount: 3300 },
];
const rb = C.calcSheet(b, { taxIncluded: true, discount: 13500 });
eq(rb.rows.map((r) => r.amount), [356400, 39600, 39600, 92400, 28600, 30800, 28600, 31900, 22000, 24200, 26400, 6600, 1100, 22000, 3300], "行ごとの金額 = 数量 × 単価 (諸経費は書かれた金額)");
eq([rb.subtotal, rb.discount, rb.total, rb.tax], [753500, 13500, 740000, 67272], "小計 753,500 − 値引き 13,500 = 合計 740,000 (うち消費税 67,272)");
eq(rb.missing, [], "計算できない行はない");

// 見本 2 (税込): カーテン 52,360 → 2割引 ▲10,472 → 金券 ▲2,000 → 諸経費 3,300 = 43,188
const a = [
  { name: "カーテンレース", spec: "SC7658 W3700×H2170", qty: 1, unitPrice: 52360 },
  { name: "カーテン2割引" },
  { name: "金券", amount: -2000 },
  { name: "諸経費", amount: 3300 },
];
const ra = C.calcSheet(a, { taxIncluded: true });
eq(ra.rows.map((r) => r.amount), [52360, -10472, -2000, 3300], "「カーテン2割引」は上の行 52,360 × 2割 = ▲10,472");
eq(ra.total, 43188, "合計 43,188 (見本の訂正後の合計と同じ)");
eq(ra.rows[1].ambiguous, false, "対象が 1 行なら確認は不要");
eq(C.rateBasis(ra.rows[1]), "上の 1 行 52,360 円 × 2割", "値引きの根拠の説明");

const amb = C.calcSheet([{ name: "畳表替え", qty: 6, unitPrice: 15000 }, { name: "襖張替え", qty: 4, unitPrice: 5000 }, { name: "1割引" }], { taxIncluded: true });
ok(amb.rows[2].ambiguous === true && amb.rows[2].amount === -11000, "対象が 2 行以上の割合の値引きは要確認 (上の 2 行 110,000 × 1割 = ▲11,000)");
const after = C.calcSheet([{ name: "畳", qty: 1, unitPrice: 10000 }, { name: "2割引" }, { name: "襖", qty: 1, unitPrice: 5000 }, { name: "1割引" }], { taxIncluded: true });
eq(after.rows.map((r) => r.amount), [10000, -2000, 5000, -500], "割合の値引きは直前の値引きの行より後の行だけが対象");
const odd = C.calcSheet([{ name: "網戸", qty: 3, unitPrice: 3333 }, { name: "1割5分引" }], { taxIncluded: true });
eq(odd.rows[1].amount, -1499, "割合の値引きは円未満切り捨て (9,999 × 0.15 = 1,499.85 → ▲1,499)");
const nobase = C.calcSheet([{ name: "2割引" }], { taxIncluded: true });
ok(nobase.rows[0].amount === null && nobase.missing.length === 1, "上に行がない割合の値引きは計算できない (金額の入力を求める)");

const ex = C.calcSheet([{ name: "畳表替え", qty: 6, unitPrice: 12000 }, { name: "諸経費", amount: 3000 }], { taxIncluded: false });
eq([ex.subtotal, ex.tax, ex.total], [75000, 7500, 82500], "税抜: 消費税 = 小計 × 10%、合計 = 小計 + 消費税");
const half = C.calcSheet([{ name: "畳表替え", qty: 4.5, unitPrice: 15500 }], { taxIncluded: true });
eq(half.rows[0].amount, 69750, "小数の数量 (4.5 畳 × 15,500 = 69,750)");
const miss = C.calcSheet([{ name: "畳表替え", qty: 6 }, { name: "襖", qty: 2, unitPrice: 5000 }], { taxIncluded: true });
ok(miss.missing[0] === 0 && miss.total === 10000, "単価が読めない行は計算できない行として知らせ、合計は 0 円として計算");
const diff = C.calcSheet([{ name: "畳", qty: 6, unitPrice: 12000, amount: 70000 }], { taxIncluded: true });
ok(diff.rows[0].amount === 72000 && diff.rows[0].writtenDiffers === 70000, "金額欄に書かれた金額が数量 × 単価と違えば、計算を使って違いを知らせる");

/* ================================================================== */
section("3. 書き写しの照合");
const calcRows = a.map((r, i) => ({ ...r, amount: ra.rows[i].amount }));
const same = C.compareTranscription({ rows: calcRows, total: 43188 }, { rows: [{ name: "カーテンレース", qty: 1, unitPrice: 52360, amount: 52360 }, { name: "カーテン2割引", qty: 1, unitPrice: -10472, amount: -10472 }, { name: "金券", qty: 1, unitPrice: -2000, amount: -2000 }, { name: "諸経費", qty: 1, unitPrice: 3300, amount: 3300 }], total: 43188 });
ok(same.checked === 4 && same.matched === 4 && same.issues.length === 0 && same.totalMatched === true, "すべて一致");
const wrong = C.compareTranscription({ rows: calcRows, total: 43188 }, { rows: [{ name: "カーテンレース", qty: 1, unitPrice: 52360, amount: 52360 }, { name: "カーテン2割引", amount: -10427 }, { name: "金券", amount: -2000 }, { name: "諸経費", amount: 3300 }], total: 43233 });
ok(wrong.matched === 3 && wrong.rows.includes(1) && wrong.issues.some((t) => t.includes("書き写した ▲10,427 円 / 計算 ▲10,472 円")) && wrong.totalMatched === false, "書き写し違い (10,472 → 10,427) と合計の違いを見つける");
const dropped = C.compareTranscription({ rows: calcRows, total: 43188 }, { rows: [{ name: "カーテンレース", qty: 1, unitPrice: 52360, amount: 52360 }, { name: "金券", amount: -2000 }, { name: "諸経費", qty: 1, unitPrice: 3300, amount: 3300 }], total: 43188 });
ok(dropped.matched === 3 && dropped.issues.length === 1 && dropped.issues[0].includes("2 行目") && dropped.issues[0].includes("見つかりません"), "読み落とした行があっても、ほかの行は正しく対応づける");
const blank = C.compareTranscription({ rows: calcRows, total: 43188 }, { rows: [{ name: "カーテンレース", qty: 1, unitPrice: 52360, amount: 52360, amountCalculated: true }, { name: "カーテン2割引", amount: -10472 }, { name: "金券", amount: -2000 }, { name: "諸経費", amount: 3300 }] });
ok(blank.issues.some((t) => t.includes("1 行目") && t.includes("読み取れません")) && blank.issues.some((t) => t.includes("税込合計金額")), "金額欄が空 (数量 × 単価で埋めた) の行と、読めない合計を知らせる");
// 最初の読み取りで 52,360 を 52,310 と読み違え、職人がそのまま 52,310 と書き写した (実際の見本で起きた読み違い)
const misCalc = [{ name: "カーテンレース", qty: 1, unitPrice: 52310, amount: 52310 }, { name: "諸経費", qty: 1, unitPrice: 3300, amount: 3300 }];
const misread = C.compareTranscription({ rows: misCalc, total: 55610 }, { rows: [{ name: "カーテンレース", qty: 1, unitPrice: 52360, amount: 52310 }, { name: "諸経費", qty: 1, unitPrice: 3300, amount: 3300 }], total: 55610 });
ok(misread.matched === 1 && misread.rows.includes(0) && misread.issues.some((t) => t.includes("1 × 52,310") && t.includes("1 × 52,360")), "書き写した金額が計算と同じでも、用紙の単価が計算に使った単価と違えば知らせる (最初の読み違いを見つける)");

/* ================================================================== */
section("4. 読取結果の整形");
const products = [];
const n1 = O.normalizeExtracted("handwritten_quote", { customerName: "見本 様", taxMode: "税込", totalTaxIncluded: 740000, discount: -13500, items: b.map((r) => ({ ...r, amount: r.amount ?? Math.round(r.qty * r.unitPrice) })) }, products);
eq(n1.extracted.discount, 13500, "AI が ▲ をマイナスで返した値引きは正の数にする");
ok(!n1.warnings.some((w) => w.includes("一致しません")), "値引きの符号を直したので、明細の合計 − 値引き = 書かれた合計 (誤った不一致の警告を出さない)");
const n2 = O.normalizeExtracted("handwritten_quote", { customerName: "見本", corrections: ["合計 753,500 を消して 740,000"], items: [{ name: "襖", qty: 2, unitPrice: 15950, corrected: true, uncertain: true }] }, products);
ok(n2.warnings.some((w) => w.includes("消して書き直した箇所") && w.includes("753,500")), "消して書き直した箇所を注意に出す");
ok(n2.extracted.items[0].corrected === true && n2.extracted.items[0].uncertain === true, "書き直した行は「書き直しあり」+ 要確認");
const n3 = O.normalizeExtracted("handwritten_quote", { taxMode: "", items: a.map((r) => ({ ...r })) }, products, { mode: "calc" });
const rateRow = n3.extracted.items[1];
ok(rateRow.rate === 0.2 && rateRow.amount === -10472 && rateRow.qty === 1 && rateRow.unitPrice === -10472, "計算の読み方: 割合の値引きの行に金額を入れる (見積の明細として使える)");
eq([n3.extracted.subtotal, n3.extracted.total, n3.extracted.totalTaxIncluded, n3.extracted.taxIncluded], [43188, 43188, 43188, true], "計算の読み方: 小計・合計・税込合計金額はシステムの計算");
ok(n3.warnings.some((w) => w.includes("○がないため、税込")) && !n3.warnings.some((w) => w.includes("氏名")), "計算の読み方: 税込・税抜の○がなければ知らせる (氏名がなくても注意しない)");
ok(n3.extracted.items[0].amountCalculated === true, "金額欄が空の行は「数量 × 単価で計算」の印");
const n4 = O.normalizeExtracted("handwritten_quote", { taxMode: "税抜", items: [{ name: "畳表替え", qty: 6, unitPrice: 12000 }] }, products, { mode: "calc" });
eq([n4.extracted.tax, n4.extracted.total, n4.extracted.taxIncluded], [7200, 79200, false], "計算の読み方: 税抜なら外税 10%");

/* ================================================================== */
section("5. Server Action: 撮影 → 計算 → 修正 → 書き写しの照合");
const store = await imp("lib/db/store.ts");
const actions = await imp("lib/actions/capture.ts");
await store.syncDb();
const db = () => store.getDb();
const staff = db().users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_staff") ?? db().users.find((u) => u.active && u.role === "admin");
const other = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId !== staff.storeId);
const mock = O.mockExtract("handwritten_quote", "IMG_手書き見積_和室6畳.jpg", db().products, "calc");
ok(mock.provider === "mock" && mock.extracted.items.some((i) => i.rate === 0.1) && mock.extracted.totalTaxIncluded === C.calcSheet(mock.extracted.items, { taxIncluded: true }).total, "サンプルの読取 (AI のキーなし) でも計算の流れを試せる");

async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { msg: null, err: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { path: u.pathname, doc: u.searchParams.get("doc"), msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
    }
    throw e;
  } finally {
    globalThis.__testUser = undefined;
  }
}
const form = (obj) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) fd.set(k, String(v));
  return fd;
};

const up = await act(staff, () => actions.uploadDocument(form({ mode: "calc", kind: "receipt", storeId: staff.storeId, sampleName: "IMG_手書き見積_和室6畳.jpg" })));
const docId = up.doc;
const doc = () => db().documents.find((d) => d.id === docId);
ok(up.path === "/capture/calc" && docId && up.msg?.includes("書き写して"), "計算の撮影は計算の画面に戻る");
ok(doc()?.kind === "handwritten_quote" && doc()?.extracted?._mode === "calc", "書類の種類は手書き見積書 (送られた種類に関係なく)・読み方は計算");
const items0 = doc().extracted.items;
const total0 = doc().extracted.total;
ok(items0.some((i) => i.rate) && typeof total0 === "number" && total0 === C.calcSheet(items0, { taxIncluded: true }).total, "保存した合計は画面と同じ計算");

// 数量を 1 つ直して保存 (画面の「確かめた内容を保存」と同じ形)
const edited = items0.map((it, i) => (i === 0 ? { ...it, qty: it.qty + 2, uncertain: false } : it));
const sv = await act(staff, () => actions.saveCalc(form({ id: docId, data: JSON.stringify({ items: edited, taxMode: "税込", discount: 500 }) })));
const want = C.calcSheet(edited.map((it) => ({ ...it, amount: it.rate ? null : undefined })), { taxIncluded: true, discount: 500 });
ok(sv.path === "/capture/calc" && sv.msg?.includes("保存しました"), "修正の保存は計算の画面に戻る");
eq([doc().extracted.items[0].qty, doc().extracted.discount, doc().extracted.total], [items0[0].qty + 2, 500, want.total], "直した数量で金額・割合の値引き・合計を計算し直す");
ok(doc().extracted._mode === "calc" && doc().extracted._edited?.by === staff.id, "保存しても計算の読み方のまま・修正者を記録");
ok(db().auditLogs.some((l) => l.entityId === docId && l.summary.includes("金額の計算: 数量・単価を確認・修正") && l.changes?.[0]?.field === "total"), "変更履歴 (合計の変更前・変更後つき)");

if (other) {
  const denied = await act(other, () => actions.saveCalc(form({ id: docId, data: JSON.stringify({ items: edited }) })));
  ok(Boolean(denied.err), "ほかの店舗の社員は保存できない");
}

// 書き写した見積書をもう一度撮影 (サンプルの読取 = 記入済みの見積書として読む)
const rc = await act(staff, () => actions.recheckCalc(form({ id: docId })));
ok(rc.path === "/capture" && (rc.msg || rc.err)?.includes("書き写しの確認"), "照合のあとは書類取込の確認画面へ");
const d2 = doc();
ok(!d2.extracted._mode && d2.extracted._calc?.total === want.total && d2.extracted._calcCheck?.checked > 0, "照合のあとは記入済みの見積書。計算の結果と照合の結果を残す");
ok(d2.extracted._warnings?.[0]?.startsWith("書き写しの確認"), "照合の結果を注意の先頭に出す");
ok(d2.extracted._calcCheck.issues.length > 0 && d2.extracted.items.some((i) => i.uncertain), "サンプルの読取は値引きの行がないため、違いを見つけて黄色の行にする");

const sv2 = await act(staff, () => actions.saveExtraction(form({ id: docId, intent: "save", data: JSON.stringify({ customerName: "見本 太郎", items: d2.extracted.items }) })));
ok(sv2.path === "/capture" && doc().extracted._calc && doc().extracted._calcCheck, "確認画面で保存しても計算・照合の記録は残る");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
