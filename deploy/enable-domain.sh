#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: ドメインを用意したあとの切り替え (IP アドレスでの公開 → https://<ドメイン>)
#
#   前提: DNS の A レコード (<ドメイン> → この VPS の IP アドレス) を設定し、反映されていること
#   使い方: sudo bash /srv/ichijoya/repo/deploy/enable-domain.sh <ドメイン> <証明書の連絡先メール>
#   例:     sudo bash /srv/ichijoya/repo/deploy/enable-domain.sh system.ichijoya.co.jp admin@ichijoya.co.jp
#
#   行うこと: DNS の確認 → nginx をドメイン用に → SSL 証明書 (Let's Encrypt・自動更新) → APP_BASE_URL を https に →
#             アプリを 127.0.0.1:3000 だけで待ち受け (3000 番を閉じる) → 再起動 → 確認
#   このあとシステムの 設定 → 外部連携・AI で「LINE の Webhook URL をこのシステムに設定」を押す
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR=/srv/ichijoya
ENV_FILE=/etc/ichijoya/ichijoya.env
SRC="$APP_DIR/repo/deploy"
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "root で実行してください (sudo bash $0 <ドメイン> <メール>)"
[[ -n "$DOMAIN" && -n "$EMAIL" ]] || die "使い方: sudo bash $0 <ドメイン> <証明書の連絡先メール>"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "ドメインの形が正しくありません: $DOMAIN"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE がありません (先に setup-server.sh を実行してください)"

set_env() {
  KEY="$1" VAL="$2" awk 'BEGIN { done = 0 }
    !done && $0 ~ ("^#? ?" ENVIRON["KEY"] "=") { print ENVIRON["KEY"] "=" ENVIRON["VAL"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VAL"] }' "$ENV_FILE" > "$ENV_FILE.tmp"
  cat "$ENV_FILE.tmp" > "$ENV_FILE"
  rm -f "$ENV_FILE.tmp"
}

log "DNS の確認 ($DOMAIN)"
PUBLIC_IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)
SERVER_IPS="$(hostname -I) $PUBLIC_IP"
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [[ -z "$DNS_IP" ]]; then die "$DOMAIN の A レコードが見つかりません。DNS に「$DOMAIN → ${PUBLIC_IP:-この VPS の IP}」を設定し、反映を待ってください"; fi
if [[ " $SERVER_IPS " != *" $DNS_IP "* ]]; then die "$DOMAIN は $DNS_IP を向いています (この VPS: $PUBLIC_IP)。A レコードを直して、反映を待ってください"; fi
echo "  $DOMAIN → $DNS_IP (この VPS)"

log "パッケージ (certbot)"
command -v certbot >/dev/null || { apt-get update -y && apt-get install -y certbot python3-certbot-nginx; }

log "nginx をドメイン用にします"
sed "s/__DOMAIN__/$DOMAIN/g" "$SRC/nginx-ichijoya.conf" > /etc/nginx/sites-available/ichijoya
ln -sf /etc/nginx/sites-available/ichijoya /etc/nginx/sites-enabled/ichijoya
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "SSL 証明書 (Let's Encrypt。期限前に自動で更新されます)"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
systemctl reload nginx

log "設定ファイル: APP_BASE_URL=https://$DOMAIN · アプリは 127.0.0.1:3000 で待ち受け"
set_env APP_BASE_URL "https://$DOMAIN"
set_env BIND_HOST 127.0.0.1
chown root:ichijoya "$ENV_FILE"
chmod 640 "$ENV_FILE"

log "ファイアウォール: 3000 番を閉じます (外からは https だけ)"
ufw delete allow 3000/tcp >/dev/null 2>&1 || true
ufw status | sed 's/^/  /'

log "アプリを再起動します"
systemctl restart ichijoya
for _ in $(seq 1 60); do
  if curl -fsS -m 10 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then break; fi
  sleep 3
done
curl -fsS -m 30 "https://$DOMAIN/api/health" && echo || die "https://$DOMAIN/api/health に接続できません。journalctl -u ichijoya -n 100 と /var/log/nginx/error.log を確認してください"

log "完了: https://$DOMAIN"
cat <<EOF
  次の手順:
  1. 動作を確認する:   cd $APP_DIR/current && node scripts/ops/verify-production.mjs https://$DOMAIN
  2. 管理者でログインし、設定 → 外部連携・AI で
     「LINE の Webhook URL をこのシステムに設定」→「LINE・Chatwork の接続を確認」
  3. Chatwork の Webhook (ルームごと) の URL: https://$DOMAIN/api/integrations/chatwork
  4. 既存の AI システムの送信先: https://$DOMAIN/api/integrations/ai-intake?source=chat|voice|phone
     (ヘッダー Authorization: Bearer <設定ファイルの AI_INTAKE_SECRET>)
  5. Xserver VPS のパネルのパケットフィルターで 3000 番を許可していた場合は、削除してください
EOF
