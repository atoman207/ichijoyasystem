import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { canDeleteTidyCheck, canEditTidyCheck, canViewTidyCheck } from "@/lib/auth/permissions";
import { TIDY_MAX_PHOTOS, TIDY_RESULT, fmtScore, scoreTone } from "@/lib/tidy";
import { addLinePhotosToTidy, deleteTidyCheck, deleteTidyPhoto, setTidyFollowUp, updateTidyCheck } from "@/lib/actions/tidy";
import { pendingLinePhotos } from "@/lib/line-photos";
import { tidyPhotoUrl } from "@/lib/tidy-photos";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { TidyForm } from "@/components/tidy/TidyForm";
import { LinePhotoChecks } from "@/components/case-posts/CasePostParts";
import { AttachmentUploader } from "@/components/attachments/AttachmentUploader";
import { Badge, Button, Card, CardHeader, Flash, LinkButton, Note, PageHeader, StoreTag } from "@/components/ui";

export const metadata: Metadata = { title: "整理整頓チェック" };

export default async function TidyCheckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const c = (db.tidyChecks ?? []).find((x) => x.id === id);
  if (!c) notFound();
  if (!canViewTidyCheck(user, c)) redirect(`/kpi/tidy?err=${encodeURIComponent("このチェックを見る権限がありません。")}`);
  const store = db.stores.find((s) => s.id === c.storeId);
  const canEdit = canEditTidyCheck(user, c);
  const today = toDateKey(new Date());
  const groups = [...new Set(c.items.map((i) => i.group ?? ""))];
  const ng = c.items.filter((i) => i.result === "ng");
  const linePhotos = canEdit ? pendingLinePhotos(db, user, "tidy", c.storeId) : [];

  if (sp.edit === "1" && canEdit) {
    return (
      <div>
        <Flash msg={sp.msg} err={sp.err} />
        <PageHeader title={`${c.number} を直す`} description="結果・メモ・期限を直して保存します。要改善の「直した」の記録は、同じ項目が要改善のままなら残ります" back={{ href: `/kpi/tidy/${c.id}`, label: "チェックの画面" }} />
        <TidyForm db={db} user={user} action={updateTidyCheck.bind(null, c.id)} check={c} submitLabel="保存する" />
      </div>
    );
  }

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={`整理整頓チェック ${c.number}`}
        badge={<Badge tone={scoreTone(c.score)}>{fmtScore(c.score)}</Badge>}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StoreTag store={store} /> · {fmtDate(c.date)}{c.place ? ` · ${c.place}` : ""} · チェック {userName(c.checkedBy)} · 良い {c.okCount} · 要改善 {c.ngCount} · 対象外 {c.naCount}{c.provisional ? " · 暫定の項目で記録" : ""}</span>}
        back={{ href: "/kpi/tidy", label: "整理整頓" }}
        actions={canEdit ? <LinkButton href={`/kpi/tidy/${c.id}?edit=1`} size="sm" variant="secondary">直す</LinkButton> : undefined}
      />
      {c.comment && <Note>{c.comment}</Note>}
      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          {groups.map((g) => (
            <Card key={g || "_"} padded={false}>
              <div className="px-5 pt-4"><CardHeader title={g || "項目"} className="mb-2" /></div>
              <ul className="divide-y divide-line">
                {c.items.filter((i) => (i.group ?? "") === g).map((i) => (
                  <li key={i.key} className="flex flex-wrap items-start gap-2 px-5 py-2.5 text-sm">
                    <Badge tone={TIDY_RESULT[i.result].tone}>{TIDY_RESULT[i.result].label}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-ink">{i.label}</div>
                      {i.note && <div className="text-xs text-ink-2">{i.note}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}

          <Card id="photos">
            <CardHeader title={`写真 (${c.photos.length} 枚)`} description={`1 つのチェックに ${TIDY_MAX_PHOTOS} 枚まで。写真を押すと大きく開きます`} />
            <div className="space-y-3">
              {canEdit && c.photos.length < TIDY_MAX_PHOTOS && <AttachmentUploader parentType="tidy" parentId={c.id} accept="image/*" endpoint="/api/tidy/photos" note="写真は自動で縮小して送ります (撮影日時・登録者を記録)。1 回に 20 枚まで選べます。" />}
              {c.photos.length > 0 ? (
                <ul className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
                  {c.photos.map((p) => (
                    <li key={p.id} className="overflow-hidden rounded-xl border border-line bg-subtle">
                      <a href={tidyPhotoUrl(c.id, p.id)} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={tidyPhotoUrl(c.id, p.id, Boolean(p.thumbKey))} alt={p.caption || p.fileName} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                      </a>
                      <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-ink-3">
                        <span className="min-w-0 flex-1 truncate">{p.caption || fmtDateTime(p.takenAt ?? p.uploadedAt)}</span>
                        {(p.uploadedBy === user.id || canDeleteTidyCheck(user, c)) && (
                          <form action={deleteTidyPhoto.bind(null, c.id, p.id)}><button type="submit" className="text-critical-ink hover:underline">削除</button></form>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-3">まだ写真はありません。</p>
              )}
            </div>
          </Card>

          {linePhotos.length > 0 && (
            <Card>
              <CardHeader title={`LINE の「整理整頓の確認」グループの写真 (${linePhotos.length} 枚)`} description="まだチェックに付けていない写真です。選んでこのチェックに付けます" />
              <form action={addLinePhotosToTidy.bind(null, c.id)} className="space-y-3">
                <LinePhotoChecks items={linePhotos.slice(0, 60)} name="lineRefs" stores={db.stores} />
                <Button type="submit" size="sm" variant="secondary">選んだ写真をこのチェックに付ける</Button>
              </form>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card id="followups">
            <CardHeader title={`要改善の対応 (${ng.length} 件)`} description="直したら「直した」を押します。直すまで KPI → 整理整頓 の一覧に残ります" />
            {ng.length === 0 ? (
              <p className="text-xs text-ink-3">要改善の項目はありません。</p>
            ) : (
              <ul className="space-y-3">
                {ng.map((i) => {
                  const overdue = i.fixStatus !== "fixed" && Boolean(i.dueDate && i.dueDate < today);
                  return (
                    <li key={i.key} className="rounded-xl border border-line p-3 text-xs">
                      <div className="text-sm text-ink">{i.label}</div>
                      {i.note && <div className="text-ink-2">{i.note}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {i.fixStatus === "fixed" ? <Badge tone="good">直した {i.fixedAt ? fmtDate(i.fixedAt.slice(0, 10)) : ""}</Badge> : <Badge tone={overdue ? "critical" : "warn"}>{overdue ? "期限切れ" : "未対応"}</Badge>}
                        {i.dueDate && <span className="text-ink-3">期限 {fmtDate(i.dueDate)}</span>}
                        {i.fixedBy && <span className="text-ink-3">({userName(i.fixedBy)})</span>}
                      </div>
                      {i.fixNote && <div className="mt-1 text-ink-2">対応: {i.fixNote}</div>}
                      {canEdit && (
                        <div className="mt-2 space-y-1.5">
                          {i.fixStatus === "fixed" ? (
                            <form action={setTidyFollowUp.bind(null, c.id)}>
                              <input type="hidden" name="key" value={i.key} />
                              <input type="hidden" name="op" value="reopen" />
                              <Button type="submit" size="sm" variant="ghost">未対応に戻す</Button>
                            </form>
                          ) : (
                            <>
                              <form action={setTidyFollowUp.bind(null, c.id)} className="flex flex-wrap items-center gap-1.5">
                                <input type="hidden" name="key" value={i.key} />
                                <input type="hidden" name="op" value="fix" />
                                <input name="fixNote" placeholder="どう直したか (任意)" maxLength={300} className="field h-8 min-w-0 flex-1 py-0.5 text-xs" aria-label="どう直したか" />
                                <Button type="submit" size="sm">直した</Button>
                              </form>
                              <form action={setTidyFollowUp.bind(null, c.id)} className="flex flex-wrap items-center gap-1.5">
                                <input type="hidden" name="key" value={i.key} />
                                <input type="hidden" name="op" value="due" />
                                <input type="date" name="dueDate" defaultValue={i.dueDate ?? ""} className="field h-8 py-0.5 text-xs" aria-label="直す期限" />
                                <Button type="submit" size="sm" variant="secondary">期限を保存</Button>
                              </form>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="記録" />
            <ul className="space-y-1 text-xs text-ink-2">
              <li>登録 {userName(c.createdBy)} · {fmtDateTime(c.createdAt)}</li>
              {c.updatedBy && <li>更新 {userName(c.updatedBy)} · {fmtDateTime(c.updatedAt)}</li>}
            </ul>
            {canDeleteTidyCheck(user, c) && (
              <form action={deleteTidyCheck.bind(null, c.id)} className="mt-3 border-t border-line pt-3">
                <Button type="submit" size="sm" variant="ghost">このチェックを削除する</Button>
              </form>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
