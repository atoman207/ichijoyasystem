import "server-only";
import { AiError, aiEnabled, generateJson } from "./provider";
import { COMMENT_TAGS, tagComment } from "@/lib/survey";

/**
 * お客様の声 (アンケート ⑧ 自由記述) の分析
 * - AI の API キーがあるとき: 記述をまとめて AI に渡し、強み・磨くべき点・提案を整理する
 * - ないとき: 分類 (簡易ルール) の件数と代表的な記述で整理する
 */

export interface VoiceInput {
  id: string;
  text: string;
  store: string;
  scores: (number | undefined)[];
}

export interface VoiceTheme {
  theme: string;
  detail: string;
  count: number;
  quotes: string[];
}

export interface VoiceAnalysis {
  summary: string;
  strengths: VoiceTheme[];
  improvements: VoiceTheme[];
  suggestions: string[];
  tagCounts: Record<string, number>;
  analyzedAt: string;
}

const THEME = {
  type: "object",
  properties: {
    theme: { type: "string", description: "テーマ (例: 仕上がりの美しさ・職人の丁寧さ)" },
    detail: { type: "string", description: "どのような声が多いか (1〜2 文)" },
    count: { type: "number", description: "このテーマに当てはまる記述のおおよその件数" },
    quotes: { type: "array", items: { type: "string" }, description: "代表的な記述 (原文のまま 1〜3 件)" },
  },
  required: ["theme", "detail", "count", "quotes"],
  additionalProperties: false,
};

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "全体の傾向 (2〜4 文)" },
    strengths: { type: "array", items: THEME, description: "お褒めの言葉から見える強み (多い順に 3〜6 件)" },
    improvements: { type: "array", items: THEME, description: "ご指摘・ご要望から見える、さらに磨くべき点 (多い順に 0〜5 件。なければ空)" },
    suggestions: { type: "array", items: { type: "string" }, description: "サービス品質の向上・社員教育への具体的な提案 (2〜5 件)" },
  },
  required: ["summary", "strengths", "improvements", "suggestions"],
  additionalProperties: false,
};

function tagCounts(list: VoiceInput[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(COMMENT_TAGS.map((t) => [t, 0]));
  for (const v of list) for (const t of tagComment(v.text).tags) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

function rulesAnalysis(list: VoiceInput[]): VoiceAnalysis {
  const counts = tagCounts(list);
  const tagged = list.map((v) => ({ v, t: tagComment(v.text) }));
  const theme = (tag: string, tone: "praise" | "negative"): VoiceTheme => {
    const hits = tagged.filter((x) => x.t.tags.includes(tag) && (tone === "praise" ? x.t.tone === "praise" : x.t.tone !== "praise"));
    return { theme: tag, detail: `「${tag}」に関する記述が ${hits.length} 件あります。`, count: hits.length, quotes: hits.slice(0, 3).map((x) => x.v.text.slice(0, 120)) };
  };
  const strengths = COMMENT_TAGS.filter((t) => t !== "ご指摘・改善要望").map((t) => theme(t, "praise")).filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
  const improvements = COMMENT_TAGS.map((t) => theme(t, "negative")).filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 5);
  const praise = tagged.filter((x) => x.t.tone === "praise").length;
  return {
    summary: `自由記述 ${list.length} 件のうち、お褒めの言葉は ${praise} 件です。多い分類は ${strengths.slice(0, 3).map((s) => `「${s.theme}」`).join("・") || "なし"} です。(AI の API キーが未設定のため、言葉の一致による簡易分類です)`,
    strengths,
    improvements,
    suggestions: improvements.length ? improvements.slice(0, 3).map((i) => `「${i.theme}」についての声を朝礼などで共有し、対応を確認する`) : ["お褒めの言葉を社内で共有し、良い対応を続ける"],
    tagCounts: counts,
    analyzedAt: new Date().toISOString(),
  };
}

export async function analyzeVoices(list: VoiceInput[]): Promise<{ ok: true; data: VoiceAnalysis; provider: string; model?: string } | { ok: false; message: string }> {
  if (!aiEnabled()) return { ok: true, data: rulesAnalysis(list), provider: "rules" };
  const lines = list.map((v, i) => `[${i + 1}] (${v.store}${v.scores.some((s) => s) ? ` / 評価 ${v.scores.map((s) => s ?? "-").join("・")}` : ""}) ${v.text.replace(/\s+/g, " ").slice(0, 240)}`);
  try {
    const r = await generateJson<Omit<VoiceAnalysis, "tagCounts" | "analyzedAt">>({
      system: [
        "あなたは株式会社一畳屋 (熊本の畳・襖・障子・網戸の専門店) の品質管理担当です。",
        "お客様アンケートはがきの自由記述 (ご指摘・お褒めの言葉) を読み、会社の強みと、さらに磨くべき部分を整理してください。",
        "- 記述に書かれていることだけを根拠にしてください。件数はおおよそで構いません。",
        "- quotes には原文をそのまま (長い場合は前半) 入れてください。お客様の個人名・住所は含めないでください。",
        "- 評価は ①電話対応 ②営業担当 ③職人 ④仕上がり の 5 段階 (5 が大変満足) です。",
      ].join("\n"),
      parts: [{ type: "text", text: `自由記述 ${list.length} 件:\n${lines.join("\n")}` }],
      schema: SCHEMA,
      schemaName: "customer_voice_analysis",
      maxTokens: 6000,
      effort: "low",
    });
    const clean = (t: VoiceTheme): VoiceTheme => ({ theme: String(t.theme ?? "").slice(0, 60), detail: String(t.detail ?? "").slice(0, 300), count: Math.max(0, Math.round(Number(t.count) || 0)), quotes: (Array.isArray(t.quotes) ? t.quotes : []).map((q) => String(q).slice(0, 200)).slice(0, 3) });
    return {
      ok: true,
      provider: r.provider,
      model: r.model,
      data: {
        summary: String(r.data.summary ?? "").slice(0, 800),
        strengths: (r.data.strengths ?? []).map(clean).slice(0, 6),
        improvements: (r.data.improvements ?? []).map(clean).slice(0, 5),
        suggestions: (r.data.suggestions ?? []).map((s) => String(s).slice(0, 200)).slice(0, 5),
        tagCounts: tagCounts(list),
        analyzedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { ok: false, message: err instanceof AiError ? err.message : "AI の分析に失敗しました。" };
  }
}
