#!/usr/bin/env node
/**
 * 売上台帳「新原本」右上の畳材料原価単価表を材料マスタへ取り込む
 *
 *   node scripts/ops/import-tatami-cost-sheet.mjs [--apply] [--from 2025-07-01] [path.xlsx]
 *
 * 指定がなければ source/12_商品・価格/畳材料原価/合志店売上_新原本含む.xlsx
 * --apply がなければ照合だけ (書き込まない)。CSV も同じフォルダーへ書き出す。
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
const fileArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--from");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
process.chdir(root);
loadEnv(root);

const defaultFile = path.join(root, "source", "12_商品・価格", "畳材料原価", "合志店売上_新原本含む.xlsx");
const target = path.resolve(fileArg || defaultFile);
if (!fs.existsSync(target)) {
  console.error(`ファイルがありません: ${target}`);
  process.exit(2);
}

process.env.DB_SNAPSHOT = process.env.DB_SNAPSHOT ?? "off";
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));

const store = await imp("lib/db/store.ts");
const { parseTatamiCostSheet, applyTatamiCostPlan, tatamiCostCsv, DEFAULT_VALID_FROM } = await imp("lib/mgmt/tatami-cost-sheet.ts");
const { SYSTEM_USER } = await imp("lib/notify/inbound.ts");

const validFrom = fromOpt && /^\d{4}-\d{2}-\d{2}$/.test(fromOpt) ? fromOpt : DEFAULT_VALID_FROM;
const buf = fs.readFileSync(target);
const plan = parseTatamiCostSheet({ buf, validFrom });
const outCsv = path.join(path.dirname(target), `新原本_畳材料原価単価表_${validFrom}.csv`);
fs.writeFileSync(outCsv, tatamiCostCsv(plan), "utf8");

const byKind = {};
for (const r of plan.rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
console.log(`[tatami-cost] ${APPLY ? "書き込み" : "照合のみ"} / ${path.basename(target)} / 適用 ${validFrom} / backend ${store.BACKEND}`);
console.log(`品目 ${plan.rows.length} 件:`, byKind);
console.log(`CSV: ${outCsv}`);
if (plan.skipped.length) console.log("スキップ:", plan.skipped.slice(0, 20).join(" / "));

await store.syncDb();
if (!APPLY) {
  console.log("書き込むときは --apply を付けて再実行してください。");
  process.exit(0);
}

const now = new Date().toISOString();
let result;
await store.mutate((db) => {
  result = applyTatamiCostPlan(db, plan, { userId: SYSTEM_USER, now, makeId: store.newId });
  store.addAudit(db, {
    userId: SYSTEM_USER,
    action: "import",
    entity: "material",
    entityId: "tatami_cost_sheet",
    entityLabel: "畳材料原価単価表",
    summary: `新原本の単価表を取込 (ops): 追加 ${result.added}・更新 ${result.updated}・単価 ${result.costs}・変更なし ${result.unchanged} (適用 ${validFrom})`,
  });
});
console.log("結果:", result);
process.exit(0);
