import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditCashEntry, canExportAccounting, canSeeAllStores } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, fmtMonth, toDateKey, yen } from "@/lib/format";
import { CASH_IN_ACCOUNTS, CASH_OUT_ACCOUNTS, CASH_SOURCE_LABEL, EXPENSE_ACCOUNTS } from "@/lib/constants";
import { cashBalance, cashMonth } from "@/lib/cashbook";
import { createCashEntry, deleteCashEntry, updateCashEntry } from "@/lib/actions/cashbook";
import type { StoreId } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, EmptyRow, Field, Flash, Input, LinkButton, Note, PageHeader, Select, Stat, Table, Td, Th, Tr } from "@/components/ui";

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export default async function CashbookPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const all = canSeeAllStores(user);
  const storeId = (all && db.stores.some((s) => s.id === sp.store) ? sp.store : all ? "hq" : user.storeId) as StoreId;
  const today = toDateKey(new Date());
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : today.slice(0, 7);
  const book = cashMonth(db.cashEntries, storeId, month);
  const store = db.stores.find((s) => s.id === storeId);
  const hasOpening = db.cashEntries.some((c) => c.storeId === storeId && c.source === "opening");
  const editId = sp.edit;
  const returnTo = `/cashbook?store=${storeId}&month=${month}`;
  const accountsOut = [...CASH_OUT_ACCOUNTS, ...EXPENSE_ACCOUNTS];

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="現金出納帳"
        description="店舗の手元現金の入出金。現金の入金 (請求・集金)、現金の経費の精算、仕入の現金払いは自動で記帳されます。銀行への預け入れ・小口現金の補充などはここで記帳します"
        actions={canExportAccounting(user) ? <LinkButton href={`/api/accounting?kind=cashbook&store=${storeId}&from=${month}-01&to=${month}-31`} variant="secondary" size="sm" download>この月の出納帳 (CSV)</LinkButton> : undefined}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        {all && (
          <Field label="店舗">
            <Select name="store" defaultValue={storeId}>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="月"><Input type="month" name="month" defaultValue={month} /></Field>
        <Button type="submit" variant="secondary">表示</Button>
        <span className="ml-2 flex gap-2 text-xs">
          <Link href={`/cashbook?store=${storeId}&month=${shiftMonth(month, -1)}`} className="text-accent hover:underline">← 前月</Link>
          <Link href={`/cashbook?store=${storeId}&month=${shiftMonth(month, 1)}`} className="text-accent hover:underline">翌月 →</Link>
        </span>
      </form>
      {!hasOpening && <Note tone="warn">{store?.name} の残高の起点 (繰越) が未登録です。帳簿を始める日の手元現金の額を「繰越」で登録すると、残高が実際の現金と合います。</Note>}
      <div className="my-4 grid grid-cols-2 gap-3 @3xl:grid-cols-5">
        <Stat label="前月からの繰越" value={yen(book.opening)} />
        <Stat label={`${fmtMonth(month)}の入金`} value={yen(book.totalIn)} />
        <Stat label={`${fmtMonth(month)}の出金`} value={yen(book.totalOut)} />
        <Stat label="月末の残高" value={yen(book.closing)} tone={book.closing < 0 ? "critical" : undefined} />
        <Stat label="今日の残高" value={yen(cashBalance(db.cashEntries, storeId, today))} />
      </div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="@4xl:col-span-2">
          <Table minWidth="min-w-[720px]">
            <thead>
              <tr>
                <Th>日付</Th>
                <Th>科目・摘要</Th>
                <Th align="right">入金</Th>
                <Th align="right">出金</Th>
                <Th align="right">残高</Th>
                <Th>記帳</Th>
              </tr>
            </thead>
            <tbody>
              <Tr>
                <Td className="text-xs text-ink-3">{fmtDate(`${month}-01`)}</Td>
                <Td className="text-xs text-ink-3">前月からの繰越</Td>
                <Td />
                <Td />
                <Td align="right" className="font-medium">{yen(book.opening)}</Td>
                <Td />
              </Tr>
              {book.rows.length === 0 && <EmptyRow colSpan={6}>この月の記帳はありません</EmptyRow>}
              {book.rows.map(({ entry: c, balance }) => (
                <Tr key={c.id}>
                  <Td className="text-xs tnum">{fmtDate(c.date)}<div className="font-mono text-[10px] text-ink-3">{c.number}</div></Td>
                  <Td>
                    <div className="text-sm text-ink">{c.account}{c.counterparty ? <span className="text-xs text-ink-3"> · {c.counterparty}</span> : null}</div>
                    <div className="text-xs text-ink-3">{c.description}</div>
                  </Td>
                  <Td align="right" className="text-good-ink">{c.direction === "in" ? yen(c.amount) : ""}</Td>
                  <Td align="right" className="text-critical-ink">{c.direction === "out" ? yen(c.amount) : ""}</Td>
                  <Td align="right" className={`font-medium ${balance < 0 ? "text-critical" : ""}`}>{yen(balance)}</Td>
                  <Td className="text-xs">
                    <Badge tone={c.source === "manual" ? "neutral" : c.source === "opening" ? "accent" : "info"} dot={false}>{CASH_SOURCE_LABEL[c.source]}</Badge>
                    <div className="text-[11px] text-ink-3">{userName(c.recordedBy)}</div>
                    {canEditCashEntry(user, c) && (
                      <div className="mt-1 flex gap-2">
                        {(c.source === "manual" || c.source === "opening") && <Link href={`${returnTo}&edit=${c.id}`} className="text-[11px] text-accent hover:underline">修正</Link>}
                        <form action={deleteCashEntry.bind(null, c.id)}>
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <button type="submit" className="text-[11px] text-critical hover:underline">削除</button>
                        </form>
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {book.byAccount.length > 0 && (
            <Card className="mt-4">
              <CardHeader title="科目別の集計" description={`${fmtMonth(month)} · ${store?.name}`} />
              <table className="w-full text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">科目</th><th className="px-3 py-1.5 text-right font-medium">入金</th><th className="px-3 py-1.5 text-right font-medium">出金</th></tr></thead>
                <tbody>
                  {book.byAccount.map((a) => (
                    <tr key={a.account} className="border-t border-line"><td className="px-3 py-1.5">{a.account}</td><td className="px-3 py-1.5 text-right tnum">{a.in ? yen(a.in) : "-"}</td><td className="px-3 py-1.5 text-right tnum">{a.out ? yen(a.out) : "-"}</td></tr>
                  ))}
                  <tr className="border-t border-line font-medium"><td className="px-3 py-1.5">合計</td><td className="px-3 py-1.5 text-right tnum">{yen(book.totalIn)}</td><td className="px-3 py-1.5 text-right tnum">{yen(book.totalOut)}</td></tr>
                </tbody>
              </table>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          {(() => {
            const editing = editId ? db.cashEntries.find((c) => c.id === editId && c.storeId === storeId) : undefined;
            if (editing && canEditCashEntry(user, editing) && (editing.source === "manual" || editing.source === "opening")) {
              return (
                <Card>
                  <CardHeader title={`${editing.number} を修正`} action={<Link href={returnTo} className="text-xs text-ink-3 hover:underline">閉じる</Link>} />
                  <form action={updateCashEntry.bind(null, editing.id)} className="space-y-2">
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <CashFields direction={editing.direction} opening={editing.source === "opening"} values={editing} accountsOut={accountsOut} />
                    <Button type="submit" size="sm">修正する</Button>
                  </form>
                </Card>
              );
            }
            return null;
          })()}
          <Card>
            <CardHeader title="入金を記帳" description="例: 小口現金の補充・銀行からの引き出し・現金の売上" />
            <form action={createCashEntry} className="space-y-2">
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="direction" value="in" />
              <input type="hidden" name="returnTo" value={returnTo} />
              <CashFields direction="in" accountsOut={accountsOut} />
              <Button type="submit" size="sm">入金を記帳</Button>
            </form>
          </Card>
          <Card>
            <CardHeader title="出金を記帳" description="例: 銀行への預け入れ・現金での少額の支払 (経費の申請が必要なものは経費精算から)" />
            <form action={createCashEntry} className="space-y-2">
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="direction" value="out" />
              <input type="hidden" name="returnTo" value={returnTo} />
              <CashFields direction="out" accountsOut={accountsOut} />
              <Button type="submit" size="sm" variant="secondary">出金を記帳</Button>
            </form>
          </Card>
          {!hasOpening && (
            <Card>
              <CardHeader title="繰越 (残高の起点) を登録" description="帳簿を始める日の手元現金の額 (店舗ごとに 1 回)" />
              <form action={createCashEntry} className="space-y-2">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="kind" value="opening" />
                <input type="hidden" name="returnTo" value={returnTo} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="日付"><Input type="date" name="date" defaultValue={`${month}-01`} required /></Field>
                  <Field label="金額"><Input type="number" name="amount" min={1} required /></Field>
                </div>
                <Field label="摘要"><Input name="description" defaultValue="帳簿の開始時の手元現金" /></Field>
                <Button type="submit" size="sm" variant="secondary">繰越を登録</Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function CashFields({ direction, opening = false, values, accountsOut }: { direction: "in" | "out"; opening?: boolean; values?: { date: string; amount: number; account: string; counterparty?: string; description: string }; accountsOut: readonly string[] }) {
  const today = toDateKey(new Date());
  return (
    <>
      {values && !opening && <input type="hidden" name="direction" value={direction} />}
      <div className="grid grid-cols-2 gap-2">
        <Field label="日付"><Input type="date" name="date" defaultValue={values?.date ?? today} required /></Field>
        <Field label="金額"><Input type="number" name="amount" min={1} defaultValue={values?.amount} required /></Field>
      </div>
      {!opening && (
        <Field label="科目">
          <Select name={direction === "in" ? "accountIn" : "accountOut"} defaultValue={values?.account ?? (direction === "in" ? CASH_IN_ACCOUNTS[1] : CASH_OUT_ACCOUNTS[0])}>
            {(direction === "in" ? CASH_IN_ACCOUNTS : accountsOut).map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
      )}
      <Field label="相手 (任意)"><Input name="counterparty" defaultValue={values?.counterparty} /></Field>
      <Field label="摘要"><Input name="description" defaultValue={values?.description} placeholder={direction === "in" ? "例: 本社から小口現金を補充" : "例: 肥後銀行 合志支店へ預け入れ"} /></Field>
    </>
  );
}
