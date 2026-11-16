#!/usr/bin/env bash
# deploy/*.sh で共通の処理

# 設定ファイル (KEY=値 の行) を環境変数にする。
# bash の「. ファイル」で読むと、値の空白や < > (例: MAIL_FROM=会社名 <info@…>) が壊れるため 1 行ずつ読む。
# systemd の EnvironmentFile と同じく、値の前後の " または ' は外す
load_env() {
  local file="$1" line key val
  [[ -r "$file" ]] || { echo "$file を読めません" >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${line#*=}"
    # 前後の空白を除く (systemd と同じ)
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    export "$key=$val"
  done < "$file"
}
