import { redirect } from "next/navigation";
import { Download, Scale } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData, canViewReports } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { yen } from "@/lib/format";
import { visibleStores } from "@/lib/management";
import { salesCheck, salesCheckPeriod, salesReference, type SalesCheckCell } from "@/lib/sales-check";
import { saveSalesReference } from "@/lib/actions/sales-check";
import type { StoreId } from "@/lib/db/types";
import { Button, Card, CardHeader, Flash, Input, Note, PageHeader, StoreTag, Table, Td, Textarea, Th, Tr } from "@/components/ui";

/**
 * 売上の照合 (お客様のご要望 2026-11-23「■2」「■5」): 店舗別・月別に、旧システム (売上台帳・販売管理ソフト) から移行した売上と
 * 新システムの売上を並べ、二重計上・台帳だけの売上・旧システムの数字との差を確かめる。集計は src/lib/sales-check.ts
 */
export const maxDuration = 60;

function Csv({ href }: { href: string }) {
  return (
    <a href={href} download className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-subtle hover:text-ink">
      <Download className="h-3 w-3" aria-hidden /> CSV
    </a>
  );
}

const diffCls = (d: number | null) => (d === null ? "text-ink-3" : d === 0 ? "text-good-ink" : "text-critical-ink");
const fmtDiff = (d: number | null) => (d === null ? "-" : d === 0 ? "一致" : `${d > 0 ? "+" : ""}${yen(d)}`);

function Cells({ c, strong }: { c: SalesCheckCell; strong?: boolean }) {
  return (
    <>
      <Td align="right">{yen(c.ledger)}<span className="block text-[11px] text-ink-3">{c.ledgerCount} 件</span></Td>
      <Td align="right">{yen(c.slipOnly)}<span className="block text-[11px] text-ink-3">{c.slipOnlyCount} 件</span></Td>
      <Td align="right">{yen(c.system)}<span className="block text-[11px] text-ink-3">{c.systemCount} 件</span></Td>
      <Td align="right" className={strong ? "font-semibold" : "font-medium"}>{yen(c.after)}</Td>
      <Td align="right" className={c.duplicate ? "text-warn-ink" : "text-ink-3"}>{c.duplicate ? yen(c.duplicate) : "-"}{c.duplicateCount ? <span className="block text-[11px]">{c.duplicateCount} 件</span> : null}</Td>
      <Td align="right" className="text-ink-2">{yen(c.current)}</Td>
      <Td align="right">{c.reference === null ? <span className="text-ink-3">-</span> : yen(c.reference)}</Td>
      <Td align="right" className={`pr-5 ${diffCls(c.diff)}`}>{fmtDiff(c.diff)}</Td>
    </>
  );
}

export default async function SalesCheckPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const db = getDb();
  const sessionUser = await requireUser();
  const user = policyReader(db, sessionUser);
  if (!canViewReports(user)) redirect("/?err=" + encodeURIComponent("売上の照合は店長・本部・管理者が閲覧できます。"));
  const period = salesCheckPeriod(sp);
  const allowed = visibleStores(db, user);
  const storeFilter = sp.store && allowed.includes(sp.store as StoreId) ? (sp.store as StoreId) : undefined;
  const storeIds = storeFilter ? [storeFilter] : allowed;
  const c = salesCheck(db, { from: period.from, to: period.to, stores: storeIds });
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const qs = new URLSearchParams(Object.entries({ from: sp.from, to: sp.to, year: sp.year, store: storeFilter }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const csv = (kind: string) => `/api/sales-check?kind=${kind}${qs ? `&${qs}` : ""}`;
  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ store: storeFilter, ...over }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
    return `/data/sales-check${q ? `?${q}` : ""}`;
  };
  const year = new Date().getFullYear();
  const canEdit = canImportData(sessionUser);
  const ref = salesReference(db);
  const custName = new Map(db.customers.map((x) => [x.id, x.name]));
  const shownLedger = c.ledgerOnly.slice(0, 300);
  const refText = ref.rows.filter((r) => r.month >= period.from && r.month <= period.to && storeIds.includes(r.storeId)).map((r) => `${r.month},${storeMap.get(r.storeId)?.name ?? r.storeId},${r.amount}${r.note ? `,${r.note}` : ""}`).join("\n");

  return (
    <div>
      <PageHeader
        title="売上の照合"
        icon={<Scale />}
        back={{ href: "/data", label: "データ入出力" }}
        description="店舗別・月別に、旧システム (売上台帳・販売管理ソフト) から移行した売上と新システムの売上を並べて確かめます。売上の月は売上計上日 (施工完了日)、金額は税込です"
      />
      <Flash msg={sp.msg} err={sp.err} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-2">期間: <b className="text-ink">{period.label}</b></span>
          <Link href={link({})} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-subtle">直近 12 か月</Link>
          {[year, year - 1, year - 2, year - 3].map((y) => (
            <Link key={y} href={link({ year: String(y) })} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-subtle">{y} 年</Link>
          ))}
          <Link href={link({ from: `${year - 1}-12`, to: `${year}-11` })} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-subtle">{year - 1}/12〜{year}/11 (KPI の期間)</Link>
          <form className="flex flex-wrap items-center gap-1.5" action="/data/sales-check">
            {storeFilter && <input type="hidden" name="store" value={storeFilter} />}
            <Input type="month" name="from" defaultValue={period.from} className="h-8 w-36" aria-label="はじめの月" />
            <span className="text-ink-3">〜</span>
            <Input type="month" name="to" defaultValue={period.to} className="h-8 w-36" aria-label="おわりの月" />
            <Button type="submit" size="sm" variant="secondary">表示</Button>
          </form>
        </div>
        {allowed.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-ink-2">店舗:</span>
            <Link href={link({ store: undefined, from: sp.from, to: sp.to, year: sp.year })} className={`rounded-md border px-2 py-1 ${!storeFilter ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:bg-subtle"}`}>全店舗</Link>
            {allowed.map((s) => (
              <Link key={s} href={link({ store: s, from: sp.from, to: sp.to, year: sp.year })} className={`rounded-md border px-2 py-1 ${storeFilter === s ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:bg-subtle"}`}>{storeMap.get(s)?.name ?? s}</Link>
            ))}
          </div>
        )}
      </Card>

      {c.pairs > 0 ? (
        <Note tone="warn">
          このデータベースには、同じ売上が売上台帳の受注と伝票の受注の 2 件になっている二重計上が {c.pairs.toLocaleString("ja-JP")} 組あります (全期間)。「二重計上」の列がまとめると消える伝票の受注で、「システムの売上」はまとめたあとの値です。
          まとめるのは <Link href="/data" className="text-accent hover:underline">データ入出力 → 売上台帳と売上明細の二重計上をまとめる</Link> (管理者・本部)。
        </Note>
      ) : (
        <Note tone="accent">二重計上 (同じ売上が台帳と伝票の 2 件) はありません。</Note>
      )}

      <Card padded={false} className="mb-4 mt-4">
        <div className="px-5 pt-5">
          <CardHeader title="店舗別の合計" description={`期間内の合計。「システムの売上」= 売上台帳 + 伝票だけ + 新システム (二重計上をまとめたあと)。「${c.referenceLabel}」は下の欄で入れた照合の相手の数字`} action={<Csv href={csv("stores")} />} />
        </div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[1080px]">
          <thead>
            <tr><Th className="pl-5">店舗</Th><Th align="right">売上台帳</Th><Th align="right">伝票だけ</Th><Th align="right">新システム</Th><Th align="right">システムの売上</Th><Th align="right">二重計上</Th><Th align="right">いまの売上</Th><Th align="right">{c.referenceLabel}</Th><Th align="right" className="pr-5">差</Th></tr>
          </thead>
          <tbody>
            {storeIds.map((s) => (
              <Tr key={s}>
                <Td className="pl-5"><StoreTag store={storeMap.get(s)} short /></Td>
                <Cells c={c.storeTotals[s] ?? { ledger: 0, ledgerCount: 0, slipOnly: 0, slipOnlyCount: 0, duplicate: 0, duplicateCount: 0, system: 0, systemCount: 0, current: 0, after: 0, reference: null, diff: null }} />
              </Tr>
            ))}
            {storeIds.length > 1 && (
              <Tr className="bg-subtle/60">
                <Td className="pl-5 font-semibold">合計</Td>
                <Cells c={c.totals} strong />
              </Tr>
            )}
          </tbody>
        </Table>
        <p className="px-5 py-3 text-[11px] text-ink-3">
          売上台帳 = 店舗別の売上台帳から移行した受注 (台帳の行ごと。台帳の月の集計と同じ) / 伝票だけ = 販売管理ソフトの売上明細の伝票で台帳にひも付かなかったもの / 新システム = システムで登録した受注 /
          いまの売上 = 経営ダッシュボードの売上 (二重計上を含む) / 差 = システムの売上 − {c.referenceLabel}
        </p>
      </Card>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5">
          <CardHeader title={`月別${storeFilter ? ` (${storeMap.get(storeFilter)?.name ?? storeFilter})` : " (全店舗)"}`} description="店舗を選ぶとその店舗の月別。CSV は月 × 店舗の行" action={<Csv href={csv("months")} />} />
        </div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[1080px]">
          <thead>
            <tr><Th className="pl-5">月</Th><Th align="right">売上台帳</Th><Th align="right">伝票だけ</Th><Th align="right">新システム</Th><Th align="right">システムの売上</Th><Th align="right">二重計上</Th><Th align="right">いまの売上</Th><Th align="right">{c.referenceLabel}</Th><Th align="right" className="pr-5">差</Th></tr>
          </thead>
          <tbody>
            {c.months.length === 0 && (
              <Tr><Td colSpan={9} className="pl-5 text-ink-3">期間内の売上はありません</Td></Tr>
            )}
            {c.months.map((m) => (
              <Tr key={m.month}>
                <Td className="pl-5 tnum">{m.month.replace("-", "/")}</Td>
                <Cells c={storeFilter ? (m.byStore[storeFilter] ?? m) : m} />
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5">
          <CardHeader
            title={`売上台帳だけにある売上 (${c.ledgerOnly.length.toLocaleString("ja-JP")} 件・${yen(c.ledgerOnly.reduce((a, o) => a + o.total, 0))})`}
            description="売上台帳にあり、販売管理ソフトの伝票とひも付かなかった売上 (二重計上の候補を除く)。売上台帳の場所 (ファイル#シート!行) と照らしてご確認ください"
            action={<Csv href={csv("ledger-only")} />}
          />
        </div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[860px]">
          <thead>
            <tr><Th className="pl-5">売上日</Th><Th>店舗</Th><Th>お客様 (現場名)</Th><Th align="right">金額</Th><Th>受注</Th><Th className="pr-5">売上台帳の場所</Th></tr>
          </thead>
          <tbody>
            {shownLedger.length === 0 && (
              <Tr><Td colSpan={6} className="pl-5 text-ink-3">ありません</Td></Tr>
            )}
            {shownLedger.map((o) => (
              <Tr key={o.id}>
                <Td className="pl-5 tnum">{o.salesDate}</Td>
                <Td><StoreTag store={storeMap.get(o.storeId)} short /></Td>
                <Td>{custName.get(o.customerId) ?? "-"}</Td>
                <Td align="right">{yen(o.total)}</Td>
                <Td><Link href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number}</Link></Td>
                <Td className="pr-5 text-[11px] text-ink-3">{o.sourceRef ?? ""}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {c.ledgerOnly.length > shownLedger.length && <p className="px-5 py-3 text-[11px] text-ink-3">先頭の {shownLedger.length} 件を表示しています。すべては CSV でご確認ください。</p>}
      </Card>

      <Card>
        <CardHeader title={`照合の相手の数字 (${ref.label})`} description="旧システム (販売管理ソフトの月次の売上など) の店舗別・月別の数字を入れると、表の「差」に出ます。12 月は新旧の両方で運用し、月末にここで照合します" />
        {canEdit ? (
          <form action={saveSalesReference} className="space-y-3">
            <input type="hidden" name="qs" value={qs} />
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
              <label className="text-xs text-ink-2">
                相手の名前 (表の見出し)
                <Input name="label" defaultValue={ref.label} placeholder="旧システム" className="mt-1" />
              </label>
              <p className="text-[11px] text-ink-3 @3xl:col-span-2">1 行に「月,店舗,金額 (税込)[,メモ]」。例: 2026-12,合志店,4637600。Excel から 3 列をコピーして貼り付けても読み取ります (タブ区切り)。同じ月・店舗はあとの行で置き換えます。</p>
            </div>
            <Textarea name="rows" rows={6} defaultValue={refText} placeholder={"2026-12,合志店,4637600\n2026-12,中央店,2895000"} className="font-mono text-xs" />
            <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" name="replaceAll" value="1" className="h-4 w-4" /> 入れてある数字をすべて消してから、この内容にする (チェックなし = 入力した月・店舗だけ置き換える)</label>
            <Button type="submit" size="sm">保存</Button>
          </form>
        ) : (
          <Note>数字の入力は管理者・本部スタッフが行います。</Note>
        )}
      </Card>
    </div>
  );
}
