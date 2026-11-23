import Link from "next/link";
import { fmtDate, yen } from "@/lib/format";
import { salesFacts } from "@/lib/assistant/facts";
import { autoUsage, costingLines, countedUsages, planUsage, MATERIAL_KIND_LABEL, STAGE_LABEL, SIZE_LABEL } from "@/lib/mgmt/costing";
import { productionNoteIndex, productionNotes } from "@/lib/mgmt/doko";
import { canRecordUsage } from "@/lib/mgmt/access";
import { recordOrderCost, saveLineCategories } from "@/lib/actions/mgmt";
import { categoryName, itemCategories, lineItemCategory, orderLineSource } from "@/lib/mgmt/categories";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { Money, PeriodForm, back, qs, type Ctx } from "./parts";

export function CostTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const facts = salesFacts(db).byId;
  const visible = (id: string) => !ctx.storeIds || ctx.storeIds.includes(id);
  const orderParam = ctx.sp.order ? db.orders.find((o) => o.id === ctx.sp.order || o.number === ctx.sp.order) : undefined;
  const orders = db.orders.filter((o) => o.status !== "cancelled" && (o.salesDate ?? o.contractDate) >= ctx.from && (o.salesDate ?? o.contractDate) <= ctx.to && visible(o.storeId));
  const notes = productionNoteIndex(db);
  const rows = orders
    .map((o) => {
      const used = countedUsages(db, o.id);
      const fact = facts.get(o.id);
      const tatami = (fact?.amounts.tatami ?? (o.category === "tatami" ? o.total : 0)) > 0;
      const legacy = !used.length && Boolean(o.tatamiCost);
      // 原価の行がない受注は、材料構成から自動で計算した原価 (店舗別損益にもこの金額が入る)
      const auto = !used.length && !legacy && tatami ? autoUsage(db, o, fact, o.salesDate ?? ctx.today, notes.get(o.id) ?? "") : undefined;
      return { o, used, tatami, legacy, auto };
    })
    .filter((r) => r.tatami || r.used.length);
  const status = (r: (typeof rows)[number]) =>
    r.used.length
      ? r.used.some((u) => u.needsReview) ? "review" : r.used[0].stage
      : r.legacy
        ? "legacy"
        : r.auto?.usages.length
          ? r.auto.usages.some((u) => u.needsReview) || r.auto.unmatched.length ? "review" : "auto"
          : r.auto?.unmatched.length
            ? "review"
            : "none";
  const counts = { none: 0, review: 0, auto: 0, estimate: 0, planned: 0, actual: 0, legacy: 0 } as Record<string, number>;
  for (const r of rows) counts[status(r)]++;
  const filter = ctx.sp.status ?? "";
  const list = rows.filter((r) => !filter || status(r) === filter);
  const docoMaterials = db.materials.filter((m) => m.active && m.kind === "doko");

  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} />
      <Note>
        材料原価 = 使用数量 × その日の単価。<strong>売上明細の商品・数量と材料構成 (BOM) から自動で計算</strong>し、原価の行を登録していない受注も店舗別損益に入ります (「自動計算」)。半畳は材料ごとの係数 (畳表などは 2 枚で 1 枚分 = 0.5)、副資材は 1 枚 (半畳も 1 枚) あたりの設定の単価。畳表は仮原価で計上し、実際の仕入との差額は共通経費の案分のタブで粗利益の比率で案分します。
        <strong>畳床</strong>は品名と製造の予定 (予定表の製造の欄の「床」「サイズ」) から 種類・厚み・寸法 を読み、材料マスタの畳床を選びます (寸法が五八以下なら五八間、それより大きければ本間の畳床)。決まらなければ材料構成の既定の畳床で計算して「既定の仕様」と表示し、既定もなければ「要確認」(金額なし) にします。段階は 予想原価 → 使用予定 → 実績 で、受注ごとに一番進んだ段階だけを原価に数えます。売上台帳から移行した受注は、移行した畳原価をそのまま使います。
      </Note>
      <div className="flex flex-wrap gap-2 text-xs">
        {[["", `すべて (${rows.length})`], ["auto", `自動計算 (${counts.auto})`], ["none", `材料構成なし (${counts.none})`], ["review", `要確認 (${counts.review})`], ["estimate", `予想 (${counts.estimate})`], ["planned", `使用予定 (${counts.planned})`], ["actual", `実績 (${counts.actual})`], ["legacy", `移行の畳原価 (${counts.legacy})`]].map(([k, l]) => (
          <Link key={k} href={qs(ctx, { status: k || undefined })} className={`rounded-full border px-2.5 py-1 ${filter === k ? "border-accent bg-accent-soft" : "border-line"}`}>
            {l}
          </Link>
        ))}
      </div>
      {orderParam && <OrderCosting ctx={ctx} orderId={orderParam.id} docoIds={docoMaterials.map((m) => m.id)} />}
      <Table minWidth="min-w-[820px]">
        <thead>
          <tr>
            <Th>受注</Th>
            <Th>売上計上日</Th>
            <Th>店舗</Th>
            <Th align="right">売上 (税込)</Th>
            <Th>原価の段階</Th>
            <Th align="right">材料原価</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {list.slice(0, 150).map((r) => {
            const st = status(r);
            const amount = r.used.length ? r.used.reduce((a, u) => a + (u.amount ?? 0), 0) : r.legacy ? Math.round(r.o.tatamiCost ?? 0) : r.auto?.usages.length ? r.auto.usages.reduce((a, u) => a + (u.amount ?? 0), 0) : null;
            return (
              <Tr key={r.o.id}>
                <Td>
                  <Link className="text-accent hover:underline" href={`/orders/${r.o.id}`}>{r.o.number}</Link>
                  <div className="text-xs text-ink-2">{r.o.title}</div>
                </Td>
                <Td>{r.o.salesDate ? fmtDate(r.o.salesDate) : "未完了"}</Td>
                <Td>{db.stores.find((s) => s.id === r.o.storeId)?.shortName}</Td>
                <Td align="right">{yen(r.o.total)}</Td>
                <Td>
                  {st === "review" ? <Badge tone="warn">要確認</Badge> : st === "none" ? <Badge tone="neutral">材料構成なし</Badge> : st === "legacy" ? <Badge tone="info">移行の畳原価</Badge> : st === "auto" ? <Badge tone="info">自動計算{r.auto?.usages.some((u) => u.assumed) ? " (既定の仕様)" : ""}</Badge> : <Badge tone={st === "actual" ? "good" : "info"}>{STAGE_LABEL[st as "actual"]}</Badge>}
                </Td>
                <Td align="right"><Money v={amount} /></Td>
                <Td>
                  <Link className="text-xs text-accent hover:underline" href={qs(ctx, { order: r.o.id }) + "#costing"}>原価を見る・登録</Link>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      {list.length > 150 && <p className="text-xs text-ink-2">先頭の 150 件を表示しています。</p>}
    </div>
  );
}

function OrderCosting({ ctx, orderId, docoIds }: { ctx: Ctx; orderId: string; docoIds: string[] }) {
  const { db } = ctx;
  const o = db.orders.find((x) => x.id === orderId)!;
  if (ctx.storeIds && !ctx.storeIds.includes(o.storeId)) return <Note tone="warn">この受注は見られません。</Note>;
  const fact = salesFacts(db).byId.get(o.id);
  const lines = costingLines(db, o, fact);
  const date = o.salesDate ?? ctx.today;
  const hint = productionNotes(db, o.id);
  const plan = planUsage(db, lines, date, {}, { hintText: hint });
  const all = db.materialUsages.filter((u) => u.orderId === o.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counted = new Set(countedUsages(db, o.id).map((u) => u.id));
  const docos = db.materials.filter((m) => docoIds.includes(m.id));
  const editable = canRecordUsage(ctx.user, o);
  return (
    <Card id="costing">
      <CardHeader title={`材料原価: ${o.number} ${o.title}`} description={`明細 ${lines.length} 行 · ${date} 時点の単価で計算${o.tatamiCost ? ` · 移行の畳原価 ${yen(Math.round(o.tatamiCost))}` : ""}`} />
      {lines.length === 0 && <Note tone="warn">原価を計算できる明細がありません (見積の明細・売上台帳の明細がない受注)。</Note>}
      {hint && <p className="mb-2 text-xs text-ink-2">製造の予定のメモ (畳床の判定に使用): {hint}</p>}
      <LineCategories ctx={ctx} orderId={o.id} />
      {plan.unmatched.length > 0 && <Note tone="warn">材料構成のない畳の明細: {plan.unmatched.map((l) => `${l.label} ×${l.qty}`).join("・")} — 材料・単価・材料構成のタブで材料構成を登録してください。</Note>}
      {editable && plan.usages.length > 0 && (
        <form action={recordOrderCost} className="space-y-3">
          {back(ctx, { order: o.id })}
          <input type="hidden" name="orderId" value={o.id} />
          <Table minWidth="min-w-[760px]">
            <thead>
              <tr>
                <Th>明細</Th>
                <Th>材料</Th>
                <Th align="right">数量</Th>
                <Th align="right">単価</Th>
                <Th align="right">金額</Th>
                <Th>計算</Th>
              </tr>
            </thead>
            <tbody>
              {plan.usages.map((u) => (
                <Tr key={u.lineKey}>
                  <Td className="text-xs">{u.productLabel} ×{u.sheets}</Td>
                  <Td>
                    {MATERIAL_KIND_LABEL[u.materialKind]}
                    {u.materialKind === "doko" && (u.needsReview || u.spec?.inferred) && (
                      <div className="mt-1">
                        <Select name={`spec:${u.lineKey}`} defaultValue={u.needsReview ? "" : (u.materialId ?? "")}>
                          <option value="">畳床の仕様を選ぶ…</option>
                          {docos.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} {m.thickness ? `${m.thickness}mm` : ""} {m.size ? SIZE_LABEL[m.size] ?? m.size : ""}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </Td>
                  <Td align="right">{u.qty}</Td>
                  <Td align="right">{u.unitCost !== undefined ? yen(u.unitCost) : "-"}</Td>
                  <Td align="right"><Money v={u.amount} /></Td>
                  <Td className="text-xs">{u.needsReview ? <span className="text-warn-ink">要確認: {u.reviewNote}</span> : u.explain}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="登録する段階">
              <Select name="stage" defaultValue={o.salesDate ? "actual" : "planned"}>
                <option value="estimate">予想原価 (見積)</option>
                <option value="planned">使用予定 (施工・製造)</option>
                <option value="actual">使用実績 (確認済み)</option>
              </Select>
            </Field>
            <Button type="submit">この内容で登録</Button>
            <span className="text-xs text-ink-2">畳床の仕様を選んだ行は、その材料の単価で計算し直して登録します (判定した畳床のままでよければ、そのまま登録)。登録しなくても、店舗別損益には自動計算の原価が入ります。</span>
          </div>
        </form>
      )}
      {all.length > 0 && (
        <details className="mt-4 text-sm" open>
          <summary className="cursor-pointer text-accent">登録した原価の行 ({all.length} 行・原価に数えるのは一番進んだ段階の有効な行)</summary>
          <Table minWidth="min-w-[760px]" className="mt-2">
            <thead>
              <tr>
                <Th>段階</Th>
                <Th>材料</Th>
                <Th align="right">数量</Th>
                <Th align="right">単価 (当時)</Th>
                <Th align="right">金額</Th>
                <Th>状態</Th>
                <Th>登録</Th>
              </tr>
            </thead>
            <tbody>
              {all.map((u) => (
                <Tr key={u.id}>
                  <Td>{STAGE_LABEL[u.stage]}</Td>
                  <Td>
                    {db.materials.find((m) => m.id === u.materialId)?.name ?? MATERIAL_KIND_LABEL[u.materialKind]}
                    {u.spec?.thickness ? <span className="text-xs text-ink-2"> {u.spec.thickness}mm {u.spec.size ? SIZE_LABEL[u.spec.size] ?? u.spec.size : ""}</span> : null}
                  </Td>
                  <Td align="right">{u.qty}</Td>
                  <Td align="right">{u.unitCost !== undefined ? yen(u.unitCost) : "-"}</Td>
                  <Td align="right"><Money v={u.amount} /></Td>
                  <Td>{counted.has(u.id) ? <Badge tone="good">原価に数える</Badge> : <Badge tone="neutral">{u.status === "superseded" ? "次の段階で置き換え" : u.status === "reversed" ? "訂正で取消し" : "-"}</Badge>}{u.needsReview && <Badge tone="warn">要確認</Badge>}</Td>
                  <Td className="text-xs">{u.createdAt.slice(0, 10)} {db.users.find((x) => x.id === u.createdBy)?.name}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </details>
      )}
      <form method="get" className="mt-3 flex items-end gap-2">
        <input type="hidden" name="tab" value="cost" />
        <Field label="ほかの受注を開く (受注番号)"><Input name="order" /></Field>
        <Button type="submit" variant="secondary">開く</Button>
      </form>
    </Card>
  );
}

/** 受注の明細の品目 (管理会計)。見積の画面で直せない受注 (完了・入金済み) もここで直せる (本部スタッフ・管理者) */
function LineCategories({ ctx, orderId }: { ctx: Ctx; orderId: string }) {
  const { db } = ctx;
  const o = db.orders.find((x) => x.id === orderId)!;
  const src = orderLineSource(db, o);
  if (!src) return null;
  const products = new Map(db.products.map((p) => [p.id, p]));
  const cats = itemCategories(db).filter((c) => c.active);
  return (
    <details className="mb-3 rounded-lg border border-line p-3 text-sm" open={src.items.some((i) => !i.productId && !i.itemCategory)}>
      <summary className="cursor-pointer font-medium">明細の品目 (店舗別・品目別の集計に使う区分) · {src.kind === "quote" ? `見積 ${src.record.number}` : `請求書 ${src.record.number}`}</summary>
      <p className="mt-1 text-xs text-ink-2">「自動」は 商品の品目 → 見積の種別 で決まります。自社商品 (ミニ畳など) やクロス以外のリフォーム工事 (大工など) は品目を選んでください。見積の画面でも、明細ごとに選べます。</p>
      <form action={saveLineCategories} className="mt-2 space-y-2">
        {back(ctx, { order: o.id })}
        <input type="hidden" name="orderId" value={o.id} />
        <Table minWidth="min-w-[560px]">
          <thead>
            <tr>
              <Th>明細</Th>
              <Th align="right">金額</Th>
              <Th>品目</Th>
            </tr>
          </thead>
          <tbody>
            {src.items.map((it, k) => {
              const auto = lineItemCategory({}, it.productId ? products.get(it.productId) : undefined, o.category);
              return (
                <Tr key={it.id ?? k}>
                  <Td className="text-xs">{it.name}{it.spec ? ` ${it.spec}` : ""}</Td>
                  <Td align="right">{yen(it.amount)}</Td>
                  <Td>
                    {ctx.canEdit ? (
                      <Select name={`cat_${k}`} defaultValue={it.itemCategory ?? ""} aria-label={`${it.name} の品目`}>
                        <option value="">自動 ({categoryName(db, auto)})</option>
                        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                    ) : (
                      <span className="text-xs">{categoryName(db, it.itemCategory ?? auto)}{it.itemCategory ? "" : " (自動)"}</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
        {ctx.canEdit && <Button type="submit" size="sm" variant="secondary">品目を保存</Button>}
      </form>
    </details>
  );
}
