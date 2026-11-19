import Link from "next/link";
import { yen } from "@/lib/format";
import { COST_TYPE_LABEL } from "@/lib/mgmt/purchase-lines";
import { itemCategories } from "@/lib/mgmt/categories";
import { analyzePurchase, confirmPurchaseLine } from "@/lib/actions/mgmt";
import type { PurchaseLineAlloc } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { Money, PeriodForm, back, qs, storeNameOf, type Ctx } from "./parts";

const STATUS: Record<PurchaseLineAlloc["status"], { label: string; tone: "good" | "warn" | "neutral" }> = {
  confirmed: { label: "確定", tone: "good" },
  needs_review: { label: "要確認", tone: "warn" },
  unassigned: { label: "自動判定 (未確定)", tone: "neutral" },
};

export function PurchasesTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const purchases = db.purchases.filter((p) => p.status !== "rejected" && p.invoiceDate >= ctx.from && p.invoiceDate <= ctx.to).sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
  const allocs = new Map<string, PurchaseLineAlloc[]>();
  for (const a of db.purchaseLineAllocs) (allocs.get(a.purchaseId) ?? allocs.set(a.purchaseId, []).get(a.purchaseId)!).push(a);
  const selected = ctx.sp.purchase ? db.purchases.find((p) => p.id === ctx.sp.purchase) : undefined;
  const unanalyzed = db.purchases.filter((p) => p.status !== "rejected" && !allocs.has(p.id)).length;
  const b = back(ctx);
  const cats = itemCategories(db).filter((c) => c.active);

  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} />
      <Note>
        請求書の明細ごとに、店舗・案件・品目・費用区分へ振り分けます。<strong>自動判定は候補</strong>です (請求書の店舗名・現場名・品番と、材料マスタ・案件の施工内容・発注書・過去に確定した振り分けを照らし合わせます)。根拠が足りない・候補が複数・金額が合わない明細は「要確認」になり、担当者が確定するまで会計の数字には勘定科目で仮に入ります。同じ品番でも使い道で品目が変わるため (例: クロス紙 → 襖の張替は襖、壁紙の張替はリフォーム)、案件で品目を決めます。読み取った内容・自動判定・確定した振り分けは別々に保存します。
      </Note>
      {unanalyzed > 0 && (
        <form action={analyzePurchase} className="flex items-center gap-2">
          {b}
          <input type="hidden" name="all" value="1" />
          <Button type="submit" variant="secondary">まだ判定していない仕入 ({unanalyzed} 件) をまとめて自動判定</Button>
        </form>
      )}
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>仕入</Th>
            <Th>請求日</Th>
            <Th>仕入先</Th>
            <Th align="right">金額 (税込)</Th>
            <Th>明細の振り分け</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {purchases.slice(0, 150).map((p) => {
            const rows = allocs.get(p.id) ?? [];
            const done = rows.filter((r) => r.status === "confirmed").length;
            const review = rows.filter((r) => r.status === "needs_review").length;
            return (
              <Tr key={p.id}>
                <Td><Link className="text-accent hover:underline" href={`/purchases/${p.id}`}>{p.number}</Link><div className="text-xs text-ink-2">{p.description}</div></Td>
                <Td>{p.invoiceDate}</Td>
                <Td>{db.suppliers.find((s) => s.id === p.supplierId)?.name}</Td>
                <Td align="right">{yen(p.amount)}</Td>
                <Td>
                  {rows.length === 0 ? <Badge tone="neutral">未判定</Badge> : (
                    <span className="text-xs">確定 {done}/{rows.length}{review ? <> · <span className="text-warn-ink">要確認 {review}</span></> : null}</span>
                  )}
                </Td>
                <Td><Link className="text-xs text-accent hover:underline" href={qs(ctx, { purchase: p.id }) + "#lines"}>明細を開く</Link></Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>

      {selected && (
        <Card id="lines">
          <CardHeader title={`仕入 ${selected.number} の明細`} description={`${db.suppliers.find((s) => s.id === selected.supplierId)?.name ?? ""} · 請求日 ${selected.invoiceDate} · ${yen(selected.amount)} (うち消費税 ${yen(selected.taxAmount)}) · 振り分けの金額は税抜`} />
          <form action={analyzePurchase} className="mb-3">
            {back(ctx, { purchase: selected.id })}
            <input type="hidden" name="purchaseId" value={selected.id} />
            <Button type="submit" variant="secondary" size="sm">{allocs.has(selected.id) ? "もう一度自動判定 (確定した明細はそのまま)" : "自動判定する"}</Button>
          </form>
          <div className="space-y-4">
            {(allocs.get(selected.id) ?? []).sort((a, b) => a.lineNo - b.lineNo).map((a) => {
              const rows = a.splits.length ? a.splits : [{ storeId: a.ai?.storeId ?? "", orderId: a.ai?.orderId, itemCategory: a.ai?.itemCategory ?? "", costType: a.ai?.costType ?? "material", materialId: a.ai?.materialId, qty: a.ocr.qty, amount: a.ocr.amountExTax }];
              const slots = [...rows, ...Array.from({ length: Math.max(0, 3 - rows.length) }, () => undefined)];
              return (
                <div key={a.id} className="rounded-xl border border-line/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <strong>{a.lineNo}. {a.ocr.name}</strong>
                    {a.ocr.code && <span className="text-xs">品番 {a.ocr.code}</span>}
                    {a.ocr.spec && <span className="text-xs text-ink-2">{a.ocr.spec}</span>}
                    <span className="text-xs">{a.ocr.qty ?? "-"} {a.ocr.unit ?? ""} × {a.ocr.unitPrice !== undefined ? yen(a.ocr.unitPrice) : "-"} = {yen(a.ocr.amount)} (税抜 {yen(a.ocr.amountExTax)})</span>
                    <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                  </div>
                  {(a.ocr.storeText || a.ocr.siteText || a.ocr.note) && <div className="mt-1 text-xs text-ink-2">請求書の記載: {[a.ocr.storeText && `店舗 ${a.ocr.storeText}`, a.ocr.siteText && `現場 ${a.ocr.siteText}`, a.ocr.note].filter(Boolean).join(" / ")}</div>}
                  {a.ai && (
                    <div className="mt-2 rounded-lg bg-panel-2 px-3 py-2 text-xs">
                      <div>
                        自動判定: {storeNameOf(db, a.ai.storeId)} / {a.ai.orderId ? db.orders.find((o) => o.id === a.ai!.orderId)?.number : "案件なし"} / {cats.find((c) => c.id === a.ai!.itemCategory)?.name ?? "品目?"} / {a.ai.costType ? COST_TYPE_LABEL[a.ai.costType] : "区分?"} · 信頼度 {a.ai.confidence}
                        {a.ai.needsReview && <span className="ml-1 font-medium text-warn-ink">要確認</span>}
                      </div>
                      <div className="mt-1 text-ink-2">理由: {a.ai.reason}</div>
                      {a.ai.refs.length > 0 && <div className="text-ink-2">参照: {a.ai.refs.join(", ")}</div>}
                      {a.ai.candidates && a.ai.candidates.length > 1 && <div className="text-ink-2">案件の候補: {a.ai.candidates.map((c) => `${c.label} (${c.score})`).join(" / ")}</div>}
                    </div>
                  )}
                  {ctx.canEdit && (
                    <form action={confirmPurchaseLine} className="mt-2 space-y-1">
                      {back(ctx, { purchase: selected.id })}
                      <input type="hidden" name="id" value={a.id} />
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[820px] text-xs">
                          <thead>
                            <tr className="text-left text-ink-2">
                              <th className="px-1">店舗</th>
                              <th className="px-1">案件 (受注番号)</th>
                              <th className="px-1">品目</th>
                              <th className="px-1">費用区分</th>
                              <th className="px-1">材料 (在庫のとき)</th>
                              <th className="px-1">数量</th>
                              <th className="px-1">金額 (税抜)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {slots.map((s, i) => (
                              <tr key={i}>
                                <td className="px-1 py-0.5">
                                  <Select name={`store${i}`} defaultValue={s?.storeId ?? ""}>
                                    <option value="">-</option>
                                    {db.stores.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                                  </Select>
                                </td>
                                <td className="px-1 py-0.5"><Input name={`order${i}`} defaultValue={s?.orderId ? db.orders.find((o) => o.id === s.orderId)?.number : ""} /></td>
                                <td className="px-1 py-0.5">
                                  <Select name={`cat${i}`} defaultValue={s?.itemCategory ?? ""}>
                                    <option value="">-</option>
                                    {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                  </Select>
                                </td>
                                <td className="px-1 py-0.5">
                                  <Select name={`costType${i}`} defaultValue={s?.costType ?? "material"}>
                                    {Object.entries(COST_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                  </Select>
                                </td>
                                <td className="px-1 py-0.5">
                                  <Select name={`material${i}`} defaultValue={s?.materialId ?? ""}>
                                    <option value="">-</option>
                                    {db.materials.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                  </Select>
                                </td>
                                <td className="px-1 py-0.5"><Input name={`qty${i}`} defaultValue={s?.qty !== undefined ? String(s.qty) : ""} inputMode="decimal" className="w-20" /></td>
                                <td className="px-1 py-0.5"><Input name={`amount${i}`} defaultValue={s ? String(s.amount) : ""} inputMode="numeric" className="w-28" /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input name="reason" placeholder="判断の理由 (修正したとき)" className="max-w-sm" defaultValue={a.reason ?? ""} />
                        <Button type="submit" size="sm">{a.status === "confirmed" ? "振り分けを訂正" : "この振り分けで確定"}</Button>
                        <span className="text-ink-2">金額の合計は {yen(a.ocr.amountExTax)} (税抜) に合わせます。分けないときは 1 行だけ入力します。</span>
                      </div>
                    </form>
                  )}
                  {a.status === "confirmed" && <div className="mt-1 text-xs text-ink-2">確定: {a.confirmedAt?.slice(0, 16).replace("T", " ")} {db.users.find((u) => u.id === a.confirmedBy)?.name} · {a.splits.map((s) => `${storeNameOf(db, s.storeId)} ${cats.find((c) => c.id === s.itemCategory)?.name} ${COST_TYPE_LABEL[s.costType]} `).join(" / ")}<Money v={a.splits.reduce((x, s) => x + s.amount, 0)} /></div>}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
