import "server-only";
import type { Database } from "@/lib/db/types";
import { CATEGORY_LABEL } from "@/lib/constants";
import { normalizeReception, ruleReception, RECEPTION_FIELD_KEYS, RECEPTION_TYPES, type ReceptionFields } from "@/lib/reception";
import { AiError, aiEnabled, generateJson, type AiPart } from "./provider";

/**
 * 受付の読み取り (手書きメモの写真・話した内容・通話の文字起こし → 受付の項目と内容の種類)
 * ------------------------------------------------------------
 * - 写真: AI が手書きの文字を読み、項目に分ける (memoText に書かれた文字そのまま)
 * - 文章 (話して入力・貼り付け・通話の文字起こし): AI が会話・メモから項目を取り出し、内容の種類を判定する
 * - AI のキーがない・失敗したとき: 言葉の規則で電話番号・種別・内容の種類だけを読む (src/lib/reception.ts の ruleReception)。写真は空の項目
 * 推測で値を作らない。読めない・言っていない項目は空文字。判定は「提案」で、登録は担当者が画面で確かめてから行う
 */

const s = (d: string) => ({ type: "string", description: `${d} (分からない・書かれていない・話していないときは空文字)` });
const ENUM = (values: readonly string[], d: string) => ({ type: "string", enum: [...values, ""], description: `${d} (判断できなければ空文字)` });

const CATEGORIES = Object.values(CATEGORY_LABEL);

export const RECEPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...RECEPTION_FIELD_KEYS, "confidence", "warnings"],
  properties: {
    callType: { type: "string", enum: RECEPTION_TYPES, description: "内容の種類: new_inquiry = お客様からの新しい依頼・相談・見積の依頼 / existing_case = すでに進んでいる工事・見積・引取・納品・支払いについての連絡 (日程の変更・確認・キャンセル・手直しの依頼など) / supplier = 仕入先・協力業者・問屋・メーカーからの連絡 / sales = 当社への営業・勧誘・広告の電話 / internal = 社員どうしの連絡 / other = 判断できない" },
    callTypeReason: s("その種類にした理由 (40 文字以内)"),
    customerName: s("お客様のお名前 (「様」は除く。会社・業者の電話なら空文字)"),
    kana: s("ふりがな (書かれている・名乗ったときだけ)"),
    phone: s("お客様の電話番号 (折返し先。書かれた・話したとおり)"),
    otherPhone: s("ほかの電話番号 (自宅と携帯の両方など)"),
    email: s("メールアドレス"),
    postalCode: s("郵便番号 (数字 7 桁)"),
    address: s("住所・施工場所 (書かれた・話したとおり)"),
    category: ENUM(CATEGORIES, "種別 (いちばん主な工事)"),
    summary: s("用件の要約 (30 文字以内。例: 和室6畳の表替えの見積依頼 / 納品日を11月28日に変更したい)"),
    detail: s("内容 (部屋・枚数・現場の状況・お客様のご要望・決まったこと・次にすること。箇条書きの文で。会話をそのまま写さない)"),
    desiredDate: s("お客様の希望の日時・時間帯 (例: 11月下旬の午前 / 土日)"),
    urgency: ENUM(["high", "normal", "low"], "緊急度 (high = 雨漏り・至急・今日中など急ぎ)"),
    callback: ENUM(["要", "不要"], "折返しの連絡が必要か"),
    mediaText: s("当社を知ったきっかけ (チラシ・ホームページ・紹介・看板・以前利用など、言った・書いたとおり)"),
    storeHint: s("お客様が言った・書いた店舗名や地域 (例: 合志店 / 玉名のあたり)"),
    staffName: s("受けた社員・メモを書いた人の名前"),
    receivedAt: s("受付の日時 (メモ・会話にあれば YYYY-MM-DDTHH:mm。年がなければ今年)"),
    caseHint: s("既存の案件の手がかり (案件番号・見積番号・「先週表替えした件」「来週の引取の件」など)"),
    companyName: s("相手が会社・業者のときの会社名"),
    memoText: s("写真のとき: メモに書かれた文字をそのまま (改行は保つ。読めない文字は 〓)。文章のときは空文字"),
    uncertainFields: { type: "array", items: { type: "string", enum: RECEPTION_FIELD_KEYS.filter((k) => k !== "uncertainFields") }, description: "読みにくい・聞き取りにくい・自信のない項目の名前" },
    confidence: { type: "number", description: "読み取り全体の確からしさ (0〜1)" },
    warnings: { type: "array", items: { type: "string" }, description: "確認が必要な点 (日本語で短く。例: 電話番号の 1 桁が読みにくい)" },
  },
} as const;

function systemPrompt(db: Pick<Database, "stores" | "users">, kind: "image" | "text"): string {
  const stores = db.stores.map((st) => `${st.name}${st.address ? ` (${st.address})` : ""}`).join(" / ");
  return [
    "あなたは畳・襖・障子・網戸の専門店 (株式会社一畳屋、熊本) の受付担当です。",
    kind === "image"
      ? "来店・イベント・現場での紹介・電話のときに社員が書いた手書きの受付メモの写真です。書かれている文字を読み、指定の JSON の項目に入れてください。"
      : "社員が電話・来店の内容を話して入力した文章、またはメモ・通話の文字起こしです。会話の内容から、指定の JSON の項目を取り出してください。",
    "- 書かれている・話している内容だけを使い、推測で値を作らないでください。お名前・電話番号・住所は 1 文字ずつ正確に。迷う文字・数字 (1 と 7、6 と 8 など) は uncertainFields と warnings に書いてください。",
    "- 電話番号は書かれた・話したとおり (例: 090-1234-5678)。「ゼロキューゼロ」のような読みは数字に直します。",
    "- 内容の種類 (callType) は会話の目的で決めます。すでに工事・見積・引取・納品の予定がある件の日程の変更・確認・キャンセル・支払い・手直しは existing_case、仕入先・業者は supplier、当社への売り込みは sales です。",
    "- detail には、見積・施工に必要なこと (部屋・畳の枚数・襖の枚数・現場の状況・ご要望・決まったこと・次にすること) を短い文で書きます。あいさつ・相づちは書きません。",
    "- お客様の言った店舗名・地域は storeHint に。店舗: " + stores,
    "- 文章のときは memoText を空文字にしてください。",
    "- confidence は全体の確からしさ (0〜1) です。",
  ].join("\n");
}

export interface ReceptionRead {
  fields: ReceptionFields;
  provider: "claude" | "openai" | "rules" | "error";
  model?: string;
  confidence: number;
  warnings: string[];
  error?: string;
  ms?: number;
  /** AI が返したままの値 (担当者の修正と比べて、読み取りの正確さを確かめる) */
  ai?: ReceptionFields;
}

/** 受付の写真 (手書きメモ) または文章を読み取る */
export async function readReception(db: Pick<Database, "stores" | "users">, input: { text?: string; image?: { base64: string; mimeType: string; fileName: string }; today?: string }): Promise<ReceptionRead> {
  const text = (input.text ?? "").trim();
  if (!aiEnabled()) {
    if (input.image) return { fields: normalizeReception({}), provider: "rules", confidence: 0, warnings: ["AI が設定されていないため、写真の文字は読み取れません。内容を入力してください。"] };
    return { fields: ruleReception(text), provider: "rules", confidence: 0.3, warnings: ["AI が設定されていないため、電話番号・種別・内容の種類だけを言葉から読み取りました。お名前・住所などは入力してください。"] };
  }
  let part: AiPart;
  if (input.image) {
    const isPdf = input.image.mimeType === "application/pdf";
    part = isPdf ? { type: "pdf", base64: input.image.base64, fileName: input.image.fileName } : { type: "image", mediaType: input.image.mimeType === "image/jpg" ? "image/jpeg" : input.image.mimeType, base64: input.image.base64 };
  } else {
    if (!text) return { fields: normalizeReception({}), provider: "error", confidence: 0, warnings: ["内容が空です。"], error: "内容が空です。" };
    part = { type: "text", text: text.slice(0, 30_000) };
  }
  try {
    const r = await generateJson<Record<string, unknown>>({
      system: systemPrompt(db, input.image ? "image" : "text"),
      parts: [part, { type: "text", text: `今日の日付: ${input.today ?? new Date().toISOString().slice(0, 10)}。${input.image ? "この受付メモを読み取ってください。" : "上の内容から受付の項目を取り出してください。"}` }],
      schema: RECEPTION_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "ichijoya_reception",
      maxTokens: 4000,
    });
    const fields = normalizeReception(r.data);
    const confidence = typeof r.data.confidence === "number" && r.data.confidence >= 0 && r.data.confidence <= 1 ? r.data.confidence : 0.8;
    const warnings = Array.isArray(r.data.warnings) ? (r.data.warnings as unknown[]).filter((w): w is string => typeof w === "string").slice(0, 10) : [];
    return { fields, provider: r.provider, model: r.model, confidence, warnings, ms: r.ms, ai: fields };
  } catch (err) {
    const message = err instanceof AiError ? err.message : "AI の読み取りに失敗しました。";
    console.warn("[reception] read failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
    // 文章は言葉の規則で下書きを作る (写真は空の項目)
    const fields = input.image ? normalizeReception({}) : ruleReception(text);
    return { fields, provider: "error", confidence: 0, warnings: [`AI で読み取れませんでした: ${message} 内容を確かめて入力してください。`], error: message };
  }
}
