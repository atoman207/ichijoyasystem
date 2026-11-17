#!/usr/bin/env bash
# ============================================================
# 一畳屋 業務システム: 本番の設定ファイル (/etc/ichijoya/ichijoya.env) に値を書き込み、アプリを再起動する
#
#   使い方: sudo bash deploy/env-apply.sh <KEY=値 の行を書いたファイル> [--keys "前方一致の KEY ..."]
#   例:     sudo bash deploy/env-apply.sh ~/.config/ichijoya/smtp.env
#           npm run env:apply   (= .env.local の外部連携の値 (SMTP・LINE・Chatwork など) だけを本番に写す)
#
#   - ファイルの KEY=値 の行だけを使う (# の行・空行は無視)。同じ KEY は上書き、ない KEY は追加
#   - 値が空の行は写さない (ひな形の「KEY=」で本番の値を消さないため)
#   - --keys を付けると、その名前で始まる KEY だけを写す (開発用の値を本番に持ち込まないため)
#   - 秘密の値をコマンドに直接書かずに済む (sudo のログ・シェルの履歴に残らない)
#   - 値は表示しない (書き込んだ KEY の名前だけを表示する)
# ============================================================
set -euo pipefail

SRC_FILE="${1:-}"
KEYS_FILTER=""
if [[ "${2:-}" == "--keys" ]]; then KEYS_FILTER="${3:-}"; fi
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

wanted() {
  [[ -z "$KEYS_FILTER" ]] && return 0
  local p
  for p in $KEYS_FILTER; do [[ "$1" == "$p"* ]] && return 0; done
  return 1
}
current() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-; }

cp -p "$ENV_FILE" "$ENV_FILE.bak"
changed=()
same=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"
  val="${BASH_REMATCH[2]}"
  [[ -n "$val" ]] || continue
  wanted "$key" || continue
  if [[ "$(current "$key")" == "$val" ]]; then same+=("$key"); continue; fi
  set_env "$key" "$val"
  changed+=("$key")
done < "$SRC_FILE"
chown root:ichijoya "$ENV_FILE"
chmod 640 "$ENV_FILE"
[[ ${#same[@]} -gt 0 ]] && echo "変更なし: ${same[*]}"
if [[ ${#changed[@]} -eq 0 ]]; then
  rm -f "$ENV_FILE.bak"
  echo "本番の設定はすでに同じです (再起動しません)"
  exit 0
fi
echo "書き込みました: ${changed[*]} (変更前の設定: $ENV_FILE.bak)"

echo "アプリを再起動します…"
systemctl restart ichijoya
for _ in $(seq 1 60); do
  if body=$(curl -fsS -m 10 http://127.0.0.1:3000/api/health 2>/dev/null); then echo "  $body"; echo "完了"; exit 0; fi
  sleep 3
done
die "再起動後に応答がありません。journalctl -u ichijoya -n 100 を確認してください (元に戻す: sudo cp -p $ENV_FILE.bak $ENV_FILE && sudo systemctl restart ichijoya)"
