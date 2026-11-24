"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import type { StoreId } from "@/lib/db/types";
import { guessAreaStore } from "@/lib/actions/areas";
import type { AreaStore } from "@/lib/store-area";

/**
 * 住所と担当店舗の欄 (お客様のご要望 2026-11-24「③ 担当店舗の自動設定」)
 * 住所を入れると担当エリアの店舗を自動で選ぶ (src/lib/store-area.ts)。店舗を手で選んだら、それ以降は自動で変えない。
 * 送る項目: address (住所)・storeId (担当店舗)・storeAuto (手で選んでいないとき "1" = サーバーでも住所から決め直す)
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
  const [address, setAddress] = useState(defaultAddress);
  const [guess, setGuess] = useState<AreaStore | null>(null);
  const [checking, setChecking] = useState(false);
  const [touched, setTouched] = useState(false);
  const [picked, setPicked] = useState<StoreId>(defaultStoreId);
  const seq = useRef(0);

  useEffect(() => {
    const a = address.trim();
    const id = ++seq.current;
    if (a.length < 2) {
      const t0 = setTimeout(() => seq.current === id && setGuess(null), 0);
      return () => clearTimeout(t0);
    }
    const t = setTimeout(() => {
      setChecking(true);
      guessAreaStore(a)
        .then((g) => seq.current === id && setGuess(g))
        .catch(() => seq.current === id && setGuess(null))
        .finally(() => seq.current === id && setChecking(false));
    }, 400);
    return () => clearTimeout(t);
  }, [address]);

  // 手で選ぶまでは、住所の担当エリアの店舗 (なければ既定の店舗)
  const value: StoreId = touched ? picked : (guess?.storeId ?? defaultStoreId);
  const options = canChooseAny
    ? stores
    : stores.filter(
        (s) =>
          s.id === defaultStoreId || s.id === guess?.storeId || s.id === value,
      );

  return (
    <>
      <label className="block">
        <span className="label">{addressLabel}</span>
        <input
          name={addressName}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={addressPlaceholder}
          maxLength={200}
          className="field"
          autoComplete="off"
        />
        {hint && (
          <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>
        )}
      </label>
      <div>
        <label className="block">
          <span className="label">{storeLabel}</span>
          <input type="hidden" name="storeAuto" value={touched ? "" : "1"} />
          <select
            name="storeId"
            value={value}
            onChange={(e) => {
              setPicked(e.target.value as StoreId);
              setTouched(true);
            }}
            className="field"
            data-testid="area-store"
          >
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.id === guess?.storeId ? " (住所の担当エリア)" : ""}
              </option>
            ))}
          </select>
          <span
            className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-ink-3"
            aria-live="polite"
          >
            <MapPin className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {checking
              ? "住所から担当店舗を確かめています…"
              : guess
                ? touched && value !== guess.storeId
                  ? `手で選んだ店舗にします (住所の担当エリアは ${guess.storeName})`
                  : `住所から自動: ${guess.storeName} (「${guess.town}」の地域)`
                : address.trim().length >= 2
                  ? "住所から担当店舗を決められませんでした (地域一覧にない地域)。店舗を選んでください"
                  : "住所を入れると、担当エリアの店舗を自動で選びます (既存のお客様はお客様の住所で決めます)"}
          </span>
        </label>
        {touched && (
          <button
            type="button"
            onClick={() => setTouched(false)}
            className="mt-0.5 text-[11px] text-accent hover:underline"
          >
            住所から自動で選ぶに戻す
          </button>
        )}
      </div>
    </>
  );
}
