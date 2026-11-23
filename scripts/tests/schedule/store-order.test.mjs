/**
 * 店舗の表示順と「本部」の名前 (お客様のご要望 2026-11-23「全社 → 合志店 → 中央店 → 西店 → 玉名店 → 本部・ショールーム。本社は本部に」)
 *   node scripts/tests/schedule/store-order.test.mjs   (npm run test:schedule)
 */
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
const fails = [];
const eq = (a, b, msg) => {
  const okv = JSON.stringify(a) === JSON.stringify(b);
  if (okv) pass++;
  else fails.push(msg);
  console.log(okv ? "  ✓" : "  ✗", okv ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};

const O = await imp("lib/store-order.ts");
const M = await imp("lib/db/master.ts");
const migrate = await imp("lib/db/migrate.ts");
const areas = await imp("lib/mgmt/areas.ts");
const labels = await imp("lib/field-labels.ts");

// データベースの並び (コードの順 CH・HQ・KS・NS・TM) + 管理者が足した店舗
const byCode = [...M.STORES].sort((a, b) => a.code.localeCompare(b.code));
const added = { ...M.STORES[0], id: "kikuyo", code: "06", name: "菊陽店", shortName: "菊陽", kind: "store" };
eq(byCode.map((s) => s.id), ["chuo", "hq", "koshi", "nishi", "tamana"], "以前の並び (店舗コードの順: 中央・本社・合志・西・玉名)");
eq(O.sortStores([...byCode, added]).map((s) => s.id), ["koshi", "chuo", "nishi", "tamana", "kikuyo", "hq"], "表示順: 合志 → 中央 → 西 → 玉名 → 足した店舗 → 本部");
eq(["hq", "tamana", "chuo", "kikuyo", "koshi", "nishi"].sort(O.compareStoreIds), ["koshi", "chuo", "nishi", "tamana", "kikuyo", "hq"], "店舗 ID だけの並べ替えも同じ順");
const db = migrate.migrateDb({ meta: { version: 99 }, stores: [...byCode], users: [], customers: [] });
eq(db.stores.map((s) => s.id), ["koshi", "chuo", "nishi", "tamana", "hq"], "読み込み (migrateDb) で店舗を表示順に並べる");
const hq = M.STORES.find((s) => s.id === "hq");
eq([hq.name, hq.shortName], ["本部・ショールーム", "本部"], "店舗マスタの本部の名前 (本社 → 本部)");
eq(labels.fieldValue("storeId", "hq"), "本部", "変更履歴の店舗の表示も本部");
const stores = { stores: M.STORES };
eq([areas.storeIdOfName(stores, "本部"), areas.storeIdOfName(stores, "本社")], ["hq", "hq"], "取込の店舗名: 本部・本社 (以前の名前) のどちらも本部");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
