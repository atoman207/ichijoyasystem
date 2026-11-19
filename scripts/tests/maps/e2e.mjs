/**
 * 地図・住宅地図の画面のテスト (Playwright)。サンプルデータ (DATA_BACKEND=json) のサーバーに対して実行する (本番のデータに対して実行しない)
 *   BASE_URL=http://127.0.0.1:3100 node scripts/tests/maps/e2e.mjs
 * サーバーは新しいサンプルデータで起動しておく (顧客「E2E 地図 太郎」を作るため、2 回目は data/db.json を消してから)
 */
import { chromium } from "playwright";
import os from "node:os";
import { makePdf, makeJsPdf } from "./pdfs.mjs";
import fs from "node:fs";
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const HERE = fs.mkdtempSync(os.tmpdir() + "/ichijoya-maps-e2e-") + "/";
const SHOT = HERE;
fs.writeFileSync(SHOT + "cust-map.pdf", await makePdf("E2E customer residential map", 2));
fs.writeFileSync(SHOT + "site-map.pdf", await makePdf("E2E site residential map"));
fs.writeFileSync(SHOT + "site-map-v2.pdf", await makePdf("E2E site residential map v2"));
fs.writeFileSync(SHOT + "evil.pdf", await makeJsPdf());
fs.writeFileSync(SHOT + "fake.pdf", Buffer.from("not a pdf at all"));
console.log("screenshots:", SHOT);
let pass = 0, fail = 0; const fails = [];
const check = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; fails.push(m); console.log("  ✗", m); } };
const section = (t) => console.log("\n■ " + t);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable", headless: true });
const pageErrors = [];
async function session(email, viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${email}: ${e.message}`));
  await page.goto(BASE + "/login");
  const form = page.locator("form:has(input[name=password])").first();
  await form.locator("input[name=email]").fill(email);
  await form.locator("input[name=password]").fill("demo1234");
  await form.locator("button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  return { ctx, page };
}
const mapCard = (page) => page.locator("#map");
const hrefOf = async (loc) => (await loc.count()) ? loc.first().getAttribute("href") : null;
async function upload(page, file, { replace = false } = {}) {
  const card = mapCard(page);
  const opener = card.getByRole("button", { name: replace ? "差し替える" : "住宅地図の PDF を登録" }).first();
  if (await opener.count()) await opener.click();
  const form = card.locator("form:has(input[name=licenseConfirmed])").first();
  await form.locator("input[name=file]").setInputFiles(file);
  await form.locator("input[name=licenseConfirmed]").check();
  const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/maps/documents") && r.request().method() === "POST"), form.locator("button[type=submit]").click()]);
  const body = await resp.json();
  if (!body.ok) console.log("   upload error:", body.error);
  await page.waitForURL((u) => u.searchParams.has("msg"), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await page.reload();
  return body;
}
const future = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

const { page } = await session("yamada@ichijoya.example");

section("1. New customer → Google Maps link");
await page.goto(BASE + "/customers/new");
const cf = page.locator("form:has(input[name=address])").first();
await cf.locator("input[name=name]").fill("E2E 地図 太郎");
await cf.locator("input[name=kana]").fill("イーツーイー チズ タロウ");
await cf.locator("input[name=phone]").fill("090-9999-0001");
await cf.locator("input[name=address]").fill("熊本県合志市須屋2500-3");
await cf.locator("select[name=storeId]").selectOption("koshi");
await page.waitForTimeout(1200);
const dupConfirm = page.getByText("確認したうえで新規に登録する");
if (await dupConfirm.count()) await dupConfirm.click();
await cf.getByRole("button", { name: "登録する" }).click();
await page.waitForURL((u) => /^\/customers\/(?!new)[^/]+$/.test(u.pathname), { timeout: 30000 });
const custId = new URL(page.url()).pathname.split("/")[2];
check(custId && custId !== "new", `customer created (${custId})`);
let search = await hrefOf(mapCard(page).getByRole("link", { name: /地図で開く/ }));
check(search?.startsWith("https://www.google.com/maps/search/?api=1&query=") && search.includes(encodeURIComponent("熊本県合志市須屋2500-3")), "customer card: api=1 Google Maps link with encoded address");
check((await hrefOf(mapCard(page).getByRole("link", { name: /経路案内/ })))?.includes("/maps/dir/?api=1&destination="), "directions link");
check(await mapCard(page).getByText("住宅地図 未登録").isVisible(), "missing status shown before upload");
await page.screenshot({ path: SHOT + "e2e-01-customer-empty.png", fullPage: true });

section("2. Upload authorized PDF to customer (UI)");
await upload(page, SHOT + "cust-map.pdf");
check(await mapCard(page).getByText("登録済み").first().isVisible(), "customer card shows registered PDF");
check(await mapCard(page).getByText("© ZENRIN CO., LTD.").first().isVisible(), "copyright notice displayed");
const pdfHref = await hrefOf(mapCard(page).getByRole("link", { name: "新しいタブで開く" }));
const custDocId = pdfHref?.split("/").pop();
check(/^\/api\/maps\/documents\/mdoc_/.test(pdfHref ?? ""), "PDF served via authenticated endpoint (no public URL)");
let r = await page.request.get(BASE + pdfHref);
check(r.status() === 200 && r.headers()["content-type"] === "application/pdf" && (r.headers()["cache-control"] ?? "").includes("no-store"), "PDF endpoint 200 application/pdf, no-store");
r = await page.request.get(BASE + pdfHref + "?download=1");
check((r.headers()["content-disposition"] ?? "").startsWith("attachment"), "download disposition");
await mapCard(page).getByRole("button", { name: "プレビュー" }).first().click();
check(await mapCard(page).locator(`iframe[src="${pdfHref}"]`).isVisible(), "inline preview iframe");
await page.screenshot({ path: SHOT + "e2e-02-customer-pdf.png", fullPage: true });
// server-side validation through HTTP
const post = (fields, file, name) => page.request.post(BASE + "/api/maps/documents", { multipart: { ...fields, file: { name, mimeType: "application/pdf", buffer: fs.readFileSync(file) } }, headers: { origin: BASE } });
r = await post({ targetType: "customer", targetId: custId, provider: "zenrin" }, SHOT + "site-map.pdf", "x.pdf");
check(r.status() === 400 && /利用許諾/.test((await r.json()).error), "server rejects upload without license confirmation");
r = await page.request.post(BASE + "/api/maps/documents", { multipart: { targetType: "order", targetId: "o_nonexistent", licenseConfirmed: "1", file: { name: "x.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(SHOT + "site-map.pdf") } }, headers: { origin: BASE } });
check(r.status() === 404, "unknown target record → 404");
r = await post({ targetType: "customer", targetId: custId, licenseConfirmed: "1" }, SHOT + "fake.pdf", "fake.pdf");
check(r.status() === 400 && /PDF ではありません/.test((await r.json()).error), "server rejects non-PDF content");
r = await post({ targetType: "customer", targetId: custId, licenseConfirmed: "1" }, SHOT + "evil.pdf", "evil.pdf");
check(r.status() === 400 && /JavaScript|JS/.test((await r.json()).error), "server rejects PDF with JavaScript");
r = await page.request.post(BASE + "/api/maps/documents", { multipart: { targetType: "customer", targetId: custId, licenseConfirmed: "1", file: { name: "a.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(SHOT + "site-map.pdf") } }, headers: { origin: "https://evil.example" } });
check(r.status() === 403, "cross-origin upload rejected");

section("3. Project (quote → order) at the same address");
await page.goto(BASE + `/quotes/new?customerId=${custId}`);
const qf = page.locator("form:has(input[name=title])").first();
await qf.locator("input[name=title]").fill("E2E 和室6畳 表替え");
await qf.getByPlaceholder("品名").first().fill("畳表替え");
await qf.locator("input[type=number]").nth(1).fill("6000");
await qf.locator("input[type=number]").nth(0).fill("6");
await qf.getByRole("button", { name: /確定 \(承認不要\)/ }).click();
await page.waitForURL(/\/quotes\/q_/, { timeout: 30000 });
await page.getByRole("button", { name: /受注登録/ }).first().click();
await page.waitForURL(/\/orders\//, { timeout: 30000 });
const order1 = new URL(page.url()).pathname.split("/")[2];
check(Boolean(order1), `order created (${order1})`);
check(await mapCard(page).getByText("お客様の住所と同じ").first().isVisible(), "order card: same as customer");
check((await hrefOf(mapCard(page).getByRole("link", { name: /地図で開く/ }))) === search, "order shows the same Google link");
check(await mapCard(page).getByText("登録済み").first().isVisible(), "order shows the customer-address PDF (same place)");

section("4. Schedule event linked to the order");
await page.goto(BASE + `/schedule/new?orderId=${order1}&kind=delivery`);
const ef = page.locator("form:has(input[name=date])").first();
await ef.locator("input[name=title]").fill("E2E 納品");
await ef.locator("input[name=date]").fill(future);
check(await ef.getByText("案件の施工場所に合わせる").isVisible(), "event form offers 'follow case location'");
if (await ef.getByText("担当者を 1 人以上選んでください").count()) await ef.locator("input[name=assigneeIds]").first().check();
await ef.getByRole("button", { name: /登録|保存/ }).last().click();
await page.waitForURL(/\/schedule\/ev_/, { timeout: 30000 });
const ev1 = new URL(page.url()).pathname.split("/")[2];
check((await hrefOf(mapCard(page).getByRole("link", { name: /地図で開く/ }))) === search, "event card shows the same Google link");
check(await mapCard(page).getByText("登録済み").first().isVisible(), "event card shows the same PDF");
await page.screenshot({ path: SHOT + "e2e-04-event.png", fullPage: true });

section("8. Coordinates corrected on the shared location → all views");
await page.goto(BASE + `/customers/${custId}`);
await mapCard(page).getByRole("link", { name: "場所の詳細・位置の修正" }).click();
await page.waitForURL(/\/maps\/locations\//);
const loc1 = new URL(page.url()).pathname.split("/")[3];
await page.locator("input[name=coords]").fill("https://www.google.com/maps/place/x/@32.9001234,130.7502345,18z");
await page.locator("input[name=verified]").check();
await page.locator("textarea[name=note]").fill("駐車場は裏");
await page.getByRole("button", { name: "保存する" }).click();
await page.getByText("場所を更新しました").waitFor();
for (const url of [`/customers/${custId}`, `/orders/${order1}`, `/schedule/${ev1}`]) {
  await page.goto(BASE + url);
  const h = await hrefOf(mapCard(page).getByRole("link", { name: /地図で開く/ }));
  check(h?.includes("query=32.9001234%2C130.7502345"), `${url.split("/")[1]} link uses the verified coordinates`);
}
check(await mapCard(page).getByText("駐車場は裏").isVisible(), "site note visible on event card");

section("5/7. Second project at a different site (no customer PDF shown)");
await page.goto(BASE + `/quotes/new?customerId=${custId}`);
const qf2 = page.locator("form:has(input[name=title])").first();
await qf2.locator("input[name=title]").fill("E2E ご実家 襖");
await qf2.locator("input[name=siteAddress]").fill("熊本県菊池郡菊陽町原水3000-2");
await qf2.getByPlaceholder("品名").first().fill("襖張替");
await qf2.locator("input[type=number]").nth(1).fill("5000");
await qf2.getByRole("button", { name: /確定 \(承認不要\)/ }).click();
await page.waitForURL(/\/quotes\/q_/);
const quote2 = new URL(page.url()).pathname.split("/")[2];
check(await mapCard(page).getByText("お客様の住所と別の場所").isVisible(), "quote card: site differs from customer");
await page.getByRole("button", { name: /受注登録/ }).first().click();
await page.waitForURL(/\/orders\//);
const order2 = new URL(page.url()).pathname.split("/")[2];
check(await mapCard(page).getByText("熊本県菊池郡菊陽町原水3000-2").first().isVisible(), "order card shows construction-site address");
check(await mapCard(page).getByText("住宅地図 未登録 (施工場所)").isVisible(), "missing-map status for the site");
check(await mapCard(page).getByText(/表示していません/).isVisible(), "explains that the customer's map is not shown");
check(!(await mapCard(page).getByText("登録済み").count()), "customer PDF NOT displayed on the site");
search = await hrefOf(mapCard(page).getByRole("link", { name: /地図で開く/ }));
check(search?.includes(encodeURIComponent("熊本県菊池郡菊陽町原水3000-2")), "Google link points to the site");
await page.screenshot({ path: SHOT + "e2e-05-order-site-missing.png", fullPage: true });

section("6. Project-specific PDF");
await upload(page, SHOT + "site-map.pdf");
check(await mapCard(page).getByText("登録済み").first().isVisible(), "order shows its own site PDF");
const siteDoc = (await hrefOf(mapCard(page).getByRole("link", { name: "新しいタブで開く" })))?.split("/").pop();
check(siteDoc && siteDoc !== custDocId, "site PDF is a different document");
await page.goto(BASE + `/customers/${custId}`);
check((await hrefOf(mapCard(page).getByRole("link", { name: "新しいタブで開く" })))?.endsWith(custDocId), "customer still shows its own PDF");

section("9. Explicit appointment override + 8. customer address change");
await page.goto(BASE + `/schedule/new?customerId=${custId}&kind=visit`);
const ef2 = page.locator("form:has(input[name=date])").first();
await ef2.locator("input[name=title]").fill("E2E 実家で打合せ");
await ef2.locator("input[name=date]").fill(future);
await ef2.getByText("この予定だけ別の場所").click();
await ef2.locator("input[name=location]").fill("熊本市中央区新屋敷1-2-3");
if (await ef2.getByText("担当者を 1 人以上選んでください").count()) await ef2.locator("input[name=assigneeIds]").first().check();
await ef2.getByRole("button", { name: /登録|保存/ }).last().click();
await page.waitForURL(/\/schedule\/ev_/);
const evOverride = new URL(page.url()).pathname.split("/")[2];
check(await mapCard(page).getByText("熊本市中央区新屋敷1-2-3").first().isVisible(), "override event shows its own place");
await page.goto(BASE + `/customers/${custId}/edit`);
await page.locator("input[name=address]").fill("熊本県合志市須屋2600-1");
await page.getByRole("button", { name: "更新する" }).click();
await page.waitForURL(new RegExp(`/customers/${custId}\\?`));
const flash = await page.locator("body").innerText();
check(/今後の予定 \d+ 件/.test(flash), "customer update message reports propagation");
check(await mapCard(page).getByText("熊本県合志市須屋2600-1").first().isVisible(), "customer map shows the new address");
check(await mapCard(page).getByText("住宅地図 未登録").isVisible(), "old house's PDF not shown for the new address");
await page.goto(BASE + `/schedule/${ev1}`);
check(await mapCard(page).getByText("熊本県合志市須屋2600-1").first().isVisible(), "following event moved to the new address");
await page.goto(BASE + `/orders/${order1}`);
check(await mapCard(page).getByText("熊本県合志市須屋2600-1").first().isVisible(), "active order (site = customer) moved to the new address");
await page.goto(BASE + `/orders/${order2}`);
check(await mapCard(page).getByText("熊本県菊池郡菊陽町原水3000-2").first().isVisible(), "order with its own site unchanged");
await page.goto(BASE + `/schedule/${evOverride}`);
check(await mapCard(page).getByText("熊本市中央区新屋敷1-2-3").first().isVisible(), "override event NOT overwritten");
check(await mapCard(page).getByText(/お客様の住所を変えても/).first().isVisible(), "override explained on event card");

section("11. Replace and remove PDF, history kept");
await page.goto(BASE + `/orders/${order2}`);
await upload(page, SHOT + "site-map-v2.pdf", { replace: true });
const v2 = (await hrefOf(mapCard(page).getByRole("link", { name: "新しいタブで開く" })))?.split("/").pop();
check(v2 && v2 !== siteDoc, "replacement is the active version");
await mapCard(page).getByRole("link", { name: "場所の詳細・位置の修正" }).click();
await page.waitForURL(/\/maps\/locations\//);
check(await page.getByText("差し替え済み (前の版)").isVisible(), "previous version listed in history");
r = await page.request.get(BASE + `/api/maps/documents/${siteDoc}`);
check(r.status() === 200, "previous version file still retrievable (audit)");
await page.getByText("情報の修正・取り消し").click();
await page.locator("input[name=reason]").fill("E2E 取り消しテスト");
await page.getByRole("button", { name: /取り消す \(台帳と履歴は残ります\)/ }).click();
await page.getByText(/取り消しました/).waitFor();
r = await page.request.get(BASE + `/api/maps/documents/${v2}`);
check(r.status() === 410, "removed document returns 410 (file deleted)");
check(await page.getByText("取り消し").first().isVisible() && await page.getByText("E2E 取り消しテスト").first().isVisible() && await page.getByText("住宅地図を取り消し (理由: E2E 取り消しテスト)").isVisible(), "removal + reason kept in history");
await page.goto(BASE + `/orders/${order2}`);
check(await mapCard(page).getByText("住宅地図 未登録 (施工場所)").isVisible(), "order shows missing again (no fallback to customer map)");

section("12. Unauthorized access");
const anon = await browser.newContext();
r = await anon.request.get(BASE + `/api/maps/documents/${custDocId}`, { maxRedirects: 0 });
check(r.status() === 307 && (r.headers()["location"] ?? "").includes("/login") && r.headers()["content-type"] !== "application/pdf", "anonymous direct URL → redirected to login, no PDF served");
r = await anon.request.get(BASE + `/api/maps/documents/${custDocId}?download=1`);
check(r.headers()["content-type"] !== "application/pdf", "anonymous download never returns the PDF");
const { page: kp } = await session("kato@ichijoya.example"); // 中央店 staff
r = await kp.request.get(BASE + `/api/maps/documents/${custDocId}`);
check(r.status() === 403, "other-store staff direct PDF URL → 403");
await kp.goto(BASE + `/maps/locations/${loc1}`);
check(!kp.url().includes("/maps/locations/"), "other-store staff cannot open the location page");
await kp.goto(BASE + "/maps");
check(!new URL(kp.url()).pathname.startsWith("/maps"), "store staff cannot open map admin page");
r = await kp.request.post(BASE + "/api/maps/documents", { multipart: { targetType: "customer", targetId: custId, licenseConfirmed: "1", file: { name: "a.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(SHOT + "site-map-v2.pdf") } }, headers: { origin: BASE } });
check(r.status() === 403, "other-store staff upload → 403");
r = await kp.request.post(BASE + "/api/maps/batch", { data: { action: "start", kind: "normalize", dryRun: true }, headers: { origin: BASE } });
check(r.status() === 403, "store staff batch API → 403");
const { page: np } = await session("nakamura@ichijoya.example"); // 合志店 staff (same store)
r = await np.request.get(BASE + `/api/maps/documents/${custDocId}`);
check(r.status() === 200, "same-store staff can open the PDF");
await np.goto(BASE + `/customers/${custId}`);
check(await mapCard(np).getByText("お客様の住所 · Google マップ").isVisible(), "same-store staff sees the map card");

section("Mobile layout");
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", isMobile: true, hasTouch: true });
const mp = await mctx.newPage();
await mp.goto(BASE + "/login");
const mf = mp.locator("form:has(input[name=password])").first();
await mf.locator("input[name=email]").fill("nakamura@ichijoya.example"); await mf.locator("input[name=password]").fill("demo1234"); await mf.locator("button[type=submit]").click();
await mp.waitForURL((u) => !u.pathname.startsWith("/login"));
await mp.goto(BASE + `/schedule/${ev1}`);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `no horizontal scroll on phone (${overflow}px)`);
check(await mapCard(mp).getByRole("link", { name: /経路案内/ }).isVisible(), "directions button visible on phone");
await mapCard(mp).scrollIntoViewIfNeeded();
await mp.screenshot({ path: SHOT + "e2e-mobile-event.png", fullPage: false });

section("13. Bulk normalization from the admin page (dry run)");
await page.goto(BASE + "/maps");
check(await page.getByText("ゼンリン 住宅地図 (自動取得)").isVisible() && await page.getByText("使えません").first().isVisible(), "ZENRIN shown as not available (16)");
const nform = page.locator("form").filter({ hasText: "① 顧客の住所の正規化" });
await nform.getByRole("button", { name: "開始" }).click();
await page.getByText("報告 (CSV) をダウンロード").waitFor({ timeout: 30000 });
const rep = await hrefOf(page.getByRole("link", { name: "報告 (CSV) をダウンロード" }));
r = await page.request.get(BASE + rep);
const body = await r.text();
check(r.status() === 200 && body.includes("元の住所 (変更していません)") && body.includes("E2E 地図 太郎"), "normalize report CSV downloadable");
await page.screenshot({ path: SHOT + "e2e-13-maps-admin.png", fullPage: true });

section("Explicit actions: follow case, use customer address, manual link, share PDF");
// follow case location on the override event
await page.goto(BASE + `/schedule/${evOverride}`);
await mapCard(page).getByRole("button", { name: "案件・お客様の場所に合わせる" }).click();
await page.waitForURL((u) => (u.searchParams.get("msg") ?? "").includes("これからは"));
check(await mapCard(page).getByText("熊本県合志市須屋2600-1").first().isVisible(), "override event switched to follow the customer (explicit button)");
// order with area-only site that is part of the customer address
await page.goto(BASE + `/quotes/new?customerId=${custId}`);
const qf3 = page.locator("form:has(input[name=title])").first();
await qf3.locator("input[name=title]").fill("E2E 網戸");
await qf3.locator("input[name=siteAddress]").fill("須屋");
await qf3.getByPlaceholder("品名").first().fill("網戸張替");
await qf3.locator("input[type=number]").nth(1).fill("3000");
await qf3.getByRole("button", { name: /確定 \(承認不要\)/ }).click();
await page.waitForURL(/\/quotes\/q_/);
await page.getByRole("button", { name: /受注登録/ }).first().click();
await page.waitForURL(/\/orders\//);
check(await mapCard(page).getByText("番地なし・位置は要確認").isVisible(), "area-only site flagged as ambiguous");
check(!(await mapCard(page).getByText("登録済み").count()), "area-only site does not borrow the customer's map");
await mapCard(page).getByRole("button", { name: "施工場所をお客様の住所にする" }).click();
await page.waitForURL((u) => (u.searchParams.get("msg") ?? "").includes("施工場所をお客様の住所にしました"));
check(await mapCard(page).getByText("お客様の住所と同じ").first().isVisible(), "site set to customer address only after explicit click");
// manual link of an area-only appointment place to a registered place
await page.goto(BASE + `/schedule/new?customerId=${custId}&kind=visit`);
const ef3 = page.locator("form:has(input[name=date])").first();
await ef3.locator("input[name=title]").fill("E2E 近所の現場確認");
await ef3.locator("input[name=date]").fill(new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10));
await ef3.getByText("この予定だけ別の場所").click();
await ef3.locator("input[name=location]").fill("合志市須屋");
if (await ef3.getByText("担当者を 1 人以上選んでください").count()) await ef3.locator("input[name=assigneeIds]").first().check();
await ef3.getByRole("button", { name: /登録|保存/ }).last().click();
await page.waitForURL(/\/schedule\/ev_/);
check(await mapCard(page).getByRole("button", { name: "この場所に結び付ける" }).isVisible(), "manual link picker offered for an area-only place");
await mapCard(page).locator("select[name=locationId]").selectOption({ label: "熊本県合志市須屋2500-3" });
await mapCard(page).getByRole("button", { name: "この場所に結び付ける" }).click();
await page.waitForURL((u) => (u.searchParams.get("msg") ?? "").includes("場所を結び付けました"));
check((await hrefOf(mapCard(page).getByRole("link", { name: /地図で開く/ })))?.includes("32.9001234%2C130.7502345"), "manually linked appointment uses the chosen place (verified coords)");
check(await mapCard(page).getByText("登録済み").first().isVisible(), "…and its residential map");
// share the customer PDF with the customer's new address location (licensing permits)
await page.goto(BASE + `/maps/locations/${loc1}`);
await page.getByText("情報の修正・取り消し").first().click();
await page.locator("input[name=shareable]").last().check();
await page.locator("input[name=edition]").first().fill("2025年版");
await page.getByRole("button", { name: "修正する" }).click();
await page.waitForURL((u) => (u.searchParams.get("msg") ?? "").includes("住宅地図の情報を修正しました"));
await page.goto(BASE + `/customers/${custId}`);
await mapCard(page).getByRole("button", { name: "位置を確認・修正する" }).click();
await page.waitForURL(/\/maps\/locations\//);
check(await page.getByText("近くの場所の住宅地図を使う (共用してよい PDF)").isVisible(), "shareable nearby map offered on the new location");
await page.getByRole("button", { name: "結び付ける" }).click();
await page.waitForURL((u) => (u.searchParams.get("msg") ?? "").includes("共用します"));
await page.goto(BASE + `/customers/${custId}`);
check(await mapCard(page).getByText(/ほか 1 か所で共用/).isVisible(), "customer now shows the shared PDF (one file, two places)");
await page.goto(BASE + `/maps/locations/${loc1}`);
check(await page.getByText("2025年版").first().isVisible(), "document info edit saved");

section("17. Existing screens still work");
for (const p of ["/", "/customers", "/orders", "/quotes", "/schedule", "/schedule?view=week", "/cases", "/invoices", "/settings", "/audit", "/help", `/customers/${custId}`, `/quotes/${quote2}`]) {
  const resp = await page.goto(BASE + p);
  check(resp.status() === 200 && !(await page.getByText("Application error").count()), `${p} renders (200)`);
}
await page.goto(BASE + "/audit");
const auditText = await page.locator("body").innerText();
check(/住宅地図を登録/.test(auditText) && /住宅地図を(表示|ダウンロード)/.test(auditText), "audit log has upload + access entries");
await page.goto(BASE + "/help");
check(await page.getByText("地図・住宅地図 (全員。一括処理は本部・管理者)").first().isVisible(), "help guide has the maps section");
// logout / login cycle
await page.goto(BASE + "/");
check(pageErrors.length === 0, `no client-side errors (${pageErrors.slice(0, 3).join(" | ")})`);
fs.writeFileSync(HERE + "e2e-ids.json", JSON.stringify({ custId, loc1, custDocId }));
console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exitCode = 1; }
await browser.close();
