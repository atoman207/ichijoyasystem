#!/usr/bin/env bash
# 試験期間 (2026-11-23 0:00 〜 2026-12-01 0:00) の切り替え
# ------------------------------------------------------------
# 期間中は「データベースだけ」をテスト用にする。それ以外 (アプリの版・設定・メール・LINE・Chatwork・FAX・AI・外部からの受信) は本番と同じ。
#   - テスト用のデータベース: 切り替えた時点の本番のデータの写し (JSON。/srv/ichijoya/testweek/data)。
#     期間中の操作 (画面・外部からの受信・定期処理) はすべて写しに入り、本番のデータベース (Supabase) は変わらない
#   - テスト用のサーバー: systemd の ichijoya-testweek (127.0.0.1:3300)。アプリは本番の版 (/srv/ichijoya/current) のコピー、
#     設定は本番の設定 (/etc/ichijoya/ichijoya.env) からデータベースの接続だけを除いたもの
#   - https://ichijoya-system.jp のすべての要求をテスト用のサーバーへ (nginx の本番の設定ファイルは変えない。本番の server が読み込む
#     /etc/nginx/snippets/ichijoya-host-testweek.conf を置くだけ。消すと元に戻る)
#   - 本番の版を公開 (deploy.sh) すると、テスト用のサーバーも同じ版にそろえる (refresh-app。データはそのまま)
# 期間の終わり (12-01 0:00) に、外部から届いた記録を CSV に控えてから、画面を本番に戻し、テスト用のデータベースを削除する
#
# 使い方 (root):
#   sudo bash deploy/testweek.sh schedule     … 予約 (11-23 0:00 に start、12-01 0:00 に end) と、デプロイからの refresh-app の許可
#   sudo ichijoya-testweek start              … いますぐ切り替える
#   sudo ichijoya-testweek end                … いますぐ本番に戻し、テスト用のデータベースを削除する
#   sudo ichijoya-testweek status             … いまの状態
#   sudo ichijoya-testweek refresh-app        … テスト用のサーバーを本番の版にそろえる (deploy.sh が自動で実行)
#   ログ: /var/log/ichijoya/testweek.log
set -euo pipefail

W=/srv/ichijoya/testweek
DATA=$W/data
ENVF=$W/testweek.env
PROD_ENV=/etc/ichijoya/ichijoya.env
APP_USER=ichijoya
PORT=3300
UNIT=ichijoya-testweek
SNIPPET=/etc/nginx/snippets/ichijoya-host-testweek.conf
CRON=/etc/cron.d/ichijoya-testweek
SUDOERS=/etc/sudoers.d/ichijoya-testweek
BIN=/usr/local/sbin/ichijoya-testweek
LIB=/usr/local/lib/ichijoya/testweek-data.py
DOMAIN=ichijoya-system.jp
END_AT="2026-12-01 00:00"
EXPORT_DIR=/var/backups/ichijoya

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "エラー: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "root で実行してください: sudo bash $0 ${1:-}"
as_app() { runuser -u "$APP_USER" -- "$@"; }

health() { curl -fsS -m 10 "http://127.0.0.1:$1/api/health" 2>/dev/null || true; }
site() { curl -fsS -m 20 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1" 2>/dev/null || true; }
wait_test() { for _ in $(seq 1 120); do health $PORT | grep -q '"backend":"json"' && return 0; sleep 1; done; return 1; }
active() { [[ -f "$SNIPPET" ]]; }

# 本番の版をテスト用のサーバーのアプリにコピーする (ハードリンク。データは $DATA へのリンク)
prepare_app() {
  local dst=$1 rel
  rel=$(readlink -f /srv/ichijoya/current)
  [[ -x "$rel/node_modules/.bin/next" && -d "$rel/.next" ]] || die "本番の版 ($rel) が見つかりません"
  as_app rm -rf "$dst"
  as_app cp -al "$rel" "$dst"
  # テスト用のサーバーからはバックアップしない (本番のバックアップは本番で毎日実行)
  as_app rm -f "$dst/deploy/backup.sh"
  as_app sh -c "printf '#!/bin/sh\necho \"試験期間のテスト用サーバーではバックアップしません (本番のバックアップは本番で毎日実行)\"\nexit 0\n' > '$dst/deploy/backup.sh' && chmod 755 '$dst/deploy/backup.sh'"
  as_app rm -rf "$dst/data"
  as_app ln -sfn "$DATA" "$dst/data"
}

# 本番の設定から、データベースの接続とデータの置き場所だけを除き、テスト用の値を足す
make_env() {
  local out=$1
  [[ -r "$PROD_ENV" ]] || die "$PROD_ENV を読めません"
  {
    echo "# 試験期間のテスト用サーバーの設定 (deploy/testweek.sh が $PROD_ENV から作成。データベースだけがテスト用)"
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$PROD_ENV" \
      | grep -vE '^(SUPABASE_[A-Z_]*|NEXT_PUBLIC_SUPABASE_[A-Z_]*|DATA_BACKEND|DATA_FILE_NAME|BIND_HOST|PORT|NODE_ENV|BACKUP_[A-Z_]*|DB_SNAPSHOT|DB_CACHE_DIR|FILE_STORAGE_DIR|CHATBOT_DB_PATH|ICHIJOYA_[A-Z_]*|ROUTING_DB_PATH|MAP_IMPORT_DIR)='
    cat <<EOF
DATA_BACKEND=json
DATA_FILE_NAME=testweek-db.json
DB_SNAPSHOT=off
DB_CACHE_DIR=$DATA/cache
FILE_STORAGE_DIR=$DATA/uploads
CHATBOT_DB_PATH=$DATA/chatbot.sqlite
ICHIJOYA_DATA_DB_PATH=$DATA/database/ichijoya-data.sqlite
ICHIJOYA_MATERIALS_DB_PATH=$DATA/database/ichijoya-materials.sqlite
ICHIJOYA_SOURCE_DIR=$W/app/source
ROUTING_DB_PATH=$DATA/cache/routing.sqlite
BACKUP_DIR=$DATA/backups
BACKUP_STATUS_FILE=$DATA/backups/status.json
MAP_IMPORT_DIR=$DATA/map-import
EOF
  } > "$out.tmp"
  if grep -qE '^(SUPABASE_|NEXT_PUBLIC_SUPABASE_)' "$out.tmp" || ! grep -qx 'DATA_BACKEND=json' "$out.tmp"; then rm -f "$out.tmp"; die "テスト用の設定にデータベースの接続が残っています (中止)"; fi
  chown "$APP_USER:$APP_USER" "$out.tmp"
  chmod 600 "$out.tmp"
  mv "$out.tmp" "$out"
}

write_unit() {
  cat > "/etc/systemd/system/$UNIT.service" <<EOF
# 試験期間のテスト用サーバー (deploy/testweek.sh が作成・削除する)。データベースだけがテスト用 (本番のデータの写し・JSON)
[Unit]
Description=Ichijoya test-week server (test database, port $PORT)
After=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$W/app
EnvironmentFile=$ENVF
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
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
# 試験期間 (〜 $END_AT): すべての要求をテスト用のサーバー (127.0.0.1:$PORT。データベースだけがテスト用) へ (deploy/testweek.sh が作成・削除する)
location ~ ^/ {
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

remove_snippet() {
  if [[ -f "$SNIPPET" ]]; then
    rm -f "$SNIPPET"
    nginx -t && systemctl reload nginx
    log "画面を本番 (3000) に戻しました"
  fi
}

cmd_start() {
  [[ -f "$LIB" ]] || die "$LIB がありません (sudo bash deploy/testweek.sh schedule を先に実行してください)"
  if active && health $PORT | grep -q '"backend":"json"'; then log "すでに試験期間です"; return 0; fi
  mkdir -p "$W"; chown "$APP_USER:$APP_USER" "$W"
  if active && [[ -f "$DATA/testweek-db.json" ]]; then
    # 期間中にテスト用のサーバーが止まっていたとき: 期間中のデータのまま起動し直す (作り直さない)
    log "期間中のテスト用のデータベースのまま、テスト用のサーバーを起動し直します"
    make_env "$ENVF"
  else
    log "1. テスト用のサーバーのアプリ (本番の版 $(cut -c1-7 /srv/ichijoya/current/REVISION)) と設定を用意する"
    systemctl stop "$UNIT" 2>/dev/null || true
    prepare_app "$W/app"
    make_env "$ENVF"
    log "2. テスト用のデータベースを作る (いまの本番のデータの写し)"
    as_app python3 "$LIB" build "$W/app"
    rm -f "$W/build-data.py" "$W/collections.json"
  fi
  log "3. テスト用のサーバーを起動する (127.0.0.1:$PORT)"
  write_unit
  systemctl enable "$UNIT" >/dev/null 2>&1
  systemctl restart "$UNIT"
  wait_test || { systemctl stop "$UNIT" || true; remove_snippet; die "テスト用のサーバーが起動しませんでした (journalctl -u $UNIT)。画面は本番のままです"; }
  log "4. https://$DOMAIN をテスト用のサーバーに向ける (nginx)"
  write_snippet
  if ! nginx -t 2>/dev/null; then rm -f "$SNIPPET"; die "nginx の設定の確認に失敗しました。画面は本番のままです"; fi
  systemctl reload nginx
  sleep 2
  local h
  h=$(site /api/health)
  if ! grep -q '"backend":"json"' <<<"$h"; then
    log "確認に失敗しました (応答: ${h:-なし})。本番に戻します"
    remove_snippet
    exit 1
  fi
  log "試験期間に切り替えました (データベースだけがテスト用)。$END_AT に自動で本番に戻ります"
}

# 本番の版を新しくしたとき、テスト用のサーバーも同じ版にする (データはそのまま。止まるのは起動し直す十数秒)
cmd_refresh_app() {
  if ! active; then log "試験期間ではないため、テスト用のサーバーはそろえません (試験期間の開始のときに本番の版を使います)"; return 0; fi
  [[ -f "$DATA/testweek-db.json" ]] || die "テスト用のデータベースがありません"
  local rev
  rev=$(cut -c1-7 /srv/ichijoya/current/REVISION)
  log "テスト用のサーバーを本番の版 $rev にそろえます (データはそのまま)"
  prepare_app "$W/app.new"
  make_env "$ENVF.new"
  systemctl stop "$UNIT"
  as_app python3 "$LIB" add-missing "$W/app.new"
  as_app rm -rf "$W/app.old"
  as_app mv "$W/app" "$W/app.old"
  as_app mv "$W/app.new" "$W/app"
  cp -p "$ENVF" "$ENVF.old"
  mv "$ENVF.new" "$ENVF"
  systemctl start "$UNIT"
  if wait_test; then
    as_app rm -rf "$W/app.old"; rm -f "$ENVF.old"
    log "そろえました (版 $rev)"
  else
    log "新しい版のテスト用のサーバーが起動しないため、前の版に戻します (journalctl -u $UNIT)"
    systemctl stop "$UNIT" || true
    as_app rm -rf "$W/app.failed"
    as_app mv "$W/app" "$W/app.failed"
    as_app mv "$W/app.old" "$W/app"
    mv "$ENVF.old" "$ENVF"
    systemctl start "$UNIT"
    wait_test || true
    die "テスト用のサーバーを新しい版にできませんでした (前の版で動かしています)"
  fi
}

cmd_end() {
  log "1. 期間中に外部から届いた記録を控える"
  if [[ -f "$DATA/testweek-db.json" && -f "$LIB" ]]; then
    mkdir -p "$EXPORT_DIR"; chown "$APP_USER:$APP_USER" "$EXPORT_DIR" 2>/dev/null || true
    as_app python3 "$LIB" export-inbound "$EXPORT_DIR/testweek-inbound-$(date +%Y%m%d).csv" || log "注意: 控えを書き出せませんでした"
  fi
  log "2. 画面を本番に戻す"
  remove_snippet
  local h
  h=$(site /api/health)
  grep -q '"backend":"supabase"' <<<"$h" || log "注意: 本番の確認の応答が想定と違います: ${h:-なし} (systemctl status ichijoya を確かめてください)"
  log "3. テスト用のサーバーを止める"
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  log "4. テスト用のデータベースを削除する"
  rm -rf "$DATA" "$W/app" "$W/app.new" "$W/app.old" "$W/app.failed" "$ENVF" "$ENVF.new" "$ENVF.old"
  rm -f "$CRON" "$SUDOERS"
  log "試験期間を終えました: 画面・データは本番のデータベース (試験期間の前と同じ内容) です"
}

cmd_status() {
  if active; then echo "モード: 試験期間 (https://$DOMAIN → テスト用のサーバー 127.0.0.1:$PORT・データベースだけがテスト用)"; else echo "モード: 本番"; fi
  echo "本番 (3000):          $(health 3000 | head -c 200)"
  echo "テスト用 ($PORT):      $(health $PORT | head -c 200)"
  echo "https://$DOMAIN: $(site /api/health | head -c 200)"
  [[ -f /srv/ichijoya/current/REVISION ]] && echo "本番の版: $(cut -c1-7 /srv/ichijoya/current/REVISION)"
  [[ -f "$W/app/REVISION" ]] && echo "テスト用のサーバーの版: $(cut -c1-7 "$W/app/REVISION")"
  [[ -f "$DATA/testweek-db.json" ]] && echo "テスト用のデータベース: $(du -h "$DATA/testweek-db.json" | cut -f1)"
  [[ -f "$CRON" ]] && { echo "予約:"; grep -E '^[0-9]' "$CRON"; }
  return 0
}

cmd_schedule() {
  install -d -o root -g root -m 755 /usr/local/lib/ichijoya
  install -o root -g root -m 755 "$(readlink -f "$0")" "$BIN"
  install -o root -g root -m 755 "$(dirname "$(readlink -f "$0")")/testweek-data.py" "$LIB"
  mkdir -p /var/log/ichijoya "$W"; chown "$APP_USER:$APP_USER" "$W"
  cat > "$CRON" <<EOF
# 試験期間の切り替えの予約 (deploy/testweek.sh schedule が作成。end のあとに自動で削除される)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TZ=Asia/Tokyo
0 0 23 11 * root [ "\$(date +\%Y)" = "2026" ] && $BIN start >> /var/log/ichijoya/testweek.log 2>&1
0 0 1 12 * root [ "\$(date +\%Y)" = "2026" ] && $BIN end >> /var/log/ichijoya/testweek.log 2>&1
# 期間中のテスト用のサーバーの死活監視 (応答がなければ起動し直す。試験期間でないときは何もしない)
*/5 * * * * root bash /srv/ichijoya/current/deploy/run-task.sh health-testweek >> /var/log/ichijoya/health.log 2>&1
EOF
  chmod 644 "$CRON"
  # デプロイ (ichijoya ユーザー) から、テスト用のサーバーを本番の版にそろえられるようにする
  echo "$APP_USER ALL=(root) NOPASSWD: $BIN refresh-app, $BIN status" > "$SUDOERS.tmp"
  chmod 440 "$SUDOERS.tmp"
  if visudo -cf "$SUDOERS.tmp" >/dev/null; then mv "$SUDOERS.tmp" "$SUDOERS"; else rm -f "$SUDOERS.tmp"; die "sudoers の確認に失敗しました"; fi
  log "予約しました: 2026-11-23 0:00 に試験期間へ切り替え、$END_AT に本番に戻してテスト用のデータベースを削除します (ログ: /var/log/ichijoya/testweek.log)"
  log "期間中のデプロイでは、テスト用のサーバーも自動で同じ版にそろえます"
}

case "${1:-}" in
  start) cmd_start ;;
  end) cmd_end ;;
  status) cmd_status ;;
  refresh-app) cmd_refresh_app ;;
  schedule) cmd_schedule ;;
  *) echo "使い方: sudo bash $0 {schedule|start|end|status|refresh-app}"; exit 1 ;;
esac
