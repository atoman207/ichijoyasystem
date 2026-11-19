import Link from "next/link";
import { yen } from "@/lib/format";
import { confirmedRun, monthRange, previewAllocation, RUN_STATUS_LABEL } from "@/lib/mgmt/allocation";
import { ruleLabel } from "@/lib/mgmt/rules";
import { classifyExpense, confirmAllocationAction } from "@/lib/actions/mgmt";
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
        共通経費 (共通広告・消耗品・廃棄物処分・システム開発など) を、店舗の<strong>{ruleLabel("alloc.basis", p.rules["alloc.basis"].value)}</strong>で案分します (2025-07〜 粗利比。議事録 2025-09-19)。粗利益 = 管理売上 − 材料費 − 外注費 (案分の結果は基準に入れません)。対象: {ruleLabel("alloc.include_hq", p.rules["alloc.include_hq"].value)}
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

      <Card>
        <CardHeader title={`${month} の経費の区分 (${expenses.length} 件)`} description="区分のない経費は店舗独自経費として数えます。共通広告・消耗品 (ハガキ・タオル)・廃棄物処分などは「共通経費」にすると案分の対象になります" />
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
                        <Select name="allocClass" defaultValue={c?.allocClass ?? "store"}>
                          <option value="store">店舗独自経費</option>
                          <option value="common">共通経費 (案分)</option>
                        </Select>
                        <Select name="costKind" defaultValue={c?.costKind ?? (COST_KINDS.find((k) => e.account.includes(k.replace(/費$/, ""))) ?? "その他")}>
                          {COST_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                        </Select>
                        <Button type="submit" size="sm" variant="secondary">保存</Button>
                      </form>
                    ) : (
                      <span>{c?.allocClass === "common" ? "共通経費" : "店舗独自経費"}</span>
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
