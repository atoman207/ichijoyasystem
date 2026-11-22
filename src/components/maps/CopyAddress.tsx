"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass } from "@/components/ui";

/** 住所をコピーする (ゼンリン GIS の地点検索に貼り付けるため) */
export function CopyAddress({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass("ghost", "sm")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          window.prompt("住所をコピーしてください", text);
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? "コピーしました" : "住所をコピー"}
    </button>
  );
}
