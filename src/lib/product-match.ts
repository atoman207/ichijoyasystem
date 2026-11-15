import type { Product, ServiceCategory } from "@/lib/db/types";

/**
 * 読み取った品名 (手書き見積・図面・施工資料) を商品マスタに対応づける
 * - 商品名の銘柄 (さくら・ちどり・ワーロン など) が書かれていれば、その商品
 * - 種別 (畳・襖・障子…) だけで銘柄が分からないときは対応づけない (価格の違う商品を推測しない)
 * - 古畳の処分・諸経費は言葉で判定する
 */

const CATEGORY_WORDS: Record<ServiceCategory, string[]> = {
  tatami: ["畳", "たたみ", "タタミ", "表替", "新調", "琉球", "へり無し"],
  fusuma: ["襖", "ふすま", "フスマ"],
  shoji: ["障子", "しょうじ", "ショウジ"],
  amido: ["網戸", "あみど", "アミド"],
  curtain: ["カーテン", "ブラインド"],
  cloth: ["クロス", "壁紙"],
  other: ["諸経費"],
};

export function normName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/帖/g, "畳")
    .replace(/[\s()（）・/／\-－「」『』【】]/g, "")
    .toLowerCase();
}

/** 商品名から種別の言葉を除いた銘柄 (例: 畳表替え さくら → さくら) */
function brandOf(p: Product): string {
  return normName(p.name.replace(/^(畳表替え|襖張替え|障子張替え|網戸張替え)\s*/, "").replace(/\(.*?\)|（.*?）/g, ""));
}

export function matchProduct(products: Product[], text: string): Product | undefined {
  const t = normName(text);
  if (!t) return undefined;
  if (/処分|引取|引き取り|古畳/.test(text)) return products.find((p) => p.id === "p_t_disposal" && p.active);
  if (/諸経費|経費一式|雑費/.test(text)) return products.find((p) => p.id === "p_misc" && p.active);
  let best: Product | undefined;
  let bestScore = 0;
  for (const p of products) {
    if (!p.active) continue;
    let score = 0;
    const n = normName(p.name);
    if (t === n) score += 100;
    else if (t.length >= 4 && (t.includes(n) || n.includes(t))) score += 45;
    const brand = brandOf(p);
    if (brand.length >= 2 && t.includes(brand)) score += 35;
    if (CATEGORY_WORDS[p.category].some((w) => t.includes(normName(w)))) score += 10;
    // 大・中・小 (障子・網戸のサイズ)
    if (p.sizeLabel && score >= 35 && new RegExp(`${p.sizeLabel}(?:サイズ|判)?`).test(text)) score += 5;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return bestScore >= 45 ? best : undefined;
}
