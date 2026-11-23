import { yen } from "@/lib/format";
import { MOVE_KIND_LABEL, locLabel, monthlyMovement, stockBalances, stockTotals } from "@/lib/mgmt/stock";
import { approveStockMove, postMaterialTransfer, postStockMoveAction, reverseMaterialTransfer, reverseStockMoveAction } from "@/lib/actions/mgmt";
import { transferSummary } from "@/lib/mgmt/transfers";
import { categoryName, itemCategories } from "@/lib/mgmt/categories";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { Money, PeriodForm, back, storeNameOf, userNameOf, type Ctx } from "./parts";

export function StockTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const visibleLoc = (loc?: string) => !ctx.storeIds || (loc ?? "").replace(/^store:/, "") === ctx.storeIds[0];
  const mats = new Map(db.materials.map((m) => [m.id, m]));
  const balances = stockBalances(db, ctx.today).filter((b) => (!ctx.storeIds || ctx.storeIds.includes(b.storeId)) && (b.qty !== 0 || b.amount !== 0));
  const totals = stockTotals(db, ctx.today);
  const month = ctx.month;
  const movement = monthlyMovement(db, month).filter((r) => !ctx.storeIds || ctx.storeIds.includes(r.storeId));
  const moves = db.stockMoves
    .filter((m) => m.date.startsWith(month) && (visibleLoc(m.fromLoc) || visibleLoc(m.toLoc)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const drafts = db.stockMoves.filter((m) => m.status === "draft" && (visibleLoc(m.fromLoc) || visibleLoc(m.toLoc)));
  const stores = db.stores.filter((s) => !ctx.storeIds || ctx.storeIds.includes(s.id));
  const cols = ["receive", "in", "out", "use", "return", "dispose", "adjust"];
  const colLabel: Record<string, string> = { receive: "受入", in: "移動 (入)", out: "移動 (出)", use: "使用", return: "返品", dispose: "廃棄", adjust: "棚卸の調整" };
  const b = back(ctx);
  const locOptions = [
    ...db.stores.filter((s) => !ctx.storeIds || ctx.canEdit || ctx.storeIds.includes(s.id)).map((s) => [`store:${s.id}`, s.name]),
    ["supplier", "仕入先"],
    ["disposal", "廃棄"],
    ["adjust", "棚卸の調整"],
  ];

  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} monthOnly />
      <Note>
        <strong>本部の在庫の材料 (畳表・畳縁・畳床)</strong> は「受入」で本部の在庫に入れ、店舗へ「移動」し、案件で「使用」します (在庫の移動は材料費にならず、使ったときに原価)。<strong>店舗で仕入れて材料費にした材料 (襖紙・クロス・ベニアなど)</strong> を別の店舗へ渡したときは、下の「店舗間の材料移動 (原価の振替)」に登録すると、渡した店舗の材料費が減り、受け取った店舗の材料費が増えます (全社の材料費は変わりません)。ハガキ・タオルなど最終的に案分経費になるものは、材料移動ではなく案分経費 (経費の区分) で管理します。取消しは逆の行を追加します (元の行は残ります)。
      </Note>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card className="@4xl:col-span-2">
          <CardHeader title="在庫 (今日時点)" description={`全社の在庫金額 ${yen(totals.amount)}`} />
          <Table minWidth="min-w-[560px]">
            <thead>
              <tr>
                <Th>店舗</Th>
                <Th>材料</Th>
                <Th align="right">数量</Th>
                <Th align="right">金額</Th>
              </tr>
            </thead>
            <tbody>
              {balances.map((x) => (
                <Tr key={`${x.storeId}|${x.materialId}`}>
                  <Td>{storeNameOf(db, x.storeId)}</Td>
                  <Td>{mats.get(x.materialId)?.name ?? x.materialId}</Td>
                  <Td align="right" className={x.qty < 0 ? "text-critical" : ""}>{x.qty} {mats.get(x.materialId)?.unit}</Td>
                  <Td align="right"><Money v={x.amount} /></Td>
                </Tr>
              ))}
              {balances.length === 0 && (
                <Tr>
                  <Td className="text-ink-2">在庫の記録はまだありません。</Td>
                </Tr>
              )}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="移動を登録する" description={ctx.canEdit ? "登録するとすぐに確定します" : "店長の登録は申請になり、本部スタッフ・管理者が確定します"} />
          <form action={postStockMoveAction} className="space-y-2">
            {b}
            <Field label="種類" required>
              <Select name="kind" defaultValue="transfer">
                {Object.entries(MOVE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="材料" required>
              <Select name="materialId" required defaultValue="">
                <option value="">選ぶ…</option>
                {db.materials.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.code} {m.name}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="移動元">
                <Select name="fromLoc" defaultValue="store:hq">{locOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              </Field>
              <Field label="移動先">
                <Select name="toLoc" defaultValue={ctx.storeIds ? `store:${ctx.storeIds[0]}` : "store:koshi"}>{locOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              </Field>
              <Field label="数量" required><Input name="qty" inputMode="decimal" required /></Field>
              <Field label="単価 (空欄 = 在庫の平均)"><Input name="unitCost" inputMode="decimal" /></Field>
              <Field label="日付" required><Input type="date" name="date" defaultValue={ctx.today} required /></Field>
              <Field label="案件 (使用のとき)"><Input name="order" placeholder="受注番号" /></Field>
            </div>
            <Field label="備考"><Input name="note" /></Field>
            <Button type="submit">登録</Button>
          </form>
        </Card>
      </div>

      <TransferCard ctx={ctx} />

      {drafts.length > 0 && (
        <Card>
          <CardHeader title={`申請中の移動 (${drafts.length} 件)`} />
          <ul className="space-y-2 text-sm">
            {drafts.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span>{m.number} {m.date} {mats.get(m.materialId)?.name} {m.qty} {locLabel(db, m.fromLoc)} → {locLabel(db, m.toLoc)} ({userNameOf(db, m.createdBy)})</span>
                {ctx.canEdit && (
                  <form action={approveStockMove}>
                    {b}
                    <input type="hidden" name="id" value={m.id} />
                    <Button type="submit" size="sm">確定</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title={`${month} の材料移動の集計 (店舗 × 材料)`} description="材料移動のスプレッドシートに当たる表。取消しは元の種類の列にマイナスで入ります" />
        <Table minWidth="min-w-[900px]">
          <thead>
            <tr>
              <Th>店舗</Th>
              <Th>材料</Th>
              {cols.map((c) => <Th key={c} align="right">{colLabel[c]}</Th>)}
            </tr>
          </thead>
          <tbody>
            {stores.flatMap((s) =>
              movement
                .filter((r) => r.storeId === s.id)
                .map((r) => (
                  <Tr key={`${r.storeId}|${r.materialId}`}>
                    <Td>{s.shortName}</Td>
                    <Td>{mats.get(r.materialId)?.name}</Td>
                    {cols.map((c) => (
                      <Td key={c} align="right" className="text-xs">
                        {r.cols[c] ? (
                          <>
                            {r.cols[c].qty}
                            <div className="text-ink-2">{yen(r.cols[c].amount)}</div>
                          </>
                        ) : (
                          "-"
                        )}
                      </Td>
                    ))}
                  </Tr>
                )),
            )}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title={`${month} の移動 (${moves.length} 件)`} />
        <Table minWidth="min-w-[960px]">
          <thead>
            <tr>
              <Th>番号・日付</Th>
              <Th>種類</Th>
              <Th>材料</Th>
              <Th>移動元 → 移動先</Th>
              <Th align="right">数量 × 単価</Th>
              <Th align="right">金額</Th>
              <Th>状態</Th>
              <Th>取消し</Th>
            </tr>
          </thead>
          <tbody>
            {moves.slice(0, 200).map((m) => (
              <Tr key={m.id}>
                <Td className="whitespace-nowrap">{m.number}<div className="text-xs text-ink-2">{m.date}</div></Td>
                <Td>{MOVE_KIND_LABEL[m.kind]}</Td>
                <Td>{mats.get(m.materialId)?.name}</Td>
                <Td className="text-xs">{locLabel(db, m.fromLoc)} → {locLabel(db, m.toLoc)}{m.note && <div className="text-ink-2">{m.note}</div>}</Td>
                <Td align="right" className="text-xs">{m.qty} × {yen(m.unitCost)}</Td>
                <Td align="right"><Money v={m.amount} /></Td>
                <Td>{m.reversalOf ? <Badge tone="neutral">取消しの行</Badge> : m.status === "reversed" ? <Badge tone="neutral">取消し済み</Badge> : m.status === "draft" ? <Badge tone="warn">申請中</Badge> : <Badge tone="good">確定</Badge>}</Td>
                <Td>
                  {ctx.canEdit && (m.status === "confirmed" || m.status === "draft") && !m.reversalOf && (
                    <form action={reverseStockMoveAction} className="flex gap-1">
                      {b}
                      <input type="hidden" name="id" value={m.id} />
                      <Input name="reason" placeholder="理由" required className="w-24" />
                      <Button type="submit" size="sm" variant="secondary">取消し</Button>
                    </form>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

/** 店舗間の材料移動 (原価の振替): これまでの「材料移動」の表の襖材料などの欄 */
function TransferCard({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const month = ctx.month;
  const visible = (id: string) => !ctx.storeIds || ctx.storeIds.includes(id);
  const list = db.materialTransfers
    .filter((t) => t.date.startsWith(month) && (visible(t.fromStoreId) || visible(t.toStoreId)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const summary = transferSummary(db, month).filter((r) => visible(r.storeId));
  const cats = itemCategories(db).filter((c) => c.active);
  const b = back(ctx);
  const fmtCats = (r: Record<string, number>) => Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${categoryName(db, k)} ${yen(v)}`).join("・") || "-";
  return (
    <Card>
      <CardHeader title={`店舗間の材料移動 (原価の振替) · ${month} · ${list.length} 件`} description="店舗で仕入れて材料費にした材料を別の店舗へ渡したときに登録します。品目は使い道で選びます (例: ベニアを襖に使えば襖、リフォームに使えばリフォーム)" />
      {ctx.canEdit ? (
        <form action={postMaterialTransfer} className="mb-4 grid grid-cols-1 gap-2 @3xl:grid-cols-4">
          {b}
          <Field label="日付" required><Input type="date" name="date" defaultValue={ctx.today} required /></Field>
          <Field label="渡した店舗" required>
            <Select name="fromStoreId" required defaultValue="">
              <option value="">選ぶ…</option>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="受け取った店舗" required>
            <Select name="toStoreId" required defaultValue="">
              <option value="">選ぶ…</option>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="品目 (使い道)">
            <Select name="itemCategory" defaultValue="">
              <option value="">材料の品目のまま</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="材料 (材料マスタ)">
            <Select name="materialId" defaultValue="">
              <option value="">選ばない (品名を入力)</option>
              {db.materials.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.code} {m.name}</option>)}
            </Select>
          </Field>
          <Field label="品名 (材料マスタにないとき)"><Input name="name" placeholder="例: 襖紙 (品番)" /></Field>
          <Field label="数量" required><Input name="qty" inputMode="decimal" required /></Field>
          <Field label="単価 (税抜・空欄 = 材料マスタの単価)"><Input name="unitCost" inputMode="decimal" /></Field>
          <Field label="備考" className="@3xl:col-span-3"><Input name="note" /></Field>
          <div className="flex items-end"><Button type="submit">登録</Button></div>
        </form>
      ) : (
        <p className="mb-3 text-xs text-ink-2">登録は本部スタッフ・管理者が行います。</p>
      )}
      {summary.length > 0 && (
        <Table minWidth="min-w-[640px]" className="mb-3">
          <thead>
            <tr>
              <Th>店舗</Th>
              <Th>受け取った (材料費 +)</Th>
              <Th>渡した (材料費 −)</Th>
              <Th align="right">材料費の増減</Th>
            </tr>
          </thead>
          <tbody>
            {summary.map((r) => (
              <Tr key={r.storeId}>
                <Td>{storeNameOf(db, r.storeId)}</Td>
                <Td className="text-xs">{fmtCats(r.received)}</Td>
                <Td className="text-xs">{fmtCats(r.sent)}</Td>
                <Td align="right"><Money v={r.net} strong /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Table minWidth="min-w-[900px]">
        <thead>
          <tr>
            <Th>番号・日付</Th>
            <Th>渡した → 受け取った</Th>
            <Th>品名・品目</Th>
            <Th align="right">数量 × 単価</Th>
            <Th align="right">金額</Th>
            <Th>状態</Th>
            <Th>取消し</Th>
          </tr>
        </thead>
        <tbody>
          {list.slice(0, 200).map((t) => (
            <Tr key={t.id}>
              <Td className="whitespace-nowrap">{t.number}<div className="text-xs text-ink-2">{t.date}</div></Td>
              <Td className="text-xs">{storeNameOf(db, t.fromStoreId)} → {storeNameOf(db, t.toStoreId)}</Td>
              <Td className="text-xs">{t.name}<div className="text-ink-2">{categoryName(db, t.itemCategory)}{t.note ? ` · ${t.note}` : ""}</div></Td>
              <Td align="right" className="text-xs">{t.qty} × {yen(t.unitCost)}</Td>
              <Td align="right"><Money v={t.reversalOf ? -t.amount : t.amount} /></Td>
              <Td>{t.reversalOf ? <Badge tone="neutral">取消しの行</Badge> : t.status === "reversed" ? <Badge tone="neutral">取消し済み</Badge> : <Badge tone="good">登録済み</Badge>}</Td>
              <Td>
                {ctx.canEdit && t.status === "active" && !t.reversalOf && (
                  <form action={reverseMaterialTransfer} className="flex gap-1">
                    {b}
                    <input type="hidden" name="id" value={t.id} />
                    <Input name="reason" placeholder="理由" required className="w-24" />
                    <Button type="submit" size="sm" variant="secondary">取消し</Button>
                  </form>
                )}
              </Td>
            </Tr>
          ))}
          {list.length === 0 && (
            <Tr>
              <Td className="text-ink-2">この月の材料移動はありません。</Td>
            </Tr>
          )}
        </tbody>
      </Table>
    </Card>
  );
}
