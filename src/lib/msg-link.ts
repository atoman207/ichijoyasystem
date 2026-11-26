/**
 * 操作の結果の知らせ (?msg=) にボタンのリンクを付ける (お客様のご要望 2026-11-26「■8 日程登録後の予定表への遷移」)。
 * msg の文の最後に「[[ボタンの名前]](/同じサイトの場所)」を付け、トースト (src/components/ui/Toaster.tsx) がボタンにする。
 * 別の検索の値にしないのは、画面が戻り先 (returnTo) を作るときに msg・err だけを外しているため (別の値だと次の知らせに古いリンクが付く)。
 * import なし (サーバー・ブラウザーの両方)
 */

const LINK_RE = /\s*\[\[([^\]\n]{1,30})\]\]\((\/[^\s)]*)\)\s*$/;

/** 文の最後にリンクの印を付ける */
export function msgWithLink(msg: string, link?: { href: string; label: string }): string {
  if (!link || !link.href.startsWith("/") || link.href.startsWith("//")) return msg;
  return `${msg} [[${link.label.replace(/[[\]\n]/g, "")}]](${link.href.replace(/[\s)]/g, encodeURIComponent)})`;
}

/** 文とリンクに分ける (印がなければリンクなし) */
export function splitMsgLink(msg: string): { text: string; link?: { href: string; label: string } } {
  const m = msg.match(LINK_RE);
  if (!m || m[2].startsWith("//")) return { text: msg };
  return { text: msg.slice(0, m.index).trimEnd(), link: { label: m[1], href: m[2] } };
}

/** 予定表の週の表示 (その日を含む週・その店舗だけ) */
export function scheduleWeekHref(date: string, storeId?: string): string {
  const q = new URLSearchParams({ view: "week", date });
  if (storeId) q.set("store", storeId);
  return `/schedule?${q.toString()}`;
}

/** 日程を登録・変更したあとの「予定表で確認」 (いくつもの日程のときは引き取りの日 → いちばん早い日) */
export function scheduleCheckLink(dates: { date?: string; pickup?: boolean }[], storeId?: string): { href: string; label: string } | undefined {
  const ok = dates.filter((d): d is { date: string; pickup?: boolean } => Boolean(d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
  if (!ok.length) return undefined;
  const pickups = ok.filter((d) => d.pickup).map((d) => d.date).sort();
  const date = pickups[0] ?? ok.map((d) => d.date).sort()[0];
  return { href: scheduleWeekHref(date, storeId), label: "予定表で確認" };
}
