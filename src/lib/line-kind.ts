/**
 * 明細 1 行の種類 (品名・仕様から決める)
 * ------------------------------------------------------------
 * お客様のご要望 (2026-11-23「■1. 品目・単位の自動選択」「■2. 予定表への仕事内容・数量の表示」) の共通の判定。
 * - 見積の明細の入力 (QuoteEditor): 品名・仕様を入れると、単位 (autoUnit) と管理会計の品目 (autoItemCategory) を自動で選ぶ (手で変えられる)
 * - 受注の引取・納品の品目 (src/lib/handover.ts の classifyLine)
 * - 予定表の仕事内容の省略表記「タ12 フ6 シ4 ア2」(src/lib/work-summary.ts)
 *
 * 判定の順:
 * 1. 品名が「畳」「襖」「障子」「網戸」だけのとき (手書き見積書の書き方。仕様に「引き手 S-186」「縁 マス菊」「仏一式」) は仕様を先に見る
 *    (「引手・取手は仕様を優先して判定」のご指示)。それ以外は品名で決め、品名で決まらなければ仕様を見る
 * 2. 言葉: 値引き → 諸経費など → 引手・取手 → 仏間 → 網戸 → 障子 → 襖 → へり無し畳 → 縁 → カーテン → 畳 → リフォーム
 *    (「6畳」「8帖間」は部屋の広さとして外す。「縁代込」「縁付き」は畳の言い方として縁にしない。「へり無し」「縁無」「琉球」はへり無し畳)
 * 3. 言葉で決まらなければ商品マスタの分類 (ServiceCategory)
 *
 * ブラウザーとサーバーの両方から使う純粋関数 (データベースに触れない)。
 */

export type LineKind = "tatami" | "heri" | "fusuma" | "butsuma" | "hikite" | "shoji" | "amido" | "curtain" | "reform" | "misc" | "discount";

export interface LineInfo {
  kind: LineKind;
  /** 畳の作業 (kind = tatami のとき) */
  tatami?: "omote" | "ura" | "new";
  /** へり無し畳 (縁無・ヘリ無し・琉球) */
  herinashi?: boolean;
  /** 半畳 */
  half?: boolean;
}

/** 品名が品目の言葉だけ (仕様を先に見る) */
const BARE = /^(畳|たたみ|タタミ|襖|ふすま|フスマ|障子|しょうじ|網戸|あみど|アミ戸|あみ戸|建具)$/;
/** 部屋の広さ (「6畳」「8帖間」「和室8畳」) */
const ROOM_SIZE = /\d+(?:\.\d+)?\s*(?:畳|帖)間?/g;
const HERINASHI = /(?:縁|へり|ヘリ|ふち)\s*(?:無し?|なし|ナシ)|ヘリレス|琉球/;
const HERINASHI_ALL = /(?:縁|へり|ヘリ|ふち)\s*(?:無し?|なし|ナシ)|ヘリレス|琉球/g;
/** 縁ではなく畳の言い方 (縁代込・縁込み・縁付き・縁共) と、引手を含む襖の言い方 (引手込み・引手共) */
const TOLERATED = /(?:縁|へり|ヘリ)\s*(?:代込み?|代含む?|込み?|付き?|共|代)|引き?手\s*(?:込み?|共|含む?)/g;
const DISCOUNT = /値引|割引|値下|金券|クーポン|ポイント|サービス値/;
const MISC = /諸経費|出張|運搬|配送|駐車|処分|送料|手数料|乾燥|防虫|消費税/;
const HIKITE = /引手|引き手|ひきて|取手|取っ手|とって|把手/;
const BUTSUMA = /仏間|仏一式|仏壇/;
const AMIDO = /網戸|アミ戸|あみ戸|網張/;
const SHOJI = /障子/;
const FUSUMA = /襖|フスマ|ふすま|天袋|戸襖|板戸/;
const HERI = /縁|へり|ヘリ/;
const CURTAIN = /カーテン|ブラインド|ロールスクリーン|プリーツスクリーン|バーチカル/;
const TATAMI = /畳|たたみ|タタミ|表替|裏返|新床|ござ|ゴザ/;
const TATAMI_NEW = /新調|新床|新畳/;
const NOT_TATAMI_NEW = /建具|ドア|扉|サッシ|窓/;
const REFORM = /クロス|壁紙|フローリング|クッションフロア|内装|リフォーム|塗装|左官|大工|工事/;
const HALF = /半畳|半帖|縁無し?半|ヘリ無し?半|半\s*\d/;

const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").trim();

function tatamiWork(t: string): LineInfo["tatami"] {
  if (TATAMI_NEW.test(t)) return "new";
  if (/裏返/.test(t)) return "ura";
  return "omote";
}

/** 文 1 つの種類 (言葉で決まらなければ undefined) */
function kindOfText(raw: string): LineInfo | undefined {
  const herinashi = HERINASHI.test(raw);
  const half = HALF.test(raw);
  const t = raw.replace(HERINASHI_ALL, " 畳 ").replace(TOLERATED, " ").replace(ROOM_SIZE, " ");
  if (!t.trim()) return undefined;
  if (DISCOUNT.test(t)) return { kind: "discount" };
  if (MISC.test(t)) return { kind: "misc" };
  if (HIKITE.test(t)) return { kind: "hikite" };
  if (BUTSUMA.test(t)) return { kind: "butsuma" };
  if (AMIDO.test(t)) return { kind: "amido" };
  if (SHOJI.test(t)) return { kind: "shoji" };
  if (FUSUMA.test(t)) return { kind: "fusuma" };
  if (herinashi) return { kind: "tatami", tatami: tatamiWork(t), herinashi: true, ...(half ? { half: true } : {}) };
  if (HERI.test(t)) return { kind: "heri" };
  if (CURTAIN.test(t)) return { kind: "curtain" };
  if (TATAMI.test(t) || (TATAMI_NEW.test(t) && !NOT_TATAMI_NEW.test(t))) return { kind: "tatami", tatami: tatamiWork(t), ...(half ? { half: true } : {}) };
  if (REFORM.test(t)) return { kind: "reform" };
  return undefined;
}

/** 商品マスタの分類 (ServiceCategory) から */
function kindOfProduct(category: string | undefined): LineInfo | undefined {
  switch (category) {
    case "tatami":
      return { kind: "tatami", tatami: "omote" };
    case "fusuma":
    case "shoji":
    case "amido":
    case "curtain":
      return { kind: category };
    case "cloth":
      return { kind: "reform" };
  }
  return undefined;
}

/**
 * 明細 1 行の種類。品名・仕様・商品マスタの分類から決める (決まらなければ undefined)
 * @param productCategory 商品マスタの分類 (ServiceCategory)。言葉で決まらないときに使う
 */
export function lineKind(name: string | undefined, spec?: string, productCategory?: string): LineInfo | undefined {
  const n = norm(name);
  const s = norm(spec);
  const bare = BARE.test(n.replace(/[\s　]/g, ""));
  let info: LineInfo | undefined;
  if (bare && s) {
    // 品名が「襖」「畳」だけ: 仕様 (引き手・縁・仏一式・表替え さくら など) を先に見て、なければ品名の品目
    info = kindOfText(s);
    if (!info || info.kind === "reform" || info.kind === "curtain") info = kindOfText(`${n} ${s}`);
  } else {
    info = kindOfText(n) ?? (s ? kindOfText(`${n} ${s}`) : undefined);
  }
  // 品名でへり無し・半畳が分からなくても、仕様に書いてあれば印を付ける (畳の行)
  if (info?.kind === "tatami" && s) {
    if (!info.herinashi && HERINASHI.test(s)) info = { ...info, herinashi: true };
    if (!info.half && HALF.test(s)) info = { ...info, half: true };
  }
  return info ?? kindOfProduct(productCategory);
}

/* ---------------- 単位 ---------------- */

/** 単位の選択肢 (お客様のご指示の単位 + m・㎡。ほかは「その他」で入力) */
export const UNIT_OPTIONS = ["畳", "枚", "個", "ヶ所", "式", "m", "㎡", "面", "本", "組", "セット", "台", "帖", "坪", "日", "時間", "回"] as const;

/**
 * 種類ごとの単位 (お客様のご指示 2026-11-23): 畳 → 畳 / 襖・障子・網戸 → 枚 / 引手・取手 → 個 / カーテン → ヶ所 /
 * 仏間 (襖) → 式 / 縁 → 畳 / リフォーム → 式。値引き・諸経費・分からないものは選ばない (今の単位のまま)
 */
const UNIT_BY_KIND: Partial<Record<LineKind, string>> = {
  tatami: "畳",
  heri: "畳",
  fusuma: "枚",
  shoji: "枚",
  amido: "枚",
  hikite: "個",
  butsuma: "式",
  curtain: "ヶ所",
  reform: "式",
};

/** 明細の単位の自動選択 (決まらなければ undefined) */
export function autoUnit(name: string | undefined, spec?: string, productCategory?: string): string | undefined {
  const k = lineKind(name, spec, productCategory);
  return k ? UNIT_BY_KIND[k.kind] : undefined;
}

/* ---------------- 管理会計の品目 ---------------- */

/** 種類 → 管理会計の品目 (src/lib/mgmt/categories.ts の 7 区分。縁は畳、引手・仏間は襖 (障子・網戸を含む)) */
const ITEM_BY_KIND: Partial<Record<LineKind, string>> = {
  tatami: "tatami",
  heri: "tatami",
  fusuma: "fusuma",
  shoji: "fusuma",
  amido: "fusuma",
  hikite: "fusuma",
  butsuma: "fusuma",
  curtain: "curtain",
  reform: "reform",
};

/** 明細の管理会計の品目の自動選択 (値引き・諸経費・分からないものは undefined = 「自動」のまま) */
export function autoItemCategory(name: string | undefined, spec?: string, productCategory?: string): string | undefined {
  const k = lineKind(name, spec, productCategory);
  return k ? ITEM_BY_KIND[k.kind] : undefined;
}

/** 数量を数える単位か (m・㎡ などの長さ・面積は枚数として数えない) */
export function isPieceUnit(unit: string | undefined): boolean {
  return !/^(m|㎡|m2|cm|mm|坪|円|時間|日)$/i.test(norm(unit));
}
