import Link from "@/components/ui/Link";
import { fmtDate } from "@/lib/format";
import { fmtDays, staffLeaveRows } from "@/lib/hr/leave";
import { Badge, EmptyRow, Note, StoreTag, Table, Td, Th, Tr } from "@/components/ui";
import { Days, type Ctx } from "./parts";

/** 社員ごとの有給の残日数・期限・年 5 日・次の付与・振休の未取得 */
export function StaffTab({ ctx }: { ctx: Ctx }) {
  const { db, today, employees } = ctx;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const rows = staffLeaveRows(db, employees, today);
  const over = rows.filter((r) => r.comp.overLimit);
  const due = rows.filter((r) => r.next?.due);
  const obligation = rows.filter((r) => r.obligation && !r.obligation.met);

  return (
    <div className="space-y-4">
      {over.length > 0 && <Note tone="warn">振休のため込みが上限 ({fmtDays(ctx.settings.compLimit)}) を超えている社員: {over.map((r) => `${r.user.name} (${fmtDays(r.comp.remaining)})`).join("・")}。社内規定のとおり、今月中に消化する日を決めてください。</Note>}
      {due.length > 0 && <Note tone="accent">付与日を過ぎて、付与が未登録の社員: {due.map((r) => `${r.user.name} (${fmtDate(r.next!.date)}${r.next!.days !== undefined ? `・法定 ${r.next!.days} 日` : ""})`).join("・")}。社員の画面の「有給を付与」から登録してください。</Note>}
      {obligation.length > 0 && <Note tone="warn">年 5 日の取得がまだの社員: {obligation.map((r) => `${r.user.name} (${fmtDays(r.obligation!.taken)}・期限 ${fmtDate(r.obligation!.deadline)})`).join("・")}</Note>}
      <Table minWidth="min-w-[960px]">
        <thead>
          <tr>
            <Th>社員</Th>
            <Th align="right">有給の残</Th>
            <Th>期限の近い残</Th>
            <Th>年 5 日</Th>
            <Th>次の付与 (目安)</Th>
            <Th align="right">振休の残り</Th>
            <Th align="right">申請中</Th>
            <Th>切り替え時点の取込</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8}>社員がいません</EmptyRow>}
          {rows.map((r) => (
            <Tr key={r.user.id}>
              <Td>
                <Link href={`/leave?tab=me&user=${r.user.id}`} className="text-sm font-medium text-ink hover:text-accent">{r.user.name}</Link>
                <div className="mt-0.5"><StoreTag store={storeMap.get(r.user.storeId)} short /></div>
              </Td>
              <Td align="right" className="tnum">
                <span className="text-base font-semibold">{fmtDays(r.paid.remaining)}</span>
                {r.paid.pending > 0 && <div className="text-[11px] text-warn-ink">申請中 {fmtDays(r.paid.pending)}</div>}
                {r.paid.shortage > 0 && <div className="text-[11px] text-critical-ink">付与不足 {fmtDays(r.paid.shortage)}</div>}
              </Td>
              <Td className="text-xs">{r.paid.expiring.length ? r.paid.expiring.map((e) => `${fmtDate(e.expiresOn)} に ${fmtDays(e.days)}`).join("・") : <span className="text-ink-3">-</span>}</Td>
              <Td className="text-xs">
                {r.obligation ? (
                  <Badge tone={r.obligation.met ? "good" : "critical"} dot={false}>{fmtDays(r.obligation.taken)} / 5 日{r.obligation.met ? "" : ` (〜${fmtDate(r.obligation.deadline).slice(5)})`}</Badge>
                ) : (
                  <span className="text-ink-3">-</span>
                )}
              </Td>
              <Td className="text-xs tnum">
                {r.next ? (
                  <>
                    <span className={r.next.due ? "font-medium text-accent-ink" : ""}>{fmtDate(r.next.date)}</span>
                    {r.next.days !== undefined && <span className="text-ink-3"> · 法定 {r.next.days} 日</span>}
                    {r.next.due && <div className="text-[11px] text-accent-ink">付与の登録が必要</div>}
                  </>
                ) : (
                  <span className="text-ink-3">基準日が未登録</span>
                )}
              </Td>
              <Td align="right" className="tnum">
                <Days value={r.comp.remaining} tone={r.comp.overLimit ? "critical" : undefined} />
                {r.comp.overLimit && <div className="text-[11px] text-critical-ink">上限超え</div>}
              </Td>
              <Td align="right" className="tnum">{r.pendingCount ? `${r.pendingCount} 件` : <span className="text-ink-3">-</span>}</Td>
              <Td className="text-xs">{r.opening ? `${fmtDays(r.opening.days)} (${fmtDate(r.opening.asOf)} 時点)` : <span className="text-ink-3">未取込</span>}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <p className="text-xs text-ink-3">
        有給の残は今日使える日数で、承認済みの先の休暇も差し引いています。切り替え時点の取込の数字は、取り込んだ時点の残 (有給管理表の当年度分 + 繰越分) です。取込の後に休暇がなければ「有給の残」と一致します。
      </p>
    </div>
  );
}
