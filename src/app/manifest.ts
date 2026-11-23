import type { MetadataRoute } from "next";

/**
 * Web アプリマニフェスト (/manifest.webmanifest)。スマートフォンのホーム画面に追加すると、
 * アドレスバーのないアプリの画面で開く (Android は Chrome の「アプリをインストール」/「ホーム画面に追加」、
 * iPhone は Safari の「共有 → ホーム画面に追加」)。
 *
 * - ログイン前でも読めるよう、proxy.ts の matcher から manifest.webmanifest と icons/ を除外している
 * - アイコンは public/icons (scripts/dev/make-app-icons.mjs で一畳屋のマークから作る)。iPhone は src/app/apple-icon.png
 * - 色は globals.css のトークンと合わせる (theme = ヘッダーの白 / background = ページの背景)
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "一畳屋 統合業務システム",
    short_name: "一畳屋",
    description: "株式会社一畳屋 社内の業務システム (顧客・問い合わせ・見積・受注・施工・請求・承認)",
    lang: "ja",
    dir: "ltr",
    // ログインの画面から開く: ログイン済みならそのまま / (ダッシュボード) へ移り、未ログインならログインの欄が出る
    // (/ のままだと、未ログインのときは公開ホーム /home に回される)
    start_url: "/login",
    scope: "/",
    display: "standalone",
    theme_color: "#ffffff",
    background_color: "#f3f5fb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
