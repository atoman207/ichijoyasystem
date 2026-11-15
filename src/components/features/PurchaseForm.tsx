import type { Database, PurchaseInvoice, User } from "@/lib/db/types";
import { canEditSuppliers, canSeeAllStores } from "@/lib/auth/permissions";
import { PURCHASE_ACCOUNTS, SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { isActiveSupplier, supplierKindOf, termsLabel } from "@/lib/suppliers";
import { Button, Field, FormActions, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { PurchaseItemsEditor } from "./PurchaseItemsEditor";

export interface PurchaseFormInitial {
  supplierId?: string;
  newSupplierName?: string;
  storeId?: string;
  invoiceDate?: string;
  dueDate?: string;
  scheduledPayDate?: string;
  amount?: number;
  taxAmount?: number;
  account?: string;
  orderRef?: string;
  supplierInvoiceNo?: string;
  description?: string;
  items?: { name: string; spec?: string; qty?: number; unit?: string; unitPrice?: number }[];
  documentId?: string;
}

/** 仕入請求書の登録・修正のフォーム */
export function PurchaseForm({ db, user, initial, action, cancelHref, mode, back }: { db: Database; user: User; initial: PurchaseFormInitial; action: (fd: FormData) => Promise<void>; cancelHref: string; mode: "create" | "edit"; back: string }) {
  const finance = canSeeAllStores(user);
  const suppliers = db.suppliers.filter((s) => isActiveSupplier(s) || s.id === initial.supplierId).sort((a, b) => supplierKindOf(a).localeCompare(supplierKindOf(b)) || a.name.localeCompare(b.name, "ja"));
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="back" value={back} />
      {initial.documentId && <input type="hidden" name="documentId" value={initial.documentId} />}
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <Field label="仕入先・協力業者" required>
          <Select name="supplierId" defaultValue={initial.supplierId ?? ""}>
            <option value="">{suppliers.length ? "選択してください" : "登録済みの取引先はありません"}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                [{SUPPLIER_KIND_LABEL[supplierKindOf(s)]}] {s.name} ({termsLabel(s)})
              </option>
            ))}
          </Select>
        </Field>
        {mode === "create" && canEditSuppliers(user) ? (
          <Field label="新しい仕入先 (一覧にないとき)" hint="名前だけで登録し、あとで 仕入先・協力業者 の画面で支払条件などを入れます">
            <Input name="newSupplierName" defaultValue={initial.newSupplierName} placeholder="例: ○○畳材 株式会社" />
          </Field>
        ) : (
          <Field label="店舗">
            <Select name="storeId" defaultValue={initial.storeId ?? (finance ? "hq" : user.storeId)} disabled={!finance}>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        {mode === "create" && canEditSuppliers(user) && (
          <Field label="店舗">
            <Select name="storeId" defaultValue={initial.storeId ?? (finance ? "hq" : user.storeId)} disabled={!finance}>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="仕入先の請求書番号"><Input name="supplierInvoiceNo" defaultValue={initial.supplierInvoiceNo} /></Field>
        <Field label="請求日" required><Input type="date" name="invoiceDate" defaultValue={initial.invoiceDate} required /></Field>
        <Field label="支払期限" hint="空欄なら仕入先の締め日・支払日から自動で計算します"><Input type="date" name="dueDate" defaultValue={initial.dueDate} /></Field>
        <Field label="支払予定日" hint="空欄なら支払期限の日に支払う予定にします"><Input type="date" name="scheduledPayDate" defaultValue={initial.scheduledPayDate} /></Field>
        <Field label="勘定科目">
          <Select name="account" defaultValue={initial.account ?? "仕入高"}>
            {PURCHASE_ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
        <Field label="案件 (受注番号・任意)" hint="例: O-2026-0012。案件の進捗にも仕入が記録されます"><Input name="orderRef" defaultValue={initial.orderRef} placeholder="O-" /></Field>
      </div>
      <div>
        <div className="label">仕入内容 (明細)</div>
        <PurchaseItemsEditor initial={initial.items} />
      </div>
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-3">
        <Field label="金額 (税込)" hint="空欄なら明細の合計"><Input type="number" name="amount" defaultValue={initial.amount} min={0} /></Field>
        <Field label="うち消費税" hint="空欄なら 10% として自動計算"><Input type="number" name="taxAmount" defaultValue={initial.taxAmount} min={0} /></Field>
      </div>
      <Field label="摘要 (内容)"><Textarea name="description" defaultValue={initial.description} placeholder="例: 10月分 い草・畳表 / 協力業者 クロス張替え工事" /></Field>
      <FormActions>
        <LinkButton href={cancelHref} variant="secondary">キャンセル</LinkButton>
        <Button type="submit" name="intent" value="save" variant="secondary">{mode === "create" ? "登録のみ" : "修正を保存"}</Button>
        <Button type="submit" name="intent" value="submit">{mode === "create" ? "登録して支払依頼" : "修正して支払依頼"}</Button>
      </FormActions>
    </form>
  );
}

export function purchaseInitial(db: Database, p: PurchaseInvoice): PurchaseFormInitial {
  return {
    supplierId: p.supplierId,
    storeId: p.storeId,
    invoiceDate: p.invoiceDate,
    dueDate: p.dueDate,
    scheduledPayDate: p.scheduledPayDate,
    amount: p.amount,
    taxAmount: p.taxAmount,
    account: p.account,
    orderRef: p.orderId ? db.orders.find((o) => o.id === p.orderId)?.number : undefined,
    supplierInvoiceNo: p.supplierInvoiceNo,
    description: p.description,
    items: p.items,
  };
}
