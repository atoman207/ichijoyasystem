import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { canRecordTidyCheck, canViewAllTidyChecks } from "@/lib/auth/permissions";
import { fmtScore, frequentNg, monthsBack, openFollowUps, scoreTone, tidySettings, tidySummary, visibleTidyChecks } from "@/lib/tidy";
import { pendingLinePhotos } from "@/lib/line-photos";
import { postTablesReady } from "@/lib/posts-tables";
import { fmtDate, toDateKey } from "@/lib/format";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { Badge, Card, CardHeader, Flash, LinkButton, Note, PageHeader, Pager, StoreTag, paginate } from "@/components/ui";

export const metadata: Metadata = { title: "KPI · 整理整頓" };

/** KPI → 整理整頓 (店舗 × 月の点数・要改善の対応・チェックの一覧。src/lib/tidy.ts) */
export default async function TidyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const n = sp.months === "3" ? 3 : sp.months === "12" ? 12 : 6;
  const months = monthsBack(today, n);
  const all = visibleTidyChecks(db, user);
  const wide = canViewAllTidyChecks(user);
  const stores = db.stores.filter((s) => (wide ? s.kind === "store" || all.some((c) => c.storeId === s.id) : s.id === user.storeId));
  const store = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : "";
  const inStore = all.filter((c) => !store || c.storeId === store);
  const inPeriod = inStore.filter((c) => c.date.slice(0, 7) >= months[0]);
  const summary = tidySummary(inPeriod, (store ? stores.filter((s) => s.id === store) : stores).map((s) => s.id), months);
  const follow = openFollowUps(inStore, today);
  const freq = frequentNg(inPeriod);
  const rows = [...inPeriod].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const paged = paginate(rows, sp.page, 50);
  const settings = tidySettings(db);
  const canRecord = db.stores.some((s) => canRecordTidyCheck(user, s.id));
  const linePhotos = pendingLinePhotos(db, user, "tidy").length;
  const q = (k: Record<string, string>) => {
    const u = new URLSearchParams();
    const v = { months: String(n), store, ...k };
    for (const [key, val] of Object.entries(v)) if (val && !(key === "months" && val === "6")) u.set(key, val);
    const s = u.toString();
    return `/kpi/tidy${s ? `?${s}` : ""}`;
  };
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="KPI · 整理整頓"
        description={`店舗の整理整頓チェックの記録と、要改善の対応の状況です。点数 = 良い ÷ (良い + 要改善) × 100 (対象外は数えません)。${wide ? "店長・本部・管理者は全店舗を見られます" : "所属店舗の記録を見られます"}。インセンティブには入りません`}
        actions={
          <>
            {canRecord && <LinkButton href="/kpi/tidy/new" size="sm">チェックを記録する</LinkButton>}
            <LinkButton href="/kpi/tidy/items" size="sm" variant="secondary">チェック項目{settings.provisional ? " (暫定)" : ""}</LinkButton>
          </>
        }
      />
      <KpiTabs current="/kpi/tidy" sp={sp} user={user} />
      {!postTablesReady(["tidy_checks"]) && <Note tone="warn">整理整頓チェックの表 (tidy_checks) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するまで記録できません。</Note>}
      {settings.provisional && <Note>いまのチェック項目 ({settings.items.length} 項目) は暫定です。お客様が使っているチェック項目の資料をいただいたら、管理者が「チェック項目」で差し替えます (1 行に 1 項目を貼り付け)。</Note>}
      {linePhotos > 0 && <Note>LINE の「整理整頓の確認」グループに、まだチェックに付けていない写真が {linePhotos} 枚あります。「チェックを記録する」の画面で選べます。</Note>}

      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        {[3, 6, 12].map((m) => <Link key={m} href={q({ months: String(m) })} className={`rounded-full px-2.5 py-1 ${n === m ? "bg-accent-soft font-semibold text-accent-ink" : "bg-subtle text-ink-2"}`}>{m} か月</Link>)}
        {stores.length > 1 && (
          <span className="ml-auto flex flex-wrap gap-1">
            <Link href={q({ store: "" })} className={`rounded-full px-2 py-1 ${!store ? "bg-ink text-white" : "bg-subtle text-ink-2"}`}>全店</Link>
            {stores.map((s) => <Link key={s.id} href={q({ store: s.id })} className={`rounded-full px-2 py-1 ${store === s.id ? "bg-ink text-white" : "bg-subtle text-ink-2"}`}>{s.shortName}</Link>)}
          </span>
        )}
      </div>

      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title="店舗 × 月の点数" description="セルは平均点 (チェックの回数)。要改善の件数は回数の下" /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">店舗</th>{months.map((m) => <th key={m} className="px-2 py-2 text-right font-medium tnum">{Number(m.slice(5))} 月</th>)}</tr></thead>
            <tbody>
              {[...summary.entries()].map(([sid, cells]) => (
                <tr key={sid} className="border-t border-line">
                  <td className="px-4 py-2"><StoreTag store={db.stores.find((s) => s.id === sid)} short /></td>
                  {months.map((m) => {
                    const c = cells.get(m)!;
                    return (
                      <td key={m} className="px-2 py-2 text-right align-top">
                        {c.count ? (
                          <>
                            <Badge tone={scoreTone(c.avg)} dot={false}>{fmtScore(c.avg)}</Badge>
                            <div className="mt-0.5 text-[11px] text-ink-3 tnum">{c.count} 回{c.ng ? ` · 要改善 ${c.ng}` : ""}</div>
                          </>
                        ) : (
                          <span className="text-xs text-ink-3">-</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] text-ink-3">90 点以上は緑・70 点以上は黄・それより下は橙で表示します。</p>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card id="followups">
          <CardHeader title={`直していない要改善 (${follow.length} 件)`} description="期限の近い順。直したらチェックの画面で「直した」を押してください" />
          {follow.length === 0 ? (
            <p className="text-xs text-ink-3">直していない要改善はありません。</p>
          ) : (
            <ul className="divide-y divide-line">
              {follow.slice(0, 30).map(({ check, item, overdue }) => (
                <li key={`${check.id}:${item.key}`} className="flex flex-wrap items-start gap-2 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink">{item.label}</div>
                    <div className="text-ink-3"><Link href={`/kpi/tidy/${check.id}#followups`} className="text-accent hover:underline">{check.number}</Link> · <StoreTag store={db.stores.find((s) => s.id === check.storeId)} short /> · {fmtDate(check.date)}{item.note ? ` · ${item.note}` : ""}</div>
                  </div>
                  {item.dueDate ? <Badge tone={overdue ? "critical" : "warn"}>{overdue ? "期限切れ" : "期限"} {fmtDate(item.dueDate)}</Badge> : <Badge tone="neutral">期限なし</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="よく要改善になる項目" description={`この ${n} か月 (回数 / その項目をチェックした回数)`} />
          {freq.length === 0 ? (
            <p className="text-xs text-ink-3">要改善の記録はありません。</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {freq.map((f) => (
                <li key={`${f.group}|${f.label}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink">{f.group ? <span className="text-ink-3">{f.group} · </span> : null}{f.label}</span>
                  <span className="text-xs tnum text-serious-ink">{f.count} / {f.of}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="チェックの一覧" description={`${rows.length} 件 (この ${n} か月)`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">番号</th><th className="px-2 py-2 text-left font-medium">日付</th><th className="px-2 py-2 text-left font-medium">店舗</th><th className="px-2 py-2 text-left font-medium">チェックした人</th><th className="px-2 py-2 text-right font-medium">点数</th><th className="px-2 py-2 text-right font-medium">要改善</th><th className="px-4 py-2 text-left font-medium">写真・コメント</th></tr></thead>
            <tbody>
              {paged.items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-ink-3">この期間の記録はありません{canRecord ? "。「チェックを記録する」から記録します" : ""}</td></tr>}
              {paged.items.map((c) => {
                const open = c.items.filter((i) => i.result === "ng" && i.fixStatus !== "fixed").length;
                return (
                  <tr key={c.id} className="border-t border-line align-top hover:bg-subtle/60">
                    <td className="px-4 py-2"><Link href={`/kpi/tidy/${c.id}`} className="font-medium text-accent hover:underline">{c.number}</Link></td>
                    <td className="px-2 py-2 text-xs tnum">{fmtDate(c.date)}</td>
                    <td className="px-2 py-2"><StoreTag store={db.stores.find((s) => s.id === c.storeId)} short />{c.place && <span className="ml-1 text-xs text-ink-3">{c.place}</span>}</td>
                    <td className="px-2 py-2 text-xs">{userName(c.checkedBy)}</td>
                    <td className="px-2 py-2 text-right"><Badge tone={scoreTone(c.score)} dot={false}>{fmtScore(c.score)}</Badge></td>
                    <td className="px-2 py-2 text-right text-xs tnum">{c.ngCount}{open ? <span className="block text-serious-ink">未対応 {open}</span> : c.ngCount ? <span className="block text-good-ink">対応済み</span> : null}</td>
                    <td className="max-w-[16rem] px-4 py-2 text-xs text-ink-2">{c.photos.length ? `写真 ${c.photos.length} 枚` : ""}{c.comment ? <span className="block truncate text-ink-3">{c.comment}</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/kpi/tidy" sp={sp} /></div>
      </Card>
    </div>
  );
}
