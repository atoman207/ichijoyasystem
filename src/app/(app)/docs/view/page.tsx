import type { Metadata } from "next";
import { Download, ExternalLink, FileText } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { safeReturn } from "@/lib/actions/guards";
import { MAX_VIEW_PAGES, loadDoc } from "@/lib/doc-view";
import { Card, buttonClass } from "@/components/ui";
import { MapBackButton, MapPageImage } from "@/components/maps/MapViewer";

export const metadata: Metadata = { title: "帳票" };
export const dynamic = "force-dynamic";

/**
 * 帳票 (見積書・納品書・請求書・領収書・まとめて印刷) をシステムの画面の中で見る (お客様のご要望 2026-11-26
 * 「スマートフォンで PDF を開いたあと元の画面に簡単に戻れるように」)。スマートフォン・タブレット・ホーム画面のアプリでは、帳票のボタンがこの画面を開く
 * (src/components/features/PdfLink.tsx)。上と下に「元の画面に戻る」。印刷・保存は「PDF を開く」(ホーム画面のアプリでは隠す: 戻れなくなるため)
 */
export default async function DocViewPage({ searchParams }: { searchParams: Promise<{ src?: string; returnTo?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await syncDb();
  const src = sp.src ?? "";
  const back = safeReturn(sp.returnTo ?? "", "/");
  const r = await loadDoc(db, user, src, { record: true });
  const pages = r.ok ? Math.min(r.entry.pages, MAX_VIEW_PAGES) : 0;
  const download = `${src}${src.includes("?") ? "&" : "?"}download=1`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MapBackButton href={back} label="元の画面に戻る" />
        <h1 className="flex min-w-0 items-center gap-1.5 text-base font-semibold break-all text-ink">
          <FileText className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          {r.ok ? r.entry.fileName : "帳票"}
        </h1>
      </div>
      {!r.ok ? (
        <Card>
          <p className="text-sm text-critical-ink">{r.error}</p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <a href={src} target="_blank" rel="noopener" className={buttonClass("secondary", "sm", "hide-in-app")}>
              <ExternalLink />
              PDF を開く (印刷)
            </a>
            <a href={download} className={buttonClass("ghost", "sm", "hide-in-app")}>
              <Download />
              保存
            </a>
            <span className="text-[11px] text-ink-3">{r.entry.pages} ページ · 画像を押すと拡大します</span>
          </div>
          <Card>
            <div className="space-y-5" data-testid="doc-view">
              {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
                <MapPageImage key={p} src={`/api/pdf/view-page?src=${encodeURIComponent(src)}&p=${p}`} pdfSrc={src} alt={`${r.entry.fileName} (${p} ページ)`} page={p} pages={pages} failNote="帳票を画像にできなかったため、PDF を表示しています。" />
              ))}
              {r.entry.pages > MAX_VIEW_PAGES && <p className="text-xs text-ink-3">{MAX_VIEW_PAGES} ページまで表示しています。残りは「PDF を開く」で見てください。</p>}
            </div>
          </Card>
        </>
      )}
      <MapBackButton href={back} label="元の画面に戻る" />
    </div>
  );
}
