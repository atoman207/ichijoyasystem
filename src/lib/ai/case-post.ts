import "server-only";
import { AiError, aiEnabled, generateJson } from "./provider";
import { withAiContext } from "./usage";
import { aiAvailability } from "@/lib/chatbot/monitor";
import { CASE_POST_CHANNEL_LABEL, normalizeHashtags, scrubPersonal, suggestHashtags, templateDraft, type PersonalContext, type PostDraftInput } from "@/lib/case-posts";

/**
 * 施工事例の投稿文の下書き (AI)。AI のキーがない・上限・失敗のときは定型文 (src/lib/case-posts.ts の templateDraft)
 * ------------------------------------------------------------
 * - AI に渡すのは 地域 (町名まで)・商品名・施工内容・種別・店舗名・投稿先だけ。お客様のお名前・番地・電話・メールは渡さない
 *   (呼び出し側で scrubPersonal したものを渡し、ここでももう一度除く)。AI の答えからも除く
 * - 事実 (商品名・施工内容) にないこと (価格・工期・お客様の感想など) を作らせない
 * - AI の呼び出しの記録は withAiContext (kind = case_post)
 */

const SYSTEM = `あなたは熊本の畳・襖・障子・網戸の専門店「一畳屋」の広報担当です。施工事例の SNS・ホームページ用の投稿文の下書きを作ります。
守ること:
- お客様のお名前・番地や建物名までの住所・電話番号・メールアドレスは絶対に書かない。地域は渡された「地域」(町名まで) だけを使う。地域が空なら地域を書かない
- 渡された商品名・施工内容にない事実 (価格・工期・枚数・お客様の感想やお喜びの声・ビフォーアフターの細部) を作らない。分からないことは書かない
- 誇張・断定的な効果 (「必ず」「一生もの」など) を書かない。落ち着いた丁寧な文体 (です・ます)
- 本文は 200〜400 文字。1 行目は施工事例と分かる短い見出し。商品名は正式な名前のまま書いてよい
- 絵文字は使わないか、Instagram 向けなら 2 つまで
- 最後に一畳屋へのご相談を促す 1 文 (店舗名があれば入れる)
- hashtags は # を付けない言葉で 5〜10 個 (「一畳屋」を必ず含める。地域の市町村名・商品の種類など)。ホームページ・Google ビジネスプロフィールだけのときもハッシュタグは返す (使うかは人が決める)
JSON で返す: { "text": 本文, "hashtags": [言葉, …] }`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "hashtags"],
  properties: {
    text: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
};

export interface CasePostDraftResult {
  text: string;
  hashtags: string;
  provider: "claude" | "openai" | "rules";
  /** 定型文にした理由 (AI のキーがない・上限・失敗) */
  note?: string;
}

/** 投稿文の下書きを作る。input は scrubPersonal 済みのもの (ここでももう一度除く) */
export async function draftCasePostText(input: PostDraftInput, ctx: PersonalContext, userId: string): Promise<CasePostDraftResult> {
  const safe: PostDraftInput = {
    ...input,
    title: scrubPersonal(input.title, ctx),
    workContent: scrubPersonal(input.workContent, ctx),
    products: input.products.map((p) => scrubPersonal(p, ctx)).filter(Boolean),
  };
  const fallback = (note: string): CasePostDraftResult => {
    const t = templateDraft(safe);
    return { text: scrubPersonal(t.text, ctx), hashtags: t.hashtags, provider: "rules", note };
  };
  if (!aiEnabled()) return fallback("AI のキーが設定されていないため、定型文で下書きを作りました。");
  const avail = aiAvailability();
  if (!avail.ok) return fallback(`${avail.message.replace(/。.*$/, "")}ため、定型文で下書きを作りました。`);
  const prompt = [
    `見出しの案: ${safe.title || "(なし)"}`,
    `地域: ${safe.area || "(なし)"}`,
    `種別: ${safe.categoryLabel || "(なし)"}`,
    `商品名:\n${safe.products.length ? safe.products.map((p) => `- ${p}`).join("\n") : "(なし)"}`,
    `施工内容:\n${safe.workContent || "(なし)"}`,
    `店舗名: 一畳屋 ${safe.storeName || ""}`.trim(),
    `投稿先: ${safe.channels.map((c) => CASE_POST_CHANNEL_LABEL[c]).join("・") || "Instagram"}`,
    safe.month ? `施工の月: ${safe.month}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const r = await withAiContext({ kind: "case_post", userId }, () => generateJson<{ text: string; hashtags: string[] }>({ system: SYSTEM, parts: [{ type: "text", text: prompt }], schema: SCHEMA, schemaName: "case_post_draft", maxTokens: 1500 }));
    const text = scrubPersonal(String(r.data.text ?? ""), ctx).slice(0, 3000);
    if (!text.trim()) return fallback("AI の下書きが空だったため、定型文で下書きを作りました。");
    const tags = Array.isArray(r.data.hashtags) && r.data.hashtags.length ? r.data.hashtags.map((t) => scrubPersonal(String(t), ctx)) : suggestHashtags(safe);
    const hashtags = normalizeHashtags(tags.some((t) => t.replace(/^#/, "") === "一畳屋") ? tags : ["一畳屋", ...tags]);
    return { text, hashtags, provider: r.provider };
  } catch (err) {
    console.warn("[case-post] draft failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
    return fallback(`${err instanceof AiError ? err.message : "AI の下書きの作成に失敗しました。"} 定型文で下書きを作りました。`);
  }
}
