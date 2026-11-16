#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: 本番サーバー (Xserver VPS・Ubuntu 24.04 / 22.04) の初期設定
#
#   使い方 (VPS に root で SSH 接続して実行。何度実行しても同じ状態になる):
#     curl -fsSLO https://raw.githubusercontent.com/<アカウント>/<リポジトリ>/main/deploy/setup-server.sh
#     sudo bash setup-server.sh <ドメイン> <証明書の連絡先メール> [リポジトリの URL] [ブランチ]
#   例: sudo bash setup-server.sh system.example.co.jp admin@example.co.jp
#
#   行うこと: パッケージ (nginx・certbot・Node.js 24・PostgreSQL 17 クライアント)、実行ユーザー ichijoya、
#   ディレクトリ、設定ファイルのひな形 (/etc/ichijoya/ichijoya.env)、systemd、nginx、ファイアウォール (ufw)、
#   自動更新 (unattended-upgrades)、定期実行 (バックアップ・社内資料の同期・死活監視)、SSL 証明書 (DNS が向いていれば)
#   行わないこと: 設定ファイルの値の入力 (秘密の値はこのあと手で入れる)、アプリのビルド (deploy.sh で行う)
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO="${3:-https://github.com/atoman207/ichijoyasystem.git}"
BRANCH="${4:-main}"
APP_USER=ichijoya
APP_DIR=/srv/ichijoya
ENV_FILE=/etc/ichijoya/ichijoya.env

if [[ $EUID -ne 0 ]]; then echo "root で実行してください (sudo bash $0 ...)"; exit 1; fi
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then echo "使い方: sudo bash $0 <ドメイン> <証明書の連絡先メール> [リポジトリの URL] [ブランチ]"; exit 1; fi
if ! grep -qiE 'ubuntu' /etc/os-release; then echo "Ubuntu 用のスクリプトです"; exit 1; fi
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "パッケージを更新・導入します"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx ufw unattended-upgrades jq rsync openssl

log "Node.js 24 (LTS)"
if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v

log "PostgreSQL 17 のクライアント (バックアップの pg_dump。Supabase と同じ版)"
if ! command -v pg_dump >/dev/null || ! pg_dump --version | grep -q ' 17\.'; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  . /etc/os-release
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-client-17
fi
pg_dump --version

log "メモリが 4 GB 未満ならスワップ (2 GB) を作ります (ビルドのため)"
MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [[ $MEM_KB -lt 4000000 && ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "実行ユーザー ($APP_USER) とディレクトリ"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /bin/bash "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR" "$APP_DIR/releases" /var/lib/ichijoya /var/backups/ichijoya /var/log/ichijoya
chmod 750 /var/backups/ichijoya
install -d -m 750 -o root -g "$APP_USER" /etc/ichijoya

log "ソースコードを取得します ($REPO $BRANCH)"
if [[ ! -d "$APP_DIR/repo/.git" ]]; then
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO" "$APP_DIR/repo"
else
  sudo -u "$APP_USER" git -C "$APP_DIR/repo" fetch --prune origin
fi
SRC="$APP_DIR/repo/deploy"

log "設定ファイル ($ENV_FILE)"
if [[ ! -f "$ENV_FILE" ]]; then
  sed "s/__DOMAIN__/$DOMAIN/g" "$SRC/ichijoya.env.example" > "$ENV_FILE"
  # ログインの署名の鍵と定期実行の鍵はここで作る (ほかの値は手で入れる)
  sed -i "s|^SESSION_SECRET=$|SESSION_SECRET=$(openssl rand -hex 32)|" "$ENV_FILE"
  sed -i "s|^CRON_SECRET=$|CRON_SECRET=$(openssl rand -hex 24)|" "$ENV_FILE"
  echo "  → 作成しました。Supabase・AI などの値を入れてください: sudo nano $ENV_FILE"
else
  echo "  → 既にあります (変更しません)"
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

log "systemd (常駐サービス)"
install -m 644 "$SRC/ichijoya.service" /etc/systemd/system/ichijoya.service
systemctl daemon-reload
systemctl enable ichijoya >/dev/null
# デプロイ (deploy.sh) から再起動できるようにする (このコマンドだけ)
cat > /etc/sudoers.d/ichijoya <<EOF
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart ichijoya, /usr/bin/systemctl is-active ichijoya
EOF
chmod 440 /etc/sudoers.d/ichijoya
visudo -cf /etc/sudoers.d/ichijoya >/dev/null

log "nginx (https://$DOMAIN → 127.0.0.1:3000)"
sed "s/__DOMAIN__/$DOMAIN/g" "$SRC/nginx-ichijoya.conf" > /etc/nginx/sites-available/ichijoya
ln -sf /etc/nginx/sites-available/ichijoya /etc/nginx/sites-enabled/ichijoya
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "ファイアウォール (SSH・HTTP・HTTPS のみ)"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

log "OS の自動更新 (セキュリティ更新)"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

log "定期実行 (バックアップ 3:30・社内資料の同期 毎時・死活監視 5 分ごと)"
install -m 644 "$SRC/ichijoya.cron" /etc/cron.d/ichijoya
cat > /etc/logrotate.d/ichijoya <<'EOF'
/var/log/ichijoya/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
EOF

log "SSL 証明書 (Let's Encrypt)"
SERVER_IPS=$(hostname -I)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [[ -n "$DNS_IP" && " $SERVER_IPS " == *" $DNS_IP "* ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  systemctl reload nginx
else
  echo "  → $DOMAIN の DNS (A レコード) がこのサーバー ($SERVER_IPS) を向いていないため、証明書はまだ取得しません。"
  echo "     DNS を設定して反映されたら、次を実行してください:"
  echo "     sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect"
fi

log "完了。次の手順"
cat <<EOF
  1. 設定ファイルに値を入れる:   sudo nano $ENV_FILE
  2. アプリをビルドして起動する:   sudo -u $APP_USER bash $APP_DIR/repo/deploy/deploy.sh
  3. 動作を確認する:               cd $APP_DIR/current && node scripts/ops/verify-production.mjs https://$DOMAIN
  4. バックアップを 1 回試す:      sudo -u $APP_USER bash $APP_DIR/current/deploy/backup.sh
EOF
