import "server-only";
import type { Database, User } from "@/lib/db/types";
import { ROLE_LABEL } from "@/lib/constants";
import { aiEnabled, AiError, generateText } from "@/lib/ai/provider";
import { rulesAnswer } from "@/lib/ai/assistant";
import { extractTerms, searchRecords } from "@/lib/ai/search";
import { PERMISSION_TABLE } from "@/lib/auth/permission-table";
import { CELL_TEXT } from "./sources";
import { ensureChatbotData } from "./build";
import { countHit, findSimilarQa, insertQa, logAsk, recentAiAsks, normalizeQuestion, similarity, searchDocs, type AskSource, type DocRow, type QaLink, type QaMatch } from "./store";

/**
 * チャットボットの回答
 * ------------------------------------------------------------
 * AI (OpenAI) の呼び出しをできるだけ減らすため、安い方法から順に試す:
 *  1. あいさつ・お礼 → 決まった返事
 *  2. データの質問 (今日の予定・未入金・承認待ち・顧客名や番号) → assistant.ts の rulesAnswer (各自の閲覧範囲)
 *  3. データベースに似た質問がある (似ている度合い ≥ REUSE) → 蓄えた回答をそのまま返す
 *  4. AI が使えない → 近い質問の回答か、関係する資料の要点
 *  5. AI に、関係する資料と近い質問の回答を渡して答えてもらい、その回答をデータベースに保存 (次からは 3 で答える)
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface BotReply {
  answer: string;
  links: QaLink[];
  source: AskSource;
  /** 評価 (👍 / 👎) の対象 */
  qaId?: number;
  /** 近い質問 (押すとその質問を送る) */
  suggestions: string[];
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

const COL = { admin: "admin", hq_staff: "hq", store_manager: "manager", store_staff: "staff" } as const;

/** 質問に関係しそうな権限一覧の行と、質問した人のロールでできるか */
function permissionHints(q: string, role: User["role"]): string[] {
  const norm = normalizeQuestion(q);
  return PERMISSION_TABLE.map((r) => ({ r, score: similarity(norm, normalizeQuestion(r.action.replace(/\s*\([^)]*\)/g, ""))) }))
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ r }) => `・${r.action} → ${CELL_TEXT[r[COL[role]]]}`);
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

export async function askChatbot(db: Database, user: User, history: ChatTurn[], raw: string): Promise<BotReply> {
  const t0 = Date.now();
  const q = raw.trim().slice(0, 500);
  const norm = normalizeQuestion(q);
  const done = (r: BotReply): BotReply => {
    try {
      logAsk({ userId: user.id, role: user.role, question: q, source: r.source, qaId: r.qaId, ms: Date.now() - t0 });
    } catch (err) {
      console.warn("[chatbot] log failed:", (err as Error).message);
    }
    return r;
  };

  for (const s of SMALLTALK) if (s.test.test(q.replace(/[\s!！。、?？~〜]+$/g, ""))) return done({ answer: s.reply, links: [], source: "smalltalk", suggestions: [] });

  const data = dataReply(db, user, q);
  if (data) return done({ answer: data, links: [], source: "data", suggestions: [] });

  ensureChatbotData(db);
  const followUp = history.some((h) => h.role === "user") && (norm.length <= 6 || FOLLOW_UP.test(q));
  const matches = findSimilarQa(q, user.role, 8);
  const top = matches[0];

  if (!followUp && top && top.score >= REUSE) {
    countHit(top.qa.id);
    return done({ answer: top.qa.answer, links: top.qa.links, source: "database", qaId: top.qa.id, suggestions: suggestionsOf(matches, top.qa.id) });
  }

  const lastUser = [...history].reverse().find((h) => h.role === "user")?.content ?? "";
  const docs = searchDocs(followUp && lastUser ? `${lastUser} ${q}` : q, 6);

  if (!aiEnabled() || recentAiAsks(user.id) >= AI_PER_HOUR) {
    if (top && top.score >= NEAR) {
      countHit(top.qa.id);
      return done({ answer: `近い質問「${top.qa.question}」への回答です。\n\n${top.qa.answer}`, links: top.qa.links, source: "database", qaId: top.qa.id, suggestions: suggestionsOf(matches, top.qa.id) });
    }
    if (docs.length) return done({ answer: docsReply(docs), links: linksOf(docs), source: "docs", suggestions: suggestionsOf(matches) });
    return done({ answer: NOT_FOUND, links: [], source: "none", suggestions: suggestionsOf(matches) });
  }

  const refs = matches.filter((m) => m.score >= 0.4).slice(0, 5);
  const system = [
    PERSONA,
    `\n## 質問している社員のロール\n${ROLE_LABEL[user.role]}`,
    ((h) => (h.length ? `\n## このロールの権限 (質問に関係しそうなもの。操作を案内する前に必ず確かめる)\n${h.join("\n")}` : ""))(permissionHints(q, user.role)),
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
    const res = await generateText({ system, messages: [...turns, { role: "user", content: q }], maxTokens: 1200 });
    let text = res.data.trim();
    const unknown = text.startsWith("[不明]") || /見当たりません|記載がありません|わかりません|分かりません/.test(text);
    text = text.replace(/^\[不明\]\s*/, "").trim() || NOT_FOUND;
    const links = unknown ? [] : linksOf(docs);
    let qaId: number | undefined;
    // 会話の流れに頼らない質問で、資料から答えられたものだけ蓄える (次から AI を呼ばずに答える)。
    // 回答はロールの権限を踏まえているので、同じロールの人にだけ使う
    if (!unknown && !followUp && docs.length && norm.length >= 3) {
      qaId = insertQa({ question: q, answer: text, links, origin: "ai", role: user.role, sourceKeys: docs.slice(0, 3).map((d) => d.key) });
    }
    return done({ answer: text, links, source: unknown ? "none" : "ai", qaId, suggestions: unknown ? suggestionsOf(matches) : [] });
  } catch (err) {
    console.warn("[chatbot] AI failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
    if (top && top.score >= NEAR) return done({ answer: `近い質問「${top.qa.question}」への回答です。\n\n${top.qa.answer}`, links: top.qa.links, source: "database", qaId: top.qa.id, suggestions: suggestionsOf(matches, top.qa.id) });
    if (docs.length) return done({ answer: docsReply(docs), links: linksOf(docs), source: "docs", suggestions: suggestionsOf(matches) });
    return done({ answer: NOT_FOUND, links: [], source: "none", suggestions: suggestionsOf(matches) });
  }
}
