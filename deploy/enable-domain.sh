#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: ドメインでの公開 (http://<IP> → https://<ドメイン>)
#
#   使い方: sudo bash deploy/enable-domain.sh [--if-ready] <ドメイン> <証明書の連絡先メール>
#   例:     sudo bash deploy/enable-domain.sh ichijoya-system.jp admin@example.jp
#
#   前提: DNS の A レコード (<ドメイン> → この VPS の IP アドレス) が反映されていること。
#         www.<ドメイン> も同じ IP を向いていれば、証明書に含めて https://<ドメイン> へ転送する
#   --if-ready: DNS がまだこの VPS を向いていなければ何もせずに終わる (終了コード 3)。
#         go-live.sh が置く定期実行 (/etc/cron.d/ichijoya-domain) から使い、公開できたら定期実行を消す
#
#   行うこと: DNS の確認 → nginx をドメイン用に → SSL 証明書 (Let's Encrypt。先に試験用で確かめてから本番を取得・自動更新) →
#             www の転送 → APP_BASE_URL を https に → アプリを 127.0.0.1:3000 だけで待ち受け (3000 番を閉じる) →
#             再起動 → 確認 → LINE の Webhook URL をこのドメインに (LINE の設定があるとき)
# ============================================================
set -euo pipefail

IF_READY=0
if [[ "${1:-}" == "--if-ready" ]]; then IF_READY=1; shift; fi
DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR=/srv/ichijoya
ENV_FILE=/etc/ichijoya/ichijoya.env
SRC="$(dirname "$(readlink -f "$0")")"
WATCH_CRON=/etc/cron.d/ichijoya-domain
FAIL_MARK=/var/lib/ichijoya/domain-cert-failed
log() { printf '\n\033[1;34m==> [%s] %s\033[0m\n' "$(date '+%F %T')" "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }
not_ready() { echo "[$(date '+%F %T')] 待機: $*"; exit 3; }

[[ $EUID -eq 0 ]] || die "root で実行してください (sudo bash $0 <ドメイン> <メール>)"
[[ -n "$DOMAIN" && -n "$EMAIL" ]] || die "使い方: sudo bash $0 [--if-ready] <ドメイン> <証明書の連絡先メール>"
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
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-; }
resolve() { { getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
# 外からの接続は NAT でこの VPS の内側に届くため、自分の公開 IP へは接続できないことがある。
# 確認は nginx (127.0.0.1:443) に本物のドメイン名で接続して行う
local_https() { curl -fsS -m "${2:-20}" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1"; }

# 公開できるまで 5 分ごとに確かめる定期実行 (このドメインで置き直す。公開できたら最後に消す)
install_watch() {
  mkdir -p /var/log/ichijoya
  cat > "$WATCH_CRON" <<EOF
# 一畳屋 業務システム: https://$DOMAIN で公開できるまで確かめる (公開後に自動で削除される)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root bash $APP_DIR/current/deploy/enable-domain.sh --if-ready $DOMAIN $EMAIL >> /var/log/ichijoya/domain.log 2>&1
EOF
  chmod 644 "$WATCH_CRON"
}

# この VPS 自身 (リモート デスクトップで使うブラウザー・定期実行など) からもドメインで開けるようにする。
# NAT の内側の VPS は自分の公開 IP に接続できない (ヘアピン NAT がない) ため、ドメインを 127.0.0.1 (この VPS の nginx) に向ける。
# /etc/hosts はこの VPS の中だけで使われるので、外の利用者・LINE・Let's Encrypt には関係しない
ensure_local_hosts() {
  local pub="${1:-}" line="127.0.0.1 $DOMAIN www.$DOMAIN # ichijoya-domain"
  [[ -n "$pub" ]] || return 0
  # 公開 IP が VPS 自身に付いている (NAT でない) ときは不要
  if ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qxF "$pub"; then return 0; fi
  grep -qxF "$line" /etc/hosts && return 0
  sed -i '/# ichijoya-domain$/d' /etc/hosts
  echo "$line" >> /etc/hosts
  echo "  /etc/hosts: $DOMAIN → 127.0.0.1 (NAT のため。この VPS のブラウザーからもドメインで開けます)"
}

# 同時に 2 つ動かさない (手動の実行と定期実行が重なったとき、certbot と nginx の設定がぶつからないように)
exec 9>/run/lock/ichijoya-enable-domain.lock
if ! flock -n 9; then
  [[ $IF_READY -eq 1 ]] && not_ready "別の enable-domain.sh が実行中です"
  echo "別の enable-domain.sh (定期実行) が実行中です。終わるのを待ちます…"
  flock -w 900 9 || die "待ちきれませんでした。しばらくしてから再実行してください"
fi

# ---- 公開済みなら何もしない ----
if [[ "$(env_value APP_BASE_URL)" == "https://$DOMAIN" && -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]] && local_https /api/health 10 >/dev/null 2>&1; then
  rm -f "$WATCH_CRON" "$FAIL_MARK"
  ensure_local_hosts "$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
  [[ $IF_READY -eq 1 ]] && exit 0
  echo "https://$DOMAIN で公開済みです。"
  exit 0
fi

# 手動で実行したとき: 定期実行をこのドメインで置き直す (前に別のドメイン名で置いていても直る)。
# このあと DNS の確認や証明書の取得に失敗しても、5 分ごとに再試行し、できた時点で自動で公開する
if [[ $IF_READY -eq 0 ]]; then install_watch; fi

# ---- DNS の確認 ----
PUBLIC_IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)
SERVER_IPS=" $(hostname -I) $PUBLIC_IP "
DNS_IP=$(resolve "$DOMAIN")
if [[ -z "$DNS_IP" || "$SERVER_IPS" != *" ${DNS_IP%% *} "* ]]; then
  msg="$DOMAIN の A レコードは ${DNS_IP:-(なし)} です。この VPS (${PUBLIC_IP:-?}) を向けてください"
  [[ $IF_READY -eq 1 ]] && not_ready "$msg"
  die "$msg (反映には数分〜数時間かかることがあります)"
fi
NAMES=("$DOMAIN")
WWW_IP=$(resolve "www.$DOMAIN")
if [[ -n "$WWW_IP" && "$SERVER_IPS" == *" ${WWW_IP%% *} "* ]]; then NAMES+=("www.$DOMAIN"); fi

# 証明書の確認・取得に失敗した直後は少しあける (定期実行のとき)。
# 試験用 (dry-run・回数制限が緩い) の失敗は約 10 分、本番の取得の失敗は Let's Encrypt の回数制限にかからないよう 1 時間
if [[ $IF_READY -eq 1 && -f "$FAIL_MARK" ]]; then
  wait_s=3600
  grep -q 'dry-run' "$FAIL_MARK" && wait_s=540
  if (( $(date +%s) - $(stat -c %Y "$FAIL_MARK") < wait_s )); then
    not_ready "前回の証明書の確認に失敗したため、少しあけて再試行します ($(cat "$FAIL_MARK"))"
  fi
fi

log "ドメインで公開します: ${NAMES[*]} → この VPS ($PUBLIC_IP)"

log "パッケージ (certbot)"
command -v certbot >/dev/null || { apt-get update -y && apt-get install -y certbot python3-certbot-nginx; }

log "nginx をドメイン用にします"
install -d /etc/nginx/snippets
rm -f /etc/nginx/snippets/ichijoya-host.conf
sed "s/server_name __DOMAIN__;/server_name ${NAMES[*]};/; s/__DOMAIN__/$DOMAIN/g" "$SRC/nginx-ichijoya.conf" > /etc/nginx/sites-available/ichijoya
ln -sf /etc/nginx/sites-available/ichijoya /etc/nginx/sites-enabled/ichijoya
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "SSL 証明書 (Let's Encrypt)"
CERT_ARGS=()
for n in "${NAMES[@]}"; do CERT_ARGS+=(-d "$n"); done
mkdir -p "$(dirname "$FAIL_MARK")"
# まず試験用 (回数制限が緩い) で、外から 80 番に届くかを確かめる
if ! certbot certonly --nginx --dry-run "${CERT_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL"; then
  echo "$(date '+%F %T') dry-run failed" > "$FAIL_MARK"
  die "証明書の確認 (試験用) に失敗しました。主な原因は、外 (Let's Encrypt) から http://$DOMAIN (80 番) に届かないことです。
   - VPS のパネルのファイアウォールで HTTP (80)・HTTPS (443) を許可してください
     (Xserver VPS: VPS パネル → パケットフィルター設定 → フィルタールールを追加 → 「Web」)
   - 許可したあとは何もしなくてかまいません。定期実行が約 10 分ごとに再試行し、届いた時点で自動で公開します
     (経過: /var/log/ichijoya/domain.log)"
fi
if ! certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring --expand; then
  echo "$(date '+%F %T') issue failed" > "$FAIL_MARK"
  die "証明書を取得できませんでした (/var/log/letsencrypt/letsencrypt.log を確認してください)"
fi
rm -f "$FAIL_MARK"
# www は https://<ドメイン> へ転送する (ログインの Cookie を 1 つのドメインにそろえる)
if [[ " ${NAMES[*]} " == *" www.$DOMAIN "* ]]; then
  printf 'if ($host = www.%s) { return 301 https://%s$request_uri; }\n' "$DOMAIN" "$DOMAIN" > /etc/nginx/snippets/ichijoya-host.conf
fi
nginx -t
systemctl reload nginx
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

log "設定ファイル: APP_BASE_URL=https://$DOMAIN · アプリは 127.0.0.1:3000 で待ち受け"
set_env APP_BASE_URL "https://$DOMAIN"
set_env BIND_HOST 127.0.0.1
chown root:ichijoya "$ENV_FILE"
chmod 640 "$ENV_FILE"

log "ファイアウォール: 3000 番を閉じます (外からは https だけ)"
if command -v ufw >/dev/null; then
  ufw delete allow 3000/tcp >/dev/null 2>&1 || true
  ufw status | sed 's/^/  /'
fi

log "アプリを再起動します"
systemctl restart ichijoya
ok=0
for _ in $(seq 1 60); do
  if local_https /api/health 10 >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[[ $ok -eq 1 ]] || die "https://$DOMAIN/api/health に応答がありません。journalctl -u ichijoya -n 100 と /var/log/nginx/error.log を確認してください"
echo "  $(local_https /api/health)"
if [[ " ${NAMES[*]} " == *" www.$DOMAIN "* ]]; then
  echo "  www: $(curl -s -o /dev/null -m 10 -w '%{http_code} → %{redirect_url}' --resolve "www.$DOMAIN:443:127.0.0.1" "https://www.$DOMAIN/")"
fi
ensure_local_hosts "$PUBLIC_IP"

# ---- LINE の Webhook URL をこのドメインにする (チャネルアクセストークンがあるとき) ----
(
  # shellcheck source=deploy/lib.sh
  . "$SRC/lib.sh"
  load_env "$ENV_FILE" >/dev/null 2>&1 || exit 0
  [[ -n "${LINE_CHANNEL_ACCESS_TOKEN:-}" ]] || exit 0
  url="https://$DOMAIN/api/integrations/line"
  log "LINE の Webhook URL を $url にします"
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -X PUT -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" -H 'Content-Type: application/json' -d "{\"endpoint\":\"$url\"}" https://api.line.me/v2/bot/channel/webhook/endpoint || true)
  echo "  設定: HTTP $code"
  # LINE のサーバーからこのドメインへ試しに送る (外から https (443 番) で届くかの確認にもなる)
  res=$(curl -s -m 40 -X POST -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" -H 'Content-Type: application/json' -d "{\"endpoint\":\"$url\"}" https://api.line.me/v2/bot/channel/webhook/test || true)
  if [[ "$res" == *'"success":true'* ]]; then
    echo "  LINE のサーバーから $url に届きました (外から https で接続できています)"
  else
    echo "  LINE のサーバーから届きませんでした: ${res:-応答なし}"
    echo "  → VPS のパネルのファイアウォール (パケットフィルター) で HTTPS (443) を許可しているか確認してください"
  fi
) || true

rm -f "$WATCH_CRON"
if command -v node >/dev/null && [[ -f "$APP_DIR/current/scripts/ops/verify-production.mjs" ]]; then
  log "動作確認 (verify-production)"
  node "$APP_DIR/current/scripts/ops/verify-production.mjs" "https://$DOMAIN" || echo "  (確認できなかった項目があります。上の結果を確認してください)"
fi
log "完了: https://$DOMAIN"
cat <<EOF
  - 証明書は自動で更新されます (certbot.timer)。確認: sudo certbot certificates
  - 動作確認:  node $APP_DIR/current/scripts/ops/verify-production.mjs https://$DOMAIN
  - LINE: LINE Developers の「Webhook の利用」と、LINE Official Account Manager の 応答設定 → Webhook をオンにしてください
  - Chatwork の Webhook (ルームごと) の URL: https://$DOMAIN/api/integrations/chatwork
  - 既存の AI システムの送信先: https://$DOMAIN/api/integrations/ai-intake?source=chat|voice|phone
    (ヘッダー Authorization: Bearer <$ENV_FILE の AI_INTAKE_SECRET>)
EOF
