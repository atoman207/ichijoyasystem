#!/usr/bin/env bash
# 定期実行の処理 (deploy/ichijoya.cron から呼ぶ)
#   knowledge-sync: 社内資料 (Google スプレッドシート) を同期する
#   health:         /api/health を確かめ、2 回続けて応答がなければアプリを再起動する
set -uo pipefail
ENV_FILE=/etc/ichijoya/ichijoya.env
BASE=http://127.0.0.1:3000

case "${1:-}" in
  knowledge-sync)
    # shellcheck source=deploy/lib.sh
    . "$(dirname "$(readlink -f "$0")")/lib.sh"
    load_env "$ENV_FILE" || exit 1
    [[ -n "${CRON_SECRET:-}" ]] || { echo "[$(date '+%F %T')] CRON_SECRET が未設定"; exit 1; }
    out=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/knowledge-sync")
    echo "[$(date '+%F %T')] knowledge-sync: $out"
    ;;
  health)
    if curl -fsS -m 20 "$BASE/api/health" >/dev/null 2>&1; then exit 0; fi
    sleep 20
    if curl -fsS -m 20 "$BASE/api/health" >/dev/null 2>&1; then exit 0; fi
    echo "[$(date '+%F %T')] 応答がないため再起動します"
    systemctl restart ichijoya
    logger -t ichijoya "health check failed twice; restarted ichijoya"
    ;;
  *)
    echo "使い方: $0 knowledge-sync|health"
    exit 1
    ;;
esac
