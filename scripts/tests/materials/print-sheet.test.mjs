/**
 * 材料発注の画面の「見積・図面を印刷」のテスト (お客様のご要望 2026-11-27「材料発注画面から、該当案件の見積内容と現場図面を…直接印刷」)
 *   node scripts/tests/materials/print-sheet.test.mjs   (npm run test:materials)
 * 1. 印刷の内容 (src/lib/material-orders/print-sheet.ts の printSheetOf): 見出し・見積の明細と合計・現場の情報・発注する材料・手書き見積書の原本・現場図面 (PDF)・採寸図 (写真)
 * 2. PDF の図面のページの画像 (/api/attachments/<ID>/page): ページ数・PNG・範囲外・PDF でない・ログインなし・権限なし
 * データは一時フォルダーの JSON (サンプルデータ)。名前は架空。外部への送信・AI は使わない
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { PDFDocument } from "pdf-lib";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-print-sheet-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "print-sheet-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-print-sheet",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)) delete process.env[k];
process.chdir(work);
const stubs = path.join(root, "scripts/tests/ops-reports/stubs");
const jiti = createJiti(import.meta.url, {
  alias: {
    "next/navigation": path.join(stubs, "next-navigation.cjs"),
    "next/cache": path.join(stubs, "next-cache.cjs"),
    "@/lib/auth/session": path.join(stubs, "session.cjs"),
    "@": path.join(root, "src"),
    "server-only": path.join(root, "scripts/tests/maps/empty.cjs"),
  },
  moduleCache: true,
});
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fails.push(msg);
    console.log("  ✗", msg);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n■ ${t}`);

const store = await imp("lib/db/store.ts");
const storage = await imp("lib/storage.ts");
const P = await imp("lib/material-orders/plan.ts");
const PS = await imp("lib/material-orders/print-sheet.ts");
const route = await imp("app/api/attachments/[id]/page/route.ts");
await store.syncDb();
const db = () => store.getDb();
const today = "2031-06-10";
const now = new Date().toISOString();

const staff = db().users.find((u) => u.active && u.role === "store_staff");
const S = staff.storeId;
const otherStore = db().stores.find((s) => s.id !== S && s.kind !== "hq").id;
const outsider = db().users.find((u) => u.active && u.role === "store_staff" && u.storeId === otherStore);

// 2 ページの PDF (現場図面) と写真 (採寸図・手書き見積書の原本)
const pdf = await PDFDocument.create();
pdf.addPage([595, 842]);
pdf.addPage([842, 595]);
const pdfBytes = Buffer.from(await pdf.save());
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
await storage.putObject("test/plan.pdf", pdfBytes);
await storage.putObject("test/measure.png", png);
await storage.putObject("test/original.png", png);

await store.mutate((x) => {
  x.customers.push({ id: "c_ps", code: "C-99981", name: "架空 次郎", kana: "", phone: "", postalCode: "", address: "熊本県テスト市テスト町3-4", storeId: S, type: "individual", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: now, updatedAt: now });
  x.documents.push({ id: "doc_ps", kind: "quote", fileName: "見積書.jpg", uploadedBy: staff.id, storeId: S, uploadedAt: now, status: "confirmed", extracted: {} });
  x.quotes.push({
    id: "q_ps",
    number: "Q-2031-9981",
    version: 1,
    customerId: "c_ps",
    storeId: S,
    title: "襖 4 枚",
    category: "fusuma",
    documentId: "doc_ps",
    siteAddress: "熊本県テスト市げんば町5-6",
    items: [
      { id: "l1", name: "襖", spec: "両面 のぞみ177", qty: 4, unit: "枚", unitPrice: 5000, amount: 20000 },
      { id: "l2", name: "諸経費", qty: 1, unit: "式", unitPrice: 2000, amount: 2000 },
    ],
    subtotal: 22000,
    discount: 0,
    tax: 2000,
    total: 22000,
    taxIncluded: true,
    siteInfo: { pickupAt: "6/11 AM", sizes: "五八", remarks: "2階の和室" },
    status: "accepted",
    createdBy: staff.id,
    createdAt: now,
    updatedAt: now,
    orderId: "o_ps",
  });
  x.orders.push({ id: "o_ps", number: "O-2031-9981", quoteId: "q_ps", customerId: "c_ps", storeId: S, title: "襖 4 枚", category: "fusuma", contractDate: today, total: 22000, status: "scheduled", workerIds: [], siteAddress: "熊本県テスト市げんば町5-6", progressNotes: [], createdBy: staff.id, createdAt: now, updatedAt: now });
  x.schedule.push({ id: "ev_ps_d", title: "納品", kind: "delivery", date: "2031-06-12", storeId: S, assigneeIds: [], orderId: "o_ps", customerId: "c_ps", source: "manual", createdBy: staff.id, createdAt: now, updatedAt: now });
  const att = { storeId: S, customerId: "c_ps", uploadedBy: staff.id, uploadedAt: now };
  x.attachments.push({ ...att, id: "att_ps_orig", parentType: "document", parentId: "doc_ps", kind: "photo", fileName: "見積書.png", contentType: "image/png", size: png.length, storageKey: "test/original.png" });
  x.attachments.push({ ...att, id: "att_ps_plan", parentType: "order", parentId: "o_ps", kind: "file", fileName: "図面.pdf", contentType: "application/pdf", size: pdfBytes.length, storageKey: "test/plan.pdf", category: "site_plan" });
  x.attachments.push({ ...att, id: "att_ps_meas", parentType: "order", parentId: "o_ps", kind: "photo", fileName: "採寸.png", contentType: "image/png", size: png.length, storageKey: "test/measure.png", category: "measure" });
  x.attachments.push({ ...att, id: "att_ps_photo", parentType: "order", parentId: "o_ps", kind: "photo", fileName: "施工前.png", contentType: "image/png", size: png.length, storageKey: "test/measure.png", category: "before" });
  x.materialOrders = [];
});

/* ================================================================== */
section("1. 印刷の内容 (printSheetOf)");
const rows = P.materialRows(db(), today, { orderIds: ["o_ps"] });
ok(rows.length > 0, "案件の材料 (襖紙) が出る");
const sheet = PS.printSheetOf(db(), rows[0], rows);
eq(sheet.title, "架空 次郎 様 襖 4 枚", "見出し = お客様・案件");
ok(sheet.lines[0].includes("O-2031-9981") && sheet.lines[0].includes("納品") && sheet.lines[1] === "施工場所: 熊本県テスト市げんば町5-6", `見出しの下: 受注番号・店舗・日程・施工場所 (${sheet.lines.join(" / ")})`);
eq(sheet.quote?.items.map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.amount]), [["襖", "両面 のぞみ177", "4", "枚", "¥20,000"], ["諸経費", "", "1", "式", "¥2,000"]], "見積の明細 (単価・金額は選んだときだけ印刷)");
ok(sheet.quote.totals.includes("合計 ¥22,000") && sheet.quote.totals.includes("内税"), `合計 (${sheet.quote.totals})`);
ok(sheet.quote.site.some(([k, v]) => v === "2階の和室") && sheet.quote.site.some(([, v]) => v === "五八"), "手書きの見積書の現場の情報 (備考・サイズ)");
ok(sheet.materials.some((m) => m.name.includes("襖紙") || m.code === "のぞみ177"), "発注する材料 (襖紙 のぞみ177)");
eq(sheet.files.map((f) => [f.id, f.label, f.kind]), [["att_ps_orig", "手書き見積書の原本", "image"], ["att_ps_plan", "現場図面", "pdf"], ["att_ps_meas", "採寸図", "image"]], "原本・現場図面 (PDF)・採寸図 (写真)。施工前の写真など発注に使わない写真は出さない");
ok(JSON.parse(JSON.stringify(sheet)) && typeof sheet.files[0].name === "string", "画面の部品に渡せる (JSON にできる)");

/* ================================================================== */
section("2. PDF の図面のページの画像 (/api/attachments/<ID>/page)");
const call = async (user, id, qs) => {
  globalThis.__testUser = user;
  try {
    return await route.GET(new Request(`http://test.local/api/attachments/${id}/page${qs}`), { params: Promise.resolve({ id }) });
  } finally {
    globalThis.__testUser = undefined;
  }
};
{
  let r = await call(staff, "att_ps_plan", "?info=1");
  eq([r.status, await r.json()], [200, { pages: 2, total: 2 }], "ページ数 (2 ページ)");
  r = await call(staff, "att_ps_plan", "?p=3");
  eq(r.status, 404, "範囲外のページは 404");
  r = await call(staff, "att_ps_meas", "?info=1");
  eq(r.status, 400, "PDF でない資料は 400 (写真はそのまま印刷する)");
  r = await call(null, "att_ps_plan", "?info=1");
  eq(r.status, 401, "ログインしていなければ 401");
  if (outsider) {
    const viewable = (await imp("lib/attachments.ts")).canViewAttachment(outsider, db(), db().attachments.find((a) => a.id === "att_ps_plan"));
    r = await call(outsider, "att_ps_plan", "?info=1");
    eq(r.status, viewable ? 200 : 403, `閲覧の権限は資料の画面と同じ (canViewAttachment = ${viewable})`);
  }
  const hasPoppler = await (await imp("lib/maps/render.ts")).rendererAvailable();
  if (hasPoppler) {
    r = await call(staff, "att_ps_plan", "?p=2");
    const body = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && r.headers.get("content-type") === "image/png" && body[0] === 0x89 && body[1] === 0x50, "2 ページ目を PNG にする (poppler の pdftoppm)");
  } else {
    console.log("  - pdftoppm がないため、PNG にする確認は省略");
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
