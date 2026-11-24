// 実行: npm run test:maps (または node scripts/tests/maps/viewer.test.mjs)
// お客様のご要望 2026-11-24: ① 住宅地図をシステムの画面の中で開き、元の画面に戻れる / ② 既存のお客様の住宅地図のまとめての登録 (画像の一括取込・未登録の一覧)
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { imp, ok, eq, section, summary, root } from "./harness.mjs";
import { makePdf } from "./pdfs.mjs";
const store = await imp("lib/db/store.ts");
const L = await imp("lib/maps/links.ts");
const RN = await imp("lib/maps/render.ts");
const B = await imp("lib/maps/batch.ts");
const R = await imp("lib/maps/resolve.ts");
const M = await imp("lib/maps/missing.ts");
const storage = await imp("lib/storage.ts");

section("① 地図の画面へのリンク・予定表の小さな画面に戻る印");
eq(L.mapViewHref("mdoc_1", "/orders/o_1#map"), "/maps/documents/mdoc_1?returnTo=%2Forders%2Fo_1%23map", "viewer link keeps the record screen (and #map) as returnTo");
eq(L.reopenHref("/schedule?view=week&date=2026-11-25&_r=ab12&msg=x", "ev_9"), "/schedule?view=week&date=2026-11-25&qe=ev_9", "schedule return URL drops msg/_r and adds qe=<event>");
eq(L.reopenHref("/schedule?qe=ev_1#top", "ev_2"), "/schedule?qe=ev_2", "an old qe is replaced, hash dropped");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
for (const f of ["src/components/maps/MapInfoCard.tsx", "src/components/schedule/EventQuick.tsx", "src/app/(app)/maps/locations/[id]/page.tsx"]) {
  const s = read(f);
  ok(!/href=\{`\/api\/maps\/documents\/\$\{d(?:oc)?\.id\}`\}/.test(s) && !/href=\{src\}/.test(s), `${f}: no direct link to the raw PDF (opens inside the system instead)`);
}
ok(/mapViewHref\(d\.id, reopenHref\(returnTo, eventId\)\)/.test(read("src/components/schedule/EventQuick.tsx")), "schedule popup opens the viewer and returns to the same popup");
ok(/params\.get\("qe"\)/.test(read("src/components/schedule/EventQuick.tsx")), "EventQuickHost reopens the popup from ?qe=");
ok(/hide-in-app/.test(read("src/app/(app)/maps/documents/[id]/page.tsx")) && /display-mode: standalone/.test(read("src/app/globals.css")), "raw-PDF link is hidden in the home-screen app (no back button there)");

section("① PDF のページを画像に (pdftoppm)");
const avail = await RN.rendererAvailable();
ok(avail, "pdftoppm is available on this server");
eq(RN.pageNumber("1", { pageCount: 2 }), 1, "page 1 ok");
eq(RN.pageNumber("2", { pageCount: 2 }), 2, "page 2 ok");
eq(RN.pageNumber("3", { pageCount: 2 }), null, "page beyond the PDF rejected");
eq(RN.pageNumber("0", { pageCount: 2 }), null, "page 0 rejected");
eq(RN.pageNumber("1.5", { pageCount: 2 }), null, "non-integer rejected");
eq(RN.pageNumber(null, {}), 1, "default page 1");
eq(RN.pageNumber("21", { pageCount: 50 }), null, `pages capped at ${RN.MAX_RENDER_PAGES}`);
const pdf2 = await makePdf("viewer test", 2);
await storage.putObject("maps/2026-11/mdoc_viewtest.pdf", pdf2);
const doc = { id: "mdoc_viewtest", sha256: "abcdef0123456789abcdef", pageCount: 2, storageKey: "maps/2026-11/mdoc_viewtest.pdf" };
if (avail) {
  const t0 = Date.now();
  const p1 = await RN.renderMapPage(doc, 1, "view");
  ok(p1 && p1[0] === 0x89 && p1[1] === 0x50, `page 1 rendered as PNG (${p1?.length} bytes, ${Date.now() - t0} ms)`);
  const w = p1.readUInt32BE(16), h = p1.readUInt32BE(20);
  eq(w, RN.RENDER_WIDTH.view, "view width");
  ok(Math.abs(h - Math.round((w * 200) / 300)) <= 2, "aspect ratio kept");
  const pv = await RN.renderMapPage(doc, 1, "preview");
  eq(pv.readUInt32BE(16), RN.RENDER_WIDTH.preview, "preview width");
  const p2 = await RN.renderMapPage(doc, 2, "view");
  ok(p2 && !p2.equals(p1), "page 2 is a different image");
  const cdir = path.join(RN.renderCacheDir(), "mdoc_viewtest");
  ok(fs.readdirSync(cdir).length === 3, "rendered pages cached on disk");
  ok(!RN.renderCacheDir().startsWith(storage.storageDir() + path.sep), "cache is outside the uploads folder (not backed up)");
  await storage.removeObjects([doc.storageKey]);
  const again = await RN.renderMapPage(doc, 1, "view");
  ok(again && again.equals(p1), "second request served from the cache");
  await RN.purgeMapRender("mdoc_viewtest");
  ok(!fs.existsSync(cdir), "purge removes the cached images (map withdrawn)");
  eq(await RN.renderMapPage(doc, 1, "view"), null, "no file and no cache → null");
  eq(await RN.renderMapPage({ ...doc, storageKey: undefined }, 1, "view"), null, "removed map (no storageKey) → null");
  await storage.putObject("maps/2026-11/mdoc_broken.pdf", Buffer.from("%PDF-1.4\nbroken"));
  let threw = "";
  try { await RN.renderMapPage({ id: "mdoc_broken", sha256: "b", pageCount: 1, storageKey: "maps/2026-11/mdoc_broken.pdf" }, 1, "view"); } catch (e) { threw = e.message; }
  ok(/pdftoppm/.test(threw), "a broken PDF throws (the route answers 503, the screen falls back to the PDF)");
}

section("② 画像 (PNG・JPEG) の一括取込");
const now = new Date().toISOString();
const admin = store.getDb().users.find((u) => u.role === "admin");
await store.mutate((db) => {
  const mk = (id, code, address, storeId = "koshi", extra = {}) => db.customers.push({ id, code, name: `地図 ${code}`, kana: "", type: "individual", phone: "", postalCode: "", address, storeId, preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now, ...extra });
  mk("cust_v1", "C-30001", "合志市須屋701-1");
  mk("cust_v2", "C-30002", "合志市須屋702-2");
  mk("cust_v3", "C-30003", "熊本市東区健軍3-12-3");
  mk("cust_v4", "C-30004", "熊本県熊本市東区健軍３丁目12番3号"); // same house as v3
  mk("cust_v5", "C-30005", "合志市須屋"); // no house number
  mk("cust_v6", "C-30006", "熊本市中央区水前寺1-2-3");
  mk("cust_v7", "C-30007", "玉名市岩崎99-1", "tamana", { tradeStopped: true });
  mk("cust_v8", "C-30008", "合志市須屋708-8");
});
const folder = "viewer-images";
const dir = path.join(B.importRoot(), folder);
fs.mkdirSync(dir, { recursive: true });
// 小さな PNG・JPEG (sharp で作る)
const sharp = (await import("sharp")).default;
const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 220, b: 240 } } }).png().toBuffer();
const jpg = await sharp({ create: { width: 90, height: 140, channels: 3, background: { r: 240, g: 220, b: 200 } } }).jpeg().toBuffer();
fs.writeFileSync(path.join(dir, "C-30001 須屋の地図.png"), png);
fs.writeFileSync(path.join(dir, "C-30002.jpg"), jpg);
fs.writeFileSync(path.join(dir, "C-30006.pdf"), await makePdf("pdf still works"));
fs.writeFileSync(path.join(dir, "C-30008.png"), Buffer.from("not really a png"));
const folders = await B.listImportFolders();
eq(folders.find((f) => f.name === folder)?.pdfs, 4, "folder list counts PDFs and images");
let job = await B.startBatch(admin, { kind: "pdf_import", dryRun: true, folder });
while (job.status === "running") job = await B.stepBatch(admin, job.id);
ok(job.counts.would_create === 3 && job.counts.error === 1, `dry run: 2 images + 1 PDF importable, fake PNG is an error (${JSON.stringify(job.counts)})`);
job = await B.startBatch(admin, { kind: "pdf_import", dryRun: false, folder, licenseConfirmed: true });
while (job.status === "running") job = await B.stepBatch(admin, job.id);
eq(job.counts.created, 3, "3 maps registered");
let db = store.getDb();
const d1 = db.mapDocuments.find((d) => d.sourceRef === `${folder}/C-30001 須屋の地図.png`);
ok(d1 && d1.contentType === "application/pdf" && d1.fileName === "C-30001 須屋の地図.pdf" && d1.title === "C-30001 須屋の地図" && d1.pageCount === 1, "image stored as a 1-page PDF (file name .pdf, title without extension)");
const stored = await storage.readObject(d1.storageKey);
const parsed = await PDFDocument.load(stored);
eq(parsed.getPageCount(), 1, "stored PDF opens");
ok(R.placeOfCustomer(db, db.customers.find((c) => c.id === "cust_v2")).documents.length === 1, "JPEG map shows on the customer screen");
const rep = await B.importReportCsv(db, job);
ok(rep.includes("画像 → PDF") && /PNG・JPEG の画像ではありません/.test(rep), "report marks converted images and the fake PNG");

section("② 住宅地図が未登録の一覧 (ゼンリン GIS で出力する順番)");
const today = "2026-11-25";
await store.mutate((db) => {
  db.schedule.push({ id: "ev_vtest", title: "見積り 地図 C-30006", kind: "survey", date: "2026-11-27", customerId: "cust_v8", storeId: "koshi", assigneeIds: [], createdBy: admin.id, createdAt: now, updatedAt: now });
  db.schedule.push({ id: "ev_vpast", title: "過去の予定", kind: "survey", date: "2026-10-01", customerId: "cust_v3", storeId: "chuo", assigneeIds: [], createdBy: admin.id, createdAt: now, updatedAt: now });
});
db = store.getDb();
const rows = M.missingMapRows(db, today, { scope: "all" });
const byCode = new Map(rows.filter((r) => r.kind === "customer").map((r) => [r.customerCode, r]));
ok(!byCode.has("C-30001") && !byCode.has("C-30002") && !byCode.has("C-30006"), "customers with a map are not listed");
ok(!byCode.has("C-30005"), "address without a house number is not listed (the map's place can't be decided)");
ok(!byCode.has("C-30007"), "customers with 取引停止 are not listed");
eq(byCode.get("C-30008")?.priority, 1, "upcoming schedule → priority 1");
eq(byCode.get("C-30008")?.nextDate, "2026-11-27", "next schedule date shown");
eq(byCode.get("C-30008")?.fileName, "C-30008.pdf", "file name for the bulk import = customer code");
ok(byCode.has("C-30003") !== byCode.has("C-30004"), "same house (two customers) is listed once");
eq((byCode.get("C-30003") ?? byCode.get("C-30004"))?.priority, 3, "past schedule only → priority 3");
const firstIdx = rows.findIndex((r) => r.customerCode === "C-30008");
ok(rows.slice(0, firstIdx).every((r) => r.priority === 1), "priority 1 rows come first");
const pri = M.missingMapRows(db, today, { scope: "priority" });
ok(pri.every((r) => r.priority < 3) && pri.some((r) => r.customerCode === "C-30008"), "scope=priority keeps only rows with a schedule or an open case");
const csv = M.missingMapCsv(db, rows);
ok(csv.split("\n")[0].includes("登録用のファイル名") && csv.includes("C-30008.pdf") && csv.includes("1 今後の予定あり"), "CSV has the file-name column and priority labels");
summary();
