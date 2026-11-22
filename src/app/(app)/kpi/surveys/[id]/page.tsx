import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canManageKpi, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";

import { deleteSurvey, updateSurvey } from "@/lib/actions/kpi";
import { deliveryOf, surveyDate } from "@/lib/kpi";
import { recentOrderOptions, staffOptions, surveyPhoto } from "@/lib/kpi-options";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { COMMENT_TONE_LABEL, SCORE_LABEL, SCORE_QUESTIONS } from "@/lib/survey";
import { userName } from "@/lib/db/queries";
import { SurveyForm } from "@/components/kpi/SurveyForm";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, PageHeader, StoreTag } from "@/components/ui";

export default async function SurveyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const s = db.surveys.find((x) => x.id === id);
  if (!s) notFound();
  // ほかの店舗のアンケートは、閲覧の範囲の設定 (顧客情報 = 全社員。src/lib/access-policy.ts) のとき閲覧のみ
  if (!canReadStoreRecords(policyReader(db, user), s.storeId)) redirect("/kpi/surveys?err=" + encodeURIComponent("このアンケートを閲覧する権限がありません。"));
  const order = s.orderId ? db.orders.find((o) => o.id === s.orderId) : undefined;
  const customer = order ? db.customers.find((c) => c.id === order.customerId) : undefined;
  const photo = surveyPhoto(db, s.documentId, s.orderId);
  const canEdit = canAccessStore(user, s.storeId) && (canManageKpi(user) || s.createdBy === user.id);
  const logs = db.auditLogs.filter((l) => l.entity === "survey" && l.entityId === s.id).reverse();

  return (
    <div className="max-w-6xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={`お客様アンケート はがき No.${s.postcardNo ?? "-"}`}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StoreTag store={db.stores.find((x) => x.id === s.storeId)} /> · 回答 {fmtDate(surveyDate(s))} · 登録 {s.createdBy ? `${userName(s.createdBy)} ` : ""}{fmtDateTime(s.createdAt ?? s.receivedAt)}</span>}
        back={{ href: "/kpi/surveys", label: "アンケート一覧" }}
      />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="回答" />
            <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
              {SCORE_QUESTIONS.map((q) => (
                <div key={q.key} className="rounded-lg bg-subtle/70 px-3 py-2">
                  <div className="text-[11px] text-ink-3">{q.no} {q.label} ({q.target})</div>
                  <div className="text-lg font-semibold tnum">{s[q.key] ?? "-"} <span className="text-xs font-normal text-ink-3">{s[q.key] ? SCORE_LABEL[s[q.key]!] : ""}</span></div>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <Dl
                items={[
                  ["⑤ 重視されたこと", s.priorities ?? "-"],
                  ["⑥ 依頼のきっかけ", s.media ?? "-"],
                  ["⑦ 次回も依頼したい", s.wouldUseAgain ?? "-"],
                  ["営業担当", s.salesUserId ? userName(s.salesUserId) : s.salesName ?? "-"],
                  ["担当職人", deliveryOf(s).map((u) => userName(u)).join("・") || s.craftsmanName || "-"],
                  ["事務担当", s.clerkUserId ? userName(s.clerkUserId) : "-"],
                ]}
              />
            </div>
            {s.comment && (
              <div className="mt-3 rounded-lg border border-line px-3 py-2 text-sm">
                <div className="mb-1 flex flex-wrap gap-1">{s.commentTone && <Badge tone={s.commentTone === "complaint" ? "critical" : s.commentTone === "request" ? "warn" : "good"}>{COMMENT_TONE_LABEL[s.commentTone]}</Badge>}{(s.commentTags ?? []).map((t) => <Badge key={t} tone="neutral" dot={false}>{t}</Badge>)}</div>
                「{s.comment}」
              </div>
            )}
          </Card>
          {canEdit && (
            <Card>
              <CardHeader title="修正" description="修正は変更履歴に残り、集計に反映されます" />
              <SurveyForm
                action={updateSurvey.bind(null, s.id)}
                survey={s}
                orderRef={order?.number}
                orderOptions={recentOrderOptions(db, user)}
                users={staffOptions(db, s.storeId)}
                stores={db.stores}
                cancelHref={`/kpi/surveys/${s.id}`}
                submitLabel="修正を保存"
                edit
              />
            </Card>
          )}
          {canManageKpi(user) && (
            <Card>
              <CardHeader title="削除" description="誤って登録したときだけ削除します (変更履歴に残ります)" />
              <form action={deleteSurvey.bind(null, s.id)} className="flex flex-wrap items-end gap-2">
                <Field label="理由" className="min-w-0 flex-1"><Input name="reason" required /></Field>
                <Button type="submit" variant="danger">削除</Button>
              </form>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="はがきの写真" />
            {photo ? (
              <a href={`/api/attachments/${photo.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/attachments/${photo.id}${photo.thumbKey ? "?size=thumb" : ""}`} alt="アンケートはがき" className="w-full object-contain" />
              </a>
            ) : (
              <p className="text-sm text-ink-3">{s.source === "import" ? "スプレッドシートから移行したアンケートです" : "写真はありません"}</p>
            )}
          </Card>
          <Card>
            <CardHeader title="案件" />
            {order ? (
              <Dl columns={1} items={[["受注", <Link key="o" href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number} {order.title}</Link>], ["お客様", customer ? <Link key="c" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name} 様</Link> : "-"], ["施工担当", order.workerIds.map((w) => userName(w)).join("・") || "-"], ["ハガキ欄", order.postcardNo ?? "-"]]} />
            ) : (
              <p className="text-sm text-warn-ink">案件が未設定です。修正欄で受注番号を入力してください。</p>
            )}
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-1.5 text-xs">
              {logs.length === 0 && <li className="text-ink-3">記録はありません</li>}
              {logs.map((l) => <li key={l.id}><span className="tnum text-ink-3">{fmtDateTime(l.at)}</span> {l.summary} <span className="text-ink-3">({userName(l.userId)})</span></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
