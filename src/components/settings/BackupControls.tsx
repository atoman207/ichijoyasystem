"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui";

/** 「今すぐバックアップ」のボタン (押したあとは二重に押せない) */
export function BackupButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} className={buttonClass("primary", "sm")}>
      {pending ? "開始しています…" : label}
    </button>
  );
}

/** 実行中は 3 秒ごとに画面を読み直して、終わったら結果を出す */
export function BackupAutoRefresh({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [running, router]);
  return null;
}
