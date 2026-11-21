"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, syncDb } from "@/lib/db/store";
import { getSessionUser } from "@/lib/auth/session";
import { canManageChatbot, canShareChatToKnowledge, canViewChatLog, canViewKnowledge } from "@/lib/auth/permissions";
import { askChatbot, type BotReply, type ChatTurn } from "@/lib/chatbot/answer";
import { cleanTurns } from "@/lib/chatbot/ask-input";
import { ensureChatbotData } from "@/lib/chatbot/build";
import { startTraining, stopTraining } from "@/lib/chatbot/train";
import { deleteQa, getChatLog, getQa, insertQa, markChatShared, rateChatLog, rateQa, updateQa } from "@/lib/chatbot/store";
import { newId, nowIso } from "@/lib/db/store";
import { KNOWLEDGE_FAQ_CATEGORY } from "@/lib/knowledge";
import { initialReview, reviewSettings } from "@/lib/knowledge-review";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

const BACK = "/ai?tab=bot";

/** 画面左下のチャットボット (「質問する」) への質問 (ログイン前のトップページからも使える) */
export async function askChatbotAction(history: ChatTurn[], question: string, convId?: string, opts?: { voice?: boolean }): Promise<BotReply> {
  const user = await getSessionUser();
  const db = user ? getDb() : await syncDb();
  const q = String(question ?? "").trim();
  if (!q) return { answer: "質問を入力してください。", links: [], source: "none", suggestions: [] };
  const turns: ChatTurn[] = cleanTurns(history, Boolean(user));
  try {
    return await askChatbot(db, user, turns, q, { convId: typeof convId === "string" ? convId.slice(0, 64) : undefined, voice: opts?.voice === true });
  } catch (err) {
    console.error("[chatbot] failed:", err);
    return { answer: "ごめんなさい、いま回答を用意できませんでした。少し時間をおいてもう一度お試しください。", links: [], source: "none", suggestions: [] };
  }
}

/** 回答の評価 (👍 / 👎)。👎 が重なった自動の回答は使われなくなる。ログイン前でも可。相談の履歴にも残す (本人の履歴だけ) */
export async function rateChatbotAnswer(qaId: number | undefined, good: boolean, logId?: number): Promise<{ ok: boolean }> {
  let ok = false;
  if (typeof qaId === "number" && Number.isInteger(qaId) && qaId > 0 && getQa(qaId)) {
    rateQa(qaId, Boolean(good));
    ok = true;
  }
  if (typeof logId === "number" && Number.isInteger(logId) && logId > 0) {
    const user = await getSessionUser();
    const log = getChatLog(logId);
    if (user && log && log.userId === user.id) {
      rateChatLog(logId, Boolean(good));
      ok = true;
    }
  }
  return { ok };
}

/**
 * 相談の回答を社内資料 (よくある質問) に登録する。登録した資料は全員の AI アシスタント・チャットボットの根拠になる。
 * 画面で質問と回答を整えてから登録する (個人情報・その時点の数字は消してから)
 */
export async function shareChatToKnowledge(logId: number, formData: FormData) {
  const user = await requireActionUser();
  const back = `/ai?tab=history&id=${logId}`;
  if (!canShareChatToKnowledge(user)) fail(back, "社内資料への登録は、店長・本部スタッフ・管理者が行えます。");
  const log = getChatLog(logId);
  if (!log || !canViewChatLog(user, log)) fail("/ai?tab=history", "相談が見つからないか、閲覧する権限がありません。");
  const title = str(formData, "title").slice(0, 200);
  const body = str(formData, "body").slice(0, 20000);
  if (!title || !body) fail(back, "タイトルと本文を入力してください。");
  const visibility = (["all", "manager", "hq", "admin"] as const).find((v) => v === str(formData, "visibility")) ?? "all";
  if (!canViewKnowledge(user, { visibility })) fail(back, "自分が見られない範囲は選べません。");
  const category = str(formData, "category").slice(0, 40) || KNOWLEDGE_FAQ_CATEGORY;
  const id = newId("kn");
  await mutate((db) => {
    const now = nowIso();
    // 担当者は登録した人 (内容に責任を持ち、定期的に確かめる。src/lib/knowledge-review.ts)
    db.knowledge.push({ id, title, body, category, tags: ["相談から登録"], source: "manual", sourceRef: `chat:${logId}`, active: true, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now, visibility, ...initialReview(reviewSettings(db), category, { ownerId: user.id }), reviewedAt: now, reviewedBy: user.id });
    addAudit(db, { userId: user.id, action: "create", entity: "knowledge", entityId: id, entityLabel: title.slice(0, 60), summary: `相談の回答を社内資料に登録 (${title.slice(0, 40)})`, storeId: user.storeId });
  });
  markChatShared(logId, id);
  revalidatePath("/knowledge");
  revalidatePath("/ai");
  redirect(withMsg(`/knowledge/${id}`, "社内資料に登録しました。AI アシスタントとチャットボットが回答に使います。"));
}

async function requireManager() {
  const user = await requireActionUser();
  if (!canManageChatbot(user)) fail(BACK, "チャットボットの管理は管理者のみ行えます。");
  return user;
}

function back(fd: FormData) {
  return safeReturn(str(fd, "returnTo"), BACK);
}

/** 回答の追加・修正 (人が登録した回答は manual として、自動の回答より優先される) */
export async function saveChatbotQa(formData: FormData) {
  const user = await requireManager();
  const to = back(formData);
  const id = Number(str(formData, "id")) || 0;
  const question = str(formData, "question").slice(0, 200);
  const answer = str(formData, "answer").slice(0, 3000);
  if (question.length < 2 || !answer) fail(to, "質問と回答を入力してください。");
  const before = id ? getQa(id) : undefined;
  if (id && !before) fail(to, "回答が見つかりません。");
  if (before) {
    updateQa(id, { question, answer, disabled: false });
  } else {
    const href = str(formData, "href");
    const links = href.startsWith("/") && !href.startsWith("//") ? [{ label: str(formData, "hrefLabel").slice(0, 30) || "画面を開く", href }] : [];
    if (insertQa({ question, answer, links, origin: "manual" }) === undefined) fail(to, "質問が短すぎます。");
  }
  await mutate((db) => {
    addAudit(db, {
      userId: user.id,
      action: before ? "update" : "create",
      entity: "ai",
      entityId: before ? `chatbot:${id}` : "chatbot",
      entityLabel: "チャットボットの回答",
      summary: `チャットボットの回答を${before ? "修正" : "追加"} (${question.slice(0, 40)})`,
      changes: before ? [{ field: "question", before: before.question, after: question }, { field: "answer", before: before.answer.slice(0, 500), after: answer.slice(0, 500) }].filter((c) => c.before !== c.after) : undefined,
      storeId: user.storeId,
    });
  });
  revalidatePath("/ai");
  redirect(withMsg(to, before ? "回答を修正しました。次の質問から使われます。" : "回答を追加しました。"));
}

export async function toggleChatbotQa(id: number, formData: FormData) {
  const user = await requireManager();
  const to = back(formData);
  const qa = getQa(id);
  if (!qa) fail(to, "回答が見つかりません。");
  updateQa(id, { disabled: !qa.disabled });
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "ai", entityId: `chatbot:${id}`, entityLabel: "チャットボットの回答", summary: `チャットボットの回答を${qa.disabled ? "有効" : "無効"}に (${qa.question.slice(0, 40)})`, changes: [{ field: "disabled", before: qa.disabled, after: !qa.disabled }], storeId: user.storeId });
  });
  revalidatePath("/ai");
  redirect(withMsg(to, qa.disabled ? "回答を有効にしました。" : "回答を無効にしました (使われなくなります)。"));
}

export async function deleteChatbotQa(id: number, formData: FormData) {
  const user = await requireManager();
  const to = back(formData);
  const qa = getQa(id);
  if (!qa) fail(to, "回答が見つかりません。");
  deleteQa(id);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "delete", entity: "ai", entityId: `chatbot:${id}`, entityLabel: "チャットボットの回答", summary: `チャットボットの回答を削除 (${qa.question.slice(0, 40)})`, storeId: user.storeId });
  });
  revalidatePath("/ai");
  redirect(withMsg(to, "回答を削除しました。"));
}

/** VPS のデータベース (システムの全データの写し) を作り直す。時間がかかるので、始めたらすぐに戻る */
export async function rebuildDataMirror() {
  const user = await requireManager();
  const { rebuildMirror } = await import("@/lib/datastore/mirror");
  void rebuildMirror().catch((err) => console.error("[mirror] rebuild failed:", err));
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "ai", entityId: "data-mirror", entityLabel: "VPS のデータベース", summary: "VPS のデータベース (AI が検索・集計に使うシステムの全データの写し) を作り直し", storeId: user.storeId });
  });
  revalidatePath("/ai");
  redirect(withMsg(BACK, "VPS のデータベースの作り直しを始めました。1〜3 分ほどで終わります (画面を再読み込みすると状況を確認できます)。"));
}

/** システムの説明 (使い方・権限・画面・社内資料) から、資料と自動の質問を作り直す */
export async function rebuildChatbot() {
  const user = await requireManager();
  const r = ensureChatbotData(getDb(), true);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "ai", entityId: "chatbot", entityLabel: "チャットボット", summary: `チャットボットのデータを作り直し (資料 ${r.docs} 件・自動の質問 ${r.seeds} 件)`, storeId: user.storeId });
  });
  revalidatePath("/ai");
  redirect(withMsg(BACK, `作り直しました。資料 ${r.docs} 件 (変更 ${r.changed} 件)、自動で作った質問 ${r.seeds} 件。`));
}

export async function startChatbotTraining(formData: FormData) {
  const user = await requireManager();
  ensureChatbotData(getDb());
  const limit = Number(str(formData, "limit")) || undefined;
  const r = startTraining({ limit });
  if (!r.ok) fail(BACK, r.reason);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "update", entity: "ai", entityId: "chatbot", entityLabel: "チャットボット", summary: `チャットボットの学習を開始 (資料 ${r.total} 件)`, storeId: user.storeId });
  });
  revalidatePath("/ai");
  redirect(withMsg(BACK, `学習を始めました (資料 ${r.total} 件)。画面を再読み込みすると進み具合を確認できます。`));
}

export async function stopChatbotTraining() {
  await requireManager();
  stopTraining();
  revalidatePath("/ai");
  redirect(withMsg(BACK, "停止を受け付けました。処理中の資料が終わったところで止まります。"));
}
