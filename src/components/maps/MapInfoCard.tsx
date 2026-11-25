import Link from "@/components/ui/Link";
import { Download, ExternalLink, FileText, Map as MapIcon, MapPin, Navigation, TriangleAlert } from "lucide-react";
import type { Database, MapDocument, MapRefType, User } from "@/lib/db/types";
import { canRemoveMapDocument, canSeeAllStores } from "@/lib/auth/permissions";
import { canEditRecordMap, canViewRecordMap } from "@/lib/maps/access";
import { BASIS_LABEL } from "@/lib/maps/google";
import { mapIndex, placeOf, type ResolvedPlace } from "@/lib/maps/resolve";
import { zenrinStatus } from "@/lib/maps/providers";
import { applyCustomerAddressToSite, followCaseLocation, linkRecordToLocation, openPlace, removeMapDocument, unlinkMapDocument } from "@/lib/actions/maps";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, buttonClass } from "@/components/ui";
import { MapDocUploader } from "./MapDocUploader";
import { MapPreview } from "./MapViewer";
import { mapViewHref } from "@/lib/maps/links";
import { CopyAddress } from "./CopyAddress";
import { MAP_USE_PURPOSE_LABEL, MAP_USE_PURPOSE_NOTE, ZENRIN_GIS } from "@/lib/maps/purpose";

/**
 * 地図・住宅地図のカード (顧客・見積・受注・予定の画面で共通)
 * ------------------------------------------------------------
 * 左: Google マップ (地図で開く・経路案内)、右: 住宅地図の PDF (プレビュー・ダウンロード・差し替え)。
 * 場所は src/lib/maps/resolve.ts で決める (施工場所 > お客様の住所。施工場所の地図がないときに、お客様の住所の地図を出さない)
 */

const COORD_BADGE: Record<string, { tone: "good" | "warn" | "neutral"; label: string }> = {
  verified: { tone: "good", label: "位置 確認済み" },
  needs_review: { tone: "warn", label: "位置 要確認" },
  unverified: { tone: "neutral", label: "位置 未確認" },
};

function fmtSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function MapInfoCard({ db, user, target, returnTo, title = "地図・住宅地図" }: { db: Database; user: User; target: { type: MapRefType; id: string }; returnTo: string; title?: string }) {
  if (!canViewRecordMap(user, db, target.type, target.id)) {
    return (
      <Card>
        <CardHeader title={title} icon={<MapPin />} description="地図と住宅地図は、この記録の店舗のメンバーと予定の担当者だけが見られます" />
      </Card>
    );
  }
  const idx = mapIndex(db);
  const place = placeOf(db, target.type, target.id, idx);
  if (!place) return null;
  const canEdit = canEditRecordMap(user, db, target.type, target.id);
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const zenrin = zenrinStatus();
  return (
    <Card id="map">
      <CardHeader
        title={title}
        icon={<MapPin />}
        description={place.origin}
        action={
          place.location ? (
            <Link href={`/maps/locations/${place.location.id}?returnTo=${encodeURIComponent(returnTo)}`} className="text-xs font-medium text-accent hover:underline">
              場所の詳細・位置の修正
            </Link>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <GoogleSide place={place} target={target} returnTo={returnTo} canEdit={canEdit} candidates={canEdit && place.norm.precision === "area" && !place.location && place.norm.town ? nearby(db, user, place.norm.key) : []} />
        <section className="min-w-0 space-y-2" aria-label="住宅地図">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
            <FileText className="h-3.5 w-3.5" aria-hidden />
            住宅地図
          </h3>
          {place.documents.length === 0 ? (
            <div className="space-y-2">
              <Badge tone="warn">住宅地図 未登録{place.role === "site" && !place.sameAsCustomer ? " (施工場所)" : ""}</Badge>
              {place.missingNote && <p className="text-xs leading-relaxed text-ink-2">{place.missingNote}</p>}
              {canEdit && place.addressText ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <a href={ZENRIN_GIS.url} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                      <MapPin />
                      {ZENRIN_GIS.label} で探す
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <CopyAddress text={place.addressText} />
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-3">ゼンリン GIS にログイン → 住所を貼り付けて地点検索 →「印刷」で PDF、または「画像出力」で地図の画像をコピー → この画面に戻って下の欄で登録 (画像は Ctrl+V で貼り付け)。</p>
                  <MapDocUploader targetType={target.type} targetId={target.id} compact />
                </>
              ) : !place.addressText ? (
                <p className="text-xs text-ink-3">住所が登録されていないため、住宅地図を登録できません。</p>
              ) : null}
            </div>
          ) : (
            place.documents.map((d) => <DocumentRow key={d.id} doc={d} place={place} target={target} returnTo={returnTo} canEdit={canEdit} canRemove={canRemoveMapDocument(user, d)} sharedWith={(idx.locationsByDoc.get(d.id) ?? []).length - 1} uploader={users.get(d.uploadedBy) ?? "-"} />)
          )}
          <p className="text-[11px] leading-relaxed text-ink-3">
            ゼンリンからの自動取得: {zenrin.enabled ? "接続済み" : "なし (ゼンリン GIS は画面で操作するサービスで、自動取得の API がないため)"}。ゼンリン GIS で出力した地図 (PDF・画像) を登録してください。
          </p>
        </section>
      </div>
    </Card>
  );
}

/** 番地のない住所の記録を結び付ける候補 (同じ町名の登録済みの場所。見られる店舗の場所だけ) */
function nearby(db: Database, user: User, areaKey: string) {
  if (!areaKey) return [];
  return db.mapLocations
    .filter((l) => l.status === "active" && l.addressKey.startsWith(areaKey) && l.addressKey !== areaKey && (canSeeAllStores(user) || l.storeId === user.storeId))
    .slice(0, 30)
    .map((l) => ({ id: l.id, address: l.address }));
}

function GoogleSide({ place, target, returnTo, canEdit, candidates }: { place: ResolvedPlace; target: { type: MapRefType; id: string }; returnTo: string; canEdit: boolean; candidates: { id: string; address: string }[] }) {
  const loc = place.location;
  const coord = loc?.coordStatus ? COORD_BADGE[loc.coordStatus] : undefined;
  return (
    <section className="min-w-0 space-y-2" aria-label="Google マップ">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
        <MapPin className="h-3.5 w-3.5" aria-hidden />
        {place.heading} · Google マップ
      </h3>
      <p className="text-sm break-words text-ink">{place.addressText || <span className="text-ink-3">住所の登録なし</span>}</p>
      <div className="flex flex-wrap gap-1">
        {place.norm.precision !== "house" && place.addressText && <Badge tone="warn">番地なし・位置は要確認</Badge>}
        {coord && <Badge tone={coord.tone}>{coord.label}</Badge>}
        {place.sameAsCustomer && place.role !== "customer" && <Badge tone="info" dot={false}>お客様の住所と同じ</Badge>}
        {place.sameAsCustomer === false && <Badge tone="accent" dot={false}>お客様の住所と別の場所</Badge>}
      </div>
      {place.searchUrl ? (
        <div className="flex flex-wrap gap-2">
          <a href={place.searchUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
            <MapPin />
            地図で開く
            <ExternalLink className="h-3 w-3" />
          </a>
          {place.directionsUrl && (
            <a href={place.directionsUrl} target="_blank" rel="noreferrer" className={buttonClass("primary", "sm")}>
              <Navigation />
              経路案内
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      ) : null}
      {place.addressText && <p className="text-[11px] text-ink-3">位置の決め方: {BASIS_LABEL[place.basis]}</p>}
      {place.customerAddress && place.sameAsCustomer === false && <p className="text-[11px] text-ink-3">お客様の住所: {place.customerAddress}</p>}
      {loc?.note && <p className="rounded-lg bg-subtle/70 px-2 py-1 text-xs text-ink-2">現地のメモ: {loc.note}</p>}
      {place.warnings.length > 0 && (
        <ul className="space-y-1">
          {place.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-xs text-warn-ink">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}
      {canEdit &&
        place.suggestions.map((s) =>
          s.kind === "use_customer_address" ? (
            <form key={s.kind} action={applyCustomerAddressToSite.bind(null, s.orderId)} className="rounded-lg border border-accent/20 bg-accent-soft/50 p-2 text-xs text-accent-ink">
              <input type="hidden" name="returnTo" value={returnTo} />
              施工場所「{place.addressText}」はお客様の住所 ({s.address}) と同じ地区です。同じ場所なら施工場所をお客様の住所にできます (自動では変えません)。
              <Button type="submit" variant="soft" size="sm" className="mt-1.5">施工場所をお客様の住所にする</Button>
            </form>
          ) : (
            <form key={s.kind} action={followCaseLocation.bind(null, s.eventId)} className="rounded-lg border border-accent/20 bg-accent-soft/50 p-2 text-xs text-accent-ink">
              <input type="hidden" name="returnTo" value={returnTo} />
              この予定の場所は案件・お客様の住所 ({s.address}) と違います。同じ場所なら合わせられます (自動では変えません)。
              <Button type="submit" variant="soft" size="sm" className="mt-1.5">案件・お客様の場所に合わせる</Button>
            </form>
          ),
        )}
      {candidates.length > 0 && (
        <form action={linkRecordToLocation.bind(null, place.record.type, place.record.id)} className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2 text-xs">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="min-w-0 flex-1">
            <span className="label">番地を確かめたら、登録済みの場所に結び付けられます (自動では結び付けません)</span>
            <select name="locationId" className="field mt-1" required>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.address}</option>)}
            </select>
          </label>
          <Button type="submit" variant="secondary" size="sm">この場所に結び付ける</Button>
        </form>
      )}
      {canEdit && !loc && place.addressText && (
        <form action={openPlace.bind(null, target.type, target.id)}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <Button type="submit" variant="ghost" size="sm">位置を確認・修正する</Button>
        </form>
      )}
    </section>
  );
}

function DocumentRow({ doc, place, target, returnTo, canEdit, canRemove, sharedWith, uploader }: { doc: MapDocument; place: ResolvedPlace; target: { type: MapRefType; id: string }; returnTo: string; canEdit: boolean; canRemove: boolean; sharedWith: number; uploader: string }) {
  const src = `/api/maps/documents/${doc.id}`;
  const view = mapViewHref(doc.id, `${returnTo}#map`);
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="good">登録済み</Badge>
        <span className="text-sm font-medium break-all text-ink">{doc.title}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-3">
        {doc.provider === "zenrin" ? "ゼンリン 住宅地図" : "その他の地図"}
        {doc.edition ? ` · ${doc.edition}` : ""} · {doc.pageCount ?? "-"} ページ · {fmtSize(doc.size)} · 登録 {uploader} {fmtDateTime(doc.uploadedAt)}
        {sharedWith > 0 ? ` · ほか ${sharedWith} か所で共用` : ""}
        {place.sameAsCustomer && place.role !== "customer" ? " · お客様の住所と同じ場所の地図" : ""}
      </p>
      <p className="text-[11px] text-ink-2">{doc.copyrightNotice}</p>
      {doc.usePurpose && (
        <p className="rounded-lg bg-subtle/70 px-2 py-1 text-[11px] leading-relaxed text-ink-2">
          <span className="font-medium">用途: {MAP_USE_PURPOSE_LABEL[doc.usePurpose]}{doc.nameplate ? " · 表札の情報あり" : ""}</span> — {MAP_USE_PURPOSE_NOTE[doc.usePurpose]}
        </p>
      )}
      {doc.licenseRef && <p className="text-[11px] text-ink-3">許諾: {doc.licenseRef}</p>}
      {/* 地図はシステムの画面の中で開く (PDF をそのまま開くと、アプリ・スマートフォンで元の画面に戻れなくなるため) */}
      <div className="flex flex-wrap items-start gap-2">
        <Link href={view} className={buttonClass("primary", "sm")}>
          <MapIcon />
          地図を開く
        </Link>
        <a href={`${src}?download=1`} className={buttonClass("ghost", "sm")}>
          <Download />
          ダウンロード
        </a>
        <MapPreview src={`${src}/page?p=1&size=preview`} href={view} title={doc.title} />
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-start gap-2 border-t border-line pt-2">
          <MapDocUploader targetType={target.type} targetId={target.id} replaceId={doc.id} replaceLabel={doc.title} defaultShareable={doc.shareable} compact />
          {sharedWith > 0 && place.location && (
            <form action={unlinkMapDocument.bind(null, doc.id, place.location.id)}>
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" variant="ghost" size="sm">この場所から外す</Button>
            </form>
          )}
          {sharedWith === 0 && canRemove && (
            <details className="text-xs">
              <summary className="cursor-pointer py-1.5 text-critical-ink">取り消す</summary>
              <form action={removeMapDocument.bind(null, doc.id)} className="mt-1 flex flex-wrap items-end gap-2">
                <input type="hidden" name="returnTo" value={returnTo} />
                <input name="reason" required maxLength={200} placeholder="理由 (例: 契約の期限切れ)" className="field h-8 w-56 text-xs" />
                <Button type="submit" variant="danger" size="sm">取り消す (履歴は残ります)</Button>
              </form>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
