import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 使っているソフトの名前を応答に出さない
  poweredByHeader: false,
  // 開発中の表示 (左下の N) は、左下のチャットボットのボタンと重なるので出さない
  devIndicators: false,
  // セキュリティのヘッダー (nginx を通さず IP アドレス:3000 で直接開いたときにも付ける。HSTS は HTTPS の nginx が付ける)
  // マイクは自分のサイトだけ許可する (「質問する」の音声入力)
  async headers() {
    return [
      // プッシュ通知のサービスワーカー: 古い版を使い続けないよう毎回確かめる
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
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
