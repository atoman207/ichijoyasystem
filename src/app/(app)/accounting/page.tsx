import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canExportAccounting } from "@/lib/auth/permissions";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { ACCOUNTING_LABEL, JOURNAL_KIND_LABEL, accountingSettings, buildJournal, journalTotals, type JournalKind } from "@/lib/accounting";
import { updateAccountingSettings } from "@/lib/actions/settings-ops";
import type { StoreId } from "@/lib/db/types";
import { Button, Card, CardHeader, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, Table, Td, Th, Tr } from "@/components/ui";

const DETAILS: [string, string][] = [
  ["sales", "売上 (請求書) の明細"],
  ["payments", "入金の明細"],
  ["expenses", "経費の明細"],
  ["purchases", "仕入の明細"],
  ["cashbook", "現金出納帳"],
];

export default async function AccountingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canExportAccounting(user)) redirect("/?err=" + encodeURIComponent("会計データの出力は本部スタッフ・管理者が行います。"));
  const db = getDb();
  const tab = sp.tab === "settings" ? "settings" : "export";
  const now = new Date();
  const lastMonthStart = toDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = toDateKey(new Date(now.getFullYear(), now.getMonth(), 0));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : lastMonthStart;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : lastMonthEnd;
  const store = db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
  const rows = from <= to ? buildJournal(db, { from, to, storeId: store }) : [];
  const totals = journalTotals(rows);
  const settings = accountingSettings(db);
  const qs = (extra: Record<string, string>) => new URLSearchParams({ from, to, ...(store ? { store } : {}), ...extra }).toString();
  const base = "/accounting";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="会計データの出力" description="期間を指定して、会計ソフト・税理士事務所へ渡す仕訳と明細を CSV で出力します。出力はすべて変更履歴に残ります" />
      <LinkTabs current={`${base}?tab=${tab}`} items={[{ href: `${base}?tab=export`, label: "出力" }, { href: `${base}?tab=settings`, label: "科目名・税区分の設定" }]} />

      {tab === "export" && (
        <div className="space-y-4">
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="export" />
            <Field label="期間 (から)"><Input type="date" name="from" defaultValue={from} /></Field>
            <Field label="期間 (まで)"><Input type="date" name="to" defaultValue={to} /></Field>
            <Field label="店舗 (部門)">
              <Select name="store" defaultValue={store ?? ""}>
                <option value="">全店舗</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Button type="submit" variant="secondary">集計する</Button>
          </form>
          {from > to && <Note tone="warn">期間の「から」が「まで」より後になっています。</Note>}
          <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
            <Card className="@4xl:col-span-2">
              <CardHeader title="仕訳の内訳" description={`${fmtDate(from)} 〜 ${fmtDate(to)}${store ? ` · ${db.stores.find((s) => s.id === store)?.name}` : " · 全店舗"} · ${totals.count} 件 · 借方合計 ${yen(totals.debit)} / 貸方合計 ${yen(totals.credit)}`} />
              <Table minWidth="min-w-[480px]">
                <thead><tr><Th>区分</Th><Th>借方 / 貸方</Th><Th align="right">件数</Th><Th align="right">金額</Th></tr></thead>
                <tbody>
                  {(Object.keys(JOURNAL_KIND_LABEL) as JournalKind[]).map((k) => {
                    const t = totals.byKind.find((x) => x.kind === k);
                    const sample = rows.find((r) => r.kind === k);
                    return (
                      <Tr key={k}>
                        <Td className="font-medium">{JOURNAL_KIND_LABEL[k]}</Td>
                        <Td className="text-xs text-ink-2">{sample ? `${sample.debit.account} / ${sample.credit.account}` : "-"}</Td>
                        <Td align="right">{t?.count ?? 0}</Td>
                        <Td align="right">{yen(t?.amount ?? 0)}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
              {rows.length > 0 && (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-accent">先頭の 30 件を見る</summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[720px]">
                      <thead><tr className="bg-subtle text-ink-2"><th className="px-2 py-1 text-left font-medium">日付</th><th className="px-2 py-1 text-left font-medium">借方</th><th className="px-2 py-1 text-left font-medium">貸方</th><th className="px-2 py-1 text-right font-medium">金額</th><th className="px-2 py-1 text-left font-medium">摘要</th></tr></thead>
                      <tbody>
                        {rows.slice(0, 30).map((r, i) => (
                          <tr key={i} className="border-t border-line"><td className="px-2 py-1 tnum">{r.date}</td><td className="px-2 py-1">{r.debit.account}{r.debit.dept ? ` (${r.debit.dept})` : ""}</td><td className="px-2 py-1">{r.credit.account}</td><td className="px-2 py-1 text-right tnum">{yen(r.debit.amount)}</td><td className="px-2 py-1 text-ink-2">{r.memo}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </Card>
            <div className="space-y-4">
              <Card>
                <CardHeader title="仕訳 (CSV)" description="1 行 1 仕訳。科目名・税区分は「科目名・税区分の設定」の内容です" />
                <div className="flex flex-col gap-2">
                  <LinkButton href={`/api/accounting?${qs({ kind: "journal", format: "generic" })}`} size="sm" download>仕訳 (汎用・UTF-8)</LinkButton>
                  <LinkButton href={`/api/accounting?${qs({ kind: "journal", format: "generic", encoding: "sjis" })}`} variant="secondary" size="sm" download>仕訳 (汎用・Shift_JIS)</LinkButton>
                  <LinkButton href={`/api/accounting?${qs({ kind: "journal", format: "yayoi" })}`} variant="secondary" size="sm" download>仕訳 (弥生会計のインポート形式)</LinkButton>
                </div>
                <p className="mt-2 text-[11px] text-ink-3">弥生会計の形式は「仕訳日記帳」のインポート用 (25 項目・見出しなし・Shift_JIS) です。取り込む前に、科目名と税区分が会計ソフトの設定と同じか確かめてください。</p>
              </Card>
              <Card>
                <CardHeader title="明細 (CSV・UTF-8)" description="税理士事務所への確認用・表計算ソフト用" />
                <div className="flex flex-col gap-2">
                  {DETAILS.map(([k, label]) => <LinkButton key={k} href={`/api/accounting?${qs({ kind: k })}`} variant="secondary" size="sm" download>{label}</LinkButton>)}
                </div>
              </Card>
            </div>
          </div>
          <Note>
            仕訳の作り方: 売上は請求書の発行日 (売掛金 / 売上高)、入金は入金日 (現金・普通預金・未収入金 / 売掛金)、経費は経費の日付で承認済み・精算済みのもの (勘定科目 / 未払金) と精算日 (未払金 / 現金・普通預金)、仕入は請求日 (勘定科目 / 買掛金) と支払日 (買掛金 / 普通預金・現金)、現金出納帳は手入力の入出金 (銀行預入など) です。売上台帳から移行した過去の売上 (請求書のない受注) は含めません。
          </Note>
        </div>
      )}

      {tab === "settings" && (
        <Card>
          <CardHeader title="科目名・税区分" description="会計ソフトの勘定科目名・税区分の名前に合わせます。変更は次の出力から使われ、変更履歴に残ります" />
          <form action={updateAccountingSettings} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              {(Object.keys(ACCOUNTING_LABEL) as (keyof typeof ACCOUNTING_LABEL)[]).map((k) => (
                <Field key={k} label={ACCOUNTING_LABEL[k]}><Input name={k} defaultValue={settings[k]} required /></Field>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="storeAsDepartment" defaultChecked={settings.storeAsDepartment} className="h-4 w-4" /> 部門に店舗名を入れる (店舗別に集計する場合)</label>
            <Button type="submit" size="sm">保存</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
