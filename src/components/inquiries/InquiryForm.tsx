"use client";

import { useEffect, useState } from "react";
import type { StoreId } from "@/lib/db/types";
import type { CaseOption } from "@/lib/case-choice";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { MEDIA, MEDIA_KEYS } from "@/lib/media";
import { checkCustomerDuplicates } from "@/lib/actions/customers";
import { loadCustomerCases } from "@/lib/actions/inquiries";
import { AutoStoreSelect } from "@/components/features/AutoStoreSelect";
import { DuplicateWatcher } from "@/components/features/DuplicateWatcher";
import { PromotionSelect, type PromotionOption } from "@/components/ops-reports/MediaFields";
import { CaseChoice } from "./CaseChoice";
import { Button, Field, FormActions, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { StaffOptions } from "@/components/features/StaffOptions";
import type { StaffChoiceGroup } from "@/lib/staff-choices";

export interface InquiryFormCustomer {
  id: string;
  label: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  /** 住所で担当店舗が決まらないときの店舗 (お客様の店舗。扱えない店舗なら自店舗) */
  fallbackStoreId: StoreId;
}

type Cases = { open: CaseOption[]; past: CaseOption[]; pastTotal: number };

/**
 * 手入力の問い合わせの登録 (/inquiries/new)。同じ情報は 1 回だけ入れる (お客様のご要望 2026-11-26「■2」):
 * - 既存のお客様を選んだら、お客様名・電話・住所の欄は出さない (お客様の情報を使う)。担当店舗はお客様の住所 (施工現場の住所があればそちら) の担当エリアから自動
 * - 既存のお客様の進行中の案件・完了した案件を出し、「新規案件として登録」か「この案件に問い合わせを追加」を選ぶ (■5。CaseChoice)。
 *   案件に追加するときは、担当店舗・媒体・担当者の初期値を案件の店舗・媒体・担当にする (手で選んだ値はそのまま)
 * 送る項目は actions/inquiries.ts の createInquiry (caseId = "new" / 案件の ID)
 */
export function InquiryForm({
  action,
  customers,
  initialCustomerId = "",
  initialCases,
  initialCaseChoice = "new",
  stores,
  userStoreId,
  canChooseAny,
  users,
  defaultAssigneeId,
  promotions,
  searchable,
}: {
  action: (formData: FormData) => Promise<void>;
  customers: InquiryFormCustomer[];
  initialCustomerId?: string;
  initialCases?: Cases;
  initialCaseChoice?: string;
  stores: { id: StoreId; name: string }[];
  userStoreId: StoreId;
  canChooseAny: boolean;
  /** 担当者の選択肢 (施工店舗 → 本部 → ほかの店舗。src/lib/staff-choices.ts の staffChoiceGroups) */
  users: StaffChoiceGroup[];
  defaultAssigneeId: string;
  promotions: PromotionOption[];
  /** お客様が多く、上の検索で候補を絞る画面 */
  searchable: boolean;
}) {
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [cases, setCases] = useState<Record<string, Cases | null>>(initialCustomerId && initialCases ? { [initialCustomerId]: initialCases } : {});
  // 選んだ案件はお客様ごと (選んでいなければ提案: 進行中の案件が 1 件だけならその案件)
  const [choices, setChoices] = useState<Record<string, string>>(initialCustomerId ? { [initialCustomerId]: initialCaseChoice } : {});
  const [media, setMedia] = useState<string | null>(null);
  const [assigneePicked, setAssigneePicked] = useState<string | null>(null);
  const customer = customers.find((c) => c.id === customerId);
  const loaded = customerId ? cases[customerId] : undefined;
  const loading = Boolean(customerId) && loaded === undefined;

  // 選んだお客様の案件を読む (はじめに開いたお客様の案件はサーバーで用意済み)
  useEffect(() => {
    if (!customerId || cases[customerId] !== undefined) return;
    let live = true;
    loadCustomerCases(customerId)
      .then((r) => live && setCases((m) => ({ ...m, [customerId]: r })))
      .catch(() => live && setCases((m) => ({ ...m, [customerId]: null })));
    return () => {
      live = false;
    };
  }, [customerId, cases]);

  const pickCustomer = (id: string) => setCustomerId(id);
  const suggestedId = loaded ? (loaded.open.length === 1 && loaded.open[0].canAdd ? loaded.open[0].id : "new") : undefined;
  const raw = customerId ? (choices[customerId] ?? suggestedId ?? "new") : "new";
  const choice = loaded && (raw === "new" || [...loaded.open, ...loaded.past].some((c) => c.id === raw && c.canAdd)) ? raw : "new";
  const setCaseChoice = (v: string) => setChoices((m) => ({ ...m, [customerId]: v }));
  const option = loaded && choice !== "new" ? [...loaded.open, ...loaded.past].find((c) => c.id === choice) : undefined;
  const owner = option?.ownerId && users.some((g) => g.users.some((u) => u.id === option.ownerId)) ? option.ownerId : undefined;
  const assignee = assigneePicked ?? owner ?? defaultAssigneeId;
  const mediaValue = media ?? option?.media ?? "";

  return (
    <form action={action} className="space-y-5">
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <Field label="既存顧客を選択" hint={searchable ? "上の検索 (住所・町名が確実) で候補を表示。未登録のお客様は「(新規のお客様)」のまま右の欄に入力" : "未登録のお客様は「(新規のお客様)」のまま右の欄に入力。候補の住所を確かめて選んでください"}>
          <Select name="customerId" value={customerId} onChange={(e) => pickCustomer(e.target.value)} data-testid="inquiry-customer">
            <option value="">(新規のお客様)</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        {customer ? (
          <div className="rounded-lg border border-good/40 bg-good-soft/30 px-3 py-2 text-sm" data-testid="inquiry-customer-card">
            <div className="font-semibold text-ink">
              {customer.name} 様 <span className="text-[11px] font-normal text-ink-3">{customer.code}</span>
            </div>
            <div className="text-ink-2">{customer.address || "住所未登録"}</div>
            {customer.phone && <div className="text-xs text-ink-2 tnum">{customer.phone}</div>}
            <p className="mt-1 text-[11px] text-ink-3">お客様の情報 (お名前・電話・住所) はそのまま使います。違うときは顧客の画面で直してください。</p>
          </div>
        ) : (
          <Field label="お客様名 (新規の場合は顧客としても登録します)">
            <Input name="contactName" placeholder="例: 坂本 幸子" />
          </Field>
        )}
        {!customer && (
          <Field label="連絡先電話番号 (新規の場合)">
            <Input name="contactPhone" placeholder="090-0000-0000" />
          </Field>
        )}
        {!customer && (
          <Field label="お客様の住所 (新規の場合)" hint="町名まで入れると担当店舗が決まります (番地はあとからでも可)">
            <Input name="address" placeholder="例: 熊本県〇〇市〇〇町1-2" maxLength={200} autoComplete="off" />
          </Field>
        )}
      </div>

      {customer && (
        <>
          {loading && <p className="text-xs text-ink-3">{customer.name} 様の案件を読み込んでいます…</p>}
          {loaded === null && <p className="text-xs text-warn-ink">案件を読み込めませんでした。新しい案件として登録します。</p>}
          {loaded && <CaseChoice value={choice} onChange={setCaseChoice} open={loaded.open} past={loaded.past} pastTotal={loaded.pastTotal} customerName={customer.name} suggestedId={suggestedId} />}
          {!loaded && <input type="hidden" name="caseId" value="new" />}
        </>
      )}

      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <Field label="受付日時" hint="省略すると現在の日時。郵送で届いた日や、後から入力する電話の時刻を指定できます">
          <Input name="receivedAt" type="datetime-local" />
        </Field>
        <Field label="入口 (どこから来た問い合わせか)" required>
          <Select name="channel" defaultValue="phone">
            {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="媒体 (当社を知ったきっかけ)" required hint={media === null && option?.media ? "追加する案件の媒体にしています。違うときは選び直してください" : "お客様に「何を見てご連絡いただきましたか」と聞いて選びます。聞けなかったときは「不明」"}>
          <Select name="media" value={mediaValue} onChange={(e) => setMedia(e.target.value)} required data-testid="inquiry-media">
            <option value="">選んでください</option>
            {MEDIA_KEYS.map((k) => (
              <option key={k} value={k} title={MEDIA[k].hint}>
                {MEDIA[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="きっかけの販促 (チラシ・イベントなど)" hint="販促の記録にあるチラシ・イベント・DM から来た問い合わせなら選びます (任意)">
          <PromotionSelect name="promotionId" options={promotions} />
        </Field>
        <Field label="種別">
          <Select name="category" defaultValue="tatami">
            {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        {/* 依頼主の住所と施工現場の住所を分ける (お客様のご要望 2026-11-25「⑨」: 業者・ご実家などの依頼。予定表の町名・地図は現場の住所) */}
        <Field label="施工現場の住所 (依頼主の住所と違うとき)" hint="業者からの依頼の現場・ご実家など。予定表の町名と地図 (Google マップ・住宅地図) はこの住所になります。空欄なら依頼主の住所">
          <Input name="siteAddress" placeholder="例: 熊本県合志市須屋 123-4 (現場)" maxLength={200} autoComplete="off" />
        </Field>
        {/* 住所 (施工現場 → お客様の住所) から担当店舗 (施工・売上計上の店舗) を自動で選ぶ (お客様のご要望 2026-11-24「③」)。案件に追加するときは案件の店舗。手で変えられる */}
        <AutoStoreSelect
          stores={stores}
          canChooseAny={canChooseAny}
          fallbackStoreId={customer?.fallbackStoreId ?? userStoreId}
          choices={[userStoreId]}
          watch={["siteAddress", "address"]}
          fallbackAddress={customer?.address ?? ""}
          caseStore={option ? { id: option.storeId, name: option.storeName, number: option.number } : undefined}
        />
        <Field label="担当者">
          <Select name="assignedUserId" value={assignee} onChange={(e) => setAssigneePicked(e.target.value)}>
            <StaffOptions groups={users} mark={owner ? { [owner]: " (案件の担当)" } : undefined} />
          </Select>
        </Field>
      </div>
      {!customer && <DuplicateWatcher check={checkCustomerDuplicates} requireConfirm fields={{ name: "contactName", phone: "contactPhone", address: "address" }} hint="既存の顧客の場合は、上の「既存顧客を選択」で選ぶと履歴がつながります。新しいお客様は、登録と同時に顧客としても登録します" />}
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
        <LinkButton href="/inquiries" variant="secondary">
          キャンセル
        </LinkButton>
        <Button type="submit">{option ? `案件 ${option.number} に問い合わせを追加する` : "登録する"}</Button>
      </FormActions>
    </form>
  );
}
