import type { Store, SurveyResponse } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, SCORE_LABEL, SCORE_QUESTIONS, splitAnswers } from "@/lib/survey";
import { Button, Field, FormActions, Input, LinkButton, Select, Textarea } from "@/components/ui";

/** アンケートの入力・修正フォーム (createSurvey / updateSurvey が読む項目名) */
export function SurveyForm({
  action,
  survey,
  orderRef,
  orderOptions,
  users,
  stores,
  defaults,
  cancelHref,
  submitLabel,
  edit = false,
}: {
  action: (fd: FormData) => Promise<void>;
  survey?: SurveyResponse;
  orderRef?: string;
  orderOptions: { value: string; label: string }[];
  users: { id: string; label: string }[];
  stores: Store[];
  defaults?: { storeId?: string; clerkUserId?: string; salesUserId?: string; deliveryUserIds?: string[] };
  cancelHref: string;
  submitLabel: string;
  edit?: boolean;
}) {
  const s = survey;
  const priorities = s ? (s.priorityList?.length ? s.priorityList : splitAnswers(s.priorities, PRIORITY_OPTIONS)) : [];
  const media = s ? (s.mediaList?.length ? s.mediaList : splitAnswers(s.media, MEDIA_OPTIONS)) : [];
  const otherOf = (text: string | undefined) => text?.match(/その他 \((.*)\)/)?.[1] ?? "";
  const delivery = s ? (s.deliveryUserIds?.length ? s.deliveryUserIds : s.craftsmanUserId ? [s.craftsmanUserId] : []) : (defaults?.deliveryUserIds ?? []);
  const chip = "inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent-ink";
  return (
    <form action={action} className="space-y-5">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-4">
        <Field label="はがき No."><Input name="postcardNo" defaultValue={s?.postcardNo} placeholder="例: 13338 / T698 / H1309" /></Field>
        <Field label="回答日"><Input type="date" name="answeredOn" defaultValue={s?.answeredOn} /></Field>
        <Field label="集計月 (KPI)" hint="はがきを集計する月。空欄 = 回答日 (なければ登録日) の月">
          <Input type="month" name="countMonth" defaultValue={s?.countMonth} />
        </Field>
        <Field label="案件 (受注番号)" hint="はがき No. が売上台帳にあれば、空欄でも自動で探します">
          <Input name="orderRef" list="survey-orders" defaultValue={orderRef} autoComplete="off" placeholder="例: O-2026-0123" />
          <datalist id="survey-orders">{orderOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
        </Field>
      </div>
      {edit && <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" name="unlinkOrder" className="h-4 w-4" /> 案件との紐づけを外す (受注番号を空欄にしたとき)</label>}
      {!edit && (
        <Field label="店舗 (案件が見つからないとき)" className="max-w-xs">
          <Select name="storeId" defaultValue={defaults?.storeId}>
            {stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
          </Select>
        </Field>
      )}

      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-4">
        {SCORE_QUESTIONS.map((q) => (
          <Field key={q.key} label={`${q.no} ${q.label}`} hint={`評価対象: ${q.target}`}>
            <Select name={q.key} defaultValue={s?.[q.key] ? String(s[q.key]) : ""}>
              <option value="">(未回答)</option>
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}. {SCORE_LABEL[n]}</option>)}
            </Select>
          </Field>
        ))}
      </div>

      <fieldset>
        <legend className="label">⑤ ご利用にあたって重視されたこと (複数)</legend>
        <div className="flex flex-wrap gap-1.5">{PRIORITY_OPTIONS.map((o) => <label key={o} className={chip}><input type="checkbox" name="priorityList" value={o} defaultChecked={priorities.includes(o)} className="sr-only" />{o}</label>)}</div>
        <Input name="priorityOther" defaultValue={otherOf(s?.priorities)} placeholder="その他の内容" className="mt-2 max-w-md" />
      </fieldset>
      <fieldset>
        <legend className="label">⑥ 何を見てご依頼いただきましたか (複数)</legend>
        <div className="flex flex-wrap gap-1.5">{MEDIA_OPTIONS.map((o) => <label key={o} className={chip}><input type="checkbox" name="mediaList" value={o} defaultChecked={media.includes(o)} className="sr-only" />{o}</label>)}</div>
        <Input name="mediaOther" defaultValue={otherOf(s?.media)} placeholder="その他の内容 (例: 208号線の店舗を見て)" className="mt-2 max-w-md" />
      </fieldset>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
        <Field label="⑦ 次回も依頼したいか">
          <Select name="wouldUseAgain" defaultValue={/はい/.test(s?.wouldUseAgain ?? "") ? "はい" : /いいえ/.test(s?.wouldUseAgain ?? "") ? "いいえ" : ""}>
            <option value="">(未回答)</option>
            <option value="はい">はい</option>
            <option value="いいえ">いいえ</option>
          </Select>
        </Field>
        <Field label="営業担当 (はがきの記入)"><Input name="salesName" defaultValue={s?.salesName} /></Field>
        <Field label="工事担当 (はがきの記入)"><Input name="craftsmanName" defaultValue={s?.craftsmanName} /></Field>
      </div>
      <Field label="⑧ ご指摘・お褒めの言葉"><Textarea name="comment" defaultValue={s?.comment} rows={3} /></Field>

      <div className="space-y-3 rounded-xl border border-line p-3">
        <div className="text-xs font-medium text-ink">担当者との紐づけ (KPI・インセンティブの集計に使います)</div>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <Field label="営業担当 (② の評価対象)">
            <Select name="salesUserId" defaultValue={s?.salesUserId ?? defaults?.salesUserId ?? ""}>
              <option value="">(未設定)</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </Select>
          </Field>
          <Field label="事務担当 (① 電話対応の担当)">
            <Select name="clerkUserId" defaultValue={s?.clerkUserId ?? defaults?.clerkUserId ?? ""}>
              <option value="">(未設定)</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="label">担当職人 (③ の評価対象・複数可)</legend>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">{users.map((u) => <label key={u.id} className={chip}><input type="checkbox" name="deliveryUserIds" value={u.id} defaultChecked={delivery.includes(u.id)} className="sr-only" />{u.label}</label>)}</div>
        </fieldset>
      </div>

      <FormActions>
        <LinkButton href={cancelHref} variant="secondary">キャンセル</LinkButton>
        <Button type="submit">{submitLabel}</Button>
      </FormActions>
    </form>
  );
}
