#!/usr/bin/env node
/**
 * KPI の取込 (年間チラシ計画・アンケートハガキ（回答）・お客様アンケート集計表) をサーバーの /api/cron/kpi-import で行い、
 * KPI のタブとの照合 (支給前の照合) を出す。画面 KPI →「分母・照合」「スプレッドシートの取込」と同じ処理
 *
 *   node scripts/ops/import-kpi-sheets.mjs --base http://127.0.0.1:3300 --env-file /srv/ichijoya/testweek/testweek.env \
 *     [--basis 年間チラシ計画.xlsx --basis アンケートハガキ（回答）.xlsx] [--workbook お客様アンケート集計表.xlsx | --workbook <タブの CSV>…] \
 *     [--start-year 2024] [--apply]
 *
 * --apply がなければ確認だけ (書き込まない)。--apply のあとに照合の結果 (合わない行) を出す。
 * 試験期間 (〜11/30) はテスト用のサーバー (3300) に取り込む (本番のデータベースに直接書かない)
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const many = (k) => args.flatMap((a, i) => (args[i - 1] === k ? [a] : []));
const APPLY = args.includes("--apply");
const base = (opt("--base") ?? "http://127.0.0.1:3300").replace(/\/$/, "");
const basis = many("--basis");
const workbook = many("--workbook");
const startYear = opt("--start-year");

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
if (!basis.length && !workbook.length && !args.includes("--check")) {
  console.error("--basis か --workbook でファイルを指定してください (照合だけなら --check)");
  process.exit(2);
}
for (const f of [...basis, ...workbook]) {
  if (!fs.existsSync(f)) {
    console.error(`ファイルがありません: ${f}`);
    process.exit(2);
  }
}

async function call(action, kind, files = [], query = {}) {
  const q = new URLSearchParams({ action, ...(kind ? { kind } : {}), ...query });
  const body = new FormData();
  for (const f of files) body.append("files", new Blob([fs.readFileSync(f)]), path.basename(f));
  const res = await fetch(`${base}/api/cron/kpi-import?${q}`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: files.length ? body : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${kind ?? ""} ${action}: ${res.status} ${j.error ?? ""}`);
  return j;
}

if (basis.length) {
  const p = await call("plan", "basis", basis);
  console.log("\n■ 年間チラシ計画・アンケートハガキ（回答）の確認");
  if (p.problems?.length) console.log("  注意:", p.problems.join(" / "));
  console.log("  個人件数:", JSON.stringify(p.individual.counts), `(${p.individual.values.length} か月分)`);
  console.log("  はがき:", JSON.stringify(p.cards));
  if (APPLY) console.log("  取り込みました:", (await call("apply", "basis", basis)).summary);
}
if (workbook.length) {
  const query = startYear ? { startYear } : {};
  const p = await call("plan", "workbook", workbook, query);
  console.log("\n■ お客様アンケート集計表の確認");
  if (p.problems?.length) console.log("  注意:", p.problems.join(" / "));
  if (p.warnings?.length) console.log("  確認:", p.warnings.slice(0, 10).join(" / "));
  console.log("  タブ:", p.tabs.map((t) => `${t.title}(${t.label}・${t.rows} 行)`).join(" / "));
  const xMark = (r) => (r.status === "sheet" ? "△ シートの誤り" : "✗");
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
  console.log("  クレーム・手直し:", JSON.stringify(pick(p.claims, ["create", "update", "unchanged", "linked", "notCounted", "review", "overlapSkipped", "emptyRows"])));
  console.log("  口コミ:", JSON.stringify(pick(p.reviews, ["create", "update", "unchanged", "startYear", "unmatched", "ignored"])));
  console.log("  過去の集計:", JSON.stringify(pick(p.history, ["create", "update", "unchanged"])));
  if (APPLY) console.log("  取り込みました:", (await call("apply", "workbook", workbook, query)).summary);
}
if (APPLY || args.includes("--check")) {
  const c = await call("check");
  console.log(`\n■ 支給前の照合 (KPI のタブ: ${c.label})`);
  if (c.problems?.length) console.log("  注意:", c.problems.join(" / "));
  for (const y of c.years) {
    console.log(`  ${y.label} (比べた期間 ${y.compared.from}〜${y.compared.to}): 一致 ${y.matched} / シート側の誤り ${y.sheetErrors ?? 0} / 差あり ${y.differ} / シート未集計の行 ${y.pending ?? 0}`);
    for (const r of y.rows.filter((x) => (x.status ?? (x.ok ? "ok" : "differ")) === "differ" || x.status === "sheet")) console.log(`    ${xMark(r)} ${r.label} ${r.target}${r.month ? ` ${r.month}` : ""}: シート ${r.sheet ?? "-"} / システム ${r.system ?? "-"}${r.detail ? ` (${r.detail})` : ""}${r.cause ? ` — ${r.cause}` : ""}`);
  }
}
