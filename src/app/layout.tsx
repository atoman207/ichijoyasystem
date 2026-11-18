import type { Metadata } from "next";
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
