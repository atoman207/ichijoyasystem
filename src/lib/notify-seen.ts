/**
 * ヘッダーの数字 (ベル・メニューのタブ・承認のアイコン) の「確認済み」(お客様のご要望 2026-11-26:
 * 通知を確認したら数字が小さくなり、すべて確認したら数字が消える)。
 *
 * - 数字の元になる記録 1 件ごとにキーを付ける (例: 問い合わせ inq:<ID>、承認 apv:<ID>)。サーバー (src/app/(app)/layout.tsx) が作る
 * - 確認したキーはブラウザーに保存し (AppShell)、数字は確認していないキーの数だけを出す。0 件なら数字を出さない
 * - 確認 = ベルの通知を押す / その記録の画面を開く (`viewPaths`)。一覧でしか見られない記録 (承認・休暇・縁在庫など) は一覧の画面
 * - 状態が変わって改めて知らせたい記録は、キーに印 (@ のあと) を付ける (例: 予定の変更日時)。印が変われば新しい通知になる
 *
 * import なし (クライアントとサーバーの両方で使う)。
 */

/** キーの種類 → その記録を確認したことになる画面。`?k=v` は検索の値が v、`?k=` は k がない (既定のタブ) のとき */
const VIEW_PATHS: Record<string, (id: string) => string[]> = {
  inq: (id) => [`/inquiries/${id}`],
  rcp: (id) => [`/inquiries/reception/${id}`],
  inv: (id) => [`/invoices/${id}`],
  fax: (id) => [`/fax/${id}`],
  ev: (id) => [`/schedule/${id}`, `/schedule/${id}/edit`],
  cf: (id) => [...id.split("+").map((e) => `/schedule/${e}`), "/schedule?conflicts=1"],
  apv: () => ["/approvals?tab=mine", "/approvals?tab="],
  lv: () => ["/leave?tab=approve", "/leave?tab="],
  heri: () => ["/heri"],
  su: () => ["/staff"],
  dr: (id) => [`/ai/drafts/${id}`],
  cp: (id) => [`/materials/cases/${id}`],
  kn: (id) => [`/knowledge/${id}`],
  ks: (id) => [`/knowledge/sources/${id}`],
  kc: () => ["/knowledge"],
  chg: (id) => [`/notices/${id}/open`, "/notices"],
  th: (id) => [`/messages/${id}`],
};

/** キーを作る (stamp: 状態が変わったら改めて知らせるための印) */
export function seenKey(kind: keyof typeof VIEW_PATHS, id: string, stamp?: string | number): string {
  return `${kind}:${id}${stamp !== undefined && stamp !== "" ? `@${stamp}` : ""}`;
}

/** キーの記録を確認したことになる画面 */
export function viewPaths(key: string): string[] {
  const i = key.indexOf(":");
  if (i < 0) return [];
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  const at = rest.indexOf("@");
  const id = at < 0 ? rest : rest.slice(0, at);
  return VIEW_PATHS[kind]?.(id) ?? [];
}

/** 画面 (pathname + 検索) が型 (`/approvals?tab=mine` など) に当たるか */
export function pathMatches(pattern: string, pathname: string, search: URLSearchParams): boolean {
  const q = pattern.indexOf("?");
  const path = q < 0 ? pattern : pattern.slice(0, q);
  if (path !== pathname) return false;
  if (q < 0) return true;
  for (const pair of pattern.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    if ((search.get(k) ?? "") !== v) return false;
  }
  return true;
}

/** いまの画面で確認したことになるキー */
export function keysViewedAt(keys: Iterable<string>, pathname: string, search: URLSearchParams): string[] {
  const out: string[] = [];
  for (const k of keys) if (viewPaths(k).some((p) => pathMatches(p, pathname, search))) out.push(k);
  return out;
}

/** 確認していないキーの数 */
export function unseenCount(keys: readonly string[] | undefined, seen: ReadonlySet<string>): number {
  if (!keys) return 0;
  let n = 0;
  for (const k of keys) if (!seen.has(k)) n++;
  return n;
}
