"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * 帳票 (見積書・納品書・請求書・領収書・まとめて印刷) の PDF のボタン (お客様のご要望 2026-11-26「スマートフォンで PDF を開いたあと元の画面に簡単に戻れるように」)
 * - パソコン: 今までどおり PDF を別のタブで開く (印刷しやすい)
 * - スマートフォン・タブレット・ホーム画面のアプリ: システムの画面の中で見る /docs/view を開く (上と下に「元の画面に戻る」。src/lib/doc-view.ts)
 * returnTo = 戻る先 (なければ今の画面。予定表の小さな画面は、その予定を開き直す場所を渡す)
 */
export function PdfLink({ href, returnTo, className, children, testId, title }: { href: string; returnTo?: string; className?: string; children: ReactNode; testId?: string; title?: string }) {
  const router = useRouter();
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const touch = window.matchMedia?.("(pointer: coarse)").matches;
    const app = window.matchMedia?.("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (!touch && !app) return;
    e.preventDefault();
    const back = returnTo ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
    router.push(`/docs/view?src=${encodeURIComponent(href)}&returnTo=${encodeURIComponent(back)}`);
  };
  return (
    <a href={href} target="_blank" rel="noopener" onClick={onClick} className={className} data-testid={testId} title={title}>
      {children}
    </a>
  );
}
