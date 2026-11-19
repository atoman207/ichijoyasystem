import type { Store } from "@/lib/db/types";

/**
 * 店舗の電話の表記
 * ------------------------------------------------------------
 * 固定電話を置いていない店舗 (2026-11 時点: 中央店・西店・玉名店) は、店舗の電話番号を空にしている。
 * 公開ページ・帳票・チャットボットでは番号を出さず、問い合わせ先として本社の番号を案内する
 */

/** 店舗の電話番号 (ない・空白だけのときは空文字) */
export function storePhone(s: Pick<Store, "phone"> | undefined): string {
  return (s?.phone ?? "").trim();
}

/** 「TEL 096-…」または、固定電話のない店舗は「固定電話なし (お電話は本社 0120-…)」 */
export function storePhoneLabel(s: Pick<Store, "phone">, hq?: Pick<Store, "phone">): string {
  const p = storePhone(s);
  if (p) return `TEL ${p}`;
  const h = storePhone(hq);
  return h ? `固定電話なし (お電話は本社 ${h})` : "固定電話なし";
}
