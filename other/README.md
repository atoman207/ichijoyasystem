# other — 実行に不要な資料・作業物

アプリの起動・ビルドに直接使わないものをここにまとめています。

| 内容 | 説明 |
|------|------|
| `docs/` | 設計メモ |
| `phase1/` / `phase2/` | 納品物 (PDF・設計書など) |
| `scripts-phase1/` / `scripts-phase2/` | 納品物の生成スクリプト |
| `.smoke-shots/` | ブラウザ疎通テストのスクリーンショット |
| `*.deb` | インストーラー |

実行に必要なものはリポジトリ直下のままです (`src/`・`public/`・`scripts/import`・`scripts/chatbot`・`deploy/`・`supabase/` など)。

クライアントから受け取った資料 (以前の `client-materials/` と、ここに置いていた参考 PDF) は、2026-11-21 にリポジトリ直下の `source/` へ業務の分野ごとに整理して移しました (`source/README.md`)。
