import "server-only";
import type { DocumentKind, Product, StoreId } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { EXPENSE_ACCOUNTS } from "@/lib/constants";
import { readCandidates, suggestAccounts } from "@/lib/expense-account";
import { matchProduct } from "@/lib/product-match";
import { calcSheet } from "@/lib/quote-sheet-calc";
import { COMMENT_TAGS, MEDIA_OPTIONS, PRIORITY_OPTIONS, normPostcardNo, tagComment } from "@/lib/survey";
import { EQUIPMENT_OPTIONS, PAYMENT_OPTIONS, SITE_MEDIA_OPTIONS } from "@/lib/site-info";
import { AiError, aiEnabled, generateJson, type AiPart } from "./provider";
import { RECEPTION_SCHEMA } from "./reception";
import { checkRows, hasRowContent, reconcileRows, retryInstruction } from "./ocr-rows";

export { aiEnabled } from "./provider";

/**
 * 紙書類の読取 (AI-OCR)
 * ------------------------------------------------------------
 * 撮影した画像・PDF から、書類の種類ごとに決めた項目 (日付・取引先・品名・数量・単価・金額 など) を取り出す。
 * - API キーがあるとき: AI (Claude / OpenAI。src/lib/ai/provider.ts) に JSON Schema を渡して読み取る
 * - 読み取りに失敗したとき: provider = "error" と空の項目を返す (サンプルの値は入れない。画面で手入力・再読取)
 * - API キーがないとき (デモ): ファイル名と種類から決まるサンプルの結果
 * 読み取った値は必ず担当者が画面で確認・修正してから登録する (src/app/(app)/capture)
 * 手書き見積書の mode = "calc" は「金額を書く前に撮影」: 数量・単価だけを読み、金額・合計はシステムが計算する
 * (src/lib/quote-sheet-calc.ts。画面は src/app/(app)/capture/calc)
 */

/** 手書き見積書の読み方: 記入済み (既定) / calc = 金額を書く前の見積書 (数量・単価まで) */
export type OcrMode = "calc";

export interface LineItem {
  name: string;
  spec?: string;
  qty?: number;
  unit?: string;
  unitPrice?: number;
  amount?: number;
  productId?: string;
  /** 読みにくい・判断が難しい行 (担当者が書類と見比べて確認する) */
  uncertain?: boolean;
  /** 取り消し線で消して書き直した行 (AI の読取。訂正後の値を読んだか確かめる) */
  corrected?: boolean;
  /** 金額欄が読み取れず、数量 × 単価で計算して埋めた */
  amountCalculated?: boolean;
  /** 割合の値引き (0.2 = 2割引)。金額は上の行から計算する (quote-sheet-calc.ts) */
  rate?: number;
  /** 仕入請求書の明細: 品番・明細に書かれた店舗名・現場名・備考 (管理会計の明細の振り分けに使う) */
  code?: string;
  storeName?: string;
  siteName?: string;
  lineNote?: string;
}

export interface OcrResult {
  provider: "claude" | "openai" | "mock" | "error";
  model?: string;
  confidence: number;
  extracted: Record<string, unknown>;
  warnings: string[];
  /** 失敗したときの理由 (利用者向け) */
  error?: string;
  ms?: number;
}

/* ================================================================== */
/* 書類の種類ごとの項目 (JSON Schema)                                     */
/* ================================================================== */

type Schema = Record<string, unknown>;
/*
 * Claude の structured outputs は anyOf (null を許す項目) が 1 回の依頼で 16 個まで。
 * 文字の項目は「読めなければ空文字」、数値の項目だけ null を許す (0 と「不明」を区別するため)
 */
const s = (d: string): Schema => ({ type: "string", description: `${d} (読めない・書かれていないときは空文字)` });
const n = (d: string): Schema => ({ anyOf: [{ type: "number" }, { type: "null" }], description: `${d} (読めない・書かれていないときは null)` });
const arr = (items: Schema, description: string): Schema => ({ type: "array", items, description });
const obj = (properties: Record<string, Schema>, description?: string): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) });
const DATE = "日付 (YYYY-MM-DD。和暦は西暦に直す)";

const ITEM_PROPS: Record<string, Schema> = {
  name: { type: "string", description: "品名・作業名 (書かれているとおり)" },
  spec: s("仕様・銘柄・柄・サイズ"),
  qty: n("数量 (一式は 1)"),
  unit: s("単位 (畳・枚・面・本・式・㎡ など)"),
  unitPrice: n("単価 (円。値引きの行は ▲ をマイナスの数にする)"),
  amount: n("金額 (円。値引きの行はマイナス)"),
};
const LINE_ITEM = obj(ITEM_PROPS);
/** 仕入請求書の明細 (店舗・案件・品目への振り分けに使う項目を足す) */
const SUPPLIER_LINE_ITEM = obj({
  ...ITEM_PROPS,
  code: s("品番・商品コード (例: SP7566)"),
  storeName: s("明細に書かれた店舗名・納品先の店舗"),
  siteName: s("明細に書かれた現場名・邸名・お客様名"),
  lineNote: s("明細の備考"),
});
const ENUM = (values: readonly string[], d: string): Schema => ({ type: "string", enum: [...values, ""], description: `${d} (○が付いていなければ空文字)` });

const COMMON = {
  confidence: { type: "number", description: "読み取り全体の確からしさ (0〜1)" },
  warnings: arr({ type: "string" }, "読みにくい文字・確認が必要な点 (日本語で短く)"),
} satisfies Record<string, Schema>;

const SCHEMAS: Record<DocumentKind, Schema> = {
  handwritten_quote: obj({
    paperNo: s("右上の No. (見積書の番号)"),
    quoteDate: s(`見積の${DATE} (R8 = 令和8年 = 2026年)`),
    furigana: s("ふりがな"),
    customerName: s("氏名 (「様」は除く)"),
    siteAddress: s("住所 (書かれたとおり。丸印・記号だけのときもそのまま)"),
    phone: s("Tel (電話番号。住所欄に書かれていてもここに)"),
    staffName: s("担当者の名前"),
    title: s("件名 (明細の内容から短く作る。例: 和室6畳 畳表替え・襖張替え)"),
    pickupAt: s("引取日時 (書かれたとおり。例: 11/21 8:00-8:30)"),
    deliveryAt: s("納品日時 (書かれたとおり。例: 畳翌日 11/26PM 襖・障子)"),
    totalTaxIncluded: n("税込合計金額 (訂正があれば訂正後の金額)"),
    paymentMethod: ENUM(PAYMENT_OPTIONS, "支払い方法 (納品時) の○: 現金 / カード (マスター・VISA を含む) / PayPay / 振込 / 訪問集金 / その他"),
    paymentNote: s("支払い方法の補足 (VISA・マスター、その他の括弧内など)"),
    taxMode: ENUM(["税込", "税抜"], "小計欄の左の「税込 / 税抜」の○"),
    // 先に行を数えてから items を書かせる (行の読み落としを防ぐ。足りなければ読み直し・空の行で埋める = ocr-rows.ts)
    lineCount: { type: "integer", description: "明細の欄で何かが書かれている行の数 (〃 の行・読めない行・諸経費・▲ の値引き・金券の行を含む。何も書かれていない行と、行ごと取り消し線で消した行は数えない)。先に数え、items をこの数と同じ行数にする" },
    items: arr(
      obj({
        line: { type: "integer", description: "この行が明細の何行目か (書き込みのある行だけを上から 1, 2, 3… と数える)" },
        ...ITEM_PROPS,
        name: { type: "string", description: "品名・作業名 (書かれているとおり。〃 は上の行の品名に置き換える。読めなければ空文字にして uncertain を true)" },
        uncertain: { type: "boolean", description: "読みにくい・判断が難しい・一部しか読めない行なら true (無理に決めない)" },
        corrected: { type: "boolean", description: "この行の数字・文字を取り消し線などで消して書き直していれば true" },
      }),
      "明細の欄の書き込みのある行すべてを、用紙の上から順に 1 行ずつ (並べ替えない・まとめない・省かない)。〃 の行・諸経費・▲ の値引き・金券の行も 1 行。読めない行も省かずに入れる (品名が読めなければ空文字、数字が読めなければ null、uncertain を true)。何も書かれていない行と、行ごと取り消し線で消した行は入れない",
    ),
    subtotal: n("小計 (訂正があれば訂正後)"),
    discount: n("値引き (明細とは別に書かれた値引きの合計。▲ が付いていても正の数。なければ null)"),
    tax: n("消費税 (書かれていなければ null)"),
    total: n("合計 (訂正があれば訂正後)"),
    note: s("備考欄の内容 (取り消し線の部分は除く)"),
    baggage: s("荷物の欄 (例: ベッド、タンス)"),
    oneOk: ENUM(["OK", "NG"], "1人 OK・NG の○"),
    spareTatami: n("かえ畳の枚数"),
    floor: s("戸建て ○ F の書き込み (例: 戸建て 2F)"),
    sizes: s("サイズの欄 (書かれたとおり)"),
    straw: ENUM(["A", "B"], "わら A/B の○"),
    material: ENUM(["A", "B"], "建材 A/B の○"),
    equipment: arr({ type: "string", enum: [...EQUIPMENT_OPTIONS] }, "脚立・ローラー・ジャッキ・台車・ジン のうち○が付いたもの"),
    paperCurtain: s("紙カーテンの欄の書き込み"),
    carryOut: ENUM(["遠", "近"], "搬出 遠/近 の○"),
    rain: ENUM(["OK", "NG"], "雨天 OK・NG の○"),
    media: arr({ type: "string", enum: [...SITE_MEDIA_OPTIONS] }, "媒体の欄で○が付いたもの (R/店舗/チラシ/…)"),
    mediaOther: s("媒体 その他の括弧内"),
    fusumaPaper: s("襖紙の欄 (例: しずか166/6枚)"),
    otherNotes: s("欄外・余白の書き込み (取り消し線の部分は除く)"),
    uncertainFields: arr({ type: "string" }, "読み取りに自信がない項目の名前 (customerName・phone・totalTaxIncluded など上の項目名)"),
    corrections: arr({ type: "string" }, "取り消し線・二重線・塗りつぶしで消して書き直した箇所 (例: 「合計 753,500 を消して 740,000」「2 行目の単価 16,850 を消して 15,950」。なければ空)"),
    ...COMMON,
  }),
  drawing: obj({
    siteName: s("現場名・お客様名"),
    siteAddress: s("現場の住所"),
    drawingDate: s(`図面・採寸の${DATE}`),
    rooms: arr(
      obj({
        name: { type: "string", description: "部屋の名前 (和室・続き間 など)" },
        size: s("広さ (6畳 など)"),
        widthMm: n("幅 (mm)"),
        depthMm: n("奥行 (mm)"),
        tatamiCount: n("畳の枚数"),
      }),
      "部屋",
    ),
    fittings: arr(
      obj({
        kind: { type: "string", enum: ["襖", "障子", "網戸", "戸", "窓", "その他"], description: "建具の種類" },
        name: s("場所・名前 (押入 など)"),
        count: n("枚数"),
        widthMm: n("幅 (mm)"),
        heightMm: n("高さ (mm)"),
      }),
      "建具 (襖・障子・網戸 など)",
    ),
    measurements: arr({ type: "string" }, "そのほかの寸法・書き込み"),
    items: arr(LINE_ITEM, "見積に使える作業の候補 (例: 畳表替え 6畳、襖張替え 4面)。単価は図面になければ null"),
    note: s("注意事項・書き込み"),
    ...COMMON,
  }),
  site_document: obj({
    title: s("書類名・件名 (施工仕様書・作業指示書・注文書 など)"),
    documentDate: s(`書類の${DATE}`),
    partnerName: s("発行元・取引先"),
    customerName: s("お客様名・施主"),
    siteAddress: s("現場の住所"),
    workDate: s(`施工予定の${DATE}`),
    items: arr(LINE_ITEM, "作業・材料の明細"),
    instructions: s("作業の指示・仕様・注意事項 (要点をまとめる)"),
    amount: n("金額の合計 (円。なければ null)"),
    note: s("そのほかの書き込み"),
    ...COMMON,
  }),
  supplier_invoice: obj({
    supplier: s("請求元 (仕入先・業者の名前)"),
    invoiceNumber: s("請求書番号"),
    invoiceDate: s(`請求日の${DATE}`),
    dueDate: s(`支払期限の${DATE}`),
    registrationNumber: s("適格請求書の登録番号 (T と 13 桁の数字)"),
    items: arr(SUPPLIER_LINE_ITEM, "請求の明細 (1 行ずつ。店舗名・現場名が明細ごとに書かれていれば行ごとに)"),
    subtotal: n("税抜の合計 (円)"),
    taxAmount: n("消費税額 (円)"),
    amount: n("請求金額 (税込の合計。円)"),
    note: s("振込先・備考"),
    ...COMMON,
  }),
  receipt: obj({
    vendor: s("店名・支払先"),
    date: s(`支払った${DATE}`),
    registrationNumber: s("登録番号 (T と 13 桁の数字。なければ null)"),
    items: arr(LINE_ITEM, "購入した品目"),
    amount: n("支払金額 (税込の合計。円)"),
    taxAmount: n("消費税額 (円)"),
    account: { type: "string", enum: [...EXPENSE_ACCOUNTS, ""], description: "勘定科目 (内容から選ぶ。決められなければ空文字)" },
    accountCandidates: arr(
      obj({ account: { type: "string", enum: [...EXPENSE_ACCOUNTS] }, reason: { type: "string", description: "その科目にした理由 (30 文字以内)" } }),
      "勘定科目の候補 (可能性の高い順に最大 3 つ。理由つき)",
    ),
    paymentMethod: { type: "string", enum: ["cash", "card", "transfer", ""], description: "支払方法 (cash=現金, card=カード・電子マネー, transfer=振込。分からなければ空文字)" },
    note: s("但し書き・備考"),
    ...COMMON,
  }),
  contract: obj({
    customerName: s("お客様名 (契約者)"),
    contractDate: s(`契約の${DATE}`),
    title: s("工事名・件名"),
    siteAddress: s("現場の住所"),
    amount: n("契約金額 (税込。円)"),
    items: arr(LINE_ITEM, "契約の明細"),
    note: s("特記事項・支払条件"),
    ...COMMON,
  }),
  survey_postcard: obj({
    postcardNo: s("はがき左上の No. (例: 13338・T698・H1309。英字も書かれたとおり)"),
    answeredOn: s(`はがき右上の回答${DATE}`),
    phoneScore: n("① 電話対応: ○が付いた番号 (1=大変不満 2=不満 3=普通 4=満足 5=大変満足)"),
    salesScore: n("② 営業担当者の対応: ○が付いた番号 (1〜5)"),
    craftsmanScore: n("③ 職人の対応: ○が付いた番号 (1〜5)"),
    finishScore: n("④ 工事の仕上がり: ○が付いた番号 (1〜5)"),
    priorityList: arr({ type: "string", enum: [...PRIORITY_OPTIONS] }, "⑤ ご利用にあたって重視されたこと: ○が付いた項目すべて"),
    priorityOther: s("⑤ 「その他」の括弧内の記入"),
    mediaList: arr({ type: "string", enum: [...MEDIA_OPTIONS] }, "⑥ 何を見てご依頼いただきましたか: ○が付いた項目すべて"),
    mediaOther: s("⑥ 「その他」の括弧内の記入 (例: 208号線の店舗を見て)"),
    wouldUseAgain: { type: "string", enum: ["はい", "いいえ", ""], description: "⑦ 次回も依頼したいか (○が付いた方。なければ空文字)" },
    comment: s("⑧ ご指摘・お褒めの言葉 (手書きの文を書かれたとおりに。改行は不要)"),
    salesName: s("下部の「営業担当 ( )」に書かれた名前"),
    craftsmanName: s("下部の「工事担当 ( )」に書かれた名前 (複数なら「、」で区切る)"),
    commentTags: arr({ type: "string", enum: [...COMMENT_TAGS] }, "⑧ の内容に当てはまる分類すべて (記述がなければ空)"),
    commentTone: { type: "string", enum: ["praise", "request", "complaint", "neutral"], description: "⑧ の内容の種類 (praise=お褒め, request=ご要望, complaint=ご指摘, neutral=その他・記述なし)" },
    ...COMMON,
  }),
  // 受付メモ (問い合わせの手書きメモ)。読み取り・登録は受付の画面 (src/lib/ai/reception.ts・/inquiries/reception)
  reception: RECEPTION_SCHEMA as unknown as Schema,
  other: obj({
    title: s("書類名・件名"),
    documentDate: s(`書類の${DATE}`),
    partnerName: s("取引先・発行元"),
    summary: s("内容の要約 (2〜3 文)"),
    fields: arr(obj({ label: { type: "string" }, value: { type: "string" } }), "そのほかの項目 (見出しと値)"),
    items: arr(LINE_ITEM, "明細があれば"),
    ...COMMON,
  }),
};

/** 書類の種類ごとの項目名 (確認画面で修正した値は、この項目だけ受け取る) */
export const FIELD_KEYS: Record<DocumentKind, string[]> = Object.fromEntries(
  Object.entries(SCHEMAS).map(([k, schema]) => [k, Object.keys((schema as { properties: Record<string, unknown> }).properties).filter((p) => p !== "confidence" && p !== "warnings" && p !== "lineCount")]),
) as Record<DocumentKind, string[]>;

const KIND_HINT: Record<DocumentKind, string> = {
  handwritten_quote: [
    "株式会社一畳屋の手書きの「御見積書」(複写式) です。ヘッダー (日付・No.・引取日時・納品日時・ふりがな・氏名・住所・Tel・担当者・税込合計金額・支払い方法)、明細、小計・消費税・合計、備考欄、その下の欄 (荷物・1人 OK/NG・かえ畳・戸建て F・サイズ・わら・建材・脚立など・紙カーテン・搬出・雨天・媒体・襖紙) をすべて読み取ってください。",
    "- 品名・規格の欄の「〃」「ヽ」「ゝ」「ミ」「4」のような記号は「上と同じ」の意味です。上の行の文字に置き換えてください (例: 1 行目が「畳表替え」で 2 行目が「〃」なら 2 行目も「畳表替え」)。",
    "- 明細の金額欄はケタごとの枠です。単価 × 数量と金額が合うか確かめ、合わないときは uncertain を true にしてください。",
    "- ▲ や △ が付いた数 (値引き・割引) はマイナスの数にしてください。",
    "- 取り消し線・二重線・塗りつぶしで消した数字・文字は使わず、書き直した値 (枠の上・横・すぐ下に小さく書かれることが多い) を使ってください。消して書き直した箇所はすべて corrections に「どこを・消した値 → 書き直した値」で書き、その明細の行は corrected を true にしてください。消した値しかなく書き直しが見つからないときは uncertain を true に。",
    "- 明細は行を 1 行も省かないでください。まず明細の欄で何かが書かれている行を上から数えて lineCount に入れ、items にはその数と同じ行数を、用紙の上から順に入れます (並べ替えない・2 行を 1 行にまとめない・1 行を分けない)。各行の line には何行目か (1 から) を入れます。",
    "- 読み取れない・一部しか読めない行も省かずに、読めた範囲で入れてください (読めない品名は空文字、読めない数字は null)。その行は uncertain を true にします。担当者があとで写真と見比べて直します。",
    "- 明細の行の金額欄にある ▲ 付きの数字 (値引き・金券・割引) も、1 つずつ明細の行にします。小計・消費税・合計の欄やその近くに書かれた ▲ の値引きは、明細ではなく discount (正の数) に入れます。行を省くと合計が合わなくなります。",
    "- 最後に、明細の金額の合計 − 値引き が 書かれた合計 (税込合計金額) と合うか見直してください。合わなければ、読み落とした行・▲ の数字・読み違えた桁がないか画像をもう一度確かめ、それでも合わなければ warnings に書いてください (合わせるために数字を作らないでください)。",
    "- 「税込 / 税抜」に○があれば taxMode に。単価が税込のことが多いです。",
    "- 読めない・判断が難しい文字は推測で埋めず、項目名を uncertainFields に入れてください。",
    "- よく出る言葉 (読み取りの参考): 畳表替え・新調・裏返し・へり (縁)・防ダニ・織部・さくら・めぐみ・古都・襖 (フスマ) 張替え・板戸・片面・両面・裏貼り・両開き・引手・丁番・下地補修・朱雀・しずか・ちどり・鳥の子・障子張替え・ストライク・ワーロン・雲竜・無地・網戸 (アミド) 張替え・18メッシュ・グレー・ブラック・カーテン・レース・Aフック・タッセル・2割引・DM値引・諸経費・処分・引取。",
  ].join("\n"),
  drawing: "現場の図面・採寸メモです。部屋の広さ・畳の枚数・建具 (襖・障子・網戸) の枚数と寸法・書き込みを読み取り、見積に使える作業の候補を items に並べてください。",
  site_document: "施工資料 (施工仕様書・作業指示書・注文書など) です。件名・お客様・現場・施工予定日・作業と材料の明細・指示事項を読み取ってください。",
  supplier_invoice: "仕入先・業者から届いた請求書です。請求元・番号・請求日・支払期限・登録番号・明細・税額・請求金額を読み取ってください。",
  receipt: "レシートまたは領収書です。店名・日付・品目・支払金額・消費税額・支払方法を読み取り、勘定科目を選んでください。",
  contract: "工事の契約書です。契約者・契約日・工事名・現場・契約金額・明細を読み取ってください。",
  survey_postcard:
    "株式会社一畳屋のお客様アンケートはがき (手書きの記入・○囲み) です。左上の No.、右上の日付、設問①〜④は○が付いた番号 (1〜5)、⑤⑥は○が付いた項目すべて、⑦ははい/いいえ、⑧は自由記述、下部の営業担当・工事担当の名前を読み取ってください。○が数字と項目名のどちらに付いていても、その選択肢を選んだものとして扱ってください。○が 2 つにまたがるなど判断できない設問は null にして warnings に書いてください。",
  reception: "来店・イベント・電話のときに社員が書いた手書きの受付メモです。お客様のお名前・電話番号・住所・用件・内容を読み取ってください。",
  other: "書類の内容を読み取り、件名・日付・取引先・要約と主な項目をまとめてください。",
};

/** 金額を書く前に撮影した見積書 (mode = calc) の読み方 */
const CALC_HINT = [
  "■ この見積書は、職人が金額を書く前 (品名・規格・数量・単価まで記入した段階) に撮影したものです。数量 × 単価・小計・合計はこのあとシステムが計算し、その結果を職人が書き写します。",
  "- 数量と単価は掛け算に使うため、1 文字ずつ正確に読み取ってください。少しでも迷う数字 (1 と 7、6 と 8、0 と 6、桁の数) があれば、その行の uncertain を true にし、warnings に書いてください。",
  "- 金額欄・小計・消費税・合計・税込合計金額は空欄が普通です。空欄の金額を自分で計算して埋めないでください (amount・subtotal・tax・total・totalTaxIncluded は null)。",
  "- 金額欄に数字が書かれている行 (諸経費・▲ の値引き・金券など) は、その金額を amount に入れてください。",
  "- 「2割引」「20%引」のように割合だけが書かれた値引きの行は、品名にそのまま書き、数量・単価・金額は null にしてください (システムが計算します)。",
].join("\n");

function systemPrompt(kind: DocumentKind, products: Product[], mode?: OcrMode): string {
  return [
    "あなたは畳・襖・障子・網戸の専門店 (株式会社一畳屋、熊本) の事務担当です。撮影・スキャンした業務書類を読み取り、指定の JSON の項目に入れてください。",
    KIND_HINT[kind],
    ...(mode === "calc" && kind === "handwritten_quote" ? [CALC_HINT] : []),
    "- 書かれている内容だけを使い、推測で値を作らないでください。読めない・書かれていない項目は、文字なら空文字、数値なら null にしてください。読みにくい箇所は warnings に書いてください。",
    "- 金額は円の整数 (カンマ・円記号なし)。日付は YYYY-MM-DD (令和・平成などの和暦は西暦に直す)。",
    "- 手書きの数字で迷う箇所 (1 と 7、6 と 8 など) は warnings に書いてください。",
    "- 明細の金額が書かれていない行は、数量 × 単価が分かれば計算せずに null のままにしてください (システムで計算します)。",
    "- confidence は読み取り全体の確からしさ (0〜1) です。",
    `参考 (自社の商品名): ${products.filter((p) => p.active).map((p) => p.name).join(" / ")}`,
  ].join("\n");
}

/* ================================================================== */
/* 読取                                                                 */
/* ================================================================== */

export async function extractDocument(params: { kind: DocumentKind; fileName: string; mimeType: string; base64?: string; products: Product[]; storeId: StoreId; mode?: OcrMode }): Promise<OcrResult> {
  const { kind, fileName, mimeType, base64, products } = params;
  const mode = kind === "handwritten_quote" ? params.mode : undefined;
  if (!aiEnabled() || !base64) return mockExtract(kind, fileName, products, mode);
  const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(fileName);
  const isImage = /^image\/(png|jpeg|jpg|webp|gif)$/.test(mimeType);
  if (!isPdf && !isImage) {
    return failed(kind, "このファイルは AI で読み取れません。写真 (JPEG・PNG) か PDF を取り込んでください。");
  }
  const document: AiPart = isPdf ? { type: "pdf", base64, fileName } : { type: "image", mediaType: mimeType === "image/jpg" ? "image/jpeg" : mimeType, base64 };
  const ask = `書類の種類: ${kind}${mode === "calc" ? " (金額を書く前の見積書)" : ""}。この書類を読み取ってください。`;
  const request = (text: string) =>
    generateJson<Record<string, unknown>>({
      system: systemPrompt(kind, products, mode),
      parts: [document, { type: "text", text }],
      schema: SCHEMAS[kind],
      schemaName: `ichijoya_${kind}`,
      maxTokens: 8000,
    });
  try {
    let r = await request(ask);
    let ms = r.ms;
    let rowWarnings: string[] = [];
    if (kind === "handwritten_quote") {
      // 数えた行より少ない行しか返ってこなかったときは 1 回だけ読み直す (行の読み落としを防ぐ。お客様のご要望 2026-11-26「■1」)
      const first = checkRows(r.data.items, r.data.lineCount);
      if (first.missing > 0) {
        try {
          const again = await request(`${ask}\n${retryInstruction(first)}`);
          ms += again.ms;
          if (checkRows(again.data.items, again.data.lineCount).read > first.read) r = again;
        } catch (err) {
          console.warn(`[ocr] re-read for missing rows failed (${fileName}):`, err instanceof AiError ? err.code : err);
        }
      }
      // 空欄の行だけを除き、順番はそのまま、まだ足りない行は空の行 (要確認) で埋める
      const rec = reconcileRows(r.data.items, r.data.lineCount);
      rowWarnings = rec.warnings;
      const data: Record<string, unknown> = { ...r.data, items: rec.rows };
      delete data.lineCount;
      r = { ...r, data };
    }
    const { extracted, warnings } = normalizeExtracted(kind, markCorrectedRows(r.data), products, { mode });
    const confidence = typeof r.data.confidence === "number" && r.data.confidence >= 0 && r.data.confidence <= 1 ? r.data.confidence : 0.8;
    return { provider: r.provider, model: r.model, confidence, extracted, warnings: [...rowWarnings, ...warnings], ms };
  } catch (err) {
    const message = err instanceof AiError ? err.message : "AI の読み取りに失敗しました。";
    console.warn(`[ocr] extraction failed (${kind}, ${fileName}):`, err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : err);
    return failed(kind, message);
  }
}

/** AI が「消して書き直した」とした明細は、確認が済むまで要確認 (黄色) にする (AI の読取の直後だけ) */
function markCorrectedRows(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data.items)) return data;
  return { ...data, items: (data.items as Record<string, unknown>[]).map((r) => (r && r.corrected === true ? { ...r, uncertain: true } : r)) };
}

/** 読み取りに失敗したとき: 空の項目 (手入力用) */
function failed(kind: DocumentKind, message: string): OcrResult {
  return { provider: "error", confidence: 0, extracted: emptyExtracted(kind), warnings: [message], error: message };
}

/** 手入力用の空の項目 */
export function emptyExtracted(kind: DocumentKind): Record<string, unknown> {
  switch (kind) {
    case "handwritten_quote":
      return { customerName: "", siteAddress: "", title: "", items: [] };
    case "drawing":
      return { siteName: "", siteAddress: "", rooms: [], fittings: [], measurements: [], items: [] };
    case "site_document":
      return { title: "", customerName: "", siteAddress: "", items: [], instructions: "" };
    case "supplier_invoice":
      return { supplier: "", invoiceDate: toDateKey(new Date()), items: [] };
    case "receipt":
      return { vendor: "", date: toDateKey(new Date()), items: [] };
    case "contract":
      return { customerName: "", title: "", items: [] };
    case "survey_postcard":
      return { postcardNo: "", priorityList: [], mediaList: [], comment: "" };
    default:
      return { title: "", summary: "", fields: [], items: [] };
  }
}

/* ================================================================== */
/* 読み取った値の整形と点検                                              */
/* ================================================================== */

const toNum = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const t = v.normalize("NFKC").replace(/[,，円¥\s]/g, "").replace(/^[▲△]/, "-");
    if (!t) return undefined;
    const x = Number(t);
    return Number.isFinite(x) ? x : undefined;
  }
  return undefined;
};
const toStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function validDate(v: unknown): string | undefined {
  const t = toStr(v)?.normalize("NFKC").replace(/\//g, "-");
  const m = t?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? undefined : iso;
}

/**
 * 明細の行をそろえる。keepUnnamed (手書き見積書): 品名が読めない行も、数字・規格・要確認の印があれば残す
 * (品名は空・要確認。お客様のご要望 2026-11-26「■1」: 行そのものは省かない)。ほかの書類は品名のない行を除く
 */
export function normalizeItems(raw: unknown, products: Product[], opts: { keepUnnamed?: boolean } = {}): LineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: LineItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const name = toStr(r.name);
    if (!name && !(opts.keepUnnamed && hasRowContent(r))) continue;
    const qty = toNum(r.qty);
    const unitPrice = toNum(r.unitPrice);
    let amount = toNum(r.amount);
    const calculated = amount === undefined && qty !== undefined && unitPrice !== undefined;
    if (calculated) amount = Math.round(qty * unitPrice);
    const rate = toNum(r.rate);
    // 品名が読めない行は商品マスタに当てない (規格だけで別の商品の単価が入らないように)
    const p = name ? matchProduct(products, `${name} ${toStr(r.spec) ?? ""}`) : undefined;
    out.push({
      name: name ?? "",
      spec: toStr(r.spec),
      qty: qty ?? (amount !== undefined && unitPrice === undefined ? 1 : undefined),
      unit: toStr(r.unit) ?? p?.unit,
      unitPrice: unitPrice ?? (amount !== undefined && (qty === undefined || qty === 1) ? amount : undefined),
      amount: amount !== undefined ? Math.round(amount) : undefined,
      productId: p?.id,
      ...(toStr(r.code) ? { code: toStr(r.code) } : {}),
      ...(toStr(r.storeName) ? { storeName: toStr(r.storeName) } : {}),
      ...(toStr(r.siteName) ? { siteName: toStr(r.siteName) } : {}),
      ...(toStr(r.lineNote) ? { lineNote: toStr(r.lineNote) } : {}),
      ...(r.corrected === true ? { corrected: true } : {}),
      ...(calculated ? { amountCalculated: true } : {}),
      ...(rate !== undefined && rate > 0 && rate < 1 ? { rate } : {}),
      ...(r.uncertain === true || !name || (qty !== undefined && unitPrice !== undefined && amount !== undefined && Math.abs(Math.round(qty * unitPrice) - amount) > 1) ? { uncertain: true } : {}),
    });
  }
  return out;
}

/** 部屋・建具の行: 数値の列を数値に、空の行を除く */
function normalizeRows(raw: unknown, numberKeys: string[], requiredKey: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (numberKeys.includes(k)) {
        const x = toNum(v);
        if (x !== undefined) row[k] = x;
      } else {
        const t = toStr(v);
        if (t) row[k] = t;
      }
    }
    if (row[requiredKey] || row.name || numberKeys.some((k) => row[k] !== undefined)) out.push(row);
  }
  return out;
}

const DATE_FIELDS = ["answeredOn", "quoteDate", "drawingDate", "documentDate", "workDate", "invoiceDate", "dueDate", "date", "contractDate"];
const NUMBER_FIELDS = ["subtotal", "discount", "tax", "total", "taxAmount", "amount", "totalTaxIncluded", "spareTatami"];
const HW_ENUMS: Record<string, readonly string[]> = { paymentMethod: PAYMENT_OPTIONS, taxMode: ["税込", "税抜"], oneOk: ["OK", "NG"], straw: ["A", "B"], material: ["A", "B"], carryOut: ["遠", "近"], rain: ["OK", "NG"] };
const HW_LISTS: Record<string, readonly string[]> = { equipment: EQUIPMENT_OPTIONS, media: SITE_MEDIA_OPTIONS };
const HW_LABEL: Record<string, string> = { items: "明細", title: "件名", paymentNote: "支払いの補足", discount: "値引き", otherNotes: "欄外の書き込み", mediaOther: "媒体 (その他)", paperCurtain: "紙カーテン", paperNo: "No.", quoteDate: "日付", furigana: "ふりがな", customerName: "氏名", siteAddress: "住所", phone: "Tel", staffName: "担当者", pickupAt: "引取日時", deliveryAt: "納品日時", totalTaxIncluded: "税込合計金額", paymentMethod: "支払い方法", taxMode: "税込/税抜", subtotal: "小計", tax: "消費税", total: "合計", note: "備考", baggage: "荷物", oneOk: "1人 OK/NG", spareTatami: "かえ畳", floor: "戸建て F", sizes: "サイズ", straw: "わら", material: "建材", equipment: "道具", carryOut: "搬出", rain: "雨天", media: "媒体", fusumaPaper: "襖紙" };
const SCORE_FIELDS = ["phoneScore", "salesScore", "craftsmanScore", "finishScore"];
const LIST_OPTIONS: Record<string, readonly string[]> = { priorityList: PRIORITY_OPTIONS, mediaList: MEDIA_OPTIONS, commentTags: COMMENT_TAGS };

/**
 * 手書き見積書の割合の値引き (「2割引」など) の行に、上の行から計算した金額を入れる (quote-sheet-calc.ts と同じ計算)。
 * 対象の行が 2 行以上・計算できないときは要確認にする
 */
function applyRateRows(items: LineItem[]): LineItem[] {
  const res = calcSheet(items, { taxIncluded: true });
  return items.map((it, i) => {
    const r = res.rows[i];
    if (r.source !== "rate" && !(r.source === "missing" && r.rate)) return it;
    if (r.amount === null) return { ...it, rate: r.rate, uncertain: true };
    return { ...it, rate: r.rate, qty: 1, unitPrice: r.amount, amount: r.amount, ...(r.ambiguous ? { uncertain: true } : {}) };
  });
}

/**
 * 金額を書く前の見積書 (mode = calc): 小計・消費税・合計・税込合計金額をシステムの計算で埋める
 * (用紙に書かれた合計ではなく、職人が書き写す金額。見積の作成画面でも同じ計算になる)
 */
export function applyCalcTotals(ex: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(ex.items) ? (ex.items as LineItem[]) : [];
  const taxIncluded = ex.taxMode === "税抜" ? false : ex.taxMode === "税込" ? true : ex.taxIncluded !== false;
  const discount = typeof ex.discount === "number" ? ex.discount : 0;
  const r = calcSheet(items, { taxIncluded, discount });
  return { ...ex, taxIncluded, subtotal: r.subtotal, tax: r.tax, total: r.total, totalTaxIncluded: r.total };
}

/** AI・手入力の値を同じ形にそろえ、合計の食い違いなどを warnings にする */
export function normalizeExtracted(kind: DocumentKind, raw: Record<string, unknown>, products: Product[], opts: { mode?: OcrMode } = {}): { extracted: Record<string, unknown>; warnings: string[] } {
  const warnings = Array.isArray(raw.warnings) ? (raw.warnings as unknown[]).filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim()) : [];
  const ex: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "confidence" || k === "warnings" || k.startsWith("_")) continue;
    if (v === null || v === undefined || v === "") continue;
    if (DATE_FIELDS.includes(k)) {
      const d = validDate(v);
      if (d) ex[k] = d;
      else warnings.push(`日付「${String(v)}」を読み取れませんでした`);
    } else if (NUMBER_FIELDS.includes(k)) {
      const x = toNum(v);
      // 値引きは正の数 (AI が ▲ をマイナスにして返すことがある)
      if (x !== undefined) ex[k] = k === "discount" ? Math.abs(Math.round(x)) : Math.round(x);
    } else if (kind === "handwritten_quote" && HW_ENUMS[k]) {
      if (HW_ENUMS[k].includes(String(v))) ex[k] = v;
    } else if (kind === "handwritten_quote" && HW_LISTS[k]) {
      const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、|]/) : []).map((x) => String(x).trim());
      ex[k] = [...new Set(list.filter((x) => HW_LISTS[k].includes(x)))];
    } else if (k === "corrections") {
      ex.corrections = (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 200));
    } else if (k === "uncertainFields") {
      ex.uncertainFields = (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.trim() !== "");
    } else if (k === "phone") {
      const t = String(v).normalize("NFKC").replace(/[^\d-]/g, "");
      if (t) ex.phone = t;
    } else if (SCORE_FIELDS.includes(k)) {
      const x = toNum(v);
      if (x !== undefined && Number.isInteger(x) && x >= 1 && x <= 5) ex[k] = x;
      else warnings.push(`評価「${String(v)}」は 1〜5 ではないため空欄にしました`);
    } else if (LIST_OPTIONS[k]) {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、\n]+/) : [];
      ex[k] = [...new Set(list.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => LIST_OPTIONS[k].includes(x)))];
    } else if (k === "postcardNo") {
      const p = normPostcardNo(String(v));
      if (p) ex.postcardNo = p;
    } else if (k === "wouldUseAgain") {
      if (v === "はい" || v === "いいえ") ex.wouldUseAgain = v;
    } else if (k === "commentTone") {
      if (["praise", "request", "complaint", "neutral"].includes(String(v))) ex.commentTone = v;
    } else if (k === "accountCandidates") {
      // 勘定科目の候補 (AI)。確認画面の入力欄ではないため、_ で始まる名前で残す
      const c = readCandidates(v);
      if (c.length) ex._accountCandidates = c;
    } else if (k === "items") {
      ex.items = normalizeItems(v, products, { keepUnnamed: kind === "handwritten_quote" });
    } else if (k === "rooms" || k === "fittings") {
      ex[k] = normalizeRows(v, k === "rooms" ? ["widthMm", "depthMm", "tatamiCount"] : ["count", "widthMm", "heightMm"], k === "rooms" ? "name" : "kind");
    } else if (k === "fields") {
      ex.fields = Array.isArray(v) ? (v as Record<string, unknown>[]).map((r) => ({ label: toStr(r?.label) ?? "", value: toStr(r?.value) ?? "" })).filter((r) => r.label || r.value) : [];
    } else if (k === "measurements") {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
      ex.measurements = list.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
    } else if (typeof v === "string") {
      ex[k] = v.trim();
    } else {
      ex[k] = v;
    }
  }
  if (kind === "survey_postcard") {
    // ⑧ の分類が空のとき (手入力・修正後) は簡易ルールで付ける
    if (typeof ex.comment === "string" && ex.comment && !(Array.isArray(ex.commentTags) && ex.commentTags.length)) {
      const t = tagComment(ex.comment);
      ex.commentTags = t.tags;
      ex.commentTone ??= t.tone;
    }
    for (const k of SCORE_FIELDS) if (ex[k] === undefined) warnings.push(`${({ phoneScore: "①", salesScore: "②", craftsmanScore: "③", finishScore: "④" } as Record<string, string>)[k]} の評価が読み取れていません`);
    if (!ex.postcardNo) warnings.push("はがきの No. が読み取れていません (案件との紐づけに使います)");
    return { extracted: ex, warnings: [...new Set(warnings)] };
  }
  if (!Array.isArray(ex.items)) ex.items = [];
  if (kind === "handwritten_quote") ex.items = applyRateRows(ex.items as LineItem[]);
  const items = ex.items as LineItem[];
  const sum = items.reduce((a, i) => a + (i.amount ?? 0), 0);
  if (kind === "handwritten_quote") {
    // 税込・税抜の判定: ○があればそれ。なければ 明細の合計 と 税込合計金額 の関係から
    const totalIn = (ex.totalTaxIncluded ?? ex.total) as number | undefined;
    const disc = (ex.discount as number) ?? 0;
    if (ex.taxMode === "税込") ex.taxIncluded = true;
    else if (ex.taxMode === "税抜") ex.taxIncluded = false;
    else if (totalIn !== undefined && items.length) ex.taxIncluded = Math.abs(sum - disc - totalIn) <= Math.abs(Math.floor((sum - disc) * 1.1) - totalIn);
    if (totalIn !== undefined && items.length) {
      const expected = ex.taxIncluded ? sum - disc : sum - disc + Math.floor((sum - disc) * 0.1);
      if (Math.abs(expected - totalIn) > 2) warnings.push(`明細から計算した合計 (${expected.toLocaleString("ja-JP")} 円) と、書かれた合計 (${totalIn.toLocaleString("ja-JP")} 円) が一致しません`);
    }
    const corrections = Array.isArray(ex.corrections) ? (ex.corrections as string[]) : [];
    if (corrections.length) warnings.push(`消して書き直した箇所 (書き直した値で読んでいます。元の書類と見比べてください): ${corrections.join(" / ")}`);
    const unsure = Array.isArray(ex.uncertainFields) ? (ex.uncertainFields as string[]) : [];
    if (unsure.length) warnings.push(`要確認: ${unsure.map((k) => HW_LABEL[k] ?? k).join("・")}`);
    const rows = items.filter((i) => i.uncertain).length;
    if (rows) warnings.push(`読み取りに自信がない明細が ${rows} 行あります (黄色の行)`);
    const unnamed = items.filter((i) => !i.name).length;
    if (unnamed) warnings.push(`品名を読み取れなかった明細が ${unnamed} 行あります (品名が空の行)。写真と見比べて入力してください`);
    const rateRows = items.filter((i) => i.rate && i.uncertain).length;
    if (rateRows) warnings.push(`割合の値引き (「2割引」など) の対象の行を確かめてください (${rateRows} 行)`);
    if (opts.mode === "calc") {
      if (!ex.taxMode) warnings.push("「税込 / 税抜」に○がないため、税込 (単価に消費税を含む) として計算しました。違うときは切り替えてください");
      const missing = items.filter((i) => i.amount === undefined).length;
      if (missing) warnings.push(`数量か単価が読み取れず、金額を計算できない明細が ${missing} 行あります`);
    } else if (!ex.customerName) warnings.push("氏名が読み取れていません");
    return { extracted: opts.mode === "calc" ? applyCalcTotals(ex) : ex, warnings: [...new Set(warnings)] };
  }
  const subtotal = ex.subtotal as number | undefined;
  const tax = (ex.tax ?? ex.taxAmount) as number | undefined;
  const total = (ex.total ?? ex.amount) as number | undefined;
  if (items.length && subtotal !== undefined && Math.abs(sum - subtotal + ((ex.discount as number) ?? 0)) > 1 && Math.abs(sum - subtotal) > 1) {
    warnings.push(`明細の合計 (${sum.toLocaleString("ja-JP")} 円) と小計 (${subtotal.toLocaleString("ja-JP")} 円) が一致しません`);
  }
  if (subtotal !== undefined && tax !== undefined && total !== undefined && Math.abs(subtotal - ((ex.discount as number) ?? 0) + tax - total) > 2) {
    warnings.push(`小計・消費税・合計の計算が合いません (${subtotal.toLocaleString("ja-JP")} + ${tax.toLocaleString("ja-JP")} ≠ ${total.toLocaleString("ja-JP")})`);
  }
  const reg = ex.registrationNumber as string | undefined;
  if (reg) {
    const t = reg.normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
    if (/^T\d{13}$/.test(t)) ex.registrationNumber = t;
    else warnings.push(`登録番号「${reg}」の形 (T と 13 桁) が正しくありません`);
  }
  if (kind === "receipt" && ex.account && !(EXPENSE_ACCOUNTS as readonly string[]).includes(ex.account as string)) delete ex.account;
  if (kind === "receipt") {
    // AI の候補がないとき (サンプル読取・手入力) は、店名・品目・但し書きと金額からルールで候補を出す
    if (!ex._accountCandidates) {
      const rule = suggestAccounts({ vendor: ex.vendor as string | undefined, description: ex.note as string | undefined, items: items.map((i) => i.name), amount: ex.amount as number | undefined });
      if (rule.length) ex._accountCandidates = rule;
    }
    const cands = ex._accountCandidates as { account: string }[] | undefined;
    if (!ex.account && cands?.length) ex.account = cands[0].account;
  }
  if (typeof ex.paymentMethod === "string") {
    const pm = ex.paymentMethod.toLowerCase();
    if (["cash", "card", "transfer"].includes(pm)) ex.paymentMethod = pm;
    else delete ex.paymentMethod;
  }
  if (items.some((i) => i.amount === undefined && i.qty !== undefined && i.unitPrice === undefined) && kind !== "drawing") warnings.push("単価・金額が読み取れない明細があります");
  return { extracted: ex, warnings: [...new Set(warnings)] };
}

/* ================================================================== */
/* デモ用のサンプル読取 (API キーがないとき)                               */
/* ================================================================== */

function hashStr(str: string): number {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function mockExtract(kind: DocumentKind, fileName: string, products: Product[], mode?: OcrMode): OcrResult {
  const h = hashStr(fileName + kind);
  const pick = <T>(list: readonly T[], salt = 0): T => list[(h + salt) % list.length];
  const today = toDateKey(new Date());
  const lower = fileName.toLowerCase();
  const conf = 0.86 + (h % 11) / 100;
  const warnings: string[] = ["サンプルの読取結果です (AI の API キーが未設定)"];
  const done = (raw: Record<string, unknown>, c = conf, extra: string[] = []): OcrResult => {
    const { extracted, warnings: w } = normalizeExtracted(kind, raw, products, { mode });
    return { provider: "mock", confidence: c, extracted, warnings: [...warnings, ...extra, ...w] };
  };
  switch (kind) {
    case "handwritten_quote": {
      const tatami = products.filter((p) => p.category === "tatami" && p.id !== "p_t_disposal" && p.active);
      const main = pick(tatami);
      const qty = pick([4.5, 6, 6, 8, 8, 10, 12], 3);
      const items: Record<string, unknown>[] = [
        { name: main.name, spec: main.grade, qty, unit: main.unit, unitPrice: main.unitPrice },
        { name: "古畳 引取・処分", qty, unit: "畳", unitPrice: 1000 },
        { name: "諸経費 (一式)", qty: 1, unit: "式", unitPrice: 3000 },
      ];
      if (h % 3 === 0) {
        const f = pick(products.filter((p) => p.category === "fusuma" && p.active), 5);
        items.splice(1, 0, { name: f.name, spec: f.grade, qty: pick([2, 4, 6], 7), unit: f.unit, unitPrice: f.unitPrice });
      }
      const subtotal = items.reduce((a, i) => a + Math.round((i.qty as number) * (i.unitPrice as number)), 0);
      if (mode === "calc") {
        // 金額を書く前の見積書: 金額欄・合計は空欄。割合の値引きの行を 1 つ入れる
        items.splice(1, 0, { name: "畳 1割引" });
        return done({ paperNo: String(100 + (h % 900)), quoteDate: today, title: `${main.name} ${qty}畳`, taxMode: "税込", items: items.map((i) => (i.name === "諸経費 (一式)" ? { ...i, qty: null, unitPrice: null, amount: 3000 } : i)) }, conf, ["数量・単価を用紙と見比べてから、金額を書き写してください"]);
      }
      return done(
        {
          paperNo: String(100 + (h % 900)),
          customerName: pick(["田中 一郎", "山本 花子", "○○介護施設", "松本 健"], 2),
          furigana: pick(["たなか いちろう", "やまもと はなこ", "", "まつもと けん"], 2),
          siteAddress: pick(["熊本市東区", "合志市須屋", "玉名市大倉", "熊本市南区近見"], 4),
          phone: "090-0000-0000",
          staffName: "",
          quoteDate: today,
          title: `${main.name.replace("畳表替え ", "畳表替え (")}${main.name.startsWith("畳表替え ") ? ")" : ""} ${qty}畳`,
          pickupAt: `${addDays(today, 7).slice(5).replace("-", "/")} 8:30〜9:30`,
          deliveryAt: `${addDays(today, 9).slice(5).replace("-", "/")} PM`,
          paymentMethod: "現金",
          taxMode: "税込",
          items,
          subtotal,
          totalTaxIncluded: subtotal,
          note: "家具の移動あり (サンプル)",
          baggage: "タンス",
          oneOk: "NG",
          spareTatami: 2,
          floor: "戸建て 1F",
          sizes: "880×1760",
          straw: "A",
          equipment: ["台車"],
          carryOut: "近",
          rain: "OK",
          media: ["チラシ"],
        },
        conf,
        h % 4 === 0 ? ["数量の手書き文字 (6 と 8) の判別確度が低いため確認してください"] : [],
      );
    }
    case "receipt": {
      const presets = [
        { vendor: "ENEOS 合志SS", account: "車両費 (ガソリン代)", amount: 6820, paymentMethod: "card", item: "レギュラーガソリン" },
        { vendor: "ホームセンター アグリ 合志店", account: "消耗品費", amount: 4380, paymentMethod: "cash", item: "養生シート・テープ" },
        { vendor: "セブン-イレブン 熊本保田窪店", account: "会議費", amount: 1296, paymentMethod: "cash", item: "飲料" },
        { vendor: "NEXCO西日本 (ETC)", account: "旅費交通費", amount: 2310, paymentMethod: "card", item: "高速道路料金" },
      ];
      let preset = pick(presets);
      if (lower.includes("eneos") || lower.includes("ガソリン") || lower.includes("gas")) preset = presets[0];
      if (lower.includes("etc") || lower.includes("高速")) preset = presets[3];
      return done({ vendor: preset.vendor, date: addDays(today, -(h % 4)), items: [{ name: preset.item, qty: 1, amount: preset.amount }], amount: preset.amount, taxAmount: Math.floor(preset.amount - preset.amount / 1.1), account: preset.account, paymentMethod: preset.paymentMethod }, Math.min(0.98, conf + 0.05));
    }
    case "supplier_invoice": {
      const presets = [
        { supplier: "熊本県い草生産者協同組合", amount: 412500, desc: "い草・畳表" },
        { supplier: "九州畳材 株式会社", amount: 198000, desc: "畳床・畳縁" },
        { supplier: "和紙工房 ふすま堂", amount: 66000, desc: "襖紙・障子紙" },
      ];
      const p = pick(presets);
      const invoiceDate = addDays(today, -(h % 10));
      const subtotal = Math.round(p.amount / 1.1);
      return done({ supplier: p.supplier, invoiceNumber: `INV-${(h % 9000) + 1000}`, invoiceDate, dueDate: addDays(invoiceDate, 30), registrationNumber: `T${String(1000000000000 + (h % 8999999999999))}`, items: [{ name: p.desc, qty: 1, unit: "式", unitPrice: subtotal, amount: subtotal }], subtotal, taxAmount: p.amount - subtotal, amount: p.amount });
    }
    case "drawing":
      return done(
        {
          siteName: "○○様邸",
          siteAddress: "合志市須屋",
          drawingDate: today,
          rooms: [{ name: "和室 (1F)", size: "6畳", widthMm: 3640, depthMm: 2730, tatamiCount: 6 }, { name: "続き間", size: "4.5畳", widthMm: 2730, depthMm: 2730, tatamiCount: 4.5 }],
          fittings: [{ kind: "襖", name: "押入", count: 2, widthMm: 880, heightMm: 1780 }, { kind: "障子", name: "縁側", count: 4, widthMm: 900, heightMm: 1780 }],
          measurements: ["敷居 3640", "鴨居高さ 1780"],
          items: [{ name: "畳表替え", qty: 10.5, unit: "畳" }, { name: "襖張替え", qty: 2, unit: "面" }, { name: "障子張替え", spec: "大", qty: 4, unit: "枚" }],
          note: "縁側側の障子は破れあり",
        },
        conf - 0.05,
        ["図面の寸法は現地採寸で再確認してください"],
      );
    case "site_document":
      return done({ title: "施工仕様書 (サンプル)", documentDate: today, partnerName: "○○工務店", customerName: "○○様", siteAddress: "熊本市中央区", workDate: addDays(today, 7), items: [{ name: "畳表替え さくら", qty: 8, unit: "畳" }, { name: "古畳 引取・処分", qty: 8, unit: "畳" }], instructions: "午前中に引き取り、翌日午後に納品。家具の移動あり。", note: "鍵は管理人室で受け取り" });
    case "survey_postcard": {
      const no = (fileName.match(/([A-Za-z]?\d{3,6})/) ?? [])[1] ?? String(10000 + (h % 9000));
      return done(
        {
          postcardNo: no,
          answeredOn: addDays(today, -(h % 5)),
          phoneScore: pick([4, 5, 4], 1),
          salesScore: pick([5, 4, 5], 2),
          craftsmanScore: pick([5, 4, 5], 3),
          finishScore: pick([4, 5, 5], 4),
          priorityList: pick([["対応", "安心感"], ["価格", "評判"], ["知名度", "所在地", "安心感"]], 5),
          mediaList: pick([["以前頼んだことがある"], ["店舗"], ["グーグルマップ", "口コミ"]], 6),
          wouldUseAgain: "はい",
          comment: pick(["仕上がりがきれいで満足しています。ありがとうございました。", "担当の方が丁寧に説明してくださり、安心してお願いできました。", "気持ちよく対応してもらえました。"], 7),
          salesName: "",
          craftsmanName: "",
        },
        conf,
        ["担当者の名前は手書きのため、案件の担当者から選んでください"],
      );
    }
    case "contract":
      return done({ customerName: "○○様", contractDate: today, title: "畳表替え工事", amount: 223300, items: [{ name: "畳表替え 古都", qty: 8, unit: "畳", unitPrice: 25000 }], note: "請負契約書 (サンプル)" });
    default:
      return done({ title: fileName, documentDate: today, summary: "書類の内容を読み取りました (サンプル)", fields: [{ label: "件名", value: fileName }] });
  }
}
