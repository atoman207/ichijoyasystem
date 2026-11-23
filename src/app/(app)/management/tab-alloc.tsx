import Link from "next/link";
import { yen } from "@/lib/format";
import { confirmedRun, monthRange, previewAllocation, RUN_STATUS_LABEL } from "@/lib/mgmt/allocation";
import { ruleAt, ruleLabel } from "@/lib/mgmt/rules";
import { defaultExpenseClass } from "@/lib/mgmt/expense-class";
import { omoteDiffEntries, parseOmoteDiffKey, previewOmoteDiff } from "@/lib/mgmt/omote-diff";
import { classifyExpense, confirmAllocationAction, confirmOmoteDiffAction, moveAdOverageAction, reverseOmoteDiffAction } from "@/lib/actions/mgmt";
import { adBudgetStatus } from "@/lib/mgmt/ad-budget";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { Money, PeriodForm, back, storeNameOf, userNameOf, type Ctx } from "./parts";

const COST_KINDS = ["広告宣伝費", "消耗品費", "廃棄物処分費", "システム開発費", "人件費", "通信費", "販促費", "その他"];

export function AllocTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const month = ctx.month;
  const p = previewAllocation(db, month);
  const run = confirmedRun(db, month);
  const runs = db.allocationRuns.filter((r) => r.month === month).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { from, to } = monthRange(month);
  const classes = new Map(db.expenseClasses.map((c) => [c.expenseId, c]));
  const expenses = db.expenses.filter((e) => (e.status === "approved" || e.status === "paid") && e.date >= from && e.date <= to && (!ctx.storeIds || ctx.storeIds.includes(e.storeId)));
  const b = back(ctx);
  const ppm = (v: number) => `${(v / 10000).toFixed(2)}%`;

  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} monthOnly />
      <Note>
        案分経費 (広告宣伝費の大部分・消耗品費のすべて・畳の処分費などの廃棄物処分費・開発費など全店舗共通の経費) を本部に集約し、店舗の<strong>{ruleLabel("alloc.basis", p.rules["alloc.basis"].value)}</strong>で案分します (2025-07〜 粗利比。お客様のご説明 2026-11-23・議事録 2025-09-19)。粗利益 = 管理売上 − 材料費 − 外注費 (案分の結果は基準に入れません)。対象: {ruleLabel("alloc.include_hq", p.rules["alloc.include_hq"].value)}
        {p.rules["alloc.include_hq"].status === "provisional" ? " (暫定)" : ""}。端数: {ruleLabel("alloc.rounding", p.rules["alloc.rounding"].value)}
        {p.rules["alloc.rounding"].status === "provisional" ? " (暫定)" : ""}。粗利益の合計が 0 以下・マイナスの店舗があるときは<strong>保留</strong>し、管理者が比率を指定するまで案分しません。
      </Note>

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title={`${month} の共通経費 ${yen(p.poolTotal)}`} description={`${p.pool.length} 件 (経費の区分が「共通経費」・仕入明細の「共通経費」・手入力の共通経費)`} />
          <ul className="space-y-1 text-sm">
            {p.pool.map((x) => (
              <li key={x.source + x.id} className="flex justify-between gap-2">
                <span className="truncate">{x.label}</span>
                <Money v={x.amount} />
              </li>
            ))}
            {p.pool.length === 0 && <li className="text-ink-2">この月の共通経費はありません。</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title={run ? `確定した案分 ${run.number}` : p.status === "held" ? "保留" : p.status === "empty" ? "案分なし" : "案分の計算 (未確定)"} description={run ? `${run.confirmedAt?.slice(0, 10)} ${userNameOf(db, run.confirmedBy)} · ${run.method === "manual_ratio" ? `指定の比率 (${run.methodReason})` : "基準の比率"}` : p.holdReason} />
          <Table minWidth="min-w-[420px]">
            <thead>
              <tr>
                <Th>店舗</Th>
                <Th align="right">基準 ({p.basisKind === "sales" ? "管理売上" : "粗利益"})</Th>
                <Th align="right">率</Th>
                <Th align="right">案分額</Th>
              </tr>
            </thead>
            <tbody>
              {(run ? run.basis : p.basis).map((x) => {
                const r = (run ? run.results : p.results).find((y) => y.storeId === x.storeId);
                return (
                  <Tr key={x.storeId}>
                    <Td>{storeNameOf(db, x.storeId)}</Td>
                    <Td align="right"><Money v={x.gross} /></Td>
                    <Td align="right">{r ? ppm(r.ratePpm) : "-"}</Td>
                    <Td align="right"><Money v={r?.amount ?? null} strong /></Td>
                  </Tr>
                );
              })}
              <Tr>
                <Td className="font-semibold">合計</Td>
                <Td align="right"><Money v={run ? run.basisTotal : p.basisTotal} /></Td>
                <Td />
                <Td align="right"><Money v={(run ? run.results : p.results).reduce((a, r) => a + r.amount, 0)} strong /></Td>
              </Tr>
            </tbody>
          </Table>
          {run && run.poolTotal !== p.poolTotal && <Note tone="warn">確定した後に共通経費が変わりました (確定時 {yen(run.poolTotal)} → 今 {yen(p.poolTotal)})。訂正して確定し直してください。</Note>}
          {ctx.canAdmin && p.status !== "empty" && (
            <div className="mt-3 space-y-3">
              {p.status === "ok" && (
                <form action={confirmAllocationAction} className="flex flex-wrap items-end gap-2">
                  {b}
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="method" value="ratio" />
                  {run && <Field label="訂正の理由" required><Input name="reason" required /></Field>}
                  <Button type="submit">{run ? "この計算で訂正して確定" : "この計算で確定"}</Button>
                </form>
              )}
              <details className={p.status === "held" ? "" : "text-sm"} open={p.status === "held"}>
                <summary className="cursor-pointer text-sm text-accent">管理者が比率を指定して案分する (保留のとき・特殊な方法)</summary>
                <form action={confirmAllocationAction} className="mt-2 grid grid-cols-2 gap-2">
                  {b}
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="method" value="manual" />
                  {db.stores.map((s) => (
                    <Field key={s.id} label={`${s.name} の比率`}><Input name={`w_${s.id}`} inputMode="decimal" placeholder="例: 30" /></Field>
                  ))}
                  <Field label="方法と理由" required className="col-span-2"><Input name="methodReason" required placeholder="例: 西店の粗利益がマイナスのため、税理士と相談のうえ売上比で案分" /></Field>
                  {run && <Field label="訂正の理由" required className="col-span-2"><Input name="reason" required /></Field>}
                  <div className="col-span-2"><Button type="submit" variant="secondary">指定の比率で確定</Button></div>
                </form>
              </details>
            </div>
          )}
        </Card>
      </div>

      {runs.length > 0 && (
        <Card>
          <CardHeader title="この月の案分の履歴" description="確定した案分は基準の粗利益・率・結果・使った設定と一緒に保存されます。訂正すると前の確定は「訂正済み」になります" />
          <ul className="space-y-1 text-sm">
            {runs.map((r) => (
              <li key={r.id}>
                {r.number} <Badge tone={r.status === "confirmed" ? "good" : "neutral"}>{RUN_STATUS_LABEL[r.status]}</Badge> {yen(r.poolTotal)} · {r.results.map((x) => `${storeNameOf(db, x.storeId)} ${yen(x.amount)}`).join("・")} · {r.confirmedAt?.slice(0, 16).replace("T", " ")} {userNameOf(db, r.confirmedBy)}
                {r.reason && <span className="text-ink-2"> (訂正: {r.reason})</span>}
                <span className="text-xs text-ink-2"> 設定: {Object.entries(r.rules).map(([k, v]) => `${ruleLabel(k, v.value)}${v.status === "provisional" ? "(暫定)" : ""}`).join(" / ")}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <OmoteDiffCard ctx={ctx} />

      <AdBudgetCard ctx={ctx} />

      <Card>
        <CardHeader title={`${month} の経費の区分 (${expenses.length} 件)`} description="区分を登録していない経費は勘定科目から自動で決めます: 消耗品費・廃棄物処分費・広告宣伝費・販促費・開発費、ハガキ・タオル、本部の経費 = 案分経費 / それ以外 = 店舗独自経費。店舗の判断で予算を超えて行った広告宣伝費などは「店舗独自経費」に変えて保存してください" />
        <Table minWidth="min-w-[860px]">
          <thead>
            <tr>
              <Th>経費</Th>
              <Th>店舗</Th>
              <Th>勘定科目・支払先</Th>
              <Th align="right">金額 (税抜)</Th>
              <Th>区分</Th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => {
              const c = classes.get(e.id);
              const auto = defaultExpenseClass(e);
              return (
                <Tr key={e.id}>
                  <Td><Link className="text-accent hover:underline" href={`/expenses/${e.id}`}>{e.number}</Link><div className="text-xs text-ink-2">{e.date}</div></Td>
                  <Td>{storeNameOf(db, e.storeId)}</Td>
                  <Td className="text-xs">{e.account} · {e.vendor}<div className="text-ink-2">{e.description}</div></Td>
                  <Td align="right">{yen(e.amount - (e.taxAmount ?? 0))}</Td>
                  <Td>
                    {ctx.canEdit ? (
                      <form action={classifyExpense} className="flex flex-wrap gap-1">
                        {b}
                        <input type="hidden" name="expenseId" value={e.id} />
                        <Select name="allocClass" defaultValue={c?.allocClass ?? auto.allocClass}>
                          <option value="store">店舗独自経費</option>
                          <option value="common">案分経費 (共通)</option>
                        </Select>
                        <Select name="costKind" defaultValue={c?.costKind ?? (COST_KINDS.find((k) => e.account.includes(k.replace(/費$/, ""))) ?? "その他")}>
                          {COST_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                        </Select>
                        <Button type="submit" size="sm" variant="secondary">保存</Button>
                        {!c && <span className="w-full text-xs text-ink-2">未登録: 自動で{auto.allocClass === "common" ? "案分経費" : "店舗独自経費"} ({auto.reason})</span>}
                      </form>
                    ) : (
                      <span>{(c?.allocClass ?? auto.allocClass) === "common" ? "案分経費" : "店舗独自経費"}{!c && <span className="text-xs text-ink-2"> (自動)</span>}</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

/** 畳表の仮原価と実際の仕入の差額 (期間を選んで、店舗の粗利益の比率で案分) */
function OmoteDiffCard({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  // 全店舗の粗利益・仕入を含むため、全店舗を見られる人だけに出す
  if (ctx.storeIds) return null;
  const isMonth = (v: string | undefined) => Boolean(v && /^\d{4}-\d{2}$/.test(v));
  const fromMonth = isMonth(ctx.sp.ofrom) ? ctx.sp.ofrom! : ctx.month;
  const toMonth = isMonth(ctx.sp.oto) && ctx.sp.oto! >= fromMonth ? ctx.sp.oto! : fromMonth < ctx.month ? ctx.month : fromMonth;
  const p = previewOmoteDiff(db, fromMonth, toMonth);
  const method = ruleAt(db, "omote.diff_method", `${toMonth}-28`);
  const confirmed = new Map<string, { total: number; stores: { storeId: string; amount: number }[]; at: string; by: string }>();
  for (const e of omoteDiffEntries(db)) {
    const k = e.metric!;
    const cur = confirmed.get(k) ?? confirmed.set(k, { total: 0, stores: [], at: e.createdAt, by: e.createdBy }).get(k)!;
    cur.total += e.amount;
    cur.stores.push({ storeId: e.storeId, amount: e.amount });
  }
  const ppm = (v: number) => `${(v / 10000).toFixed(2)}%`;
  const b = back(ctx, { ofrom: fromMonth, oto: toMonth });
  return (
    <Card id="omote-diff">
      <CardHeader
        title="畳表の仮原価と実際の仕入の差額"
        description={`店舗には畳表を仮原価 × 使用数量で計上し、実際の仕入金額との差額を各店舗の粗利益の比率で案分します。設定: ${ruleLabel("omote.diff_method", method.value)}`}
      />
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="alloc" />
        <input type="hidden" name="month" value={ctx.month} />
        <Field label="開始月"><Input type="month" name="ofrom" defaultValue={fromMonth} /></Field>
        <Field label="終了月"><Input type="month" name="oto" defaultValue={toMonth} /></Field>
        <Button type="submit" variant="secondary">計算する</Button>
      </form>
      <div className="grid grid-cols-1 gap-3 text-sm @3xl:grid-cols-3">
        <div className="rounded-lg border border-line p-3"><div className="text-xs text-ink-2">実際の仕入 (畳表の在庫の受入 {p.receiveCount} 件)</div><Money v={p.purchases} strong /></div>
        <div className="rounded-lg border border-line p-3"><div className="text-xs text-ink-2">仮原価で計上した材料費 ({p.bookedCount} 行)</div><Money v={p.booked} strong /></div>
        <div className="rounded-lg border border-line p-3"><div className="text-xs text-ink-2">差額 (店舗の材料費に足す)</div><Money v={p.diff} strong /></div>
      </div>
      {p.status === "ok" ? (
        <Table minWidth="min-w-[420px]" className="mt-3">
          <thead>
            <tr>
              <Th>店舗</Th>
              <Th align="right">粗利益 (期間)</Th>
              <Th align="right">率</Th>
              <Th align="right">差額の案分</Th>
            </tr>
          </thead>
          <tbody>
            {p.basis.map((x) => {
              const r = p.results.find((y) => y.storeId === x.storeId);
              return (
                <Tr key={x.storeId}>
                  <Td>{storeNameOf(db, x.storeId)}</Td>
                  <Td align="right"><Money v={x.gross} /></Td>
                  <Td align="right">{r ? ppm(r.ratePpm) : "-"}</Td>
                  <Td align="right"><Money v={r?.amount ?? null} strong /></Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <p className="mt-3 text-sm text-ink-2">{p.status === "empty" ? "この期間に畳表の仕入・仮原価の計上がない (または差額が 0) ため、案分する差額はありません。" : p.holdReason}</p>
      )}
      {p.overlap && <Note tone="warn">{p.overlap}。</Note>}
      {ctx.canAdmin && p.status === "ok" && !p.overlap && (
        <form action={confirmOmoteDiffAction} className="mt-3 flex flex-wrap items-end gap-2">
          {b}
          <input type="hidden" name="fromMonth" value={fromMonth} />
          <input type="hidden" name="toMonth" value={toMonth} />
          <Button type="submit">この差額を {toMonth} の材料費 (畳) に案分して確定</Button>
          <span className="text-xs text-ink-2">店舗ごとの「材料の差額調整」として登録します。取消しは逆の行で行います。</span>
        </form>
      )}
      <p className="mt-2 text-xs text-ink-2">
        実際の仕入は、仕入明細の振り分けで畳表を「在庫」(本部の一括仕入) として確定したものです。仕入と使用の月がずれると 1 か月ごとの差額は大きく振れるため、四半期・決算期など長めの期間で確定してもかまいません。
      </p>
      {confirmed.size > 0 && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="font-semibold">確定した差額</div>
          {[...confirmed.entries()].map(([k, v]) => {
            const per = parseOmoteDiffKey(k)!;
            return (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <span>{per.from}〜{per.to}: {yen(v.total)} ({v.stores.map((x) => `${storeNameOf(db, x.storeId)} ${yen(x.amount)}`).join("・")}) · {v.at.slice(0, 10)} {userNameOf(db, v.by)}</span>
                {ctx.canAdmin && (
                  <form action={reverseOmoteDiffAction} className="flex gap-1">
                    {b}
                    <input type="hidden" name="key" value={k} />
                    <Input name="reason" placeholder="取消しの理由" required className="w-36" />
                    <Button type="submit" size="sm" variant="secondary">取消し</Button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** 広告宣伝費の店舗の予算と超過分 (超過分は店舗独自経費) */
function AdBudgetCard({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const rows = adBudgetStatus(db, ctx.month, ctx.storeIds);
  const anyBudget = rows.some((r) => r.budget !== null);
  const pending = rows.filter((r) => r.budget !== null && r.toMove !== 0);
  return (
    <Card>
      <CardHeader title={`${ctx.month} の広告宣伝費 (店舗の予算と超過分)`} description="広告宣伝費は案分経費ですが、店舗の判断で予算を超えた分は店舗独自経費にします。予算は「人件費・手入力」のタブで種類「予算」・指標「広告宣伝費」で登録します。店舗の広告宣伝費 = その店舗の広告・販促の経費 + 仕入明細の振り分けでその店舗を選んだ分" />
      {!anyBudget ? (
        <p className="text-sm text-ink-2">この月の広告の予算はまだ登録されていません (予算のない店舗は判定しません)。</p>
      ) : (
        <Table minWidth="min-w-[720px]">
          <thead>
            <tr>
              <Th>店舗</Th>
              <Th align="right">予算</Th>
              <Th align="right">広告宣伝費</Th>
              <Th align="right">うち店舗独自経費済み</Th>
              <Th align="right">超過分</Th>
              <Th align="right">移した額</Th>
              <Th align="right">これから移す額</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.storeId}>
                <Td>{storeNameOf(db, r.storeId)}</Td>
                <Td align="right">{r.budget === null ? <span className="text-xs text-ink-3">未登録</span> : <Money v={r.budget} />}</Td>
                <Td align="right"><Money v={r.spend} /></Td>
                <Td align="right"><Money v={r.ownAlready} /></Td>
                <Td align="right"><Money v={r.budget === null ? null : r.overage} strong /></Td>
                <Td align="right"><Money v={r.moved} /></Td>
                <Td align="right"><Money v={r.budget === null ? null : r.toMove} strong /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {ctx.canEdit && pending.length > 0 && (
        <form action={moveAdOverageAction} className="mt-3 flex flex-wrap items-center gap-2">
          {back(ctx)}
          <input type="hidden" name="month" value={ctx.month} />
          <Button type="submit" size="sm">超過分を店舗独自経費へ移す ({pending.length} 店舗)</Button>
          <span className="text-xs text-ink-2">店舗独自経費 + と案分経費 − の 2 行を登録します (全社の経費の合計は変わりません)。</span>
        </form>
      )}
    </Card>
  );
}
