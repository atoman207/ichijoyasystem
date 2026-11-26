#!/usr/bin/env node
/**
 * 勤怠の月次表 (令和○年度.xlsx) を取り込む
 *
 *   node scripts/ops/import-attendance-workbook.mjs [--apply] [--force] [path.xlsx]
 *
 * 指定がなければ source/15_人事・労務/勤怠/令和8年度_勤怠月次.xlsx
 * --apply がなければ照合だけ (書き込まない)。--force は確定済みも置き換え
 * .env.local が Supabase (本番のデータベース) を指すときの --apply は --prod も付ける。
 * 試験期間 (2026-11-23〜11-30) はお客様のデータをテスト用のデータベースに入れるので、画面 (勤怠 → 労務士へ送る勤務表 → 以前の表の取込) を使う
 */
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { loadEnv } from "../import/env.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const fileArg = args.find((a) => !a.startsWith("--"));

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
process.chdir(root);
loadEnv(root);

const defaultFile = path.join(root, "source", "15_人事・労務", "勤怠", "令和8年度_勤怠月次.xlsx");
const target = path.resolve(fileArg || defaultFile);
if (!fs.existsSync(target)) {
  console.error(`ファイルがありません: ${target}`);
  process.exit(2);
}

process.env.DB_SNAPSHOT = process.env.DB_SNAPSHOT ?? "off";
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));

const store = await imp("lib/db/store.ts");
const { parseAttendanceWorkbook, applyAttendanceSheet, attendanceCsv } = await imp("lib/hr/attendance.ts");
const { SYSTEM_USER } = await imp("lib/notify/inbound.ts");

const buf = fs.readFileSync(target);
const sheets = parseAttendanceWorkbook(buf);
console.log(`[attendance] ${APPLY ? "書き込み" : "照合のみ"} / ${path.basename(target)} / sheets ${sheets.length} / backend ${store.BACKEND}`);
for (const s of sheets) {
  const staff = s.lines.filter((l) => l.kind === "staff").length;
  const part = s.lines.filter((l) => l.kind === "part").length;
  console.log(`  ${s.yearMonth} (${s.sheetName}) ${s.payLabel ?? ""} 社員 ${staff}・パート ${part}`);
}
if (!sheets.length) {
  console.error("勤怠の月次シートが見つかりません。");
  process.exit(2);
}

await store.syncDb();
if (APPLY && store.BACKEND === "supabase" && !args.includes("--prod")) {
  console.error("本番のデータベース (Supabase) に書き込むときは --prod も付けてください。試験期間中は画面の取込 (テスト用のデータベース) を使います。");
  process.exit(2);
}
if (!APPLY) {
  console.log("書き込むときは --apply を付けて再実行してください。");
  process.exit(0);
}

const now = new Date().toISOString();
const results = [];
await store.mutate((db) => {
  for (const sheet of sheets) {
    const r = applyAttendanceSheet(db, sheet, {
      userId: SYSTEM_USER,
      now,
      makeId: store.newId,
      sourceLabel: path.basename(target).slice(0, 120),
      force: FORCE,
    });
    results.push(r);
    const month = db.attendanceMonths.find((m) => m.id === r.monthId);
    if (month) {
      const csvPath = path.join(path.dirname(target), `勤怠月次_${r.yearMonth}.csv`);
      fs.writeFileSync(csvPath, attendanceCsv(db, month), "utf8");
      console.log(`  CSV: ${csvPath}`);
    }
  }
  store.addAudit(db, {
    userId: SYSTEM_USER,
    action: "import",
    entity: "attendance_month",
    entityId: "workbook",
    entityLabel: path.basename(target).slice(0, 80),
    summary: `勤怠月次を取込 (ops): ${results.map((r) => `${r.yearMonth}(${r.lines})`).join("・")}`,
  });
});
console.log("結果:", results.map((r) => `${r.yearMonth}: ${r.lines} 行`).join(", "));
process.exit(0);
