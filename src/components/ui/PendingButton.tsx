"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

/**
 * フォームの送信のボタン (ui の Button が使う)
 * 保存が終わるまで同じフォームのボタンを押せなくし、押したボタンに「処理中」の印を出す。
 * 保存に数秒かかるときの二度押しで、同じ問い合わせ・見積が 2 件できないようにする (2026-11-23 に 1 秒差で 2 件の登録があった)。
 * Server Action のフォームの中だけで働く (それ以外では普通のボタン)。
 */
export function PendingButton({ children, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending, data } = useFormStatus();
  const mine = pending && (!rest.name || data?.get(rest.name) === String(rest.value ?? ""));
  return (
    <button {...rest} disabled={disabled || pending} aria-busy={mine || undefined}>
      {mine && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
