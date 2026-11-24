/**
 * 新原本の畳材料原価単価表の取込 (適用開始日つき・過去の原価は変えない)
 * 実行: node scripts/tests/mgmt/tatami-cost-sheet.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { eq, ok, section, summary, root, imp } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const C = await imp("lib/mgmt/costing.ts");
const T = await imp("lib/mgmt/tatami-cost-sheet.ts");

const xlsxPath = path.join(root, "source", "12_商品・価格", "畳材料原価", "合志店売上_新原本含む.xlsx");
const hasXlsx = fs.existsSync(xlsxPath);
let seq = 0;
const mid = (p) => `${p}_tcs${++seq}`;

section("単価表の解析 (行列から)");
{
  const rows = Array.from({ length: 20 }, () => Array(60).fill(""));
  rows[9][21] = "コン10.50";
  rows[9][22] = "168";
  rows[9][30] = "格安";
  rows[9][31] = "1300";
  rows[9][33] = "雅（柄表）";
  rows[9][34] = "7000";
  rows[9][36] = "100A 五八（引目カラーも）";
  rows[9][37] = "3250";
  rows[9][42] = "3型47　五八";
  rows[9][43] = "3780";
  rows[9][51] = "AB下ぺフ22　五八";
  rows[9][52] = "2840";
  rows[12][30] = "きずな";
  rows[12][31] = "3500";
  rows[17][33] = "マイトスタット";
  rows[17][34] = "300";
  const plan = T.parseTatamiCostSheet({ rows, validFrom: "2025-07-01" });
  eq(plan.rows.length, 8, "8 品目を読む");
  const find = (re) => plan.rows.find((r) => re.test(r.name));
  eq(find(/^コン10\.50/)?.kind, "heri", "縁");
  eq(find(/^格安$/)?.kind, "omote", "畳表 (い草)");
  eq(find(/^格安$/)?.costKind, "provisional", "畳表は仮原価");
  eq(find(/100A.*五八/)?.kind, "chem_omote", "化学畳表");
  eq(find(/^3型47/)?.kind, "doko", "畳床 3型");
  eq(find(/^3型47/)?.thickness, 47, "厚み 47");
  eq(find(/^3型47/)?.size, "gohachi", "五八");
  eq(find(/AB下ぺフ22/)?.spec, "オールボード", "AB = オールボード");
  eq(find(/^マイトスタット/)?.kind, "sub", "マイトスタットは副資材");
  eq(find(/^きずな$/)?.unitCost, 3500, "きずな 3,500");
}

section("取込: 単価変更しても過去の使用実績は変わらない");
{
  const admin = "u_admin";
  const now = "2030-06-01T00:00:00.000Z";
  const plan = T.parseTatamiCostSheet({
    rows: (() => {
      const rows = Array.from({ length: 20 }, () => Array(60).fill(""));
      rows[12][30] = "テストきずな原価";
      rows[12][31] = "3500";
      return rows;
    })(),
    validFrom: "2030-06-01",
  });
  await store.mutate((d) => {
    T.applyTatamiCostPlan(d, plan, { userId: admin, now, makeId: mid });
  });
  const d0 = store.getDb();
  const m = d0.materials.find((x) => x.name === "テストきずな原価");
  ok(!!m, "材料マスタにある");
  eq(C.costAt(d0, m.id, "2030-06-15").unitCost, 3500, "取込直後の単価 3,500");
  const costRow = C.costAt(d0, m.id, "2030-06-10");

  await store.mutate((d) => {
    const mat = d.materials.find((x) => x.name === "テストきずな原価");
    d.materialUsages.push({
      id: mid("mu"),
      orderId: "o_tcs_dummy",
      storeId: "koshi",
      materialId: mat.id,
      materialKind: "omote",
      itemCategory: "tatami",
      qty: 6,
      unitCost: 3500,
      costId: costRow.id,
      amount: 21000,
      stage: "actual",
      source: "bom",
      date: "2030-06-10",
      status: "active",
      createdBy: admin,
      createdAt: now,
    });
  });
  const usageId = store.getDb().materialUsages.find((u) => u.orderId === "o_tcs_dummy").id;
  const before = store.getDb().materialUsages.find((u) => u.id === usageId).amount;

  const plan2 = T.parseTatamiCostSheet({
    rows: (() => {
      const rows = Array.from({ length: 20 }, () => Array(60).fill(""));
      rows[12][30] = "テストきずな原価";
      rows[12][31] = "4000";
      return rows;
    })(),
    validFrom: "2030-07-01",
  });
  await store.mutate((d) => {
    T.applyTatamiCostPlan(d, plan2, { userId: admin, now: "2030-07-01T00:00:00.000Z", makeId: mid });
  });
  const d1 = store.getDb();
  eq(d1.materialUsages.find((u) => u.id === usageId).amount, before, "確定した使用の金額は変わらない");
  eq(C.costAt(d1, m.id, "2030-06-15").unitCost, 3500, "変更前の日付は旧単価");
  eq(C.costAt(d1, m.id, "2030-07-15").unitCost, 4000, "変更後の日付は新単価");
  ok(d1.materialCosts.filter((c) => c.materialId === m.id).length >= 2, "単価の履歴が残る");
}

if (hasXlsx) {
  section("実ファイル「新原本」の単価表");
  const plan = T.parseTatamiCostSheet({ buf: fs.readFileSync(xlsxPath) });
  ok(plan.rows.length >= 80, `品目が十分ある (${plan.rows.length})`);
  ok(plan.rows.some((r) => r.name.includes("きずな") && r.unitCost === 3500), "きずな 3,500");
  ok(plan.rows.some((r) => r.kind === "heri"), "縁がある");
  ok(plan.rows.some((r) => r.kind === "doko" && r.thickness), "畳床に厚み");
  const csv = T.tatamiCostCsv(plan);
  ok(csv.split("\n").length > plan.rows.length, "CSV を書き出せる");
} else {
  section("実ファイル (スキップ: source に xlsx なし)");
  ok(true, "CI などでは実ファイルがなくても単体テストは通る");
}

summary();
