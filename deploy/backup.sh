#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: バックアップ (毎日 3:30 に /etc/cron.d/ichijoya から実行)
#
#   手動: sudo -u ichijoya bash /srv/ichijoya/current/deploy/backup.sh
#   1. データベース: pg_dump (Supabase の public スキーマ・カスタム形式) → /var/backups/ichijoya/db/ichijoya-<日時>.dump
#   2. 添付ファイル (Supabase Storage): 新しいファイルだけ /var/backups/ichijoya/storage/ に追加でコピー
#   3. チャットボットのデータベース (SQLite): VACUUM INTO → /var/backups/ichijoya/chatbot/chatbot-<日時>.sqlite
#   4. 古いバックアップを削除 (BACKUP_KEEP_DAYS 日。既定 14 日)
#   5. 結果を BACKUP_STATUS_FILE に書く (設定 → 本番運用の準備 で確認できる)
#   復元の手順は deploy/README.md の「復元」を参照
# ============================================================
set -uo pipefail

ENV_FILE=/etc/ichijoya/ichijoya.env
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
load_env "$ENV_FILE" || exit 1
DEST="${BACKUP_DIR:-/var/backups/ichijoya}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/ichijoya/backup-status.json}"
APP=/srv/ichijoya/current
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST/db" "$DEST/storage" "$DEST/chatbot"
umask 077

status=ok
messages=()
db_file=""
db_size=0
started=$(date --iso-8601=seconds)

# 1. データベース
if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  db_file="$DEST/db/ichijoya-$STAMP.dump"
  # 権限 (anon・authenticated への取り消し、service_role への付与) も残す (--no-privileges は付けない)
  if PGCONNECT_TIMEOUT=20 pg_dump --no-owner --format=custom --schema=public --dbname="$SUPABASE_DB_URL" --file="$db_file"; then
    db_size=$(stat -c %s "$db_file")
    # 中身を確かめる (表の一覧を読めるか)
    tables=$(pg_restore --list "$db_file" | grep -c ' TABLE DATA ' || true)
    messages+=("データベース: ${tables} 表・$((db_size / 1024)) KB")
    [[ "$tables" -ge 20 ]] || { status=failed; messages+=("データベースの表の数が少なすぎます (${tables})"); }
  else
    status=failed
    messages+=("データベースのバックアップに失敗しました (pg_dump)")
    rm -f "$db_file"
    db_file=""
  fi
else
  status=failed
  messages+=("SUPABASE_DB_URL が未設定のため、データベースをバックアップできません")
fi

# 2. 添付ファイル
if out=$(node "$APP/scripts/ops/backup-storage.mjs" --dest="$DEST/storage" 2>&1); then
  messages+=("$(echo "$out" | tail -n 1)")
else
  status=failed
  messages+=("添付ファイルのバックアップに失敗しました: $(echo "$out" | tail -n 1)")
fi

# 3. チャットボットのデータベース (まだ作られていなければ何もしない。失敗しても業務データのバックアップは成功のまま)
CHATBOT_DB="${CHATBOT_DB_PATH:-/srv/ichijoya/data/chatbot.sqlite}"
if [[ -f "$CHATBOT_DB" ]]; then
  bot_file="$DEST/chatbot/chatbot-$STAMP.sqlite"
  if node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("pragma busy_timeout = 10000"); db.prepare("vacuum into ?").run(process.argv[2]); db.close();' "$CHATBOT_DB" "$bot_file" 2>/dev/null; then
    messages+=("チャットボット: $(( $(stat -c %s "$bot_file") / 1024 )) KB")
  else
    messages+=("チャットボットのデータベースのバックアップに失敗しました")
    rm -f "$bot_file"
  fi
fi

# 4. 古いバックアップを削除
find "$DEST/db" -name 'ichijoya-*.dump' -mtime +"$KEEP" -delete
find "$DEST/chatbot" -name 'chatbot-*.sqlite' -mtime +"$KEEP" -delete

# 5. 結果
kept=$(find "$DEST/db" -name 'ichijoya-*.dump' | wc -l)
disk=$(df -P "$DEST" | awk 'NR==2 {print $5}')
jq -n --arg at "$(date --iso-8601=seconds)" --arg started "$started" --arg status "$status" --arg file "$db_file" --argjson size "$db_size" --argjson kept "$kept" --arg disk "$disk" --arg msg "$(IFS=' / '; echo "${messages[*]}")" \
  '{at: $at, startedAt: $started, status: $status, dbFile: $file, dbBytes: $size, kept: $kept, diskUsed: $disk, message: $msg}' > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
chmod 644 "$STATUS_FILE"
echo "[$(date '+%F %T')] $status: ${messages[*]}"
[[ "$status" == "ok" ]]
