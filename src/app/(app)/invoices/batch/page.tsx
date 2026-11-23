import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canIssueInvoices } from "@/lib/auth/permissions";
import { fmtDate, fmtMonth, toDateKey, yen } from "@/lib/format";
import { CHANNEL_LABEL, INVOICE_STATUS } from "@/lib/constants";
import { batchGroups, batchTitle, corporateWithoutTerms, termsText } from "@/lib/billing";
import { issueBatchInvoice } from "@/lib/actions/billing";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag } from "@/components/ui";

/**
 * 締め日のまとめ請求 (法人のお客様)。お客様のご指示 2026-11-23「■4」: 法人のお客様は従来どおり締め日ごとにまとめて請求書を発行する。
 * 売上計上日 (= 施工完了日) は案件ごとに決まっていて、請求書の発行日とは別 (src/lib/billing.ts)
 */
export default async function BatchInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  // 既定の対象月: 月の 10 日までは前の月の締め (月末締めの請求を月初に出す)、それより後は今月
  const now = new Date();
  const defaultMonth = now.getDate() <= 10 ? toDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7) : today.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : defaultMonth;
  const inScope = (storeId: Parameters<typeof canAccessStore>[1]) => canAccessStore(user, storeId);
  const groups = batchGroups(db, month, inScope);
  const pending = groups.filter((g) => g.orders.length > 0);
  const issuedOnly = groups.filter((g) => g.orders.length === 0);
  const noTerms = corporateWithoutTerms(db, inScope);
  const can = canIssueInvoices(user);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const returnTo = `/invoices/batch?month=${month}`;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="締め日のまとめ請求"
        description="法人のお客様など「まとめ請求」にしたお客様の、締め日までに施工が完了した案件を 1 枚の請求書にまとめて発行します。売上計上日は案件ごとの施工完了日のまま (請求書の発行日とは別) です"
        back={{ href: "/invoices", label: "請求・入金" }}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="締めの月"><Input type="month" name="month" defaultValue={month} /></Field>
        <Button type="submit" variant="secondary">表示する</Button>
        <span className="text-xs text-ink-3">お客様ごとの締め日 (例: 20日締めは {Number(month.slice(5, 7))}月20日) までに完了した、請求書のない案件を表示します</span>
      </form>

      {!can && <Note>請求書の発行は店長・本部スタッフ・管理者が行います。</Note>}
      {pending.length === 0 && (
        <Card>
          <p className="text-sm text-ink-3">{fmtMonth(month)}の締めで請求する案件はありません。お客様の画面の「請求の締め」で、まとめ請求にするお客様と締め日を設定できます。</p>
        </Card>
      )}

      <div className="space-y-4">
        {pending.map((g) => {
          const lateClose = g.closingDate > today;
          return (
            <Card key={g.key}>
              <CardHeader
                title={<span className="inline-flex flex-wrap items-center gap-2"><Link href={`/customers/${g.customer.id}`} className="hover:text-accent">{g.customer.name}</Link> <StoreTag store={storeMap.get(g.storeId)} short /> <Badge tone="info" dot={false}>{termsText(g.terms)}</Badge></span>}
                description={`締めの期間 ${fmtDate(g.from)}〜${fmtDate(g.to)} · 支払期限 ${fmtDate(g.dueDate)} · ${g.orders.length} 件 · ${yen(g.total)} (税込)${g.terms.note ? ` · ${g.terms.note}` : ""}`}
              />
              {g.issued.length > 0 && (
                <p className="mb-2 text-xs text-ink-2">この締めで発行済み: {g.issued.map((i) => <Link key={i.id} href={`/invoices/${i.id}`} className="mr-2 font-mono text-accent hover:underline">{i.number}</Link>)}</p>
              )}
              <form action={issueBatchInvoice} className="space-y-3">
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="customerId" value={g.customer.id} />
                <input type="hidden" name="storeId" value={g.storeId} />
                <input type="hidden" name="periodFrom" value={g.from} />
                <input type="hidden" name="periodTo" value={g.to} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="bg-subtle text-xs text-ink-2">
                        <th className="w-8 px-2 py-1.5"></th>
                        <th className="px-2 py-1.5 text-left font-medium">受注番号</th>
                        <th className="px-2 py-1.5 text-left font-medium">件名・現場</th>
                        <th className="px-2 py-1.5 text-left font-medium">施工完了日 (売上計上日)</th>
                        <th className="px-2 py-1.5 text-right font-medium">金額 (税込)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.orders.map(({ order: o, earlier }) => (
                        <tr key={o.id} className="border-t border-line">
                          <td className="px-2 py-1.5"><input type="checkbox" name="orderIds" value={o.id} defaultChecked className="h-4 w-4" aria-label={`${o.number} を請求に含める`} disabled={!can} /></td>
                          <td className="px-2 py-1.5 font-mono text-xs"><Link href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number}</Link></td>
                          <td className="px-2 py-1.5">{o.title}{o.siteAddress && o.siteAddress !== g.customer.address ? <div className="text-[11px] text-ink-3">現場: {o.siteAddress}</div> : null}</td>
                          <td className="px-2 py-1.5 text-xs tnum">{fmtDate(o.salesDate)}{earlier && <Badge tone="warn" dot={false}>前の締めの未請求</Badge>}</td>
                          <td className="px-2 py-1.5 text-right tnum">{yen(o.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {can && (
                  <>
                    <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
                      <Field label="請求書の発行日" hint={lateClose ? "締め日がまだ来ていません。締め日より前に発行するときは日付を確かめてください" : "既定は締め日"}><Input type="date" name="issueDate" defaultValue={lateClose ? today : g.to} required /></Field>
                      <Field label="支払期限" hint={termsText(g.terms)}><Input type="date" name="dueDate" defaultValue={g.dueDate} required /></Field>
                      <Field label="送付方法">
                        <Select name="sentVia" defaultValue={g.customer.preferredChannel === "email" ? "email" : "mail"}>
                          {(["mail", "email", "line", "chatwork", "visit"] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                        </Select>
                      </Field>
                      <Field label="件名"><Input name="title" placeholder={batchTitle(g.to, g.orders.length)} /></Field>
                      <Field label="備考 (請求書に印字・任意)" className="@xl:col-span-2 @4xl:col-span-4"><Input name="notes" placeholder="例: 11月分の施工代金をまとめてご請求申し上げます" /></Field>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="submit">チェックした案件でまとめ請求書を発行</Button>
                      <span className="text-[11px] text-ink-3">明細は案件ごとに 1 行 (税込)。消費税は請求書の合計から 1 回だけ計算します (内税)</span>
                    </div>
                  </>
                )}
              </form>
            </Card>
          );
        })}
      </div>

      {issuedOnly.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="この締めで発行済みのまとめ請求" />
          <ul className="space-y-1.5 text-sm">
            {issuedOnly.flatMap((g) => g.issued.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/invoices/${i.id}`} className="font-mono text-xs text-accent hover:underline">{i.number}</Link>
                <span>{g.customer.name}</span>
                <StoreTag store={storeMap.get(i.storeId)} short />
                <StatusBadge value={i.status} map={INVOICE_STATUS} />
                <span className="tnum">{yen(i.total)}</span>
                <span className="text-xs text-ink-3">発行 {fmtDate(i.issueDate)} · 期限 {fmtDate(i.dueDate)} · {i.orderIds?.length ?? 1} 件</span>
              </li>
            )))}
          </ul>
        </Card>
      )}

      {noTerms.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="請求の締めが未設定の法人のお客様" description="施工が完了して請求書のない案件があります。締め日ごとにまとめて請求するお客様は、お客様の画面の「請求の締め」でまとめ請求にしてください (案件ごとに請求するときは受注の画面から発行します)" />
          <ul className="space-y-1 text-sm">
            {noTerms.slice(0, 50).map((r) => (
              <li key={r.customer.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/customers/${r.customer.id}`} className="text-accent hover:underline">{r.customer.name}</Link>
                <span className="text-xs text-ink-3">未請求 {r.count} 件 · {yen(r.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="mt-6"><LinkButton href="/finance?tab=ar" variant="ghost" size="sm">売掛一覧 (請求済み・未請求の残高)</LinkButton></div>
    </div>
  );
}
