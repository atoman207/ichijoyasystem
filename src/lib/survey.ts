/**
 * お客様アンケート (アンケートはがき) の設問
 * ------------------------------------------------------------
 * はがきの設問と選択肢。AI の読取 (src/lib/ai/ocr.ts)・確認画面・集計 (src/lib/kpi.ts) で共通に使う
 *  ① 電話対応        → 事務の評価 (全社の平均で支給を判定)
 *  ② 営業担当者の対応 → 営業担当 (見積り) の評価
 *  ③ 職人の対応      → 担当職人の評価 (複数名なら全員に同じ点)
 *  ④ 工事の仕上がり  → 店舗の評価
 *  ⑤⑥⑦             → インセンティブとは別に集計
 *  ⑧ 自由記述        → 分類・分析
 */

export const SCORE_LABEL: Record<number, string> = { 1: "大変不満", 2: "不満", 3: "普通", 4: "満足", 5: "大変満足" };

export const SCORE_QUESTIONS = [
  { key: "phoneScore", no: "①", label: "電話対応", target: "事務 (全社)" },
  { key: "salesScore", no: "②", label: "営業担当者の対応", target: "営業担当" },
  { key: "craftsmanScore", no: "③", label: "職人の対応", target: "担当職人" },
  { key: "finishScore", no: "④", label: "工事の仕上がり", target: "店舗" },
] as const;

export type ScoreKey = (typeof SCORE_QUESTIONS)[number]["key"];

/** ⑤ ご利用にあたって重視されたこと (複数回答可) */
export const PRIORITY_OPTIONS = ["価格", "評判", "対応", "人柄", "知名度", "所在地", "安心感", "まとめて頼める", "その他"] as const;

/** ⑥ 何を見てご依頼いただきましたか */
export const MEDIA_OPTIONS = ["以前頼んだことがある", "ダイレクトメール", "チラシ", "CM", "店舗", "看板", "紹介", "口コミ", "ホームページ", "フリーペーパー", "グーグルマップ", "SNS", "その他"] as const;

/** ⑧ の分類 (お褒め・ご意見の内容) */
export const COMMENT_TAGS = ["仕上がり", "職人の技術・対応", "営業の説明・提案", "電話・事務の対応", "スピード・日程", "価格", "清掃・マナー", "商品・素材", "ご指摘・改善要望", "感謝・また依頼したい"] as const;

export const COMMENT_TONE_LABEL: Record<"praise" | "request" | "complaint" | "neutral", string> = {
  praise: "お褒め",
  request: "ご要望",
  complaint: "ご指摘",
  neutral: "その他",
};

/** はがきの番号の比較用 (全角・空白・ハイフンの違いを除き、英字は大文字) */
export function normPostcardNo(v: string | undefined | null): string {
  return (v ?? "").normalize("NFKC").replace(/^No\.?/i, "").replace(/[\s\-ー－]/g, "").toUpperCase();
}

/**
 * 移行データ (スプレッドシートの回答)・古い集計表の書き方 → ⑥ の選択肢。
 * フォームでは「R」= リピーター (以前頼んだことがある)、「DM」「Googleマップ」「HP」と書いていた
 */
const MEDIA_ALIASES: [RegExp, (typeof MEDIA_OPTIONS)[number]][] = [
  [/^R$|^リピ|^以前|^前回/i, "以前頼んだことがある"],
  [/^DM$|ダイレクトメール/i, "ダイレクトメール"],
  [/(google|グーグル).*(map|マップ)|^google$|^グーグル$/i, "グーグルマップ"],
  [/^HP$|ホームページ|^ネット|インターネット/i, "ホームページ"],
  [/^CM$|^TV$|テレビ/i, "CM"],
  [/クチコミ|口コミ/, "口コミ"],
  [/^紹介|^知人|^友人/, "紹介"],
  [/^SNS$|インスタ|instagram|facebook/i, "SNS"],
];

function optionOf(part: string, options: readonly string[]): string | undefined {
  const p = part.normalize("NFKC").trim();
  const direct = options.find((o) => p === o || p.includes(o) || (p.length >= 2 && o.includes(p)));
  if (direct) return direct;
  if (options.includes("以前頼んだことがある")) return MEDIA_ALIASES.find(([re]) => re.test(p))?.[1];
  return undefined;
}

const splitParts = (v: string) => v.split(/[,、，・\n/]+/).map((x) => x.trim()).filter(Boolean);

/** 古い集計表の文字 (例: "価格, 評判") を選択肢の配列にする (選択肢にない書き方はそのまま残す) */
export function splitAnswers(v: string | undefined, options: readonly string[]): string[] {
  if (!v) return [];
  return splitParts(v).map((p) => optionOf(p, options) ?? p);
}

/**
 * 集計用: 回答 (文字・配列) → 選択肢 (重複なし)。選択肢にない書き方 (自由記述) は「その他」に数え、元の文字は others に残す。
 * スプレッドシートの集計表 (H26〜R4 集計) も選択肢にない回答は「その他」に数えていた
 */
export function tallyAnswers(v: string | string[] | undefined, options: readonly string[]): { options: string[]; others: string[] } {
  const parts = Array.isArray(v) ? v : v ? splitParts(v) : [];
  const out = new Set<string>();
  const others: string[] = [];
  for (const raw of parts) {
    const o = optionOf(raw, options);
    if (o) out.add(o);
    else if (raw.trim()) {
      out.add("その他");
      others.push(raw.trim().slice(0, 40));
    }
  }
  return { options: [...out], others };
}

/** ⑧ の分類 (AI を使わないとき・移行データ用の簡易ルール) */
export function tagComment(text: string | undefined): { tags: string[]; tone: "praise" | "request" | "complaint" | "neutral" } {
  const t = (text ?? "").normalize("NFKC");
  if (!t.trim()) return { tags: [], tone: "neutral" };
  const rules: [string, RegExp][] = [
    ["仕上がり", /仕上|出来|きれい|キレイ|綺麗|美し|見違え/],
    ["職人の技術・対応", /職人|技術|プロ|丁寧|手際/],
    ["営業の説明・提案", /説明|提案|アドバイス|相談|営業|担当/],
    ["電話・事務の対応", /電話|受付|事務/],
    ["スピード・日程", /早|速|スピード|日程|すぐ|迅速|待/],
    ["価格", /価格|値段|料金|安|高い|費用/],
    ["清掃・マナー", /掃除|清掃|片付|マナー|挨拶|礼儀|感じ/],
    ["商品・素材", /畳表|い草|香り|素材|襖紙|障子紙|色|柄/],
    ["ご指摘・改善要望", /残念|不満|遅れ|ミス|傷|汚れ|要望|改善|ほしい|欲しい|困/],
    ["感謝・また依頼したい", /ありがと|感謝|また|次回|お願いしたい|満足/],
  ];
  const tags = rules.filter(([, re]) => re.test(t)).map(([k]) => k);
  const negative = /残念|不満|遅れ|ミス|傷|汚れ|困|悪/.test(t);
  const request = /ほしい|欲しい|要望|改善|希望/.test(t);
  return { tags, tone: negative ? "complaint" : request ? "request" : tags.length ? "praise" : "neutral" };
}
