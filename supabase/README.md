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
npm run db:setup              # ichijoya.sql を作り直して、そのまま Supabase で実行 (生成 → 実行 → 件数の確認)
npm run db:setup -- --yes     # すでにデータが入っているデータベースを置き換えるとき

# 個別に行うとき
npm run db:sql                # → supabase/ichijoya.sql (約 31 MB。移行データ + デモ用アカウント 15 名)
SUPABASE_DB_PASSWORD='<データベースのパスワード>' node scripts/import/setup-database.mjs   # psql 不要 (15 秒前後)
psql "<Supabase の接続文字列>" -v ON_ERROR_STOP=1 -f supabase/ichijoya.sql
```

中身は上から、テーブル定義 → データの入れ替え (1 つのトランザクション。途中で失敗すると何も変わらない) → 件数の確認です。最後に表示される `ok` 列がすべて `true` なら完了です。

`npm run db:setup` / `db:sql` は移行データ (`client-data.json`) から作り直すため、運用開始後にアプリで登録したデータ・変更履歴は消えます。**現在の Supabase のデータのまま** ichijoya.sql を作り直して実行する (テーブル定義の追加だけを反映する) ときは、次の順にします。

```bash
node scripts/import/dump-supabase.mjs                                         # 現在のデータを書き出す (読み取りだけ) → data/import/supabase-current.json
node scripts/import/generate-data-sql.mjs data/import/supabase-current.json --no-demo   # → supabase/ichijoya.sql (デモ用アカウントは現在の状態のまま)
node scripts/import/setup-database.mjs --yes                                  # 実行 (書き出しから実行までの間に登録されたデータは残らないため、続けて行う)
```

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

## デモ用アカウント (架空の 15 名・パスワード demo1234)

ローカルのサンプルデータと同じ 15 名 (`src/lib/db/master.ts` の `USERS`。ログイン ID は `<名前>@ichijoya.example`) を、本番データベースの `users` にも登録します。A・B・C の方法でデータを入れ直すときは自動で含まれます (含めないときは `generate-data-sql.mjs` / `load-to-supabase.mjs` に `--no-demo`)。データを残したまま追加・戻すときは次を使います。

```bash
node scripts/import/seed-demo-accounts.mjs          # 登録 (既にあれば更新。パスワードを demo1234 に戻し、有効にする)
node scripts/import/seed-demo-accounts.mjs --off    # 無効にする (ログインできなくなる。登録した案件・履歴は残る)
```

SQL で登録するときは `supabase/ichijoya.sql` を使います (デモ用アカウントを含みます。別の SQL ファイルはありません)。

- `.env.local` の `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` を使います。`users` のデモ用アカウント 15 行だけを書き換え、ほかのデータには触れません。実行中のアプリ (Vercel を含む) は再起動なしで反映します
- パスワードはハッシュだけを保存します (`users.password` 列は制約で空のみ)。役職の先頭に「【デモ用】」が付きます
- 承認先の判定では、デモ用アカウントの申請にはデモ用の店長、社員の申請には社員の店長だけを数えます。デモ用アカウントを加えても、社員の申請の承認先は変わりません
- 1 名だけ止めるときは、管理者で 設定 → ユーザーと権限 から無効にします

## 販売管理ソフトの売上明細を取り込む (常に最新にする)

販売管理ソフトから書き出した「売上明細」の CSV (Shift_JIS・全期間でよい) を取り込み、顧客は得意先コード、売上は伝票№で登録・更新します。売上台帳から移行した受注とは 売上日 (±3 日)・お客様の名前・金額 で照合してひも付け (重複して作らない)、ひも付いた台帳の顧客は得意先コードの顧客に統合します (電話番号・住所が付く)。

- **最新にするとき (普段):** 管理者・本部スタッフで データ入出力 → 「売上明細の取込」で CSV を選びます。取込済みの伝票と内容を比べ、追加・変更された伝票だけを反映します (何度選んでも同じ状態になる)。変更履歴に「取込」として残ります
- **最初の一括取込・まとめて入れ直すとき:** `node scripts/import/import-sales-csv.mjs "<CSV>"` で件数を確かめ (書き込まない)、`--yes` を付けて書き込みます。`.env.local` の `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` を使い、変わった行だけを書き込みます。`--json=<ファイル>` で JSON のデータに対して試算もできます
- 金額: 2021-02 までの伝票と、2021-03 以降の法人向け (建設・不動産・官公庁など) の多くは税抜のため、売上日の税率で税込に換算します (売上台帳と照合して判定。照合できない伝票は同じ得意先・得意先区分の傾向で判定)。明細は税込・税抜の別とともに受注の経過メモに残ります
- 店舗: CSV に店舗の列がないため、照合できた受注から 得意先・担当者・住所の市区町村 ごとに学習して決めます。2018 年以前で担当者・地域から決められない伝票は「本社」になります
- 担当者: CSV の名前のない列 (担当者コードと氏名の組) を社員の氏名と照合し、2 番目を施工担当、3 番目を入力者にします。社員にいない担当者は経過メモに氏名だけを残します

## アプリを接続する

`.env.local` (ローカル) または Vercel の Environment Variables に、`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` を設定します (`SESSION_SECRET` も推奨)。接続できたかどうかは `/api/health` で確認できます (`"db":"ok"`)。

- アプリはサーバーの起動時に全データ (約 6 万行) を読み込み、その後は 2 秒ごとに更新の有無だけを確かめます。Vercel では、関数のリージョン (Project Settings → Functions → Function Region) を Supabase のプロジェクトと同じ地域にすると、起動と書き込みが速くなります
- テーブルには RLS を設定し、`anon` / `authenticated` (publishable キー) からは読み書きできません。アプリは secret キー (`service_role`) でだけアクセスします

## 資料・写真 (添付ファイル) を使うとき

資料・写真の台帳は `attachments` テーブル、ファイルの本体は Storage の非公開バケット `attachments` に保存します。

1. `attachments` テーブルは 2026-11-13 に作成済みです (テーブル定義の自動反映、または [`migrations/20261112000000_initial_schema.sql`](migrations/20261112000000_initial_schema.sql) の実行で作られます。既存のテーブル・データはそのまま)
2. バケットはアプリが最初の登録時に自動で作成します (非公開。`public` にはしない)
3. `/api/health` が `"schema":"ok"` を返せば完了です。テーブルがない間は `"schema":{"missing":["attachments"]}` を返し、資料・写真の登録だけが使えません (ほかの画面は動きます)

- ファイルを直接開ける URL はありません。画面からは `/api/attachments/<ID>` を開き、権限を確かめたあとに 2 分間有効な URL へ転送します
- 写真はブラウザで長辺 2048px の JPEG (1 枚 0.5〜1.5 MB 程度) に縮小してから保存します。PDF などは 1 ファイル 4 MB まで
- Storage の容量はプランによって異なります (無料プランは 1 GB)。写真の保存期間・移行の方針 (Phase 1 の決定事項 D9) に合わせてプランを確認してください

## テーブル定義を変えたとき (自動で反映)

1. `src/lib/db/schema.ts` を編集します
2. `npm run db:migrate` を実行します。テーブル定義の SQL (`migrations/20261112000000_initial_schema.sql`) を作り直し、Supabase に反映します (テーブル・列・索引の追加だけ。データは変えない。追加があれば起動中のアプリが読み直す)
3. デプロイ時も自動で反映します: `npm run build` の前の `prebuild` が同じ処理を行います (接続情報 `SUPABASE_DB_PASSWORD` / `SUPABASE_DB_URL` があるときだけ。`DATA_BACKEND=json` のビルドでは行わない)。Vercel で使うには Environment Variables に `SUPABASE_DB_PASSWORD` を設定します (直接接続は IPv6 のみのため、接続プーラーにつながります)
4. ichijoya.sql も作り直すときは `node scripts/import/generate-data-sql.mjs` (分割版は `--split`)。現在のデータを残すときは上の「現在の Supabase のデータのまま」の手順で作ります

追加した列は既存のテーブルにも追加されます。列の削除・型の変更・既存の列への制約の追加は自動では行わないため、移行用の SQL を別に書いてください。
