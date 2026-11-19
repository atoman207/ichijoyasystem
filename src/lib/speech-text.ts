/**
 * 音声の読み上げ・音声入力のための文字の整え (画面とサーバーの両方で使う。ほかのモジュールに依存しない)
 * ------------------------------------------------------------
 * - forSpeech: 回答の文字 (**太字**・[名前](/画面)・¥金額・2026/04/01・〜 など) を、読み上げやすい文にする。
 *   社名・店舗名などの読みを、ひらがなに置き換えて正しく読ませる (一畳屋 → いちじょうや、合志 → こうし)
 * - fixTranscript: 音声入力の文字起こしでよく起きる聞き違い (甲子店 → 合志店、日常屋 → 一畳屋) を直す
 */

/** 読み上げの長さの上限 (およそ 1 分半) */
export const SPEECH_MAX_CHARS = 700;

/** 読み (順番に置き換える。長いものを先に) */
const READINGS: [RegExp, string][] = [
  [/株式会社一畳屋/g, "株式会社いちじょうや"],
  [/一畳屋/g, "いちじょうや"],
  [/合志/g, "こうし"],
  [/坪井/g, "つぼい"],
  [/玉名/g, "たまな"],
  [/表替え/g, "おもてがえ"],
  [/畳縁/g, "たたみべり"],
  [/粗利/g, "あらり"],
  [/御中/g, "おんちゅう"],
  [/襖/g, "ふすま"],
];

function readDate(y: string, m: string, d?: string) {
  return `${Number(y)}年${Number(m)}月${d ? `${Number(d)}日` : ""}`;
}

/** 回答の文字 → 読み上げる文 (表があるときは、画面で見てもらう一言を添える) */
export function forSpeech(text: string, opts: { hasTable?: boolean; max?: number } = {}): string {
  const max = opts.max ?? SPEECH_MAX_CHARS;
  let s = text
    // 内部の情報・記号
    .replace(/^\s*\[分析条件[:：].*$/gm, "")
    .replace(/\[([^\]]+)\]\((\/[^)\s]*|https?:[^)\s]*)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[#*_`>|]/g, "")
    .replace(/^\s*(?:[-・●○■◆※]|\d+\.)\s*/gm, "")
    // 金額・日付・範囲
    .replace(/[¥￥]\s?(-?[\d,]+)/g, (_, n: string) => `${n}円`)
    .replace(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/g, (_, y: string, m: string, d: string) => readDate(y, m, d))
    .replace(/(\d{4})年(\d{2})月(?!\d)/g, (_, y: string, m: string) => readDate(y, m))
    .replace(/\s*[〜~～]\s*/g, "から")
    .replace(/(\d+(?:\.\d+)?)%/g, "$1パーセント")
    // 絵文字
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  for (const [re, r] of READINGS) s = s.replace(re, r);
  // 改行は文の区切りにする
  s = s
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[。！？!?、]$/.test(l) ? l : `${l}。`))
    .join("")
    .replace(/。{2,}/g, "。")
    .replace(/\s{2,}/g, " ");
  if (s.length > max) {
    // 文の切れ目で切る
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
    s = `${end > max * 0.5 ? cut.slice(0, end + 1) : `${cut}。`}続きは画面でご確認ください。`;
  }
  if (opts.hasTable) s += "表とグラフは画面に表示しています。";
  return s;
}

/** 音声入力の聞き違いを直す */
const FIXES: [RegExp, string][] = [
  [/(甲子|孝志|幸志|光志|好志|耕志|皇子|高市)店/g, "合志店"],
  [/(日常屋|一条屋|一畳や|いちじょうや|イチジョウヤ|一乗屋)/g, "一畳屋"],
  [/(多摩名|玉那|田間名)店/g, "玉名店"],
  [/(荒利|あらり)/g, "粗利"],
  [/見つもり/g, "見積"],
  [/売り上げ/g, "売上"],
  [/(ふすま|フスマ)/g, "襖"],
];

export function fixTranscript(text: string): string {
  let s = text.trim();
  for (const [re, r] of FIXES) s = s.replace(re, r);
  return s;
}

/** 音声認識に渡す言葉の手がかり (社名・店舗名・よく使う言葉) */
export const TRANSCRIBE_HINT = "一畳屋 (いちじょうや)、合志店 (こうしてん)、中央店、西店、玉名店 (たまなてん)、本社・坪井ショールーム、畳、表替え、襖、障子、網戸、カーテン、クロス、見積、受注、施工、請求、入金、粗利、売上、予定表、問い合わせ";
