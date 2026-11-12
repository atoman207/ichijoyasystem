# Supabase のセットアップ

テーブルの作成と移行データ (59,462 行) の登録は、次のどれかで行います。**SQL Editor は 1 回に約 1 MB までしか実行できない** (超えると `Query is too large to be run via the SQL Editor`) ため、使う方法によって SQL ファイルが違います。

| 方法 | 使うファイル | 必要なもの |
| --- | --- | --- |
| A. SQL Editor (ブラウザだけで完結) | `supabase/data/*.sql` (40 ファイル・各 900 KB 以下) | Supabase ダッシュボードへのログイン |
| B. 1 ファイルで実行 (おすすめ) | `supabase/ichijoya.sql` (1 ファイル・約 31 MB) | データベースのパスワード (psql は不要) |
| C. スクリプト | テーブル定義の SQL + `load-to-supabase.mjs` | `.env.local` の `SUPABASE_SECRET_KEY` |

どの方法も、**実行するとデータベースの既存の行 (アプリで登録したデータを含む) はすべて移行データに置き換わります**。何度実行しても同じ状態になります。

SQL ファイルは移行データ (`data/import/client-data.json`) から作ります。**お客様の個人情報を含むため、リポジトリには入れません** (.gitignore で除外)。受け渡しは社内の安全な方法で行い、作業後は削除してください。

## A. SQL Editor で実行する (分割版)

```bash
node scripts/import/generate-data-sql.mjs --split   # → supabase/data/*.sql
```

Supabase ダッシュボード → SQL Editor → New query で、次の順に **1 ファイルずつ** 内容を貼り付けて Run します。

| 順 | ファイル | 内容 |
| --- | --- | --- |
| 1 | `00_start.sql` | テーブル定義 (24 テーブル。既存のテーブルは消さない) + 全テーブルの行の削除 |
| 2 | `01_data.sql` 〜 `38_data.sql` | 移行データの登録 (1 ファイル 1〜2 秒) |
| 3 | `99_finish.sql` | メタ情報の更新 + 件数の確認 (`ok` 列がすべて `true` なら完了) |

- 各ファイルは 1 つのトランザクションです。途中でエラーになったら、そのファイルから実行し直せます (失敗したファイルは何も登録されません)
- 最初からやり直すときは `00_start.sql` から実行します
- 1 ファイルの大きさは `--max-kb` で変えられます (既定 900。SQL Editor の上限 1003 まで)

## B. 1 ファイルで実行する (ichijoya.sql)

```bash
node scripts/import/generate-data-sql.mjs   # → supabase/ichijoya.sql (約 31 MB)

# どちらかで実行
SUPABASE_DB_PASSWORD='<データベースのパスワード>' node scripts/import/setup-database.mjs   # psql 不要 (15 秒前後)
psql "<Supabase の接続文字列>" -v ON_ERROR_STOP=1 -f supabase/ichijoya.sql
```

中身は上から、テーブル定義 → データの入れ替え (1 つのトランザクション。途中で失敗すると何も変わらない) → 件数の確認です。最後に表示される `ok` 列がすべて `true` なら完了です。

`setup-database.mjs` について:

- 接続先は `.env.local` の `NEXT_PUBLIC_SUPABASE_URL` から判定し、直接接続 → 接続プーラー (各リージョン) の順に試します。接続文字列がわかっているときは `SUPABASE_DB_URL` を使います
- すでにデータが入っているデータベースでは、置き換えてよいことを確かめるため `--yes` が必要です (`node scripts/import/setup-database.mjs --yes`)
- テーブル定義だけを実行するときは、ファイルを指定します (`node scripts/import/setup-database.mjs supabase/migrations/20261112000000_initial_schema.sql`)
- パスワードに `#` `%` などの記号があるとき: `.env.local` やシェルでは値を `'...'` で囲みます。psql の接続文字列 (URL) に入れるときは URL エンコードします (`#` → `%23`、`%` → `%25`)
- 実行中のアプリは数秒以内にデータの入れ替えを検知して、全データを読み直します (再起動は不要)

psql の接続文字列は Supabase の Connect → Session pooler。

## C. スクリプトで登録する

1. [`migrations/20261112000000_initial_schema.sql`](migrations/20261112000000_initial_schema.sql) (テーブル定義だけ・約 40 KB・リポジトリに含まれる) を SQL Editor で実行します
2. `node scripts/import/load-to-supabase.mjs --yes` (`.env.local` の `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` を使用。データベースのパスワードは不要)

## アプリを接続する

`.env.local` (ローカル) または Vercel の Environment Variables に、`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` を設定します (`SESSION_SECRET` も推奨)。接続できたかどうかは `/api/health` で確認できます (`"db":"ok"`)。

- アプリはサーバーの起動時に全データ (約 6 万行) を読み込み、その後は 2 秒ごとに更新の有無だけを確かめます。Vercel では、関数のリージョン (Project Settings → Functions → Function Region) を Supabase のプロジェクトと同じ地域にすると、起動と書き込みが速くなります
- テーブルには RLS を設定し、`anon` / `authenticated` (publishable キー) からは読み書きできません。アプリは secret キー (`service_role`) でだけアクセスします

## テーブル定義を変えたとき

1. `src/lib/db/schema.ts` を編集します
2. `node scripts/import/generate-schema.mjs` (テーブル定義だけの SQL) と `node scripts/import/generate-data-sql.mjs` (ichijoya.sql。分割版は `--split`) で作り直します
3. 本番で使っているデータを残したまま列を足すときは、テーブル定義だけの SQL を実行します (ichijoya.sql と分割版はデータを置き換えるため)

追加した列は既存のテーブルにも追加されます。列の削除・型の変更・既存の列への制約の追加は自動では行わないため、移行用の SQL を別に書いてください。
