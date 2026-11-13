# CLAUDE.md — 一畳屋 統合業務システム

AI コーディング支援 (Claude Code 等) がこのリポジトリで作業するときの前提です。

## まず読むもの
- `README.md` — 起動方法・テストアカウント・画面一覧・ディレクトリ構成
- `supabase/README.md` — テーブル作成とデータ登録 (`ichijoya.sql` を `scripts/import/setup-database.mjs` / psql で実行、または分割版を SQL Editor で実行)
- (ローカルのみ・リポジトリ外) `docs/` の設計メモと `phase1/` の納品物 (要件定義書・設計書・画面一覧・権限設定一覧・次段階開発仕様書)

## 設計原則
1. 情報は一つの基盤に集約する。問い合わせ → 見積 → 受注・施工 → 売上 → 請求 → 入金 を ID で連結し、どの画面からも前後へ辿れるようにする
2. 業務ロジックは `src/lib/actions/*` (Server Actions) に置く。順序は `requireActionUser` → `assertStore` (店舗スコープ) → `mutate` → `addAudit` → `revalidatePath` → `redirect(withMsg(...))`
3. 金額・契約・支払いに関わる変更は `Approval` を経由する (`src/lib/actions/approvals.ts` の `applyDecision` に反映処理を集約)
4. 権限は `src/lib/auth/permissions.ts` の関数のみで判定する (ロール名を画面で直接比較しない)
5. 外部サービス (DB・ファイル・AI・送信) は境界 (`src/lib/db/store.ts`, `src/lib/storage.ts`, `src/lib/ai/*`) に閉じ込め、デモ (JSON・data/uploads / サンプル応答) と本番を同じインターフェイスで差し替える
6. UI は `src/components/ui` の部品を使い、淡いブルーの背景 + 白いカード・日本語ラベル・ステータスは色 + ラベルで表現する。チャートは `src/components/charts` の方針 (店舗色固定・凡例・ツールチップ・表表示)
7. 本文 (`src/app/(app)` 配下) の段組みは画面幅の `sm:` / `lg:` ではなくコンテナクエリ (`@xl:` 576px / `@3xl:` 768px / `@4xl:` 896px / `@5xl:` 1024px) で指定する。部品の置き場所 (カード・列) で使える幅が変わるため。グリッドは `grid-cols-1` を基本に書き、狭い画面ではみ出さないようにする。メニューはヘッダーのタブ (`src/components/layout/AppShell.tsx`、項目は `src/app/(app)/layout.tsx` の `nav`)。ロゴは `src/components/brand/Logo.tsx` を使う

## コマンド
- `npm run dev` / `npm run build` / `npm start`
- `npx tsc --noEmit` — 型チェック
- `npm run db:migrate` — テーブル定義 (schema.ts) を Supabase に反映 (追加だけ。データは変えない)。`npm run build` の前にも `prebuild` で自動実行 (接続情報があり、`DATA_BACKEND=json` でないとき)
- `npx eslint src` — Lint
- `npm run smoke` — Playwright によるブラウザ疎通テスト (要 `npx playwright install chromium`)
- `npm run db:sql` — `supabase/ichijoya.sql` (テーブル定義 + 移行データ + デモ用アカウント) を作り直す。`npm run db:setup` は作り直して Supabase で実行 (既存データの置き換えは `-- --yes`)

## 注意
- Next.js 16 (App Router)。`params` / `searchParams` / `cookies()` は Promise。`middleware` ではなく `src/proxy.ts`
- 本番データは Supabase。`.env.local` に `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SECRET_KEY` があれば Supabase、なければ (または `DATA_BACKEND=json`) `data/<DATA_FILE_NAME>` の JSON。テーブル定義の正本は `src/lib/db/schema.ts` (型 `types.ts` にフィールドを足したら schema.ts にも列を足し、`node scripts/import/generate-schema.mjs` で `supabase/migrations/20261112000000_initial_schema.sql` を、`node scripts/import/generate-data-sql.mjs` で `supabase/ichijoya.sql` (テーブル定義 + 全データの 1 ファイル。psql 用。コミットしない) を作り直す。SQL の組み立ては `scripts/import/schema-sql.mjs` に集約)。Supabase の SQL Editor は 1 回 0.98 MB まで (超えると "Query is too large to be run via the SQL Editor") なので、SQL Editor 用は `--split` の `supabase/data/*.sql` (各 900 KB 以下)
- 書き込みは必ず `await mutate(...)`。読み込みは `requireUser` / `requireActionUser` が `syncDb()` で最新化した後の `getDb()`。認証前に DB を読む画面 (ログイン・API) は `await syncDb()` を使う
- リポジトリは公開。`client-materials/` (共有資料)・`data/` (移行データ・初期パスワード・サンプル)・`supabase/ichijoya.sql`・`supabase/data/` (データの SQL)・`phase1/`・`docs/`・`scripts/import/extract-client-data.mjs` (社員名を含む) はコミットしない (.gitignore)。社員の実名・ログイン ID をコードに書かない。手順は supabase/README.md
- schema.ts を変えたら `npm run db:migrate` で Supabase に反映する (`.env.local` の `SUPABASE_DB_PASSWORD` を使う)。反映前の本番ではそのテーブルがない。読み込みは空として続行し (`supabase.ts` の `missingTables`)、`/api/health` が `schema.missing` で知らせる。その機能の書き込み前に `recheckMissingTables()` で確かめ、ない間は分かる言葉で断る
- 資料・写真は `src/lib/attachments.ts` (登録先・権限・保存)。閲覧・登録の権限は登録先の記録に従う。ファイルの URL は `/api/attachments/<ID>` だけ (権限を確かめてから Storage の期限つき URL へ転送)。Vercel の送信上限 4.5 MB のため、写真は `src/components/attachments/image-prep.ts` で縮小してから送る
- 権限の判定を変えたら `src/lib/auth/permission-table.ts` (設定画面の権限一覧) も直す
- `data/db.json` はローカル検証用のサンプルデータ (コミットしない)。初期化は 設定 → データ管理 (JSON のときのみ)、または削除して再起動
- デモ用アカウント (架空の 15 名 `<名前>@ichijoya.example` / `demo1234`、元は `master.ts` の `USERS`) は Supabase にも登録する: `node scripts/import/seed-demo-accounts.mjs` (`--off` で無効化)。`generate-data-sql.mjs` / `load-to-supabase.mjs` も既定で含める。判定は `permissions.ts` の `isDemoAccount` (承認先の判定でデモ用と社員を混ぜない)
- 店舗 ID は `koshi` / `chuo` / `nishi` / `tamana` / `hq` 固定。店舗名・住所は公開サイトの会社概要に基づく
- Claude API を呼ぶコードは `claude-opus-5-5` を既定とし、`betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"` を付ける
