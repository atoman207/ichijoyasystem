#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: サーバーを止めない設定 (Xserver VPS。何度実行しても同じ状態になる)
#
#   sudo bash deploy/harden-server.sh          (このリポジトリのフォルダーで。setup-server.sh からも呼ばれる)
#
#   1. スリープ・休止をしない (画面の操作がなくても、ログイン画面のままでも止まらない)
#   2. OS の自動更新 (セキュリティ更新) は続けるが、自動で再起動はしない。更新は夜 4:30 (バックアップの後)
#   3. 本番のアプリ (ichijoya) と nginx は、止まっても数秒で起動し直す (回数の上限なし)。VPS の起動時に自動で起動する
#      アプリはメモリ不足のときに最後に止められるようにする (開発用のサーバー・エディタが先)
#   4. カーネルが致命的なエラーで止まったときは、止まったままにせず 10 秒後に起動し直す (アプリは自動で起動する)
#   5. スワップ (メモリの予備) が 6 GB より少なければ 4 GB 足す (ビルド・開発用のサーバーと同時に動かすため)
#   6. ログ (journal) を再起動のあとも残す (止まった理由を後から確かめられるように)
#   アプリの再起動はしない (新しいサービスの設定は、次のデプロイ・再起動のときに使われる)
# ============================================================
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "root で実行してください: sudo bash $0"; exit 1; }
SRC="$(dirname "$(readlink -f "$0")")"
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "1. スリープ・休止をしない"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target >/dev/null 2>&1 || true
install -d /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/ichijoya-no-sleep.conf <<'EOF'
# 一畳屋 業務システム: サーバーなのでスリープ・休止・電源ボタンでの停止をしない (deploy/harden-server.sh)
[Login]
HandleSuspendKey=ignore
HandleHibernateKey=ignore
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
echo "  スリープ: $(systemctl is-enabled suspend.target 2>/dev/null || true) (masked = 無効)"

log "2. 自動更新で勝手に再起動しない (セキュリティ更新は続ける・夜 4:30 に実行)"
cat > /etc/apt/apt.conf.d/52ichijoya-no-reboot <<'EOF'
// 一畳屋 業務システム: セキュリティ更新は自動で入れるが、自動では再起動しない (deploy/harden-server.sh)
// カーネルの更新を使うには、業務時間外に sudo reboot する (アプリは自動で起動する)
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
EOF
install -d /etc/systemd/system/apt-daily-upgrade.timer.d
cat > /etc/systemd/system/apt-daily-upgrade.timer.d/ichijoya.conf <<'EOF'
# 一畳屋 業務システム: 更新 (サービスの入れ替えを含む) は業務時間外の 4:30〜4:45 に行う (バックアップ 3:30 の後)
[Timer]
OnCalendar=
OnCalendar=*-*-* 04:30
RandomizedDelaySec=15m
EOF

log "3. 本番のアプリと nginx: 止まっても自動で起動し直す・VPS の起動時に自動で起動する"
install -m 644 "$SRC/ichijoya.service" /etc/systemd/system/ichijoya.service
install -d /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/ichijoya-restart.conf <<'EOF'
# 一畳屋 業務システム: nginx が止まっても 3 秒後に起動し直す (回数の上限なし) (deploy/harden-server.sh)
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=always
RestartSec=3
EOF
systemctl daemon-reload
systemctl restart apt-daily-upgrade.timer
systemctl enable ichijoya nginx cron >/dev/null 2>&1
systemctl enable certbot.timer >/dev/null 2>&1 || true
# 定期実行 (バックアップ・死活監視など) も最新にする
install -m 644 "$SRC/ichijoya.cron" /etc/cron.d/ichijoya
install -d -o ichijoya -g ichijoya /var/log/ichijoya /var/lib/ichijoya /var/backups/ichijoya /srv/ichijoya/data
install -d -o ichijoya -g ichijoya -m 750 /srv/ichijoya/data/uploads
chmod 750 /var/backups/ichijoya

log "4. カーネルが止まったら 10 秒後に起動し直す"
cat > /etc/sysctl.d/90-ichijoya.conf <<'EOF'
# 一畳屋 業務システム: カーネルが致命的なエラー (panic) で止まったときは 10 秒後に起動し直す (deploy/harden-server.sh)
kernel.panic = 10
EOF
sysctl -q -w kernel.panic=10

log "5. スワップ (メモリの予備)"
SWAP_KB=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
if [[ $SWAP_KB -lt 6000000 && ! -f /swapfile-ichijoya ]]; then
  fallocate -l 4G /swapfile-ichijoya
  chmod 600 /swapfile-ichijoya
  mkswap /swapfile-ichijoya >/dev/null
  swapon /swapfile-ichijoya
  grep -q '/swapfile-ichijoya' /etc/fstab || echo '/swapfile-ichijoya none swap sw 0 0' >> /etc/fstab
  echo "  4 GB 足しました"
else
  echo "  そのまま ($((SWAP_KB / 1024)) MB)"
fi

log "6. ログ (journal) を再起動のあとも残す"
install -d -m 2755 -g systemd-journal /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
systemctl kill --kill-whom=main --signal=SIGUSR1 systemd-journald >/dev/null 2>&1 || true

log "確認"
printf '  %-34s %s\n' \
  "スリープ (suspend.target)" "$(systemctl is-enabled suspend.target 2>/dev/null || true)" \
  "自動の再起動 (unattended-upgrades)" "$(apt-config dump 2>/dev/null | grep -i 'Automatic-Reboot "' | head -n 1 | sed 's/.*"\(.*\)".*/\1/')" \
  "更新の時刻" "$(systemctl show apt-daily-upgrade.timer -p TimersCalendar --value 2>/dev/null | grep -o 'OnCalendar=[^;]*' | head -n 1)" \
  "アプリ (ichijoya) 起動時に自動" "$(systemctl is-enabled ichijoya)" \
  "アプリの再起動の設定" "$(systemctl show ichijoya -p Restart --value) / 上限 $(systemctl show ichijoya -p StartLimitBurst --value) 回 ($(systemctl show ichijoya -p StartLimitIntervalUSec --value))" \
  "nginx 起動時に自動 / 再起動" "$(systemctl is-enabled nginx) / $(systemctl show nginx -p Restart --value)" \
  "cron (バックアップ・死活監視)" "$(systemctl is-enabled cron)" \
  "kernel.panic" "$(sysctl -n kernel.panic) 秒" \
  "スワップ" "$(free -h | awk '/Swap/ {print $2}')"
[[ -f /var/run/reboot-required ]] && echo "  ※ カーネルの更新が再起動待ちです。業務時間外に sudo reboot してください (アプリは自動で起動します)。"
echo
echo "  アプリのサービスの新しい設定は、次のデプロイ (npm run deploy) か sudo systemctl restart ichijoya で使われます。"
