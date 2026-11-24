import Link from "@/components/ui/Link";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { AGING_BUCKETS, receivablesAsOf } from "@/lib/ar-ap";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { Badge, Button, EmptyRow, Field, Input, LinkButton, Note, Select, Stat, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

const isDate = (v?: string): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/**
 * 売掛一覧 (基準日の残高)。売上計上日 (= 施工完了日) に計上した売上 − 基準日までの入金。会計データの仕訳と同じ範囲 (src/lib/ar-ap.ts)
 */
export function ReceivablesTab({ db, user, sp }: { db: Database; user: User; sp: Record<string, string | undefined> }) {
  const all = canSeeAllStores(user);
  const asOf = isDate(sp.asOf) ? sp.asOf : toDateKey(new Date());
  const store = all && db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
  const view = sp.view === "lines" ? "lines" : "customers";
  const inScope = (id: StoreId) => canAccessStore(user, id) && (!store || id === store);
  const { customers, totals } = receivablesAsOf(db, asOf, inScope);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const qs = (extra: Record<string, string>) => new URLSearchParams({ asOf, ...(store ? { store } : {}), ...extra }).toString();
  const lines = customers.flatMap((c) => c.lines.map((l) => ({ ...l, customer: c })));

  return (
    <div className="space-y-4">
      <Note>
        基準日時点の売掛残高です。税理士へ毎月送っている一覧の控えは source/03_売上・実績/税理士送付 にあります (その表の「前残マイナス」は前受金。焦げ付き・自治体経由の前受金で工事待ちの案件も含みます)。ここから CSV を出せます。
      </Note>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="ar" />
        <Field label="基準日"><Input type="date" name="asOf" defaultValue={asOf} /></Field>
        {all && (
          <Field label="店舗">
            <Select name="store" defaultValue={store ?? ""}>
              <option value="">全店舗</option>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="表示">
          <Select name="view" defaultValue={view}>
            <option value="customers">お客様ごと</option>
            <option value="lines">案件ごと</option>
          </Select>
        </Field>
        <Button type="submit" variant="secondary">表示する</Button>
      </form>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label={`売掛残高 (${fmtDate(asOf)} 時点)`} value={yen(totals.balance)} sub={`${totals.customers} 件のお客様 · ${totals.lines} 件`} />
        <Stat label="うち請求済み" value={yen(totals.invoiced)} />
        <Stat label="うち未請求 (締め日前など)" value={yen(totals.uninvoiced)} />
        <Stat label="うち支払期限を過ぎたもの" value={yen(totals.overdue)} tone={totals.overdue > 0 ? "critical" : undefined} />
      </div>
      <div className="flex flex-wrap gap-2">
        <LinkButton href={`/api/finance?${qs({ kind: "ar" })}`} size="sm" download>売掛一覧 CSV (お客様ごと・UTF-8)</LinkButton>
        <LinkButton href={`/api/finance?${qs({ kind: "ar", encoding: "sjis" })}`} variant="secondary" size="sm" download>同 (Shift_JIS)</LinkButton>
        <LinkButton href={`/api/finance?${qs({ kind: "ar_lines" })}`} variant="secondary" size="sm" download>売掛明細 CSV (案件ごと)</LinkButton>
      </div>

      {view === "customers" ? (
        <Table minWidth="min-w-[1040px]">
          <thead>
            <tr>
              <Th>お客様</Th>
              <Th>店舗</Th>
              <Th align="right">売掛残高</Th>
              <Th align="right">請求済み</Th>
              <Th align="right">未請求</Th>
              {AGING_BUCKETS.map((b) => <Th key={b.label} align="right">{b.label}</Th>)}
              <Th>最も古い売上計上日</Th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && <EmptyRow colSpan={6 + AGING_BUCKETS.length}>基準日の売掛残高はありません</EmptyRow>}
            {customers.map((c) => (
              <Tr key={c.customerId}>
                <Td>
                  <Link href={`/customers/${c.customerId}`} className="font-medium hover:text-accent">{c.name}</Link>
                  <div className="flex flex-wrap gap-1 text-[11px] text-ink-3">{c.code}{c.corporate && <Badge tone="info" dot={false}>法人</Badge>}{c.batch && <Badge tone="neutral" dot={false}>まとめ請求</Badge>}</div>
                </Td>
                <Td><span className="flex flex-wrap gap-1">{c.storeIds.map((id) => <StoreTag key={id} store={storeMap.get(id)} short />)}</span></Td>
                <Td align="right" className="font-medium">{yen(c.balance)}</Td>
                <Td align="right" className={c.overdue > 0 ? "text-critical" : undefined}>{yen(c.invoiced)}{c.overdue > 0 && <div className="text-[10px]">期限超過 {yen(c.overdue)}</div>}</Td>
                <Td align="right" className="text-ink-2">{c.uninvoiced ? yen(c.uninvoiced) : "-"}</Td>
                {c.buckets.map((v, k) => <Td key={k} align="right" className={v ? (k >= 3 ? "font-medium text-warn-ink" : undefined) : "text-ink-3"}>{v ? yen(v) : "-"}</Td>)}
                <Td className="text-xs tnum">{fmtDate(c.oldest)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Table minWidth="min-w-[960px]">
          <thead>
            <tr>
              <Th>売上計上日</Th>
              <Th>受注・請求</Th>
              <Th>お客様</Th>
              <Th>店舗</Th>
              <Th align="right">金額</Th>
              <Th align="right">入金済み</Th>
              <Th align="right">残高</Th>
              <Th>請求書</Th>
              <Th align="right">経過日数</Th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && <EmptyRow colSpan={9}>基準日の売掛残高はありません</EmptyRow>}
            {lines.map((l) => (
              <Tr key={`${l.kind}:${l.id}`}>
                <Td className="text-xs tnum">{fmtDate(l.salesDate)}</Td>
                <Td className="font-mono text-xs"><Link href={l.kind === "order" ? `/orders/${l.id}` : `/invoices/${l.id}`} className="text-accent hover:underline">{l.number}</Link><div className="font-sans text-[11px] text-ink-3">{l.title}</div></Td>
                <Td><Link href={`/customers/${l.customerId}`} className="hover:text-accent">{l.customer.name}</Link></Td>
                <Td><StoreTag store={storeMap.get(l.storeId)} short /></Td>
                <Td align="right">{yen(l.amount)}</Td>
                <Td align="right" className="text-ink-2">{l.paid ? yen(l.paid) : "-"}</Td>
                <Td align="right" className="font-medium">{yen(l.balance)}</Td>
                <Td className="text-xs">{l.invoiceId ? <><Link href={`/invoices/${l.invoiceId}`} className="font-mono text-accent hover:underline">{l.invoiceNumber}</Link><div className={l.overdue ? "text-critical" : "text-ink-3"}>発行 {fmtDate(l.invoiceDate)} · 期限 {fmtDate(l.dueDate)}</div></> : <span className="text-ink-3">未請求</span>}</Td>
                <Td align="right" className="text-xs tnum">{l.ageDays} 日</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Note>
        売掛残高 = 売上計上日 (施工完了日) に計上した売上 − 基準日までの入金。会計データ (仕訳) の売掛金と同じ範囲です。請求書の発行日 (法人のまとめ請求の締め日など) とは別に、施工完了の日から売掛金になります。
        経過日数は売上計上日からの日数です。販売管理ソフトから移行した過去の売上は、移行前の会計で処理済みのため含めません。CSV の項目は税理士事務所の形式が分かりしだい合わせます。
      </Note>
    </div>
  );
}
