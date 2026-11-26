import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { staffForStore } from "@/lib/staff-choices";
import { canAccessStore, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import { customerOptions } from "@/lib/db/queries";
import { createInquiry } from "@/lib/actions/inquiries";
import { CustomerSearch } from "@/components/features/CustomerSearch";
import { InquiryForm, type InquiryFormCustomer } from "@/components/inquiries/InquiryForm";
import { customerOptionLabel } from "@/lib/duplicates";
import { promotionOptions } from "@/components/ops-reports/MediaFields";
import { caseSummary } from "@/lib/case-group";
import { caseOptionsForCustomer, initialCaseChoice } from "@/lib/case-choice";
import { toDateKey } from "@/lib/format";
import { Card, Flash, Note, PageHeader } from "@/components/ui";

/**
 * 手入力の問い合わせの登録。既存のお客様を選ぶと、そのお客様の案件から「新規案件 / この案件に問い合わせを追加」を選ぶ (お客様のご要望 2026-11-26「■5」)。
 * ?customerId= でお客様、?caseId= で「この案件に問い合わせを追加」を選んだ状態で開く (案件の画面から)
 */
export default async function NewInquiryPage({ searchParams }: { searchParams: Promise<{ err?: string; customerId?: string; cq?: string; caseId?: string }> }) {
  const { err, customerId: qCustomer, cq, caseId } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const today = toDateKey(new Date());
  // 案件の画面から開いたとき: 案件のお客様
  const presetCase = caseId ? caseSummary(db, caseId, today) : undefined;
  const customerId = qCustomer ?? presetCase?.customerId;
  // 選べるお客様: 自店舗 (全店舗ロールは全店舗)、店長は全店舗 (permissions.ts の canEditCaseStore)。受付店舗は自店舗のまま
  const choices = customerOptions(db.customers.filter((c) => canEditCaseStore(user, c.storeId)), cq, customerId);
  const customers: InquiryFormCustomer[] = choices.options.map((c) => ({
    id: c.id,
    label: customerOptionLabel(c),
    name: c.name,
    code: c.code,
    address: c.address || "",
    phone: [c.phone, ...(c.contacts ?? []).map((x) => x.phone)].filter(Boolean).slice(0, 2).join(" / "),
    fallbackStoreId: allStores || canAccessStore(user, c.storeId) ? c.storeId : user.storeId,
  }));
  const preset = customerId ? customers.find((c) => c.id === customerId) : undefined;
  const initialCases = preset ? caseOptionsForCustomer(db, user, preset.id, today) : undefined;
  const initialChoice = initialCases ? initialCaseChoice(initialCases, presetCase && presetCase.customerId === preset?.id ? presetCase.id : undefined) : "new";
  // 担当者の選択肢: 自店舗の社員 + 本部の社員 (全店舗共通。お客様のご要望 2026-11-24「④」)。案件に追加するときの案件の担当も選べるように
  const owners = initialCases ? [...initialCases.open, ...initialCases.past].map((c) => c.ownerId).filter((x): x is string => Boolean(x)) : [];
  const base = allStores ? db.users.filter((u) => u.active) : staffForStore(db, user.storeId, owners);
  const users = base.map((u) => ({ id: u.id, label: `${u.name}${u.title ? ` (${u.title})` : ""}` }));
  const promotions = promotionOptions(db.promotions ?? [], (sid) => sid === "hq" || canAccessStore(user, sid));
  return (
    <div className="max-w-3xl">
      <Flash err={err} />
      <PageHeader title="問い合わせを登録" back={presetCase ? { href: presetCase.href, label: `案件 ${presetCase.number}` } : { href: "/inquiries", label: "問い合わせ一覧" }} />
      <Note tone="accent">
        電話・来店 (対面)・郵送・LINE などで受けた問い合わせを手入力で登録します。既存のお客様は「既存顧客を選択」で住所・お名前から選ぶと、そのお客様の進行中の案件・完了した案件が出ます。新しいご依頼なら「新規案件として登録」、同じ案件のご連絡 (日程の変更・クレーム・手直しなど) なら「この案件に問い合わせを追加」を選んでください (どちらも問い合わせ一覧に出ます)。手書きのメモを撮影する・話して入力する・通話の録音から読み取るときは{" "}
        <Link href={preset ? `/inquiries/reception?customer=${preset.id}${presetCase ? `&caseId=${presetCase.id}` : ""}` : "/inquiries/reception"} className="font-medium underline">
          問合せ登録
        </Link>{" "}
        を使うと、AI がお名前・電話・住所・用件を読み取り、登録済みのお客様・進行中の案件も探します。
      </Note>
      <Card className="mt-4">
        {choices.searchable && <CustomerSearch total={choices.total} q={cq} shown={choices.options.filter((c) => c.id !== customerId).length} keep={{ customerId, caseId }} />}
        <InquiryForm
          action={createInquiry}
          customers={customers}
          initialCustomerId={preset?.id ?? ""}
          initialCases={initialCases}
          initialCaseChoice={initialChoice}
          stores={db.stores.map((s) => ({ id: s.id, name: s.name }))}
          userStoreId={user.storeId}
          canChooseAny={allStores}
          users={users}
          defaultAssigneeId={user.id}
          promotions={promotions}
          searchable={choices.searchable}
        />
      </Card>
    </div>
  );
}
