"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { buttonClass } from "@/components/ui";

type Variant = "primary" | "secondary" | "ghost" | "danger";

/**
 * テスト期間中に止めているアカウントの操作のボタン (account-rules.ts の accountEditLocked)。
 * 見た目は元のボタンと同じで、押すと送信せずに「テスト期間中のため変更できません」を出す
 */
export function AccountLockButton({ label, message, variant = "primary", size = "sm", className }: { label: string; message: string; variant?: Variant; size?: "sm" | "md"; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(true)} className={buttonClass(variant, size, className)}>
        {label}
      </button>
      {open && (
        <span role="alert" className="flex max-w-xs items-start gap-1.5 rounded-lg bg-warn-soft px-2.5 py-1.5 text-left text-[11px] leading-relaxed font-normal text-warn-ink">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{message}</span>
        </span>
      )}
    </span>
  );
}
