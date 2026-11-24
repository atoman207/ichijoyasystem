#!/usr/bin/env node
/**
 * 予定表の月ファイル (.xlsx) を、アプリと同じ照合・取込ロジックで直接取り込む
 * (サーバー未起動でも可。HTTP の import-schedule-sheet.mjs / 画面の取込と同じ結果)
 *
 *   node scripts/ops/run-schedule-sheet-files.mjs [--from 2026-11-24] [--apply] \
 *     [source/04_予定表・作業日報/予定表/2026.11.xlsx] […/2026.12.xlsx]
 *
 * 指定がなければ source/04_予定表・作業日報/予定表 の 2026.11.xlsx・2026.12.xlsx を使う。
 * --apply がなければ照合だけ (書き込まない)。既定の from は明日 (今日の予定は触らない)。
 */
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { loadEnv } from "../import/env.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fromOpt = (() => {
  const i = args.indexOf("--from");
  return i >= 0 ? args[i + 1] : undefined;
})();
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--from");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
process.chdir(root);
loadEnv(root);

const defaultDir = path.join(root, "source", "04_予定表・作業日報", "予定表");
const targets = (files.length ? files : ["2026.11.xlsx", "2026.12.xlsx"].map((n) => path.join(defaultDir, n))).map((f) => path.resolve(f));
for (const f of targets) {
  if (!fs.existsSync(f)) {
    console.error(`ファイルがありません: ${f}`);
    process.exit(2);
  }
}

process.env.DB_SNAPSHOT = process.env.DB_SNAPSHOT ?? "off";
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));

const store = await imp("lib/db/store.ts");
const { readScheduleWorkbook } = await imp("lib/schedule-sheet/read.ts");
const { planSheetImport, applySheetImport } = await imp("lib/schedule-sheet/plan.ts");
const { addDays, toDateKey } = await imp("lib/format.ts");
const { SYSTEM_USER } = await imp("lib/notify/inbound.ts");

const today = toDateKey(new Date());
const from = fromOpt && /^\d{4}-\d{2}-\d{2}$/.test(fromOpt) ? fromOpt : addDays(today, 1);
if (from < today) {
  console.error(`from は今日 (${today}) 以降にしてください`);
  process.exit(2);
}

console.log(`[sheet] ${APPLY ? "書き込み" : "照合のみ"} / 今日 ${today} / from ${from} / backend ${store.BACKEND}`);
const db = await store.syncDb();
const stores = db.stores.map((s) => ({ id: s.id, name: s.name, shortName: s.shortName }));

const months = [];
for (const f of targets) {
  const name = path.basename(f);
  const bytes = new Uint8Array(fs.readFileSync(f));
  const month = readScheduleWorkbook(name, bytes, stores);
  months.push(month);
  console.log(`読み込み: ${month.label} → ${month.days.length} 日・${month.events.length} 件・人 ${month.persons.join("・") || "(なし)"}${month.problems.length ? `\n  注意: ${month.problems.join(" / ")}` : ""}`);
}

const plan = planSheetImport(db, months, { from });
const c = plan.counts;
console.log(`\n照合 (${plan.from}〜${plan.to}):`, c);
console.log("右上・事務の人:", plan.persons.map((p) => `${p.name}(${p.count})→${p.userName ?? "未設定"}`).join(" / ") || "(なし)");
if (plan.unknownNames.length) console.log("社員に当たらない名前:", plan.unknownNames.slice(0, 40).map((u) => `${u.name}(${u.count})`).join(" / "));
const amb = plan.groups.filter((g) => g.ambiguous);
if (amb.length) {
  console.log(`お客様の候補が複数 ${amb.length} 件 (既定の顧客を採用):`);
  for (const g of amb.slice(0, 40)) {
    const chosen = g.candidates.find((x) => x.id === g.auto)?.label ?? g.choice;
    console.log(`  (${g.area ?? ""}${g.area ? " " : ""}${g.name}) → ${chosen}`);
  }
}
const dups = plan.items.filter((i) => i.status === "duplicate");
if (dups.length) console.log(`登録済みのため取り込まない ${dups.length} 件`);
if (plan.remove.length) console.log(`消す予定 ${plan.remove.length} 件 (以前の取込でシートに無いもの)`);
if (plan.keep.length) console.log(`新システムで変更済みのため残す ${plan.keep.length} 件`);

const sample = plan.items.filter((i) => i.status === "add" || i.status === "update").slice(0, 25);
if (sample.length) {
  console.log("\n取り込む予定 (先頭):");
  for (const i of sample) {
    console.log(`  ${i.ev.date} [${i.status}] ${i.storeId} ${i.ev.kind} ${i.title}`);
  }
}

if (!APPLY) {
  console.log("\n(確認だけ。取り込むときは --apply を付けて再実行)");
  process.exit(0);
}

let summary = "";
await store.mutate((d) => {
  const p = planSheetImport(d, months, { from });
  summary = applySheetImport(d, p, { id: SYSTEM_USER }, months.map((m) => m.label).join("・")).summary;
});
console.log("\n取り込みました:", summary);
console.log("変更履歴・顧客・問い合わせ・予定は本番 DB に反映済みです (11/30 の引き継ぎ対象に含まれます)。");
