// 実行: npm run test:maps (または node scripts/tests/maps/logic.test.mjs)
import fs from "node:fs";
import { imp, ok, eq, section, summary } from "./harness.mjs";
import { makePdf, makeJsPdf } from "./pdfs.mjs";
const store = await imp("lib/db/store.ts");
const R = await imp("lib/maps/resolve.ts");
const S = await imp("lib/maps/store.ts");
const D = await imp("lib/maps/documents.ts");
const P = await imp("lib/maps/pdf.ts");
const AC = await imp("lib/maps/access.ts");
const PR = await imp("lib/maps/providers.ts");
const perms = await imp("lib/auth/permissions.ts");
const { toDateKey, addDays } = await imp("lib/format.ts");

const db0 = store.getDb();
const admin = db0.users.find((u) => u.role === "admin");
const koshiStaff = db0.users.find((u) => u.role === "store_staff" && u.storeId === "koshi" && u.active);
const chuoStaff = db0.users.find((u) => u.role === "store_staff" && u.storeId === "chuo" && u.active);
const today = toDateKey(new Date());
const future = addDays(today, 5);
const past = addDays(today, -40);
const now = new Date().toISOString();
const files = () => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = d + "/" + e.name; if (e.isDirectory()) walk(p); else out.push(p); } }; walk(process.env.FILE_STORAGE_DIR + "/maps"); return out.filter((f) => f.endsWith(".pdf")); };

// ---- test records (koshi store) ----
const C1 = { id: "cust_t1", code: "C-90001", name: "地図 太郎", kana: "チズ タロウ", type: "individual", phone: "096-000-0001", postalCode: "8611102", address: "熊本県合志市須屋1234-5", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now };
const C2 = { ...C1, id: "cust_t2", code: "C-90002", name: "地図 花子", address: "熊本市東区健軍3丁目12-3", storeId: "koshi" };
const mkOrder = (id, number, customerId, site, status = "confirmed", storeId = "koshi") => ({ id, number, customerId, storeId, title: "畳表替え", category: "tatami", contractDate: today, total: 50000, status, workerIds: [koshiStaff.id], siteAddress: site, progressNotes: [], createdBy: admin.id, createdAt: now, updatedAt: now });
const mkEvent = (id, extra) => ({ id, title: "テスト予定", kind: "visit", date: future, storeId: "koshi", assigneeIds: [koshiStaff.id], source: "manual", createdBy: admin.id, createdAt: now, ...extra });
await store.mutate((db) => {
  db.customers.push(C1, C2);
  db.orders.push(mkOrder("ord_same", "O-2099-0001", C1.id, C1.address));                     // 3: same address as customer
  db.orders.push(mkOrder("ord_diff", "O-2099-0002", C1.id, "熊本県菊池郡菊陽町原水2000-1"));   // 5: different site
  db.orders.push(mkOrder("ord_diff2", "O-2099-0003", C1.id, "熊本市北区植木町岩野300"));      // 7: different site, no PDF
  db.orders.push(mkOrder("ord_shareA", "O-2099-0004", C2.id, "熊本市中央区水前寺1-2-3 サンハイツ")); // 10
  db.orders.push(mkOrder("ord_shareB", "O-2099-0005", C1.id, "熊本市中央区水前寺１丁目２番３号"));   // 10 (same place, different text)
  db.orders.push(mkOrder("ord_area", "O-2099-0006", C1.id, "須屋"));                         // abbreviated site
  db.orders.push(mkOrder("ord_done", "O-2099-0007", C1.id, C1.address, "paid"));             // completed order keeps history
  db.schedule.push(mkEvent("ev_case", { orderId: "ord_same", customerId: C1.id, location: C1.address }));          // 4
  db.schedule.push(mkEvent("ev_diff", { orderId: "ord_diff", customerId: C1.id, location: "熊本県菊池郡菊陽町原水2000-1" })); // 5
  db.schedule.push(mkEvent("ev_cust", { customerId: C1.id, location: C1.address }));                               // follows customer (legacy, same text)
  db.schedule.push(mkEvent("ev_override", { customerId: C1.id, location: "熊本市中央区新屋敷1-1-1 実家" }));          // 9 explicit override
  db.schedule.push(mkEvent("ev_past", { customerId: C1.id, location: C1.address, date: past }));                    // past event keeps text
  db.schedule.push(mkEvent("ev_none", { location: undefined, storeId: "koshi" }));                                  // nothing linked
  db.schedule.push(mkEvent("ev_abbrev", { customerId: C1.id, location: "須屋" }));                                  // legacy area abbreviation
  db.schedule.push(mkEvent("ev_chuo", { storeId: "chuo", assigneeIds: [chuoStaff.id], customerId: C1.id, location: C1.address })); // other-store assignee
});
let db = store.getDb();

section("1. New customer with address → Google Maps link");
let pc = R.placeOfCustomer(db, db.customers.find((c) => c.id === C1.id));
ok(pc.searchUrl?.startsWith("https://www.google.com/maps/search/?api=1&query=") && pc.searchUrl.includes(encodeURIComponent("熊本県合志市須屋1234-5")), "customer place has api=1 search URL with encoded address");
ok(pc.directionsUrl?.includes("/maps/dir/?api=1&destination="), "directions link present");
eq(pc.documents.length, 0, "no PDF yet");
ok(pc.warnings.some((w) => w.includes("未確認")), "warns that address-text positioning is unverified");

section("E. PDF validation");
const good = await makePdf("customer map", 2);
let r = await P.inspectPdf(good); ok(r.ok && r.pages === 2, "valid 2-page PDF accepted");
r = await P.inspectPdf(good.subarray(0, good.length - 200)); ok(!r.ok && /終わり/.test(r.error), "truncated PDF rejected");
r = await P.inspectPdf(Buffer.from("hello world, not a pdf %%EOF")); ok(!r.ok && /PDF ではありません/.test(r.error), "non-PDF rejected");
r = await P.inspectPdf(await makeJsPdf()); ok(!r.ok && /JavaScript|JS/.test(r.error), "PDF with JavaScript action rejected (object streams)");
r = await P.inspectPdf(good, 100); ok(!r.ok && /MB/.test(r.error), "oversize rejected");
r = await P.inspectPdf(Buffer.alloc(0)); ok(!r.ok, "empty rejected");
let threw = "";
try { await D.registerMapDocument({ user: admin, target: { type: "customer", id: C1.id }, file: { name: "a.pdf", bytes: good }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: false }, source: "upload" }); } catch (e) { threw = e.message; }
ok(/利用許諾/.test(threw), "upload without license confirmation rejected");
threw = "";
try { await D.registerMapDocument({ user: admin, target: { type: "customer", id: C1.id }, file: { name: "a.txt", bytes: good }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" }); } catch (e) { threw = e.message; }
ok(/登録できない種類/.test(threw), "non-PDF, non-image file rejected");
eq(files().length, 0, "nothing stored after rejected uploads");

section("2. Upload authorized PDF to customer");
const r2 = await D.registerMapDocument({ user: koshiStaff, target: { type: "customer", id: C1.id }, file: { name: "合志市須屋.pdf", bytes: good }, meta: { provider: "zenrin", kind: "residential", edition: "2025年版", licenseRef: "契約 A-1", licenseConfirmed: true }, source: "upload" });
db = store.getDb();
pc = R.placeOf(db, "customer", C1.id);
eq(r2.status, "created", "created");
ok(pc.documents.length === 1 && pc.documents[0].id === r2.document.id, "customer place shows the PDF");
ok(pc.location && pc.location.addressKey === "熊本県合志市須屋1234-5", "location record created with normalized key");
eq(r2.document.copyrightNotice, "© ZENRIN CO., LTD.", "default ZENRIN copyright notice kept");
ok(r2.document.licenseConfirmedBy === koshiStaff.id && r2.document.sha256.length === 64 && r2.document.pageCount === 2, "license confirmer, sha256, page count stored");
ok(!r2.document.storageKey.startsWith("/") && fs.existsSync(process.env.FILE_STORAGE_DIR + "/" + r2.document.storageKey), "file in private storage dir (not public/)");
ok(db.customers.find((c) => c.id === C1.id).address === "熊本県合志市須屋1234-5", "original customer address untouched");
ok(db.auditLogs.some((l) => l.entity === "map_location" && l.summary.includes("住宅地図を登録")), "upload audit-logged");

section("3. Project at the same address → same map info");
let po = R.placeOf(db, "order", "ord_same");
ok(po.sameAsCustomer === true && po.location?.id === pc.location.id, "order site resolves to the customer's location");
ok(po.documents[0]?.id === r2.document.id, "order shows the same PDF");
eq(po.searchUrl, pc.searchUrl, "same Google link");

section("4. Schedule event linked to project");
let pe = R.placeOf(db, "event", "ev_case");
eq(pe.searchUrl, pc.searchUrl, "event shows same Google link");
ok(pe.documents[0]?.id === r2.document.id, "event shows same PDF");
eq(R.eventLocationMode(db, db.schedule.find((e) => e.id === "ev_case")), "follow", "legacy event with same text → follow");

section("5. Site differs from customer address");
po = R.placeOf(db, "order", "ord_diff");
ok(po.addressText === "熊本県菊池郡菊陽町原水2000-1" && po.sameAsCustomer === false, "order shows construction-site address");
ok(po.searchUrl.includes(encodeURIComponent("熊本県菊池郡菊陽町原水2000-1")), "Google link for the site");
pe = R.placeOf(db, "event", "ev_diff");
eq(pe.addressText, "熊本県菊池郡菊陽町原水2000-1", "event shows construction-site location");
ok(pe.documents.length === 0 && !pe.documents.some((d) => d.id === r2.document.id), "event does not show customer PDF");

section("7. Project PDF missing → missing status, never customer PDF");
po = R.placeOf(db, "order", "ord_diff2");
eq(po.documents.length, 0, "no documents for the different site");
ok(/表示していません/.test(po.missingNote ?? ""), "explicit note that the customer's map is not shown");

section("6. Project-specific PDF takes precedence");
const sitePdf = await makePdf("site map kikuyo");
const r6 = await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_diff" }, file: { name: "菊陽町原水.pdf", bytes: sitePdf }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" });
db = store.getDb();
po = R.placeOf(db, "order", "ord_diff");
ok(po.documents[0]?.id === r6.document.id && po.documents.length === 1, "order shows its own site PDF");
pe = R.placeOf(db, "event", "ev_diff");
ok(pe.documents[0]?.id === r6.document.id, "event linked to that order shows the site PDF");
ok(R.placeOf(db, "customer", C1.id).documents[0].id === r2.document.id, "customer still shows customer PDF");

section("10. Two projects share the same physical site (no file duplication)");
const shareBefore = files().length;
const shPdf = await makePdf("suizenji block");
const r10 = await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_shareA" }, file: { name: "水前寺.pdf", bytes: shPdf }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" });
db = store.getDb();
const pA = R.placeOf(db, "order", "ord_shareA"), pB = R.placeOf(db, "order", "ord_shareB");
ok(pA.location && pA.location.id === pB.location?.id, "different text forms resolve to one location record");
ok(pB.documents[0]?.id === r10.document.id, "second project sees the PDF without uploading");
eq(files().length - shareBefore, 1, "exactly one file stored");
ok(pA.addressText !== pB.addressText, "each project keeps its own original text");

section("14. Duplicate PDF handling");
threw = "";
try { await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_diff2" }, file: { name: "copy.pdf", bytes: shPdf }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" }); } catch (e) { threw = e.message; }
ok(/共用しない/.test(threw), "same bytes to another place rejected while not shareable");
threw = "";
try { await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_shareB" }, file: { name: "again.pdf", bytes: shPdf }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" }); } catch (e) { threw = e.message; }
ok(/登録済み/.test(threw), "same bytes to the same place rejected");
await store.mutate((d) => { d.mapDocuments.find((x) => x.id === r10.document.id).shareable = true; R.touchMapIndex(); });
const before14 = files().length;
const r14 = await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_diff2" }, file: { name: "copy.pdf", bytes: shPdf }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" });
db = store.getDb();
ok(r14.status === "linked_existing" && r14.document.id === r10.document.id, "shareable duplicate → linked to existing document");
eq(files().length, before14, "no new file for duplicate");
eq((R.mapIndex(db).locationsByDoc.get(r10.document.id) ?? []).length, 2, "document now linked to 2 locations");

section("11. Replace / delete keeps other references valid + audit");
const repl = await makePdf("suizenji block v2");
const r11 = await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_shareA" }, file: { name: "水前寺_2026.pdf", bytes: repl }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, replaceId: r10.document.id, source: "upload" });
db = store.getDb();
const old = db.mapDocuments.find((d) => d.id === r10.document.id);
ok(r11.status === "replaced" && old.status === "replaced" && old.replacedById === r11.document.id, "old version marked replaced with pointer");
ok(R.placeOf(db, "order", "ord_diff2").documents[0]?.id === r11.document.id, "other location (shared) now shows the new version");
ok(R.placeOf(db, "order", "ord_shareB").documents[0]?.id === r11.document.id, "other project at same site shows the new version");
ok(fs.existsSync(process.env.FILE_STORAGE_DIR + "/" + old.storageKey), "previous version file kept for audit");
ok(db.auditLogs.some((l) => l.summary.includes("差し替え")), "replacement audit-logged");
ok(AC.canViewMapDocument(admin, db, old), "old version still viewable by admin (history)");

section("12. Access control");
ok(AC.canViewRecordMap(koshiStaff, db, "customer", C1.id), "own-store staff can view customer map");
ok(!AC.canViewRecordMap(chuoStaff, db, "customer", C1.id), "other-store staff cannot view customer map");
ok(!AC.canViewRecordMap(chuoStaff, db, "order", "ord_same"), "other-store staff cannot view order map");
const nishiStaff = db.users.find((u) => u.role === "store_staff" && u.storeId === "nishi" && u.active);
ok(!AC.canViewMapDocument(nishiStaff, db, db.mapDocuments.find((d) => d.id === r2.document.id)), "other-store staff (no assignment) cannot open customer PDF by id");
ok(AC.canViewRecordMap(chuoStaff, db, "event", "ev_chuo"), "assigned staff of another store can view the event map");
ok(AC.canViewMapDocument(chuoStaff, db, db.mapDocuments.find((d) => d.id === r2.document.id)), "…and open that PDF while assigned to an upcoming event there");
const unassigned = db.users.find((u) => u.role === "store_staff" && u.storeId === "nishi" && u.active);
ok(!AC.canViewRecordMap(unassigned, db, "event", "ev_case"), "unassigned staff of another store cannot view event map");
ok(AC.canViewMapDocument(admin, db, r6.document), "admin can view all");
ok(perms.canRemoveMapDocument(koshiStaff, r6.document), "uploader can remove");
ok(!perms.canRemoveMapDocument(chuoStaff, r6.document), "other-store staff cannot remove");
ok(!perms.canManageMaps(koshiStaff) && perms.canManageMaps(admin), "batch tools only for HQ/admin");

// access through an assignment expires when the appointment is in the past
await store.mutate((d) => { d.schedule.find((e) => e.id === "ev_chuo").date = past; });
db = store.getDb();
ok(!AC.canViewMapDocument(chuoStaff, db, db.mapDocuments.find((d) => d.id === r2.document.id)), "assignment-based access ends after the appointment date");
await store.mutate((d) => { d.schedule.find((e) => e.id === "ev_chuo").date = future; });
db = store.getDb();

section("8. Linked location updated → all non-overridden views reflect it");
await store.mutate((d) => { const l = d.mapLocations.find((x) => x.id === pc.location.id); Object.assign(l, { lat: 32.8899, lng: 130.7461, coordStatus: "verified", coordSource: "manual" }); R.touchMapIndex(); });
db = store.getDb();
for (const [t, id] of [["customer", C1.id], ["order", "ord_same"], ["event", "ev_case"], ["event", "ev_cust"]]) ok(R.placeOf(db, t, id).searchUrl.includes("32.8899%2C130.7461"), `${t} ${id} uses corrected coordinates`);
ok(!R.placeOf(db, "event", "ev_override").searchUrl.includes("32.8899"), "override event not affected");
// customer moves: address change propagation
const NEW = "熊本県合志市幾久富1909-2";
let prop;
await store.mutate((d) => { const c = d.customers.find((x) => x.id === C1.id); const before = c.address; c.address = NEW; prop = S.propagateCustomerAddress(d, admin, c, before); });
db = store.getDb();
eq(db.orders.find((o) => o.id === "ord_same").siteAddress, NEW, "active order whose site = old address follows the move");
eq(db.orders.find((o) => o.id === "ord_done").siteAddress, "熊本県合志市須屋1234-5", "completed order keeps historical site");
eq(db.orders.find((o) => o.id === "ord_diff").siteAddress, "熊本県菊池郡菊陽町原水2000-1", "order with a different site unchanged");
eq(db.schedule.find((e) => e.id === "ev_cust").location, NEW, "future event following customer updated");
eq(db.schedule.find((e) => e.id === "ev_case").location, NEW, "future event following the order updated");
eq(db.schedule.find((e) => e.id === "ev_past").location, "熊本県合志市須屋1234-5", "past event keeps historical text");
ok(prop.orders === 1 && prop.events >= 2, `propagation counts (orders ${prop.orders}, events ${prop.events})`);
ok(R.placeOf(db, "customer", C1.id).documents.length === 0, "customer at new address: PDF of the old house not shown");
ok(db.auditLogs.some((l) => l.entity === "order" && l.summary.includes("お客様の住所の変更")), "propagation audit-logged");

section("9. Explicit appointment override survives customer address change");
eq(db.schedule.find((e) => e.id === "ev_override").location, "熊本市中央区新屋敷1-1-1 実家", "legacy override text untouched");
await store.mutate((d) => { S.saveEventLocationMode(d, admin, d.schedule.find((e) => e.id === "ev_cust"), "custom"); });
await store.mutate((d) => { const c = d.customers.find((x) => x.id === C1.id); const b = c.address; c.address = "熊本県合志市竹迫2000"; S.propagateCustomerAddress(d, admin, c, b); });
db = store.getDb();
eq(db.schedule.find((e) => e.id === "ev_cust").location, NEW, "event saved as custom keeps its location on the next move");
eq(R.eventLocationMode(db, db.schedule.find((e) => e.id === "ev_cust")), "custom", "mode stored as custom");
pe = R.placeOf(db, "event", "ev_override");
ok(pe.role === "event" && pe.suggestions.some((s) => s.kind === "follow_case") && pe.warnings.some((w) => w.includes("違う場所")), "override shown with explicit warning + follow suggestion");

section("Unrelated addresses never chosen silently");
pe = R.placeOf(db, "event", "ev_none");
ok(!pe.searchUrl && pe.documents.length === 0 && pe.warnings.some((w) => w.includes("場所が登録されていません")), "event without case/customer/location: no link, no PDF");
pe = R.placeOf(db, "event", "ev_abbrev");
ok(pe.role === "event" && pe.addressText === "須屋" && pe.documents.length === 0, "legacy area abbreviation treated as its own (ambiguous) place");
po = R.placeOf(db, "order", "ord_area");
ok(po.sameAsCustomer === false && po.documents.length === 0, "order with area-only site does not borrow customer map");
ok(po.warnings.some((w) => w.includes("不完全")), "ambiguous address warning");

section("11b. Remove blocked while shared; unlink then remove");
const shared = db.mapDocuments.find((d) => d.id === r11.document.id);
const locs = R.mapIndex(db).locationsByDoc.get(shared.id);
eq(locs.length, 2, "new version linked to both locations");
await store.mutate((d) => { S.unlinkDocument(d, shared.id, locs[1]); });
db = store.getDb();
eq((R.mapIndex(db).locationsByDoc.get(shared.id) ?? []).length, 1, "unlinked from one location");
ok(R.placeOf(db, "order", "ord_shareA").documents[0]?.id === shared.id, "remaining reference still valid");

section("16. ZENRIN provider never reports success without authorization");
const st = PR.zenrinStatus();
ok(!st.enabled && st.reasons.length >= 2, "ZENRIN adapter disabled with reasons");
process.env.ZENRIN_API_ENDPOINT = "https://example.invalid"; process.env.ZENRIN_API_KEY = "x"; process.env.ZENRIN_LICENSE_CONFIRMED = "yes";
ok(!PR.zenrinStatus().enabled, "still disabled even with env vars when no official adapter exists");
const rq = await PR.requestResidentialMap({ address: "x" });
ok(rq.ok === false && /使えません/.test(rq.error), "requestResidentialMap returns failure");
ok(!PR.geocodingEnabled(), "geocoding disabled without GOOGLE_MAPS_API_KEY");
const g = await PR.geocode("熊本県合志市須屋1234-5");
ok(g.ok === false, "geocode refuses without key (no external call)");

section("Area-precision locations are per-record (no auto-sharing)");
await store.mutate((d) => { const p = R.placeOf(d, "order", "ord_area"); S.ensureLocation(d, admin, p); });
db = store.getDb();
const pArea = R.placeOf(db, "order", "ord_area");
ok(pArea.location && pArea.location.precision === "area", "area location created and linked by ref");
const another = { ...mkOrder("ord_area2", "O-2099-0008", C2.id, "須屋") };
await store.mutate((d) => d.orders.push(another));
db = store.getDb();
ok(!R.placeOf(db, "order", "ord_area2").location, "another record with the same area text does NOT share it");

section("ゼンリン GIS の画像出力 (PNG・JPEG) → PDF にして登録・用途");
{
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#d04040" } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 300, height: 900, channels: 3, background: "#40a040" } }).jpeg().toBuffer();
  const IMG = await imp("lib/maps/image.ts");
  eq(IMG.detectMapImage(png), "png", "PNG を先頭のバイトで見分ける");
  eq(IMG.detectMapImage(jpg), "jpeg", "JPEG を先頭のバイトで見分ける");
  eq(IMG.detectMapImage(good), null, "PDF は画像として扱わない");
  const a1 = await IMG.imageToPdf(png, "png");
  const a2 = await IMG.imageToPdf(png, "png");
  ok(a1.pdf.equals(a2.pdf), "同じ画像からは同じ PDF (二重登録の確認が使える)");
  const insp = await P.inspectPdf(a1.pdf);
  ok(insp.ok && insp.pages === 1, "画像から作った PDF は 1 ページで、確認を通る");
  const big = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#fff" } }).png().toBuffer();
  const bigPdf = await (await import("pdf-lib")).PDFDocument.load((await IMG.imageToPdf(big, "png")).pdf);
  const sz = bigPdf.getPage(0).getSize();
  ok(sz.width <= 1190.6 && sz.height <= 841.9 && Math.abs(sz.width / sz.height - 2) < 0.01, "大きい横長の画像は縦横の比のまま A3 横に収める");

  const before = files().length;
  const rImg = await D.registerMapDocument({ user: koshiStaff, target: { type: "customer", id: C2.id }, file: { name: "image.png", bytes: png }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" });
  eq(rImg.status, "created", "貼り付けた画像 (image.png) を登録できる");
  eq([rImg.document.fileName, rImg.document.contentType, rImg.document.pageCount], ["image.pdf", "application/pdf", 1], "PDF にして保存 (名前・種類・ページ数)");
  eq(rImg.document.usePurpose, "internal", "ゼンリンの地図の用途の既定は「社内の資料」");
  eq(files().length, before + 1, "保存するのは PDF 1 つ");
  ok(/画像を PDF にして保存/.test(rImg.message), "登録の知らせに画像を PDF にしたことを書く");
  let t2 = "";
  try { await D.registerMapDocument({ user: koshiStaff, target: { type: "customer", id: C2.id }, file: { name: "image.png", bytes: png }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" }); } catch (e) { t2 = e.message; }
  ok(/登録済み/.test(t2), "同じ画像の二重登録は断る");
  const rJpg = await D.registerMapDocument({ user: koshiStaff, target: { type: "order", id: "ord_diff2" }, file: { name: "案内図.jpg", bytes: jpg }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true, usePurpose: "contractor", nameplate: true }, source: "upload" });
  eq([rJpg.status, rJpg.document.fileName, rJpg.document.usePurpose, rJpg.document.nameplate], ["created", "案内図.pdf", "contractor", true], "JPEG も登録でき、用途 (工事関係者への配布)・表札の情報を残す");
  let t3 = "";
  try { await D.registerMapDocument({ user: koshiStaff, target: { type: "customer", id: C2.id }, file: { name: "broken.png", bytes: Buffer.concat([png.subarray(0, 40)]) }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true }, source: "upload" }); } catch (e) { t3 = e.message; }
  ok(/画像を読み込めません/.test(t3), "壊れた画像は断る");
  let t4 = "";
  try { await D.registerMapDocument({ user: koshiStaff, target: { type: "customer", id: C2.id }, file: { name: "x.pdf", bytes: good }, meta: { provider: "zenrin", kind: "residential", licenseConfirmed: true, usePurpose: "sales" }, source: "upload" }); } catch (e) { t4 = e.message; }
  ok(/用途が正しくありません/.test(t4), "決まっていない用途は断る");
  const PU = await imp("lib/maps/purpose.ts");
  ok(/お客様 \(施主様\)・取引先には渡せません/.test(PU.MAP_USE_PURPOSE_NOTE.internal), "社内の資料の地図は、お客様・取引先に渡せないことを画面に出す");
}

summary();
