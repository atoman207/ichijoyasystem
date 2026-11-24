import { yen } from "@/lib/format";
import { MATERIAL_KIND_LABEL, SIZE_LABEL, costAt } from "@/lib/mgmt/costing";
import { itemCategories } from "@/lib/mgmt/categories";
import { DEFAULT_VALID_FROM } from "@/lib/mgmt/tatami-cost-sheet";
import { importMaterialsCsv, importTatamiCostSheet, saveBom, saveMaterial, setMaterialCostAction } from "@/lib/actions/mgmt";
import { Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Textarea, Tr } from "@/components/ui";
import { back, userNameOf, type Ctx } from "./parts";
import type { MaterialKind } from "@/lib/db/types";

export function MastersTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const b = back(ctx);
  const cats = itemCategories(db);
  const kindFilter = (ctx.sp.kind ?? "") as MaterialKind | "";
  const q = (ctx.sp.q ?? "").trim();
  const materials = db.materials
    .filter((m) => (!kindFilter || m.kind === kindFilter) && (!q || m.name.includes(q) || m.code.includes(q)))
    .sort((a, b2) => a.kind.localeCompare(b2.kind) || a.name.localeCompare(b2.name, "ja"));
  const sel = ctx.sp.material ? db.materials.find((m) => m.id === ctx.sp.material) : undefined;
  const boms = [...db.boms].sort((a, b2) => a.name.localeCompare(b2.name, "ja") || b2.validFrom.localeCompare(a.validFrom));
  const filterQs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ tab: "masters" });
    const kind = extra.kind !== undefined ? extra.kind : kindFilter;
    const query = extra.q !== undefined ? extra.q : q;
    const material = extra.material !== undefined ? extra.material : ctx.sp.material;
    if (kind) p.set("kind", kind);
    if (query) p.set("q", query);
    if (material) p.set("material", material);
    return `/management?${p.toString()}`;
  };
  return (
    <div className="space-y-4">
      <Note>
        材料ごとの原価単価を一覧で管理します。単価を変えるときは「適用開始日」を付けて新しい行を登録します (前の単価は履歴に残ります)。すでに登録した受注・売上の原価 (当時の単価の写し) は変わりません。新しい受注から新しい単価が使われます。畳表 (い草) は仕入相場で変わるため「仮原価」で登録します。副資材 (1 枚 100 円) は設定タブで変えます。原価のデータは社外秘のため、リポジトリには入れず、ここで登録・取込します。
      </Note>
      <Card>
        <CardHeader title={`材料・単価一覧 (${materials.length} / ${db.materials.length} 件)`} description="仕入価格の値上げ・変更があったら、該当の材料を開いて単価を登録してください。品目の追加も下の「材料を追加」からできます。" />
        <form className="mb-3 flex flex-wrap items-end gap-2" method="get" action="/management">
          <input type="hidden" name="tab" value="masters" />
          <Field label="種類">
            <Select name="kind" defaultValue={kindFilter}>
              <option value="">すべて</option>
              {Object.entries(MATERIAL_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="名前・コード"><Input name="q" defaultValue={q} placeholder="きずな・HERI など" /></Field>
          <Button type="submit" size="sm" variant="secondary">絞り込み</Button>
        </form>
        <Table minWidth="min-w-[860px]">
          <thead>
            <tr>
              <Th>コード</Th>
              <Th>名前</Th>
              <Th>種類</Th>
              <Th>品目</Th>
              <Th>仕様</Th>
              <Th align="right">今日の単価</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const c = costAt(db, m.id, ctx.today);
              return (
                <Tr key={m.id}>
                  <Td className="text-xs">{m.code}{m.supplierCode && <div className="text-ink-2">品番 {m.supplierCode}</div>}</Td>
                  <Td>{m.name}{!m.active && <span className="text-xs text-ink-2"> (使わない)</span>}</Td>
                  <Td>{MATERIAL_KIND_LABEL[m.kind]}</Td>
                  <Td>{cats.find((x) => x.id === m.itemCategory)?.name}</Td>
                  <Td className="text-xs">{[m.spec, m.thickness ? `${m.thickness}mm` : "", m.size ? SIZE_LABEL[m.size] ?? m.size : ""].filter(Boolean).join(" ")}</Td>
                  <Td align="right">{c ? `${yen(c.unitCost)}${c.kind === "provisional" ? " (仮)" : ""}` : <span className="text-warn-ink">未登録</span>}</Td>
                  <Td><a className="text-xs text-accent hover:underline" href={filterQs({ material: m.id }) + "#material"}>単価・編集</a></Td>
                </Tr>
              );
            })}
            {!materials.length && (
              <Tr><Td colSpan={7} className="text-ink-2">該当する材料がありません。下の取込か「材料を追加」で登録してください。</Td></Tr>
            )}
          </tbody>
        </Table>
      </Card>

      {sel && (
        <Card id="material">
          <CardHeader title={`${sel.name} の単価の履歴`} description="新しい単価を登録しても、過去の日付の原価計算と確定済みの使用実績は当時の単価のままです。" />
          <ul className="mb-3 space-y-1 text-sm">
            {db.materialCosts.filter((c) => c.materialId === sel.id).sort((a, b2) => b2.validFrom.localeCompare(a.validFrom)).map((c) => (
              <li key={c.id}>
                {c.validFrom}〜{c.validTo ?? ""} {yen(c.unitCost)} ({c.kind === "provisional" ? "仮原価" : "原価単価"}) · {c.createdAt.slice(0, 10)} {userNameOf(db, c.createdBy)}{c.note ? ` · ${c.note}` : ""}
              </li>
            ))}
            {!db.materialCosts.some((c) => c.materialId === sel.id) && <li className="text-ink-2">まだ単価がありません。</li>}
          </ul>
          {ctx.canAdmin && (
            <form action={setMaterialCostAction} className="flex flex-wrap items-end gap-2">
              {b}
              <input type="hidden" name="materialId" value={sel.id} />
              <Field label="単価 (円・税抜)" required><Input name="unitCost" inputMode="decimal" required className="w-28" /></Field>
              <Field label="種類">
                <Select name="kind" defaultValue={sel.kind === "omote" ? "provisional" : "standard"}>
                  <option value="provisional">仮原価</option>
                  <option value="standard">原価単価</option>
                </Select>
              </Field>
              <Field label="適用開始日" required><Input type="date" name="validFrom" defaultValue={ctx.today} required /></Field>
              <Field label="メモ"><Input name="note" placeholder="例: 2026-11 仕入値上げ" /></Field>
              <Button type="submit" size="sm">単価を登録</Button>
            </form>
          )}
        </Card>
      )}

      {ctx.canAdmin && (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <Card>
            <CardHeader title={sel ? `材料を編集: ${sel.name}` : "材料を追加"} description="一覧にない品目を追加するとき。コードは再取込で同じ材料に当てる目印です。" />
            <form action={saveMaterial} className="grid grid-cols-2 gap-2">
              {b}
              {sel && <input type="hidden" name="id" value={sel.id} />}
              <Field label="コード" required><Input name="code" defaultValue={sel?.code} required /></Field>
              <Field label="名前" required><Input name="name" defaultValue={sel?.name} required /></Field>
              <Field label="種類" required>
                <Select name="kind" defaultValue={sel?.kind ?? "omote"}>
                  {Object.entries(MATERIAL_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="品目" required>
                <Select name="itemCategory" defaultValue={sel?.itemCategory ?? "tatami"}>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="単位"><Input name="unit" defaultValue={sel?.unit ?? "枚"} /></Field>
              <Field label="仕様"><Input name="spec" defaultValue={sel?.spec} /></Field>
              <Field label="厚み (mm・畳床)"><Input name="thickness" defaultValue={sel?.thickness ? String(sel.thickness) : ""} /></Field>
              <Field label="規格 (畳床)">
                <Select name="size" defaultValue={sel?.size ?? ""}>
                  <option value="">-</option>
                  {Object.entries(SIZE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="仕入先の品番 (請求書の照合)"><Input name="supplierCode" defaultValue={sel?.supplierCode} /></Field>
              <Field label="状態">
                <Select name="active" defaultValue={sel && !sel.active ? "0" : "1"}>
                  <option value="1">使う</option>
                  <option value="0">使わない</option>
                </Select>
              </Field>
              <div className="col-span-2"><Button type="submit" size="sm">保存</Button></div>
            </form>
          </Card>
          <Card>
            <CardHeader title="新原本の単価表を取り込む" description="売上台帳 .xlsx のシート「新原本」右上の畳材料原価単価表。適用開始日より前の受注・確定済みの原価には影響しません。" />
            <form action={importTatamiCostSheet} className="space-y-2">
              {b}
              <Field label="売上台帳 (.xlsx)" required><Input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></Field>
              <Field label="適用開始日" required><Input type="date" name="validFrom" defaultValue={DEFAULT_VALID_FROM} required /></Field>
              <Button type="submit" size="sm">単価表を取り込む</Button>
            </form>
            <div className="mt-4 border-t border-line pt-3">
              <CardHeader title="材料と単価の一括取込 (CSV)" description="1 行 = コード,名前,種類,単位,品目,単価,単価の種類,適用開始日,厚み,規格,仕入先の品番 (UTF-8)。種類: omote・chem_omote・heri・doko・sub・cloth・paper・other / 単価の種類: provisional (仮原価)・standard" />
              <form action={importMaterialsCsv} className="space-y-2">
                {b}
                <Input type="file" name="file" accept=".csv,text/csv" />
                <Textarea name="csv" rows={4} placeholder="または貼り付け: DOKO-55G,畳床 55mm 五八,doko,枚,tatami,4000,standard,2026-07-01,55,gohachi," />
                <Button type="submit" size="sm">CSV を取り込む</Button>
              </form>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader title={`材料構成 (BOM・${boms.length} 件)`} description="商品 1 単位 (畳 1 枚) あたりの材料と使用量。半畳は材料ごとの係数 (例: 畳表 0.5・畳床 0.5・副資材 1)。畳床は種類だけを決めておき (doko)、受注ごとに品名・製造の予定 (床・サイズ) から自動で選びます。決まらないときに使う既定の畳床を行の 3 つ目に書けます" />
        <Table minWidth="min-w-[760px]">
          <thead>
            <tr>
              <Th>名前</Th>
              <Th>対象</Th>
              <Th>材料 × 使用量</Th>
              <Th>適用</Th>
            </tr>
          </thead>
          <tbody>
            {boms.map((x) => (
              <Tr key={x.id}>
                <Td>{x.name}</Td>
                <Td className="text-xs">{x.productId ? `商品: ${db.products.find((p) => p.id === x.productId)?.name ?? x.productId}` : `品名に「${x.matchName}」`}</Td>
                <Td className="text-xs">{x.lines.map((l) => `${l.materialId ? db.materials.find((m) => m.id === l.materialId)?.name : `${MATERIAL_KIND_LABEL[l.materialKind]} (仕様で選ぶ${l.defaultMaterialId ? `・既定 ${db.materials.find((m) => m.id === l.defaultMaterialId)?.name ?? "?"}` : ""})`} × ${l.qty}`).join(" / ")}</Td>
                <Td className="text-xs">{x.validFrom}〜{x.validTo ?? ""}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {ctx.canAdmin && (
          <form action={saveBom} className="mt-3 grid grid-cols-1 gap-2 @3xl:grid-cols-2">
            {b}
            <Field label="名前" required><Input name="name" required placeholder="例: 表替え 上級 (1 枚)" /></Field>
            <Field label="商品マスタの商品">
              <Select name="productId" defaultValue="">
                <option value="">-</option>
                {db.products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}{p.grade ? ` ${p.grade}` : ""}{p.sizeLabel ? ` ${p.sizeLabel}` : ""}</option>)}
              </Select>
            </Field>
            <Field label="または品名に含まれる言葉 (移行データの明細)"><Input name="matchName" placeholder="例: 畳 上級" /></Field>
            <Field label="適用開始日"><Input type="date" name="validFrom" defaultValue={ctx.today} /></Field>
            <Field label="材料の行 (1 行に「材料コード または 種類, 使用量」。畳床など種類だけの行は「, 既定の材料コード」を足せる)" hint="既定の材料は、品名・製造の予定から仕様を判定できないときに使います (例: doko, 1, DOKO-KENZAI-55)" className="@3xl:col-span-2">
              <Textarea name="lines" rows={4} required placeholder={"OMOTE-A, 1\nHERI-KON, 1\ndoko, 1, DOKO-KENZAI-55\nsub, 1"} />
            </Field>
            <div><Button type="submit" size="sm">保存 (新しい版)</Button></div>
          </form>
        )}
      </Card>
    </div>
  );
}
