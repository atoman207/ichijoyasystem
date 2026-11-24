"use server";

import { postalFromAddress } from "@/lib/postal/lookup";
import { requireActionUser } from "./guards";

/** 入力中の住所の郵便番号 (顧客の登録・変更の画面で自動入力。src/lib/postal/lookup.ts)。決まらなければ null */
export async function lookupPostal(address: string): Promise<{ postalCode: string; place: string } | null> {
  await requireActionUser();
  const r = postalFromAddress(String(address ?? "").slice(0, 200));
  return r.ok ? { postalCode: r.hit.postalCode, place: `${r.hit.pref}${r.hit.city}${r.hit.town}` } : null;
}
