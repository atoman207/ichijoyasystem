#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: バックアップ
#   毎日 3:30 に /etc/cron.d/ichijoya から実行。管理者は 設定 → データ管理 の「今すぐバックアップ」からいつでも実行できる
#
#   手動: sudo -u ichijoya bash /srv/ichijoya/current/deploy/backup.sh [--manual "<実行した人>"]
#   保存先はすべてこの VPS (BACKUP_DIR。既定 /var/backups/ichijoya):
#   1. データベース (Supabase の public スキーマ): pg_dump → db/ichijoya-<日時>[-manual].dump
#   2. 添付ファイル・写真 (VPS の /srv/ichijoya/data/uploads): 新しいファイルを storage/ に追加でコピー
#      (rsync。ファイルの中身は変わらないため増えた分だけ。アプリで削除したファイルもバックアップには残す)
#   3. チャットボットのデータベース (SQLite): VACUUM INTO → chatbot/chatbot-<日時>.sqlite
#      データ台帳の資料庫 (SQLite。人が変えた資料の扱い・画面から追加した資料の中身): VACUUM INTO → chatbot/materials-<日時>.sqlite
#   4. 古いバックアップを削除 (自動: BACKUP_KEEP_DAYS 日・既定 14 日 / 手動: BACKUP_KEEP_MANUAL_DAYS 日・既定 30 日)
#   5. 結果を BACKUP_STATUS_FILE に書き、履歴 (backup-history.jsonl) に 1 行足す (設定 → データ管理・本番運用の準備 に表示)
#   同時には 1 つだけ実行する (2 つ目は「実行中」で終わる)。復元の手順は deploy/README.md の「バックアップと復元」
# ============================================================
set -uo pipefail

TRIGGER=auto
BY=""
if [[ "${1:-}" == "--manual" ]]; then
  TRIGGER=manual
  BY="${2:-}"
fi

ENV_FILE=/etc/ichijoya/ichijoya.env
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
load_env "$ENV_FILE" || exit 1
DEST="${BACKUP_DIR:-/var/backups/ichijoya}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
KEEP_MANUAL="${BACKUP_KEEP_MANUAL_DAYS:-30}"
STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/ichijoya/backup-status.json}"
HISTORY_FILE="$(dirname "$STATUS_FILE")/backup-history.jsonl"
UPLOADS="${FILE_STORAGE_DIR:-/srv/ichijoya/data/uploads}"
STAMP=$(date +%Y%m%d-%H%M%S)
umask 077
mkdir -p "$DEST/db" "$DEST/storage" "$DEST/chatbot" "$(dirname "$STATUS_FILE")"

# 同時に 2 つ動かさない
exec 9>"$(dirname "$STATUS_FILE")/backup.lock"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] 別のバックアップが実行中のため終了します"
  exit 3
fi

started=$(date --iso-8601=seconds)
t0=$(date +%s)
write_status() { # $1 = JSON
  echo "$1" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
  chmod 644 "$STATUS_FILE"
}
write_status "$(jq -cn --arg started "$started" --arg trigger "$TRIGGER" --arg by "$BY" --argjson pid $$ '{status: "running", startedAt: $started, at: $started, trigger: $trigger, by: $by, pid: $pid}')"

status=ok
messages=()
db_file=""
db_size=0
suffix=$([[ "$TRIGGER" == manual ]] && echo "-manual" || echo "")

# 1. データベース
if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  db_file="$DEST/db/ichijoya-$STAMP$suffix.dump"
  # 権限 (anon・authenticated への取り消し、service_role への付与) も残す (--no-privileges は付けない)
  if PGCONNECT_TIMEOUT=20 pg_dump --no-owner --format=custom --schema=public --dbname="$SUPABASE_DB_URL" --file="$db_file.part" && mv "$db_file.part" "$db_file"; then
    db_size=$(stat -c %s "$db_file")
    # 中身を確かめる (表の一覧を読めるか)
    tables=$(pg_restore --list "$db_file" | grep -c ' TABLE DATA ' || true)
    messages+=("データベース: ${tables} 表・$((db_size / 1024)) KB")
    [[ "$tables" -ge 20 ]] || { status=failed; messages+=("データベースの表の数が少なすぎます (${tables})"); }
  else
    status=failed
    messages+=("データベースのバックアップに失敗しました (pg_dump)")
    rm -f "$db_file.part"
    db_file=""
  fi
else
  status=failed
  messages+=("SUPABASE_DB_URL が未設定のため、データベースをバックアップできません")
fi

# 2. 添付ファイル・写真 (VPS の保存先 → バックアップ。中身が変わらないので、まだないファイルだけコピー)
files=0
files_bytes=0
if [[ -d "$UPLOADS" ]]; then
  if copied=$(rsync -a --ignore-existing --exclude='*.tmp' --out-format='%n' "$UPLOADS/" "$DEST/storage/" 2>&1); then
    new=$(printf '%s' "$copied" | grep -c '[^/]$' || true)
    files=$(find "$DEST/storage" -type f | wc -l)
    files_bytes=$(du -sb "$DEST/storage" | cut -f1)
    messages+=("添付ファイル: ${files} 件 ($((files_bytes / 1048576)) MB)・新しくコピー ${new} 件")
  else
    status=failed
    messages+=("添付ファイルのバックアップに失敗しました: $(echo "$copied" | tail -n 1)")
  fi
else
  messages+=("添付ファイル: 保存先 $UPLOADS はまだありません (0 件)")
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

# 3b. データ台帳の資料庫 (クライアント資料の中身はファイルから作り直せるが、人が変えた扱いと追加した資料を残す)
MATERIALS_DB="${ICHIJOYA_MATERIALS_DB_PATH:-/srv/ichijoya/data/database/ichijoya-materials.sqlite}"
if [[ -f "$MATERIALS_DB" ]]; then
  mat_file="$DEST/chatbot/materials-$STAMP.sqlite"
  if node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("pragma busy_timeout = 10000"); db.prepare("vacuum into ?").run(process.argv[2]); db.close();' "$MATERIALS_DB" "$mat_file" 2>/dev/null; then
    messages+=("資料庫: $(( $(stat -c %s "$mat_file") / 1024 / 1024 )) MB")
  else
    messages+=("データ台帳の資料庫のバックアップに失敗しました")
    rm -f "$mat_file"
  fi
fi

# 4. 古いバックアップを削除 (手動で取ったものは長めに残す)
find "$DEST/db" -name 'ichijoya-*.dump' ! -name '*-manual.dump' -mtime +"$KEEP" -delete
find "$DEST/db" -name 'ichijoya-*-manual.dump' -mtime +"$KEEP_MANUAL" -delete
find "$DEST/db" -name '*.part' -mmin +120 -delete
find "$DEST/chatbot" -name 'chatbot-*.sqlite' -mtime +"$KEEP" -delete
find "$DEST/chatbot" -name 'materials-*.sqlite' -mtime +"$KEEP" -delete

# 5. 結果
kept=$(find "$DEST/db" -name 'ichijoya-*.dump' | wc -l)
disk=$(df -P "$DEST" | awk 'NR==2 {print $5}')
seconds=$(( $(date +%s) - t0 ))
msg=$(printf '%s / ' "${messages[@]}")
msg=${msg% / }
result=$(jq -cn --arg at "$(date --iso-8601=seconds)" --arg started "$started" --arg status "$status" --arg trigger "$TRIGGER" --arg by "$BY" \
  --arg file "$db_file" --argjson size "$db_size" --argjson files "$files" --argjson filesBytes "$files_bytes" --argjson kept "$kept" --arg disk "$disk" \
  --argjson seconds "$seconds" --arg msg "$msg" \
  '{at: $at, startedAt: $started, status: $status, trigger: $trigger, by: $by, dbFile: $file, dbBytes: $size, files: $files, filesBytes: $filesBytes, kept: $kept, diskUsed: $disk, seconds: $seconds, message: $msg}')
write_status "$result"
echo "$result" >> "$HISTORY_FILE"
# 履歴は新しい 200 件を残す
if [[ $(wc -l < "$HISTORY_FILE") -gt 200 ]]; then tail -n 200 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"; fi
chmod 644 "$HISTORY_FILE"
echo "[$(date '+%F %T')] $status ($TRIGGER${BY:+ $BY}): $msg"
[[ "$status" == "ok" ]]
