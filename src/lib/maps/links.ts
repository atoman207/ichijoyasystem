/**
 * 住宅地図を見る画面 (/maps/documents/<ID>) へのリンク (画面の部品・サーバーで共通。server-only にしない)。
 * 見たあとは returnTo (元の画面) に戻る。PDF そのもの (/api/maps/documents/<ID>) へのリンクは画面に出さない
 * (ホーム画面のアプリ・スマートフォンの新しいタブで元の画面に戻れなくなるため。お客様のご要望 2026-11-24「①」)
 */
export function mapViewHref(docId: string, returnTo: string): string {
  return `/maps/documents/${encodeURIComponent(docId)}?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * 予定表の URL に「この予定の小さな画面を開く」印 (qe = 予定の ID) を付ける。
 * 予定表の小さな画面から住宅地図を開き、「元の画面に戻る」で同じ予定表・同じ予定の小さな画面に戻るため (EventQuickHost が qe を読んで開き、URL から外す)
 */
export function reopenHref(returnTo: string, eventId: string): string {
  const [path, query = ""] = returnTo.split("#")[0].split("?");
  const sp = new URLSearchParams(query);
  for (const k of ["msg", "err", "_r", "qe"]) sp.delete(k);
  sp.set("qe", eventId);
  return `${path}?${sp.toString()}`;
}
