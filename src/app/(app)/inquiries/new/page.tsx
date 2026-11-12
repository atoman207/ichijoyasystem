import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { customerOptions } from "@/lib/db/queries";
import { createInquiry } from "@/lib/actions/inquiries";
import { CustomerSearch } from "@/components/features/CustomerSearch";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function NewInquiryPage({ searchParams }: { searchParams: Promise<{ err?: string; customerId?: string; cq?: string }> }) {
  const { err, customerId, cq } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const choices = customerOptions(scopeByStore(user, db.customers), cq, customerId);
  const customers = choices.options;
  const users = db.users.filter((u) => u.active && (allStores || u.storeId === user.storeId));
  return (
    <div className="max-w-3xl">
      <Flash err={err} />
      <PageHeader title="問い合わせを登録" back={{ href: "/inquiries", label: "問い合わせ一覧" }} />
      <Note tone="accent">AI電話受付や Web フォームからの問い合わせは本番環境では自動登録されます。この画面は電話・来店・LINE などを手入力する場合に使います。</Note>
      <Card className="mt-4">
        {choices.searchable && <CustomerSearch total={choices.total} q={cq} shown={customers.filter((c) => c.id !== customerId).length} keep={{ customerId }} />}
        <form action={createInquiry} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="既存顧客を選択" hint={choices.searchable ? "上の検索で候補を表示。未登録のお客様は下の氏名欄に入力" : "未登録のお客様は下の氏名欄に入力"}>
              <Select name="customerId" defaultValue={customerId ?? ""}>
                <option value="">(新規のお客様)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                ))}
              </Select>
            </Field>
            <Field label="お客様名 (新規の場合)">
              <Input name="contactName" placeholder="例: 坂本 幸子" />
            </Field>
            <Field label="連絡先電話番号 (新規の場合)">
              <Input name="contactPhone" placeholder="090-0000-0000" />
            </Field>
            <Field label="入口 (どこから来た問い合わせか)" required>
              <Select name="channel" defaultValue="phone">
                {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
                  <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
                ))}
              </Select>
            </Field>
            <Field label="種別">
              <Select name="category" defaultValue="tatami">
                {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </Select>
            </Field>
            <Field label="受付店舗">
              <Select name="storeId" defaultValue={user.storeId} disabled={!allStores}>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="担当者">
              <Select name="assignedUserId" defaultValue={user.id}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.title})</option>)}
              </Select>
            </Field>
          </div>
          <Field label="問い合わせ内容 (要約)" required>
            <Input name="summary" required placeholder="例: 和室6畳の畳表替え、概算希望" />
          </Field>
          <Field label="詳細">
            <Textarea name="detail" placeholder="希望時期、現場の状況、お客様の要望など" />
          </Field>
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="次のアクション">
              <Input name="nextAction" placeholder="例: 折返し電話で現地調査日を調整" />
            </Field>
            <Field label="期限">
              <Input name="nextActionDue" type="date" />
            </Field>
          </div>
          <FormActions>
            <LinkButton href="/inquiries" variant="secondary">キャンセル</LinkButton>
            <Button type="submit">登録する</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
