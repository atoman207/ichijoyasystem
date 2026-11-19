import type { Database, PeriodClose } from "@/lib/db/types";
import { ruleAt } from "./rules";

/**
 * 月次確定
 * ------------------------------------------------------------
 * 確定した月の 売上の調整・材料の使用・在庫の移動・手入力・案分 は追加・変更・取消しができない。
 * 訂正は設定 close.correction に従う: reopen = 管理者が確定を解除してから訂正 / next_month = 開いている月に訂正の行を登録
 */

export const monthOf = (date: string) => date.slice(0, 7);

export function closeRow(db: Pick<Database, "periodCloses">, month: string): PeriodClose | undefined {
  return (db.periodCloses ?? []).find((p) => p.month === month);
}

export function isClosed(db: Pick<Database, "periodCloses">, dateOrMonth: string): boolean {
  return closeRow(db, monthOf(dateOrMonth))?.status === "closed";
}

/** 確定した最後の月 (なければ空) */
export function lastClosedMonth(db: Pick<Database, "periodCloses">): string | undefined {
  return (db.periodCloses ?? []).filter((p) => p.status === "closed").map((p) => p.month).sort().pop();
}

/** 確定した月にかかる日付なら、断る理由 */
export function closedReason(db: Pick<Database, "periodCloses" | "mgmtRules">, date: string | undefined, what = "この登録"): string | null {
  if (!date || !isClosed(db, date)) return null;
  const policy = ruleAt(db, "close.correction", date).value;
  return policy === "next_month"
    ? `${monthOf(date)} は月次確定済みです。${what}は確定した月には入れられません。開いている月の日付で訂正として登録してください。`
    : `${monthOf(date)} は月次確定済みです。${what}をするには、管理者が月次確定を解除してください (解除と再確定は履歴に残ります)。`;
}

/**
 * 訂正の行を入れる日付: 元の日付の月が開いていればその日、確定済みなら (翌月以降に訂正する設定のとき) 今日。
 * 確定済みで「解除して訂正」の設定なら null (断る)
 */
export function correctionDate(db: Pick<Database, "periodCloses" | "mgmtRules">, original: string | undefined, today: string): string | null {
  if (!original || !isClosed(db, original)) return original ?? today;
  if (ruleAt(db, "close.correction", original).value !== "next_month") return null;
  return isClosed(db, today) ? null : today;
}
