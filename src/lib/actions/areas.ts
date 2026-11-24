"use server";

import { getDb } from "@/lib/db/store";
import { areaStoreOf, type AreaStore } from "@/lib/store-area";
import { requireActionUser } from "./guards";

/** 入力中の住所の担当店舗 (画面の「住所から自動」の表示。src/lib/store-area.ts) */
export async function guessAreaStore(address: string): Promise<AreaStore | null> {
  await requireActionUser();
  return areaStoreOf(getDb(), String(address ?? "").slice(0, 200)) ?? null;
}
