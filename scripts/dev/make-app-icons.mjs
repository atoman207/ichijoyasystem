// ============================================================
// ホーム画面のアイコン (public/icons/*.png) を一畳屋のマークから作り直す
//
//   node scripts/dev/make-app-icons.mjs
//
// マークの図形は src/components/brand/Logo.tsx の IchijoyaMark と同じ (黒 + 赤のアクセント、白い背景)。
// - icon-<大きさ>.png: そのまま表示するアイコン (purpose = any)
// - icon-maskable-<大きさ>.png: Android が丸・角丸などに切り抜くアイコン (purpose = maskable)。
//   切り抜かれても欠けないよう、マークを中央の円 (直径 80%) の内側に収める
// 読み込むのは src/app/manifest.ts。iPhone のアイコンは src/app/apple-icon.png (180×180)。
// sharp は Next.js と一緒に入っているもの (package.json には書いていない) を使う。
// ============================================================
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../public/icons");

const INK = "#000000";
const ACCENT = "#a72126"; // LOGO_ACCENT
const MARK_W = 112.03;
const MARK_H = 82.16;
const MARK_PATHS = [
  [INK, "M10.58,47.25C7,45,3.39,42.92,0,41.08,18.67,30.94,42.18,13.69,56,0c2.51,2.49,5.35,5.1,8.41,7.76C50.44,20.28,27.65,37,10.58,47.25Z"],
  [ACCENT, "M56,59.75c-3.22-2.49-6.58-5-10-7.56,13-9.62,27.8-20.43,38.9-28.34,3.65,2.61,7.36,5.16,11,7.56C84.05,39,68.87,49.79,56,59.75Z"],
  [INK, "M69.2,70.38c-2.58-2.19-5.44-4.52-8.48-6.94a417.47,417.47,0,0,1,40.73-28.53c3.63,2.25,7.19,4.32,10.58,6.17A291.89,291.89,0,0,0,69.2,70.38Z"],
  [INK, "M79.51,19.87c-3.57-2.67-7-5.39-10.31-8.09C57.59,21.61,40.38,34.47,25.53,44.52h0c-3.3,2.24-6.49,4.33-9.47,6.23,3.68,2.4,7.39,4.94,11,7.56A250,250,0,0,1,56,82.16c2.51-2.49,5.35-5.1,8.41-7.76C56.8,67.57,46.55,59.49,36,51.9,50.24,41.65,67.38,29,79.51,19.87Z"],
];

/** 正方形の size px に、マークを幅 widthRatio で中央に置いた SVG */
function iconSvg(size, widthRatio) {
  const scale = (size * widthRatio) / MARK_W;
  const x = (size - MARK_W * scale) / 2;
  const y = (size - MARK_H * scale) / 2;
  const paths = MARK_PATHS.map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(5)})">${paths}</g></svg>`;
}

mkdirSync(OUT, { recursive: true });
const jobs = [
  // そのまま表示: apple-icon.png と同じくらいの余白 (マークの幅 68%)
  ["icon-192.png", 192, 0.68],
  ["icon-512.png", 512, 0.68],
  // 切り抜き用: 幅 58% なら、マークの四隅も中央の円 (直径 80%) の内側に入る
  ["icon-maskable-192.png", 192, 0.58],
  ["icon-maskable-512.png", 512, 0.58],
];
for (const [name, size, ratio] of jobs) {
  await sharp(Buffer.from(iconSvg(size, ratio))).png({ compressionLevel: 9 }).toFile(join(OUT, name));
  console.log(`public/icons/${name} (${size}×${size})`);
}
