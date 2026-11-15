import type { CashEntry, CashSource, Database, StoreId } from "@/lib/db/types";
import { newId, nextNumber, nowIso } from "@/lib/db/store";

/**
 * 現金出納帳 (店舗ごとの手元現金)
 * ------------------------------------------------------------
 * - 手入力の入出金 (銀行預入・小口現金の補充など) と、次の操作からの自動の記帳を 1 つの帳簿にまとめる
 *   ・入金の登録で「現金」を選んだとき (請求・入金の画面、受注の画面の集金) → 入金
 *   ・経費の精算で、支払方法が「現金」の経費を精算済みにしたとき → 出金
 *   ・仕入請求書の支払完了で「現金」を選んだとき → 出金
 * - 残高は「繰越 (期首の残高)」を含む入金の合計 − 出金の合計。日付順 (同じ日は登録順) に積み上げる
 * - 自動で記帳した行は元の記録 (sourceId) と結び付け、同じ記録から 2 回記帳しない
 */

/** 自動の記帳 (元の記録 1 件につき 1 行。すでにあれば何もしない) */
export function postCash(
  db: Database,
  e: { storeId: StoreId; date: string; direction: "in" | "out"; amount: number; account: string; counterparty?: string; description: string; source: Exclude<CashSource, "manual" | "opening">; sourceId: string; userId: string },
): CashEntry | undefined {
  if (!(e.amount > 0)) return undefined;
  if (db.cashEntries.some((c) => c.source === e.source && c.sourceId === e.sourceId)) return undefined;
  const now = nowIso();
  const entry: CashEntry = {
    id: newId("cash"),
    number: nextNumber(db, "CASH", db.cashEntries, e.date),
    storeId: e.storeId,
    date: e.date,
    direction: e.direction,
    amount: Math.round(e.amount),
    account: e.account,
    counterparty: e.counterparty || undefined,
    description: e.description,
    source: e.source,
    sourceId: e.sourceId,
    recordedBy: e.userId,
    createdAt: now,
    updatedAt: now,
  };
  db.cashEntries.push(entry);
  return entry;
}

export const signed = (c: Pick<CashEntry, "direction" | "amount">) => (c.direction === "in" ? c.amount : -c.amount);

/** 日付順 (同じ日は登録順) */
export function sortCash(rows: CashEntry[]): CashEntry[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export interface CashMonth {
  /** 前月からの繰越 (月初の残高) */
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
  /** 月内の行と、その行の後の残高 */
  rows: { entry: CashEntry; balance: number }[];
  /** 科目別の合計 (入金・出金) */
  byAccount: { account: string; in: number; out: number }[];
}

/** 店舗の 1 か月分の現金出納帳 (month = YYYY-MM) */
export function cashMonth(entries: CashEntry[], storeId: StoreId, month: string): CashMonth {
  const mine = sortCash(entries.filter((c) => c.storeId === storeId));
  const opening = mine.filter((c) => c.date < `${month}-01`).reduce((a, c) => a + signed(c), 0);
  let balance = opening;
  const rows: CashMonth["rows"] = [];
  const acc = new Map<string, { in: number; out: number }>();
  for (const c of mine) {
    if (!c.date.startsWith(month)) continue;
    balance += signed(c);
    rows.push({ entry: c, balance });
    const a = acc.get(c.account) ?? { in: 0, out: 0 };
    if (c.direction === "in") a.in += c.amount;
    else a.out += c.amount;
    acc.set(c.account, a);
  }
  const totalIn = rows.filter((r) => r.entry.direction === "in").reduce((a, r) => a + r.entry.amount, 0);
  const totalOut = rows.filter((r) => r.entry.direction === "out").reduce((a, r) => a + r.entry.amount, 0);
  return {
    opening,
    totalIn,
    totalOut,
    closing: opening + totalIn - totalOut,
    rows,
    byAccount: [...acc.entries()].map(([account, v]) => ({ account, ...v })).sort((a, b) => b.in + b.out - (a.in + a.out)),
  };
}

/** 店舗の現在の残高 (今日までの記帳) */
export function cashBalance(entries: CashEntry[], storeId: StoreId, until: string): number {
  return entries.filter((c) => c.storeId === storeId && c.date <= until).reduce((a, c) => a + signed(c), 0);
}
