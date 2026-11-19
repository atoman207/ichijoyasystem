import { yen } from "@/lib/format";
import { reconcile, type StorePnl } from "@/lib/mgmt/pnl";
import { closeMonthAction, reopenMonthAction } from "@/lib/actions/mgmt";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Table, Td, Th, Tr } from "@/components/ui";
import { PeriodForm, back, userNameOf, type Ctx } from "./parts";

export function CloseTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const month = ctx.month;
  const row = db.periodCloses.find((p) => p.month === month);
  const rc = ctx.storeIds ? null : reconcile(db, month);
  const snap = row?.snapshot as { at: string; basis: string; stores: StorePnl[]; total: StorePnl; provisional: boolean } | undefined;
  const b = back(ctx);
  const recent = [...db.periodCloses].sort((a, b2) => b2.month.localeCompare(a.month)).slice(0, 24);
  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} monthOnly />
      <Note>
        月次確定すると、その月の 売上の調整・材料の使用・在庫の移動・仕入明細の振り分け・手入力・案分 は変えられなくなり、確定時の店舗別損益が保存されます。訂正は管理者が確定を解除してから行います (解除と再確定は理由と一緒に履歴に残ります)。確定の前に、共通経費の案分を確定し、下の照合を確かめてください。
      </Note>
      {rc && (
        <Card>
          <CardHeader title={`${month} の照合`} description={rc.ok ? "すべて一致しています" : "一致しない項目があります"} />
          <ul className="space-y-1 text-sm">
            {rc.checks.map((c) => (
              <li key={c.label} className="flex flex-wrap gap-2">
                <Badge tone={c.ok ? "good" : "warn"}>{c.ok ? "OK" : "要確認"}</Badge>
                <span>{c.label}</span>
                <span className="text-xs text-ink-2">{c.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader title={`${month} の状態: ${row?.status === "closed" ? "確定済み" : "未確定"}`} />
        {ctx.canAdmin && row?.status !== "closed" && (
          <form action={closeMonthAction} className="flex flex-wrap items-end gap-2">
            {b}
            <input type="hidden" name="month" value={month} />
            <Field label="メモ"><Input name="reason" /></Field>
            <Button type="submit">{month} を月次確定する</Button>
          </form>
        )}
        {ctx.canAdmin && row?.status === "closed" && (
          <form action={reopenMonthAction} className="flex flex-wrap items-end gap-2">
            {b}
            <input type="hidden" name="month" value={month} />
            <Field label="解除の理由" required><Input name="reason" required className="w-80" /></Field>
            <Button type="submit" variant="danger">確定を解除する</Button>
          </form>
        )}
        {snap && (
          <div className="mt-4">
            <p className="mb-2 text-sm">確定時の店舗別損益 ({snap.at.slice(0, 16).replace("T", " ")} · {snap.basis}{snap.provisional ? " · 暫定を含む" : ""})</p>
            <Table minWidth="min-w-[640px]">
              <thead>
                <tr>
                  <Th>店舗</Th>
                  <Th align="right">管理売上</Th>
                  <Th align="right">粗利益</Th>
                  <Th align="right">案分額</Th>
                  <Th align="right">損益</Th>
                </tr>
              </thead>
              <tbody>
                {[...snap.stores, snap.total].filter((s) => !ctx.storeIds || ctx.storeIds.includes(s.storeId)).map((s, i) => (
                  <Tr key={i}>
                    <Td>{s.storeName}</Td>
                    <Td align="right">{yen(s.mgmtSales)}</Td>
                    <Td align="right">{yen(s.gross)}</Td>
                    <Td align="right">{yen(s.allocated)}</Td>
                    <Td align="right">{yen(s.profit)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {row && (
          <ul className="mt-3 space-y-1 text-xs text-ink-2">
            {row.history.map((h, i) => (
              <li key={i}>
                {h.at.slice(0, 16).replace("T", " ")} {userNameOf(db, h.by)}: {h.action === "close" ? "確定" : "解除"}{h.reason ? ` (${h.reason})` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {recent.length > 0 && (
        <Card>
          <CardHeader title="確定の一覧" />
          <ul className="flex flex-wrap gap-2 text-sm">
            {recent.map((p) => (
              <li key={p.month}>
                <Badge tone={p.status === "closed" ? "good" : "neutral"}>{p.month} {p.status === "closed" ? "確定" : "解除中"}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
