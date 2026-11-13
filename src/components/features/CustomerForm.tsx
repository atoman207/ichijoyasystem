import type { Customer, Store, User } from "@/lib/db/types";
import { CHANNEL_LABEL } from "@/lib/constants";
import { Button, Field, FormActions, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { checkCustomerDuplicates } from "@/lib/actions/customers";
import { DuplicateWatcher } from "./DuplicateWatcher";

export function CustomerForm({
  action,
  customer,
  stores,
  users,
  user,
  cancelHref,
}: {
  action: (formData: FormData) => Promise<void>;
  customer?: Customer;
  stores: Store[];
  users: User[];
  user: User;
  cancelHref: string;
}) {
  const allStores = canSeeAllStores(user);
  const storeId = customer?.storeId ?? user.storeId;
  return (
    <form action={action} className="space-y-5">
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
          <Input name="tags" defaultValue={customer?.tags.join(", ")} />
        </Field>
      </div>
      <DuplicateWatcher check={checkCustomerDuplicates} excludeId={customer?.id} requireConfirm={!customer} />
      <Field label="備考 (駐車・訪問時の注意など)">
        <Textarea name="notes" defaultValue={customer?.notes} />
      </Field>
      <FormActions>
        <LinkButton href={cancelHref} variant="secondary">キャンセル</LinkButton>
        <Button type="submit">{customer ? "更新する" : "登録する"}</Button>
      </FormActions>
    </form>
  );
}
