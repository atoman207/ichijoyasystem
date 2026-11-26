"use client";

import { useSearchParams } from "next/navigation";
import { CircleAlert, CircleCheck } from "lucide-react";
import { shownFromUrl } from "./toast";

/**
 * 画面の上の知らせ。
 * 画面の操作の結果 (URL の ?msg= / ?err=) はトースト (AppShell の Toaster) が出すので、ここでは出さない。
 * 画面が自分で決めた知らせ (「権限がありません」「提案の日時を入れています」など、URL にない文) だけを画面の中に出す
 */
export function Flash({ msg, err }: { msg?: string; err?: string }) {
  const params = useSearchParams();
  const fromUrl = (t?: string) => Boolean(t) && (params.get("msg") === t || params.get("err") === t || shownFromUrl(t));
  const m = msg && !fromUrl(msg) ? msg : undefined;
  const e = err && !fromUrl(err) ? err : undefined;
  if (!m && !e) return null;
  return (
    <div role="status" className={e ? "mb-4 flex items-start gap-2.5 rounded-xl border border-critical/30 bg-critical-soft px-4 py-3 text-sm text-critical-ink shadow-card animate-fade" : "mb-4 flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-accent-ink shadow-card animate-fade"}>
      {e ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>{e ?? m}</span>
    </div>
  );
}
