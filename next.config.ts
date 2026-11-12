import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
