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
- `npm run dev` (開発用。**3001 番**) / `npm run build` / `npm start`
- 本番は同じ VPS の **3000 番** (systemd `ichijoya`、`/srv/ichijoya/current`、https://ichijoya-system.jp)。作業中の変更は 3001 番で確認し、コミットしてから `npm run deploy` で本番に出す (deploy/README.md)。3001 番も本番のデータベースを使う
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
- AI の呼び出しは必ず `src/lib/ai/provider.ts` (generateJson / generateText) を通す。OpenAI (`OPENAI_API_KEY`) と Claude (`ANTHROPIC_API_KEY`) をキーの形で自動判定する。JSON Schema は全項目 required・additionalProperties: false、null を許す項目 (anyOf) は 1 回の依頼で 16 個まで (Claude の上限)。Vercel の 60 秒に収めるため、AI を呼ぶ画面は `export const maxDuration = 60`
- 案件の状態は `src/lib/case-status.ts` に集約 (進捗・見積と仕様・工事日程・請求・入金・事務処理を分けて持ち、多くは記録から自動で決める。人が決めるのは Quote.specStatus / Order.specStatus・scheduleStatus・billing・plannedPayment・closedAt と Payment.settledOn)。手書き見積書の備考欄以下は `SiteInfo` (`src/lib/site-info.ts`) として見積 → 受注へ引き継ぎ、予定表の施工のメモにも書く。税込の見積 (Quote.taxIncluded) の合計は `src/lib/quote-calc.ts`
- 顧客の新規登録は `canCreateCustomer` (初期設定は事務担当・本部・管理者。設定 → 運用)
- 承認の判断は 承認 (approved)・差戻し (returned: 修正して再申請)・却下 (rejected) の 3 つ (`src/lib/actions/approvals.ts` の `applyDecision`)。基準額と顧客の重要情報の承認は `src/lib/approval-rules.ts` の `approvalSettings(db)` (設定 → 承認ルール。`APPROVAL_RULES` は既定値)。変更の申請 (`order_change`・`customer_change`) は内容を `Approval.changes` に持ち、承認時に変更前の値が変わっていないか確かめてから反映する。承認依頼を作ったら保存の後に `notifyNewApprovals` を呼ぶ
- 外部への送信 (メール・LINE・Chatwork) は `src/lib/notify/` だけで行う。業務の記録を保存した後に `sendAndRecord` (送信 → 送信履歴 `deliveries`)。設定 (環境変数) がなければ送らずに status = skipped。受信は `/api/integrations/*` (proxy.ts の matcher から除外し、署名・共有鍵を各ルートで確認)。お客様に送る PDF のリンクは `src/lib/notify/doc-link.ts` の署名つき URL (`/api/doc/*`)
- LINE のグループ (現場ごと) は `src/lib/line-groups.ts` (settings の id = `line_groups`。join で登録 → 受注・協力業者にひも付け。ひも付け前のメッセージは pending に保留)。写真・ファイルは Webhook の応答のあと (`after`) に `src/lib/notify/line-api.ts` が取得して添付ファイルに保存する。接続の確認と Webhook URL の設定は 設定 → 外部連携・AI (`src/lib/actions/line-groups.ts`)。Chatwork の Webhook はルームごとのため `CHATWORK_WEBHOOK_TOKEN` はカンマ区切りで複数
- 現金の入出金は `src/lib/cashbook.ts` の `postCash` で現金出納帳に記帳する (現金の入金・現金の経費の精算・仕入の現金払い。元の記録 1 件につき 1 行)。会計データの仕訳は `src/lib/accounting.ts`
- 変更履歴の項目名・値の表示は `src/lib/field-labels.ts`。update の監査ログには `changes` (変更前・変更後) を必ず付ける。履歴の閲覧範囲は `canViewAuditEntry`
- KPI・インセンティブのルールは `src/lib/kpi-settings.ts` (既定値) と `src/lib/incentive.ts`。既定値はクライアントの「お客様アンケート集計表」KPI シートの評価方法に合わせている (① は全社、② は営業担当、③ は担当職人、④・返信率・クレーム率は店舗)
- 経営ダッシュボードの集計は `src/lib/management.ts` (期間 `resolvePeriod`・`managementReport`・CSV `mgmtCsvRows`)。画面 `/reports` と CSV `/api/reports` は同じ関数を使う。店舗のロールは自店舗に固定
- 社内資料 (ナレッジ) は `knowledge` テーブル。検索は `src/lib/knowledge.ts` (2 文字の組 + IDF)、スプレッドシートの同期は `src/lib/knowledge-sync.ts` (画面のボタンと `/api/cron/knowledge-sync`)。AI アシスタントは `src/lib/ai/search.ts` (顧客・案件の検索) と社内資料を system に入れる。要約は `src/lib/ai/summary.ts`、文書の作成は `src/lib/ai/draft.ts`。どれも AI のキーがないときはルール・定型文で答える
- 既存の AI システムからの受付は `src/lib/ai-intake.ts` (`normalizeIntake` で項目名の違いを吸収 → `recordAiIntake`)。入口は `ai_chat` / `ai_voice` / `ai_phone`。引き継ぎは問い合わせにひも付く業務依頼 (`createHandoffTask`)
- 本番サーバー (Xserver VPS) の手順とスクリプトは `deploy/` (`setup-server.sh`・`deploy.sh`・`backup.sh`)。`scripts/ops/` に本番の確認とファイルのバックアップ。本番運用の準備の自動確認は `src/lib/golive.ts`
