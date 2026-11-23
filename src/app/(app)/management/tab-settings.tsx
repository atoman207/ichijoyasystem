import { RULE_DEFS, RULE_GROUPS, ruleAt, ruleLabel } from "@/lib/mgmt/rules";
import { activeAreas } from "@/lib/mgmt/areas";
import { itemCategories } from "@/lib/mgmt/categories";
import { addSalesArea, closeSalesArea, importSalesAreas, saveItemCategory, saveStoreUnit, setRuleAction } from "@/lib/actions/mgmt";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Table, Td, Th, Tr } from "@/components/ui";
import { StoreSelect, back, storeNameOf, userNameOf, type Ctx } from "./parts";
import { compareStoreIds } from "@/lib/store-order";

export function SettingsTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const b = back(ctx);
  const areas = activeAreas(db, ctx.today).sort((a, b2) => compareStoreIds(a.storeId, b2.storeId) || a.town.localeCompare(b2.town, "ja"));
  const byStore = new Map<string, number>();
  for (const a of areas) byStore.set(a.storeId, (byStore.get(a.storeId) ?? 0) + 1);
  const ended = db.salesAreas.filter((a) => a.validTo && a.validTo < ctx.today).length;
  return (
    <div className="space-y-4">
      <Note>
        設定は適用開始日つきで変えます。前の値は履歴に残り、<strong>適用開始日より前の期間・確定した結果は変わりません</strong>。「暫定」は税理士・社内の確認待ちの設定で、これを使った数字には「暫定」の印が付きます。確認できたら「確認済み」で登録し直してください。{!ctx.canAdmin && " 変更は管理者が行います。"}
      </Note>
      {RULE_GROUPS.map((g) => (
        <Card key={g}>
          <CardHeader title={g} />
          <div className="space-y-4">
            {Object.entries(RULE_DEFS)
              .filter(([, d]) => d.group === g)
              .map(([key, d]) => {
                const now = ruleAt(db, key, ctx.today);
                const history = db.mgmtRules.filter((r) => r.key === key).sort((a, b2) => b2.createdAt.localeCompare(a.createdAt));
                return (
                  <div key={key} className="border-b border-line/60 pb-3 last:border-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <strong>{d.label}</strong>
                      <span>{ruleLabel(key, now.value)}</span>
                      <Badge tone={now.status === "confirmed" ? "good" : "warn"}>{now.status === "confirmed" ? "確認済み" : "暫定"}</Badge>
                      <span className="text-xs text-ink-2">{now.ruleId ? `${now.validFrom} から (設定)` : "既定値"}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-2">根拠: {d.basis}</p>
                    {d.defaults.length > 1 && <p className="text-xs text-ink-2">既定値の期間: {d.defaults.map((x) => `${x.validFrom}〜 ${ruleLabel(key, x.value)}`).join(" / ")}</p>}
                    {history.length > 0 && (
                      <ul className="mt-1 text-xs text-ink-2">
                        {history.map((r) => (
                          <li key={r.id}>
                            {r.validFrom}〜{r.validTo ?? ""} {ruleLabel(key, r.value)} ({r.status === "confirmed" ? "確認済み" : "暫定"}) · {r.createdAt.slice(0, 10)} {userNameOf(db, r.createdBy)}{r.note ? ` · ${r.note}` : ""}{r.validTo && r.validTo < r.validFrom ? " (置き換え済み)" : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {ctx.canAdmin && (
                      <form action={setRuleAction} className="mt-2 flex flex-wrap items-end gap-2">
                        {b}
                        <input type="hidden" name="key" value={key} />
                        <Field label={d.type === "bp" ? "率 (%)" : d.type === "yen" ? "金額 (円)" : "値"}>
                          {d.type === "enum" ? (
                            <Select name="value" defaultValue={now.value}>
                              {Object.entries(d.options ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </Select>
                          ) : (
                            <Input name="value" defaultValue={d.type === "bp" ? String(Number(now.value) / 100) : now.value} inputMode="decimal" className="w-28" />
                          )}
                        </Field>
                        <Field label="適用開始日"><Input type="date" name="validFrom" defaultValue={ctx.today} required /></Field>
                        <Field label="状態">
                          <Select name="status" defaultValue={now.status}>
                            <option value="confirmed">確認済み</option>
                            <option value="provisional">暫定</option>
                          </Select>
                        </Field>
                        <Field label="根拠・メモ"><Input name="note" className="w-64" /></Field>
                        <Button type="submit" size="sm" variant="secondary">変更</Button>
                      </form>
                    )}
                  </div>
                );
              })}
          </div>
        </Card>
      ))}

      <Card>
        <CardHeader title={`営業エリア (町名 → 担当店舗・${areas.length} 件)`} description={`${[...byStore].map(([s, n]) => `${storeNameOf(db, s)} ${n}`).join("・") || "未登録"}${ended ? ` · 終了した行 ${ended} 件 (履歴)` : ""}。住所に町名が含まれるかで判定し、一番長く一致したものを使います。売上の帰属は施工店舗が優先で、営業エリアは内部受注の候補の判定に使います`} />
        {db.stores.filter((s) => s.kind === "store" && !byStore.get(s.id)).length > 0 && <Note tone="warn">営業エリアがない店舗: {db.stores.filter((s) => s.kind === "store" && !byStore.get(s.id)).map((s) => s.name).join("・")} (この店舗の地域は判定できません。下で追加してください)</Note>}
        {ctx.canAdmin && (
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
            <form action={importSalesAreas} className="space-y-2 rounded-xl border border-line/70 p-3">
              {b}
              <p className="text-sm font-medium">予定表スプレッドシートの「地域一覧」を取り込む (.xlsx)</p>
              <p className="text-xs text-ink-2">Google スプレッドシートは ファイル → ダウンロード → Microsoft Excel。今の営業エリアは適用開始日の前日で終了し、取り込んだ行に置き換わります (履歴は残ります)。</p>
              <Input type="file" name="file" accept=".xlsx" required />
              <Field label="適用開始日"><Input type="date" name="validFrom" defaultValue={ctx.today} /></Field>
              <Button type="submit" size="sm">取り込む</Button>
            </form>
            <form action={addSalesArea} className="space-y-2 rounded-xl border border-line/70 p-3">
              {b}
              <p className="text-sm font-medium">町名を追加・担当店舗を変更する</p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="町名" required><Input name="town" required placeholder="例: 下硯川町" /></Field>
                <Field label="担当店舗" required><StoreSelect db={db} name="storeId" required /></Field>
                <Field label="市区町村 (任意)"><Input name="municipality" placeholder="例: 熊本市北区" /></Field>
                <Field label="適用開始日"><Input type="date" name="validFrom" defaultValue={ctx.today} /></Field>
              </div>
              <Button type="submit" size="sm" variant="secondary">保存</Button>
            </form>
          </div>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-accent">営業エリアの一覧を見る</summary>
          <Table minWidth="min-w-[560px]" className="mt-2">
            <thead>
              <tr>
                <Th>町名</Th>
                <Th>担当店舗</Th>
                <Th>適用</Th>
                <Th>元</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {areas.map((a) => (
                <Tr key={a.id}>
                  <Td>{a.municipality ? `${a.municipality} ` : ""}{a.town}</Td>
                  <Td>{storeNameOf(db, a.storeId)}</Td>
                  <Td className="text-xs">{a.validFrom}〜</Td>
                  <Td className="text-xs text-ink-2">{a.source === "import" ? "地域一覧" : "手入力"}</Td>
                  <Td>
                    {ctx.canAdmin && (
                      <form action={closeSalesArea}>
                        {b}
                        <input type="hidden" name="id" value={a.id} />
                        <Button type="submit" size="sm" variant="ghost">担当を終了</Button>
                      </form>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </details>
      </Card>

      <Card>
        <CardHeader title="品目 (管理会計の 7 区分)" description="売上・材料費・外注費の明細に付ける区分。名前と並びを変えられます (区分の ID は固定)" />
        <div className="space-y-2">
          {itemCategories(db).map((c) => (
            <form key={c.id} action={saveItemCategory} className="flex flex-wrap items-end gap-2">
              {b}
              <input type="hidden" name="id" value={c.id} />
              <span className="w-16 text-xs text-ink-2">{c.id}</span>
              <Input name="name" defaultValue={c.name} className="w-48" disabled={!ctx.canAdmin} />
              <Input name="sort" defaultValue={String(c.sort)} className="w-16" disabled={!ctx.canAdmin} />
              <Select name="active" defaultValue={c.active ? "1" : "0"} disabled={!ctx.canAdmin}>
                <option value="1">使う</option>
                <option value="0">使わない</option>
              </Select>
              {ctx.canAdmin && <Button type="submit" size="sm" variant="secondary">保存</Button>}
            </form>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="店舗・本部 (管理部門)" description="名前の変更・閉鎖・統合を記録します。閉鎖・統合した後も過去の数字は残り、閉鎖後の月は共通経費の案分の対象から外れます。新しい店舗の追加は、受注・顧客などの画面の店舗の一覧 (src/lib/db/types.ts の StoreId) の追加が必要です" />
        <div className="space-y-2">
          {db.stores.map((s) => (
            <form key={s.id} action={saveStoreUnit} className="flex flex-wrap items-end gap-2">
              {b}
              <input type="hidden" name="id" value={s.id} />
              <Field label="名前"><Input name="name" defaultValue={s.name} className="w-44" disabled={!ctx.canAdmin} /></Field>
              <Field label="略称"><Input name="shortName" defaultValue={s.shortName} className="w-20" disabled={!ctx.canAdmin} /></Field>
              <Field label="開設日"><Input type="date" name="openedOn" defaultValue={s.openedOn ?? ""} disabled={!ctx.canAdmin} /></Field>
              <Field label="閉鎖日"><Input type="date" name="closedOn" defaultValue={s.closedOn ?? ""} disabled={!ctx.canAdmin} /></Field>
              <Field label="統合先"><StoreSelect db={db} name="mergedInto" defaultValue={s.mergedInto ?? ""} all="なし" /></Field>
              {ctx.canAdmin && <Button type="submit" size="sm" variant="secondary">保存</Button>}
            </form>
          ))}
        </div>
      </Card>
    </div>
  );
}
