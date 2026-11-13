/**
 * ブラウザ疎通テスト (Playwright)
 * ------------------------------------------------------------
 * 各ロールでログインし、全画面を開いて致命的エラーが無いことと、
 * 代表的な操作 (顧客登録・承認・入金・書類取込・AI 質問) が成功することを確認し、
 * スクリーンショットを保存します。
 *
 *   npm run build && npm start -- -p 3100   (別ターミナル)
 *   BASE_URL=http://localhost:3100 npm run smoke
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = process.env.SHOT_DIR ?? path.join(process.cwd(), ".smoke-shots");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "ja-JP" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(`console: ${m.text()}`);
});

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

async function visit(url, name) {
  const res = await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  const status = res?.status() ?? 0;
  const body = await page.content();
  const broken = status >= 400 || /Application error|Internal Server Error|Unhandled Runtime Error/.test(body);
  results.push({ url, status, ok: !broken });
  if (broken) errors.push(`${url} -> status ${status}`);
  if (name) await shot(name);
  return page;
}

async function login(roleRegex, storeName, staffRegex) {
  await ctx.clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: roleRegex }).first().click();
  if (storeName) await page.getByRole("button", { name: storeName, exact: true }).click();
  if (staffRegex) await page.getByRole("button", { name: staffRegex }).first().click();
  await page.getByRole("button", { name: /としてログイン/ }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
}

async function expectText(re, label) {
  const ok = await page
    .getByText(re)
    .first()
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  results.push({ url: label, status: ok ? "ok" : "missing", ok });
  if (!ok) errors.push(`expected text not found: ${label}`);
}

// ---------------- 未ログイン → /login へ ----------------
await ctx.clearCookies();
const r0 = await page.goto(`${BASE}/customers`, { waitUntil: "networkidle" });
results.push({ url: "/customers (未ログイン)", status: r0?.status(), ok: page.url().includes("/login") });
await shot("00-login");

// ---------------- 店舗スタッフ (合志店 中村 花子) ----------------
await login(/^店舗スタッフ/, "合志店", /^中村 花子/);
await shot("10-staff-dashboard");
for (const [u, n] of [["/inquiries", "11-staff-inquiries"], ["/customers", null], ["/quotes", null], ["/orders", null], ["/schedule", "12-staff-schedule"], ["/invoices", null], ["/expenses", null], ["/capture", null], ["/approvals", null], ["/messages", null], ["/ai", null], ["/audit", null], ["/settings", null], ["/profile", "13-staff-profile"]]) await visit(u, n);
// 顧客登録
await visit("/customers/new", null);
await page.fill('input[name="name"]', "テスト 太郎");
await page.fill('input[name="kana"]', "テスト タロウ");
await page.fill('input[name="phone"]', "090-9999-0001");
await page.fill('input[name="address"]', "熊本県合志市須屋1-1-1");
await page.getByRole("button", { name: "登録する" }).click();
await page.waitForURL(/\/customers\/cust_/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
await expectText(/顧客を登録しました/, "action: 顧客登録");
await shot("13-staff-customer-created");
// AI電話受付の問い合わせ → 顧客として登録 → 見積作成 → 承認申請
await visit("/inquiries?status=new", null);
await page.getByRole("link", { name: /AI電話受付: 和室8畳/ }).first().click();
await page.waitForURL(/\/inquiries\/inq_/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
const inquiryUrl = page.url();
await shot("14-staff-inquiry-ai-phone");
const registerBtn = page.getByRole("button", { name: "顧客として登録する" });
if (await registerBtn.isVisible().catch(() => false)) {
  await registerBtn.click();
  await page.waitForURL(/\/customers\/.*\/edit/, { timeout: 30000 });
  await expectText(/顧客として登録しました/, "action: 問い合わせから顧客登録");
}
await page.goto(inquiryUrl, { waitUntil: "networkidle" });
await page.getByRole("link", { name: "見積を作成" }).first().click();
await page.waitForURL(/\/quotes\/new/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
await shot("15-staff-quote-new");
await page.getByRole("button", { name: "承認を申請" }).click();
await page.waitForURL(/\/quotes\/q_/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
await expectText(/承認を申請しました/, "action: 見積作成 + 承認申請");
await shot("16-staff-quote-pending");

// ---------------- 店長 (合志店 田中 健一) ----------------
await login(/^店長/, "合志店");
await shot("20-manager-dashboard");
await visit("/approvals?tab=mine", "21-manager-approvals");
const approveBtn = page.getByRole("button", { name: "承認", exact: true }).first();
if (await approveBtn.isVisible().catch(() => false)) {
  await approveBtn.click();
  await page.waitForLoadState("networkidle");
  await expectText(/承認しました/, "action: 店長が承認");
  await shot("22-manager-approved");
} else {
  errors.push("店長の承認待ちが見つかりません");
}
await visit("/reports", "23-manager-reports");
await visit("/quotes?status=approved", null);
const firstApproved = page.locator("tbody a[href^='/quotes/']").first();
if (await firstApproved.isVisible().catch(() => false)) {
  await firstApproved.click();
  await page.waitForURL(/\/quotes\/q_/, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  const sendBtn = page.getByRole("button", { name: /送付を記録/ }).first();
  if (await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click();
    await page.waitForLoadState("networkidle");
    await expectText(/送付した記録を残しました/, "action: 見積送付記録");
  }
  await shot("24-manager-quote-detail");
  const orderBtn = page.getByRole("button", { name: /受注登録/ }).first();
  if (await orderBtn.isVisible().catch(() => false)) {
    await orderBtn.click();
    await page.waitForURL(/\/orders\/o_/, { timeout: 30000 });
    await page.waitForLoadState("networkidle");
    await expectText(/受注を登録しました/, "action: 受注登録");
    await shot("25-manager-order-pending");
    const approveOrder = page.getByRole("button", { name: "契約を承認する" });
    if (await approveOrder.isVisible().catch(() => false)) {
      await approveOrder.click();
      await page.waitForLoadState("networkidle");
      await expectText(/承認しました/, "action: 契約承認");
      await shot("26-manager-order-confirmed");
    }
  }
}

// ---------------- 本部スタッフ (山本 恵) ----------------
await login(/^本部スタッフ/, null, /^山本 恵/);
await shot("30-hq-dashboard");
await visit("/invoices?status=overdue", "31-hq-invoices-overdue");
const firstInvoice = page.locator("tbody a[href^='/invoices/']").first();
if (await firstInvoice.isVisible().catch(() => false)) {
  await firstInvoice.click();
  await page.waitForURL(/\/invoices\/inv_/, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await shot("32-hq-invoice-detail");
  const payBtn = page.getByRole("button", { name: "入金を登録する" });
  if (await payBtn.isVisible().catch(() => false)) {
    await payBtn.click();
    await page.waitForLoadState("networkidle");
    await expectText(/入金を登録しました/, "action: 入金登録");
    await shot("33-hq-invoice-paid");
  }
}
await visit("/purchases", "34-hq-purchases");
await visit("/orders?status=completed", null);
const firstCompleted = page.locator("tbody a[href^='/orders/']").first();
if (await firstCompleted.isVisible().catch(() => false)) {
  await firstCompleted.click();
  await page.waitForURL(/\/orders\/o_/, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  const invBtn = page.getByRole("button", { name: /請求書を発行/ });
  if (await invBtn.isVisible().catch(() => false)) {
    await invBtn.click();
    await page.waitForURL(/\/invoices\/inv_/, { timeout: 30000 });
    await page.waitForLoadState("networkidle");
    await expectText(/請求書を発行しました/, "action: 請求書発行");
    await shot("35-hq-invoice-issued");
  }
}
await visit("/expenses", "36-hq-expenses");

// ---------------- 管理者 (山田 太郎) ----------------
await login(/^管理者/);
await shot("40-admin-dashboard");
for (const [u, n] of [["/approvals", "41-admin-approvals"], ["/reports?months=6", "42-admin-reports"], ["/audit", "43-admin-audit"], ["/settings?tab=users", "44-admin-settings-users"], ["/settings?tab=products", "45-admin-settings-products"], ["/settings?tab=rules", null], ["/settings?tab=integrations", null], ["/settings?tab=data", null], ["/settings/users/u06", "44b-admin-user-account"], ["/data", "50-admin-data-io"], ["/messages", "46-admin-messages"], ["/customers", "47-admin-customers"], ["/orders", "48-admin-orders"], ["/schedule", "49-admin-schedule"], ["/profile", null], ["/customers?q=%E7%94%B0%E4%B8%AD", null]]) await visit(u, n);
// 書類取込 (サンプル読取)
await visit("/capture?kind=receipt", null);
await page.getByRole("button", { name: /サンプル画像で読み取りを試す/ }).click();
await page.waitForURL(/\/capture\?doc=/, { timeout: 60000 });
await page.waitForLoadState("networkidle");
await expectText(/読み取りが完了しました/, "action: 書類取込 (サンプル)");
await shot("50-admin-capture");
await page.getByRole("link", { name: "経費として登録" }).click();
await page.waitForURL(/\/expenses\/new/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
await shot("51-admin-expense-from-receipt");
await page.getByRole("button", { name: "承認を申請" }).click();
await page.waitForURL(/\/expenses\/exp_/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
await expectText(/経費を登録し/, "action: 経費登録 (レシートから)");
// AI アシスタント
await visit("/ai", null);
await page.fill('input[placeholder^="質問や依頼を入力"]', "今月の売上は？");
await page.getByRole("button", { name: /送信/ }).click();
await page.getByText(/ルールベース|Claude による回答/).first().waitFor({ timeout: 60000 });
await shot("52-admin-ai");
// 印刷書式
await visit("/quotes", null);
const href = await page.locator("tbody a[href^='/quotes/']").first().getAttribute("href");
if (href) await visit(`/print${href}`, "53-print-quote");
// 社内連絡 返信
await visit("/messages", null);
const firstThread = page.locator("a[href^='/messages/th_']").first();
if (await firstThread.isVisible().catch(() => false)) {
  await firstThread.click();
  await page.waitForURL(/\/messages\/th_/, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await page.fill('textarea[name="body"]', "スモークテストからの返信です。");
  await page.getByRole("button", { name: "投稿する" }).click();
  await page.waitForLoadState("networkidle");
  await expectText(/返信を投稿しました/, "action: 社内連絡の返信");
  await shot("54-admin-thread");
}
// ヘッダー: アバター → ユーザーメニュー → プロフィール
await visit("/", null);
await page.getByRole("button", { name: "ユーザーメニュー" }).click();
await page.getByRole("menuitem", { name: "プロフィール" }).waitFor({ timeout: 10000 });
results.push({ url: "header: アバターでユーザーメニューを開く", status: "ok", ok: true });
await shot("55-admin-user-menu");
await page.getByRole("menuitem", { name: "プロフィール" }).click();
await page.waitForURL(`${BASE}/profile`, { timeout: 30000 });
await page.waitForLoadState("networkidle");
await expectText(/このアカウントでできること/, "page: /profile (ユーザーメニューから)");
await shot("56-admin-profile");
// ヘッダー: 新規作成メニュー (Esc で閉じる)
await page.getByRole("button", { name: "新規作成" }).click();
await page.getByRole("menuitem", { name: /問い合わせを登録/ }).waitFor({ timeout: 10000 });
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const createStillOpen = await page.getByRole("menuitem", { name: /問い合わせを登録/ }).isVisible().catch(() => false);
results.push({ url: "header: 新規作成メニュー (Esc で閉じる)", status: createStillOpen ? "still open" : "ok", ok: !createStillOpen });
// ヘッダー: 通知
await page.getByRole("button", { name: "通知" }).click();
await page.getByRole("menu", { name: "通知" }).waitFor({ timeout: 10000 });
results.push({ url: "header: 通知を開く", status: "ok", ok: true });
await shot("57-admin-notifications");
await page.keyboard.press("Escape");
// ヘッダー: ロゴ (公式サイトのロゴ) からダッシュボードへ
await visit("/customers", null);
await page.getByRole("link", { name: /一畳屋 統合業務システム/ }).click();
await page.waitForURL(`${BASE}/`, { timeout: 30000 });
await page.waitForLoadState("networkidle");
results.push({ url: "header: ロゴからダッシュボードへ", status: "ok", ok: true });
// ヘッダーのタブ (アイコン + 名前): クリックで画面移動し、選択中のタブが強調される
const headerNav = page.locator("header").getByRole("navigation", { name: "メインメニュー" });
await headerNav.getByRole("link", { name: "見積", exact: true }).click();
await page.waitForURL(`${BASE}/quotes`, { timeout: 30000 });
await page.waitForLoadState("networkidle");
const activeTab = (await headerNav.locator('a[aria-current="page"]').first().textContent().catch(() => "")) ?? "";
results.push({ url: "header tabs: アイコンから画面移動 (選択中の表示)", status: activeTab || "none", ok: activeTab.includes("見積") });
await shot("57b-admin-header-tabs");
// ヘッダー: 顧客検索 (ボタン → 入力 → Enter で顧客一覧を検索)
await page.getByRole("button", { name: "顧客を検索" }).click();
await page.getByRole("textbox", { name: "顧客を検索" }).fill("田中");
await page.keyboard.press("Enter");
await page.waitForURL(/\/customers\?q=/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
results.push({ url: "header: 顧客検索", status: "ok", ok: true });
// 幅の狭い PC: 入りきらないタブは「その他」にまとめ、そこから画面移動できる
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);
const moreBtn = headerNav.getByRole("button", { name: /その他/ });
const hasMore = await moreBtn.isVisible().catch(() => false);
if (hasMore) {
  await moreBtn.click();
  const moreMenu = page.getByRole("menu", { name: "その他のメニュー" });
  await moreMenu.waitFor({ timeout: 10000 });
  await shot("57c-admin-header-more");
  await moreMenu.getByRole("link", { name: /^設定/ }).click();
  await page.waitForURL(`${BASE}/settings`, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
}
results.push({ url: "header tabs (1100px): 「その他」から画面移動", status: hasMore ? "ok" : "no overflow menu", ok: hasMore && page.url() === `${BASE}/settings` });
await page.setViewportSize({ width: 1366, height: 900 });
// ヘッダー: ユーザーメニューからログアウト
await page.getByRole("button", { name: "ユーザーメニュー" }).click();
await page.getByRole("menuitem", { name: "ログアウト" }).click();
await page.waitForURL(/\/login/, { timeout: 30000 });
results.push({ url: "header: ユーザーメニューからログアウト", status: "ok", ok: page.url().includes("/login") });
await shot("58-logged-out");

// タブレット表示: ヘッダーのボタンでメニューを開き、画面を移動すると閉じる
await login(/^管理者/);
await page.setViewportSize({ width: 768, height: 1024 });
await visit("/", "59-tablet-dashboard");
await page.getByRole("button", { name: "メニューを開く" }).click();
await page.locator("#app-drawer").getByRole("link", { name: /^予定表/ }).click();
await page.waitForURL(`${BASE}/schedule`, { timeout: 30000 });
await page.waitForLoadState("networkidle");
const drawerClosed = !(await page.locator("#app-drawer").isVisible().catch(() => false));
results.push({ url: "drawer (tablet): 画面移動で閉じる", status: drawerClosed ? "ok" : "still open", ok: drawerClosed });
await shot("59b-tablet-schedule");

// モバイル表示
await page.setViewportSize({ width: 390, height: 844 });
await visit("/", "60-mobile-dashboard");
await page.getByRole("button", { name: "メニューを開く" }).click();
await page.waitForTimeout(300);
await shot("61-mobile-menu");
await page.getByRole("button", { name: "メニューを閉じる" }).click();
await page.getByRole("button", { name: "ユーザーメニュー" }).click();
await page.getByRole("menuitem", { name: "プロフィール" }).waitFor({ timeout: 10000 });
results.push({ url: "header (mobile): ユーザーメニュー", status: "ok", ok: true });
await shot("62-mobile-user-menu");
await page.keyboard.press("Escape");
await visit("/orders", "63-mobile-orders");
await visit("/customers", "64-mobile-customers");
await page.getByRole("button", { name: "ユーザーメニュー" }).click();
await page.getByRole("menuitem", { name: "ログアウト" }).click();
await page.waitForURL(/\/login/, { timeout: 30000 });
await page.waitForLoadState("networkidle");
results.push({ url: "header (mobile): ログアウト", status: "ok", ok: page.url().includes("/login") });
await shot("65-mobile-login");

await browser.close();

const okCount = results.filter((r) => r.ok).length;
console.log(`\n=== smoke: ${okCount}/${results.length} checks passed ===`);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.url} (${r.status})`);
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(" - " + e);
  process.exit(1);
}
console.log(`\nscreenshots: ${OUT}`);
