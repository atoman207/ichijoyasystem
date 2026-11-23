import type { ExpenseClass, StoreId } from "@/lib/db/types";

/**
 * 経費の区分の既定 (店舗独自経費か案分経費か)
 * ------------------------------------------------------------
 * お客様のご説明 (2026-11-23):
 * - 店舗独自経費: 各店舗の人件費・店舗の売上にひも付く材料費・外注費・店舗の判断で予算を超えて行った広告宣伝費
 * - 案分経費: 広告宣伝費の大部分・消耗品費のすべて (どの店舗で使ったかに関係なく)・畳の処分費などの廃棄物処分費・
 *   開発費など全店舗で共通に負担する経費。全社 (本部) で集約して、各店舗に粗利益の比率で振り分ける
 * - アンケートのハガキ・タオルなど、これまで材料移動に入れていた「最終的に案分経費になるもの」も案分経費
 * 経費ごとに区分を登録すれば (expense_classes)、その区分が優先する (店舗の予算を超えた広告費は「店舗独自経費」に変える)
 */

/** 案分経費になる勘定科目 */
export const COMMON_ACCOUNTS = /消耗品|廃棄|処分|広告|宣伝|販売促進|販促|開発/;
/** 案分経費になる品名 (勘定科目が通信費などでも) */
export const COMMON_WORDS = /ハガキ|はがき|葉書|タオル/;

export interface DefaultClass {
  allocClass: ExpenseClass["allocClass"];
  reason: string;
}

/** 区分を登録していない経費・仕入の既定の区分 */
export function defaultExpenseClass(e: { account?: string; storeId: StoreId | string; description?: string; vendor?: string }): DefaultClass {
  const account = e.account ?? "";
  if (COMMON_ACCOUNTS.test(account)) return { allocClass: "common", reason: `勘定科目「${account}」は案分経費` };
  if (COMMON_WORDS.test(`${e.description ?? ""} ${e.vendor ?? ""}`)) return { allocClass: "common", reason: "ハガキ・タオルなどは案分経費" };
  if (e.storeId === "hq") return { allocClass: "common", reason: "本部の経費は全社で集約して案分" };
  return { allocClass: "store", reason: "店舗の経費 (店舗独自経費)" };
}
