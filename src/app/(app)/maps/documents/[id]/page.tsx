import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { Download, ExternalLink, FileText, MapPin } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageMaps } from "@/lib/auth/permissions";
import { canViewLocation, canViewMapDocument } from "@/lib/maps/access";
import { mapIndex } from "@/lib/maps/resolve";
import { MAX_RENDER_PAGES } from "@/lib/maps/render";
import { MAP_USE_PURPOSE_LABEL, MAP_USE_PURPOSE_NOTE } from "@/lib/maps/purpose";
import { safeReturn } from "@/lib/actions/guards";
import { fmtDateTime } from "@/lib/format";
import { Badge, Card, Flash, buttonClass } from "@/components/ui";
import { MapBackButton, MapPageImage } from "@/components/maps/MapViewer";

export const metadata: Metadata = { title: "住宅地図" };

/**
 * 住宅地図を見る画面 (お客様のご要望 2026-11-24「① 登録済みPDF地図の表示」: 地図を見たあと元の案件の画面に簡単に戻れるように)
 * PDF をそのまま開かず、システムの画面の中に地図の画像を出す (src/lib/maps/render.ts)。上と下に「元の画面に戻る」。
 * 戻り先は returnTo (顧客・見積・受注・予定の画面、予定表の小さな画面)。なければ場所の画面
 */
export default async function MapDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ returnTo?: string; msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const doc = db.mapDocuments.find((d) => d.id === id);
  if (!doc) notFound();
  const fallback = canManageMaps(user) ? "/maps" : "/";
  if (!canViewMapDocument(user, db, doc)) redirect(`${safeReturn(sp.returnTo ?? "", fallback)}${(sp.returnTo ?? "").includes("?") ? "&" : "?"}err=${encodeURIComponent("この住宅地図を表示する権限がありません。")}`);
  const idx = mapIndex(db);
  const locations = (idx.locationsByDoc.get(doc.id) ?? []).map((l) => idx.locations.get(l)).filter((l) => l && canViewLocation(user, db, l)).map((l) => l!);
  const back = safeReturn(sp.returnTo ?? "", locations[0] ? `/maps/locations/${locations[0].id}` : fallback);
  const backLabel = sp.returnTo ? "元の画面に戻る" : locations[0] ? "場所の画面に戻る" : "戻る";
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const pages = Math.min(MAX_RENDER_PAGES, Math.max(1, doc.pageCount ?? 1));
  const pdf = `/api/maps/documents/${doc.id}`;
  const removed = doc.status === "removed" || !doc.storageKey;

  return (
    <div className="space-y-3">
      <Flash msg={sp.msg} err={sp.err} />
      <div className="flex flex-wrap items-center gap-2">
        <MapBackButton href={back} label={backLabel} />
        <h1 className="flex min-w-0 items-center gap-1.5 text-base font-semibold break-all text-ink">
          <FileText className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          {doc.title || doc.fileName}
        </h1>
        {doc.status === "replaced" && <Badge tone="warn">差し替え前の版</Badge>}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-3">
        {doc.provider === "zenrin" ? "ゼンリン 住宅地図" : "その他の地図"}
        {doc.edition ? ` · ${doc.edition}` : ""} · {doc.pageCount ?? "-"} ページ · 登録 {users.get(doc.uploadedBy) ?? "-"} {fmtDateTime(doc.uploadedAt)}
        {locations.length ? ` · 場所: ${locations.map((l) => l.address).slice(0, 3).join("・")}${locations.length > 3 ? ` ほか ${locations.length - 3} か所` : ""}` : ""}
      </p>
      {doc.usePurpose && (
        <p className="rounded-lg bg-subtle/70 px-2 py-1 text-[11px] leading-relaxed text-ink-2">
          <span className="font-medium">用途: {MAP_USE_PURPOSE_LABEL[doc.usePurpose]}{doc.nameplate ? " · 表札の情報あり" : ""}</span> — {MAP_USE_PURPOSE_NOTE[doc.usePurpose]}
        </p>
      )}

      {removed ? (
        <Card>
          <p className="text-sm text-ink-2">この住宅地図は取り消されています (ファイルの本体は削除済みです)。</p>
        </Card>
      ) : (
        <Card>
          <div className="space-y-5">
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <MapPageImage key={p} src={`/api/maps/documents/${doc.id}/page?p=${p}&size=view`} pdfSrc={pdf} alt={`${doc.title || doc.fileName} (${p} ページ)`} page={p} pages={pages} />
            ))}
            {(doc.pageCount ?? 1) > MAX_RENDER_PAGES && <p className="text-xs text-ink-3">{MAX_RENDER_PAGES} ページまで表示しています。残りのページは「ダウンロード」で見てください。</p>}
          </div>
          <p className="mt-3 text-[11px] text-ink-2">{doc.copyrightNotice}</p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <MapBackButton href={back} label={backLabel} />
        {!removed && (
          <>
            <a href={`${pdf}?download=1`} className={buttonClass("secondary", "sm")}>
              <Download />
              ダウンロード (印刷用の PDF)
            </a>
            {/* ホーム画面のアプリでは出さない (PDF の画面には戻るボタンがないため) */}
            <a href={pdf} target="_blank" rel="noreferrer" className={buttonClass("ghost", "sm", "hide-in-app")}>
              PDF を別のタブで開く
              <ExternalLink className="h-3 w-3" />
            </a>
          </>
        )}
        {locations[0] && sp.returnTo && (
          <Link href={`/maps/locations/${locations[0].id}?returnTo=${encodeURIComponent(sp.returnTo)}`} className={buttonClass("ghost", "sm")}>
            <MapPin />
            場所の詳細
          </Link>
        )}
      </div>
    </div>
  );
}
