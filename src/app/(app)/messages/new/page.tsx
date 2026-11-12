import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { createThread } from "@/lib/actions/messages";
import { ROLE_LABEL, THREAD_KIND_LABEL } from "@/lib/constants";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, PageHeader, Select, Textarea } from "@/components/ui";

export default async function NewThreadPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const users = db.users.filter((u) => u.active && u.id !== user.id);
  return (
    <div className="max-w-3xl">
      <Flash err={sp.err} />
      <PageHeader title="新しい社内連絡" back={{ href: "/messages", label: "社内連絡" }} />
      <Card>
        <form action={createThread} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-3">
            <Field label="種類">
              <Select name="kind" defaultValue={sp.kind ?? "request"}>
                {(Object.keys(THREAD_KIND_LABEL) as (keyof typeof THREAD_KIND_LABEL)[]).map((k) => <option key={k} value={k}>{THREAD_KIND_LABEL[k]}</option>)}
              </Select>
            </Field>
            <Field label="店舗 (任意)">
              <Select name="storeId" defaultValue={canSeeAllStores(user) ? "" : user.storeId}>
                <option value="">全社</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="関連 (任意)">
              <Select name="relatedType" defaultValue={sp.relatedType ?? ""}>
                <option value="">なし</option>
                <option value="inquiry">問い合わせ</option>
                <option value="quote">見積</option>
                <option value="order">受注・施工</option>
                <option value="invoice">請求書</option>
                <option value="expense">経費</option>
                <option value="purchase">仕入請求書</option>
                <option value="customer">顧客</option>
              </Select>
            </Field>
          </div>
          <input type="hidden" name="relatedId" value={sp.relatedId ?? ""} />
          <Field label="件名" required><Input name="title" required placeholder="例: 【依頼】○○様 現地調査の同行" /></Field>
          <Field label="本文" required><Textarea name="body" required className="min-h-[120px]" /></Field>
          <Field label="メンション (通知する相手・複数選択可)">
            <select name="mentions" multiple className="field h-40">
              {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_LABEL[u.role]} / {u.title})</option>)}
            </select>
          </Field>
          <FormActions>
            <LinkButton href="/messages" variant="secondary">キャンセル</LinkButton>
            <Button type="submit">投稿する</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
