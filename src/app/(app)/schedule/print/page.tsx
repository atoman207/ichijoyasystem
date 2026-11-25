import Link from "@/components/ui/Link";
import { PdfLink } from "@/components/features/PdfLink";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { isDateKey } from "@/lib/calendar";
import { toDateKey, yen } from "@/lib/format";
import { defaultScheduleStore } from "@/lib/schedule-default";
import { dayDocRows } from "@/lib/day-docs";
import { prepareDayDocs } from "@/lib/actions/day-docs";
import { RECEIPT_METHODS, RECEIPT_METHOD_LABEL } from "@/lib/receipts";
import { ORDER_STATUS } from "@/lib/constants";
import { Button, Card, Flash, Note, PageHeader, StatusBadge, buttonClass } from "@/components/ui";
import { Printer } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * 帳票をまとめて印刷 (お客様のご要望 2026-11-25「⑦ 請求書・領収書の一括印刷」)
 * 日付・店舗を選ぶと、その日の納品・施工・現場見積の案件が並ぶ。案件ごとに 請求書・領収書 (発行する・しない)・見積書 を選び、
 * 「選んだ帳票をまとめる」→ 請求書・領収書がなければ発行 → 「まとめて印刷 (PDF)」で 1 つの PDF を開いて印刷する (src/lib/day-docs.ts)
 */
export default async function SchedulePrintPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const date = sp.date && isDateKey(sp.date) ? sp.date : toDateKey(new Date());
  const store = sp.store === "all" || db.stores.some((s) => s.id === sp.store) ? sp.store! : defaultScheduleStore(db, user);
  const rows = dayDocRows(db, user, date, store);
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const docs = sp.docs ?? "";
  const docCount = docs ? docs.split(",").filter(Boolean).length : 0;
  const back = `/schedule?view=day&date=${date}${store !== "all" ? `&store=${store}` : ""}`;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="帳票をまとめて印刷" description="その日に納品・施工・現場見積の案件の納品書・請求書・領収書・見積書を 1 つの PDF にまとめて印刷します。出力の記録が残り、2 回目からの領収書は「再発行」と印字します" back={{ href: back, label: "予定表 (この日)" }} />

      {docCount > 0 && (
        <Card className="mb-4 border-accent/40 bg-accent-soft/30">
          <div className="flex flex-wrap items-center gap-3">
            <PdfLink href={`/api/pdf/batch?docs=${encodeURIComponent(docs)}&date=${date}`} className={buttonClass("primary", "md")}>
              <Printer />
              まとめて印刷 (PDF {docCount} 枚)
            </PdfLink>
            <span className="text-xs text-ink-2">PDF が開いたら、ブラウザーの印刷 (プリンターのアイコン) で印刷してください。もう一度開くと、領収書は「再発行」として記録されます。</span>
          </div>
        </Card>
      )}

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="label">日付</span>
          <input type="date" name="date" defaultValue={date} className="field w-auto" />
        </label>
        <label className="block">
          <span className="label">店舗</span>
          <select name="store" defaultValue={store} className="field w-auto">
            <option value="all">全店舗</option>
            {db.stores
              .filter((s) => s.kind !== "hq")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" size="sm">
          表示する
        </Button>
      </form>

      {rows.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-ink-3">この日の納品・施工・現場見積の予定はありません。</p>
        </Card>
      ) : (
        <form action={prepareDayDocs} className="space-y-3" data-testid="day-docs-form">
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="store" value={store} />
          <Note>
            請求書・領収書がまだない案件は、ここで発行してから印刷します (請求書の発行は店長・本部・管理者。施工完了の前に発行した請求書は、売上・売掛には施工完了の日から入ります)。
            領収書は、現金払いの予定の案件は「発行する」、カード・電子決済はご希望があれば印を付けてください (案件ごとの設定として残ります)。支払方法を組み合わせるときは、請求書の画面で内訳を入れて発行してください。
          </Note>
          {rows.map((r) => {
            const rc = r.receipt;
            const receiptDefault = Boolean(rc && rc.wanted.wanted && (rc.canIssue || (rc.issued.length > 0 && rc.issued.every((x) => x.outputs === 0))));
            return (
              <Card key={r.key} className="@container" padded={false}>
                <div className="flex flex-wrap items-start gap-2 border-b border-line px-4 py-2.5">
                  <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <input type="checkbox" name="case" value={r.key} defaultChecked className="h-4 w-4" aria-label={`${r.customerName} 様の帳票を印刷する`} />
                    {r.customerName ? `${r.customerName} 様` : "(お客様未登録)"}
                  </label>
                  <span className="text-xs text-ink-2">{r.events.map((e) => `${e.period} ${e.label}`).join(" / ")}</span>
                  <span className="text-xs text-ink-3">{storeName(r.storeId)}</span>
                  <Link href={r.caseHref} className="ml-auto text-xs text-accent hover:underline">
                    {r.caseNumber} {r.title}
                  </Link>
                </div>
                <div className="grid grid-cols-1 gap-3 px-4 py-3 text-xs @xl:grid-cols-2 @4xl:grid-cols-4">
                  {r.order && <input type="hidden" name={`orderId:${r.key}`} value={r.order.id} />}
                  {r.quote && <input type="hidden" name={`quoteId:${r.key}`} value={r.quote.id} />}
                  {/* 納品書 (請求書と同じ内容で表題が「納品書」。お客様のご要望 2026-11-25) */}
                  <div className="rounded-lg bg-subtle/60 p-2.5">
                    <div className="mb-1 font-semibold text-ink">納品書</div>
                    {r.order ? (
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" name={`delivery:${r.key}`} value="1" disabled={!r.order.canPrintDelivery} className="h-4 w-4" />
                        {r.order.number} {yen(r.order.total)}
                        {r.order.deliveryOutputs > 0 && <span className="text-ink-3">(出力 {r.order.deliveryOutputs} 回)</span>}
                      </label>
                    ) : (
                      <p className="text-ink-3">受注の前の案件です</p>
                    )}
                  </div>
                  {/* 請求書 */}
                  <div className="rounded-lg bg-subtle/60 p-2.5">
                    <div className="mb-1 font-semibold text-ink">請求書</div>
                    {r.invoice ? (
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" name={`invoice:${r.key}`} value="1" defaultChecked={r.invoice.canPrint} disabled={!r.invoice.canPrint} className="h-4 w-4" />
                        {r.invoice.number} {yen(r.invoice.total)}
                        {r.invoice.outputs > 0 && <span className="text-ink-3">(出力 {r.invoice.outputs} 回)</span>}
                      </label>
                    ) : r.order ? (
                      r.invoiceIssue?.ok ? (
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" name={`invoice:${r.key}`} value="1" defaultChecked className="h-4 w-4" />
                          発行して印刷 ({yen(r.order.total)}{r.invoiceIssue.pre ? " · 施工完了の前に発行" : ""})
                        </label>
                      ) : (
                        <p className="text-ink-3">未発行 · {r.invoiceIssue?.reason}</p>
                      )
                    ) : (
                      <p className="text-ink-3">受注の前の案件です</p>
                    )}
                    {r.order && (
                      <div className="mt-1 text-[11px] text-ink-3">
                        受注 {r.order.number} <StatusBadge value={r.order.status} map={ORDER_STATUS} />
                      </div>
                    )}
                  </div>
                  {/* 領収書 */}
                  <div className="rounded-lg bg-subtle/60 p-2.5">
                    <div className="mb-1 font-semibold text-ink">領収書</div>
                    {rc ? (
                      <>
                        <input type="hidden" name={`rwDefault:${r.key}`} value={rc.wanted.wanted ? "1" : "0"} />
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" name={`receipt:${r.key}`} value="1" defaultChecked={receiptDefault} disabled={!rc.canIssue && rc.issued.length === 0} className="h-4 w-4" />
                          {rc.canIssue ? `発行する (${yen(rc.remaining)})` : rc.issued.length ? `発行済みを印刷 (${rc.issued.map((x) => `${x.number}${x.outputs ? ` 出力 ${x.outputs} 回 → 再発行` : ""}`).join("・")})` : "発行できません"}
                        </label>
                        {rc.canIssue && (
                          <label className="mt-1 flex items-center gap-1.5">
                            <span className="text-ink-2">支払方法</span>
                            <select name={`method:${r.key}`} defaultValue={rc.method} className="field h-8 w-auto py-0.5 text-xs">
                              {RECEIPT_METHODS.filter((m) => m !== "other").map((m) => (
                                <option key={m} value={m}>
                                  {RECEIPT_METHOD_LABEL[m]}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <p className="mt-1 text-[11px] text-ink-3">
                          {rc.wanted.reason}
                          {rc.reason && !rc.canIssue && rc.issued.length === 0 ? ` · ${rc.reason}` : ""}
                        </p>
                      </>
                    ) : (
                      <p className="text-ink-3">受注の前の案件です</p>
                    )}
                  </div>
                  {/* 見積書 */}
                  <div className="rounded-lg bg-subtle/60 p-2.5">
                    <div className="mb-1 font-semibold text-ink">見積書</div>
                    {r.quote ? (
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" name={`quote:${r.key}`} value="1" disabled={!r.quote.canPrint} className="h-4 w-4" />
                        {r.quote.number}
                        {r.quote.version > 1 ? ` 第${r.quote.version}版` : ""}
                        {r.quote.draft ? " (承認前)" : ""}
                        {r.quote.outputs > 0 && <span className="text-ink-3">(出力 {r.quote.outputs} 回)</span>}
                      </label>
                    ) : (
                      <p className="text-ink-3">見積はありません</p>
                    )}
                  </div>
                </div>
                {r.checks.length > 0 && (
                  <ul className="border-t border-line px-4 py-2 text-[11px] text-warn-ink">
                    {r.checks.map((c) => (
                      <li key={c.text}>・{c.text}</li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
          <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/95 px-4 py-3 shadow-pop backdrop-blur">
            <Button type="submit" data-testid="day-docs-submit">
              <Printer />
              選んだ帳票をまとめる (請求書・領収書がなければ発行)
            </Button>
            <span className="text-xs text-ink-3">
              {rows.length} 件 · 押したあと、上に出る「まとめて印刷 (PDF)」で印刷します
            </span>
          </div>
        </form>
      )}
      {rows.length > 0 && <p className="mt-6 text-[11px] text-ink-3">帳票の出力 (日時・出力者・案件・帳票の種類・何回目) は、請求書の画面の「領収書」の下の「帳票の出力記録」で確かめられます。</p>}
    </div>
  );
}
