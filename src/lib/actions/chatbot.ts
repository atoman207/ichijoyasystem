"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, syncDb } from "@/lib/db/store";
import { getSessionUser } from "@/lib/auth/session";
import { canManageChatbot } from "@/lib/auth/permissions";
import { askChatbot, type BotReply, type ChatTurn } from "@/lib/chatbot/answer";
import { ensureChatbotData } from "@/lib/chatbot/build";
import { startTraining, stopTraining } from "@/lib/chatbot/train";
import { deleteQa, getQa, insertQa, rateQa, updateQa } from "@/lib/chatbot/store";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

const BACK = "/ai?tab=bot";

/** 画面左下のチャットボットへの質問 (ログイン前のトップページからも使える) */
export async function askChatbotAction(history: ChatTurn[], question: string): Promise<BotReply> {
  const user = await getSessionUser();
  const db = user ? getDb() : await syncDb();
  const q = String(question ?? "").trim();
  if (!q) return { answer: "質問を入力してください。", links: [], source: "none", suggestions: [] };
  const turns: ChatTurn[] = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-6)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
  try {
    return await askChatbot(db, user, turns, q);
  } catch (err) {
    console.error("[chatbot] failed:", err);
    return { answer: "ごめんなさい、いま回答を用意できませんでした。少し時間をおいてもう一度お試しください。", links: [], source: "none", suggestions: [] };
  }
}

/** 回答の評価 (👍 / 👎)。👎 が重なった自動の回答は使われなくなる。ログイン前でも可 */
export async function rateChatbotAnswer(qaId: number, good: boolean): Promise<{ ok: boolean }> {
  if (!Number.isInteger(qaId) || qaId <= 0 || !getQa(qaId)) return { ok: false };
  rateQa(qaId, Boolean(good));
  return { ok: true };
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
