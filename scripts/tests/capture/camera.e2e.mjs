// ============================================================
// 書類の撮影・取込の画面のテスト (パソコン = ブラウザーのカメラ / スマートフォン = 端末のカメラ)
//
//   node scripts/tests/capture/camera.e2e.mjs [http://localhost:3101]
//
// サンプルデータ (DATA_BACKEND=json) のサーバーに対して動かす (本番・テスト用のサーバーには使わない。書類・見積・写真を登録する)。
// ログインはサンプルのアカウント (店長 tanaka@ichijoya.example / demo1234)。Chrome は CHROME_PATH (なければ /usr/bin/google-chrome)。
// パソコンのカメラは Chrome の偽のカメラ (--use-fake-device-for-media-stream) に書類の画像を映して確かめる。
// 画面の写しは SHOTS (既定は一時フォルダー) に残す。
// ============================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, devices } from "playwright";
import sharp from "sharp";

const BASE = process.argv[2] ?? process.env.BASE ?? "http://localhost:3101";
const USER = process.env.E2E_USER ?? "tanaka@ichijoya.example";
const PASS = process.env.E2E_PASS ?? "demo1234";
const CHROME = process.env.CHROME_PATH ?? (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "capture-e2e-"));
const SHOTS = process.env.SHOTS ?? path.join(WORK, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

// --- 試しの画像: 手書き見積書らしい紙 (スマートフォンの写真の大きさ) と、偽のカメラに映す映像 (MJPEG) ---
const paper = (w, h) =>
  Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#f4f1ea"/>` +
      `<text x="${w * 0.1}" y="${h * 0.12}" font-size="${h * 0.05}" fill="#223">御見積書</text>` +
      Array.from({ length: 10 }, (_, i) => `<text x="${w * 0.1}" y="${h * (0.22 + i * 0.07)}" font-size="${h * 0.03}" fill="#334">畳 表替え ${i + 1}   6   8,500</text>`).join("") +
      "</svg>",
  );
const PHOTO = path.join(WORK, "phone-photo.jpg");
await sharp({ create: { width: 3024, height: 4032, channels: 3, background: "#f4f1ea" } }).composite([{ input: paper(3024, 4032) }]).jpeg({ quality: 92 }).toFile(PHOTO);
const FRAME = await sharp({ create: { width: 1280, height: 960, channels: 3, background: "#555" } })
  .composite([{ input: await sharp(paper(600, 840)).png().toBuffer(), left: 340, top: 60 }])
  .jpeg({ quality: 85 })
  .toBuffer();
const MJPEG = path.join(WORK, "document.mjpeg");
fs.writeFileSync(MJPEG, Buffer.concat(Array.from({ length: 30 }, () => FRAME)));

async function launch(args) {
  return chromium.launch({ executablePath: CHROME, headless: true, args });
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  const f = page.locator("form:has(input[name=password])").first();
  await f.locator("input[name=email]").fill(USER);
  await f.locator("input[name=password]").fill(PASS);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login")), f.locator("button[type=submit]").first().click()]);
}

/** 画面の横のはみ出し (ページの横スクロール + 入力欄が画面の外に出ていないか) */
async function layout(page) {
  return page.evaluate(() => {
    const w = innerWidth;
    const outside = [...document.querySelectorAll("main input:not([type=hidden]), main select, main textarea")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(el).visibility !== "hidden" && el.closest(".overflow-x-auto") === null && r.right > w + 1;
      })
      .map((el) => el.getAttribute("aria-label") || el.getAttribute("name") || el.tagName);
    return { scroll: document.documentElement.scrollWidth > w, outside };
  });
}

async function submitCapture(page) {
  const form = page.locator("form:has([data-capture-zone])").first();
  await Promise.all([page.waitForURL((u) => u.searchParams.has("doc") || /\/reception\/./.test(u.pathname), { timeout: 90_000 }), form.locator("button[type=submit]").first().click()]);
  await page.waitForLoadState("networkidle");
}

// ============================================================
console.log(`\nパソコン (Chrome 1366×900・偽のカメラ) — ${BASE}`);
{
  const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${MJPEG}`]);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.grantPermissions(["camera"], { origin: BASE });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await login(page);

  await page.goto(`${BASE}/capture?kind=handwritten_quote`, { waitUntil: "networkidle" });
  check("「カメラで撮影」と「ファイルを選ぶ」がある", (await page.getByRole("button", { name: "カメラで撮影" }).count()) === 1 && (await page.getByRole("button", { name: "ファイルを選ぶ" }).count()) === 1);
  check("スマートフォンの「撮影する」は出さない", (await page.getByRole("button", { name: "撮影する" }).count()) === 0);
  check("入力欄の文字はパソコンでは 14px のまま", (await page.locator("main select.field").first().evaluate((el) => getComputedStyle(el).fontSize)) === "14px");

  await page.getByRole("button", { name: "カメラで撮影" }).click();
  const dialog = page.getByRole("dialog", { name: /カメラで撮影/ });
  await dialog.waitFor();
  const shutter = dialog.getByRole("button", { name: "撮影", exact: true });
  await shutter.waitFor();
  await page.waitForFunction(() => {
    const v = document.querySelector("dialog video");
    return v && v.videoWidth > 0;
  });
  check("カメラの映像が出て「撮影」を押せる", await shutter.isEnabled());
  const size = await page.evaluate(() => {
    const v = document.querySelector("dialog video");
    return { w: v.videoWidth, h: v.videoHeight };
  });
  check("カメラの解像度で撮る (偽のカメラ 1280×960)", size.w === 1280 && size.h === 960, JSON.stringify(size));
  await page.screenshot({ path: path.join(SHOTS, "pc-1-camera.png") });
  await shutter.click();
  await dialog.getByRole("img", { name: "撮影した画像" }).waitFor();
  await dialog.getByRole("button", { name: "右に回転" }).click();
  await page.waitForTimeout(300);
  const rotated = await dialog.getByRole("img", { name: "撮影した画像" }).evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  check("右に回転すると縦横が入れ替わる", rotated.w === 960 && rotated.h === 1280, JSON.stringify(rotated));
  await dialog.getByRole("button", { name: "左に回転" }).click();
  await page.screenshot({ path: path.join(SHOTS, "pc-2-shot.png") });
  await dialog.getByRole("button", { name: "この写真を使う" }).click();
  await dialog.waitFor({ state: "detached" });
  check("撮った写真が取込の欄に入る", (await page.getByRole("img", { name: "取り込む画像のプレビュー" }).count()) === 1);
  check("ファイル名は camera-日時.jpg", /camera-\d{8}-\d{6}\.jpg/.test((await page.locator("[data-capture-zone]").innerText()) ?? ""));
  await submitCapture(page);
  check("読み取って確認の画面に進む", new URL(page.url()).searchParams.has("doc"), page.url());
  const items = page.getByRole("group", { name: "1 行目" }).first();
  const qb = await items.getByRole("textbox", { name: "数量" }).boundingBox();
  const ab = await items.getByRole("textbox", { name: "金額" }).boundingBox();
  check("確認の画面の明細は数量〜金額が 1 行に並ぶ (パソコンの欄の幅に合わせる)", qb && ab && Math.abs(qb.y - ab.y) < 2, JSON.stringify({ qb, ab }));
  check("明細の行に単価・金額の欄がある", (await items.getByRole("textbox", { name: "単価" }).count()) === 1 && (await items.getByRole("textbox", { name: "金額" }).count()) === 1);
  let l = await layout(page);
  check("確認の画面は横にはみ出さない", !l.scroll && l.outside.length === 0, JSON.stringify(l));
  await page.screenshot({ path: path.join(SHOTS, "pc-3-review.png"), fullPage: true });

  // 見積を作成 → 明細の表 → 下書き保存
  await Promise.all([page.waitForURL(/\/quotes\/new/), page.getByRole("button", { name: /見積を作成/ }).first().click()]);
  await page.waitForLoadState("networkidle");
  check("見積の作成: 明細の見出しの行が出る (表)", await page.locator("text=商品 (マスタから選択)").first().isVisible());
  l = await layout(page);
  check("見積の作成は横にはみ出さない", !l.scroll && l.outside.length === 0, JSON.stringify(l));
  const row1 = page.getByRole("group", { name: "明細 1 行目" });
  await row1.getByRole("spinbutton", { name: "数量" }).fill("3");
  await row1.getByRole("spinbutton", { name: "単価" }).fill("8500");
  check("数量 × 単価で金額が変わる", (await row1.innerText()).includes("¥25,500"));
  await page.screenshot({ path: path.join(SHOTS, "pc-4-quote.png"), fullPage: true });
  await page.locator("select[name=customerId]").selectOption({ index: 1 });
  await Promise.all([page.waitForURL(/\/quotes\/(?!new)/), page.getByRole("button", { name: "下書き保存" }).click()]);
  check("見積を下書き保存できる", /\/quotes\/[^/?]+/.test(new URL(page.url()).pathname) && !page.url().includes("err="), page.url());

  // 写真の登録 (見積の画面): 続けて 2 枚撮って登録
  await page.waitForLoadState("networkidle");
  const attach = page.getByRole("button", { name: "カメラで撮影" }).first();
  if ((await attach.count()) === 0) {
    check("見積の画面に写真の「カメラで撮影」がある", false);
  } else {
    await attach.click();
    const d2 = page.getByRole("dialog", { name: /カメラで撮影/ });
    const s2 = d2.getByRole("button", { name: "撮影", exact: true });
    await s2.waitFor();
    await page.waitForFunction(() => (document.querySelector("dialog video")?.videoWidth ?? 0) > 0);
    for (let i = 0; i < 2; i++) {
      await s2.click();
      await d2.getByRole("button", { name: "この写真を追加" }).click();
    }
    await d2.getByRole("button", { name: "2 枚を登録する" }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    check("続けて 2 枚撮れる", (await d2.getByRole("button", { name: "2 枚を登録する" }).count()) === 1);
    await d2.getByRole("button", { name: "2 枚を登録する" }).click();
    await page.getByText("2 / 2 件を登録しました").waitFor({ timeout: 30_000 }).catch(() => undefined);
    check("2 枚とも写真として登録される", (await page.getByText("2 / 2 件を登録しました").count()) === 1);
  }

  // ファイルを選ぶ・貼り付け (Ctrl+V)
  await page.goto(`${BASE}/capture?kind=receipt`, { waitUntil: "networkidle" });
  await page.locator("[data-testid=capture-file]").setInputFiles(PHOTO);
  check("ファイルを選ぶと取込の欄に入る", (await page.getByRole("img", { name: "取り込む画像のプレビュー" }).count()) === 1);
  await page.getByRole("button", { name: "取り消す" }).click();
  await page.evaluate(async () => {
    const blob = await (await fetch("/icons/icon-192.png")).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    document.body.focus();
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check("画像を貼り付ける (Ctrl+V) と取込の欄に入る", /paste-\d+\.png/.test(await page.locator("[data-capture-zone]").innerText()));
  await ctx.close();
  await browser.close();
}

console.log("\nパソコン: カメラが 2 台 (内蔵 + USB でつないだスマートフォン・外付けのカメラ)");
{
  // 映像のファイルを指定すると偽のカメラは 1 台になるので、ここは Chrome の試しの映像 (2 台)
  const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream=device-count=2"]);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.grantPermissions(["camera"], { origin: BASE });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await login(page);
  await page.goto(`${BASE}/capture`, { waitUntil: "networkidle" });
  const openCamera = async () => {
    await page.getByRole("button", { name: "カメラで撮影" }).click();
    const d = page.getByRole("dialog", { name: /カメラで撮影/ });
    await d.getByRole("button", { name: "撮影", exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector("dialog video")?.videoWidth ?? 0) > 0 && !document.querySelector("dialog select")?.disabled);
    return d;
  };
  let d = await openCamera();
  const select = d.getByRole("combobox");
  const options = await select.locator("option").allTextContents();
  check("カメラが 2 台あると「カメラ」で選べる", options.length === 2, JSON.stringify(options));
  const second = await select.locator("option").nth(1).getAttribute("value");
  await select.selectOption(second);
  await page.waitForFunction((id) => {
    const v = document.querySelector("dialog video");
    const t = v?.srcObject?.getVideoTracks?.()[0];
    return t && t.getSettings().deviceId === id && v.videoWidth > 0;
  }, second);
  check("選んだカメラに切り替わる", (await select.inputValue()) === second);
  await page.keyboard.press("Escape");
  await d.waitFor({ state: "detached" });
  d = await openCamera();
  check("次に開くと前に選んだカメラ (ブラウザーに保存)", (await d.getByRole("combobox").inputValue()) === second);
  // 使っているカメラが外された (スマートフォンの USB を抜いた) → ほかのカメラに切り替えて知らせる
  await page.evaluate(() => document.querySelector("dialog video").srcObject.getVideoTracks()[0].dispatchEvent(new Event("ended")));
  await d.getByRole("status").filter({ hasText: "外されたため" }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("使っているカメラを外すと、ほかのカメラに切り替えて知らせる", (await d.getByRole("status").filter({ hasText: "外されたため" }).count()) === 1);
  const switched = await page
    .waitForFunction(() => !document.querySelector("dialog button[type=button].bg-accent")?.disabled && (document.querySelector("dialog video")?.videoWidth ?? 0) > 0, null, { timeout: 15_000 })
    .then(() => true, () => false);
  check("切り替えたカメラで撮影できる", switched && (await d.getByRole("button", { name: "撮影", exact: true }).isEnabled()));
  await page.screenshot({ path: path.join(SHOTS, "pc-5-two-cameras.png") });
  await ctx.close();
  await browser.close();
}

console.log("\nパソコン: カメラがない・許可されないとき");
{
  // カメラなし (偽のカメラを使わない。サーバーにはカメラがない)
  const browser = await launch(["--use-fake-ui-for-media-stream"]);
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await login(page);
  await page.goto(`${BASE}/capture`, { waitUntil: "networkidle" });
  await page.getByText("このパソコンにはカメラが見つかりません").waitFor({ timeout: 5000 }).catch(() => undefined);
  check("カメラがないパソコンでは、つなげば撮影できると知らせる", (await page.getByText("このパソコンにはカメラが見つかりません").count()) === 1);
  await page.getByRole("button", { name: "カメラで撮影" }).click();
  await page.getByRole("alert").filter({ hasText: "カメラが見つかりません" }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("押すと「カメラが見つかりません」と「もう一度」", (await page.getByRole("alert").filter({ hasText: "カメラが見つかりません" }).count()) === 1 && (await page.getByRole("button", { name: "もう一度" }).count()) === 1);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  check("Esc でカメラの画面を閉じる", (await page.getByRole("dialog").count()) === 0);
  await browser.close();
}
{
  // 許可されない
  const browser = await launch(["--use-fake-device-for-media-stream", "--deny-permission-prompts"]);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  await page.goto(`${BASE}/capture`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "カメラで撮影" }).click();
  await page.getByRole("alert").filter({ hasText: "許可されていません" }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("許可されないときは、許可のしかたを知らせる", (await page.getByRole("alert").filter({ hasText: "許可されていません" }).count()) === 1);
  await ctx.close();
  await browser.close();
}

// ============================================================
console.log("\nスマートフォン (iPhone 13 の画面・タッチ)");
{
  const browser = await launch([]);
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await login(page);
  await page.goto(`${BASE}/capture?kind=handwritten_quote`, { waitUntil: "networkidle" });
  check("「撮影する」と「写真・ファイルを選ぶ」がある", (await page.getByRole("button", { name: "撮影する" }).count()) === 1 && (await page.getByRole("button", { name: "写真・ファイルを選ぶ" }).count()) === 1);
  check("パソコンの「カメラで撮影」は出さない", (await page.getByRole("button", { name: "カメラで撮影" }).count()) === 0);
  check("入力欄の文字は 16px (iPhone が押したときに拡大しない)", (await page.locator("main select.field").first().evaluate((el) => getComputedStyle(el).fontSize)) === "16px");

  // 撮影する = 端末のカメラ (capture あり)
  let [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "撮影する" }).click()]);
  check("「撮影する」は端末のカメラを開く (capture)", (await chooser.element().getAttribute("capture")) === "environment");
  await chooser.setFiles(PHOTO);
  check("撮った写真が取込の欄に入る", (await page.getByRole("img", { name: "取り込む画像のプレビュー" }).count()) === 1);
  await page.getByRole("button", { name: "取り消す" }).click();
  // 写真・ファイルを選ぶ = アルバム・PDF (capture なし)
  [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "写真・ファイルを選ぶ" }).click()]);
  const el = chooser.element();
  check("「写真・ファイルを選ぶ」は撮影済みの写真・PDF を選べる (capture なし)", (await el.getAttribute("capture")) === null && (await el.getAttribute("accept")).includes("application/pdf"));
  await chooser.setFiles(PHOTO);
  const t0 = Date.now();
  await submitCapture(page);
  check(`写真 (12 MP) を縮小して送り、確認の画面に進む (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`, new URL(page.url()).searchParams.has("doc"));
  const card = page.getByRole("group", { name: "1 行目" }).first();
  check("確認の画面の明細は 1 行ずつのカード (見出しの行なし)", !(await page.locator("text=規格・仕様").first().isVisible()) || (await card.getByText("単価").count()) > 0);
  const priceBox = await card.getByRole("textbox", { name: "単価" }).boundingBox();
  const amountBox = await card.getByRole("textbox", { name: "金額" }).boundingBox();
  check("単価・金額の欄が画面の中にある (横にスワイプしない)", priceBox && amountBox && priceBox.x + priceBox.width <= 390 && amountBox.x + amountBox.width <= 390, JSON.stringify({ priceBox, amountBox }));
  let l = await layout(page);
  check("確認の画面は横にはみ出さない", !l.scroll && l.outside.length === 0, JSON.stringify(l));
  await page.screenshot({ path: path.join(SHOTS, "sp-1-review.png"), fullPage: true });

  await Promise.all([page.waitForURL(/\/quotes\/new/), page.getByRole("button", { name: /見積を作成/ }).first().click()]);
  await page.waitForLoadState("networkidle");
  const q1 = page.getByRole("group", { name: "明細 1 行目" });
  const qPrice = await q1.getByRole("spinbutton", { name: "単価" }).boundingBox();
  check("見積の作成: 明細はカードで、単価の欄が画面の中にある", qPrice && qPrice.x + qPrice.width <= 390, JSON.stringify(qPrice));
  l = await layout(page);
  check("見積の作成は横にはみ出さない", !l.scroll && l.outside.length === 0, JSON.stringify(l));
  await q1.getByRole("spinbutton", { name: "数量" }).fill("2");
  await q1.getByRole("spinbutton", { name: "単価" }).fill("12000");
  check("数量 × 単価で金額が変わる", (await q1.innerText()).includes("¥24,000"));
  await page.screenshot({ path: path.join(SHOTS, "sp-2-quote.png"), fullPage: true });
  await page.locator("select[name=customerId]").selectOption({ index: 1 });
  await Promise.all([page.waitForURL(/\/quotes\/(?!new)/), page.getByRole("button", { name: "下書き保存" }).click()]);
  check("スマートフォンから見積を下書き保存できる", !page.url().includes("err=") && !page.url().includes("/new"), page.url());

  // 受付のメモ (撮影済みの写真を選ぶ)
  await page.goto(`${BASE}/inquiries/reception`, { waitUntil: "networkidle" });
  [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "写真・ファイルを選ぶ" }).click()]);
  await chooser.setFiles(PHOTO);
  await submitCapture(page);
  check("受付のメモを取り込んで確認の画面に進む", /\/inquiries\/reception\/./.test(new URL(page.url()).pathname), page.url());
  l = await layout(page);
  check("受付の確認の画面は横にはみ出さない", !l.scroll && l.outside.length === 0, JSON.stringify(l));
  await ctx.close();
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed   (画面の写し: ${SHOTS})`);
fs.rmSync(path.join(WORK, "document.mjpeg"), { force: true });
process.exit(failed ? 1 : 0);
