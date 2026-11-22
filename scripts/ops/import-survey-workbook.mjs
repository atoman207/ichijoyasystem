#!/usr/bin/env node
/**
 * スプレッドシート「お客様アンケート集計表」を取り込む (クレーム・手直し / Google 口コミ / アンケートの過去の集計。KPI のタブは照合だけ)
 *
 *   node scripts/ops/import-survey-workbook.mjs                       (試し: 何も書かない。source/ の最新の「お客様アンケート集計表」を読む)
 *   node scripts/ops/import-survey-workbook.mjs --apply               (書き込む)
 *   node scripts/ops/import-survey-workbook.mjs --dir <タブごとの CSV のフォルダー> | --file <.xlsx・.csv> [--file …] [--start-year 2024] [--apply]
 *   --json                                                            (サンプルデータ data/db.json に書く。DATA_BACKEND=json)
 *
 * 画面 (KPI → スプレッドシートの取込) と同じ処理 (src/lib/survey-workbook/plan.ts)。書き込みはアプリと同じ store.ts の mutate
 * (変更の記録 app_changes で他のインスタンスも取り込む)。変更履歴の利用者は「system」。同じ行を 2 回取り込んでも二重にならない (行ごとの印)。
 * 指定がなければ source/ の「お客様アンケート集計表」のタブごとの CSV のフォルダー (なければ .xlsx) を読む (source/README.md)
 */
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { loadEnv } from "../import/env.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const JSON_BACKEND = args.includes("--json");
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));

loadEnv();
if (JSON_BACKEND) process.env.DATA_BACKEND = "json";
process.env.DB_SNAPSHOT = "off"; // 本番の控え (/srv/ichijoya/data/cache) に書かない
process.env.ICHIJOYA_DATA_DB = "off"; // VPS の写しに書かない (アプリが変更の記録から取り込む)

const { sourceDir } = await imp("lib/registry/source.ts");
const SOURCE = sourceDir(root);

/** 取り込むファイル: 指定 → source/ のタブごとの CSV のフォルダー (新しいもの) → source/ の .xlsx */
function pickFiles() {
  const files = args.flatMap((a, i) => (a === "--file" ? [args[i + 1]] : []));
  const dir = opt("--dir");
  if (dir) return fs.readdirSync(dir).filter((f) => /\.(csv|xlsx)$/i.test(f)).map((f) => path.join(dir, f));
  if (files.length) return files;
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name.startsWith("_") ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])) : []);
  const all = walk(SOURCE).filter((f) => /お客様アンケート集計表/.test(f.normalize("NFKC")));
  const csv = all.filter((f) => /\.csv$/i.test(f));
  if (csv.length) {
    // タブごとの CSV のフォルダーのうち、最も新しいもの
    const dirs = [...new Set(csv.map((f) => path.dirname(f)))].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return csv.filter((f) => path.dirname(f) === dirs[0]);
  }
  return all.filter((f) => /\.xlsx$/i.test(f)).slice(0, 1);
}

const files = pickFiles();
if (!files.length) {
  console.error(`取り込むファイルがありません (--dir / --file で指定するか、${path.relative(root, SOURCE)}/ に「お客様アンケート集計表」を置いてください)`);
  process.exit(2);
}

const store = await imp("lib/db/store.ts");
const R = await imp("lib/survey-workbook/read.ts");
const P = await imp("lib/survey-workbook/plan.ts");
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const startYear = opt("--start-year") ? Number(opt("--start-year")) : undefined;

console.log(`[survey-workbook] ${APPLY ? "書き込み" : "試し (書き込まない)"} / 今日 ${today} / バックエンド ${store.BACKEND}`);
console.log(`[survey-workbook] ファイル ${files.length} 件: ${files.map((f) => path.relative(root, f)).join(", ").slice(0, 400)}`);
const { tabs, problems } = R.tabsFromFiles(files.map((f) => ({ name: path.basename(f), bytes: fs.readFileSync(f) })));
if (problems.length) console.log(`[survey-workbook] 読み取りの注意: ${problems.join(" / ")}`);
const db = await store.syncDb();
if (store.BACKEND === "supabase") {
  const { missingTables } = await imp("lib/db/supabase.ts");
  if (missingTables().includes("survey_history")) {
    console.error("[survey-workbook] データベースに survey_history の表がありません。先に npm run db:migrate を実行してください (クレーム・手直しの新しい列も同じ反映で追加されます)");
    if (APPLY) process.exit(1);
  }
}
const plan = P.planWorkbook(db, tabs, { today, startYear });
const c = plan.claims;
const r = plan.reviews;
const h = plan.history;
console.log(`[survey-workbook] タブ: ${plan.tabs.map((t) => `${t.title} (${t.kind})`).join(", ")}`);
console.log(`[survey-workbook] クレーム・手直し ${c.items.length} 件: 新規 ${c.create}・更新 ${c.update}・変更なし ${c.unchanged}・案件にひも付け ${c.linked}・集計に入れない ${c.notCounted}・要確認 ${c.review}・期間の重なりで読まない行 ${c.overlapSkipped}`);
console.log(`[survey-workbook] Google 口コミ ${r.items.length} 件: 新規 ${r.create}・更新 ${r.update}・変更なし ${r.unchanged}・最初の行の年 ${r.startYear ?? "-"}${r.unmatched.length ? `・アカウントのない名前 ${r.unmatched.map((u) => `${u.name} ${u.count} 件`).join("・")}` : ""}`);
console.log(`[survey-workbook] アンケートの過去の集計 ${h.rows.length} 行: 新規 ${h.create}・更新 ${h.update}・変更なし ${h.unchanged} (${h.blocks.map((b) => `${b.fiscalLabel}${b.storeId ? `/${b.storeId}` : ""}`).join(" ")})`);
for (const y of plan.kpi) console.log(`[survey-workbook] KPI の照合 ${y.label} (${y.period.from}〜${y.period.to}): 一致 ${y.matched}・差あり ${y.differ}`);
for (const p of plan.problems) console.log(`[survey-workbook] 問題: ${p}`);
for (const w of plan.warnings) console.log(`[survey-workbook] 注意: ${w}`);
if (!APPLY) {
  console.log("[survey-workbook] 試しのため書き込みませんでした。書き込むときは --apply を付けてください");
  process.exit(0);
}
let summary = "";
await store.mutate((d) => {
  const res = P.applyWorkbook(d, tabs, { today, startYear, userId: "system", label: `${files.length === 1 ? path.basename(files[0]) : `${path.basename(path.dirname(files[0]))} (${files.length} ファイル)`} (スクリプト)` });
  summary = res.summary;
});
console.log(`[survey-workbook] 取り込みました: ${summary}`);
process.exit(0);
