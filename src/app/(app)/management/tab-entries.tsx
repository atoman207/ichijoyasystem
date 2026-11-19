import { addMgmtEntry, reverseMgmtEntry } from "@/lib/actions/mgmt";
import { itemCategories } from "@/lib/mgmt/categories";
import type { MgmtEntry } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { Money, PeriodForm, StoreSelect, back, storeNameOf, userNameOf, type Ctx } from "./parts";

export const ENTRY_KIND_LABEL: Record<MgmtEntry["kind"], string> = {
  labor: "人件費",
  store_expense: "店舗独自経費",
  common_expense: "共通経費 (案分の対象)",
  other_mgmt: "その他管理経費",
  material_adjust: "材料の差額調整 (畳表の仮原価と実仕入など)",
  budget: "予算",
};

export function EntriesTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const rows = db.mgmtEntries.filter((m) => m.month === ctx.month && (!ctx.storeIds || ctx.storeIds.includes(m.storeId))).sort((a, b) => a.storeId.localeCompare(b.storeId) || a.createdAt.localeCompare(b.createdAt));
  const b = back(ctx);
  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} monthOnly />
      <Note>
        システムにない数字 (給与などの人件費・管理経費・共通経費・予算) と、畳表の仮原価と実仕入の差額などの調整を、月 × 店舗で入力します (税抜)。畳表の差額の計算方法 (期間・在庫評価) は未確定のため、自動では計算しません。確かめた差額を備考と一緒に入力してください。取消しは逆の行を追加します。
      </Note>
      {ctx.canEdit && (
        <Card>
          <CardHeader title="入力する" />
          <form action={addMgmtEntry} className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
            {b}
            <Field label="月" required><Input type="month" name="month" defaultValue={ctx.month} required /></Field>
            <Field label="店舗" required><StoreSelect db={db} name="storeId" required /></Field>
            <Field label="種類" required>
              <Select name="kind" defaultValue="labor">
                {Object.entries(ENTRY_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="金額 (円・税抜。減らすときはマイナス)" required><Input name="amount" inputMode="numeric" required /></Field>
            <Field label="品目 (材料の差額調整のとき)">
              <Select name="itemCategory" defaultValue="">
                <option value="">-</option>
                {itemCategories(db).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="予算の指標 (予算のとき)">
              <Select name="metric" defaultValue="sales">
                <option value="sales">管理売上</option>
                <option value="gross">粗利益</option>
                <option value="profit">店舗の損益</option>
              </Select>
            </Field>
            <Field label="備考" className="@3xl:col-span-2"><Input name="note" /></Field>
            <div className="@3xl:col-span-4"><Button type="submit">登録</Button></div>
          </form>
        </Card>
      )}
      <Table minWidth="min-w-[820px]">
        <thead>
          <tr>
            <Th>店舗</Th>
            <Th>種類</Th>
            <Th align="right">金額</Th>
            <Th>備考</Th>
            <Th>登録</Th>
            <Th>取消し</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <Tr key={m.id}>
              <Td>{storeNameOf(db, m.storeId)}</Td>
              <Td>{ENTRY_KIND_LABEL[m.kind]}{m.metric && m.kind === "budget" ? ` (${m.metric})` : ""}{m.reversalOf && <Badge tone="neutral">取消しの行</Badge>}{m.status === "reversed" && <Badge tone="neutral">取消し済み</Badge>}</Td>
              <Td align="right"><Money v={m.amount} /></Td>
              <Td className="text-xs">{m.note}</Td>
              <Td className="text-xs">{m.createdAt.slice(0, 10)} {userNameOf(db, m.createdBy)}</Td>
              <Td>
                {ctx.canEdit && m.status === "active" && !m.reversalOf && (
                  <form action={reverseMgmtEntry} className="flex gap-1">
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
    </div>
  );
}
