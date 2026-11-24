#!/usr/bin/env bash
# 定期実行の処理 (deploy/ichijoya.cron から呼ぶ)
#   knowledge-sync: 社内資料 (Google スプレッドシート) を同期する
#   fax:            FAX の定期処理 (送信の状態の確認・通信エラーの自動の再送・AI の判定待ちの読み直し)。FAX_PROVIDER が未設定なら何もしない
#   chatbot-eval:   AI アシスタントの精度の評価 (正解付きの質問を AI に聞いて採点する。結果は AI アシスタント →「品質・費用」)
#   survey-workbook: お客様アンケート集計表 (Google スプレッドシート) の同期。KPI → スプレッドシートの取込 で「定期の同期」がオンのときだけ取り込む
#   inquiry-followup: 期限を過ぎた問い合わせの依頼の再通知 (日本時間 8〜20 時だけ送る)
#   health:         /api/health を確かめ、2 回続けて応答がなければアプリを再起動する
set -uo pipefail
ENV_FILE=/etc/ichijoya/ichijoya.env
BASE=http://127.0.0.1:3000
# 試験期間 (deploy/testweek.sh) は、データを扱う定期処理をテスト用のサーバー (テスト用のデータベース) に送る。死活監視は両方
TESTWEEK_SNIPPET=/etc/nginx/snippets/ichijoya-host-testweek.conf
TEST_BASE=http://127.0.0.1:3300
DATA_BASE=$BASE
[[ -f "$TESTWEEK_SNIPPET" ]] && DATA_BASE=$TEST_BASE

case "${1:-}" in
  knowledge-sync)
    # shellcheck source=deploy/lib.sh
    . "$(dirname "$(readlink -f "$0")")/lib.sh"
    load_env "$ENV_FILE" || exit 1
    [[ -n "${CRON_SECRET:-}" ]] || { echo "[$(date '+%F %T')] CRON_SECRET が未設定"; exit 1; }
    out=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $CRON_SECRET" "$DATA_BASE/api/cron/knowledge-sync")
    echo "[$(date '+%F %T')] knowledge-sync: $out"
    ;;
  fax)
    # shellcheck source=deploy/lib.sh
    . "$(dirname "$(readlink -f "$0")")/lib.sh"
    load_env "$ENV_FILE" || exit 1
    [[ -n "${FAX_PROVIDER:-}" ]] || exit 0
    [[ -n "${CRON_SECRET:-}" ]] || { echo "[$(date '+%F %T')] CRON_SECRET が未設定"; exit 1; }
    out=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $CRON_SECRET" "$DATA_BASE/api/cron/fax")
    echo "[$(date '+%F %T')] fax: $out"
    ;;
  chatbot-eval)
    # shellcheck source=deploy/lib.sh
    . "$(dirname "$(readlink -f "$0")")/lib.sh"
    load_env "$ENV_FILE" || exit 1
    [[ -n "${CRON_SECRET:-}" ]] || { echo "[$(date '+%F %T')] CRON_SECRET が未設定"; exit 1; }
    out=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/chatbot-eval")
    echo "[$(date '+%F %T')] chatbot-eval: $out"
    ;;
  survey-workbook)
    # shellcheck source=deploy/lib.sh
    . "$(dirname "$(readlink -f "$0")")/lib.sh"
    load_env "$ENV_FILE" || exit 1
    [[ -n "${CRON_SECRET:-}" ]] || { echo "[$(date '+%F %T')] CRON_SECRET が未設定"; exit 1; }
    out=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $CRON_SECRET" "$DATA_BASE/api/cron/survey-workbook")
    echo "[$(date '+%F %T')] survey-workbook: $out"
    ;;
  inquiry-followup)
    # 期限を過ぎた問い合わせの依頼の再通知 (src/lib/inquiry-followup.ts。画面を開いている社員がいるときは画面の読み込みからも動く)
    # shellcheck source=deploy/lib.sh
    . "$(dirname "$(readlink -f "$0")")/lib.sh"
    load_env "$ENV_FILE" || exit 1
    [[ -n "${CRON_SECRET:-}" ]] || { echo "[$(date '+%F %T')] CRON_SECRET が未設定"; exit 1; }
    out=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $CRON_SECRET" "$DATA_BASE/api/cron/inquiry-followup")
    echo "[$(date '+%F %T')] inquiry-followup: $out"
    ;;
  health)
    if curl -fsS -m 20 "$BASE/api/health" >/dev/null 2>&1; then exit 0; fi
    sleep 20
    if curl -fsS -m 20 "$BASE/api/health" >/dev/null 2>&1; then exit 0; fi
    echo "[$(date '+%F %T')] 応答がないため再起動します"
    systemctl restart ichijoya
    logger -t ichijoya "health check failed twice; restarted ichijoya"
    ;;
  health-testweek)
    [[ -f "$TESTWEEK_SNIPPET" ]] || exit 0
    if curl -fsS -m 20 "$TEST_BASE/api/health" >/dev/null 2>&1; then exit 0; fi
    sleep 20
    if curl -fsS -m 20 "$TEST_BASE/api/health" >/dev/null 2>&1; then exit 0; fi
    echo "[$(date '+%F %T')] テスト用のサーバーの応答がないため再起動します"
    systemctl restart ichijoya-testweek
    logger -t ichijoya "test-week health check failed twice; restarted ichijoya-testweek"
    ;;
  *)
    echo "使い方: $0 knowledge-sync|fax|chatbot-eval|survey-workbook|health|health-testweek"
    exit 1
    ;;
esac
