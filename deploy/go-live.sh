#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: 本番公開 (1 回の実行で、初期設定 → ビルド・起動 → ドメインでの公開 まで)
#
#   使い方 (このリポジトリのフォルダで。何度実行してもよい):
#     sudo bash deploy/go-live.sh <ドメイン> <証明書の連絡先メール>
#   例: sudo bash deploy/go-live.sh ichijoya-system.jp admin@example.jp
#
#   1. setup-server.sh --ip   パッケージ・実行ユーザー・設定ファイル (.env.local の値を写す)・systemd・nginx・
#                             ファイアウォール・定期実行 (バックアップ・死活監視・社内資料の同期)
#   2. deploy.sh              このリポジトリのコミット済みの main をビルドし、本番 (3000 番・常駐・再起動後も自動で起動) を開始
#   3. enable-domain.sh       DNS がこの VPS を向いていれば、すぐに https://<ドメイン> で公開。
#                             まだなら 5 分ごとに確かめる定期実行を置き、向いた時点で自動で公開する
#
#   本番 (3000 番) はコミット済みの内容で動く。作業中の変更は npm run dev (3001 番) で確認し、
#   コミットしてから npm run deploy で本番に出す
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
APP_USER=ichijoya
WATCH_CRON=/etc/cron.d/ichijoya-domain
log() { printf '\n\033[1;35m######## %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "root で実行してください: sudo bash $0 <ドメイン> <メール>"
[[ -n "$DOMAIN" && -n "$EMAIL" ]] || die "使い方: sudo bash $0 <ドメイン> <証明書の連絡先メール>"
# git はリポジトリの持ち主 (ichijoya) で実行する (root で他人のリポジトリを触ると git が拒否するため)
as_app() { sudo -u "$APP_USER" "$@"; }
as_app git -C "$REPO_DIR" rev-parse --verify -q main >/dev/null || die "$REPO_DIR に main ブランチがありません"
echo "公開するコミット: $(as_app git -C "$REPO_DIR" log -1 --format='%h %s' main)"
if [[ -n "$(as_app git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
  echo "注意: コミットしていない変更は本番に出ません (コミット済みの main を公開します)"
fi
ENV_FROM=()
[[ -r "$REPO_DIR/.env.local" ]] && ENV_FROM=(--env-from "$REPO_DIR/.env.local")

# 取得用のリポジトリ (/srv/ichijoya/repo。setup-server.sh がひな形を読む) を最新のコミットにそろえる
sync_repo() {
  [[ -d /srv/ichijoya/repo/.git ]] || return 0
  as_app git -C /srv/ichijoya/repo fetch -q --prune origin
  as_app git -C /srv/ichijoya/repo checkout -q --detach origin/main
}

log "1/3 サーバーの初期設定"
sync_repo
bash "$REPO_DIR/deploy/setup-server.sh" --ip --repo "$REPO_DIR" "${ENV_FROM[@]}"
sync_repo

log "2/3 ビルドして本番を起動 (3000 番)"
as_app bash "$REPO_DIR/deploy/deploy.sh"
systemctl is-enabled ichijoya >/dev/null && echo "  再起動後も自動で起動します (systemctl is-enabled ichijoya: enabled)"

log "3/3 ドメインでの公開 ($DOMAIN)"
set +e
bash "$REPO_DIR/deploy/enable-domain.sh" --if-ready "$DOMAIN" "$EMAIL"
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  # まだ公開できない (DNS が向いていない・証明書が取れない): 5 分ごとに確かめ、できた時点で自動で公開する
  # (公開できたら enable-domain.sh がこの定期実行を消す。証明書の失敗のあとは 1 時間あけて再試行する)
  cat > "$WATCH_CRON" <<EOF
# 一畳屋 業務システム: https://$DOMAIN で公開できるまで確かめる (公開後に自動で削除される)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root bash /srv/ichijoya/current/deploy/enable-domain.sh --if-ready $DOMAIN $EMAIL >> /var/log/ichijoya/domain.log 2>&1
EOF
  chmod 644 "$WATCH_CRON"
  PUBLIC_IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo
  echo "  本番 (3000 番) は起動しています。https://$DOMAIN の公開はまだです:"
  if [[ $rc -eq 3 ]]; then
    echo "  - DNS の A レコードを「$DOMAIN → $PUBLIC_IP」にしてください (www は CNAME のままで構いません)"
  else
    echo "  - 証明書を取得できませんでした。VPS のパネルのファイアウォールで HTTP (80)・HTTPS (443) を許可してください"
  fi
  echo "  - 直れば自動で https://$DOMAIN を公開します (経過: sudo tail -f /var/log/ichijoya/domain.log)"
  echo "  - それまでは http://$PUBLIC_IP:3000 で開けます (パネルのファイアウォールで 3000 番を許可している場合)"
fi

log "バックアップを 1 回実行して確かめます"
as_app bash /srv/ichijoya/current/deploy/backup.sh 2>&1 | tail -n 3 || echo "  バックアップに失敗しました (/var/log/ichijoya/backup.log)"

log "状態"
echo "  本番 (3000 番): $(systemctl is-active ichijoya) / 起動時に自動: $(systemctl is-enabled ichijoya)"
echo "  nginx: $(systemctl is-active nginx) / 証明書の自動更新: $(systemctl is-active certbot.timer 2>/dev/null || echo '-')"
echo "  健康状態: $(curl -fsS -m 20 http://127.0.0.1:3000/api/health || echo '応答なし')"
echo "  開発用 (作業中の変更): cd $REPO_DIR && npm run dev  → http://localhost:3001"
