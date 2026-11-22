import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditPromotion, canSeeAllStores, canViewPromoAnalysis, canViewStoreFigures } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";

import { userName } from "@/lib/db/queries";
import { fmtDateTime, toDateKey, yen } from "@/lib/format";
import { CATEGORY_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import { MEDIA, MEDIA_KEYS, MEDIA_LABEL } from "@/lib/media";
import { PROMOTION_KIND, PROMOTION_STATUS, inquiryDate } from "@/lib/ops-reports/promo-analysis";
import { opsTablesReady } from "@/lib/ops-reports/tables";
import { deletePromotion, registerEventInquiries, updatePromotion } from "@/lib/actions/promotions";
import { PromotionForm } from "@/components/ops-reports/PromotionForm";
import { Badge, Button, Card, CardHeader, Dl, EmptyRow, Field, Flash, Input, PageHeader, Select, StatusBadge, StoreTag, Table, Td, Textarea, Th, Tr } from "@/components/ui";

export default async function PromotionDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  // 見る範囲は経営の数字の閲覧の範囲 (src/lib/access-policy.ts)。変更は canEditPromotion (本物の利用者)
  const reader = policyReader(db, user);
  if (!canViewPromoAnalysis(reader)) redirect("/?err=" + encodeURIComponent("販促の記録を閲覧する権限がありません。"));
  const p = (db.promotions ?? []).find((x) => x.id === id);
  if (!p) notFound();
  if (!canViewStoreFigures(reader, p.storeId)) redirect("/promotions?tab=list&err=" + encodeURIComponent("この販促を閲覧する権限がありません。"));
  const canEdit = canEditPromotion(user, p.storeId);
  const ready = opsTablesReady(["promotions"]);
  const store = db.stores.find((s) => s.id === p.storeId);
  const kind = PROMOTION_KIND[p.kind];
  const inquiries = db.inquiries.filter((i) => i.promotionId === p.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const quoteIds = new Set(inquiries.map((i) => i.quoteId).filter(Boolean));
  const orders = db.orders.filter((o) => o.quoteId && quoteIds.has(o.quoteId) && o.status !== "cancelled");
  const sales = orders.reduce((a, o) => a + o.total, 0);
  const logs = db.auditLogs.filter((l) => l.entity === "promotion" && l.entityId === p.id).reverse().slice(0, 20);
  const users = db.users.filter((u) => u.active && (u.storeId === p.storeId || canSeeAllStores(u)));
  const today = toDateKey(new Date());

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={p.title}
        badge={<Badge tone={PROMOTION_STATUS[p.status].tone}>{PROMOTION_STATUS[p.status].label}</Badge>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{p.number} · {kind.label} · {p.startDate.replaceAll("-", "/")}{p.endDate ? `〜${p.endDate.replaceAll("-", "/")}` : ""} · <StoreTag store={store} /></span>}
        back={{ href: "/promotions?tab=list", label: "販促の記録" }}
      />

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="反応" description="きっかけの販促にこの販促を選んだ問い合わせ (問い合わせの登録・更新・受付票の一括登録)" />
            <Dl
              columns={3}
              items={[
                [kind.copiesLabel, `${p.copies.toLocaleString("ja-JP")} ${kind.unit}`],
                ["問い合わせ", `${inquiries.length} 件`],
                ["1,000 あたり", p.copies ? `${Math.round((inquiries.length / p.copies) * 1000 * 100) / 100} 件` : "-"],
                ["成約 (受注)", `${orders.length} 件`],
                ["成約の売上 (税込)", yen(sales)],
                ["費用", p.cost !== undefined ? yen(p.cost) : "-"],
                ["媒体", MEDIA_LABEL[p.media]],
                ["配布業者・依頼先", p.vendor ?? "-"],
                ["費用 ÷ 問い合わせ", p.cost !== undefined && inquiries.length ? yen(Math.round(p.cost / inquiries.length)) : "-"],
              ]}
            />
            {p.areas.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-semibold text-ink-2">地域と部数</div>
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {p.areas.map((a) => <li key={a.area} className="rounded-md border border-line px-2 py-0.5">{a.area} <span className="tnum text-ink-2">{a.copies.toLocaleString("ja-JP")}</span></li>)}
                </ul>
              </div>
            )}
            {p.note && <p className="mt-3 text-sm whitespace-pre-wrap text-ink-2">{p.note}</p>}
          </Card>

          <Card>
            <CardHeader title={`ひも付いた問い合わせ (${inquiries.length} 件)`} />
            <Table minWidth="min-w-[560px]">
              <thead>
                <tr>
                  <Th>受付日</Th>
                  <Th>お客様</Th>
                  <Th>内容</Th>
                  <Th>担当</Th>
                  <Th>状態</Th>
                </tr>
              </thead>
              <tbody>
                {inquiries.length === 0 && <EmptyRow colSpan={5}>まだありません</EmptyRow>}
                {inquiries.slice(0, 100).map((i) => (
                  <Tr key={i.id}>
                    <Td className="text-xs tnum">{inquiryDate(i).replaceAll("-", "/")}</Td>
                    <Td>{i.contactName}</Td>
                    <Td><Link href={`/inquiries/${i.id}`} className="text-ink hover:text-accent">{i.summary}</Link></Td>
                    <Td className="text-xs text-ink-2">{userName(i.assignedUserId)}</Td>
                    <Td><StatusBadge value={i.status} map={INQUIRY_STATUS} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {canEdit && (
            <Card id="event-sheet">
              <CardHeader title="受付票をまとめて問い合わせとして登録" description="イベント・展示会で受け付けた受付票を 1 行に 1 枚で貼り付けます (氏名, 電話, 住所, 内容。タブ区切りの表計算の行もそのまま貼れます)。入口は「イベント・展示会」、きっかけの販促はこの販促になります。電話番号が同じ店舗の顧客と一致すれば顧客にひも付けます" />
              <form action={registerEventInquiries.bind(null, p.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-4">
                <Field label="受付日" required><Input type="date" name="date" required defaultValue={p.startDate <= today ? p.startDate : today} max={today} /></Field>
                <Field label="種別">
                  <Select name="category" defaultValue="tatami">
                    {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </Select>
                </Field>
                <Field label="媒体">
                  <Select name="media" defaultValue={p.media}>
                    {MEDIA_KEYS.map((k) => <option key={k} value={k}>{MEDIA[k].label}</option>)}
                  </Select>
                </Field>
                <Field label="担当者">
                  <Select name="assignedUserId" defaultValue={user.id}>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <Field label="受付票 (1 行に 1 枚)" required className="@xl:col-span-2 @3xl:col-span-4">
                  <Textarea name="sheet" rows={8} required placeholder={"山田 花子, 090-1234-5678, 合志市須屋1234, 和室6畳の表替え\n佐藤 一郎, 096-123-4567, 菊陽町光の森, 網戸の張替"} />
                </Field>
                <div className="@xl:col-span-2 @3xl:col-span-4"><Button type="submit" size="sm" disabled={!ready}>問い合わせとして登録する</Button></div>
              </form>
            </Card>
          )}

          {canEdit && (
            <Card>
              <CardHeader title="販促の内容を変更" />
              <PromotionForm action={updatePromotion.bind(null, p.id)} promotion={p} stores={db.stores} storeLocked={!canSeeAllStores(user)} defaultStore={p.storeId} cancelHref="/promotions?tab=list" submitLabel="更新する" disabled={!ready} />
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="登録" />
            <p className="text-xs text-ink-2">登録 {fmtDateTime(p.createdAt)} · {userName(p.createdBy)}</p>
            {p.updatedAt !== p.createdAt && <p className="text-xs text-ink-2">更新 {fmtDateTime(p.updatedAt)} · {userName(p.updatedBy)}</p>}
            {canEdit && (
              <form action={deletePromotion.bind(null, p.id)} className="mt-3">
                <Button type="submit" size="sm" variant="danger" disabled={!ready || inquiries.length > 0}>削除する</Button>
                {inquiries.length > 0 && <p className="mt-1 text-[11px] text-ink-3">問い合わせがひも付いているため削除できません (中止にできます)</p>}
              </form>
            )}
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-2 text-xs">
              {logs.length === 0 && <li className="text-ink-3">なし</li>}
              {logs.map((l) => (
                <li key={l.id}><span className="text-ink-3 tnum">{fmtDateTime(l.at)}</span> <span className="text-ink">{l.summary}</span> <span className="text-ink-3">({userName(l.userId)})</span></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
