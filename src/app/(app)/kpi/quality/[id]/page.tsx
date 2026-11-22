import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canManageKpi } from "@/lib/auth/permissions";
import { deleteQualityIssue, updateQualityIssue } from "@/lib/actions/kpi";
import { QUALITY_CATEGORIES, QUALITY_KIND_HELP, QUALITY_KIND_LABEL, kpiSettings } from "@/lib/kpi-settings";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { QualityGuide } from "@/components/kpi/QualityGuide";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, PageHeader, Select, StoreTag, Textarea } from "@/components/ui";

export default async function QualityDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const q = db.qualityIssues.find((x) => x.id === id);
  if (!q) notFound();
  if (!canAccessStore(user, q.storeId)) redirect("/kpi/quality?err=" + encodeURIComponent("この記録を閲覧する権限がありません。"));
  const order = q.orderId ? db.orders.find((o) => o.id === q.orderId) : undefined;
  const customer = order ? db.customers.find((c) => c.id === order.customerId) : undefined;
  const manage = canManageKpi(user);
  const canEdit = manage || q.reportedBy === user.id || q.responsibleUserIds.includes(user.id);
  const qp = kpiSettings(db).qualityPoints;
  const staff = db.users.filter((u) => u.active && (u.storeId === q.storeId || q.responsibleUserIds.includes(u.id) || order?.workerIds.includes(u.id) || u.storeId === "hq"));
  const logs = db.auditLogs.filter((l) => l.entity === "quality" && l.entityId === q.id).reverse();
  const back = `/kpi/quality/${q.id}`;

  return (
    <div className="max-w-5xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={`${q.number} ${QUALITY_KIND_LABEL[q.kind]}`}
        badge={<><Badge tone={q.kind === "rework" ? "warn" : "critical"}>{q.points} 点</Badge><Badge tone={q.status === "resolved" ? "good" : "neutral"}>{q.status === "resolved" ? "解決済み" : "対応中"}</Badge>{q.counted === false && <Badge tone="neutral" dot={false}>記録のみ (集計しない)</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StoreTag store={db.stores.find((s) => s.id === q.storeId)} /> · 発生 {fmtDate(q.occurredOn)} · 登録 {userName(q.reportedBy)} {fmtDateTime(q.createdAt)}</span>}
        back={{ href: "/kpi/quality", label: "クレーム・手直し一覧" }}
      />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="内容" />
            <Dl columns={1} items={[["案件", order ? <Link key="o" href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number} {customer?.name} 様 · {order.title}</Link> : <span key="o" className="text-warn-ink">未設定 (下の「案件 (受注番号)」でひも付けてください)</span>], ["現場名", q.siteName ?? "-"], ["発生のきっかけ", q.origin ?? "-"], ["登録のもと", q.sourceRef ? "スプレッドシート「お客様アンケート集計表」から取込 (シートの行が変わると、次の取込で内容が更新されます)" : "システムで登録"], ["対象の担当者", q.responsibleUserIds.map((u) => userName(u)).join("・") || "-"], ["ポイントの単位", q.attribution === "office" ? "事務" : "店舗"], ["カテゴリー", q.category ?? "-"], ["内容", <span key="d" className="whitespace-pre-wrap">{q.description}</span>], ["原因", <span key="c" className="whitespace-pre-wrap">{q.cause ?? "未入力"}</span>], ["対策・再発防止", <span key="m" className="whitespace-pre-wrap">{q.countermeasure ?? "未入力"}</span>]]} />
          </Card>
          {canEdit && (
            <Card>
              <CardHeader title="更新 (原因・対策の追記、解決済みにする)" />
              <form action={updateQualityIssue.bind(null, q.id)} className="space-y-3">
                <input type="hidden" name="returnTo" value={back} />
                <input type="hidden" name="countedField" value="1" />
                <fieldset disabled={!manage}>
                  <legend className="label">区分 {manage ? "" : "(変更は店長以上)"}</legend>
                  <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
                    {(["rework", "claim", "claim_rework"] as const).map((k) => (
                      <label key={k} className="flex cursor-pointer gap-2 rounded-lg border border-line p-2 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft/50">
                        <input type="radio" name="kind" value={k} defaultChecked={q.kind === k} className="mt-0.5" />
                        <span><span className="font-medium text-ink">{QUALITY_KIND_LABEL[k]} ({qp[k]} 点)</span><br /><span className="text-ink-3">{QUALITY_KIND_HELP[k]}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <QualityGuide />
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
                  <Field label="案件 (受注番号)" hint={manage ? "空欄にするとひも付けを外します" : undefined}><Input name="orderRef" defaultValue={order?.number ?? ""} placeholder="O-2026-0012" /></Field>
                  <Field label="現場名"><Input name="siteName" defaultValue={q.siteName ?? ""} placeholder="（地区）お客様名" /></Field>
                  <Field label="発生のきっかけ"><Input name="origin" defaultValue={q.origin ?? ""} placeholder="電話・アンケート・LINE・点検DM など" /></Field>
                </div>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
                  <Field label="発生日"><Input type="date" name="occurredOn" defaultValue={q.occurredOn} /></Field>
                  <Field label="ポイントの単位 (原因)"><Select name="attribution" defaultValue={q.attribution ?? "store"} disabled={!manage}><option value="store">店舗 (施工・見積の原因)</option><option value="office">事務 (事務の原因)</option></Select></Field>
                  <Field label="カテゴリー"><Select name="category" defaultValue={q.category ?? ""}><option value="">(未選択)</option>{QUALITY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
                </div>
                {manage && (
                  <fieldset>
                    <legend className="label">対象の担当者</legend>
                    <div className="flex flex-wrap gap-1.5">
                      {staff.map((u) => <label key={u.id} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft"><input type="checkbox" name="responsibleUserIds" value={u.id} defaultChecked={q.responsibleUserIds.includes(u.id)} className="h-3.5 w-3.5" />{u.name}</label>)}
                    </div>
                  </fieldset>
                )}
                <Field label="内容"><Textarea name="description" defaultValue={q.description} rows={2} required /></Field>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <Field label="原因"><Textarea name="cause" defaultValue={q.cause} rows={3} /></Field>
                  <Field label="対策・再発防止"><Textarea name="countermeasure" defaultValue={q.countermeasure} rows={3} /></Field>
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-ink-2">
                  <label className="flex items-center gap-2"><input type="checkbox" name="resolved" defaultChecked={q.status === "resolved"} className="h-4 w-4" /> 解決済み (原因と対策が必要)</label>
                  {manage && <label className="flex items-center gap-2"><input type="checkbox" name="notCounted" defaultChecked={q.counted === false} className="h-4 w-4" /> 記録のみ (集計しない: 点検 DM・点検電話、お客様が原因など)</label>}
                </div>
                <Button type="submit">更新する</Button>
              </form>
            </Card>
          )}
          {manage && (
            <Card>
              <CardHeader title="削除" description="誤って登録したときだけ削除します (変更履歴に残ります)" />
              <form action={deleteQualityIssue.bind(null, q.id)} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="returnTo" value={order ? `/orders/${order.id}` : "/kpi/quality"} />
                <Field label="理由" className="min-w-0 flex-1"><Input name="reason" required /></Field>
                <Button type="submit" variant="danger">削除</Button>
              </form>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title="変更履歴" />
          <ul className="space-y-1.5 text-xs">
            {logs.map((l) => <li key={l.id}><span className="tnum text-ink-3">{fmtDateTime(l.at)}</span> {l.summary} <span className="text-ink-3">({userName(l.userId)})</span></li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
