import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Server Action で受け取れる大きさ (既定 1 MB)。書類取込の画像・PDF と CSV の取込用。
    // Vercel の 1 回の送信の上限 (4.5 MB) に合わせる。写真は画面側で縮小してから送る
    serverActions: { bodySizeLimit: "4.5mb" },
  },
  // 帳票 PDF (見積書・請求書・領収書) の日本語フォント。API (src/app/api/pdf) の関数に同梱する
  outputFileTracingIncludes: {
    "/api/pdf/**": ["./src/assets/fonts/NotoSansJP-Regular.ttf", "./src/assets/fonts/NotoSansJP-Bold.ttf"],
  },
  // 社内業務システム: 全ページが認証付きの動的レンダリングのため Cache Components は使用しない
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
