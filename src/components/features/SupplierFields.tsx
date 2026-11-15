import type { Supplier } from "@/lib/db/types";
import { SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { Field, Input, Select, Textarea } from "@/components/ui";

/** 仕入先・協力業者の入力欄 (登録・変更で共通) */
export function SupplierFields({ s }: { s?: Partial<Supplier> }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
        <Field label="名前" required><Input name="name" defaultValue={s?.name} required /></Field>
        <Field label="フリガナ"><Input name="kana" defaultValue={s?.kana} /></Field>
        <Field label="区分">
          <Select name="kind" defaultValue={s?.kind ?? "supplier"}>
            {(Object.keys(SUPPLIER_KIND_LABEL) as (keyof typeof SUPPLIER_KIND_LABEL)[]).map((k) => <option key={k} value={k}>{SUPPLIER_KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="取扱品目・業種"><Input name="category" defaultValue={s?.category === "未分類" ? "" : s?.category} placeholder="例: 畳表 / クロス工事" /></Field>
        <Field label="先方の担当者"><Input name="contactName" defaultValue={s?.contactName} /></Field>
        <Field label="電話"><Input name="phone" defaultValue={s?.phone} /></Field>
        <Field label="FAX"><Input name="fax" defaultValue={s?.fax} /></Field>
        <Field label="メール"><Input name="email" type="email" defaultValue={s?.email} /></Field>
        <Field label="郵便番号"><Input name="postalCode" defaultValue={s?.postalCode} /></Field>
      </div>
      <Field label="住所"><Input name="address" defaultValue={s?.address} /></Field>
      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-medium text-ink">支払条件 (仕入請求書の支払期限を自動で計算します)</legend>
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <Field label="締め日" hint="31 = 末日"><Input name="closingDay" type="number" min={1} max={31} defaultValue={s?.closingDay ?? 31} /></Field>
          <Field label="支払月">
            <Select name="payMonthOffset" defaultValue={s?.payMonthOffset != null ? String(s.payMonthOffset) : ""}>
              <option value="">(文章から読む / 都度払い)</option>
              <option value="0">当月</option>
              <option value="1">翌月</option>
              <option value="2">翌々月</option>
              <option value="3">3 か月後</option>
            </Select>
          </Field>
          <Field label="支払日" hint="31 = 末日"><Input name="payDay" type="number" min={1} max={31} defaultValue={s?.payDay} /></Field>
          <Field label="支払条件 (文章)" hint="例: 月末締め 翌月末払い / 都度払い"><Input name="paymentTerms" defaultValue={s?.paymentTerms} /></Field>
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <Field label="振込先" hint="銀行・支店・種別・口座番号・名義"><Input name="bankInfo" defaultValue={s?.bankInfo} /></Field>
        <Field label="登録番号 (適格請求書)" hint="T + 13 桁"><Input name="registrationNumber" defaultValue={s?.registrationNumber} placeholder="T1234567890123" /></Field>
        <Field label="LINE ユーザー ID" hint="LINE で連絡するとき (U で始まる 33 文字)"><Input name="lineId" defaultValue={s?.lineId} /></Field>
        <Field label="Chatwork ルーム ID" hint="この取引先とのやりとりのルーム (数字)"><Input name="chatworkRoomId" defaultValue={s?.chatworkRoomId} /></Field>
      </div>
      <Field label="メモ"><Textarea name="notes" defaultValue={s?.notes} rows={2} /></Field>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="hidden" name="active" value="off" />
        <input type="checkbox" name="active" value="on" defaultChecked={s?.active !== false} className="h-4 w-4" /> 取引中 (外すと一覧・選択肢に出しません)
      </label>
    </div>
  );
}
