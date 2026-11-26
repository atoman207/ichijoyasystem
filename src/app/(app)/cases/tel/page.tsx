import Link from "@/components/ui/Link";
import { PhoneCall } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { canAccessStore, canEditCaseStore } from "@/lib/auth/permissions";
import { quoteAccessInfo } from "@/lib/case-access";
import { buildCaseMap, caseHref } from "@/lib/case-group";
import { telWaitRows, TEL_AGE_FILTERS } from "@/lib/tel-wait";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { Badge, buttonClass, EmptyRow, Flash, LinkTabs, PageHeader, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

/**
 * TEL待ち一覧 (お客様のご要望 2026-11-26「■6 一つの案件に対する複数見積とTEL待ちの管理」: これまでスプレッドシートで管理していた TEL待ち を、案件を横断して一覧で)。
 * 見積をお渡し・送付してお客様からのご連絡を待っている見積 (受注・失注になっていない。同じ案件の受注より前の見積は除く) を、お渡しした日の古い順に。
 * 行の「案件を開く」で見積の内容・やりとりを確かめ、受注・日程の登録に進む。計算は src/lib/tel-wait.ts
 */

export const dynamic = "force-dynamic";

export default async function TelWaitPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const store = sp.store && db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
  const age = TEL_AGE_FILTERS.find((f) => String(f.days) === sp.age);
  const all = telWaitRows(db, buildCaseMap(db), today).filter((r) => quoteAccessInfo(db, user, r.quote).access !== "none");
  const rows = all.filter((r) => (!store || r.quote.storeId === store) && (!age || r.days >= age.days));
  const userName = (id?: string) => (id ? db.users.find((u) => u.id === id)?.name ?? "" : "");
  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ store, age: age ? String(age.days) : undefined, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `/cases/tel${q.toString() ? `?${q.toString()}` : ""}`;
  };
  const stores = db.stores.filter((s) => all.some((r) => r.quote.storeId === s.id));
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        icon={<PhoneCall />}
        title="TEL待ち一覧"
        description="見積をお渡し・送付して、お客様からのご連絡を待っている見積です (受注・失注になったら一覧から外れます)。お渡しした日の古い順。「案件を開く」で見積の内容・やりとりを確かめて、受注・日程の登録に進めます"
        back={{ href: "/cases", label: "案件の進捗" }}
      />
      <LinkTabs
        current={href({})}
        items={[
          { href: href({ store: undefined }), label: "全店舗", count: all.filter((r) => !age || r.days >= age.days).length },
          ...stores.map((s) => ({ href: href({ store: s.id }), label: s.shortName || s.name, count: all.filter((r) => r.quote.storeId === s.id && (!age || r.days >= age.days)).length })),
        ]}
      />
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-ink-3">お渡ししてから</span>
        <Link href={href({ age: undefined })} className={`rounded-lg px-2.5 py-1 ${!age ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-subtle"}`}>すべて</Link>
        {TEL_AGE_FILTERS.map((f) => (
          <Link key={f.days} href={href({ age: String(f.days) })} className={`rounded-lg px-2.5 py-1 ${age?.days === f.days ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-subtle"}`}>
            {f.label}
          </Link>
        ))}
      </div>
      <Table minWidth="min-w-[1000px]">
        <thead>
          <tr>
            <Th>お渡し</Th>
            <Th>お客様</Th>
            <Th>見積</Th>
            <Th align="right">金額</Th>
            <Th>店舗 · 担当</Th>
            <Th>最後のやりとり</Th>
            <Th>次の連絡</Th>
            <Th><span className="sr-only">操作</span></Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8}>TEL待ちの見積はありません</EmptyRow>}
          {rows.map((r) => {
            const q = r.quote;
            const c = r.customer;
            return (
              <Tr key={q.id}>
                <Td className="text-xs whitespace-nowrap tnum">
                  {fmtDate(r.since)}
                  <div className={r.days >= 30 ? "font-medium text-critical-ink" : r.days >= 14 ? "font-medium text-warn-ink" : "text-ink-3"}>{r.days} 日</div>
                </Td>
                <Td className="min-w-[11rem]">
                  {c ? <Link href={`/customers/${c.id}`} className="font-medium text-ink hover:text-accent">{c.name}</Link> : <span className="text-ink-3">-</span>}
                  {c?.address && <div className="line-clamp-1 text-[11px] text-ink-3">{c.address}</div>}
                  {c?.phone && <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`} className="text-xs text-accent tnum hover:underline">{c.phone}</a>}
                </Td>
                <Td className="min-w-[13rem]">
                  <Link href={`/quotes/${q.id}`} className="font-mono text-xs text-accent hover:underline">{q.number}{q.version > 1 ? ` 第${q.version}版` : ""}</Link>
                  <span className="ml-1 text-[11px] text-ink-3">案件 {r.caseNumber}</span>
                  <div className="text-sm text-ink">{q.title}</div>
                  {r.siblings > 0 && <Badge tone="info" dot={false}>同じ案件の見積 ほか {r.siblings} 件</Badge>}
                  {q.handedOver && q.status === "draft" && <div className="text-[11px] text-ink-3">手書きの見積書をお渡し済み</div>}
                </Td>
                <Td align="right" className="font-semibold tnum">{yen(q.total)}</Td>
                <Td className="text-xs">
                  <StoreTag store={db.stores.find((s) => s.id === q.storeId)} short />
                  <div className="text-ink-2">{userName(q.estimatorId ?? q.createdBy)}</div>
                </Td>
                <Td className="max-w-[16rem] text-xs text-ink-2">
                  {r.lastLog ? (
                    <>
                      <span className="text-ink-3 tnum">{fmtDate(r.lastLog.at)}</span> <span className="line-clamp-2">{r.lastLog.body}</span>
                    </>
                  ) : (
                    <span className="text-ink-3">-</span>
                  )}
                </Td>
                <Td className="text-xs">
                  {r.next ? <span className={r.next.date < today ? "font-medium text-critical-ink" : "text-ink-2"}>{fmtDate(r.next.date)}{r.next.text ? ` ${r.next.text}` : ""}</span> : <span className="text-ink-3">-</span>}
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Link href={caseHref(r.caseId)} className={buttonClass("secondary", "sm")}>案件を開く</Link>
                    {canEditCaseStore(user, q.storeId) && q.status !== "draft" && q.status !== "pending_approval" && <Link href={`/quotes/${q.id}#to-order`} className={buttonClass("primary", "sm")}>受注にする</Link>}
                    {canAccessStore(user, q.storeId) && q.status !== "draft" && q.status !== "pending_approval" && <Link href={`/quotes/${q.id}#to-order`} className={buttonClass("ghost", "sm")} title="見積の画面の「受注登録」の欄の「失注」">失注にする</Link>}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
