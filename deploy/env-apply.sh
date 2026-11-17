#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: 本番の設定ファイル (/etc/ichijoya/ichijoya.env) に値を書き込み、アプリを再起動する
#
#   使い方: sudo bash deploy/env-apply.sh <KEY=値 の行を書いたファイル>
#   例:     sudo bash deploy/env-apply.sh ~/.config/ichijoya/smtp.env
#
#   - ファイルの KEY=値 の行だけを使う (# の行・空行は無視)。同じ KEY は上書き、ない KEY は追加
#   - 秘密の値をコマンドに直接書かずに済む (sudo のログ・シェルの履歴に残らない)
#   - 値は表示しない (書き込んだ KEY の名前だけを表示する)
# ============================================================
set -euo pipefail

SRC_FILE="${1:-}"
ENV_FILE=/etc/ichijoya/ichijoya.env
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "root で実行してください: sudo bash $0 <ファイル>"
[[ -n "$SRC_FILE" && -r "$SRC_FILE" ]] || die "使い方: sudo bash $0 <KEY=値 の行を書いたファイル>"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE がありません (先に setup-server.sh / go-live.sh を実行してください)"

set_env() {
  KEY="$1" VAL="$2" awk 'BEGIN { done = 0 }
    !done && $0 ~ ("^#? ?" ENVIRON["KEY"] "=") { print ENVIRON["KEY"] "=" ENVIRON["VAL"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VAL"] }' "$ENV_FILE" > "$ENV_FILE.tmp"
  cat "$ENV_FILE.tmp" > "$ENV_FILE"
  rm -f "$ENV_FILE.tmp"
}

cp -p "$ENV_FILE" "$ENV_FILE.bak"
keys=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
  set_env "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  keys+=("${BASH_REMATCH[1]}")
done < "$SRC_FILE"
[[ ${#keys[@]} -gt 0 ]] || die "$SRC_FILE に KEY=値 の行がありません"
chown root:ichijoya "$ENV_FILE"
chmod 640 "$ENV_FILE"
echo "書き込みました: ${keys[*]} (変更前の設定: $ENV_FILE.bak)"

echo "アプリを再起動します…"
systemctl restart ichijoya
for _ in $(seq 1 60); do
  if body=$(curl -fsS -m 10 http://127.0.0.1:3000/api/health 2>/dev/null); then echo "  $body"; echo "完了"; exit 0; fi
  sleep 3
done
die "再起動後に応答がありません。journalctl -u ichijoya -n 100 を確認してください (元に戻す: sudo cp -p $ENV_FILE.bak $ENV_FILE && sudo systemctl restart ichijoya)"
