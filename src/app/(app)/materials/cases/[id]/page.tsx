import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Download, Megaphone } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { canApproveCasePost, canDiscardCasePost, canEditCasePost, canRecordCasePosting, canRequestCasePostReview, canReturnCasePost, canViewCasePost, canWithdrawCasePost, isCasePostReviewer } from "@/lib/auth/permissions";
import {
  CASE_POST_ACTION_LABEL,
  CASE_POST_CHANNELS,
  CASE_POST_CHANNEL_LABEL,
  CASE_POST_CONSENT_LABEL,
  CASE_POST_STATUS,
  casePostReviewerIds,
  casePostReviewers,
  lastReturnComment,
  orderPhotos,
  personalContext,
  personalInfoFindings,
  postFullText,
  readinessProblems,
} from "@/lib/case-posts";
import { changeCasePostStatus, recordCasePostPosting, saveCasePost } from "@/lib/actions/case-posts";
import { attachLinePhotosToOrder } from "@/lib/actions/line-photos";
import { pendingLinePhotos } from "@/lib/line-photos";
import { aiEnabled } from "@/lib/ai/provider";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { CasePostStatusBadge, CasePostSteps, LinePhotoChecks, PhotoChecks } from "@/components/case-posts/CasePostParts";
import { CopyText } from "@/components/case-posts/CopyText";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, StoreTag, Textarea } from "@/components/ui";

export const metadata: Metadata = { title: "施工事例の投稿" };
// 「保存して AI で投稿文を作り直す」(src/lib/ai/case-post.ts)
export const maxDuration = 60;

export default async function CasePostPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const p = (db.casePosts ?? []).find((x) => x.id === id);
  if (!p) notFound();
  const ids = casePostReviewerIds(db);
  if (!canViewCasePost(user, p, ids)) redirect(`/materials?tab=cases&err=${encodeURIComponent("この投稿を見る権限がありません。")}`);
  const order = db.orders.find((o) => o.id === p.orderId);
  const customer = order ? db.customers.find((c) => c.id === order.customerId) : undefined;
  const ctx = personalContext(customer, order);
  const store = db.stores.find((s) => s.id === p.storeId);
  const photos = order ? orderPhotos(db, order.id) : [];
  const chosen = p.photoIds.map((pid) => photos.find((a) => a.id === pid)).filter((a): a is (typeof photos)[number] => Boolean(a));
  const canEdit = canEditCasePost(user, p, ids);
  const reviewer = isCasePostReviewer(user, ids);
  const findings = personalInfoFindings(`${p.title}\n${p.text}`, ctx);
  const problems = readinessProblems(p, ctx);
  const ret = p.status === "returned" ? lastReturnComment(p) : undefined;
  const linePhotos = canEdit ? pendingLinePhotos(db, user, "photos", p.storeId) : [];
  const full = postFullText(p);
  const act = (a: Parameters<typeof changeCasePostStatus>[1]) => changeCasePostStatus.bind(null, p.id, a);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={`${p.number} ${p.title || "(見出しなし)"}`}
        icon={<Megaphone />}
        badge={<CasePostStatusBadge p={p} />}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {order ? <>受注 <Link href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number}</Link></> : "案件なし"} · <StoreTag store={store} /> · 作成 {userName(p.createdBy)} {fmtDateTime(p.createdAt)} · 下書き: {p.provider === "rules" ? "定型文" : p.provider === "manual" ? "手入力" : "AI"}
          </span>
        }
        back={{ href: "/materials?tab=cases", label: "施工事例の投稿の一覧" }}
      />
      <CasePostSteps status={p.status} />
      <p className="-mt-2 mb-4 text-xs text-ink-3">{CASE_POST_STATUS[p.status].hint}。確認する人: {casePostReviewers(db).map((u) => u.name).join("・") || "-"}</p>

      {ret && <Note tone="warn">差し戻しの理由: {ret}</Note>}
      {findings.length > 0 && <Note tone="warn">投稿文・見出しにお客様の個人情報が残っています: {findings.join("・")}。消してから確認を依頼してください (地域は町名まで)。</Note>}
      {p.consent === "unconfirmed" && p.status !== "posted" && <Note>お客様の掲載の了承が「未確認」です。お宅と分かる写真を使うときは、了承をいただいてから投稿してください。</Note>}

      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          {canEdit ? (
            <form action={saveCasePost.bind(null, p.id)} className="space-y-4">
              <Card>
                <CardHeader title="投稿文" description="この文をコピーして投稿します。直したら「保存」を押してください" />
                <div className="space-y-3">
                  <Field label="見出し"><Input name="title" defaultValue={p.title} maxLength={120} /></Field>
                  <Field label="本文"><Textarea name="text" defaultValue={p.text} rows={12} /></Field>
                  <Field label="ハッシュタグ (空白区切り)" hint="Instagram・Facebook で使います。ホームページ・Google ビジネスプロフィールでは使わなくてかまいません"><Input name="hashtags" defaultValue={p.hashtags} /></Field>
                </div>
              </Card>
              <Card>
                <CardHeader title={`使う写真 (${p.photoIds.length} 枚選択中 · 10 枚まで)`} description="受注・施工の画面の「現場写真・資料」の写真から選びます" />
                <PhotoChecks photos={photos} selected={p.photoIds} />
              </Card>
              <Card>
                <CardHeader title="投稿の材料と投稿先" description="AI で作り直すときに使います" />
                <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
                  <Field label="地域 (町名まで)"><Input name="area" defaultValue={p.area ?? ""} maxLength={60} /></Field>
                  <Field label="お客様の掲載の了承">
                    <Select name="consent" defaultValue={p.consent}>
                      {Object.entries(CASE_POST_CONSENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="商品名 (1 行に 1 つ)"><Textarea name="products" defaultValue={p.products} rows={4} /></Field>
                  <Field label="施工内容"><Textarea name="workContent" defaultValue={p.workContent} rows={4} /></Field>
                </div>
                <fieldset className="mt-3">
                  <legend className="label">投稿先</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {CASE_POST_CHANNELS.map((c) => (
                      <label key={c} className="flex items-center gap-1.5 text-sm text-ink-2"><input type="checkbox" name="channels" value={c} defaultChecked={p.channels.includes(c)} className="h-4 w-4" /> {CASE_POST_CHANNEL_LABEL[c]}</label>
                    ))}
                  </div>
                </fieldset>
              </Card>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" name="intent" value="save">保存</Button>
                <Button type="submit" name="intent" value="ai" variant="secondary">保存して{aiEnabled() ? " AI " : "定型文"}で投稿文を作り直す</Button>
                <span className="text-xs text-ink-3">作り直すと、いまの本文とハッシュタグは置き換わります{p.status === "approved" && !reviewer ? "。承認のあとに直すと下書きに戻ります" : ""}</span>
              </div>
            </form>
          ) : (
            <Card>
              <CardHeader title="投稿文" description={p.status === "review" ? "確認を依頼している間は、確認する人だけが直せます" : undefined} />
              <p className="whitespace-pre-wrap text-sm text-ink">{p.text || "(本文なし)"}</p>
              {p.hashtags && <p className="mt-2 text-sm text-accent-ink">{p.hashtags}</p>}
              <div className="mt-3 text-xs text-ink-3">地域: {p.area || "-"} · 投稿先: {p.channels.map((c) => CASE_POST_CHANNEL_LABEL[c]).join("・") || "-"} · 掲載の了承: {CASE_POST_CONSENT_LABEL[p.consent].label}</div>
            </Card>
          )}

          <Card>
            <CardHeader title="投稿する (コピー・写真の保存)" description={p.status === "approved" || p.status === "posted" ? "文面をコピーして投稿の画面に貼り付け、写真を保存して添付してください。投稿したら右の「投稿を記録する」へ" : "確認する人の承認のあとに投稿してください"} />
            <div className="flex flex-wrap gap-2">
              <CopyText text={full} label="本文とハッシュタグをコピー" variant={p.status === "approved" ? "primary" : "secondary"} />
              <CopyText text={p.text} label="本文だけをコピー" />
              {p.hashtags && <CopyText text={p.hashtags} label="ハッシュタグだけ" variant="ghost" />}
            </div>
            <p className="mt-2 text-[11px] text-ink-3">{full.length.toLocaleString("ja-JP")} 文字 (Instagram は 2,200 文字・Google ビジネスプロフィールは 1,500 文字まで)</p>
            {chosen.length > 0 ? (
              <ul className="mt-3 grid grid-cols-2 gap-2 @xl:grid-cols-4">
                {chosen.map((a, i) => (
                  <li key={a.id} className="overflow-hidden rounded-xl border border-line bg-subtle">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/attachments/${a.id}?size=thumb`} alt={a.caption || a.fileName} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                    <a href={`/api/attachments/${a.id}?download=1`} className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent hover:underline"><Download className="h-3 w-3" />{i + 1} 枚目を保存</a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-ink-3">写真が選ばれていません。</p>
            )}
          </Card>

          {canEdit && linePhotos.length > 0 && (
            <Card>
              <CardHeader title={`LINE の「施工事例写真」グループの写真 (${linePhotos.length} 枚)`} description="まだ案件に付けていない写真です。選んで追加すると、この案件の「現場写真・資料」に保存し、この投稿の写真にも足します" />
              <form action={attachLinePhotosToOrder} className="space-y-3">
                <input type="hidden" name="postId" value={p.id} />
                <input type="hidden" name="returnTo" value={`/materials/cases/${p.id}`} />
                <LinePhotoChecks items={linePhotos.slice(0, 60)} />
                <Button type="submit" size="sm" variant="secondary">選んだ写真をこの案件と投稿に追加</Button>
              </form>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="確認と投稿" />
            <div className="space-y-3">
              {canRequestCasePostReview(user, p, ids) && (
                <form action={act("request")} className="space-y-1.5">
                  {problems.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-warn-ink">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
                  <Button type="submit" disabled={problems.length > 0}>{canApproveCasePost(user, { ...p, status: "review" }, ids) ? "確認して承認する" : "確認を依頼する"}</Button>
                  <p className="text-[11px] text-ink-3">{canApproveCasePost(user, { ...p, status: "review" }, ids) ? "あなたは確認する人なので、そのまま承認済みになります" : "保存してから押してください。確認する人に知らせます"}</p>
                </form>
              )}
              {canApproveCasePost(user, p, ids) && (
                <form action={act("approve")}>
                  {problems.length > 0 && <ul className="mb-1.5 list-disc space-y-0.5 pl-4 text-xs text-warn-ink">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
                  <Button type="submit" disabled={problems.length > 0}>承認する</Button>
                </form>
              )}
              {canReturnCasePost(user, p, ids) && (
                <form action={act("return")} className="space-y-1.5">
                  <Field label="差し戻しの理由" required><Textarea name="comment" rows={2} required placeholder="例: 2 枚目の写真に表札が写っています" /></Field>
                  <Button type="submit" variant="secondary" size="sm">差し戻す</Button>
                </form>
              )}
              {canWithdrawCasePost(user, p) && !canApproveCasePost(user, p, ids) && (
                <form action={act("withdraw")}><Button type="submit" variant="secondary" size="sm">確認の依頼を取り下げる</Button></form>
              )}
              {canRecordCasePosting(user, p, ids) && (
                <form action={recordCasePostPosting.bind(null, p.id)} className="space-y-2 border-t border-line pt-3">
                  <div className="text-sm font-medium text-ink">投稿を記録する</div>
                  <Field label="投稿先">
                    <Select name="channel" defaultValue={p.channels.find((c) => !p.postings.some((x) => x.channel === c)) ?? p.channels[0] ?? "instagram"}>
                      {CASE_POST_CHANNELS.map((c) => <option key={c} value={c}>{CASE_POST_CHANNEL_LABEL[c]}</option>)}
                    </Select>
                  </Field>
                  <Field label="投稿した日"><Input type="date" name="on" defaultValue={toDateKey(new Date())} required /></Field>
                  <Field label="投稿の URL (任意)"><Input type="url" name="url" placeholder="https://www.instagram.com/p/…" /></Field>
                  <Button type="submit" size="sm">投稿を記録する</Button>
                </form>
              )}
              {p.status === "discarded" && canDiscardCasePost(user, p, ids) && (
                <form action={act("restore")}><Button type="submit" variant="secondary" size="sm">下書きに戻す</Button></form>
              )}
              {p.status !== "discarded" && p.status !== "posted" && canDiscardCasePost(user, p, ids) && (
                <form action={act("discard")} className="border-t border-line pt-3"><Button type="submit" variant="ghost" size="sm">取りやめにする</Button></form>
              )}
            </div>
          </Card>

          {p.postings.length > 0 && (
            <Card>
              <CardHeader title="投稿した記録" />
              <ul className="space-y-1.5 text-xs">
                {p.postings.map((x, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="good">{CASE_POST_CHANNEL_LABEL[x.channel]}</Badge>
                    <span className="tnum">{fmtDate(x.on)}</span>
                    {x.url && <a href={x.url} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">{x.url}</a>}
                    <span className="text-ink-3">({userName(x.by)})</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="処理の記録" />
            <ol className="space-y-1.5 text-xs">
              {[...p.events].reverse().slice(0, 40).map((e, i) => (
                <li key={i} className="border-l-2 border-line pl-2">
                  <span className="font-medium text-ink">{CASE_POST_ACTION_LABEL[e.action] ?? e.action}</span>
                  {e.to && e.from !== e.to && <span className="text-ink-3"> → {CASE_POST_STATUS[e.to].label}</span>}
                  <div className="text-ink-3">{userName(e.by)} · {fmtDateTime(e.at)}</div>
                  {e.comment && <div className="text-ink-2">{e.comment}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
