#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: デプロイ (更新) / ロールバック
#
#   最新の main を公開:     sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh
#   版を指定して公開:       sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh <コミット・タグ・ブランチ>
#   1 つ前の版に戻す:       sudo -u ichijoya bash /srv/ichijoya/repo/deploy/deploy.sh --rollback
#
#   流れ: 取得 → releases/<日時> に展開 → npm ci → npm run build (データベースの表の追加を含む) →
#         current を切り替え → 再起動 → /api/health を確認 (失敗したら前の版に戻す) → 古い版を削除 (5 つ残す)
#   データベースの更新は「表・列の追加」だけ (データの削除・型の変更はしない)
# ============================================================
set -euo pipefail

APP_DIR=/srv/ichijoya
REPO="$APP_DIR/repo"
ENV_FILE=/etc/ichijoya/ichijoya.env
KEEP=5
HEALTH=http://127.0.0.1:3000/api/health
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[[ "$(id -un)" == "ichijoya" ]] || die "ichijoya ユーザーで実行してください: sudo -u ichijoya bash $0 $*"
[[ -r "$ENV_FILE" ]] || die "$ENV_FILE を読めません (setup-server.sh を先に実行してください)"

wait_healthy() {
  for _ in $(seq 1 60); do
    if body=$(curl -fsS -m 10 "$HEALTH" 2>/dev/null) && [[ "$(echo "$body" | jq -r '.ok')" == "true" ]]; then
      echo "  $body"
      return 0
    fi
    sleep 3
  done
  return 1
}

switch_to() {
  ln -sfn "$1" "$APP_DIR/current.new"
  mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
  sudo /usr/bin/systemctl restart ichijoya
}

if [[ "${1:-}" == "--rollback" ]]; then
  CUR=$(readlink -f "$APP_DIR/current" || true)
  PREV=$(ls -1d "$APP_DIR"/releases/*/ 2>/dev/null | sed 's#/$##' | grep -vx "$CUR" | sort | tail -n 1)
  [[ -n "$PREV" ]] || die "戻せる版がありません"
  log "前の版に戻します: $(basename "$PREV") ($(cat "$PREV/REVISION" 2>/dev/null || echo '?'))"
  switch_to "$PREV"
  wait_healthy || die "戻した版も起動しませんでした。journalctl -u ichijoya -n 200 を確認してください"
  log "戻しました"
  exit 0
fi

REF="${1:-origin/main}"
log "ソースコードを取得します ($REF)"
git -C "$REPO" fetch --prune --tags origin
COMMIT=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
STAMP=$(date +%Y%m%d-%H%M%S)
REL="$APP_DIR/releases/$STAMP"
mkdir -p "$REL"
git -C "$REPO" archive "$COMMIT" | tar -x -C "$REL"
echo "$COMMIT" > "$REL/REVISION"
echo "  $COMMIT → $REL"

log "依存パッケージ (npm ci)"
cd "$REL"
npm ci --no-audit --no-fund --loglevel=error

log "ビルド (npm run build: データベースの表の追加 → next build)"
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
load_env "$ENV_FILE"
export NODE_ENV=production
npm run build

PREV=$(readlink -f "$APP_DIR/current" 2>/dev/null || true)
log "公開します (current → $STAMP)"
switch_to "$REL"
if ! wait_healthy; then
  echo "  起動を確認できませんでした。ログ (最後の 50 行):"
  journalctl -u ichijoya -n 50 --no-pager 2>/dev/null || true
  if [[ -n "$PREV" && -d "$PREV" ]]; then
    log "前の版 ($(basename "$PREV")) に戻します"
    switch_to "$PREV"
    wait_healthy || true
  fi
  die "デプロイに失敗しました (版 $STAMP は残してあります)"
fi

log "古い版を削除します (新しい $KEEP 版を残す)"
ls -1d "$APP_DIR"/releases/*/ | sed 's#/$##' | sort | head -n -"$KEEP" | while read -r old; do
  [[ "$old" == "$(readlink -f "$APP_DIR/current")" ]] || rm -rf "$old"
done
log "完了: $COMMIT"
