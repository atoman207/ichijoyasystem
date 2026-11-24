"use client";

import { useEffect, useRef, useState } from "react";
import { lookupPostal } from "@/lib/actions/postal";

/**
 * 住所と郵便番号の欄 (お客様のご要望 2026-11-24「① 郵便番号の自動設定」)。
 * 住所を入れると郵便番号を自動で入れる (日本郵便の郵便番号データ。src/lib/postal/lookup.ts)。郵便番号を手で直したら、それ以降は自動で変えない
 */
export function PostalAddressFields({ defaultAddress = "", defaultPostal = "" }: { defaultAddress?: string; defaultPostal?: string }) {
  const [address, setAddress] = useState(defaultAddress);
  const [postal, setPostal] = useState(defaultPostal);
  // 手で入れた郵便番号 (登録済みの郵便番号も手で入れたものとみなす)
  const [manual, setManual] = useState(Boolean(defaultPostal.trim()));
  const [note, setNote] = useState("");
  const seq = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const a = address.trim();
    const id = ++seq.current;
    const t = setTimeout(() => {
      if (manual || a.length < 3) {
        if (seq.current === id) setNote("");
        return;
      }
      lookupPostal(a)
        .then((r) => {
          if (seq.current !== id) return;
          if (r) {
            setPostal(r.postalCode);
            setNote(`住所から自動: 〒${r.postalCode} (${r.place})`);
          } else {
            setNote("住所から郵便番号を決められませんでした (町名・番地まで入れてください)。分かれば手で入れてください");
          }
        })
        .catch(() => seq.current === id && setNote(""));
    }, 450);
    return () => clearTimeout(t);
  }, [address, manual]);

  return (
    <>
      <label className="block">
        <span className="label">住所</span>
        <input name="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="熊本県熊本市..." className="field" autoComplete="off" />
      </label>
      <label className="block">
        <span className="label">郵便番号</span>
        <input
          name="postalCode"
          value={postal}
          onChange={(e) => {
            setPostal(e.target.value);
            setManual(Boolean(e.target.value.trim()));
            setNote("");
          }}
          placeholder="860-0000 (住所から自動で入ります)"
          inputMode="numeric"
          className="field tnum"
          data-testid="postal-code"
        />
        {note ? (
          <span className="mt-1 block text-[11px] text-ink-3" aria-live="polite">
            {note}
          </span>
        ) : manual && postal.trim() ? (
          <button
            type="button"
            className="mt-1 text-[11px] text-accent hover:underline"
            onClick={() => {
              setManual(false);
              setPostal("");
              setNote("");
              lookupPostal(address.trim())
                .then((r) => (r ? (setPostal(r.postalCode), setNote(`住所から自動: 〒${r.postalCode} (${r.place})`)) : setNote("住所から郵便番号を決められませんでした")))
                .catch(() => undefined);
            }}
          >
            住所から入れ直す
          </button>
        ) : null}
      </label>
    </>
  );
}
