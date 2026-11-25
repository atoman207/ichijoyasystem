/**
 * 帳票 (請求書・領収書) に載せる個人のお名前: 名字と名前の間にスペース (お客様のご要望 2026-11-25「②」例: 滝下 伸幸 様)
 * ------------------------------------------------------------
 * - スペースのあるお名前 (登録のほとんど) はそのまま (全角・連続のスペースは半角 1 つに)
 * - スペースのないお名前は、確かなときだけ分けて印字する:
 *   1. 漢字の名字 + ひらがなの名前 (田中はな) → 漢字とかなの境目
 *   2. スペースつきで登録されたお客様のお名前から作った名字と名前の一覧 (nameIndex) で、先頭の名字と残りの名前がどちらも一覧にある分け方
 *      (名字はいちばん長いもの。例: 滝下 + 伸幸)
 *   3. 一覧で決まらない 4 文字以上のお名前で、3 文字の名字 (佐々木・長谷川・一ノ瀬など) + 一覧にある名前
 *   決まらないお名前・2 文字 (名字だけ)・7 文字以上・カタカナや英字を含むお名前・お店や会社のようなお名前 (商店・工業・自宅…) は分けない
 * - 分けられない・分け方が違うときは、顧客の情報のお名前にスペースを入れて登録し直すと、そのとおりに印字する
 * 法人・施設 (御中) のお名前には使わない。import なし (PDF・画面・テストで共通)
 */

/** 3 文字の名字 (名字の一覧に当たらないとき、先頭がこれなら 3 + 残り) */
const THREE = ["佐々木", "長谷川", "久保田", "小野寺", "五十嵐", "大久保", "宇佐美", "長谷部", "小笠原", "佐久間", "阿久津", "加賀谷", "曽我部", "小早川", "波多野", "伊集院", "東海林", "宇都宮", "小山内", "大和田", "小田切", "小野田", "大河原", "日比野"];

const HAN = "\\p{Script=Han}々〆ヶヵノ之";
const KANJI = new RegExp(`^[${HAN}]+$`, "u");
const KANA_TAIL = new RegExp(`^([${HAN}]{1,4})([\\p{Script=Hiragana}ー]{1,6})$`, "u");
const HIRA = /^[\p{Script=Hiragana}ー]+$/u;

/** スペースつきで登録されたお名前の名字・名前 (漢字 1〜4 文字) と件数 */
export interface NameIndex {
  surnames: Map<string, number>;
  givens: Map<string, number>;
}

/** お店・会社・メモのようなお名前 (分けない) */
const NOT_PERSON = /(様|殿|御中|自宅|団地|社長|会長|奥様|商店|工業|開発|建設|工務|産業|興業|設備|電気|住宅|不動産|大工|会館|会社|事務所|組合|協会|病院|医院|寺|院|会|社|店|館|荘|堂|屋|所|組|園|部|課|係)$/u;

export function nameIndex(names: Iterable<string>): NameIndex {
  const surnames = new Map<string, number>();
  const givens = new Map<string, number>();
  for (const raw of names) {
    const parts = (raw ?? "").trim().split(/[\s\u3000]+/);
    if (parts.length !== 2 || !parts[1]) continue;
    const [sur, given] = parts;
    const ls = Array.from(sur).length;
    const lg = Array.from(given).length;
    if (ls >= 1 && ls <= 4 && KANJI.test(sur)) surnames.set(sur, (surnames.get(sur) ?? 0) + 1);
    if ((lg >= 1 && lg <= 4 && KANJI.test(given)) || (lg >= 2 && lg <= 6 && HIRA.test(given))) givens.set(given, (givens.get(given) ?? 0) + 1);
  }
  return { surnames, givens };
}

/** 名字と名前の間にスペースを入れたお名前 (確かでないときはそのまま) */
export function spacedPersonName(raw: string | undefined, index?: NameIndex): string {
  const name = (raw ?? "").trim();
  if (!name) return name;
  if (/[\s\u3000]/.test(name)) return name.replace(/[\s\u3000]+/g, " ");
  if (NOT_PERSON.test(name)) return name;
  // 名字だけのお名前 (大河原・高井良など、登録されている名字そのもの)
  if (index?.surnames.has(name)) return name;
  // 漢字の名字 + ひらがなの名前 (名字・名前とも一覧にあるとき。お店の名前「○○だんご」などを分けない)
  const kana = name.match(KANA_TAIL);
  if (kana) return index && (index.surnames.get(kana[1]) ?? 0) > 0 && (index.givens.get(kana[2]) ?? 0) > 0 ? `${kana[1]} ${kana[2]}` : name;
  if (!KANJI.test(name)) return name;
  const chars = Array.from(name);
  const n = chars.length;
  if (n < 3 || n > 6) return name;
  const split = (k: number) => `${chars.slice(0, k).join("")} ${chars.slice(k).join("")}`;
  // 名前が一覧にあるか (1 文字の名前は 2 人以上のときだけ)
  const given = (k: number) => (index?.givens.get(chars.slice(k).join("")) ?? 0) >= (n - k === 1 ? 2 : 1);
  // 登録されているお客様の名字と名前の両方に当たる分け方 (名字はいちばん長いもの)
  if (index) {
    for (let k = Math.min(4, n - 1); k >= 1; k--) {
      if (n - k > 4) break;
      if ((index.surnames.get(chars.slice(0, k).join("")) ?? 0) > 0 && given(k)) return split(k);
    }
  }
  // 3 文字の名字 (「一ノ瀬」「木之下」「霞ヶ関」のように 2 文字目が ノ・之・ヶ も) + 一覧にある名前
  if (THREE.includes(name)) return name;
  const three = THREE.some((t) => name.startsWith(t)) || /^[\p{Script=Han}][ノ之ヶヵ][\p{Script=Han}]/u.test(name);
  if (three && n >= 4 && (!index || given(3))) return split(3);
  return name;
}

/** 帳票の宛名: 個人 (様) は名字と名前の間にスペース、法人・施設 (御中) はそのまま */
export function addresseeName(name: string, honorific: "様" | "御中" | string, index?: NameIndex): string {
  return honorific === "御中" ? name.trim() : spacedPersonName(name, index);
}
