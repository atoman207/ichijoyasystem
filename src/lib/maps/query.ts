import { normalizeAddress, DEFAULT_PREFECTURE } from "./address";
import { postalFromAddress, prefectureOfAddress } from "@/lib/postal/lookup";

/**
 * 地図で探すための住所の文字 (お客様のご要望 2026-11-26「Google マップが違う場所を示す・住所コピーで番地が入らない」)
 * ------------------------------------------------------------
 * Google マップのリンク (google.ts) とゼンリン GIS の地点検索に貼る「住所をコピー」の両方で使う。
 * - 都道府県 + 市区町村 + 町名 + 番地。お客様の住所は県・熊本市を省いて書かれることが多いので補う
 *   (「北区植木町…」→「熊本県熊本市北区植木町…」。県がないと Google は東京都中央区・兵庫県豊岡市などを先に出す)
 * - 都道府県は書かれていればそれ、なければ市区町村から (九州 7 県の郵便番号データ)、それでも決まらなければ熊本県
 * - 市区町村のない地区だけ (予定表の「須屋」「植木平井」) は、郵便番号データで 1 つの町に決まるときだけ市区町村も補う (「熊本県合志市須屋」)
 * - 番地まである住所は建物名・部屋番号・郵便番号を外す (建物名を別の場所と取り違えないように)。番地のない住所はそのまま (県だけ補う)
 * 元の住所の文字は変えない (画面には登録どおりの住所を出す)。このファイルは画面からも読み込む
 */
export function mapSearchAddress(text: string | undefined | null): string {
  const n = normalizeAddress(text);
  const core = n.core.trim();
  if (!core) return "";
  if (n.prefectureWritten) return `${n.prefecture}${core}`;
  const ctx = prefectureOfAddress(core);
  if (ctx) return `${ctx.pref}${ctx.addCity ?? ""}${core}`;
  const town = postalFromAddress(core);
  if (town.ok) return `${town.hit.pref}${town.hit.city}${core}`;
  return `${DEFAULT_PREFECTURE}${core}`;
}
