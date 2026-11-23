import Link from "next/link";
import { fmtDate, yen } from "@/lib/format";
import { salesFacts } from "@/lib/assistant/facts";
import { ADJ_KIND_LABEL, TAX_CATEGORY_LABEL, TREATMENT_LABEL, WORK_KIND_LABEL, adjustmentDate, attributionOf, internalOrderStale, orderTaxStatus } from "@/lib/mgmt/attribution";
import { mainCategory, orderCategorySales } from "@/lib/mgmt/categories";
import { ruleAt, ruleLabel } from "@/lib/mgmt/rules";
import { createAdjustment, recalcInternalOrder, reverseAdjustmentAction, saveAttribution, setOrderTaxCategory } from "@/lib/actions/mgmt";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { Money, PeriodForm, StoreSelect, back, storeNameOf, type Ctx } from "./parts";

export function SalesTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const facts = salesFacts(db).byId;
  const visible = (id: string) => !ctx.storeIds || ctx.storeIds.includes(id);
  const orders = db.orders.filter((o) => o.status !== "cancelled" && (o.salesDate ?? o.contractDate) >= ctx.from && (o.salesDate ?? o.contractDate) <= ctx.to && visible(o.storeId));
  const atts = orders.map((o) => ({ o, a: attributionOf(db, o, mainCategory(orderCategorySales(db, o, facts.get(o.id), o.salesDate ?? o.contractDate), "other")) }));
  // 内部受注の候補: 営業エリアの店舗 ≠ 施工店舗 で、まだ帰属を登録していない受注
  const candidates = atts.filter(({ a }) => !a.saved && a.area.status === "matched" && a.area.storeId !== a.workStoreId);
  const saved = atts.filter(({ a }) => a.saved);
  const warned = atts.filter(({ a }) => a.warnings.length);
  // 税区分の確認: 見積・請求書の消費税が 0 円で、税区分が未登録の受注 (輸出など)
  const zeroTax = orders.filter((o) => orderTaxStatus(db, o, db.orderAttributions.find((x) => x.orderId === o.id)).source === "zero");
  const orderIndex = new Map(db.orders.map((o) => [o.id, o]));
  const adjs = (db.salesAdjustments ?? [])
    .filter((x) => {
      const d = adjustmentDate(db, x, orderIndex) ?? x.createdAt.slice(0, 10);
      return d >= ctx.from && d <= ctx.to && (visible(x.fromStoreId) || visible(x.toStoreId));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rate = (k: string) => ruleAt(db, k, ctx.to);
  const b = back(ctx);

  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} />
      <Note>
        売上は<strong>実際に施工した店舗</strong>に計上します (受注の店舗 = 売上帰属店舗)。担当エリアの仕事を他店舗に割り振ったときは内部受注として、依頼元に{" "}
        <strong>{ruleLabel("internal.base", rate("internal.base").value)} × 通常工事 {ruleLabel("internal.rate.normal", rate("internal.rate.normal").value)} ({ruleLabel("internal.rounding", rate("internal.rounding").value)})</strong> / リフォーム工事{" "}
        {ruleLabel("internal.rate.reform", rate("internal.rate.reform").value)}
        {rate("internal.rate.reform").status === "provisional" ? " (暫定)" : ""} を移します。店頭・イベント・リビング経由の仕事は内部受注になりません (社内総合マニュアル) — 候補は自動で計上せず、確認してから登録してください。
      </Note>

      <Card>
        <CardHeader title={`内部受注の候補 (${candidates.length} 件)`} description="住所の営業エリアの店舗と、施工した店舗 (受注の店舗) が違う受注。依頼元 = 営業エリアの店舗 として計上するか、内部受注なしとして登録します" />
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-2">候補はありません{db.salesAreas.length === 0 ? " (営業エリアが未登録です。設定 → 営業エリアで地域一覧を取り込んでください)" : ""}。</p>
        ) : (
          <Table minWidth="min-w-[900px]">
            <thead>
              <tr>
                <Th>受注</Th>
                <Th>売上計上日</Th>
                <Th>営業エリア</Th>
                <Th>施工店舗</Th>
                <Th align="right">金額 (税込)</Th>
                <Th>登録</Th>
              </tr>
            </thead>
            <tbody>
              {candidates.slice(0, 100).map(({ o, a }) => (
                <Tr key={o.id}>
                  <Td>
                    <Link className="text-accent hover:underline" href={`/orders/${o.id}`}>{o.number}</Link>
                    <div className="text-xs text-ink-2">{o.title}</div>
                  </Td>
                  <Td>{o.salesDate ? fmtDate(o.salesDate) : "未完了"}</Td>
                  <Td>{storeNameOf(db, a.area.storeId)} <span className="text-xs text-ink-2">({a.area.key})</span></Td>
                  <Td>{storeNameOf(db, a.workStoreId)}</Td>
                  <Td align="right">{yen(o.total)}</Td>
                  <Td>
                    {ctx.canEdit ? (
                      <div className="flex flex-wrap gap-1">
                        <form action={saveAttribution}>
                          {b}
                          <input type="hidden" name="orderId" value={o.id} />
                          <input type="hidden" name="receivedStoreId" value={a.area.storeId} />
                          <input type="hidden" name="workStoreId" value={a.workStoreId} />
                          <input type="hidden" name="workKind" value={a.workKind} />
                          <Button type="submit" size="sm">内部受注として計上 ({WORK_KIND_LABEL[a.workKind]})</Button>
                        </form>
                        <form action={saveAttribution}>
                          {b}
                          <input type="hidden" name="orderId" value={o.id} />
                          <input type="hidden" name="receivedStoreId" value={a.workStoreId} />
                          <input type="hidden" name="workStoreId" value={a.workStoreId} />
                          <input type="hidden" name="workKind" value={a.workKind} />
                          <input type="hidden" name="note" value="内部受注なし (店頭・イベント・リビング経由など)" />
                          <Button type="submit" size="sm" variant="secondary">内部受注なし</Button>
                        </form>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-2">本部スタッフ・管理者が登録</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {candidates.length > 100 && <p className="mt-2 text-xs text-ink-2">先頭の 100 件を表示しています。期間を絞ってください。</p>}
      </Card>

      {zeroTax.length > 0 && (
        <Card>
          <CardHeader title={`税区分の確認 (${zeroTax.length} 件)`} description="見積・請求書の消費税が 0 円で、税区分が未登録の受注です (輸出など)。店舗別損益では税を引かずに数えています。税区分を登録してください" />
          <ul className="space-y-2 text-sm">
            {zeroTax.slice(0, 50).map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <Link className="text-accent hover:underline" href={`/orders/${o.id}`}>{o.number}</Link>
                <span>{o.title}</span>
                <span className="text-ink-2">{yen(o.total)}</span>
                {ctx.canEdit &&
                  (["exempt", "non_taxable", "out_of_scope", "taxable"] as const).map((t) => (
                    <form key={t} action={setOrderTaxCategory}>
                      {b}
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="taxCategory" value={t} />
                      <Button type="submit" size="sm" variant={t === "exempt" ? "primary" : "secondary"}>{TAX_CATEGORY_LABEL[t]}</Button>
                    </form>
                  ))}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {warned.length > 0 && (
        <Card>
          <CardHeader title={`確認が必要な受注 (${warned.length} 件)`} />
          <ul className="space-y-1 text-sm">
            {warned.slice(0, 50).map(({ o, a }) => (
              <li key={o.id}>
                <Link className="text-accent hover:underline" href={`/orders/${o.id}`}>{o.number}</Link>: {a.warnings.join(" / ")}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title={`店舗間の売上調整 (${adjs.length} 件)`} description="内部受注・本部の特殊配分・手入力の調整。取り消すと逆の行が追加されます (元の行は残ります)" />
        <Table minWidth="min-w-[1000px]">
          <thead>
            <tr>
              <Th>番号</Th>
              <Th>種類</Th>
              <Th>受注・計上日</Th>
              <Th>受け取る ← 渡す</Th>
              <Th>計算</Th>
              <Th align="right">金額</Th>
              <Th>状態</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody>
            {adjs.slice(0, 200).map((x) => {
              const o = x.orderId ? orderIndex.get(x.orderId) : undefined;
              const stale = internalOrderStale(db, x, o);
              const d = adjustmentDate(db, x, orderIndex);
              return (
                <Tr key={x.id}>
                  <Td className="whitespace-nowrap">{x.number}</Td>
                  <Td>
                    {ADJ_KIND_LABEL[x.kind]}
                    {x.workKind && <div className="text-xs text-ink-2">{WORK_KIND_LABEL[x.workKind]}</div>}
                    {x.treatment && <div className="text-xs text-ink-2">扱い: {TREATMENT_LABEL[x.treatment]}</div>}
                  </Td>
                  <Td>
                    {o ? <Link className="text-accent hover:underline" href={`/orders/${o.id}`}>{o.number}</Link> : "-"}
                    <div className="text-xs text-ink-2">{d ? fmtDate(d) : "未計上 (施工完了前)"}</div>
                  </Td>
                  <Td>{storeNameOf(db, x.fromStoreId)} ← {storeNameOf(db, x.toStoreId)}</Td>
                  <Td className="text-xs">
                    {x.baseAmount !== undefined ? `${x.base === "tax_included" ? "税込" : "税抜"} ${yen(x.baseAmount)} × ${((x.rateBp ?? 0) / 100).toLocaleString("ja-JP")}%${x.rateSource === "override" ? " (特例)" : ""}` : `金額指定 (${x.base === "tax_included" ? "税込" : "税抜"})`}
                    {x.reason && <div className="text-ink-2">{x.reason}</div>}
                  </Td>
                  <Td align="right"><Money v={x.amount} /></Td>
                  <Td>
                    {x.reversalOf ? <Badge tone="neutral">取消しの行</Badge> : x.status === "reversed" ? <Badge tone="neutral">取消し済み</Badge> : <Badge tone="good">有効</Badge>}
                    {x.provisional && <div><Badge tone="warn">暫定</Badge></div>}
                    {stale && <div className="mt-1 text-xs text-warn-ink">{stale}</div>}
                  </Td>
                  <Td>
                    {ctx.canEdit && x.status === "active" && !x.reversalOf && (
                      <div className="flex flex-col gap-1">
                        {stale && (
                          <form action={recalcInternalOrder}>
                            {b}
                            <input type="hidden" name="id" value={x.id} />
                            <Button type="submit" size="sm">再計算 (訂正)</Button>
                          </form>
                        )}
                        <form action={reverseAdjustmentAction} className="flex gap-1">
                          {b}
                          <input type="hidden" name="id" value={x.id} />
                          <Input name="reason" placeholder="取消しの理由" required className="w-32" />
                          <Button type="submit" size="sm" variant="secondary">取消し</Button>
                        </form>
                      </div>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {ctx.canEdit && (
        <Card>
          <CardHeader title="受注の売上の帰属を登録する" description="受注店舗 ≠ 施工店舗 なら内部受注を自動で計算して計上します (前の計上と違えば取り消して計上し直し)。売上帰属店舗は受注の「店舗」です" />
          <form action={saveAttribution} className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
            {b}
            <Field label="受注番号" required><Input name="orderId" required placeholder="例: OR-2026-0123" /></Field>
            <Field label="受注店舗 (依頼元)" required><StoreSelect db={db} name="receivedStoreId" required /></Field>
            <Field label="施工店舗" required><StoreSelect db={db} name="workStoreId" required /></Field>
            <Field label="工事の区分">
              <Select name="workKind" defaultValue="normal">
                <option value="normal">通常工事</option>
                <option value="reform">リフォーム工事</option>
              </Select>
            </Field>
            <Field label="税区分">
              <Select name="taxCategory" defaultValue="unset">
                {Object.entries(TAX_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="本部売上・特殊配分あり">
              <Select name="hqSpecial" defaultValue="">
                <option value="">なし</option>
                <option value="1">あり</option>
              </Select>
            </Field>
            {ctx.canAdmin && <Field label="特例の配分率 (%・管理者)" hint="空欄なら設定の標準の率"><Input name="overridePct" inputMode="decimal" /></Field>}
            <Field label="理由・備考"><Input name="reason" /></Field>
            <div className="@3xl:col-span-4"><Button type="submit">保存</Button></div>
          </form>
          {saved.length > 0 && <p className="mt-3 text-xs text-ink-2">この期間の登録済みの受注: {saved.length} 件</p>}
        </Card>
      )}

      {ctx.canAdmin && (
        <Card>
          <CardHeader title="本部の特殊配分・手入力の調整 (管理者)" description="固定の率ではなく、作業に相当する金額を指定して配分します (例: 本部で約 45 万円の売上のうち、中央店が請け負った工賃に相当する約 24 万円を中央店の売上に)。受け取る店舗 = 作業した店舗、渡す店舗 = 本部。全社の外部売上は変わりません。原価は作業した店舗に計上します (材料原価のタブ・仕入明細の振り分けで作業した店舗を選ぶ)。輸出など消費税のかからない売上は、受注の売上の帰属で税区分を「免税」にしてください" />
          <form action={createAdjustment} className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
            {b}
            <Field label="種類">
              <Select name="kind" defaultValue="hq_special">
                <option value="hq_special">本部の特殊配分</option>
                <option value="manual">手入力の調整</option>
              </Select>
            </Field>
            <Field label="受け取る店舗" required><StoreSelect db={db} name="fromStoreId" required /></Field>
            <Field label="渡す店舗" required><StoreSelect db={db} name="toStoreId" defaultValue="hq" required /></Field>
            <Field label="金額 (円)" required><Input name="amount" inputMode="numeric" required /></Field>
            <Field label="金額の税">
              <Select name="base" defaultValue="tax_excluded">
                <option value="tax_excluded">税抜</option>
                <option value="tax_included">税込</option>
              </Select>
            </Field>
            <Field label="計上日" required><Input type="date" name="date" defaultValue={ctx.today} required /></Field>
            <Field label="会計上の扱い">
              <Select name="treatment" defaultValue={rate("hq.treatment").value}>
                {Object.entries(TREATMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="受注番号 (任意)"><Input name="order" /></Field>
            <Field label="理由" required className="@3xl:col-span-3"><Input name="reason" required placeholder="例: 本部売上のうち中央店の畳の作業分" /></Field>
            <div className="@3xl:col-span-4"><Button type="submit">登録</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}
