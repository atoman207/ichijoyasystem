import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Megaphone } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canCreateCasePost } from "@/lib/auth/permissions";
import { CASE_POST_CHANNELS, CASE_POST_CHANNEL_LABEL, CASE_POST_CONSENT_LABEL, orderPhotos, postPrefill } from "@/lib/case-posts";
import { createCasePost } from "@/lib/actions/case-posts";
import { aiEnabled } from "@/lib/ai/provider";
import { postTablesReady } from "@/lib/posts-tables";
import { PhotoChecks } from "@/components/case-posts/CasePostParts";
import { Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, StoreTag, Textarea } from "@/components/ui";

export const metadata: Metadata = { title: "施工事例の投稿を作る" };
// AI で投稿文の下書きを作る (src/lib/ai/case-post.ts)
export const maxDuration = 60;

export default async function NewCasePostPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const order = db.orders.find((o) => o.id === sp.order || o.number === sp.order);
  if (!order) notFound();
  if (!canCreateCasePost(user, order.storeId)) redirect(`/orders/${order.id}?err=${encodeURIComponent("施工事例の投稿は、この案件の店舗の担当者・本部・管理者が作れます。")}`);
  const pre = postPrefill(db, order);
  const photos = orderPhotos(db, order.id);
  const store = db.stores.find((s) => s.id === order.storeId);
  const ready = postTablesReady(["case_posts"]);
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="施工事例の投稿を作る"
        icon={<Megaphone />}
        description={<span className="inline-flex flex-wrap items-center gap-2">受注 <Link href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number}</Link> · <StoreTag store={store} /> · {order.title}</span>}
        back={{ href: `/orders/${order.id}`, label: "受注・施工の画面" }}
      />
      {!ready && <Note tone="warn">施工事例の投稿の表 (case_posts) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するまで作れません。</Note>}
      <Note>
        案件の写真・商品名・施工内容から{aiEnabled() ? " AI が" : " (AI のキーがないため定型文で)"}投稿文の下書きを作ります。お客様のお名前・番地・電話番号は AI に渡さず、投稿文にも入れません (地域は町名まで)。下の内容は投稿文の材料で、そのまま投稿されるわけではありません。作ったあとで直せます。
      </Note>
      <form action={createCasePost} className="mt-4 space-y-4">
        <input type="hidden" name="orderId" value={order.id} />
        <Card>
          <CardHeader title="投稿の材料" description="案件の明細・施工内容・施工場所から入れています。必要なら直してください" />
          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            <Field label="見出し" hint="例: 合志市 和室 6 畳の表替え"><Input name="title" defaultValue={pre.title} maxLength={120} /></Field>
            <Field label="地域 (町名まで)" hint="番地・建物名は入れません。空にすると地域を書きません"><Input name="area" defaultValue={pre.area} maxLength={60} /></Field>
            <Field label="商品名 (1 行に 1 つ)"><Textarea name="products" defaultValue={pre.products} rows={5} /></Field>
            <Field label="施工内容"><Textarea name="workContent" defaultValue={pre.workContent} rows={5} /></Field>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            <fieldset>
              <legend className="label">投稿先</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {CASE_POST_CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-sm text-ink-2"><input type="checkbox" name="channels" value={c} defaultChecked={pre.channels.includes(c)} className="h-4 w-4" /> {CASE_POST_CHANNEL_LABEL[c]}</label>
                ))}
              </div>
            </fieldset>
            <Field label="お客様の掲載の了承" hint="お宅と分かる写真は、お客様の了承をいただいてから投稿してください">
              <Select name="consent" defaultValue="unconfirmed">
                {Object.entries(CASE_POST_CONSENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title={`使う写真 (${photos.length} 枚から選ぶ。10 枚まで)`} description="新しい 10 枚を選んでいます。LINE の「施工事例写真」グループの写真は、作ったあとの画面で追加できます" />
          <PhotoChecks photos={photos} selected={pre.photoIds} />
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!ready}>{aiEnabled() ? "AI で投稿文の下書きを作る" : "定型文で下書きを作る"}</Button>
          <span className="text-xs text-ink-3">AI の下書きには数十秒かかることがあります</span>
        </div>
      </form>
    </div>
  );
}
