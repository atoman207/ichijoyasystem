import { notFound, redirect } from "next/navigation";
import clsx from "clsx";
import { requireUser } from "@/lib/auth/session";
import { BACKEND, getDb } from "@/lib/db/store";
import { missingTables } from "@/lib/db/supabase";
import { canApproveDocDraft, canDiscardDocDraft, canEditDocDraft, canReturnDocDraft, canReviewDocDraft, canSendDocDraft, canViewDocDraft, skipsApproval } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { DOC_DRAFT_ACTION_LABEL, DOC_DRAFT_CHANNEL_LABEL, DOC_DRAFT_FORMAT_LABEL, DOC_DRAFT_STATUS, defaultRecipients, docDraftApprovers, isReturned, lastEvent, lineDiff } from "@/lib/doc-drafts";
import { changeDocDraftStatus, copyDocDraftAction, recordDocDraftHanded, sendDocDraft, updateDocDraft } from "@/lib/actions/doc-drafts";
import { chatworkConfig, lineConfig, mailConfig } from "@/lib/notify/config";
import { DELIVERY_STATUS } from "@/lib/constants";
import Link from "@/components/ui/Link";
import { HistoryCard } from "@/components/features/History";
import { DocDraftStatusBadge, DocDraftSteps } from "@/components/features/DocDrafts";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, Textarea } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * 文書の下書きの詳細: 文面の修正 (版が増える)・確認・承認・差し戻し・送信・版の履歴と違い・処理の記録
 * ?v=<版> でその版を表示し、いまの文面との違いを出す
 */
export default async function DocDraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const d = (db.docDrafts ?? []).find((x) => x.id === id);
  if (!d) notFound();
  if (!canViewDocDraft(user, d)) redirect("/ai/drafts?err=" + encodeURIComponent("この文書を見る権限がありません。"));
  const tableMissing = BACKEND === "supabase" && missingTables().includes("doc_drafts");
  const editable = canEditDocDraft(user, d) && !tableMissing;
  const s = DOC_DRAFT_STATUS[d.status];
  const ev = lastEvent(d);
  const returned = isReturned(d);
  const shownV = sp.v ? d.versions.find((v) => String(v.v) === sp.v) : undefined;
  const recipients = defaultRecipients(db, d);
  const channels = [mailConfig() ? "email" : null, lineConfig() ? "line" : null, chatworkConfig() ? "chatwork" : null].filter(Boolean) as ("email" | "line" | "chatwork")[];
  const approvers = d.status === "reviewed" ? docDraftApprovers(db, d) : [];
  const deliveries = db.deliveries.filter((x) => (d.deliveryIds ?? []).includes(x.id));
  const act = (a: "review" | "approve" | "return" | "discard" | "restore") => changeDocDraftStatus.bind(null, d.id, a);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={d.title}
        back={{ href: "/ai/drafts", label: "文書の下書き" }}
        badge={<DocDraftStatusBadge d={d} />}
        description={`${d.number} · ${DOC_DRAFT_FORMAT_LABEL[d.format]} · ${d.audience === "customer" ? "お客様向け" : "社内・取引先向け"} · 第 ${d.version} 版 · 作成 ${fmtDateTime(d.createdAt)} ${userName(d.createdBy)} · 更新 ${fmtDateTime(d.updatedAt)} ${userName(d.updatedBy ?? d.createdBy)}`}
      />
      {tableMissing && <Note tone="warn">データベースに文書の下書きの表がまだないため、変更は保存できません (管理者がデプロイするか npm run db:migrate を実行してください)。</Note>}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <DocDraftSteps status={d.status} />
        <span className="text-xs text-ink-3">{s.hint}</span>
      </div>
      {returned && ev && (
        <Note tone="warn">
          {userName(ev.by)} さんが差し戻しました ({fmtDateTime(ev.at)}): {ev.comment}
        </Note>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          {shownV && (
            <Card>
              <CardHeader
                title={`第 ${shownV.v} 版 (${fmtDateTime(shownV.at)} ${userName(shownV.by)}${shownV.source === "ai" ? "・作成" : shownV.source === "copy" ? "・複製" : "・修正"})`}
                description={shownV.v === d.version ? "いまの文面です" : `いまの文面 (第 ${d.version} 版) との違い: 赤 = この版にあっていまはない行 / 緑 = いま増えている行`}
                action={<Link href={`/ai/drafts/${d.id}`} className="text-xs text-accent hover:underline">閉じる</Link>}
              />
              {shownV.note && <p className="mb-2 text-xs text-ink-2">修正のメモ: {shownV.note}</p>}
              {(shownV.subject ?? "") !== (d.subject ?? "") && (
                <p className="mb-2 text-xs">
                  件名: <span className="bg-critical-soft text-critical-ink line-through">{shownV.subject || "(なし)"}</span> → <span className="bg-good-soft text-good-ink">{d.subject || "(なし)"}</span>
                </p>
              )}
              <pre className="max-h-[480px] overflow-auto rounded-lg border border-line bg-subtle p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap" data-testid="draft-diff">
                {lineDiff(shownV.body, d.body).map((l, i) => (
                  <div key={i} className={clsx(l.op === "add" && "bg-good-soft text-good-ink", l.op === "del" && "bg-critical-soft text-critical-ink line-through")}>
                    <span className="mr-2 inline-block w-3 text-ink-3 select-none" aria-hidden>{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
                    {l.text || " "}
                  </div>
                ))}
              </pre>
              {editable && shownV.v !== d.version && (
                <form action={updateDocDraft.bind(null, d.id)} className="mt-2">
                  <input type="hidden" name="subject" value={shownV.subject ?? ""} />
                  <input type="hidden" name="body" value={shownV.body} />
                  <input type="hidden" name="note" value={`第 ${shownV.v} 版に戻す`} />
                  <Button type="submit" size="sm" variant="secondary">この版の文面に戻す (新しい版として保存)</Button>
                </form>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title="文面" description={editable ? (d.status === "draft" ? "直して「保存する」を押すと新しい版になります" : "確認済み・承認済みの文書を直すと下書きに戻り、確認と承認をやり直します (承認した文面だけを送るため)") : d.status === "sent" ? "送った文面です (直すときは複製してください)" : "この文書を直す権限がありません (作成者と、店長・本部・管理者が直せます)"} />
            {editable ? (
              <form action={updateDocDraft.bind(null, d.id)} className="space-y-3">
                {d.format !== "line" && <Field label="件名"><Input name="subject" defaultValue={d.subject ?? ""} maxLength={200} placeholder={d.format === "email" ? "メールの件名" : "文書の題名 (任意)"} /></Field>}
                {d.format === "line" && <input type="hidden" name="subject" value={d.subject ?? ""} />}
                <Field label="本文" required><Textarea name="body" defaultValue={d.body} required className="min-h-[360px] font-sans text-sm leading-relaxed" /></Field>
                <Field label="修正のメモ (任意)" hint="版の履歴に残ります (例: 日程を 11/26 に変更)"><Input name="note" maxLength={300} /></Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm">保存する</Button>
                  {d.status !== "draft" && <span className="text-[11px] text-warn-ink">保存すると「{s.label}」から「下書き」に戻ります</span>}
                </div>
              </form>
            ) : (
              <div>
                {d.subject && <p className="mb-2 text-sm font-medium text-ink">件名: {d.subject}</p>}
                <div className="text-sm leading-relaxed whitespace-pre-wrap text-ink" data-testid="draft-body">{d.body}</div>
              </div>
            )}
          </Card>

          {d.status === "approved" && canSendDocDraft(user, d) && !tableMissing && (
            <Card>
              <CardHeader title="送信する" description={`承認された文面 (第 ${d.version} 版) をそのまま送ります。送れたときだけ送信済みになり、やりとり履歴・送信履歴にも残ります`} />
              {channels.length === 0 && <Note>メール・LINE・Chatwork の送信の設定がありません (設定 → 外部連携・AI)。郵送・手渡しで渡したときは下の「記録だけ残す」を使ってください。</Note>}
              <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
                {channels.map((ch) => (
                  <form key={ch} action={sendDocDraft.bind(null, d.id)} className="space-y-2 rounded-xl border border-line p-3">
                    <input type="hidden" name="channel" value={ch} />
                    <div className="text-sm font-medium text-ink">{DOC_DRAFT_CHANNEL_LABEL[ch]}で送る</div>
                    <Field label={ch === "email" ? "宛先のメールアドレス" : ch === "line" ? "LINE のユーザー ID" : "Chatwork のルーム ID (空欄 = 社内通知のルーム)"}>
                      <Input name="to" defaultValue={recipients[ch]?.to ?? ""} required={ch !== "chatwork"} placeholder={ch === "email" ? "customer@example.com" : ch === "line" ? "U から始まる 33 文字" : "例: 123456789"} />
                    </Field>
                    <Field label="宛先の名前"><Input name="toLabel" defaultValue={recipients[ch]?.label ?? ""} maxLength={100} /></Field>
                    <Button type="submit" size="sm">{DOC_DRAFT_CHANNEL_LABEL[ch]}で送信する</Button>
                  </form>
                ))}
              </div>
              <form action={recordDocDraftHanded.bind(null, d.id)} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <Field label="システムの外で渡した">
                  <Select name="how" defaultValue="manual_mail" className="w-auto">
                    <option value="manual_mail">郵送した</option>
                    <option value="manual_hand">手渡し・対面で渡した</option>
                  </Select>
                </Field>
                <Field label="メモ (任意)" className="min-w-0 flex-1"><Input name="note" maxLength={200} placeholder="例: 11/20 普通郵便で発送" /></Field>
                <Button type="submit" size="sm" variant="secondary">記録だけ残す (送信済みにする)</Button>
              </form>
            </Card>
          )}

          {d.status === "sent" && (
            <Card>
              <CardHeader title="送信の記録" />
              <p className="text-sm text-ink">
                {d.channel ? DOC_DRAFT_CHANNEL_LABEL[d.channel] : "-"} · {d.recipientLabel || d.recipient || "-"} · {fmtDateTime(d.sentAt)} {userName(d.sentBy)}
              </p>
              {d.commLogId && <p className="mt-1 text-xs"><Link href="/contacts" className="text-accent hover:underline">やりとり履歴に残しました</Link></p>}
            </Card>
          )}
          {deliveries.length > 0 && (
            <Card>
              <CardHeader title="送信履歴" />
              <ul className="space-y-1 text-xs">
                {deliveries.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={DELIVERY_STATUS[x.status].tone}>{DELIVERY_STATUS[x.status].label}</Badge>
                    <span>{fmtDateTime(x.createdAt)} · {x.recipientLabel || x.recipient}</span>
                    {x.error && <span className="text-critical-ink">{x.error}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="進める" />
            <div className="space-y-3 text-sm">
              {canReviewDocDraft(user, d) && !tableMissing && (
                <form action={act("review")}>
                  <Button type="submit" size="sm">内容を確認した</Button>
                  <p className="mt-1 text-[11px] text-ink-3">{d.createdBy === user.id && skipsApproval(user) ? "管理者の文書のため、確認すると承認も省略して承認済みになります" : "宛名・金額・日付・約束が記録と合っているか確かめてから押してください。承認する人に知らせます"}</p>
                </form>
              )}
              {d.status === "reviewed" && (
                <p className="text-xs text-ink-2">
                  確認 {userName(d.reviewedBy)} ({fmtDateTime(d.reviewedAt)})。承認する人: {approvers.map((u) => u.name).join("・") || "店長・本部スタッフ・管理者"}
                </p>
              )}
              {canApproveDocDraft(user, d) && !tableMissing && (
                <form action={act("approve")} className="space-y-1">
                  <Input name="comment" maxLength={500} placeholder="コメント (任意)" aria-label="承認のコメント" />
                  <Button type="submit" size="sm">承認する</Button>
                </form>
              )}
              {d.status === "reviewed" && d.createdBy === user.id && !skipsApproval(user) && <p className="text-[11px] text-ink-3">自分が作った文書は承認できません。店長・本部・管理者の承認を待ってください。</p>}
              {d.status === "approved" && <p className="text-xs text-ink-2">承認 {userName(d.approvedBy)} ({fmtDateTime(d.approvedAt)})</p>}
              {canReturnDocDraft(user, d) && !tableMissing && (
                <form action={act("return")} className="space-y-1">
                  <Input name="comment" required maxLength={500} placeholder="差し戻しの理由 (必須)" aria-label="差し戻しの理由" />
                  <Button type="submit" size="sm" variant="secondary">差し戻す</Button>
                </form>
              )}
              {d.status === "discarded" && canDiscardDocDraft(user, d) && !tableMissing && (
                <form action={act("restore")}><Button type="submit" size="sm" variant="secondary">下書きに戻す</Button></form>
              )}
              {d.status !== "sent" && d.status !== "discarded" && canDiscardDocDraft(user, d) && !tableMissing && (
                <form action={act("discard")}><Button type="submit" size="sm" variant="danger">破棄する</Button></form>
              )}
              {(d.status === "sent" || d.status === "discarded") && !tableMissing && (
                <form action={copyDocDraftAction.bind(null, d.id)}><Button type="submit" size="sm" variant="secondary">複製して新しい下書きにする</Button></form>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="関係する記録" />
            {d.refs.length === 0 ? (
              <p className="text-xs text-ink-3">なし (記録の番号を入れずに作った文書)</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.refs.map((r) => <li key={`${r.type}:${r.id}`}><Link href={r.href} className="text-accent hover:underline">{r.label}</Link></li>)}
              </ul>
            )}
            {d.notes && <p className="mt-2 text-xs text-ink-2">作成のときの要点: {d.notes}</p>}
            {d.copiedFrom && <p className="mt-1 text-xs"><Link href={`/ai/drafts/${d.copiedFrom}`} className="text-accent hover:underline">複製の元の文書</Link></p>}
          </Card>

          <Card>
            <CardHeader title="版の履歴" description="版を押すと、その版といまの文面の違いを表示します" />
            <ul className="space-y-1 text-xs">
              {[...d.versions].reverse().map((v) => (
                <li key={v.v} className="flex flex-wrap items-center gap-1.5">
                  <Link href={`/ai/drafts/${d.id}?v=${v.v}`} className={clsx("font-medium hover:underline", shownV?.v === v.v ? "text-ink" : "text-accent")}>第 {v.v} 版</Link>
                  <span className="text-ink-3">{fmtDateTime(v.at)} {userName(v.by)} · {v.source === "ai" ? (d.provider === "rules" ? "定型文で作成" : "AI で作成") : v.source === "copy" ? "複製" : "修正"}{v.v === d.version ? " · いまの版" : ""}</span>
                  {v.note && <span className="w-full pl-2 text-ink-2">{v.note}</span>}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="処理の記録" />
            <ol className="space-y-1.5 text-xs">
              {[...d.events].reverse().map((e, i) => (
                <li key={i}>
                  <span className="font-medium text-ink">{DOC_DRAFT_ACTION_LABEL[e.action]}</span>
                  <span className="text-ink-3"> · {fmtDateTime(e.at)} {userName(e.by)}{e.from && e.to && e.from !== e.to ? ` · ${DOC_DRAFT_STATUS[e.from].label} → ${DOC_DRAFT_STATUS[e.to].label}` : ""}{e.version ? ` · 第 ${e.version} 版` : ""}</span>
                  {e.comment && <div className="pl-2 text-ink-2">{e.comment}</div>}
                </li>
              ))}
            </ol>
          </Card>

          <HistoryCard db={db} user={user} targets={[{ entity: "doc_draft", id: d.id }]} />
        </div>
      </div>
    </div>
  );
}
