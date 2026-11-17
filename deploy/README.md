# 本番環境 (Xserver VPS) の構築・運用手順

一畳屋 業務システムを Xserver VPS で公開・運用するための手順です。データベースとファイルの保存先は、これまでどおり Supabase を使います。

```
ブラウザ ──HTTPS──▶ nginx (443・証明書 Let's Encrypt) ──▶ Next.js (127.0.0.1:3000・systemd で常駐) ──▶ Supabase (PostgreSQL・Storage)
                                                         ▲
cron: バックアップ 3:30 / 社内資料の同期 毎時 / 死活監視 5 分ごと
```

| ファイル | 内容 |
|---|---|
| `setup-server.sh` | サーバーの初期設定 (1 回。何度実行しても同じ状態になる) |
| `deploy.sh` | 更新 (公開) とロールバック |
| `backup.sh` | バックアップ (データベース・添付ファイル) |
| `run-task.sh` | 定期実行の処理 (社内資料の同期・死活監視) |
| `ichijoya.env.example` | 設定ファイルのひな形 (`/etc/ichijoya/ichijoya.env`) |
| `ichijoya.service` / `nginx-ichijoya.conf` / `ichijoya.cron` | systemd・nginx・cron の設定 |
| `../scripts/ops/verify-production.mjs` | 公開後の動作確認 (読み取りだけ) |
| `../scripts/ops/backup-storage.mjs` | 添付ファイルのバックアップ (backup.sh から使う) |

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

## 2-A. ドメインがまだないとき (IP アドレスで公開)

ドメインを用意するまでは、`http://<VPS の IP アドレス>:3000` (と `http://<IP>`) で使えるようにします。証明書がないため通信は暗号化されません。社内の確認用としてください。

1. **Xserver VPS のパネル → パケットフィルター設定** で **TCP 3000** と **HTTP (80)** を許可する (SSH 22 も許可したまま)
2. **初期設定** (このサーバーで開発していた場合は、そのリポジトリと `.env.local` をそのまま使えます)
   ```bash
   sudo bash deploy/setup-server.sh --ip --repo "$PWD" --env-from "$PWD/.env.local"
   ```
   `--repo` に GitHub の URL を渡すと GitHub から取得します。`AI_INTAKE_SECRET` (既存の AI システムからの受信の鍵) は自動で作ります。
3. **ビルドして起動** (手で動かしている `next dev` は自動で止まります)
   ```bash
   sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh
   ```
4. **確認**: 別の端末 (スマートフォンなど) で `http://<IP>:3000` を開き、ログイン画面が出ること

### ドメインを用意したら

DNS に A レコード (`<ドメイン>` → VPS の IP アドレス) を設定し、反映されたら 1 回実行します。nginx・SSL 証明書・`APP_BASE_URL`・待ち受けのアドレスを切り替え、3000 番を閉じます。

```bash
sudo bash /srv/ichijoya/repo/deploy/enable-domain.sh <ドメイン> <証明書の連絡先メール>
```

そのあと 設定 → 外部連携・AI で「LINE の Webhook URL をこのシステムに設定」を押し、Chatwork・既存の AI システムの送信先を `https://<ドメイン>/api/integrations/...` にします。パネルのパケットフィルターで許可した 3000 番は削除します。

## 3. 更新 (デプロイ) とロールバック

```bash
sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh            # 最新の main を公開
sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh v1.2.0     # タグ・コミットを指定して公開
sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh --rollback # 1 つ前の版に戻す
```

- 公開のたびに `/srv/ichijoya/releases/<日時>` に展開し、ビルドが終わってから切り替えます。起動を確認できないときは自動で前の版に戻します (新しい版を 5 つ残します)。
- ビルドの前に、データベースの表・列の追加を自動で行います (`npm run build` → `scripts/import/migrate.mjs`)。データの削除や型の変更は行いません。
- 切り替えの再起動のあいだ (起動時にデータを読み込む約 10〜20 秒)、画面が表示されません。業務時間外に行ってください。

## 4. バックアップと復元

| 対象 | 方法 | 保管場所 | 保管期間 |
|---|---|---|---|
| データベース | `pg_dump` (public スキーマ・カスタム形式) | `/var/backups/ichijoya/db/ichijoya-<日時>.dump` | 14 日 (`BACKUP_KEEP_DAYS`) |
| 添付ファイル (写真・PDF) | 新しいファイルだけ追加でコピー | `/var/backups/ichijoya/storage/` | 削除しない |

- 毎日 3:30 に自動で実行し、結果を `/var/log/ichijoya/backup.log` と 設定 → 本番運用の準備 に残します。
- **サーバーの故障に備えて、バックアップを別の場所にも置いてください** (例: Xserver VPS の自動バックアップ機能、または `rsync` で別のサーバー・ストレージへ)。どこに置くかは貴社と決めます。

**データベースの復元** (データベース全体を、バックアップの時点に戻します。戻す前に、いまの状態のバックアップを取ってください。root で実行: `sudo -i`):

```bash
sudo -u ichijoya bash /srv/ichijoya/current/deploy/backup.sh          # いまの状態を残す
sudo systemctl stop ichijoya
. /srv/ichijoya/current/deploy/lib.sh && load_env /etc/ichijoya/ichijoya.env
pg_restore --clean --if-exists --no-owner --dbname="$SUPABASE_DB_URL" /var/backups/ichijoya/db/ichijoya-<日時>.dump
(cd /srv/ichijoya/current && node scripts/import/migrate.mjs)   # 表の権限 (RLS・service_role) をそろえ直す
sudo systemctl start ichijoya
```

一部の記録だけを戻すときは、バックアップを手元の PostgreSQL に復元して該当の行を取り出します (開発担当が行います)。添付ファイルは `storage/` から Supabase Storage の同じパスへアップロードし直します。

## 5. 監視・ログ

| 確認したいこと | コマンド |
|---|---|
| アプリの状態 | `systemctl status ichijoya` |
| アプリのログ | `journalctl -u ichijoya -n 200 --no-pager` (`-f` で追跡) |
| 死活監視 (止まったら自動で再起動) | `/var/log/ichijoya/health.log` |
| バックアップ | `/var/log/ichijoya/backup.log` |
| 社内資料の同期 | `/var/log/ichijoya/cron.log` |
| nginx | `/var/log/nginx/access.log` / `error.log` |
| 証明書の期限 | `sudo certbot certificates` (自動更新: `systemctl list-timers \| grep certbot`) |
| ディスク | `df -h /` |

OS のセキュリティ更新は自動 (unattended-upgrades) です。カーネルの更新で再起動が必要なときは、業務時間外に `sudo reboot` してください (アプリは自動で起動します)。

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
