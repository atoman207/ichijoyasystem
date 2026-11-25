import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { staffForStore } from "@/lib/staff-choices";
import { canAccessStore, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import { customerOptions } from "@/lib/db/queries";
import { createInquiry } from "@/lib/actions/inquiries";
import { CustomerSearch } from "@/components/features/CustomerSearch";
import { AreaStoreFields } from "@/components/features/AreaStoreFields";
import { DuplicateWatcher } from "@/components/features/DuplicateWatcher";
import { checkCustomerDuplicates } from "@/lib/actions/customers";
import { customerOptionLabel } from "@/lib/duplicates";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { MediaSelect, PromotionSelect, promotionOptions } from "@/components/ops-reports/MediaFields";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function NewInquiryPage({ searchParams }: { searchParams: Promise<{ err?: string; customerId?: string; cq?: string }> }) {
  const { err, customerId, cq } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  // 選べるお客様: 自店舗 (全店舗ロールは全店舗)、店長は全店舗 (permissions.ts の canEditCaseStore)。受付店舗は自店舗のまま
  const choices = customerOptions(db.customers.filter((c) => canEditCaseStore(user, c.storeId)), cq, customerId);
  const customers = choices.options;
  // 担当者の選択肢: 自店舗の社員 + 本部の社員 (全店舗共通。お客様のご要望 2026-11-24「④」)
  const users = allStores ? db.users.filter((u) => u.active) : staffForStore(db, user.storeId);
  const promotions = promotionOptions(db.promotions ?? [], (sid) => sid === "hq" || canAccessStore(user, sid));
  return (
    <div className="max-w-3xl">
      <Flash err={err} />
      <PageHeader title="問い合わせを登録" back={{ href: "/inquiries", label: "問い合わせ一覧" }} />
      <Note tone="accent">電話・来店 (対面)・郵送・LINE などで受けた問い合わせを手入力で登録します。既存のお客様の新規案件は、受注番号は不要です。「既存顧客を選択」で住所・お名前から選んでください (同じ氏名・電話でも住所が違うことがあります)。手書きのメモを撮影する・話して入力する・通話の録音から読み取るときは <Link href="/inquiries/reception" className="font-medium underline">問合せ登録</Link> を使うと、AI がお名前・電話・住所・用件を読み取り、登録済みのお客様・進行中の案件も探します。</Note>
      <Card className="mt-4">
        {choices.searchable && <CustomerSearch total={choices.total} q={cq} shown={customers.filter((c) => c.id !== customerId).length} keep={{ customerId }} />}
        <form action={createInquiry} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="既存顧客を選択" hint={choices.searchable ? "上の検索 (住所・町名が確実) で候補を表示。未登録のお客様は下の氏名欄に入力" : "未登録のお客様は下の氏名欄に入力。候補の住所を確かめて選んでください"}>
              <Select name="customerId" defaultValue={customerId ?? ""}>
                <option value="">(新規のお客様)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{customerOptionLabel(c)}</option>
                ))}
              </Select>
            </Field>
            <Field label="お客様名 (新規の場合)">
              <Input name="contactName" placeholder="例: 坂本 幸子" />
            </Field>
            <Field label="連絡先電話番号 (新規の場合)">
              <Input name="contactPhone" placeholder="090-0000-0000" />
            </Field>
            <Field label="受付日時" hint="省略すると現在の日時。郵送で届いた日や、後から入力する電話の時刻を指定できます">
              <Input name="receivedAt" type="datetime-local" />
            </Field>
            <Field label="入口 (どこから来た問い合わせか)" required>
              <Select name="channel" defaultValue="phone">
                {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
                  <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
                ))}
              </Select>
            </Field>
            <Field label="媒体 (当社を知ったきっかけ)" required hint="お客様に「何を見てご連絡いただきましたか」と聞いて選びます。聞けなかったときは「不明」">
              <MediaSelect name="media" required />
            </Field>
            <Field label="きっかけの販促 (チラシ・イベントなど)" hint="販促の記録にあるチラシ・イベント・DM から来た問い合わせなら選びます (任意)">
              <PromotionSelect name="promotionId" options={promotions} />
            </Field>
            <Field label="種別">
              <Select name="category" defaultValue="tatami">
                {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </Select>
            </Field>
            {/* 住所から担当店舗 (施工・売上計上の店舗) を自動で選ぶ (お客様のご要望 2026-11-24「③」)。手で変えられる */}
            <AreaStoreFields stores={db.stores.map((s) => ({ id: s.id, name: s.name }))} defaultStoreId={user.storeId} canChooseAny={allStores} hint="町名まで入れると担当店舗が決まります (番地はあとからでも可)" />
            {/* 依頼主の住所と施工現場の住所を分ける (お客様のご要望 2026-11-25「⑨」: 業者・ご実家などの依頼。予定表の町名・地図は現場の住所) */}
            <Field label="施工現場の住所 (依頼主の住所と違うとき)" hint="業者からの依頼の現場・ご実家など。予定表の町名と地図 (Google マップ・住宅地図) はこの住所になります。空欄なら依頼主の住所">
              <Input name="siteAddress" placeholder="例: 熊本県合志市須屋 123-4 (現場)" />
            </Field>
            <Field label="担当者">
              <Select name="assignedUserId" defaultValue={user.id}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.title})</option>)}
              </Select>
            </Field>
          </div>
          <DuplicateWatcher check={checkCustomerDuplicates} requireConfirm={false} fields={{ name: "contactName", phone: "contactPhone" }} hint="既存の顧客の場合は、上の「既存顧客を選択」で選ぶと履歴がつながります" />
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
