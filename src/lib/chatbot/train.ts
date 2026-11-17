import "server-only";
import { aiEnabled, AiError, generateJson } from "@/lib/ai/provider";
import { allDocs, getMeta, insertManyQa, markTrained, setMeta, type DocRow } from "./store";

/**
 * 学習 (質問の言い換えを AI で作ってデータベースに蓄える)
 * ------------------------------------------------------------
 * 資料 1 件につき 1 回だけ AI を呼び、社員が聞きそうな質問と回答の組をまとめて作る。
 * 内容が変わっていない資料は作り直さない (trained_hash)。途中で止まっても、次は残りから続ける。
 * ここで先に AI を使っておくことで、普段の質問はデータベースから答えられ、AI の呼び出しが減る
 */

export interface TrainState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  heartbeat?: string;
  total: number;
  done: number;
  added: number;
  failed: number;
  error?: string;
}

const KEY = "train_state";
const STOP_KEY = "train_stop";
const STALE_MS = 3 * 60_000;
const PER_DOC = 20;

export function trainState(): TrainState {
  try {
    const s = JSON.parse(getMeta(KEY) ?? "") as TrainState;
    if (s.running && s.heartbeat && Date.now() - new Date(s.heartbeat).getTime() > STALE_MS) return { ...s, running: false, error: s.error ?? "途中で止まりました (サーバーの再起動など)。もう一度実行すると残りから続けます。" };
    return s;
  } catch {
    return { running: false, total: 0, done: 0, added: 0, failed: 0 };
  }
}

const save = (s: TrainState) => setMeta(KEY, JSON.stringify({ ...s, heartbeat: new Date().toISOString() }));

export function pendingDocs(): DocRow[] {
  return allDocs().filter((d) => d.trainedHash !== d.hash);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: { question: { type: "string" }, answer: { type: "string" } },
      },
    },
  },
};

const SYSTEM = [
  "あなたは株式会社一畳屋 (熊本の畳・襖・障子・網戸の専門店) の社内業務システムの案内係の学習データを作る担当です。",
  `渡された資料の内容について、社員が実際にチャットで聞きそうな質問と、その回答を ${PER_DOC} 組作ってください。`,
  "質問: 話し言葉・短い言い方・敬語・言い間違いに近い言い方・「〜したいんだけど」「〜ってどこ？」「〜できる？」など、聞き方を幅広く変える。同じ意味の質問を重複させない。",
  "回答: 資料に書かれている内容だけで答える。推測や資料にない手順・数値を足さない。です・ます調で、同僚に教えるような自然でやわらかい日本語にする。2〜5 文程度。画面やボタンの名前は資料のとおりに書く。",
  "資料から答えられない質問は作らない。社員の個人名・お客様の情報は書かない。",
].join("\n");

async function trainDoc(doc: DocRow): Promise<number> {
  const res = await generateJson<{ items: { question: string; answer: string }[] }>({
    system: SYSTEM,
    parts: [{ type: "text", text: `# 資料: ${doc.title}\n${doc.href ? `(画面: ${doc.href})\n` : ""}\n${doc.body}` }],
    schema: SCHEMA,
    schemaName: "chatbot_training",
    maxTokens: 6000,
    effort: "low",
  });
  const links = doc.href ? [{ label: doc.title.replace(/^(使い方|画面の詳細|画面|権限|ロール|社内資料): /, "").slice(0, 30), href: doc.href }] : [];
  const rows = (res.data.items ?? [])
    .filter((i) => i.question?.trim() && i.answer?.trim())
    .slice(0, PER_DOC + 5)
    .map((i) => ({ question: i.question.trim().slice(0, 200), answer: i.answer.trim().slice(0, 1500), links, origin: "generated" as const, sourceKeys: [doc.key] }));
  const added = insertManyQa(rows);
  markTrained(doc.key, doc.hash);
  return added;
}

/** 学習を始める (終わるまで待たない)。すでに実行中・AI 未設定のときは理由を返す */
export function startTraining(opts: { limit?: number } = {}): { ok: true; total: number } | { ok: false; reason: string } {
  if (!aiEnabled()) return { ok: false, reason: "AI の API キーが設定されていないため、学習できません。" };
  if (trainState().running) return { ok: false, reason: "学習を実行中です。終わるまでお待ちください。" };
  const docs = pendingDocs().slice(0, opts.limit ?? 10_000);
  if (!docs.length) return { ok: false, reason: "学習が必要な資料はありません (すべて学習済みです)。" };
  const state: TrainState = { running: true, startedAt: new Date().toISOString(), total: docs.length, done: 0, added: 0, failed: 0 };
  save(state);
  void runTraining(docs, state);
  return { ok: true, total: docs.length };
}

async function runTraining(docs: DocRow[], state: TrainState) {
  const queue = [...docs];
  const worker = async () => {
    for (let doc = queue.shift(); doc; doc = queue.shift()) {
      if (getMeta(STOP_KEY) === state.startedAt) state.running = false;
      if (!state.running) return;
      try {
        state.added += await trainDoc(doc);
      } catch (err) {
        state.failed++;
        state.error = err instanceof AiError ? `${err.message}${err.detail ? ` (${err.detail.slice(0, 120)})` : ""}` : (err as Error).message;
        console.warn("[chatbot] training failed:", doc.key, state.error);
        // キーの誤り・利用上限は続けても同じなので止める
        if (err instanceof AiError && (err.code === "auth" || err.code === "quota" || err.code === "config")) state.running = false;
      }
      state.done++;
      save(state);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    const stopped = getMeta(STOP_KEY) === state.startedAt;
    save({ ...state, running: false, finishedAt: new Date().toISOString(), error: stopped ? "管理者が停止しました。残りは次の実行で続けます。" : state.error });
  }
}

/** 実行中の学習を止める (いま処理中の資料が終わったところで止まる) */
export function stopTraining(): void {
  const s = trainState();
  if (s.running && s.startedAt) setMeta(STOP_KEY, s.startedAt);
}
