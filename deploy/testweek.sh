#!/usr/bin/env bash
# 試験期間 (2026-11-23 0:00 〜 2026-12-01 0:00) の切り替え
# ------------------------------------------------------------
# 期間中は https://ichijoya-system.jp の画面を「テスト用のデータベース」のサーバーに向ける。
#   - テスト用のデータベース = 切り替えた時点の本番のデータの写し (JSON。/srv/ichijoya/testweek/app/data)。
#     期間中の登録・変更・削除はすべて写しに入り、本番のデータベース (Supabase) は一切変わらない
#   - テスト用のサーバー: systemd の ichijoya-testweek (127.0.0.1:3300)。本番のデータベースの鍵・メール・LINE・Chatwork・FAX の
#     設定を持たない (何も送信しない)
#   - 外部からの受信 (/api/integrations/: LINE・Web フォーム・AI 受付など) と、お客様に送った書類のリンク (/api/doc/) は
#     本番 (127.0.0.1:3000) のまま (本当の受付を失わないため)。定期処理 (cron) も本番のまま
#   - nginx の本番の設定ファイルは変えない。本番の server が読み込む /etc/nginx/snippets/ichijoya-host*.conf に
#     1 つのファイル (ichijoya-host-testweek.conf) を置くだけ。消すと元に戻る
# 期間の終わり (12-01 0:00) に、画面を本番に戻し、テスト用のサーバーを止め、テスト用のデータベースを削除する
#
# 使い方 (root):
#   sudo bash deploy/testweek.sh schedule     … 11-23 0:00 に start、12-01 0:00 に end を自動で実行するよう予約する
#   sudo ichijoya-testweek start              … いますぐ切り替える (予約を待たないとき)
#   sudo ichijoya-testweek end                … いますぐ本番に戻し、テスト用のデータベースを削除する
#   sudo ichijoya-testweek status             … いまの状態
#   sudo ichijoya-testweek refresh-app        … 期間中に本番の版を新しくしたとき、テスト用のサーバーの版もそろえる (データは残す)
#   ログ: /var/log/ichijoya/testweek.log
set -euo pipefail

W=/srv/ichijoya/testweek
APP_USER=ichijoya
PORT=3300
UNIT=ichijoya-testweek
SNIPPET=/etc/nginx/snippets/ichijoya-host-testweek.conf
CRON=/etc/cron.d/ichijoya-testweek
BIN=/usr/local/sbin/ichijoya-testweek
DOMAIN=ichijoya-system.jp
END_AT="2026-12-01 00:00"

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "エラー: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "root で実行してください: sudo bash $0 ${1:-}"

health() { curl -fsS -m 10 "http://127.0.0.1:$1/api/health" 2>/dev/null || true; }
site() { curl -fsS -m 20 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1" 2>/dev/null || true; }
# 外部からの受信が本番に届くか: 本番には AI_INTAKE_SECRET があるので鍵なしは 401、テスト用は鍵がないので 503
intake_status() { curl -s -o /dev/null -w '%{http_code}' -m 20 --resolve "$DOMAIN:443:127.0.0.1" -X POST -H 'content-type: application/json' -d '{}' "https://$DOMAIN/api/integrations/ai-intake?source=phone" || true; }

remove_snippet() {
  if [[ -f "$SNIPPET" ]]; then
    rm -f "$SNIPPET"
    nginx -t && systemctl reload nginx
    log "画面を本番 (3000) に戻しました"
  fi
}

write_unit() {
  cat > "/etc/systemd/system/$UNIT.service" <<EOF
# 試験期間のテスト用サーバー (deploy/testweek.sh が作成・削除する)。本番のデータの写し (JSON) を使う
[Unit]
Description=Ichijoya test-week server (copy of production data, port $PORT)
After=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$W/app
EnvironmentFile=$W/testweek.env
Environment=NODE_ENV=production
ExecStart=$W/app/node_modules/.bin/next start -p $PORT -H 127.0.0.1
Restart=always
RestartSec=3
TimeoutStartSec=180
MemoryMax=2G
# 期間中は利用者が使うサーバーなので、エディターなどより後に止められるようにする (本番は -900)
OOMScoreAdjust=-800
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

write_snippet() {
  cat > "$SNIPPET.tmp" <<EOF
# 試験期間 (〜 $END_AT): 画面はテスト用のデータベースのサーバー (127.0.0.1:$PORT) へ (deploy/testweek.sh が作成・削除する)
# 外部からの受信 (/api/integrations/) と、お客様に送った書類のリンク (/api/doc/) は、この下の location / で本番 (3000) へ
location ~ ^/(?!api/integrations/|api/doc/) {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header Connection "";
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
EOF
  mv "$SNIPPET.tmp" "$SNIPPET"
}

check_env() {
  [[ -f "$W/testweek.env" && -x "$W/app/node_modules/.bin/next" && -f "$W/build-data.py" ]] || die "$W にテスト用のサーバーの準備がありません"
  grep -qx 'DATA_BACKEND=json' "$W/testweek.env" || die "testweek.env が DATA_BACKEND=json ではありません (本番のデータベースを使わないように中止)"
  if grep -qE '^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|SMTP_|MAIL_FROM|LINE_|CHATWORK_|FAX_|RESEND_|SENDGRID_|AI_INTAKE_SECRET|WEBFORM_SECRET|CRON_SECRET)' "$W/testweek.env"; then
    die "testweek.env に本番のデータベース・送信の設定があります (中止)"
  fi
}

cmd_start() {
  check_env
  if [[ -f "$SNIPPET" ]] && health $PORT | grep -q '"backend":"json"'; then log "すでに試験期間の切り替え済みです"; return 0; fi
  if [[ -f "$SNIPPET" && -f "$W/app/data/testweek-db.json" ]]; then
    # 期間中にテスト用のサーバーが止まっていたとき: 期間中のデータを残したまま起動し直す (作り直さない)
    log "1. 期間中のテスト用のデータベースを使って起動し直す (作り直さない)"
  else
    # 切り替えの時点の本番のデータで作り直す (前に作った写しは使わない)
    log "1. テスト用のデータベースを作る (いまの本番のデータの控えの写し)"
    runuser -u "$APP_USER" -- python3 "$W/build-data.py"
  fi
  log "2. テスト用のサーバーを起動する (127.0.0.1:$PORT)"
  write_unit
  systemctl enable --now "$UNIT" >/dev/null 2>&1
  systemctl restart "$UNIT"
  for _ in $(seq 1 120); do health $PORT | grep -q '"backend":"json"' && break; sleep 1; done
  health $PORT | grep -q '"backend":"json"' || { systemctl stop "$UNIT" || true; die "テスト用のサーバーが起動しませんでした (journalctl -u $UNIT)。画面は本番のままです"; }
  log "3. 画面をテスト用のサーバーに向ける (nginx)"
  write_snippet
  if ! nginx -t 2>/dev/null; then rm -f "$SNIPPET"; die "nginx の設定の確認に失敗しました。画面は本番のままです"; fi
  systemctl reload nginx
  sleep 2
  local h s
  h=$(site /api/health)
  s=$(intake_status)
  if ! grep -q '"backend":"json"' <<<"$h" || [[ "$s" != "401" ]]; then
    log "確認に失敗しました (画面: ${h:-応答なし} / 受信: $s)。本番に戻します"
    remove_snippet
    exit 1
  fi
  log "試験期間に切り替えました: 画面 = テスト用のデータベース、外部からの受信 = 本番 (HTTP $s)。$END_AT に自動で本番に戻ります"
}

cmd_end() {
  log "1. 画面を本番に戻す"
  remove_snippet
  local h
  h=$(site /api/health)
  grep -q '"backend":"supabase"' <<<"$h" || log "注意: 本番の確認の応答が想定と違います: ${h:-応答なし} (systemctl status ichijoya を確かめてください)"
  log "2. テスト用のサーバーを止める"
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  log "3. テスト用のデータベースを削除する"
  rm -rf "$W/app/data" "$W/testweek.env"
  rm -f "$CRON"
  log "試験期間を終えました: 画面・データは本番のデータベース (試験期間の前と同じ内容) です"
}

cmd_status() {
  if [[ -f "$SNIPPET" ]]; then echo "モード: 試験期間 (画面 = テスト用のデータベース 127.0.0.1:$PORT)"; else echo "モード: 本番 (画面 = 本番のデータベース)"; fi
  echo "本番 (3000):   $(health 3000 | head -c 200)"
  echo "テスト (3300): $(health $PORT | head -c 200)"
  echo "https://$DOMAIN: $(site /api/health | head -c 200)"
  echo "外部からの受信 (鍵なしの POST): HTTP $(intake_status) (401 = 本番が受ける)"
  [[ -f "$CRON" ]] && { echo "予約:"; grep -v '^#' "$CRON" | grep -v '^$' | grep -v '^[A-Z]'; }
  [[ -f "$W/app/data/testweek-db.json" ]] && echo "テスト用のデータベース: $(du -h "$W/app/data/testweek-db.json" | cut -f1)"
  return 0
}

cmd_refresh_app() {
  check_env
  local rel
  rel=$(readlink -f /srv/ichijoya/current)
  log "テスト用のサーバーの版を $(cat "$rel/REVISION" 2>/dev/null | cut -c1-7) にそろえる (データは残す)"
  systemctl stop "$UNIT" || true
  mv "$W/app/data" "$W/data.keep"
  rm -rf "$W/app"
  runuser -u "$APP_USER" -- cp -al "$rel" "$W/app"
  rm -f "$W/app/deploy/backup.sh"
  printf '#!/bin/sh\necho "試験期間のテスト用サーバーではバックアップしません"\nexit 0\n' > "$W/app/deploy/backup.sh"
  chmod 755 "$W/app/deploy/backup.sh"; chown "$APP_USER:$APP_USER" "$W/app/deploy/backup.sh"
  mv "$W/data.keep" "$W/app/data"
  systemctl start "$UNIT"
  for _ in $(seq 1 120); do health $PORT | grep -q '"backend":"json"' && break; sleep 1; done
  health $PORT | grep -q '"backend":"json"' && log "そろえました" || die "テスト用のサーバーが起動しません (journalctl -u $UNIT)"
}

cmd_schedule() {
  check_env
  install -o root -g root -m 755 "$(readlink -f "$0")" "$BIN"
  mkdir -p /var/log/ichijoya
  cat > "$CRON" <<EOF
# 試験期間の切り替えの予約 (deploy/testweek.sh schedule が作成。end のあとに自動で削除される)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TZ=Asia/Tokyo
0 0 23 11 * root [ "\$(date +\%Y)" = "2026" ] && $BIN start >> /var/log/ichijoya/testweek.log 2>&1
0 0 1 12 * root [ "\$(date +\%Y)" = "2026" ] && $BIN end >> /var/log/ichijoya/testweek.log 2>&1
EOF
  chmod 644 "$CRON"
  log "予約しました: 2026-11-23 0:00 に試験期間へ切り替え、$END_AT に本番に戻してテスト用のデータベースを削除します (ログ: /var/log/ichijoya/testweek.log)"
  log "いますぐ切り替えるときは: sudo $BIN start"
}

case "${1:-}" in
  start) cmd_start ;;
  end) cmd_end ;;
  status) cmd_status ;;
  refresh-app) cmd_refresh_app ;;
  schedule) cmd_schedule ;;
  *) echo "使い方: sudo bash $0 {schedule|start|end|status|refresh-app}"; exit 1 ;;
esac
