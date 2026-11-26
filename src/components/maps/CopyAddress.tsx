"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass } from "@/components/ui";

/**
 * 住所をコピーする (ゼンリン GIS の地点検索に貼り付けるため)。
 * text = 地図で探す住所 (都道府県 + 市区町村 + 町名 + 番地。src/lib/maps/query.ts の mapSearchAddress = resolve.ts の searchText)。
 * 押したあとにコピーした住所を出す (番地まで入ったことを確かめられるように)
 */
export function CopyAddress({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <button
        type="button"
        className={buttonClass("ghost", "sm")}
        title={`コピーする住所: ${text}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 5000);
          } catch {
            window.prompt("住所をコピーしてください", text);
          }
        }}
      >
        {done ? <Check /> : <Copy />}
        {done ? "コピーしました" : "住所をコピー"}
      </button>
      {done && (
        <span className="text-[11px] break-all text-good-ink" data-testid="copied-address">
          {text}
        </span>
      )}
    </span>
  );
}
