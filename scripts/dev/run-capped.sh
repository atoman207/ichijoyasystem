#!/usr/bin/env bash
# ============================================================
# 重い処理 (開発用のサーバー・ビルド) を、メモリの上限つきの別の枠 (systemd のスコープ) で動かす
#
#   bash scripts/dev/run-capped.sh <dev|build|test> <コマンド...>
#   例: bash scripts/dev/run-capped.sh dev next dev -p 3001   (npm run dev)
#
# なぜ: この VPS (メモリ 7.7 GB) では、エディター (Cursor) の端末から起動した next dev / next build が
#   6〜7 GB まで増えると、OS のメモリ不足の対処 (systemd-oomd) が「エディターの枠」ごと止めるため、
#   エディター・AI のセッション・リモートデスクトップの画面がまとめて消えていた (2026-11-18〜20 に 4 回)。
#   別の枠に入れると、上限を超えたときに止まるのはこの処理だけになる (エディターと本番のアプリは残る)。
#
# 上限 (枠ごと。メモリが上限に達すると枠の中だけでスワップへ逃がし、スワップの上限も超えたらこの処理だけを止める):
#   dev   : メモリ 3 GB + スワップ 2 GB
#   build : メモリ 4 GB + スワップ 4 GB
#   test  : 試験用のサーバー (next start -p 3100 など)。メモリ 2.5 GB + スワップ 1 GB
#   ICHIJOYA_MEM_MAX / ICHIJOYA_MEM_SWAP で上書き、ICHIJOYA_MEM_LIMIT=off で上限なし
#   MemoryHigh (やわらかい上限) は使わない: スワップに逃がせないと止まらずに固まり続けるため (2026-11-20 に確認)
# systemd のユーザーの枠が使えない環境 (Vercel・CI・mac・cron など) では、そのまま実行する
# ============================================================
set -euo pipefail

profile="${1:-}"
shift || true
if [[ $# -eq 0 ]]; then
  echo "使い方: bash scripts/dev/run-capped.sh <dev|build|test> <コマンド...>" >&2
  exit 2
fi

case "$profile" in
  dev) max=3G swap=2G ;;
  build) max=4G swap=4G ;;
  test) max=2560M swap=1G ;;
  *) echo "run-capped.sh: 種類は dev / build / test のどれか ($profile)" >&2; exit 2 ;;
esac
max="${ICHIJOYA_MEM_MAX:-$max}"
swap="${ICHIJOYA_MEM_SWAP:-$swap}"

# 上限なしの指定・systemd-run がない・ユーザーの systemd に接続できない → そのまま実行
if [[ "${ICHIJOYA_MEM_LIMIT:-on}" == "off" ]] || ! command -v systemd-run >/dev/null 2>&1 \
  || ! timeout 5 systemd-run --user --scope --quiet --collect -- true >/dev/null 2>&1; then
  exec "$@"
fi

# すでに上限つきの枠の中 (二重に入れない)
if grep -q 'ichijoya-capped-' /proc/self/cgroup 2>/dev/null; then
  exec "$@"
fi

echo "[run-capped] ${profile}: メモリの上限 ${max} (+ スワップ ${swap}) の別の枠で実行します (エディターと分離)" >&2
exec systemd-run --user --scope --quiet --collect \
  --unit="ichijoya-capped-${profile}-$$" \
  -p MemoryMax="$max" -p MemorySwapMax="$swap" \
  -- "$@"
