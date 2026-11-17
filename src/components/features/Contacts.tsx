import Link from "@/components/ui/Link";
import type { CommLog, Database } from "@/lib/db/types";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { CHANNEL_LABEL, DELIVERY_STATUS } from "@/lib/constants";
import { createContactLog, linkContactLog } from "@/lib/actions/contacts";
import { Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";

/** やりとりの手段 (記録できるもの)。メール・LINE・Chatwork は「相手に送信する」で実際に送れる */
const CHANNELS = ["phone", "email", "line", "chatwork", "web", "visit", "mail"] as const;

const RELATED_PATH: Record<string, string> = { inquiry: "/inquiries", quote: "/quotes", order: "/orders", invoice: "/invoices", purchase: "/purchases" };

export function caseLabel(db: Database, c: Pick<CommLog, "relatedType" | "relatedId">): { href: string; label: string } | undefined {
  if (!c.relatedType || !c.relatedId || !RELATED_PATH[c.relatedType]) return undefined;
  const coll: { id: string; number: string }[] | undefined = c.relatedType === "inquiry" ? db.inquiries : c.relatedType === "quote" ? db.quotes : c.relatedType === "order" ? db.orders : c.relatedType === "invoice" ? db.invoices : c.relatedType === "purchase" ? db.purchases : undefined;
  const row = coll?.find((x) => x.id === c.relatedId);
  return row ? { href: `${RELATED_PATH[c.relatedType]}/${row.id}`, label: row.number } : undefined;
}

/**
 * やりとりの記録フォーム
 * fixed: 相手・案件を決めて開く (顧客・協力業者・案件の画面から)。指定がない項目は画面で選ぶ
 */
export function ContactLogForm({
  returnTo,
  customerId,
  supplierId,
  caseRef,
  customers,
  suppliers,
  defaultChannel = "phone",
  canSend,
  lineGroups,
}: {
  returnTo: string;
  customerId?: string;
  supplierId?: string;
  caseRef?: string;
  customers?: { id: string; label: string }[];
  suppliers?: { id: string; label: string }[];
  defaultChannel?: (typeof CHANNELS)[number];
  canSend: boolean;
  /** この案件にひも付いた LINE グループ (手段が LINE で送信するとき、グループに送れる) */
  lineGroups?: { id: string; label: string }[];
}) {
  return (
    <form action={createContactLog} className="space-y-3">
      <input type="hidden" name="returnTo" value={returnTo} />
      {customerId && <input type="hidden" name="customerId" value={customerId} />}
      {supplierId && <input type="hidden" name="supplierId" value={supplierId} />}
      {(!customerId && customers) || (!supplierId && suppliers) ? (
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          {!customerId && customers && (
            <Field label="お客様">
              <Select name="customerId" defaultValue="">
                <option value="">(なし)</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </Field>
          )}
          {!supplierId && suppliers && (
            <Field label="協力業者・仕入先">
              <Select name="supplierId" defaultValue="">
                <option value="">(なし)</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </Field>
          )}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
        <Field label="手段">
          <Select name="channel" defaultValue={defaultChannel}>
            {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </Select>
        </Field>
        <Field label="向き">
          <Select name="direction" defaultValue="outbound">
            <option value="outbound">こちらから (発信)</option>
            <option value="inbound">相手から (受信)</option>
          </Select>
        </Field>
        <Field label="日時 (空欄は今)"><Input type="datetime-local" name="at" /></Field>
        <Field label="相手の担当者"><Input name="contactName" placeholder="例: 山田様" /></Field>
      </div>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <Field label="件名"><Input name="subject" placeholder="例: 施工日の調整" /></Field>
        <Field label="案件番号 (紐付け・任意)" hint="INQ- / Q- / O- / INV- / AP- で始まる番号"><Input name="caseRef" defaultValue={caseRef} placeholder="例: O-2026-0012" /></Field>
      </div>
      {canSend && lineGroups && lineGroups.length > 0 && (
        <Field label="LINE の送り先" hint="手段が LINE で「相手に送信する」のとき。グループを選ぶと、現場のグループに投稿します">
          <Select name="lineGroupId" defaultValue="">
            <option value="">相手 (お客様・協力業者) の LINE</option>
            {lineGroups.map((g) => <option key={g.id} value={g.id}>グループ: {g.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="内容" required><Textarea name="body" required rows={3} placeholder="やりとりの内容" /></Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm">記録する</Button>
        {canSend && (
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" name="send" className="h-4 w-4" /> 相手に送信する (メール・LINE・Chatwork。発信のときのみ)
          </label>
        )}
      </div>
    </form>
  );
}

/** やりとりの一覧 (新しい順) */
export function ContactList({ db, logs, showParty = true, returnTo, linkable = false, empty = "やりとりの記録はありません" }: { db: Database; logs: CommLog[]; showParty?: boolean; returnTo: string; linkable?: boolean; empty?: string }) {
  const rows = [...logs].sort((a, b) => b.at.localeCompare(a.at));
  if (!rows.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((c) => {
        const cs = caseLabel(db, c);
        const customer = c.customerId ? db.customers.find((x) => x.id === c.customerId) : undefined;
        const supplier = c.supplierId ? db.suppliers.find((x) => x.id === c.supplierId) : undefined;
        const delivery = c.deliveryId ? db.deliveries.find((d) => d.id === c.deliveryId) : undefined;
        return (
          <li key={c.id} className="py-2 text-sm">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <span className="tnum">{fmtDateTime(c.at)}</span>
              <Badge tone={c.direction === "inbound" ? "info" : "neutral"} dot={false}>{c.direction === "inbound" ? "受信" : "発信"}</Badge>
              <span>{CHANNEL_LABEL[c.channel]}</span>
              {showParty && customer && <Link href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name} 様</Link>}
              {showParty && supplier && <Link href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">{supplier.name}</Link>}
              {c.contactName && <span>({c.contactName})</span>}
              {cs && <Link href={cs.href} className="rounded bg-subtle px-1.5 font-mono text-[11px] text-accent hover:underline">{cs.label}</Link>}
              {delivery && <Badge tone={DELIVERY_STATUS[delivery.status].tone} dot={false}>{DELIVERY_STATUS[delivery.status].label}</Badge>}
              <span>· {userName(c.userId)}</span>
            </div>
            <div className="font-medium text-ink">{c.subject}</div>
            {c.body !== c.subject && <p className="whitespace-pre-wrap text-xs text-ink-2">{c.body}</p>}
            {linkable && (
              <form action={linkContactLog.bind(null, c.id)} className="mt-1 flex flex-wrap items-center gap-1">
                <input type="hidden" name="returnTo" value={returnTo} />
                <input name="caseRef" defaultValue={cs?.label ?? ""} placeholder="案件番号" className="field h-7 w-36 py-0.5 text-xs" aria-label="紐付ける案件番号" />
                <button type="submit" className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-subtle">{cs ? "紐付けを変更" : "案件に紐付け"}</button>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}
