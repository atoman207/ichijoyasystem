"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass } from "@/components/ui";

/** 投稿文をコピーする (SNS・ホームページの投稿画面に貼り付ける) */
export function CopyText({ text, label = "コピー", variant = "secondary" }: { text: string; label?: string; variant?: "primary" | "secondary" | "ghost" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass(variant, "sm")}
      disabled={!text.trim()}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          window.prompt("コピーしてください", text);
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? "コピーしました" : label}
    </button>
  );
}
