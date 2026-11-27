# 本番環境 (Xserver VPS) の構築・運用手順

一畳屋 業務システムを Xserver VPS で公開・運用するための手順です。データベース (文字とファイルのパス) は Supabase、ファイル (添付ファイル・写真・顔写真) の本体とバックアップはこの VPS のディスクに置きます。

```
ブラウザ ──HTTPS──▶ nginx (443・証明書 Let's Encrypt) ──▶ Next.js (127.0.0.1:3000・systemd で常駐) ──▶ Supabase (PostgreSQL: 文字とパスだけ)
                                                         │
                                                         ├─▶ VPS のディスク: /srv/ichijoya/data/uploads (ファイルの本体)・data/cache (データの控え)
                                                         ▲
cron: バックアップ 3:30 (→ /var/backups/ichijoya) / 社内資料の同期 毎時 / AI アシスタントの精度の評価 毎月 1 日 4:10 / 死活監視 5 分ごと
```

| ファイル | 内容 |
|---|---|
| `setup-server.sh` | サーバーの初期設定 (1 回。何度実行しても同じ状態になる) |
| `deploy.sh` | 更新 (公開) とロールバック |
| `backup.sh` | バックアップ (データベース・添付ファイル・写真・チャットボット。保存先はこの VPS。毎日 3:30 と、管理者の「今すぐバックアップ」) |
| `harden-server.sh` | サーバーを止めない設定 (スリープしない・自動更新で再起動しない・止まっても自動で起動し直す) |
| `run-task.sh` | 定期実行の処理 (社内資料の同期・死活監視) |
| `ichijoya.env.example` | 設定ファイルのひな形 (`/etc/ichijoya/ichijoya.env`) |
| `ichijoya.service` / `nginx-ichijoya.conf` / `ichijoya.cron` | systemd・nginx・cron の設定 |
| `../scripts/ops/verify-production.mjs` | 公開後の動作確認 (読み取りだけ) |
| `../scripts/ops/migrate-storage-to-vps.mjs` | 以前 Supabase Storage に置いていたファイルを VPS へ移す (確認・削除つき) |

## 1. 事前に用意するもの (手作業)

| # | 用意するもの | 担当 |
|---|---|---|
| 1 | Xserver VPS の契約。OS は **Ubuntu 24.04**、メモリ **4 GB 以上** (2 GB でも動作しますがビルドが遅くなります) | 貴社 |
| 2 | VPS パネルの「パケットフィルター設定」で **SSH (22)・HTTP (80)・HTTPS (443)** を許可 | 開発担当 |
| 3 | 公開するドメイン (例: `system.example.co.jp`) と、DNS を設定できる管理画面へのアクセス | 貴社 |
| 4 | DNS の **A レコード**: ドメイン → VPS の IP アドレス | 貴社または開発担当 |
| 5 | SSH の鍵 (VPS 作成時に登録。パスワードでのログインは使わない) | 開発担当 |
| 6 | 設定ファイルの値: Supabase (URL・secret key・Session pooler の接続文字列)、AI のキー、使う外部連携の値 | 開発担当 (貴社のアカウントの値は貴社から受領) |

## 2. 初回の構築

VPS に SSH で接続して実行します。各手順の「確認」で結果を確かめてから次へ進みます。

1. **初期設定**
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/atoman207/ichijoyasystem/main/deploy/setup-server.sh
   sudo bash setup-server.sh <ドメイン> <証明書の連絡先メール>
   ```
   確認: 最後に「完了。次の手順」と表示される。`sudo ufw status` で 22・80・443 だけが許可されている。
2. **設定ファイルに値を入れる** (`SESSION_SECRET`・`CRON_SECRET` は自動で作成済み)
   ```bash
   sudo nano /etc/ichijoya/ichijoya.env
   ```
   確認: `sudo ls -l /etc/ichijoya/ichijoya.env` が `-rw-r----- root ichijoya`。
3. **ビルドして起動**
   ```bash
   sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh
   ```
   確認: 最後に `/api/health` の結果 (`"ok":true,"backend":"supabase","db":"ok","schema":"ok"`) と「完了」が表示される。
4. **SSL 証明書** (DNS がまだ向いていなかったとき。初期設定で取得できていれば不要)
   ```bash
   sudo certbot --nginx -d <ドメイン> --non-interactive --agree-tos -m <メール> --redirect
   ```
   確認: ブラウザで `https://<ドメイン>` を開くと鍵のマークが付き、ログイン画面が表示される。
5. **動作確認**
   ```bash
   cd /srv/ichijoya/current && node scripts/ops/verify-production.mjs https://<ドメイン>
   ```
   確認: 「不合格」が 0 件 (外部連携の受信口は、設定前は「設定前」と表示されて合格)。
6. **バックアップを 1 回実行**
   ```bash
   sudo -u ichijoya bash /srv/ichijoya/current/deploy/backup.sh
   ```
   確認: `ok:` で始まる行が出る。システムの 設定 → 本番運用の準備 の「最後のバックアップ」が OK になる。
7. **システムの設定画面で確認** (管理者でログイン)
   - 設定 → 本番運用の準備: 「要対応」が 0 件
   - 設定 → 外部連携・AI: 「接続を確認」で AI に接続できる。使うサービスは「テスト送信」で届く
8. **外部サービスの受信先を新しいドメインに変更** (Vercel から移行する場合)
   LINE Developers の Webhook URL、Chatwork の Webhook、Web サイトのフォーム、既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) の送信先を `https://<ドメイン>/api/integrations/...` に変更します。URL の一覧は 設定 → 外部連携・AI に表示されます。
9. **Vercel の停止** (移行する場合): 新しいドメインで 1 週間ほど問題がないことを確かめてから、Vercel のプロジェクトを停止します。

## 2-0. このサーバーで開発していたとき (1 回で公開: go-live.sh)

このリポジトリと `.env.local` があるサーバーでは、次の 1 回で「初期設定 → ビルド・起動 → ドメインでの公開」まで行います。

```bash
cd /home/ichijoya/Documents/ichijoyasistem
sudo bash deploy/go-live.sh ichijoya-system.jp <証明書の連絡先メール>
```

- 本番は **3000 番** (systemd の `ichijoya`。VPS を再起動しても自動で起動し、止まれば 5 秒後に再起動)。外からは nginx の https だけ
- DNS (A レコード) がまだこの VPS を向いていなければ、5 分ごとに確かめる定期実行を置き、向いた時点で証明書を取って https で公開します (`/var/log/ichijoya/domain.log`)
- 作業中の変更は `npm run dev` (**3001 番**) で確認し、コミットしてから `npm run deploy` で本番に出します。3001 番は本番と同じデータベースを使うので、操作すると本番のデータが変わります
- 事前に VPS のパネルのファイアウォールで HTTP (80)・HTTPS (443) を許可してください

### 外部連携の値 (メール・LINE・Chatwork) を入れる・変える

リポジトリの `.env.local` の「外部連携」の欄に値を入れ、このフォルダで次を実行します (sudo のパスワードを入力)。

```bash
npm run env:apply
```

`SMTP_`・`MAIL_FROM`・`LINE_`・`CHATWORK_`・`WEBFORM_SECRET`・`AI_INTAKE_SECRET`・`PHONE_INTAKE_SECRET`・AI のキーだけを本番の設定ファイルに写し、変わったときだけアプリを再起動します。値が空の行は写しません (本番の値を消さない)。開発用 (3001 番) には保存した時点で反映されます。

## 2-A. ドメインがまだないとき (IP アドレスで公開)

ドメインを用意するまでは、`http://<VPS の IP アドレス>:3000` (と `http://<IP>`) で使えるようにします。証明書がないため通信は暗号化されません。社内の確認用としてください。

1. **Xserver VPS のパネル → パケットフィルター設定** で **TCP 3000** と **HTTP (80)** を許可する (SSH 22 も許可したまま)
2. **初期設定** (このサーバーで開発していた場合は、そのリポジトリと `.env.local` をそのまま使えます)
   ```bash
   sudo bash deploy/setup-server.sh --ip --repo "$PWD" --env-from "$PWD/.env.local"
   ```
   `--repo` に GitHub の URL を渡すと GitHub から取得します。`AI_INTAKE_SECRET` (既存の AI システムからの受信の鍵)・`PHONE_INTAKE_SECRET` (電話のシステムからの通話の受信の鍵) は自動で作ります。
3. **ビルドして起動** (手で動かしている `next dev` は自動で止まります)
   ```bash
   sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh
   ```
4. **確認**: 別の端末 (スマートフォンなど) で `http://<IP>:3000` を開き、ログイン画面が出ること

### ドメインを用意したら

1. **Xserver VPS のパネル → パケットフィルター設定** で **「Web」(HTTP 80・HTTPS 443)** を許可する。
   許可していないと、外 (利用者・Let's Encrypt・LINE) からは何も届きません (VPS の中からの確認では気づけないので注意)
2. DNS に A レコード (`<ドメイン>` → VPS の IP アドレス) を設定し、1 回実行します。nginx・SSL 証明書・`APP_BASE_URL`・待ち受けのアドレスを切り替え、3000 番を閉じます。

```bash
sudo bash /srv/ichijoya/current/deploy/enable-domain.sh <ドメイン> <証明書の連絡先メール>
```

- DNS の反映前やパケットフィルターの許可前に実行しても大丈夫です。失敗しても定期実行 (`/etc/cron.d/ichijoya-domain`) が約 10 分ごとに再試行し、届いた時点で自動で公開します (経過: `/var/log/ichijoya/domain.log`)。別のドメイン名で定期実行を置いていても、手動で実行したドメインに置き直します
- 最後に、LINE のサーバーから `https://<ドメイン>` へ試しに送り (外から 443 番に届くかの確認)、`verify-production.mjs` で全体を確認します
- この VPS は NAT の内側にあり、自分の公開 IP には接続できません (ヘアピン NAT なし)。そのため `/etc/hosts` にドメイン → `127.0.0.1` を追加し、VPS 上のブラウザー (リモート デスクトップ) からもドメインで開けるようにします

そのあと Chatwork・既存の AI システムの送信先を `https://<ドメイン>/api/integrations/...` にします (LINE の Webhook URL は自動で設定されます。LINE Developers の「Webhook の利用」はオンにしてください)。パネルのパケットフィルターで許可した 3000 番は削除します。

## 3. 更新 (デプロイ) とロールバック

```bash
npm run deploy                                                        # (このサーバーのリポジトリで) コミット済みの main を公開
sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh            # 最新の main を公開
sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh v1.2.0     # タグ・コミットを指定して公開
sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh --rollback # 1 つ前の版に戻す
```

- 公開のたびに `/srv/ichijoya/releases/<日時>` に展開し、ビルドが終わってから切り替えます。起動を確認できないときは自動で前の版に戻します (新しい版を 5 つ残します)。
- ビルドの前に、データベースの表・列の追加を自動で行います (`npm run build` → `scripts/import/migrate.mjs`)。データの削除や型の変更は行いません。
- 切り替えの再起動のあいだ (起動時にデータを読み込む約 10〜20 秒)、画面が表示されません。業務時間外に行ってください。
- AI アシスタント (質問する・要約・文書の作成・社内資料・権限) に関わるファイルが前の版から変わっていたら、ビルドの前に `npm run test:assistant` (AI を呼ばないテストの全部。一時フォルダーのサンプルデータ) を実行し、通らなければ公開しません。公開のあとは本番の AI で精度の評価を裏で始めます (結果は AI アシスタント →「品質・費用」。1 回 100 円前後)。止めるときは `EVAL_AFTER_DEPLOY=off`、テストを飛ばすのは急ぐときだけ `SKIP_ASSISTANT_TESTS=1`。

## 4. バックアップと復元

保存先はすべてこの VPS の `/var/backups/ichijoya` です。

| 対象 | 方法 | 保管場所 | 保管期間 |
|---|---|---|---|
| データベース | `pg_dump` (public スキーマ・カスタム形式) | `db/ichijoya-<日時>.dump` (手動は `-manual`) | 自動 14 日 (`BACKUP_KEEP_DAYS`)・手動 30 日 (`BACKUP_KEEP_MANUAL_DAYS`) |
| 添付ファイル・写真・顔写真 | `/srv/ichijoya/data/uploads` から新しいファイルだけ追加でコピー (rsync) | `storage/` (同じパス) | 削除しない (アプリで消したファイルも残る) |
| チャットボット | SQLite の `VACUUM INTO` | `chatbot/chatbot-<日時>.sqlite` | 14 日 |

- **自動**: 毎日 3:30 (`/etc/cron.d/ichijoya`)。結果は `/var/log/ichijoya/backup.log` と 設定 → データ管理・本番運用の準備 に出ます。
- **手動 (管理者)**: 設定 → データ管理 の **「今すぐバックアップ」**。いつでも実行でき、1 分ほどで終わります (画面に結果が出ます。だれが実行したかは変更履歴に残ります)。同時に 2 つは動きません。
- コマンドで: `sudo -u ichijoya bash /srv/ichijoya/current/deploy/backup.sh --manual "<名前>"`
- **VPS そのものの故障に備えて、バックアップを別の場所にも置くことをおすすめします** (例: Xserver VPS の自動バックアップ機能 (イメージ保存)、または `rsync` で別のサーバー・ストレージへ)。
- **ダウンロード (社外に保管)**: 設定 → データ管理 → バックアップ で、データベース (`.dump`)・添付ファイル・写真の一式 (`tar.gz`、その場で作る)・チャットボット (`.sqlite`) をダウンロードできます (`/api/backups/download`)。管理者のみ・初期パスワードのままでは不可・だれが何をダウンロードしたかは変更履歴に残ります。お客様の個人情報をすべて含むため、鍵のかかる場所 (暗号化したディスク・パスワード付きのクラウドなど) に保管してください。ダウンロードしたデータベースは、下の手順の `/var/backups/ichijoya/db/…` の代わりにそのファイルを使って復元できます (VPS に送ってから `pg_restore`)

**データベースの復元** (データベース全体を、バックアップの時点に戻します。戻す前に、いまの状態のバックアップを取ってください。root で実行: `sudo -i`):

```bash
sudo -u ichijoya bash /srv/ichijoya/current/deploy/backup.sh --manual "復元の前"   # いまの状態を残す
sudo systemctl stop ichijoya            # 開発用 (3001 番) も止める
. /srv/ichijoya/current/deploy/lib.sh && load_env /etc/ichijoya/ichijoya.env
pg_restore --clean --if-exists --no-owner --dbname="$SUPABASE_DB_URL" /var/backups/ichijoya/db/ichijoya-<日時>.dump
(cd /srv/ichijoya/current && node scripts/import/migrate.mjs)   # 表の権限 (RLS・service_role) をそろえ直す
sudo systemctl start ichijoya
```

アプリは起動時に、VPS に保存した控え (`/srv/ichijoya/data/cache`) がいまのデータベースと同じ流れのものかを確かめ (変更の記録 `app_changes` の時刻で照合)、違えば Supabase から全件を読み直します。復元のあとに控えを手で消す必要はありません。

**ファイルの復元**: `sudo -u ichijoya rsync -a --ignore-existing /var/backups/ichijoya/storage/ /srv/ichijoya/data/uploads/` (足りないファイルだけを戻します)。

一部の記録だけを戻すときは、バックアップを手元の PostgreSQL に復元して該当の行を取り出します (開発担当が行います)。

## 4-A. サーバーを止めない (再起動しない・しても自動で戻る)

1 回だけ実行します (何度実行しても同じ状態になります。`setup-server.sh` からも呼ばれます):

```bash
cd /home/ichijoya/Documents/ichijoyasistem && sudo bash deploy/harden-server.sh
```

- スリープ・休止をしない (画面の操作がなくても、ログイン画面のままでも止まらない)
- OS のセキュリティ更新は自動で続けるが、**自動では再起動しない**。更新は夜 4:30 (バックアップの後) に行う
- 本番のアプリ (`ichijoya`) と nginx は、止まっても 3 秒後に起動し直す (回数の上限なし)。VPS を起動すると自動で起動する。5 分ごとの死活監視が、応答しないアプリを再起動する
- メモリが足りなくなったとき、本番のアプリは最後に止められる (開発用のサーバー・エディタが先)。スワップを 4 GB 足す
- カーネルが致命的なエラーで止まったときは、止まったままにせず 10 秒後に起動し直す (アプリは自動で起動する)
- 再起動のあとの起動は、VPS に保存した控えから読むので数秒で終わる (Supabase から全件を読まない)

Xserver 側の保守 (ホストの障害・メンテナンス) による再起動は防げませんが、その場合もアプリは自動で起動します。カーネルの更新を使うには、業務時間外に `sudo reboot` してください。

## 5. 監視・ログ

| 確認したいこと | コマンド |
|---|---|
| アプリの状態 | `systemctl status ichijoya` |
| アプリのログ | `journalctl -u ichijoya -n 200 --no-pager` (`-f` で追跡) |
| 死活監視 (止まったら自動で再起動) | `/var/log/ichijoya/health.log` |
| バックアップ | `/var/log/ichijoya/backup.log` |
| 社内資料の同期・FAX の定期処理・AI の精度の評価 | `/var/log/ichijoya/cron.log` |
| nginx | `/var/log/nginx/access.log` / `error.log` |
| 証明書の期限 | `sudo certbot certificates` (自動更新: `systemctl list-timers \| grep certbot`) |
| ディスク | `df -h /` |

OS のセキュリティ更新は自動 (unattended-upgrades) です。カーネルの更新で再起動が必要なときは、業務時間外に `sudo reboot` してください (アプリは自動で起動します)。

## 5-AI. AI アシスタントの品質・費用

- 画面: AI アシスタント →「品質・費用」(管理者)。受入基準 (正答率・数字の一致・権限の漏えい・存在しない画面の案内・根拠のない回答・答えられない質問・実行の断り・参照元の表示) と、正解付きの質問・評価の実行・AI の利用回数と費用・予算・低評価の回答・データの品質。
- 定期の評価 (毎月 1 日 4:10) を cron に加えたため、`deploy/ichijoya.cron` を入れ直してください: `sudo install -m 644 /srv/ichijoya/current/deploy/ichijoya.cron /etc/cron.d/ichijoya`。評価は AI を本当に呼ぶので費用がかかります (1 問あたり AI の呼び出し 2〜6 回)。
- 予算: 画面の「予算と単価」(または `.env.local` の `AI_MONTHLY_BUDGET_JPY`・`AI_MONTHLY_TOKEN_LIMIT`・`AI_USD_JPY`)。超えたら月末まで AI を使わずに (蓄えた回答・集計・資料から) 答えます。単価は OpenAI・Anthropic の料金表で確かめて入れてください (未設定のモデルは費用に入りません)。
- 障害: AI の呼び出しが続けて失敗すると、3 分 (キー・残高の誤りは 30 分) は AI を呼ばずにすぐ答えます。失敗の種類と回数は同じ画面に出ます。
- 相談の履歴の保存期間: `CHATBOT_LOG_RETENTION_DAYS` (既定 730 日)、履歴の集計の表 (お客様の名前などを含む) は `CHATBOT_LOG_TABLE_DAYS` (既定 90 日)。AI の呼び出しの記録 (数だけ) は `AI_CALLS_RETENTION_DAYS` (既定 400 日)。
- テスト: `npm run test:chatbot` (AI を呼ばない単体テストと、モックの OpenAI・Claude を使うテスト。本物の AI・本番のデータは使わない)。本物の AI での評価は画面の「評価を実行」、またはサンプルデータで `node scripts/tests/chatbot/eval-live.mjs`。

- 受入の確認: 正解付きの質問に「対象 (質問する・要約・文書の作成)」「対象の記録を選ぶ SQL」「必要な根拠・出してはいけない根拠」「ロールの組み合わせ (全ロール × 全店舗)」を付けられます。「代表にする」で代表シナリオを選び、評価が合格したら、お客様 (一畳屋の責任者) が回答を読んで「承認を記録する」を押します (受入確認書は「受入確認書を印刷」)。AI アシスタントを変えて版が変わる・代表シナリオが不合格になると「要再確認」になります。テストは `npm run test:acceptance`。

## 5-K. 社内資料と Google スプレッドシートの同期

- 社内資料には、どれにも担当者・次に確かめる日・見られる人・分類を付けます。期限を過ぎた資料は担当者に知らせ (右上のベル・メール。1 日 1 回の確認で、同じ人には 7 日に 1 回)、AI は「古い可能性がある」と添えて答えます。担当者・見られる人のまとめての割り当ては 社内資料 →「資料の管理の状況」で絞り込み →「選んだ資料をまとめて変更」。
- 既存のマニュアル・議事録 (クライアント資料) の取込: `npm run registry:promote` (確認だけ) → `npm run registry:promote -- --apply --owner <担当者のログイン ID>` (Supabase に書く。担当者を省くと 確認のルールの既定の担当者、なければ「担当者なし」)。テーブル定義の反映 (`npm run db:migrate`) のあとに行います。
- 同期は一方向 (シート → システム。読み取り専用の権限で読み、シートには書きません)。取込元を登録すると、取り込む前に行ごとの確認結果を出します。定期の同期は毎時 15 分 (`deploy/ichijoya.cron` の knowledge-sync)。失敗・シートの半分以上の行が消えたときは書かずに止め、取込元の担当者と本部・管理者に知らせます (同じ失敗は 24 時間に 1 回。直ったら「復旧しました」)。最後に成功した日時・同期の記録・定期の同期が動いているかは 社内資料 → 取込元の画面と 設定 → 外部連携・AI、本番運用の準備 に出ます。
- cron を入れ直す (FAX・精度の評価の行を足したため。いまの /etc/cron.d/ichijoya は古い版です): `sudo install -m 644 /srv/ichijoya/current/deploy/ichijoya.cron /etc/cron.d/ichijoya`。動いているかは `/var/log/ichijoya/cron.log`。

## 5-S. お客様アンケート集計表 (クレーム・手直し・Google 口コミ・アンケートの集計表) の取込

- 先に `npm run db:migrate` (表 `survey_history` と クレーム・手直しの列 `site_name`・`origin`・`source_ref`・`order_id` の not null を外す・口コミの `source_ref`)。反映前は取込の画面で「確認」だけでき、取り込むボタンは押せません。
- 最初の取込: VPS で `npm run kpi:import-workbook` (確認だけ。`source/02_お客様対応・アンケート/アンケート/` のタブごとの CSV のフォルダーを読む) → 件数・案件へのひも付け・KPI のシートとの照合を確かめて `npm run kpi:import-workbook -- --apply`。画面 (KPI →「スプレッドシートの取込」、本部・管理者) でも同じことができます。同じ行を 2 回取り込んでも二重になりません。
- スプレッドシートを直接読む: 下の「サービスアカウント」を設定し、お客様アンケート集計表を **閲覧者** として共有 → 取込の画面の「つなぎ方の設定」に URL を登録。毎日取り込むときは「定期の同期」をオン (6:20。`deploy/ichijoya.cron` の survey-workbook。cron を入れ直す: `sudo install -m 644 /srv/ichijoya/current/deploy/ichijoya.cron /etc/cron.d/ichijoya`)。一方向 (シート → システム) で、シートから消えた行は消さず、システムで変えた案件・担当者・状態は上書きしません。

### Google スプレッドシートのサービスアカウント (非公開のシートを読む)

1. Google Cloud のコンソールでプロジェクトを作る (または既存のもの) →「API とサービス」→「ライブラリ」で **Google Sheets API** を有効にする。
2. 「IAM と管理」→「サービスアカウント」→ 作成 (ロールは付けない) →「鍵」→「鍵を追加」→ JSON をダウンロードする。
3. 鍵をサーバーに置く (鍵の中身はリポジトリ・チャットに貼らない):
   `sudo install -m 640 -o root -g ichijoya <ダウンロードした鍵>.json /etc/ichijoya/google-service-account.json`
4. `/etc/ichijoya/ichijoya.env` に `GOOGLE_SERVICE_ACCOUNT_FILE=/etc/ichijoya/google-service-account.json` を足して `sudo systemctl restart ichijoya` (または `.env.local` に書いて `npm run env:apply`。`GOOGLE_SERVICE_ACCOUNT_JSON` に鍵の JSON (base64 でも可) を直接入れてもよい)。
5. 設定 → 外部連携・AI の「Google スプレッドシート」が「サービスアカウントで接続」になり、メールアドレス (…@….iam.gserviceaccount.com) が出ることを確かめる。
6. 読ませたいシートごとに、シートの「共有」でそのメールアドレスを **閲覧者** として追加する (編集者にしない。リンクの共有は「制限付き」のままでよい)。
7. 社内資料 → スプレッドシートの URL を登録 → 行ごとの確認結果を見て「この内容で同期する」。

## 5-A. 発注書・クラウド FAX

- 発注書・FAX のテーブル (`purchase_orders`・`fax_messages`・`fax_numbers`) は、デプロイ (`npm run deploy` の build) で自動で作られます。作られるまでは画面から保存できません (分かる言葉で断ります)。
- FAX の定期処理 (2 分ごと。送信の状態の確認・通信エラーの自動の再送・AI の判定待ちの読み直し) を cron に加えたため、このリポジトリの `deploy/ichijoya.cron` を入れ直してください:
  `sudo install -m 644 /srv/ichijoya/current/deploy/ichijoya.cron /etc/cron.d/ichijoya`
- 設定 (`.env.local` の「外部連携」→ `npm run env:apply`):
  - `FAX_NUMBER=096-348-3177` (自社の FAX 番号。発注書の返信先に載ります)
  - `FAX_PROVIDER` … FAX サービスを契約し、そのアダプター (`src/lib/fax/adapter.ts` の `LIVE_ADAPTERS`) を加えてから設定します。未設定のあいだは送信せず、「PDF を印刷して FAX 機で送る → 送信の記録」と「受信した FAX の PDF を登録」で運用できます。`mock` は検証環境 (`DATA_BACKEND=json`) 専用で、本番のデータベースでは動きません。
  - `FAX_WEBHOOK_SECRET` … FAX サービスからの通知 (`https://<ドメイン>/api/integrations/fax`) の署名の鍵。
- 送受信した FAX の PDF は添付ファイルと同じ場所 (`/srv/ichijoya/data/uploads/fax/`) に保存し、毎日のバックアップに含まれます。

## 6. Supabase (データベース) の本番の設定

- データベースのパスワードは強いものにし、設定ファイル以外に書かない。
- 自動バックアップ (日次・時点復元) が必要なら、Supabase の有料プラン (Pro) にする。このサーバーの毎日のバックアップとあわせて二重になります。
- Settings → Database → **SSL Enforcement** を有効にする。
- Settings → Database → **Network Restrictions** で、直接接続を VPS の IP アドレスと開発担当の IP に限る (任意)。

## 7. 障害のとき

| 症状 | 確認・対応 |
|---|---|
| 画面が開かない | `systemctl status ichijoya`・`journalctl -u ichijoya -n 100`。`sudo systemctl restart ichijoya` |
| 更新後に不具合 | `deploy.sh --rollback` で前の版に戻し、開発担当に連絡 |
| `/api/health` が `db:error` | Supabase の状態 (status.supabase.com)・設定ファイルの値を確認 |
| 証明書の期限切れ | `sudo certbot renew` → `sudo systemctl reload nginx` |
| ディスクがいっぱい | `sudo du -sh /var/backups/ichijoya/* /srv/ichijoya/releases/*`。古い版・バックアップを整理 |

## 試験期間 (2026-11-23 0:00 〜 12-01 0:00)

試験期間は「データベースだけ」をテスト用にします (`deploy/testweek.sh`・`deploy/testweek-data.py`)。アプリの版・設定・メール・LINE・Chatwork・FAX・AI・外部からの受信・定期処理は本番と同じです。

- テスト用のデータベース: 切り替えた時点の本番のデータの控え (`/srv/ichijoya/data/cache/db-production.ndjson.gz`) の写し (JSON。`/srv/ichijoya/testweek/data`)。添付ファイル・チャットボット・資料庫も写し。期間中の操作 (画面・外部からの受信・定期処理) はすべて写しに入り、本番のデータベース (Supabase) は変わらない
- テスト用のサーバー: systemd の `ichijoya-testweek` (127.0.0.1:3300・メモリ 2 GB まで)。アプリは本番の版のコピー (`cp -al`。`data` は `/srv/ichijoya/testweek/data` へのリンク)、設定 `/srv/ichijoya/testweek/testweek.env` は本番の設定 (`/etc/ichijoya/ichijoya.env`) からデータベースの接続 (`SUPABASE_*`) とデータの置き場所だけを除いたもの (メール・LINE などは本当に送られる)
- nginx: 本番の server が読み込む `/etc/nginx/snippets/ichijoya-host-testweek.conf` で、https://ichijoya-system.jp のすべての要求をテスト用のサーバーへ (本番の設定ファイルは変えない)
- デプロイ: `npm run deploy` は本番を公開したあと、試験期間ならテスト用のサーバーも同じ版にそろえる (`sudo -n /usr/local/sbin/ichijoya-testweek refresh-app`。データはそのまま、新しい表は空で足す。止まるのは起動し直す十数秒)。そろえられなかったときはデプロイが失敗の終了コードで知らせる
- 定期処理: データを扱うもの (knowledge-sync・fax・survey-workbook) は期間中テスト用のサーバーへ (`run-task.sh`)。バックアップと本番の死活監視は本番。テスト用のサーバーの死活監視 (`health-testweek`、5 分ごと) は期間中だけ
- バックアップ: 毎日 3:30 の `backup.sh` は、期間中だけテスト用のデータベースも控える (`/var/backups/ichijoya/testweek/testweek-<日時>.tar.gz`: データベースの JSON・チャットボット・期間中に増えた添付ファイル。14 日で削除)。テスト用のサーバーの画面の「今すぐバックアップ」は何もしない (アプリのコピーの `backup.sh` を置き換えている)
- 予約: `sudo bash deploy/testweek.sh schedule` で、11-23 0:00 に `start`、12-01 0:00 に `end` を cron (`/etc/cron.d/ichijoya-testweek`) で実行し、デプロイからの `refresh-app` を許可する (`/etc/sudoers.d/ichijoya-testweek`)。`end` は、期間中に外部 (LINE・Web フォーム・AI 受付・電話のシステム) から届いた記録を `/var/backups/ichijoya/testweek-inbound-<日付>.csv` に控えてから、画面を本番に戻し、テスト用のデータベースの控え (データベースの JSON と期間中に増えた・変わったファイル。`/var/backups/ichijoya/testweek-final-<日付>.tar.gz`・アプリの利用者 (ichijoya) と root だけが読める・60 日で削除。期間中のデータを本番に引き継ぐときに使う) を作ってから削除する (控えを作れなければ削除しない)。手動は `sudo ichijoya-testweek start|end|status|refresh-app|reset-data` (`reset-data` は期間中のデータベースをいまの本番の写しで作り直す。練習で入れたデータを消してから本番さながらに使い、12/1 にそのデータを本番に引き継ぐときに使う。作り直す前の控えを残す)。ログは `/var/log/ichijoya/testweek.log`
- 期間中は 3001 番の開発サーバーで動作を確かめない (3001 番は本番のデータベースを使うため)。Supabase に直接書くスクリプトも使わない

### 試験期間のデータを本番に引き継ぐ (`scripts/ops/testweek-carryover.mjs`)

お客様が期間中に「本番さながら」に登録したデータ (例: 11/23 の店長会議で登録したコンパス未入力の問い合わせ・見積) を、12/1 に本番のデータベースへ引き継ぐ。テストは `npm run test:carryover`。

- 比べる元: 期間の始まりの本番の控え `/var/backups/ichijoya/testweek-baseline-rev<リビジョン>-<日付>.ndjson.gz` (`testweek-data.py build` が残す。11/23 の分は `testweek-baseline-rev354.ndjson.gz`)。テスト用のデータベースの meta.copyOfSavedAt と同じ控えでないと止まる
- まとまり: 期間中に増えた・変わった・消えた行を、ID の参照でつながる「まとまり」(お客様 → 問い合わせ → 見積 → 承認・写真・やりとり・変更履歴) に分け、最初の操作の日時 (受付日などの業務の日付ではなく、システムが付けた日時) が `--since`〜`--until` (日本時間) のものを引き継ぐ。除くのは `--exclude <番号・ID>`、指定したものだけは `--only`。お客様名・件名・要約に「練習」「テスト」とあるものは練習として引き継がない。ログイン・閲覧だけの変更履歴は引き継がない。引き継ぐ行が参照する期間中に増えた行 (新しい仕入先など) は一緒に引き継ぐ。社員はプロフィールの項目 (ログイン ID・通知先・顔写真など。パスワードは期間中は変更を止めている) だけ。設定・店舗の変更は `--settings <ID>` で指定したものだけ (例: 運用の設定 `operations`)
- 本番への書き込み: 1 つのトランザクションで、行を読む (for update) → 期間中に本番の側で変わった行・番号の重複 (12/1 以降に本番で登録した記録など)・ファイルの重複があれば何も書かずに中止 → 追加・更新・削除 → 読み直して計画と照合 → `record_changes` (動いているサーバーは変わった行だけを取り直す) → commit。写真・資料のファイルは `/srv/ichijoya/data/uploads` へ写す (上書きしない)。2 回実行しても同じ (同じ内容は飛ばす)

お客様の判断 (2026-11-23): 11/23 の店長会議から 11/30 まで本番同様に使い、11/30 に引き継ぎの最終判断をする。判断は画面 データ入出力 →「本番への引き継ぎ」(`/data/carryover`。テスト用のサーバーで、管理者・本部が まとまりごとに「引き継ぐ・引き継がない」・期間・引き継ぐ設定を決め、管理者が最終判断) でテスト用のデータベースの settings `carryover_review` に残り、`plan` はそれを読む (引数の指定が優先。`--ignore-review` で使わない)。`plan` は最終判断の有無を表示する。

手順 (12/1 の朝、本番で登録を始める前に。番号が重ならないように):

```bash
cd /home/ichijoya/Documents/ichijoyasistem
# 1. 計画と一覧 (期間中はいつでも作れる。テスト用のデータベースは読むだけ。12/1 以降は期間の終わりの控えを読む)
node scripts/ops/testweek-carryover.mjs plan            # 画面の判断 (期間・引き継ぐ/引き継がない・設定) のまま。上書きは --since/--until/--settings/--exclude/--only
#    → /var/backups/ichijoya/carryover/<日時>/carryover-list.csv (お客様に確かめていただく一覧) と carryover-plan.json
# 2. 本番と突き合わせ (読むだけ) → 予行 (書いて照合してから取り消す) → 書く
node scripts/ops/testweek-carryover.mjs check --plan <…>/carryover-plan.json
node scripts/ops/testweek-carryover.mjs apply --plan <…>/carryover-plan.json
node scripts/ops/testweek-carryover.mjs apply --plan <…>/carryover-plan.json --yes
```

12/1 0:00 の `end` のあとは、テスト用のデータベースは `testweek-final-<日付>.tar.gz` から読む (`--test` を省くと新しい控え)。2026-11-23 の時点で使われている `end` は、`schedule` を実行し直すまで控えを root だけが読める形で作る (`sudo bash deploy/testweek.sh schedule` で入れ直すか、`sudo chown ichijoya: /var/backups/ichijoya/testweek-final-*.tar.gz`)。

### 試験期間のチャットを本番に引き継ぐ (`scripts/ops/testweek-chat-carryover.mjs`)

チャット (チャンネル・DM・資料・写真) はデータベースではなく SQLite (`chat.sqlite`) とファイル (`uploads/chat/`) で、期間中はテスト用のサーバーのフォルダー (`/srv/ichijoya/testweek/data`) にある。お客様のご指示 (2026-11-27) で、期間中のチャットはすべて 12/1 に本番に引き継ぐ (上の まとまりごとの判断の対象外)。テストは `npm run test:chat` (carryover.test.mjs)。

- 書き方: 本番の `/srv/ichijoya/data/chat.sqlite` に、本番にない行を 1 つの取引で足す (本番のサーバーは動いたままでよい)。rev は本番のいまの rev のあとに付け直す (開いている画面も読み直す)。日時のある行 (管理者のメンバーの変更・チャンネルの画像・既読・通知の設定) は新しいほう。期間の前に両方に入れたメンバーの変更で、期間中に自動に戻したものは本番でも消す。ファイルは上書きしない。済んだら本番の chat.sqlite の meta `testweek_carryover` に結果を残し、2 回目は何もしない
- 元: テスト用のフォルダー (end が消す前) → 期間の終わりの控え `testweek-final-<日付>.tar.gz` (chat.sqlite と uploads/chat だけを取り出す) → 写し `/var/backups/ichijoya/testweek-chat/` (`--stage`)。2026-11-23 に入れた `end` は控えを root だけが読める形で作るため、写しを予備にした (それより後のメッセージは控えにだけある。`sudo bash deploy/testweek.sh schedule` で入れ直すと控えを ichijoya も読める)
- 定期実行: ichijoya のユーザーの crontab (`deploy/testweek-chat.cron` を `crontab deploy/testweek-chat.cron` で入れる。確認は `crontab -l`。ログ `/var/log/ichijoya/testweek-chat.log`。本番に出す前でも、この作業用のフォルダーの道具で動く)。11/30 は 10 分ごと・23 時台と 12/1 0:00〜0:04 は 1 分ごとに `--stage`、12/1〜12/3 は 10 分ごとに `--auto --apply` (0:05 までと、テスト用のサーバー・nginx の切り替えが残っているあいだは待つ)。12/4 以降に crontab の行を消してよい
- 手動: `node scripts/ops/testweek-chat-carryover.mjs` (予行: 本番の写しに書いて数を出すだけ) → `--apply`。`--from <フォルダー | tar.gz>`・`--to <データのフォルダー>` で元と先を指定

練習用の架空のデータの環境 (`/srv/ichijoya/training`・ユーザーのサービス `ichijoya-training`・127.0.0.1:3200) も作ってあるが、試験期間の方式にしたため止めている (`systemctl --user start ichijoya-training` で起動。初期化は `bash /srv/ichijoya/training/reset.sh`)。
