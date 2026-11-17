# 株式会社一畳屋 統合業務システム (デモ)

顧客・問い合わせ・見積・受注・施工・売上・請求・入金・経費・仕入・承認・社内連絡・変更履歴を
**一つの情報基盤** に集約する社内システムのデモ実装です。
株式会社一畳屋 (https://ichijoya.co.jp / 熊本の畳・襖・障子・網戸専門店, 4 店舗 + 本社ショールーム) の
構想メモ (「会社全体の情報革命」) をもとに、機能・画面・データ・権限・承認フローを具体化しています。

> **English summary** — Internal information-management system demo for Ichijoya Co., Ltd. (tatami / fusuma /
> shoji specialist in Kumamoto). Next.js 16 App Router + TypeScript + Tailwind v4. Data is stored in Supabase
> (PostgreSQL; setup SQL in `supabase/`), or in a local JSON file with fictional sample data for development.
> Role-based access (Administrator / Store Manager / Store Staff / HQ Staff), approval workflows, audit log,
> company-wide calendar, paper-to-data capture (sample OCR without a key; real AI reading when `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set),
> quotes with revisions and PDF output (quote / invoice / receipt), customer-survey postcards, claims/rework, Google reviews, KPIs and incentives,
> AI assistant, dashboards and reports. No client data is included in this repository.

## データベースと本番データ (Phase 1)

- 本番データは **Supabase (PostgreSQL)** に保存します。`.env.local` (コミットしない) に `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` を設定すると Supabase を使い、未設定ならローカルの JSON ファイル (`data/db.json`、サンプルデータ) を使います
- Supabase のデータは、Google ドライブで共有された業務資料から移行したものです (資料・移行データはリポジトリに含めません)。サンプルデータは入っていません
- データベースは、テーブル定義 + 移行データの SQL で起動できます (個人情報を含むためリポジトリには入れず、`node scripts/import/generate-data-sql.mjs` で作る)。1 ファイル版 (`supabase/ichijoya.sql`) は `node scripts/import/setup-database.mjs` (データベースのパスワードで接続。psql 不要) か psql で実行します。SQL Editor は 1 回に約 1 MB までなので、SQL Editor では分割版 (`--split` → `supabase/data/`) を使います。手順は [supabase/README.md](supabase/README.md)
- 設計資料 (要件定義書・業務フロー図・設計書・画面一覧など) は Phase 1 の納品物として別途お渡ししています (リポジトリには含めません)
- 本番データではログイン画面にテスト用アカウントは表示されません。社員ごとのログイン ID と初期パスワード (`data/import/initial-passwords.csv`、管理者へ直接手渡し) で入り、各自プロフィール画面で変更します
- 確認用に、下記「テスト用アカウント」の 15 名 (架空・パスワード `demo1234`) を本番データベースにもデモ用アカウントとして登録しています (`node scripts/import/seed-demo-accounts.mjs`。止めるときは `--off`)。ログイン画面で ID とパスワードを入力して入ります
- ログイン: セッションは 7 日で失効、パスワード変更で他端末のセッションも失効、同じ ID で 10 回失敗すると 15 分ロック。ロール・所属は管理者が 設定 → ユーザーと権限 で変更

| 環境変数 | 内容 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Supabase の接続先と secret キー (サーバー側のみで使用) |
| `SESSION_SECRET` | ログイン状態の署名鍵 (推奨。未設定なら `SUPABASE_SECRET_KEY` から導出。変更すると全員再ログイン) |
| `OPENAI_API_KEY` または `ANTHROPIC_API_KEY` | 任意。どちらか 1 つ。書類の AI 読取 (手書き見積・図面・施工資料・請求書・レシート・アンケートはがき)・お客様の声の分析・AI アシスタントを動かす。キーの形 (sk-ant- / sk-) で接続先を自動判定。本番は Vercel の Environment Variables にも設定して再デプロイ |
| `DATA_BACKEND=json` + `DATA_FILE_NAME` | ローカル検証用。Supabase を使わず `data/<DATA_FILE_NAME>` を使う (例: `import/client-data.json` のコピーで本番データを手元確認) |

## クイックスタート (ローカル・サンプルデータ)

```bash
npm install
DATA_BACKEND=json npm run dev
# http://localhost:3000 を開く (未ログイン時は /login にリダイレクト)
```

初回アクセス時に `data/db.json` へサンプルデータが自動生成されます (ローカル検証用)。
データを初期状態に戻すには、管理者でログイン → 設定 → データ管理 → 「サンプルデータを初期化する」
(または `data/db.json` を削除して再起動)。Supabase に接続しているときは初期化できません。

## テスト用アカウント (デモ用アカウント)

パスワードはすべて `demo1234` です。

- ローカルのサンプルデータ: ログイン画面でロール (管理者 / 店長 / 店舗スタッフ / 本部スタッフ) と店舗を選ぶと、メールアドレスとパスワードが自動入力されます
- 本番データ (Supabase): 同じ 15 名をデモ用アカウントとして登録しています。ログイン画面には表示されないので、ログイン ID (メールアドレス) とパスワードを入力します。
  権限の範囲は社員と同じで、店長・店舗スタッフは自店舗の顧客・案件、管理者・本部スタッフは全店舗を見られます。役職の先頭に「【デモ用】」が付きます。
  登録・パスワードの初期化は `node scripts/import/seed-demo-accounts.mjs`、停止は `--off` (手順は [supabase/README.md](supabase/README.md) の「デモ用アカウント」)

| ロール | 氏名 | 所属 | メール |
| --- | --- | --- | --- |
| 管理者 | 山田 太郎 | 本社 (代表取締役) | yamada@ichijoya.example |
| 店長 | 田中 健一 | 合志店 | tanaka@ichijoya.example |
| 店長 | 佐藤 美咲 | 中央店 | sato@ichijoya.example |
| 店長 | 鈴木 大輔 | 西店 | suzuki@ichijoya.example |
| 店長 | 高橋 直樹 | 玉名店 | takahashi@ichijoya.example |
| 店舗スタッフ | 中村 花子 (営業・受付) / 小林 翔太 (施工) | 合志店 | nakamura@ / kobayashi@ichijoya.example |
| 店舗スタッフ | 加藤 由美 / 渡辺 拓也 | 中央店 | kato@ / watanabe@ichijoya.example |
| 店舗スタッフ | 伊藤 さくら / 松本 隆 | 西店 | ito@ / matsumoto@ichijoya.example |
| 店舗スタッフ | 木村 彩 / 林 大地 | 玉名店 | kimura@ / hayashi@ichijoya.example |
| 本部スタッフ | 山本 恵 (経理) / 井上 誠 (総務) | 本社 | yamamoto@ / inoue@ichijoya.example |

※ 店舗名は会社概要 (合志店・中央店・西店・玉名店・坪井ショールーム) に基づき、人物はすべて架空です。

## おすすめの試し方 (10 分)

1. **店舗スタッフ (中村 花子)** でログイン → ダッシュボードの「AI電話受付」の問い合わせを開く →
   「顧客として登録する」→ 見積を作成し「承認を申請」
2. **店長 (田中 健一)** でログイン → 通知ベル / 承認画面から見積を承認 → 見積詳細で「送付を記録」→
   「受注登録 (契約承認を申請)」→ 承認 → 受注・施工で施工予定を設定
3. **本部スタッフ (山本 恵)** でログイン → 施工完了済みの受注から請求書を発行 → 入金を登録 →
   仕入・買掛で「請求書を撮影・取込」→ 仕入請求書として登録
4. **管理者 (山田 太郎)** でログイン → 介護施設案件 (¥50 万以上) の見積を承認 → レポート・分析 →
   変更履歴で「誰が・いつ・何を」変更したか確認 → 設定で承認ルール・連携状況を確認
5. **書類取込** でレシート / 手書き見積のサンプルを読み取り → 経費 / 見積として登録
6. **AI アシスタント** に「今月の売上は？」「未入金の請求は？」「田中様の履歴」などを質問

## 主な画面

| 画面 | URL | 内容 |
| --- | --- | --- |
| ダッシュボード | `/` | ロール別 KPI、月次売上 (店舗別)、本日の予定、承認待ち、未対応問い合わせ、進行中施工、最近の更新 |
| 顧客 | `/customers` | 顧客 360° (基本情報・案件の流れ・外部とのやりとり履歴・予定・資料と写真)。登録時に既存顧客 (全店舗) との重複確認 |
| 問い合わせ | `/inquiries` | 電話 / AI 電話受付 / AI テキスト相談 / AI 音声相談 / Web / メール / LINE / 来店・対面 / 郵送 / 紹介 などの入口を一元管理。受付日時の指定、既存顧客の候補と紐づけ、他店舗へ回す、資料・写真の添付。AI システムからの受付は会話の記録つき。担当者への引き継ぎ (業務依頼) |
| 見積 | `/quotes` | 商品マスタからの明細作成、承認フロー、確定後の金額変更申請、送付記録、印刷用書式 |
| 受注・施工 | `/orders` | 契約承認 → 施工予定 (予定表連動) → 進捗記録 → 施工完了 (売上計上) → 請求書発行。現場写真・資料 (カメラ・アルバムから複数枚)、案件情報・担当店舗の変更、現場情報・引継ぎ事項、案件の状態 (工事完了・売上計上・請求完了・入金完了・全処理完了)、納品時の集金、クレーム・手直し |
| 案件の進捗 | `/cases` | 問い合わせ〜全処理完了を 1 つの一覧で。案件進捗・見積と仕様・工事日程・請求・入金を分けて絞り込み (TEL待ち・請求書未発行・未入金・決済入金待ち など) |
| KPI | `/kpi` | お客様アンケート (はがきの AI 読取)・お客様の声・クレーム・手直し・Google 口コミ・年間インセンティブ |
| 予定表 | `/schedule` | 週表示、店舗・担当者フィルタ、受注の施工予定を自動反映 |
| 請求・入金 | `/invoices` | 売掛残高、期日超過、顧客別の請求状況、入金予定 (入金予定日・金額)、入金登録 (現金/振込/カード/PayPay)、督促記録、見積書・請求書のメール (PDF 添付)・LINE (PDF のリンク) 送信、印刷用書式 |
| 入出金の予定 | `/finance` | 未入金 (入金予定日・支払期限の順)、決済会社からの入金待ち、支払待ち・支払依頼中 (仕入・経費の精算) |
| 経費精算 | `/expenses` | レシート撮影 → AI 読取 (勘定科目の候補つき) → 承認 → 精算 (現金は現金出納帳に記帳)。手入力でも勘定科目の候補 (ルール・AI)、下書き・差戻しの修正と再申請 |
| 現金出納帳 | `/cashbook` | 店舗ごとの手元現金の入出金と残高 (繰越・月別・科目別の集計)。現金の入金・経費の精算・仕入の現金払いは自動で記帳 |
| 仕入・買掛 | `/purchases` | 仕入請求書 (仕入内容の明細・案件) の登録 → 支払依頼 (管理者の承認) → 支払待ち → 支払完了 (支払日・方法)。仕入先別の買掛金、支払予定 (店長は自店舗) |
| 仕入先・協力業者 | `/suppliers` | 取引先の台帳 (支払条件から支払期限を自動計算・振込先・登録番号・LINE / Chatwork)、仕入請求書とやりとりの記録 |
| 会計データの出力 | `/accounting` | 期間・店舗を指定して仕訳 (汎用 CSV・弥生会計のインポート形式) と明細 (売上・入金・経費・仕入・現金出納) を CSV で出力。科目名・税区分の設定 (本部・管理者) |
| 書類取込 | `/capture` | 紙 → データ (手書き見積書 (備考欄以下まで) / 図面 / 施工資料 / 仕入請求書 / レシート / アンケートはがき)。AI が自信のない項目は黄色で示し、確認のチェックが済むまで登録しない。元の画像・PDF を保存。手書き見積書の読取の正確さ (担当者の修正との一致率) を表示 |
| 承認 | `/approvals` | あなたの承認待ち / 申請中 / 全体 / 履歴 (種類・判断・申請者・判断者・期間で絞り込み、CSV)。判断は承認・差戻し・却下。見積の金額変更、契約内容の変更、顧客の重要情報の変更、経費、仕入の支払依頼 |
| 社内連絡・業務依頼 | `/messages` | 連絡・確認のスレッド、メンション通知、案件への紐づけ。業務依頼 (依頼先・期限 → 確認 → 報告 → 完了 / 差し戻し) |
| 連絡履歴 | `/contacts` | お客様・協力業者・仕入先との電話・メール・LINE・Chatwork・Web・対面のやりとりの記録と検索、案件への紐付け、メール・LINE・Chatwork での送信 |
| AI アシスタント | `/ai` | 質問・検索 (顧客名・番号・電話番号で顧客・案件を検索し、リンクつきで回答)、社内資料にもとづく回答、集計、文書の作成 (お客様向けの案内・日報・施工報告などの下書き)。各画面の「AI で要約」(見積・受注・経費・顧客・問い合わせ) |
| 社内資料 (ナレッジ) | `/knowledge` | AI が回答の根拠にする資料 (価格の目安・手順・社内ルール・よくある質問)。画面で登録、ファイル (テキスト・CSV・PDF・写真) の取込、Google スプレッドシートとの同期 (毎時・今すぐ同期) |
| 経営ダッシュボード | `/reports` | 期間 (今月〜昨年・指定)・店舗・担当者で、売上・受注・問い合わせ→見積→受注・施工完了・請求・入金・未入金・経費・仕入・簡易粗利、月次推移、受注の進み具合、請求の状況、店舗別・担当者別・種別別・入口別・勘定科目別。各表を CSV で書き出し (店長は自店舗) |
| データ入出力 | `/data` | CSV・Google スプレッドシート (リンク共有) からの顧客・問い合わせの取込 (確認 → 実行)、販売管理ソフトの売上明細の取込 (追加・変更された伝票だけを反映)、顧客・問い合わせ・受注・月次売上の CSV 書き出し (管理者・本部スタッフ) |
| 変更履歴 | `/audit` | 監査ログ (登録者・変更者・承認者、変更前後の値)。ロールに応じた閲覧範囲、期間・対象・操作・操作者での絞り込み、CSV (管理者・本部) |
| 設定 | `/settings` | ユーザー・店舗・商品マスタ・承認ルール (基準額・顧客の重要情報の承認)・外部連携 (メール・LINE・Chatwork・Web フォームの状態、テスト送信、社内通知、送信履歴)・データ管理・本番運用の準備 (サーバー・データベース・セキュリティ・バックアップ・移行データの自動確認) (管理者)。外部連携のタブで既存の AI システムからの受付の設定 (店舗・引き継ぎ先)。ユーザーと権限のタブに権限一覧 (ロール × 操作)、ユーザーごとのアカウント画面 `/settings/users/<ID>` |
| 使い方 | `/help` | ロールごとの操作説明 (画面とボタンの名前で) |
| プロフィール | `/profile` | ヘッダー右上のアバターから開く。自分の権限・担当中の問い合わせ/施工・承認・予定・操作履歴 |

画面の構成: 上部に浮かぶヘッダーに一畳屋のロゴ (公式サイト https://ichijoya.co.jp のロゴ)、メニューのタブ
(アイコン + 名前。マウスを重ねるとアイコンが拡大)、顧客検索、「+ 新規」(問い合わせ・顧客・見積・予定・社内連絡・書類取込)、
通知ベル、アバター (ユーザーメニュー: プロフィール / 承認待ち / 社内連絡 / 予定表 / 設定 / ログアウト) があります。
タブが入りきらない幅では、あふれた分を「その他」にまとめます。タブレット・スマートフォンではヘッダー左のボタンで
メニュー (アイコンの一覧) を開閉します。本文は使える幅に合わせて段組み (1 列 ⇄ 2〜5 列) が自動で切り替わります。

## 技術構成

- Next.js 16 (App Router, Server Components, Server Actions, Turbopack) / React 19 / TypeScript
- Tailwind CSS v4 (淡いブルーの背景に白いカード、アクセントは青紫 (インディゴ)。Web フォント Inter + Noto Sans JP はオフライン時にシステムフォントへフォールバック。本文の段組みはコンテナクエリ `@container` で、実際の表示幅に合わせて変わる)
- データ: Supabase (PostgreSQL)。ローカル検証は `data/db.json` (JSON ファイル)。`src/lib/db/store.ts` が切り替えの境界、テーブル定義の正本は `src/lib/db/schema.ts`
- ファイル (資料・写真・書類取込の元画像・顔写真): 本体はサーバー (VPS) のディスク `/srv/ichijoya/data/uploads` (`FILE_STORAGE_DIR`。手元の開発環境は `data/uploads/`) にだけ保存し、Supabase には台帳の文字とファイルのパスだけを持つ。`src/lib/storage.ts` が境界。閲覧は `/api/attachments/<ID>` が権限 (登録先の記録の店舗・ロール) を確かめてからファイルを返す。写真はブラウザで長辺 2048px に縮小してから送る (Vercel の 1 回の送信は 4.5 MB まで)
- 認証: 署名付き Cookie セッション + scrypt でハッシュ化したパスワード (2 要素認証は次の段階)
- AI: `src/lib/ai/provider.ts` が OpenAI (chat completions + JSON Schema) と Claude (`@anthropic-ai/sdk`、structured outputs) を同じ形で呼ぶ。キー未設定時はサンプル応答。接続は 設定 → 外部連携・AI の「接続を確認」で確かめられる
- 帳票 PDF: `src/lib/pdf/` (pdf-lib + Noto Sans JP を埋め込み)。`/api/pdf/quotes/<ID>` (`?version=` で旧版)・`/api/pdf/invoices/<ID>`・`/api/pdf/receipts/<ID>`。会社情報・登録番号・振込先は 設定 → 帳票
- KPI: `src/lib/kpi.ts` (返信率・評価・クレーム率・口コミ) と `src/lib/incentive.ts` (年間インセンティブ)。ルールは 設定 → KPI・インセンティブ
- 外部連携: `src/lib/notify/` (メールは Resend / SendGrid の API、LINE Messaging API、Chatwork API を fetch で呼ぶ。設定がなければ送らずに送信履歴に「記録のみ」)。受信は `/api/integrations/line`・`/api/integrations/chatwork` (署名を確認)・`/api/integrations/webform` (共有鍵)。LINE で送る帳票は期限つきの署名リンク `/api/doc/<種類>/<ID>`
- 会計データ: `src/lib/accounting.ts` (仕訳の組み立て)・`src/lib/sjis.ts` (Shift_JIS への変換)・`/api/accounting`
- 依存ライブラリは最小限 (`lucide-react`, `clsx`, `@anthropic-ai/sdk`, `pdf-lib`, `@pdf-lib/fontkit`, `server-only`)

```
src/
  app/
    login/                 ログイン (ロール選択・テスト用認証情報を自動入力)
    (app)/                 認証後の画面 (ヘッダーのレイアウト)
      page.tsx             ダッシュボード
      customers/ inquiries/ quotes/ orders/ schedule/ invoices/ expenses/
      purchases/ suppliers/ cashbook/ finance/ accounting/ contacts/ capture/ approvals/ messages/ ai/ reports/ audit/ settings/
    print/                 見積書・請求書の印刷用書式
    api/export, api/health, api/accounting (会計データ), api/integrations (LINE・Chatwork・Web フォームの受信), api/doc (帳票の共有リンク)
    icon.png, apple-icon.png  ブラウザのタブ・ホーム画面用アイコン (公式サイトのファビコン)
  components/
    ui/                    ボタン・バッジ・テーブル・フォーム等の共通部品
    layout/AppShell.tsx    ヘッダー (ロゴ・メニューのタブ・検索・新規作成・通知・ユーザーメニュー) とスマートフォン用メニュー
    brand/Logo.tsx         一畳屋のロゴ (公式サイトのロゴをインライン SVG 化。カラー / 白抜き)
    charts/                依存なしの SVG チャート
    features/              見積明細エディタ、書類取込、AI チャット、ログインフォーム
  lib/
    db/types.ts            ドメインモデル (全エンティティの型)
    db/master.ts           店舗・ユーザー・商品・仕入先マスタ
    db/seed.ts             サンプルデータ生成 (決定論的)
    db/store.ts            データストア (Supabase / JSON の切り替え境界)
    storage.ts             ファイルの保存先 (VPS のディスク。Supabase にはパスだけ)
    backup.ts              バックアップ (deploy/backup.sh の実行・結果の表示。設定 → データ管理)
    attachments.ts         添付ファイル (資料・写真) の登録先・権限・保存
    duplicates.ts          既存顧客との重複確認
    data-io.ts, data-io-spec.ts, csv.ts   CSV・Google スプレッドシートの取込と書き出し
    db/schema.ts           テーブル定義 (Supabase の SQL を生成する元)
    db/supabase.ts         Supabase との読み書き
    db/queries.ts          集計・通知・顧客 360 などの読み取り
    auth/                  セッション・権限ルール
    actions/               Server Actions (登録・更新・承認などの業務ロジック)
    ai/                    OCR (書類読取) と AI アシスタント
    constants.ts           ラベル・ステータス・承認ルール閾値
  proxy.ts                 未ログイン時のリダイレクト
supabase/
  migrations/              テーブル定義だけの SQL (SQL Editor で実行)
  ichijoya.sql             テーブル定義 + 移行データの 1 ファイル (setup-database.mjs / psql で実行。ローカルで生成・コミットしない)
  data/                    同じ内容の分割版 (SQL Editor 用。各 900 KB 以下。ローカルで生成・コミットしない)
  README.md                テーブル作成・データ登録の手順
scripts/
  import/                  SQL の生成・実行とデータの登録 (generate-schema / generate-data-sql / setup-database / load-to-supabase)、デモ用アカウントの登録 (seed-demo-accounts)、売上明細 CSV の取込 (import-sales-csv)
  smoke.mjs                ブラウザ疎通テスト (npm run smoke)
```

## 環境変数

`.env.example` を `.env.local` にコピーして設定します (全項目の説明は `.env.example` にあります。値はコミットしない)。

| 変数 | 説明 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Supabase の接続先と secret キー。両方あれば Supabase、なければ JSON |
| `SESSION_SECRET` | セッション署名用の秘密鍵 (推奨。未設定なら secret キーから導出) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | どちらか 1 つ。書類・はがきの AI 読取と AI アシスタントが動作 (`OPENAI_MODEL`・`AI_PROVIDER` で固定も可。`.env.example` 参照) |
| `DATA_BACKEND` / `DATA_FILE_NAME` | `json` で Supabase を使わずローカルファイル (`data/` 配下、省略時 `db.json`) |
| `SUPABASE_DB_PASSWORD` または `SUPABASE_DB_URL` | データベースへの直接接続。テーブル定義の自動反映 (`npm run build` の前に `scripts/import/migrate.mjs`) と ichijoya.sql の実行 (`setup-database.mjs`) に使う。アプリ本体では使わない |
| `REVIEW_ACCESS_KEY` / `REVIEW_LOGIN` | 確認用ログインの鍵 (省略時は secret キーから導出) / `off` で確認用ログインを停止 |
| `APP_TIME_ZONE` | 日付・時刻の基準 (省略時 `Asia/Tokyo`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` と `MAIL_FROM` | メールの送信 (見積書・請求書の送付、社内通知)。会社のメールアカウント (Xserver の SMTP) を使う。`RESEND_API_KEY` / `SENDGRID_API_KEY` も可 |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE の送信 / 受信 (Webhook の署名の確認) |
| `CHATWORK_API_TOKEN` / `CHATWORK_ROOM_ID` / `CHATWORK_WEBHOOK_TOKEN` | Chatwork の送信 / 社内通知のルーム / 受信 (Webhook の署名の確認。ルームごとのトークンをカンマ区切り) |
| `WEBFORM_SECRET` | Web サイトのお問い合わせフォームからの受信の共有鍵 |
| `APP_BASE_URL` | 通知・送付文に入れる画面の URL (省略時は Vercel の URL。VPS では必須) |
| `AI_INTAKE_SECRET` | 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受信の共有鍵 (`POST /api/integrations/ai-intake?source=chat|voice|phone`) |
| `CRON_SECRET` | 定期実行 (`POST /api/cron/knowledge-sync`: 社内資料のスプレッドシート同期) の鍵 |
| `BACKUP_STATUS_FILE` | バックアップの結果のファイル (`deploy/backup.sh` が書き、設定 → 本番運用の準備 に表示) |

## 本番環境 (Xserver VPS)

構築・更新・ロールバック・バックアップと復元・監視の手順は [`deploy/README.md`](deploy/README.md) にあります (nginx + Let's Encrypt + systemd + cron。データベースとファイルは Supabase)。公開後の確認は `node scripts/ops/verify-production.mjs https://<ドメイン>` (読み取りだけ)。

## Vercel への公開

1. Vercel の Project Settings → Environment Variables に `NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SECRET_KEY`・`SESSION_SECRET` を設定します (Production と Preview)。`NEXT_PUBLIC_` の値はビルド時に埋め込まれるため、設定・変更したあとは再デプロイが必要です
   - `SUPABASE_DB_PASSWORD` (Production) も設定すると、デプロイのビルドの前にテーブル定義 (`schema.ts`) の追加分を Supabase に自動で反映します (`prebuild` → `scripts/import/migrate.mjs`。テーブル・列・索引の追加だけで、データは変えない。反映に失敗したときはデプロイを止める)。未設定ならこの手順は飛ばします
2. 本番 (Production) は `main` ブランチから作られます。関数のリージョンは `vercel.json` で `syd1` (Supabase と同じシドニー) にしています
3. 公開後、`/api/health` が `"backend":"supabase"`・`"db":"ok"`・`"schema":"ok"`・`"timeZone":"Asia/Tokyo"` を返すことを確認します。`"schema":{"missing":[...]}` のときは、アプリに追加したテーブルがデータベースにまだありません。`npm run db:migrate` を実行するか、テーブル定義の SQL (`supabase/migrations/20261112000000_initial_schema.sql`。既存のデータは消えない) を SQL Editor で実行してください (それまでは、その機能だけが使えません)。`"db":"not_configured"` のときは環境変数が未設定です (サンプルデータで動いてしまうため 503 を返します)
4. Vercel のサーバーは UTC で動くため、起動時に日本時間へ設定しています (`src/instrumentation.ts`)。起動直後は全データ (約 6 万行) を読み込むため、関数の実行時間の上限を 60 秒にしています

### 確認用ログイン (お客様の画面確認用)

`/review?key=<鍵>` を開いた端末だけ、ログイン画面にロールのボタン (管理者 / 本部スタッフ / 店長 / 店舗スタッフ) が出て、パスワードなしでログインできます。確認用アカウント (`確認用 管理者` など) が初回に作られ、社員のアカウントは使いません。確認用アカウントは承認先の判定に含めません。リンクを知らない人には通常のログイン画面だけが表示されます。確認期間が終わったら `REVIEW_LOGIN=off` を設定するか、設定 → ユーザーと権限 で確認用アカウントを無効化します。

## 注意事項

- リポジトリは公開されています。お客様のデータ・共有資料・移行データ・接続情報 (`.env.local`)・設計資料はコミットしません (`.gitignore` で除外)
- ローカルのサンプルデータ (JSON) はすべて架空で、パスワードは平文です。本番 (Supabase) のパスワードはハッシュでのみ保存します
