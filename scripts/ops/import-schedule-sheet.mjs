#!/usr/bin/env node
/**
 * 予定表 (スプレッドシート) の月のファイル (.xlsx) を、動いているサーバーに取り込む (開発担当用。お客様は画面
 * 予定表 →「スプレッドシートの取込」で同じことができる)。/api/cron/schedule-sheet を CRON_SECRET で呼ぶ。
 *
 *   node scripts/ops/import-schedule-sheet.mjs --base http://127.0.0.1:3300 --env-file /srv/ichijoya/testweek/testweek.env \
 *     [--from 2026-11-24] [--alias 光子=<社員の名前か ID>] [--apply] 2026.11.xlsx 2026.12.xlsx
 *
 * --apply がなければ照合の結果を出すだけ (書き込まない)。試験期間 (〜11/30) はテスト用のサーバー (3300) に取り込む
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = new Set(args.filter((a) => a.startsWith("--") && !["--base", "--env-file", "--from", "--alias"].includes(a)));
const files = args.filter((a, i) => !a.startsWith("--") && !["--base", "--env-file", "--from", "--alias"].includes(args[i - 1]));
const base = (opt("--base") ?? "http://127.0.0.1:3300").replace(/\/$/, "");
const from = opt("--from");
const aliases = args.flatMap((a, i) => (args[i - 1] === "--alias" ? [a] : []));

let secret = process.env.CRON_SECRET ?? "";
const envFile = opt("--env-file");
if (!secret && envFile) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*CRON_SECRET\s*=\s*(.*)\s*$/);
    if (m) secret = m[1].replace(/^["']|["']$/g, "");
  }
}
if (!secret) {
  console.error("CRON_SECRET がありません (環境変数か --env-file で渡してください)");
  process.exit(2);
}
if (!files.length) {
  console.error("取り込む .xlsx を指定してください");
  process.exit(2);
}

async function call(action, query = {}, body, type = "application/octet-stream") {
  const q = new URLSearchParams({ action, ...query, ...(from ? { from } : {}) });
  const res = await fetch(`${base}/api/cron/schedule-sheet?${q}`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": type }, body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${action}: ${res.status} ${j.error ?? ""}`);
  return j;
}

let batch;
for (const f of files) {
  const r = await call("upload", { name: path.basename(f), ...(batch ? { batch } : {}) }, fs.readFileSync(f));
  batch = r.batch;
  console.log(`読み込み: ${r.label} (${r.days} 日・${r.events} 件) 人: ${r.persons.join("・")}${r.problems.length ? ` 注意: ${r.problems.join(" / ")}` : ""}`);
}
if (aliases.length) {
  const body = Object.fromEntries(aliases.map((a) => a.split("=").map((x) => x.trim())));
  const r = await call("alias", {}, JSON.stringify(body), "application/json");
  console.log("名前の対応:", JSON.stringify(r.aliases));
}
const plan = await call("plan", { batch });
console.log(`\n照合 (${plan.from}〜${plan.to}):`, JSON.stringify(plan.counts));
console.log("右上・事務の人:", plan.persons.map((p) => `${p.name}(${p.count})→${p.user ?? "未設定"}`).join(" / "));
if (plan.unknownNames.length) console.log("社員に当たらない名前:", plan.unknownNames.map((u) => `${u.name}(${u.count})`).join(" / "));
if (plan.duplicates.length) console.log(`登録済みのため取り込まない ${plan.duplicates.length} 件:\n  ${plan.duplicates.slice(0, 30).join("\n  ")}`);
if (plan.ambiguous.length) console.log(`お客様の候補が複数 ${plan.ambiguous.length} 件 (既定の顧客):\n  ${plan.ambiguous.slice(0, 30).map((a) => `${a.name} → ${a.chosen}`).join("\n  ")}`);
if (plan.remove.length) console.log(`消す予定 ${plan.remove.length} 件:\n  ${plan.remove.slice(0, 30).join("\n  ")}`);
if (!flags.has("--apply")) {
  console.log(`\n(確認だけ。取り込むときは --apply。読み込んだ内容: batch=${batch})`);
  process.exit(0);
}
const r = await call("apply", { batch });
console.log("\n取り込みました:", r.summary);
