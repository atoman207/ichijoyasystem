"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate } from "@/lib/db/store";
import { canManageChatbot } from "@/lib/auth/permissions";
import { askChatbot } from "@/lib/chatbot/answer";
import { getChatLog } from "@/lib/chatbot/store";
import { aiStatus } from "@/lib/ai/provider";
import { aiBudget, DEFAULT_PRICES, saveAiBudget, saveAiPrices, type AiPrice } from "@/lib/chatbot/monitor";
import { csvToCases, deleteEvalCase, getEvalCase, saveEvalCase, seedEvalCases, setEvalCaseActive, startEvalRun, stopEvalRun, type AskFn, type EvalExpect } from "@/lib/chatbot/eval";
import type { User } from "@/lib/db/types";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * AI アシスタントの品質・費用の管理 (AI アシスタント →「品質・費用」。管理者だけ)
 * 正解付きの質問の登録・取込、評価の実行、低評価の回答から質問を作る、予算と単価の設定
 */

const BACK = "/ai?tab=quality";

async function requireManager(): Promise<User> {
  const user = await requireActionUser();
  if (!canManageChatbot(user)) fail(BACK, "AI アシスタントの品質・費用の管理は管理者のみ行えます。");
  return user;
}

async function audit(user: User, summary: string, entityId = "chatbot-eval") {
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "ai", entityId, entityLabel: "AI アシスタントの品質", summary, storeId: user.storeId });
  });
}

/** 評価の質問 (askChatbot を「評価」として呼ぶ: 履歴・蓄えた回答・1 時間の上限に触れない) */
const evalAsk: AskFn = async (db, user, history, question) => {
  const r = await askChatbot(db, user, history.map((h) => ({ role: h.role, content: h.content, specs: h.specs as never })), question, { evaluation: true });
  return { answer: r.answer, tools: r.tools, sources: r.sources, source: r.source, checks: r.checks, tables: r.tables };
};

export async function startChatbotEval(formData: FormData) {
  const user = await requireManager();
  const db = getDb();
  if (!aiStatus().enabled) fail(BACK, "AI のキーが設定されていないため、評価を実行できません。");
  seedEvalCases(db, user.id);
  const only = str(formData, "category");
  const { listEvalCases } = await import("@/lib/chatbot/eval");
  const ids = only ? listEvalCases({ activeOnly: true, category: only }).map((c) => c.id) : undefined;
  if (ids && !ids.length) fail(BACK, "この分類には有効な質問がありません。");
  const r = startEvalRun(db, evalAsk, { label: str(formData, "label").slice(0, 60) || (only ? `分類: ${only}` : "手動"), by: user.name, caseIds: ids, provider: `${aiStatus().label} ${aiStatus().model ?? ""}`.trim() });
  if (!r.ok) fail(BACK, r.reason);
  await audit(user, `AI アシスタントの精度の評価を開始${only ? ` (分類 ${only})` : ""}`);
  revalidatePath("/ai");
  redirect(withMsg(BACK, "評価を始めました。1 問 10〜40 秒ほどかかります。画面を再読み込みすると進み具合を確認できます。"));
}

export async function stopChatbotEval() {
  const user = await requireManager();
  stopEvalRun();
  await audit(user, "AI アシスタントの精度の評価を中止");
  redirect(withMsg(BACK, "いまの質問が終わったところで評価を止めます。"));
}

export async function seedChatbotEvalCases() {
  const user = await requireManager();
  const n = seedEvalCases(getDb(), user.id);
  await audit(user, `評価の始めの質問を追加 (${n} 問)`);
  revalidatePath("/ai");
  redirect(withMsg(BACK, n ? `始めの質問を ${n} 問追加しました。` : "始めの質問はすべて登録済みです。"));
}

const lines = (s: string) => s.split(/[\n|｜]/).map((x) => x.trim()).filter(Boolean);

function expectFromForm(fd: FormData): EvalExpect {
  const numbers = lines(str(fd, "numbers")).map((x) => Number(x.replace(/[,，円件人¥￥\s]/g, ""))).filter((n) => Number.isFinite(n));
  const e: EvalExpect = {};
  if (lines(str(fd, "contains")).length) e.contains = lines(str(fd, "contains"));
  if (lines(str(fd, "anyOf")).length) e.anyOf = lines(str(fd, "anyOf"));
  if (numbers.length) e.numbers = numbers;
  if (str(fd, "sql")) e.sql = str(fd, "sql").slice(0, 4000);
  if (str(fd, "sqlMode") === "any") e.sqlMode = "any";
  if (str(fd, "sqlScope") === "user") e.sqlScope = "user";
  if (str(fd, "forbidSql")) e.forbidSql = str(fd, "forbidSql").slice(0, 4000);
  if (lines(str(fd, "notContains")).length) e.notContains = lines(str(fd, "notContains"));
  if (lines(str(fd, "tools")).length) e.tools = lines(str(fd, "tools"));
  if (lines(str(fd, "links")).length) e.links = lines(str(fd, "links")).filter((l) => l.startsWith("/"));
  if (fd.get("unknown")) e.unknown = true;
  if (fd.get("refuse")) e.refuse = true;
  return e;
}

/** 正解付きの質問の追加・修正 */
export async function saveChatbotEvalCase(formData: FormData) {
  const user = await requireManager();
  const id = Number(str(formData, "id")) || undefined;
  const question = str(formData, "question");
  if (question.length < 2) fail(BACK, "質問を入力してください。");
  const expect = expectFromForm(formData);
  if (!Object.keys(expect).filter((k) => !["tools", "sqlMode", "sqlScope"].includes(k)).length) fail(BACK, "正解の条件 (含む言葉・数字・SQL・答えられない・断る のどれか) を入力してください。");
  if (id && !getEvalCase(id)) fail(BACK, "質問が見つかりません。");
  saveEvalCase(
    {
      category: str(formData, "category") || "howto",
      question,
      history: lines(str(formData, "history")),
      role: str(formData, "role") || "admin",
      storeId: str(formData, "storeId"),
      expect,
      answerNote: str(formData, "answerNote"),
      evidenceNote: str(formData, "evidenceNote"),
      origin: str(formData, "origin") || "manual",
      active: true,
    },
    user.id,
    id,
  );
  await audit(user, `評価の質問を${id ? "修正" : "追加"} (${question.slice(0, 40)})`);
  revalidatePath("/ai");
  redirect(withMsg(`${BACK}#cases`, id ? "質問を修正しました。" : "質問を追加しました。次の評価から使われます。"));
}

export async function toggleChatbotEvalCase(id: number) {
  const user = await requireManager();
  const c = getEvalCase(id);
  if (!c) fail(BACK, "質問が見つかりません。");
  setEvalCaseActive(id, !c.active);
  await audit(user, `評価の質問を${c.active ? "無効" : "有効"}に (${c.question.slice(0, 40)})`);
  revalidatePath("/ai");
  redirect(withMsg(`${BACK}#cases`, c.active ? "質問を無効にしました (評価に使いません)。" : "質問を有効にしました。"));
}

export async function deleteChatbotEvalCase(id: number) {
  const user = await requireManager();
  const c = getEvalCase(id);
  if (!c) fail(BACK, "質問が見つかりません。");
  deleteEvalCase(id);
  await audit(user, `評価の質問を削除 (${c.question.slice(0, 40)})`);
  revalidatePath("/ai");
  redirect(withMsg(`${BACK}#cases`, "質問を削除しました。"));
}

/** CSV (表計算ソフトで作った正解付きの質問) を取り込む */
export async function importChatbotEvalCsv(formData: FormData) {
  const user = await requireManager();
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) fail(BACK, "CSV ファイルを選んでください。");
  if (file.size > 2 * 1024 * 1024) fail(BACK, "CSV が大きすぎます (2 MB まで)。");
  const buf = Buffer.from(await file.arrayBuffer());
  // Excel の「CSV (コンマ区切り)」は Shift_JIS のことがある
  let text = buf.toString("utf8");
  if (text.includes("�")) text = new TextDecoder("shift_jis").decode(buf);
  const { cases, errors } = csvToCases(text, getDb().stores);
  if (!cases.length) fail(BACK, errors.slice(0, 3).join(" / ") || "取り込める行がありませんでした。");
  for (const c of cases) saveEvalCase(c, user.id);
  await audit(user, `評価の質問を CSV から取込 (${cases.length} 問)`);
  revalidatePath("/ai");
  redirect(withMsg(`${BACK}#cases`, `${cases.length} 問を取り込みました。${errors.length ? ` 取り込めなかった行: ${errors.slice(0, 3).join(" / ")}${errors.length > 3 ? ` ほか ${errors.length - 3} 行` : ""}` : ""}`));
}

/** 低評価 (👎) の相談から、正解付きの質問を作る (正しい回答を人が書く) */
export async function addChatToEval(logId: number, formData: FormData) {
  const user = await requireManager();
  const log = getChatLog(logId);
  if (!log) fail(BACK, "相談が見つかりません。");
  const expect = expectFromForm(formData);
  if (!Object.keys(expect).filter((k) => k !== "tools").length) fail(`${BACK}#lowrated`, "正解の条件 (含む言葉・数字・答えられない・断る のどれか) を入力してください。");
  const u = getDb().users.find((x) => x.id === log.userId);
  saveEvalCase(
    {
      category: str(formData, "category") || "howto",
      question: log.question,
      role: u?.role ?? log.role,
      storeId: u?.storeId ?? log.storeId,
      expect,
      answerNote: str(formData, "answerNote"),
      evidenceNote: `相談の履歴 #${logId}`,
      origin: "chat",
    },
    user.id,
  );
  await audit(user, `低評価の相談 #${logId} を評価の質問に追加`);
  revalidatePath("/ai");
  redirect(withMsg(`${BACK}#lowrated`, "評価の質問に追加しました。次の評価から正しく答えられるかを確かめます。"));
}

/** 月の予算・トークンの上限・為替・単価 */
export async function saveChatbotBudget(formData: FormData) {
  const user = await requireManager();
  const n = (k: string) => {
    const v = Number(str(formData, k).replace(/[,，円\s]/g, ""));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const before = aiBudget();
  const next = { monthlyJpy: Math.round(n("monthlyJpy")), monthlyTokens: Math.round(n("monthlyTokens")), usdJpy: n("usdJpy") || 150, onExceed: str(formData, "onExceed") === "warn" ? ("warn" as const) : ("fallback" as const) };
  saveAiBudget(next);
  // 単価: 「モデル名 入力 キャッシュ 出力」を 1 行に 1 つ (米ドル / 100 万トークン)
  const prices: Record<string, AiPrice> = {};
  const errors: string[] = [];
  for (const line of lines(str(formData, "prices"))) {
    const [model, a, b, c] = line.split(/[\s,，]+/);
    const vals = [a, b, c].map(Number);
    if (!model || vals.some((v) => !Number.isFinite(v) || v < 0) || c === undefined) {
      errors.push(line);
      continue;
    }
    prices[model] = { in: vals[0], cachedIn: vals[1], out: vals[2] };
  }
  // 既定と同じものは保存しない (既定が直ったときに追随するように)
  const custom = Object.fromEntries(Object.entries(prices).filter(([k, p]) => JSON.stringify(DEFAULT_PRICES[k]) !== JSON.stringify(p)));
  saveAiPrices(custom);
  await mutate((db) => {
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "ai",
      entityId: "ai-budget",
      entityLabel: "AI の予算",
      summary: `AI の予算・単価を変更 (月 ${next.monthlyJpy.toLocaleString()} 円・${next.monthlyTokens.toLocaleString()} トークン・${next.onExceed === "warn" ? "警告だけ" : "超えたら AI を止める"})`,
      changes: [
        { field: "monthlyJpy", before: before.monthlyJpy, after: next.monthlyJpy },
        { field: "monthlyTokens", before: before.monthlyTokens, after: next.monthlyTokens },
        { field: "onExceed", before: before.onExceed, after: next.onExceed },
      ].filter((c) => c.before !== c.after),
      storeId: user.storeId,
    });
  });
  revalidatePath("/ai");
  redirect(withMsg(`${BACK}#usage`, `予算と単価を保存しました。${errors.length ? ` 読めなかった単価の行: ${errors.join(" / ")}` : ""}`));
}
