import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { MAP_USE_PURPOSES, MAP_USE_PURPOSE_LABEL, MAP_USE_PURPOSE_NOTE } from "@/lib/maps/purpose";
import { notFound, redirect } from "next/navigation";
import { ExternalLink, FileText, MapPin, Navigation } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageMaps, canRemoveMapDocument } from "@/lib/auth/permissions";
import { canEditLocation, canEditMapDocument, canViewLocation, canViewMapDocument, canViewRecordMap } from "@/lib/maps/access";
import { BASIS_LABEL, fmtCoord, mapLinkBasis, mapsDirectionsUrl, mapsSearchUrl } from "@/lib/maps/google";
import { mapSearchAddress } from "@/lib/maps/query";
import { PRECISION_LABEL } from "@/lib/maps/address";
import { locationReferences, mapIndex } from "@/lib/maps/resolve";
import { geocodingEnabled, zenrinStatus } from "@/lib/maps/providers";
import { geocodeLocation, linkSharedMapDocument, mergeLocations, removeMapDocument, requestProviderMap, unlinkMapDocument, updateLocationPosition, updateMapDocumentInfo } from "@/lib/actions/maps";
import { safeReturn } from "@/lib/actions/guards";
import { fmtDateTime, toDateKey } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, PageHeader, Select, Textarea, buttonClass } from "@/components/ui";
import { HistoryCard } from "@/components/features/History";
import { MapDocUploader } from "@/components/maps/MapDocUploader";
import { MapPreview } from "@/components/maps/MapViewer";
import { mapViewHref } from "@/lib/maps/links";

export const metadata: Metadata = { title: "場所・住宅地図" };

const STATUS_LABEL = { active: "使用中", replaced: "差し替え済み (前の版)", removed: "取り消し" } as const;

export default async function LocationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string; returnTo?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const loc = db.mapLocations.find((l) => l.id === id);
  if (!loc) notFound();
  if (!canViewLocation(user, db, loc)) redirect("/?err=" + encodeURIComponent("この場所を閲覧する権限がありません。"));
  const back = safeReturn(sp.returnTo ?? "", "");
  const idx = mapIndex(db);
  const self = `/maps/locations/${loc.id}`;
  // 地図の画面から戻るときは、この画面 (と、この画面の戻り先) に戻る
  const selfBack = back ? `${self}?returnTo=${encodeURIComponent(back)}` : self;
  const verified = loc.coordStatus === "verified";
  const target = { address: mapSearchAddress(loc.address) || undefined, lat: loc.lat, lng: loc.lng, coordsVerified: verified, placeId: loc.placeId };
  // 変更できるのは場所を参照する記録の地図を変更できる人だけ (閲覧の範囲の設定で見られるだけの人は見るだけ)
  const canEdit = canEditLocation(user, db, loc) && loc.status === "active";
  const refs = locationReferences(db, loc, { today: toDateKey(new Date()) }, idx).filter((r) => canViewRecordMap(user, db, r.type, r.id));
  const linkedDocIds = new Set(db.mapDocumentLinks.filter((l) => l.locationId === loc.id).map((l) => l.documentId));
  const docs = db.mapDocuments.filter((d) => linkedDocIds.has(d.id)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const active = docs.filter((d) => d.status === "active");
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const town = loc.addressKey.replace(/\d.*$/, "");
  // 近くの場所 (同じ町名) で使っている、共用してよい住宅地図
  const shareCandidates = town
    ? db.mapDocuments.filter((d) => d.status === "active" && d.shareable && !linkedDocIds.has(d.id) && (idx.locationsByDoc.get(d.id) ?? []).some((l) => idx.locations.get(l)?.addressKey.startsWith(town)) && canViewMapDocument(user, db, d)).slice(0, 30)
    : [];
  const dups = loc.precision === "house" ? db.mapLocations.filter((l) => l.id !== loc.id && l.status === "active" && l.addressKey === loc.addressKey) : [];
  const zenrin = zenrinStatus();

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={loc.address || "(住所なし)"}
        badge={<span className="flex flex-wrap gap-1">{loc.status === "merged" && <Badge tone="warn">まとめ済み</Badge>}<Badge tone={loc.precision === "house" ? "info" : "warn"} dot={false}>{PRECISION_LABEL[loc.precision]}</Badge>{verified && <Badge tone="good">位置 確認済み</Badge>}</span>}
        description={`場所 ${loc.id} · 登録 ${users.get(loc.createdBy) ?? "-"} ${fmtDateTime(loc.createdAt)}${loc.source === "batch" ? " (一括の正規化)" : ""} · この場所を使う記録すべてに同じ地図・住宅地図が表示されます`}
        back={back ? { href: back, label: "元の画面" } : canManageMaps(user) ? { href: "/maps", label: "地図・住宅地図" } : undefined}
      />
      {loc.status === "merged" && loc.mergedInto && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="この場所は別の場所にまとめられています" description="重複していたため、住宅地図と結び付けをまとめ先へ移しました。この記録は履歴として残しています" action={<Link href={`/maps/locations/${loc.mergedInto}`} className="text-xs font-medium text-accent hover:underline">まとめ先を開く</Link>} />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <Card>
          <CardHeader title="Google マップ・位置" icon={<MapPin />} description={`位置の決め方: ${BASIS_LABEL[mapLinkBasis(target)]}`} />
          <div className="flex flex-wrap gap-2">
            {mapsSearchUrl(target) && (
              <a href={mapsSearchUrl(target)} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                <MapPin />地図で開く<ExternalLink className="h-3 w-3" />
              </a>
            )}
            {mapsDirectionsUrl(target) && (
              <a href={mapsDirectionsUrl(target)} target="_blank" rel="noreferrer" className={buttonClass("primary", "sm")}>
                <Navigation />経路案内<ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">緯度・経度</dt>
            <dd className="tnum text-ink">{loc.lat != null && loc.lng != null ? `${fmtCoord(loc.lat)}, ${fmtCoord(loc.lng)}` : "未登録"}</dd>
            <dt className="text-ink-3">位置の確認</dt>
            <dd className="text-ink">{loc.coordStatus === "verified" ? `確認済み (${users.get(loc.coordVerifiedBy ?? "") ?? "-"} ${fmtDateTime(loc.coordVerifiedAt)})` : loc.coordStatus === "needs_review" ? "要確認 (候補が複数・おおよその位置)" : loc.coordStatus === "unverified" ? "未確認" : "-"}</dd>
            <dt className="text-ink-3">Google の場所 ID</dt>
            <dd className="break-all text-ink">{loc.placeId ?? "-"}</dd>
            {loc.geocodeNote && (<><dt className="text-ink-3">自動の結果</dt><dd className="text-ink-2">{loc.geocodeNote}</dd></>)}
          </dl>
          {canEdit && (
            <form action={updateLocationPosition.bind(null, loc.id)} className="mt-4 space-y-2 border-t border-line pt-3">
              <Field label="位置 (緯度, 経度 または Google マップの URL)" hint="Google マップで正しい建物を長押し (パソコンは右クリック) して出る数字か、その場所を開いたときの URL を貼り付けます。住所が完全でも位置がずれることがあるので、地図で確かめてください">
                <Input name="coords" placeholder="32.8031, 130.7079" defaultValue={loc.lat != null && loc.lng != null ? `${fmtCoord(loc.lat)}, ${fmtCoord(loc.lng)}` : ""} />
              </Field>
              <Field label="Google の場所 ID (任意)"><Input name="placeId" defaultValue={loc.placeId ?? ""} placeholder="ChIJ…" /></Field>
              <Field label="現地のメモ (任意)"><Textarea name="note" defaultValue={loc.note ?? ""} maxLength={500} placeholder="例: 駐車場は裏。入口は北側" /></Field>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="verified" value="1" defaultChecked={verified} /> 地図で確かめた (この位置で確定。リンクは緯度経度で開きます)</label>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm">保存する</Button>
                {loc.lat != null && <Button type="submit" name="clearCoords" value="1" variant="ghost" size="sm">位置を消す</Button>}
              </div>
            </form>
          )}
          {canEdit && !verified && (
            geocodingEnabled() ? (
              <form action={geocodeLocation.bind(null, loc.id)} className="mt-3"><Button type="submit" variant="secondary" size="sm">住所から位置を求める (Google)</Button></form>
            ) : (
              <p className="mt-3 text-[11px] text-ink-3">住所から位置を自動で求める機能は設定されていません (GOOGLE_MAPS_API_KEY)。上の欄に手で入力してください。</p>
            )
          )}
        </Card>

        <Card>
          <CardHeader title="住宅地図 (PDF)" icon={<FileText />} description={active.length ? `使用中 ${active.length} 件` : "未登録"} />
          {active.length === 0 && <Badge tone="warn">住宅地図 未登録</Badge>}
          {!canEdit && loc.status === "active" && <p className="mb-2 text-[11px] text-ink-3">見るだけの権限です。住宅地図の登録・差し替えと位置の修正は、この場所の記録を変更できる人 (その店舗の社員・店長・本部・管理者) が行います。</p>}
          <div className="space-y-3">
            {active.map((d) => {
              const shared = (idx.locationsByDoc.get(d.id) ?? []).length - 1;
              const editDoc = canEditMapDocument(user, db, d);
              const removable = shared === 0 && canRemoveMapDocument(user, d);
              return (
                <div key={d.id} className="space-y-2 rounded-xl border border-line p-3 text-xs">
                  <div className="font-medium text-ink">{d.title}</div>
                  <div className="text-ink-3">{d.provider === "zenrin" ? "ゼンリン 住宅地図" : "その他の地図"}{d.edition ? ` · ${d.edition}` : ""} · {d.pageCount ?? "-"} ページ · 登録 {users.get(d.uploadedBy) ?? "-"} {fmtDateTime(d.uploadedAt)}{d.source === "bulk_import" ? " (一括取込)" : ""}{shared > 0 ? ` · ほか ${shared} か所で共用` : ""}</div>
                  <div className="text-ink-2">{d.copyrightNotice}</div>
                  {d.usePurpose && <div className="rounded-lg bg-subtle/70 px-2 py-1 text-ink-2"><span className="font-medium">用途: {MAP_USE_PURPOSE_LABEL[d.usePurpose]}{d.nameplate ? " · 表札の情報あり" : ""}</span> — {MAP_USE_PURPOSE_NOTE[d.usePurpose]}</div>}
                  <div className="text-ink-3">許諾の確認: {users.get(d.licenseConfirmedBy) ?? "-"} {fmtDateTime(d.licenseConfirmedAt)}{d.licenseRef ? ` · ${d.licenseRef}` : ""}</div>
                  <div className="flex flex-wrap items-start gap-2">
                    <Link href={mapViewHref(d.id, selfBack)} className={buttonClass("primary", "sm")}>地図を開く</Link>
                    <a href={`/api/maps/documents/${d.id}?download=1`} className={buttonClass("ghost", "sm")}>ダウンロード</a>
                    <MapPreview src={`/api/maps/documents/${d.id}/page?p=1&size=preview`} href={mapViewHref(d.id, selfBack)} title={d.title} />
                    {canEdit && <MapDocUploader targetType="location" targetId={loc.id} replaceId={d.id} replaceLabel={d.title} defaultShareable={d.shareable} compact />}
                    {canEdit && shared > 0 && (
                      <form action={unlinkMapDocument.bind(null, d.id, loc.id)}><input type="hidden" name="returnTo" value={self} /><Button type="submit" variant="ghost" size="sm">この場所から外す</Button></form>
                    )}
                  </div>
                  {(editDoc || removable) && (
                  <details>
                    <summary className="cursor-pointer text-accent">{editDoc ? "情報の修正・取り消し" : "取り消し"}</summary>
                    {editDoc && (
                    <form action={updateMapDocumentInfo.bind(null, d.id)} className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-2">
                      <input type="hidden" name="returnTo" value={self} />
                      <Field label="表示名"><Input name="title" defaultValue={d.title} maxLength={120} /></Field>
                      <Field label="版・発行年"><Input name="edition" defaultValue={d.edition ?? ""} maxLength={60} /></Field>
                      <Field label="著作権表示"><Input name="copyrightNotice" defaultValue={d.copyrightNotice} maxLength={200} /></Field>
                      <Field label="契約・許諾の番号"><Input name="licenseRef" defaultValue={d.licenseRef ?? ""} maxLength={100} /></Field>
                      <Field label="許諾のメモ" className="@xl:col-span-2"><Input name="licenseNote" defaultValue={d.licenseNote ?? ""} maxLength={500} /></Field>
                      <Field label="出力したときの用途">
                        <select name="usePurpose" defaultValue={d.usePurpose ?? ""} className="field">
                          <option value="">(未設定)</option>
                          {MAP_USE_PURPOSES.map((p) => <option key={p} value={p}>{MAP_USE_PURPOSE_LABEL[p]}</option>)}
                        </select>
                      </Field>
                      <label className="flex items-end gap-2 pb-2"><input type="checkbox" name="nameplate" value="1" defaultChecked={d.nameplate} /> 表札 (居住者名) の情報を含む</label>
                      <label className="flex items-center gap-2 @xl:col-span-2"><input type="checkbox" name="shareable" value="1" defaultChecked={d.shareable} /> 複数の場所で共用してよい</label>
                      <div><Button type="submit" size="sm" variant="secondary">修正する</Button></div>
                    </form>
                    )}
                    {removable && (
                      <form action={removeMapDocument.bind(null, d.id)} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-2">
                        <input type="hidden" name="returnTo" value={self} />
                        <Field label="取り消しの理由"><Input name="reason" required maxLength={200} placeholder="例: 契約の期限切れ" /></Field>
                        <Button type="submit" variant="danger" size="sm">取り消す (台帳と履歴は残ります)</Button>
                      </form>
                    )}
                  </details>
                  )}
                </div>
              );
            })}
            {canEdit && active.length === 0 && <MapDocUploader targetType="location" targetId={loc.id} />}
            {canEdit && shareCandidates.length > 0 && (
              <form action={linkSharedMapDocument.bind(null, loc.id)} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <input type="hidden" name="returnTo" value={self} />
                <Field label="近くの場所の住宅地図を使う (共用してよい PDF)">
                  <Select name="documentId" required>
                    {shareCandidates.map((d) => <option key={d.id} value={d.id}>{d.title}{d.edition ? ` (${d.edition})` : ""}</option>)}
                  </Select>
                </Field>
                <Button type="submit" variant="secondary" size="sm">結び付ける</Button>
              </form>
            )}
            <form action={requestProviderMap.bind(null, loc.id)} className="border-t border-line pt-3 text-[11px] text-ink-3">
              <p>ゼンリンからの自動取得: {zenrin.enabled ? "使えます" : `使えません — ${zenrin.reasons.join(" / ")}`}</p>
              {zenrin.enabled && canEdit && <Button type="submit" variant="secondary" size="sm" className="mt-1">ゼンリンから取得する</Button>}
            </form>
          </div>
          {docs.some((d) => d.status !== "active") && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-1 text-xs font-semibold text-ink-2">これまでの住宅地図 (差し替え前・取り消し)</h3>
              <ul className="space-y-1 text-[11px] text-ink-2">
                {docs.filter((d) => d.status !== "active").map((d) => (
                  <li key={d.id}>
                    <Badge dot={false}>{STATUS_LABEL[d.status]}</Badge> {d.title} · 登録 {users.get(d.uploadedBy) ?? "-"} {fmtDateTime(d.uploadedAt)}{d.removedAt ? ` · 取り消し ${users.get(d.removedBy ?? "") ?? "-"} ${fmtDateTime(d.removedAt)} (${d.removeReason ?? ""})` : ""} · {d.copyrightNotice}
                    {d.status === "replaced" && d.storageKey && <> · <Link href={mapViewHref(d.id, selfBack)} className="text-accent hover:underline">開く</Link></>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="この場所を使う記録" description="同じ番地の顧客・見積・受注と、この場所の今後の予定 (見られる店舗の分だけ表示)。位置・住宅地図の変更はすべてに反映されます" />
          {refs.length === 0 ? <p className="text-xs text-ink-3">見られる記録はありません。</p> : (
            <ul className="space-y-1 text-xs">
              {refs.slice(0, 100).map((r) => <li key={`${r.type}:${r.id}`}><Link href={r.href} className="text-accent hover:underline">{r.label}</Link> <span className="text-ink-3">{db.stores.find((s) => s.id === r.storeId)?.shortName}</span></li>)}
              {refs.length > 100 && <li className="text-ink-3">ほか {refs.length - 100} 件</li>}
            </ul>
          )}
        </Card>

        {canManageMaps(user) && dups.length > 0 && loc.status === "active" && (
          <Card className="border-warn/40 bg-warn-soft/30">
            <CardHeader title="同じ番地の場所が重複しています" description="まとめると住宅地図と結び付けがまとめ先へ移ります。元の場所は「まとめ済み」として残ります (データは消しません)" />
            <form action={mergeLocations.bind(null, loc.id)} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="returnTo" value={self} />
              <Field label="この場所を次の場所にまとめる">
                <Select name="targetId" required>
                  {dups.map((d) => <option key={d.id} value={d.id}>{d.address} ({d.id} · 住宅地図 {(idx.docsByLocation.get(d.id) ?? []).length} 件)</option>)}
                </Select>
              </Field>
              <Button type="submit" variant="secondary" size="sm">まとめる</Button>
            </form>
          </Card>
        )}
      </div>
      <div className="mt-4">
        <HistoryCard db={db} user={user} targets={[{ entity: "map_location", id: loc.id }, ...docs.map((d) => ({ entity: "map_document", id: d.id }))]} description="場所の位置・住宅地図の登録・差し替え・取り消し・閲覧の記録" />
      </div>
    </div>
  );
}
