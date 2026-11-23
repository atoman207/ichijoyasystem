/**
 * パソコンのカメラの選び方 (src/components/attachments/camera-pick.ts) のテスト
 *   node scripts/tests/capture/camera-pick.test.mjs
 * 内蔵カメラ・USB の Web カメラ・書画カメラ・スマートフォン (USB のウェブカメラ・スマートフォン連携・アプリ) の組み合わせで、
 * 前に選んだカメラ → スマートフォン・書画カメラ → 内蔵以外 → 既定 の順に選ぶことを確かめる
 */
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") } });
const { pickCamera, parseSavedCamera, isBuiltInCamera, isPreferredCamera } = await jiti.import(path.join(root, "src/components/attachments/camera-pick.ts"));

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fails.push(msg);
    console.log(`  ✗ ${msg}`);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (結果 ${JSON.stringify(a)})`}`);

const laptop = { id: "cam-int", label: "Integrated Camera (04f2:b6dd)" };
const mac = { id: "cam-mac", label: "FaceTime HD Camera" };
const pixel = { id: "cam-px", label: "Pixel 8 (18d1:4f00)" };
const androidUvc = { id: "cam-and", label: "Android Webcam" };
const phoneLink = { id: "cam-link", label: "Galaxy S23 カメラ" };
const camo = { id: "cam-camo", label: "Camo" };
const iphoneMac = { id: "cam-cont", label: "山田のiPhone のカメラ" };
const logi = { id: "cam-logi", label: "Logitech C920 HD Pro Webcam" };
const ipevo = { id: "cam-ipevo", label: "IPEVO V4K" };

console.log("\nカメラの名前の見分け");
ok(isBuiltInCamera(laptop.label) && isBuiltInCamera(mac.label), "内蔵カメラ (Integrated・FaceTime HD)");
ok(!isBuiltInCamera(logi.label) && !isBuiltInCamera(pixel.label), "USB の Web カメラ・スマートフォンは内蔵ではない");
ok([pixel, androidUvc, phoneLink, camo, iphoneMac, ipevo].every((c) => isPreferredCamera(c.label)), "スマートフォン (USB・連携・アプリ・連係カメラ) と書画カメラ");
ok(!isPreferredCamera(logi.label) && !isPreferredCamera(laptop.label), "普通の Web カメラ・内蔵カメラは優先の名前ではない");

console.log("\n選ぶ順番");
eq(pickCamera([laptop], undefined), { reason: "default" }, "内蔵カメラだけ → 既定");
eq(pickCamera([laptop, pixel], undefined), { id: "cam-px", reason: "preferred" }, "ノートパソコン + USB でつないだ Android → スマートフォン");
eq(pickCamera([mac, iphoneMac], undefined), { id: "cam-cont", reason: "preferred" }, "Mac + iPhone (連係カメラ) → iPhone");
eq(pickCamera([laptop, camo], undefined), { id: "cam-camo", reason: "preferred" }, "Windows + iPhone (Camo) → iPhone");
eq(pickCamera([laptop, logi], undefined), { id: "cam-logi", reason: "external" }, "ノートパソコン + USB の Web カメラ → 外付け");
eq(pickCamera([logi, ipevo], undefined), { id: "cam-ipevo", reason: "preferred" }, "Web カメラ + 書画カメラ → 書画カメラ");
eq(pickCamera([logi], undefined), { reason: "default" }, "デスクトップ + Web カメラ 1 台 → 既定 (そのカメラ)");
eq(pickCamera([laptop, pixel], { id: "cam-int", label: laptop.label }), { id: "cam-int", reason: "saved" }, "内蔵カメラを選んでいたら、スマートフォンがつながっていても内蔵カメラ");
eq(pickCamera([laptop, { id: "cam-px-2", label: pixel.label }], { id: "cam-px", label: pixel.label }), { id: "cam-px-2", reason: "saved-label" }, "USB をつなぎ直して ID が変わっても、名前で前のスマートフォンを選ぶ");
eq(pickCamera([laptop, logi], { id: "cam-px", label: pixel.label }), { id: "cam-logi", reason: "external" }, "前に選んだスマートフォンがないときは、ほかの外付け");
eq(pickCamera([{ id: "", label: "" }], { id: "cam-px", label: pixel.label }), { reason: "default" }, "カメラの使用の許可の前 (ID・名前が空) → 既定 (許可のあとで選び直す)");
eq(pickCamera([], undefined), { reason: "default" }, "カメラがない → 既定 (開くと「見つかりません」)");

console.log("\n覚えたカメラの読み込み");
eq(parseSavedCamera(JSON.stringify({ id: "a", label: "Pixel 8" })), { id: "a", label: "Pixel 8" }, "ID と名前");
eq(parseSavedCamera("legacy-device-id"), { id: "legacy-device-id" }, "以前の形式 (ID の文字だけ)");
eq(parseSavedCamera(null), undefined, "未保存");
eq(parseSavedCamera("{}"), undefined, "空のとき");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
