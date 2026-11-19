import type { Customer, Store, User } from "@/lib/db/types";
import { CHANNEL_LABEL } from "@/lib/constants";
import { Button, Field, FormActions, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { checkCustomerDuplicates } from "@/lib/actions/customers";
import { DuplicateWatcher } from "./DuplicateWatcher";
import { ContactsEditor } from "./ContactsEditor";

export function CustomerForm({
  action,
  customer,
  stores,
  users,
  user,
  cancelHref,
  returnTo,
  changeNote,
}: {
  action: (formData: FormData) => Promise<void>;
  returnTo?: string;
  /** 重要情報の変更に承認が必要なときの案内 (編集の画面) */
  changeNote?: string;
  customer?: Partial<Customer>;
  stores: Store[];
  users: User[];
  user: User;
  cancelHref: string;
}) {
  const allStores = canSeeAllStores(user);
  const storeId = customer?.storeId ?? user.storeId;
  return (
    <form action={action} className="space-y-5">
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <Field label="氏名 / 会社名" required>
          <Input name="name" defaultValue={customer?.name} required placeholder="例: 山田 花子 / 株式会社○○" />
        </Field>
        <Field label="フリガナ">
          <Input name="kana" defaultValue={customer?.kana} placeholder="ヤマダ ハナコ" />
        </Field>
        <Field label="区分">
          <Select name="type" defaultValue={customer?.type ?? "individual"}>
            <option value="individual">個人</option>
            <option value="corporate">法人・施設</option>
          </Select>
        </Field>
        <Field label="担当店舗" hint={allStores ? undefined : "店舗ロールは自店舗に固定されます"}>
          <Select name="storeId" defaultValue={storeId} disabled={!allStores}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="電話番号">
          <Input name="phone" defaultValue={customer?.phone} placeholder="090-0000-0000" />
        </Field>
        <Field label="メールアドレス">
          <Input name="email" type="email" defaultValue={customer?.email} />
        </Field>
        <Field label="LINE ID / 表示名">
          <Input name="lineId" defaultValue={customer?.lineId} />
        </Field>
        <Field label="希望する連絡手段">
          <Select name="preferredChannel" defaultValue={customer?.preferredChannel ?? "phone"}>
            {(["phone", "line", "email", "chatwork", "mail", "visit"] as const).map((c) => (
              <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
            ))}
          </Select>
        </Field>
        <Field label="郵便番号">
          <Input name="postalCode" defaultValue={customer?.postalCode} placeholder="860-0000" />
        </Field>
        <Field label="住所">
          <Input name="address" defaultValue={customer?.address} placeholder="熊本県熊本市..." />
        </Field>
        <Field label="担当者">
          <Select name="assignedUserId" defaultValue={customer?.assignedUserId ?? user.id}>
            {users.filter((u) => allStores || u.storeId === user.storeId || u.id === customer?.assignedUserId).map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.title})</option>
            ))}
          </Select>
        </Field>
        {!customer && (
          <Field label="初回接点 (入口)">
            <Select name="firstContactChannel" defaultValue="phone">
              {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
                <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="タグ" hint="カンマ区切り (例: リピーター, LINE登録)">
          <Input name="tags" defaultValue={customer?.tags?.join(", ")} />
        </Field>
      </div>
      <Field label="ほかの連絡先 (本人以外の電話番号)" hint="夫・姉・祖母・勤務先など、続柄つきで何件でも登録できます。着信・Web フォームの照合と顧客の検索に使います">
        <ContactsEditor initial={customer?.contacts} />
      </Field>
      <DuplicateWatcher check={checkCustomerDuplicates} excludeId={customer?.id} requireConfirm={!customer?.id} />
      <Field label="備考 (駐車・訪問時の注意など)">
        <Textarea name="notes" defaultValue={customer?.notes} />
      </Field>
      <div className="rounded-lg border border-line px-3 py-2.5">
        <label className="inline-flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="tradeStopped" value="1" defaultChecked={Boolean(customer?.tradeStopped)} className="h-4 w-4" />
          取引停止 (見積・受注の登録時に警告を表示します)
        </label>
        <Input name="tradeStopNote" defaultValue={customer?.tradeStopNote} placeholder="理由 (例: 未払いのため 2024-03 から取引停止)" className="mt-2" aria-label="取引停止の理由" />
      </div>
      {changeNote && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft/40 px-3 py-2 text-xs text-ink-2">
          <p>{changeNote}</p>
          <Field label="重要情報を変更する理由 (承認者に伝わります)" className="mt-2">
            <Input name="changeReason" placeholder="例: お客様から電話番号の変更の連絡あり" />
          </Field>
        </div>
      )}
      <FormActions>
        <LinkButton href={cancelHref} variant="secondary">キャンセル</LinkButton>
        <Button type="submit">{customer?.id ? "更新する" : "登録する"}</Button>
      </FormActions>
    </form>
  );
}
