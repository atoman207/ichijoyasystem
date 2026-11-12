"use client";

import Link from "@/components/ui/Link";

export function PrintToolbar({ backHref }: { backHref: string }) {
  return (
    <div className="mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between px-2 print:hidden">
      <Link href={backHref} className="text-sm text-ink-2 hover:text-ink">← 戻る</Link>
      <div className="flex gap-2">
        <button type="button" onClick={() => window.print()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
          印刷 / PDF 保存
        </button>
      </div>
    </div>
  );
}
