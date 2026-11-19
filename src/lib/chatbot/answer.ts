import "server-only";
import type { Database, User } from "@/lib/db/types";
import { aiEnabled, AiError, generateText } from "@/lib/ai/provider";
import { rulesAnswer } from "@/lib/ai/assistant";
import { extractTerms, searchRecords } from "@/lib/ai/search";
import { ensureChatbotData } from "./build";
import { countHit, findSimilarQa, insertChatLog, insertQa, logAsk, recentAiAsks, normalizeQuestion, searchDocs, type AskSource, type ChatLogPayload, type DocRow, type QaLink, type QaMatch } from "./store";
import { runAgent, type AgentSource } from "@/lib/assistant/agent";
import { runAnalysis, type AnalysisResult, type AnalysisSpec } from "@/lib/assistant/analyze";
import { ANALYSIS_WORDS, heuristicSpec, refineSpec } from "@/lib/assistant/intent";
import { yen } from "@/lib/format";
import { withAiContext } from "@/lib/ai/usage";
import { aiAvailability, installAiMonitor } from "./monitor";
import type { AnswerChecks } from "@/lib/assistant/guard";

/**
 * チャットボット (「質問する」) の回答
 * ------------------------------------------------------------
 * AI の呼び出しをできるだけ減らすため、安い方法から順に試す:
 *  1. あいさつ・お礼 → 決まった返事
 *  2. 使い方の質問で、データベースに似た質問がある (似ている度合い ≥ REUSE) → 蓄えた回答をそのまま返す
 *  3. ログインした社員: AI アシスタント (src/lib/assistant/agent.ts) が検索・集計の道具でデータを調べて答える。
 *     使い方だけの回答は蓄え (次からは 2 で答える)、データの回答は蓄えない (内容が日々変わり、閲覧範囲も人で違うため)
 *  4. AI が使えない・使いすぎの制限 → 集計の質問は言葉の決まりで表を作る (intent.ts)。データの質問は rulesAnswer、
 *     使い方は近い質問の回答か関係する資料の要点
 *  ログイン前 (公開ページ) は使い方の案内だけ (データ・社内資料は答えない)。
 *  ログインした社員の質問と回答は相談の履歴 (chat_log) に残す (誰が・いつ・何を聞き・どう答えたか)
 *  今月の AI の予算・上限を超えたとき、AI の障害が続いているとき (monitor.ts の aiAvailability) は、AI を呼ばずに 4 で答える。
 *  AI の呼び出しは withAiContext で「誰の・何のための呼び出しか」を付けて記録する (利用回数・トークン・費用・失敗)
 *  opts.evaluation (精度の評価 eval.ts) のときは、履歴・蓄えた回答・利用回数の上限に触れない
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** その回答で使った集計の条件 (続けて「店舗別にして」と聞かれたときに使う) */
  specs?: AnalysisSpec[];
}

export interface BotReply {
  answer: string;
  links: QaLink[];
  source: AskSource;
  /** 評価 (👍 / 👎) の対象 */
  qaId?: number;
  /** 近い質問 (押すとその質問を送る) */
  suggestions: string[];
  /** 集計の表 (画面で表・グラフにする) */
  tables?: AnalysisResult[];
  /** 回答の根拠 (記録・資料・集計) */
  sources?: AgentSource[];
  /** 調べた内容 (道具と条件) */
  tools?: { name: string; summary: string }[];
  /** 相談の履歴の ID (評価・社内資料への登録に使う) */
  logId?: number;
  /** 回答の確かめの結果 (guard.ts。画面には出さず、履歴と精度の評価に使う) */
  checks?: AnswerChecks;
  /** AI の接続先とモデル */
  provider?: string;
  /** AI を使わなかった理由 (予算の上限・障害) */
  degraded?: "budget" | "outage" | "error" | "limit";
}

const REUSE = 0.8;
const NEAR = 0.6;
/** 1 人が 1 時間に AI で答えてもらえる回数 (超えたらデータベースの回答だけで答える) */
const AI_PER_HOUR = Number(process.env.CHATBOT_AI_PER_HOUR) || 40;

const SMALLTALK: { test: RegExp; reply: string }[] = [
  { test: /^(ありがと|ありがとう|ありがとうございます|助かり|助かった|サンキュ|thanks?|thank you)/i, reply: "どういたしまして。ほかにも気になることがあれば、いつでも聞いてくださいね。" },
  { test: /^(了解|りょうかい|わかりました|分かりました|ok|おk|おけ|はい)$/i, reply: "はい。また何かあれば声をかけてください。" },
  { test: /^(おはよう|おはようございます)$/, reply: "おはようございます。今日もよろしくお願いします。予定の確認や操作の手順など、何でも聞いてください。" },
  { test: /^(こんにちは|こんにちわ|はじめまして|やあ|hello|hi)$/i, reply: "こんにちは。システムの使い方や画面の場所、「今日の予定」「未入金の請求」のようなデータの確認にお答えします。どうぞ聞いてください。" },
  { test: /^(こんばんは|こんばんわ)$/, reply: "こんばんは。遅くまでお疲れさまです。何かお手伝いできることはありますか？" },
  { test: /^(お疲れ|おつかれ|お疲れ様|お疲れさま|おつかれさま)(です|でした)?$/, reply: "お疲れさまです。何かお手伝いできることはありますか？" },
];

/** 操作のしかたを聞いている (データではなく手順の質問) */
const HOW_TO = /どうやって|どうすれば|どうしたら|方法|やり方|仕方|しかた|どこで|どこから|どこに|どこにある|手順|使い方|とは|って何|ってなに|できますか|できる？|できる\?|権限|誰が|だれが|登録したい|変更したい|したい$/;
/** 自分の範囲のデータを聞いている */
const DATA = /売上|業績|未入金|売掛|督促|回収|承認待ち|承認待|重複|ダブルブッキング|(今日|本日|明日|今週)の?(予定|スケジュール)|予定(は|を).*(今日|明日|今週)|未対応の?問い合わせ|対応中の?問い合わせ|進行中|今月の経費|未払|店舗(別|ごと)の?(比較|成績)/;
/** 直前の会話を前提にした質問 (データベースの回答をそのまま使わない) */
const FOLLOW_UP = /それ|これ|あれ|その|この|あの|さっき|先ほど|もっと|詳しく|くわしく|他には|ほかには|具体的|続き|つまり|なぜ|なんで/;

function dataReply(db: Database, user: User, q: string): string | undefined {
  const howTo = HOW_TO.test(q);
  // 顧客・案件の検索は、敬称つきの名前・番号・電話番号・「」の言葉があるときだけ (画面の名前が顧客名の一部に当たらないように)
  const t = extractTerms(q);
  if (t.names.length || t.numbers.length || t.phones.length || (t.words.length && !howTo)) {
    if (searchRecords(db, user, q).context) return rulesAnswer(db, user, q);
  }
  if (DATA.test(q) && !howTo) return rulesAnswer(db, user, q);
  return undefined;
}

const linksOf = (docs: DocRow[], max = 2): QaLink[] => {
  const seen = new Set<string>();
  const out: QaLink[] = [];
  for (const d of docs) {
    if (!d.href || seen.has(d.href)) continue;
    seen.add(d.href);
    out.push({ label: d.title.replace(/^(使い方|画面の詳細|画面|権限|ロール|社内資料): /, "").replace(/ \(.*\)$/, "").slice(0, 24), href: d.href });
    if (out.length >= max) break;
  }
  return out;
};

/** 近い質問の候補 (今の回答と同じ答えになるもの・同じ答えの言い換えは 1 つにまとめる) */
function suggestionsOf(matches: QaMatch[], except?: number): string[] {
  const shown = matches.find((m) => m.qa.id === except)?.qa.answer;
  const answers = new Set<string>(shown ? [shown] : []);
  const out: string[] = [];
  for (const m of matches) {
    if (m.qa.id === except || m.score < 0.4 || answers.has(m.qa.answer)) continue;
    answers.add(m.qa.answer);
    out.push(m.qa.question);
    if (out.length >= 3) break;
  }
  return out;
}

function docsReply(docs: DocRow[]): string {
  return `データベースの資料から、関係しそうな内容です。\n\n${docs
    .slice(0, 2)
    .map((d) => `【${d.title}】\n${d.body.length > 400 ? `${d.body.slice(0, 400)}…` : d.body}`)
    .join("\n\n")}`;
}

const NOT_FOUND = "ごめんなさい、その内容はシステムの資料に見つかりませんでした。聞き方を変えてもらうか、「使い方」の画面を見てみてください。それでもわからないときは、店長か管理者に確認をお願いします。";

const PERSONA = [
  "あなたは株式会社一畳屋 (熊本の畳・襖・障子・網戸の専門店。合志店・中央店・西店・玉名店と本社) の社内業務システム「一畳屋 統合業務システム」の案内係です。",
  "社員からの質問に、システムに詳しい親切な先輩社員として、人と話しているような自然でやわらかい日本語 (です・ます調) で答えてください。",
  "ルール:",
  "- 下の「参考資料」と「蓄えた回答」に書かれている内容だけを根拠に答える。資料にない画面・ボタン・手順・数値・機能を作らない。",
  "- 資料から答えられないときは、答えの先頭に [不明] と書き、その後に「資料には見当たらない」ことと、店長・管理者に確認してほしいことをやさしく伝える。",
  "- 画面の名前・ボタンの名前は資料の表記のまま「」で書く。必要なら メニュー → 画面 → ボタン の順に案内する。",
  "- 相手のロールでできない操作は、できないことと、誰に頼めばよいかを伝える。",
  "- 2〜6 文程度で簡潔に。手順が多いときだけ短い箇条書き (・) を使う。Markdown の見出しや表は使わない。",
  "- 社員の個人名・お客様の個人情報は書かない。データ (売上・予定・顧客など) を聞かれたら「今日の予定は？」のように聞けば答えられることを案内する。",
].join("\n");

/** 集計の表を、AI を使わずに短い文章にする */
function analysisReply(r: AnalysisResult): string {
  const first = r.columns.find((c) => c.kind !== "text");
  const lines = [`**${r.title}**`];
  if (first && r.total[first.key] !== undefined && r.total[first.key] !== null && typeof r.total[first.key] === "number") lines.push(`合計 ${first.kind === "yen" ? yen(r.total[first.key] as number) : (r.total[first.key] as number).toLocaleString("ja-JP")}`);
  if (r.compareLabel) lines.push(`比較: ${r.compareLabel}`);
  lines.push("表とグラフで表示しています。条件を変えたいときは「月別にして」「前年と比べて」のように続けて聞いてください。");
  if (r.notes.length) lines.push(`※ ${r.notes.slice(0, 2).join(" / ")}`);
  return lines.join("\n");
}

/** 知識 (社内資料) から作った資料・回答はログイン前の人には使わない */
const isKnowledgeQa = (m: QaMatch) => m.qa.sourceKeys.some((k) => k.startsWith("knowledge:"));

/**
 * チャットボットに答える。user が null のときはログイン前 (公開ホームなど)。
 * ログイン前は個人のデータ (予定・売上など) と社内資料は答えず、使い方・画面の案内に限る。
 */
export async function askChatbot(db: Database, user: User | null, history: ChatTurn[], raw: string, opts: { convId?: string; voice?: boolean; evaluation?: boolean } = {}): Promise<BotReply> {
  installAiMonitor();
  return withAiContext({ kind: opts.evaluation ? "eval" : user ? "assistant" : "guest", userId: user?.id }, () => answerQuestion(db, user, history, raw, opts));
}

async function answerQuestion(db: Database, user: User | null, history: ChatTurn[], raw: string, opts: { convId?: string; voice?: boolean; evaluation?: boolean }): Promise<BotReply> {
  const t0 = Date.now();
  const q = raw.trim().slice(0, 1000);
  const norm = normalizeQuestion(q);
  const guest = !user;
  const role = user?.role ?? "";
  const askerId = user?.id ?? "guest";
  const done = (r: BotReply): BotReply => {
    const ms = Date.now() - t0;
    if (opts.evaluation) return r;
    try {
      logAsk({ userId: askerId, role, question: q, source: r.source, qaId: r.qaId, ms });
    } catch (err) {
      console.warn("[chatbot] log failed:", (err as Error).message);
    }
    // 相談の履歴 (ログインした社員だけ。あいさつは残さない)
    if (user && r.source !== "smalltalk") {
      try {
        const payload: ChatLogPayload = { links: r.links, sources: r.sources, tools: r.tools, tables: r.tables, voice: opts.voice || undefined, provider: r.provider, checks: r.checks, degraded: r.degraded };
        r.logId = insertChatLog({ convId: opts.convId, userId: user.id, userName: user.name, role: user.role, storeId: user.storeId, question: q, answer: r.answer, source: r.source, payload, ms });
      } catch (err) {
        console.warn("[chatbot] chat log failed:", (err as Error).message);
      }
    }
    return r;
  };

  for (const s of SMALLTALK) if (s.test.test(q.replace(/[\s!！。、?？~〜]+$/g, ""))) return done({ answer: s.reply, links: [], source: "smalltalk", suggestions: [] });

  if (!user && DATA.test(q) && !HOW_TO.test(q)) {
    return done({
      answer: "予定や売上などのデータは、ログイン後に聞けます。使い方や画面の場所なら、このままお答えできます。",
      links: [{ label: "ログイン", href: "/login" }],
      source: "none",
      suggestions: ["見積の作り方を教えて", "ログインの仕方は？", "新規登録の流れは？"],
    });
  }

  ensureChatbotData(db);
  const followUp = history.some((h) => h.role === "user") && (norm.length <= 6 || FOLLOW_UP.test(q));
  const matches = findSimilarQa(q, role, 8).filter((m) => !guest || !isKnowledgeQa(m));
  const top = matches[0];
  const howTo = HOW_TO.test(q);
  // データ・集計の質問 (蓄えた回答では答えない)
  const t = extractTerms(q);
  const dataish = Boolean(user) && (DATA.test(q) || ANALYSIS_WORDS.test(q) || t.names.length > 0 || t.numbers.length > 0 || t.phones.length > 0) && !(howTo && !ANALYSIS_WORDS.test(q) && !t.names.length && !t.numbers.length);

  if (!followUp && !dataish && top && top.score >= REUSE && !opts.evaluation) {
    countHit(top.qa.id);
    return done({ answer: top.qa.answer, links: top.qa.links, source: "database", qaId: top.qa.id, suggestions: suggestionsOf(matches, top.qa.id) });
  }

  // AI を使えるか: キー・1 時間の回数・今月の予算・障害の遮断 (monitor.ts)
  const availability = aiEnabled() ? aiAvailability() : ({ ok: true } as const);
  const underLimit = opts.evaluation || recentAiAsks(askerId) < AI_PER_HOUR;
  const canUseAi = aiEnabled() && underLimit && availability.ok;
  let degraded: BotReply["degraded"] = !aiEnabled() ? undefined : !availability.ok ? availability.reason : !underLimit ? "limit" : undefined;
  // ログイン前 (公開ページ) の人には、予算・障害などの社内の事情を書かない
  const degradedNote = () => (!user ? "" : degraded === "budget" || degraded === "outage" ? `(${!availability.ok ? availability.message : ""})\n` : degraded === "limit" ? "(AI の利用回数の上限に達したため、AI を使わずにお答えします)\n" : degraded === "error" ? "(AI の応答が得られなかったため、AI を使わずにお答えします)\n" : "");

  // ---- ログインした社員: AI アシスタント (データを調べて答える) ----
  if (user && canUseAi) {
    try {
      const r = await runAgent(db, user, history, q, { prefetchGuides: !dataish || howTo, dataQuestion: dataish, voice: opts.voice });
      let qaId: number | undefined;
      const links = r.sources.filter((s) => s.href).slice(0, 3).map((s) => ({ label: s.label.slice(0, 24), href: s.href! }));
      // 使い方だけの回答は蓄える (同じロールの人に次から AI なしで答える)。データを使った回答は蓄えない
      if (!r.usedData && !r.usedKnowledge && !r.unknown && !followUp && r.docKeys.length && norm.length >= 3 && !opts.evaluation && !r.checks?.issues.some((i) => i.severity !== "low")) {
        qaId = insertQa({ question: q, answer: r.answer, links, origin: "ai", role, sourceKeys: [...new Set(r.docKeys)].slice(0, 3) });
      }
      return done({ answer: r.answer, links: r.tables.length || r.usedData ? [] : links, source: r.usedData ? "agent" : r.unknown ? "none" : "ai", qaId, suggestions: [], tables: r.tables, sources: r.sources, tools: r.tools, checks: r.checks, provider: r.provider });
    } catch (err) {
      console.warn("[chatbot] agent failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
      degraded = "error";
      // 下の AI なしの回答へ
    }
  }

  // ---- AI なし (キーなし・使いすぎ・失敗) ----
  if (user) {
    const prevSpec = history.at(-1)?.role === "assistant" ? history.at(-1)?.specs?.[0] : undefined;
    const spec = heuristicSpec(db, q) ?? (prevSpec && !howTo ? refineSpec(db, prevSpec, q) : null);
    if (spec) {
      const r = runAnalysis(db, user, spec);
      if (r.ok) return done({ answer: `${degradedNote()}${analysisReply(r)}`, links: [{ label: "経営ダッシュボード", href: "/reports" }], source: "analysis", suggestions: [], tables: [r], sources: [{ label: r.title, kind: "集計" }], degraded });
    }
    const data = dataReply(db, user, q);
    if (data) return done({ answer: `${degradedNote()}${data}`, links: [], source: "data", suggestions: [], degraded });
  }

  const lastUser = [...history].reverse().find((h) => h.role === "user")?.content ?? "";
  const docs = searchDocs(followUp && lastUser ? `${lastUser} ${q}` : q, 6).filter((d) => !guest || d.kind !== "knowledge");

  if (!canUseAi || user) {
    if (top && top.score >= NEAR) {
      countHit(top.qa.id);
      return done({ answer: `${degradedNote()}近い質問「${top.qa.question}」への回答です。\n\n${top.qa.answer}`, links: top.qa.links, source: "database", qaId: top.qa.id, suggestions: suggestionsOf(matches, top.qa.id), degraded });
    }
    if (docs.length) return done({ answer: `${degradedNote()}${docsReply(docs)}`, links: linksOf(docs), source: "docs", suggestions: suggestionsOf(matches), degraded });
    return done({ answer: `${degradedNote()}${NOT_FOUND}`, links: [], source: "none", suggestions: suggestionsOf(matches), degraded });
  }

  // ---- ログイン前: 使い方の資料を AI に渡して答える ----
  const refs = matches.filter((m) => m.score >= 0.4).slice(0, 5);
  const system = [
    PERSONA,
    "\n## 質問している人\nログイン前の訪問者。個人のデータ (予定・顧客・売上など) と社内の資料は答えず、システムの使い方・画面・新規登録・ログインの案内に限る。データ確認はログイン後に聞いてほしいと伝える。",
    docs.length ? `\n## 参考資料\n${docs.map((d) => `### ${d.title}${d.href ? ` (画面: ${d.href})` : ""}\n${d.body.slice(0, 1500)}`).join("\n\n")}` : "\n## 参考資料\n(見つかりませんでした)",
    refs.length ? `\n## 蓄えた回答 (近い質問と、その回答)\n${refs.map((m) => `Q: ${m.qa.question}\nA: ${m.qa.answer.slice(0, 600)}`).join("\n\n")}` : "",
  ].join("\n");

  const turns: ChatTurn[] = [];
  for (const h of history.slice(-6)) {
    if (!h.content.trim()) continue;
    if (!turns.length && h.role !== "user") continue;
    const last = turns[turns.length - 1];
    if (last && last.role === h.role) turns[turns.length - 1] = { role: h.role, content: `${last.content}\n\n${h.content}` };
    else turns.push({ role: h.role, content: h.content.slice(0, 1500) });
  }
  if (turns.length && turns[turns.length - 1].role === "user") turns.pop();

  try {
    const res = await generateText({ system, messages: [...turns.map((x) => ({ role: x.role, content: x.content })), { role: "user", content: q }], maxTokens: 1200 });
    let text = res.data.trim();
    const unknown = text.startsWith("[不明]") || /見当たりません|記載がありません|わかりません|分かりません/.test(text);
    text = text.replace(/^\[不明\]\s*/, "").trim() || NOT_FOUND;
    const links = unknown ? [] : linksOf(docs);
    let qaId: number | undefined;
    if (!unknown && !followUp && docs.length && norm.length >= 3 && !opts.evaluation) {
      qaId = insertQa({ question: q, answer: text, links, origin: "ai", role, sourceKeys: docs.slice(0, 3).map((d) => d.key) });
    }
    return done({ answer: text, links, source: unknown ? "none" : "ai", qaId, suggestions: unknown ? suggestionsOf(matches) : [] });
  } catch (err) {
    console.warn("[chatbot] AI failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
    if (top && top.score >= NEAR) return done({ answer: `近い質問「${top.qa.question}」への回答です。\n\n${top.qa.answer}`, links: top.qa.links, source: "database", qaId: top.qa.id, suggestions: suggestionsOf(matches, top.qa.id) });
    if (docs.length) return done({ answer: docsReply(docs), links: linksOf(docs), source: "docs", suggestions: suggestionsOf(matches) });
    return done({ answer: NOT_FOUND, links: [], source: "none", suggestions: suggestionsOf(matches) });
  }
}
