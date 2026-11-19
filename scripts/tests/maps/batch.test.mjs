// 実行: npm run test:maps (または node scripts/tests/maps/batch.test.mjs)
import fs from "node:fs";
import path from "node:path";
import { imp, ok, eq, section, summary } from "./harness.mjs";
import { makePdf } from "./pdfs.mjs";
const store = await imp("lib/db/store.ts");
const B = await imp("lib/maps/batch.ts");
const R = await imp("lib/maps/resolve.ts");
const N = 12000;
const db0 = store.getDb();
const admin = db0.users.find((u) => u.role === "admin");
const now = new Date().toISOString();
const towns = ["合志市須屋", "熊本市東区健軍", "熊本市中央区水前寺", "菊池郡菊陽町原水", "玉名市岩崎", "熊本市北区植木町岩野"];
const zen = (s) => s.replace(/[0-9-]/g, (c) => (c === "-" ? "－" : String.fromCharCode(c.charCodeAt(0) + 0xfee0)));
function address(i) {
  // each block of 20 customers shares one lot, written in different formats (same house → one location)
  const blk = Math.floor(i / 20);
  const t = towns[blk % towns.length];
  const lot = i % 20 >= 10 ? `${100 + (i % 3000)}-${1 + (i % 7)}` : `${100 + (blk % 3000)}-${1 + (blk % 7)}`;
  switch (i % 20) {
    case 0: return "";                                   // empty
    case 1: return t;                                    // area only
    case 2: return `熊本県${t}${lot}`;                     // with prefecture
    case 3: return zen(`${t}${lot}`);                    // full-width
    case 4: return `${t}${lot} コーポ${i % 50}号棟 ${100 + (i % 9)}号室`; // building + room
    case 5: return `〒861-1102 ${t}${lot.replace("-", "番地")}`;          // postal + 番地
    default: return `${t}${lot}`;
  }
}
await store.mutate((db) => {
  for (let i = 0; i < N; i++) db.customers.push({ id: `cust_b${String(i).padStart(5, "0")}`, code: `C-${String(20000 + i)}`, name: `一括 ${i}`, kana: "", type: "individual", phone: "", postalCode: "", address: address(i), storeId: ["koshi", "chuo", "nishi", "tamana"][i % 4], preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
});
let db = store.getDb();
const originalAddresses = new Map(db.customers.map((c) => [c.id, c.address]));
const total = db.customers.length;

section("13. Dry run (no writes)");
const locBefore = db.mapLocations.length;
let job = await B.startBatch(admin, { kind: "normalize", dryRun: true });
db = store.getDb();
ok(job.status === "done" && job.counts.records === total, `dry run classified ${total} records`);
eq(db.mapLocations.length, locBefore, "dry run wrote no locations");
console.log("   dry-run counts:", JSON.stringify(job.counts));
const expectedNew = job.counts.new;

section("13. Real run with interruption + resume");
let t0 = Date.now();
job = await B.startBatch(admin, { kind: "normalize", dryRun: false });
job = await B.stepBatch(admin, job.id);
job = await B.stepBatch(admin, job.id);
const cursorAtCrash = job.cursor;
ok(job.status === "running" && cursorAtCrash === 4000, `progress checkpointed at ${cursorAtCrash}`);
let threw = "";
try { await B.startBatch(admin, { kind: "normalize", dryRun: false }); } catch (e) { threw = e.message; }
ok(/途中/.test(threw), "cannot start a second job while one is running");
// "restart": read state back from the store (as a new request would)
const resumed = B.readBatchState(store.getDb()).current;
ok(resumed.id === job.id && resumed.cursor === cursorAtCrash, "state persisted with the data (resume point)");
let steps = 0;
while (job.status === "running" && steps++ < 100) job = await B.stepBatch(admin, job.id);
const ms = Date.now() - t0;
db = store.getDb();
ok(job.status === "done" && job.cursor === total, `completed ${total} records in ${steps + 2} steps, ${ms} ms`);
console.log("   real-run counts:", JSON.stringify(job.counts));
eq(job.counts.new ?? 0, expectedNew, "new locations created = dry-run prediction");
ok((job.counts.linked ?? 0) > 0, `records sharing a lot matched the location created earlier in the run (${job.counts.linked})`);
eq((job.counts.new ?? 0) + (job.counts.linked ?? 0) + (job.counts.ambiguous ?? 0) + (job.counts.empty ?? 0), total, "every record accounted for");
ok(db.customers.every((c) => originalAddresses.get(c.id) === c.address), "no customer address was modified");
eq(R.mapIndex(db).duplicateKeys.size, 0, "no duplicate location records created");
const blockKey = R.placeOfCustomer(db, db.customers.find((c) => c.id === "cust_b00062")).norm.key;
const sameLot = db.customers.filter((c) => c.id.startsWith("cust_b") && R.placeOfCustomer(db, c).norm.key === blockKey);
console.log("   block", blockKey, sameLot.map((c) => c.address).join(" | "));
ok(sameLot.length >= 5 && new Set(sameLot.map((c) => R.placeOfCustomer(db, c).location?.id)).size === 1, `differently formatted addresses of the same lot share one location (${sameLot.length} records)`);

section("13. Idempotent re-run");
const locCount = db.mapLocations.length;
job = await B.startBatch(admin, { kind: "normalize", dryRun: false });
while (job.status === "running") job = await B.stepBatch(admin, job.id);
db = store.getDb();
ok((job.counts.new ?? 0) === 0 && db.mapLocations.length === locCount, "second run creates nothing new");

section("13. Report");
const csv = B.normalizeReportCsv(db, false);
const lines = csv.trim().split("\n");
eq(lines.length, total + 1, "report has one row per record + header");
ok(lines.some((l) => l.includes("番地なし・要確認")) && lines.some((l) => l.includes("住所なし")) && lines.some((l) => l.includes("登録済みの場所に一致")), "report includes ambiguous / empty / matched statuses");

section("F. PDF batch import (manifest + file names, duplicates, errors, resume)");
const folder = "batch-test";
const dir = path.join(B.importRoot(), folder);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const custs = db.customers.filter((c) => c.id.startsWith("cust_b") && R.placeOfCustomer(db, c).norm.precision === "house").slice(0, 60);
for (const c of custs.slice(0, 50)) fs.writeFileSync(path.join(dir, `${c.code}.pdf`), await makePdf(`map ${c.code}`));
const dupBytes = await makePdf("shared page 12");
fs.writeFileSync(path.join(dir, "page12-a.pdf"), dupBytes);
fs.writeFileSync(path.join(dir, "page12-b.pdf"), dupBytes);
fs.writeFileSync(path.join(dir, "C-99999.pdf"), await makePdf("nobody"));         // unknown code
fs.writeFileSync(path.join(dir, "random-name.pdf"), await makePdf("unmatched"));  // no mapping
fs.writeFileSync(path.join(dir, "broken.pdf"), Buffer.from("%PDF-1.4\nbroken"));   // corrupt
fs.writeFileSync(path.join(dir, "by-address.pdf"), await makePdf("by address"));
fs.writeFileSync(path.join(dir, "area.pdf"), await makePdf("area"));
fs.writeFileSync(path.join(dir, "manifest.csv"), ["file,customer_code,address,shareable,edition", `page12-a.pdf,${custs[50].code},,1,2025年版`, `page12-b.pdf,${custs[51].code},,1,2025年版`, `broken.pdf,${custs[52].code},,,`, `by-address.pdf,,${custs[53].address},,`, `area.pdf,,合志市須屋,,`].join("\n"));
const totalFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")).length;

threw = "";
try { await B.startBatch(admin, { kind: "pdf_import", dryRun: false, folder }); } catch (e) { threw = e.message; }
ok(/利用許諾/.test(threw), "real import requires license confirmation");
const docsBefore = db.mapDocuments.length;
job = await B.startBatch(admin, { kind: "pdf_import", dryRun: true, folder });
while (job.status === "running") job = await B.stepBatch(admin, job.id);
db = store.getDb();
eq(db.mapDocuments.length, docsBefore, "dry-run import wrote no documents");
console.log("   dry-run import:", JSON.stringify(job.counts));
ok(job.counts.would_create >= 51 && job.counts.would_link === 1 && job.counts.unmatched === 3 && job.counts.error === 1, "dry run predicts creates / duplicate / unmatched / error");

job = await B.startBatch(admin, { kind: "pdf_import", dryRun: false, folder, licenseConfirmed: true, licenseRef: "テスト契約" });
job = await B.stepBatch(admin, job.id); // 25 files then "crash"
const mid = job.cursor;
while (job.status === "running") job = await B.stepBatch(admin, job.id);
db = store.getDb();
console.log("   import counts:", JSON.stringify(job.counts));
eq(job.cursor, totalFiles, `all ${totalFiles} files processed (resumed after ${mid})`);
eq(job.counts.created, 52, "52 PDFs created (50 by code + 1 shared page + 1 by address)");
eq(job.counts.linked_existing, 1, "duplicate content linked instead of stored twice");
eq(job.counts.unmatched, 3, "3 unmatched (unknown code, no mapping, address without house number)");
eq(job.counts.error, 1, "1 corrupt PDF reported as error");
const shared = db.mapDocuments.find((d) => d.sourceRef === `${folder}/page12-a.pdf`);
eq((R.mapIndex(db).locationsByDoc.get(shared.id) ?? []).length, 2, "shared page linked to both customers' locations");
ok(R.placeOfCustomer(db, custs[0]).documents[0]?.sourceRef === `${folder}/${custs[0].code}.pdf`, "customer screen shows the imported PDF");
ok(db.mapDocuments.filter((d) => d.source === "bulk_import").every((d) => d.licenseConfirmedBy === admin.id && d.copyrightNotice.includes("ZENRIN")), "license + copyright metadata on every imported doc");

const again = await B.startBatch(admin, { kind: "pdf_import", dryRun: false, folder, licenseConfirmed: true });
let j2 = again; while (j2.status === "running") j2 = await B.stepBatch(admin, j2.id);
ok((j2.counts.created ?? 0) === 0 && (j2.counts.linked_existing ?? 0) === 0 && j2.counts.already_imported === 52 && j2.counts.duplicate_skipped === 1, `re-running the same folder changes nothing (${j2.counts.already_imported} already imported, ${j2.counts.duplicate_skipped} duplicate)`);
const rep = await B.importReportCsv(store.getDb(), job);
ok(rep.split("\n").length >= totalFiles + 1 && rep.includes("登録先なし") && rep.includes("エラー") && rep.includes("共用"), "per-file import report with all categories");
summary();
