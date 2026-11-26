"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import clsx from "clsx";

/**
 * パスワードの入力欄 + 目のアイコン (押すと入力したパスワードを表示 / もう一度押すと隠す)。ログイン・新規登録の画面で使う。
 * - 入力欄の右端にボタンを重ね、文字がアイコンの下に入らないよう右の余白を広げる
 * - ボタンは type="button" (押してもフォームを送らない)。読み上げは「パスワードを表示する / 隠す」
 * - 送信のあとは隠した状態に戻す必要がないため状態は持ったまま (画面を移ると消える)
 */
export function PasswordInput({ className, defaultShown = false, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { defaultShown?: boolean }) {
  const [shown, setShown] = useState(defaultShown);
  return (
    <span className="relative block">
      <input {...props} type={shown ? "text" : "password"} className={clsx("field pr-11", className)} autoCapitalize="none" spellCheck={false} />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-ink-3 transition hover:text-ink focus:outline-none focus-visible:text-accent focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={shown ? "パスワードを隠す" : "パスワードを表示する"}
        aria-pressed={shown}
        title={shown ? "パスワードを隠す" : "パスワードを表示する"}
        data-testid="password-toggle"
      >
        {shown ? <EyeOff className="h-[18px] w-[18px]" aria-hidden /> : <Eye className="h-[18px] w-[18px]" aria-hidden />}
      </button>
    </span>
  );
}
