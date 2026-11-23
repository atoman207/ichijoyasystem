import type { Metadata, Viewport } from "next";
import "./globals.css";

// Vercel の関数の実行時間の上限 (秒)。サーバーの起動直後は全データ (約 6 万行) の読み込みを待つため、既定 (10 秒の場合がある) より長くする
export const maxDuration = 60;

export const metadata: Metadata = {
  title: {
    default: "一畳屋 統合業務システム",
    template: "%s | 一畳屋 統合業務システム",
  },
  description:
    "株式会社一畳屋 社内情報基盤 - 顧客・問い合わせ・見積・受注・施工・請求・経費・承認を一元管理するデモシステム",
  // ホーム画面に追加したときの名前と開き方 (マニフェストは src/app/manifest.ts)。
  // 上端の帯 (時計・電池) は default = 白地に黒い文字で、ページはその下から始まる (black-translucent にすると
  // ヘッダーが時計の下に潜るので使わない)。iOS 16.4 より前はマニフェストを読まないため apple-mobile-web-app-capable も出す
  // (Next.js 16 の appleWebApp.capable は mobile-web-app-capable だけを出す)
  applicationName: "一畳屋",
  appleWebApp: { capable: true, title: "一畳屋", statusBarStyle: "default" },
  other: { "apple-mobile-web-app-capable": "yes" },
};

/** 画面の幅・拡大率は Next.js の既定 (width=device-width, initial-scale=1)。ホーム画面のアプリの上端の帯の色 = ヘッダーの白 */
export const viewport: Viewport = {
  themeColor: "#ffffff",
};

/** 本文: Noto Sans JP / 見出し (font-maru・font-serif): Noto Serif JP */
const FONT_URL =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&family=Noto+Serif+JP:wght@500;600;700&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={FONT_URL} rel="stylesheet" />
      </head>
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
