"use client";

import type { StoreId } from "@/lib/db/types";
import { AutoStoreSelect } from "./AutoStoreSelect";

/**
 * 住所と担当店舗の欄 (お客様のご要望 2026-11-24「③ 担当店舗の自動設定」)
 * 住所を入れると担当エリアの店舗を自動で選ぶ (src/lib/store-area.ts)。店舗を手で選んだら、それ以降は自動で変えない。
 * 送る項目: address (住所)・storeId (担当店舗)・storeAuto (手で選んでいないとき "1" = サーバーでも住所から決め直す)。
 * 店舗の欄は AutoStoreSelect (施工現場の住所・お客様の住所も見るときは AutoStoreSelect を直接使う)
 */
export function AreaStoreFields({
  stores,
  defaultStoreId,
  canChooseAny,
  addressName = "address",
  addressLabel = "住所 (新規のお客様・施工場所)",
  addressPlaceholder = "例: 熊本県〇〇市〇〇町1-2",
  defaultAddress = "",
  storeLabel = "担当店舗 (施工・売上計上の店舗)",
  hint,
}: {
  stores: { id: StoreId; name: string }[];
  /** 住所で決まらないときの店舗 (受け付けた人の店舗・お客様の店舗) */
  defaultStoreId: StoreId;
  /** 全店舗から選べる (全店舗のロール)。ほかの人は自店舗と住所の担当エリアの店舗 */
  canChooseAny: boolean;
  addressName?: string;
  addressLabel?: string;
  addressPlaceholder?: string;
  defaultAddress?: string;
  storeLabel?: string;
  hint?: string;
}) {
  return (
    <>
      <label className="block">
        <span className="label">{addressLabel}</span>
        <input name={addressName} defaultValue={defaultAddress} placeholder={addressPlaceholder} maxLength={200} className="field" autoComplete="off" />
        {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
      </label>
      <AutoStoreSelect stores={stores} canChooseAny={canChooseAny} fallbackStoreId={defaultStoreId} choices={[defaultStoreId]} watch={[addressName]} initialAddress={defaultAddress} label={storeLabel} />
    </>
  );
}
