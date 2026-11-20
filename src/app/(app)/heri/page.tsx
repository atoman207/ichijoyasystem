import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageHeriStock, canRecordHeriMove, canReverseHeriMove, type HeriOp } from "@/lib/auth/permissions";
import { officeCtx } from "@/lib/office";
import { heriTablesReady } from "@/lib/office-tables";
import { COMMON_LOC, HERI_OP_LABEL, heriLabel, heriLocLabel, heriLocations, heriMaterials, heriRows, type HeriRow } from "@/lib/heri-stock";
import { countHeriAction, importHeriAction, recordHeriAction, reverseHeriAction, saveHeriMaterial } from "@/lib/actions/heri";
import { userName } from "@/lib/db/queries";
import { fmtDate, toDateKey } from "@/lib/format";
import { Badge, Button, Card, CardHeader, EmptyRow, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, Stat, Table, Td, Th, Tr } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * 縁在庫 (畳縁の品番 × 場所の数量)。管理会計の材料マスタ・在庫の移動を使う (src/lib/heri-stock.ts)。
 * 原価・単価・金額はこの画面に出さない (社外秘。管理会計 /management の権限のまま)
 */

type Sp = Record<string, string | undefined>;
const q4 = (n: number) => n.toLocaleString("ja-JP", { maximumFractionDigits: 4 });
const MOVE_LABEL: Record<string, string> = { receive: "入庫", transfer: "振り分け", use: "使用", adjust: "棚卸", return: "返品", dispose: "廃棄" };

function href(sp: Sp, patch: Sp): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v && k !== "msg" && k !== "err") q.set(k, v);
  const s = q.toString();
  return s ? `/heri?${s}` : "/heri";
}

export default async function HeriPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const ctx = officeCtx(db);
  const manage = canManageHeriStock(user, ctx);
  const tabs = ["stock", "count", "history", ...(manage ? ["master"] : [])];
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : "stock";
  const ready = heriTablesReady();
  const rows = heriRows(db, { includeInactive: tab === "master" });
  const below = rows.filter((r) => r.below);
  const locs = heriLocations(db);
  const allowed = (op: HeriOp, l: { from?: string; to?: string }) => canRecordHeriMove(user, op, l, ctx);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="縁在庫"
        description="畳縁の品番ごとの数量を、共通在庫 (本社) と各店で管理します。入庫・各店への振り分け・使用・棚卸で数量が変わり、共通在庫が規定量を下回ると本部と店長に社内連絡でお知らせします。原価・単価はこの画面には出ません"
        actions={<LinkButton href="/api/office?kind=heri" variant="secondary" size="sm" download>CSV で書き出す</LinkButton>}
      />
      <LinkTabs
        current={`/heri?tab=${tab}`}
        items={[
          { href: "/heri?tab=stock", label: "在庫", count: below.length || undefined },
          { href: "/heri?tab=count", label: "棚卸 (まとめて)" },
          { href: "/heri?tab=history", label: "登録の履歴" },
          ...(manage ? [{ href: "/heri?tab=master", label: "品番の設定・取込" }] : []),
        ]}
      />
      {!ready && <Note tone="warn">縁在庫のテーブル (材料マスタ・在庫の移動) がまだデータベースにありません (デプロイ後に作られます)。それまでは登録できません。</Note>}
      {tab === "stock" && <StockTab sp={sp} rows={rows} locs={locs} allowed={allowed} manage={manage} userStore={user.storeId} />}
      {tab === "count" && <CountTab sp={sp} rows={rows} locs={locs.filter((l) => allowed("count", { to: l.loc }))} />}
      {tab === "history" && <HistoryTab canReverse={(m) => canReverseHeriMove(user, m, ctx)} />}
      {tab === "master" && manage && <MasterTab sp={sp} rows={rows} locs={locs} />}
    </div>
  );
}

function StatusBadge({ r }: { r: HeriRow }) {
  if (!r.material.active) return <Badge tone="neutral">使わない</Badge>;
  if (r.below) return <Badge tone="critical">規定量未満</Badge>;
  if (!r.hasRecord) return <Badge tone="neutral" dot={false}>記録なし</Badge>;
  if (r.common <= 0) return <Badge tone="warn">共通在庫なし</Badge>;
  return null;
}

/* ================================================================== */
/* 在庫                                                                 */
/* ================================================================== */

function StockTab({ sp, rows, locs, allowed, manage, userStore }: { sp: Sp; rows: HeriRow[]; locs: ReturnType<typeof heriLocations>; allowed: (op: HeriOp, l: { from?: string; to?: string }) => boolean; manage: boolean; userStore: string }) {
  const series = [...new Set(rows.map((r) => r.material.series ?? "").filter(Boolean))];
  const q = (sp.q ?? "").normalize("NFKC").toLowerCase();
  const shown = rows.filter((r) => (!sp.series || r.material.series === sp.series) && (sp.low !== "1" || r.below) && (sp.lineup !== "1" || r.material.lineup) && (!q || `${r.material.series ?? ""} ${r.material.supplierCode ?? ""} ${r.material.name} ${r.material.note ?? ""}`.normalize("NFKC").toLowerCase().includes(q)));
  const stores = locs.filter((l) => l.loc !== COMMON_LOC);
  const ops = (["use", "transfer", "count", "receive"] as HeriOp[]).filter((op) => locs.some((a) => locs.some((b) => allowed(op, op === "receive" || op === "count" ? { to: a.loc } : op === "use" ? { from: a.loc } : { from: a.loc, to: b.loc }))));
  const op = ops.includes(sp.op as HeriOp) ? (sp.op as HeriOp) : ops[0];
  const base: Sp = { tab: "stock", series: sp.series, low: sp.low, lineup: sp.lineup, q: sp.q };
  const mats = heriMaterials(getDb());
  const commonOf = new Map(rows.map((r) => [r.material.id, r.common]));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="品番" value={`${rows.length} 件`} />
        <Stat label="共通在庫が規定量未満" value={`${rows.filter((r) => r.below).length} 件`} tone={rows.some((r) => r.below) ? "critical" : undefined} href={href(base, { low: "1" })} />
        <Stat label="規定量の設定あり" value={`${rows.filter((r) => r.material.reorderLevel !== undefined).length} 件`} />
        <Stat label="数量の記録なし" value={`${rows.filter((r) => !r.hasRecord).length} 件`} />
      </div>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="stock" />
        <Field label="シリーズ">
          <Select name="series" defaultValue={sp.series ?? ""}>
            <option value="">すべて</option>
            {series.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="検索"><Input name="q" defaultValue={sp.q ?? ""} placeholder="品番・メモ" /></Field>
        <label className="mb-2 flex items-center gap-1.5 text-sm"><input type="checkbox" name="low" value="1" defaultChecked={sp.low === "1"} className="h-4 w-4" />規定量未満だけ</label>
        <label className="mb-2 flex items-center gap-1.5 text-sm"><input type="checkbox" name="lineup" value="1" defaultChecked={sp.lineup === "1"} className="h-4 w-4" />通常ヘリだけ</label>
        <Button type="submit" variant="secondary">絞り込む</Button>
      </form>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-3">
        <div className="min-w-0 @5xl:col-span-2">
          <Table minWidth="min-w-[720px]">
            <thead>
              <tr>
                <Th>品番</Th>
                <Th align="right">共通在庫</Th>
                {stores.map((s) => <Th key={s.loc} align="right">{s.label}</Th>)}
                <Th align="right">合計</Th>
                <Th align="right">規定量</Th>
                <Th>状態</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Tr key={r.material.id} className={r.below ? "bg-critical-soft/40" : undefined}>
                  <Td>
                    <div className="font-medium">{heriLabel(r.material)}{r.material.lineup && <span className="ml-1.5 text-[11px] text-accent-ink">通常ヘリ</span>}</div>
                    {r.material.note && <div className="text-[11px] text-ink-3">{r.material.note}</div>}
                  </Td>
                  <Td align="right" className={`tnum ${r.below ? "font-semibold text-critical-ink" : ""}`}>{r.hasRecord ? `${q4(r.common)} ${r.material.unit}` : "-"}</Td>
                  {stores.map((s) => <Td key={s.loc} align="right" className="tnum text-ink-2">{r.byStore[s.storeId] ? q4(r.byStore[s.storeId]) : "-"}</Td>)}
                  <Td align="right" className="tnum">{r.hasRecord ? q4(r.total) : "-"}</Td>
                  <Td align="right" className="tnum text-ink-2">{r.material.reorderLevel !== undefined ? q4(r.material.reorderLevel) : "-"}</Td>
                  <Td><StatusBadge r={r} /></Td>
                </Tr>
              ))}
              {shown.length === 0 && <EmptyRow colSpan={stores.length + 5}>{rows.length ? "条件に合う品番はありません" : manage ? "縁の品番がまだありません。「品番の設定・取込」で縁在庫表 (.xlsx) を取り込んでください" : "縁の品番がまだありません (事務担当・本部が登録します)"}</EmptyRow>}
            </tbody>
          </Table>
        </div>

        <Card>
          <CardHeader title="数量を登録する" description="原価・単価は入力しません (管理会計で自動)。登録は変更履歴に残り、取り消すと逆向きの行が入ります" />
          {ops.length === 0 ? (
            <p className="text-xs text-ink-3">登録できる操作がありません。</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-1">
                {ops.map((o) => (
                  <Link key={o} href={href(base, { op: o })} className={`rounded-full px-3 py-1 text-xs ${o === op ? "bg-accent-soft font-semibold text-accent-ink" : "bg-subtle text-ink-2 hover:text-ink"}`}>{HERI_OP_LABEL[o]}</Link>
                ))}
              </div>
              <form action={recordHeriAction} className="space-y-2">
                <input type="hidden" name="back" value={href(base, { op })} />
                <input type="hidden" name="op" value={op} />
                <Field label="品番" required>
                  <Select name="materialId" required defaultValue="">
                    <option value="">選ぶ…</option>
                    {mats.map((m) => <option key={m.id} value={m.id}>{heriLabel(m)} (共通 {q4(commonOf.get(m.id) ?? 0)})</option>)}
                  </Select>
                </Field>
                {(op === "transfer" || op === "use") && (
                  <Field label={op === "use" ? "使った在庫の場所" : "振り分けの元"}>
                    <Select name="from" defaultValue={op === "use" && allowed("use", { from: `store:${userStore}` }) && userStore !== "hq" ? `store:${userStore}` : COMMON_LOC}>
                      {locs.filter((l) => (op === "use" ? allowed("use", { from: l.loc }) : locs.some((b) => b.loc !== l.loc && allowed("transfer", { from: l.loc, to: b.loc })))).map((l) => <option key={l.loc} value={l.loc}>{l.label}</option>)}
                    </Select>
                  </Field>
                )}
                {(op === "transfer" || op === "receive" || op === "count") && (
                  <Field label={op === "transfer" ? "振り分けの先" : op === "receive" ? "入庫する場所" : "棚卸の場所"}>
                    <Select name="to" defaultValue={op === "transfer" ? (locs.find((l) => l.loc !== COMMON_LOC && allowed("transfer", { from: COMMON_LOC, to: l.loc }))?.loc ?? "") : op === "count" && !allowed("count", { to: COMMON_LOC }) ? `store:${userStore}` : COMMON_LOC}>
                      {locs.filter((l) => (op === "transfer" ? locs.some((a) => a.loc !== l.loc && allowed("transfer", { from: a.loc, to: l.loc })) : allowed(op, { to: l.loc }))).map((l) => <option key={l.loc} value={l.loc}>{l.label}</option>)}
                    </Select>
                  </Field>
                )}
                <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
                  <Field label={op === "count" ? "数えた数量" : "数量"} required><Input name="qty" inputMode="decimal" required placeholder="帖" /></Field>
                  <Field label="日付" required><Input type="date" name="date" defaultValue={toDateKey(new Date())} required /></Field>
                </div>
                {op === "use" && <Field label="受注番号 (任意)" hint="案件にひも付けると案件ごとの使用が分かります"><Input name="order" placeholder="OR-2026-0001" /></Field>}
                <Field label="メモ"><Input name="note" maxLength={150} placeholder={op === "receive" ? "納品書の番号など" : op === "use" ? "現場・お客様など" : ""} /></Field>
                <Button type="submit">{HERI_OP_LABEL[op]}を登録</Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ================================================================== */
/* 棚卸 (まとめて)                                                        */
/* ================================================================== */

function CountTab({ sp, rows, locs }: { sp: Sp; rows: HeriRow[]; locs: ReturnType<typeof heriLocations> }) {
  if (!locs.length) return <Note>棚卸を登録できる場所がありません (事務担当・本部・管理者、店長は所属店舗)。</Note>;
  const loc = locs.find((l) => l.loc === sp.loc) ?? locs[0];
  const series = [...new Set(rows.map((r) => r.material.series ?? "").filter(Boolean))];
  const shown = rows.filter((r) => !sp.series || r.material.series === sp.series);
  const qty = (r: HeriRow) => (loc.loc === COMMON_LOC ? r.common : (r.byStore[loc.storeId] ?? 0));
  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="count" />
        <Field label="場所">
          <Select name="loc" defaultValue={loc.loc}>{locs.map((l) => <option key={l.loc} value={l.loc}>{l.label}</option>)}</Select>
        </Field>
        <Field label="シリーズ">
          <Select name="series" defaultValue={sp.series ?? ""}>
            <option value="">すべて</option>
            {series.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">表示</Button>
      </form>
      <Note>数えた数量を入れた品番だけ、今の数量との差を「棚卸」として登録します (空欄の品番は変えません)。差の行は登録の履歴から取り消せます。</Note>
      <form action={countHeriAction} className="space-y-3">
        <input type="hidden" name="back" value={href({ tab: "count", loc: loc.loc, series: sp.series }, {})} />
        <input type="hidden" name="loc" value={loc.loc} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="棚卸日" required><Input type="date" name="date" defaultValue={toDateKey(new Date())} required /></Field>
          <Button type="submit">{loc.label}の棚卸を登録</Button>
        </div>
        <Table minWidth="min-w-[560px]">
          <thead>
            <tr>
              <Th>品番</Th>
              <Th align="right">今の数量</Th>
              <Th align="right">規定量</Th>
              <Th>数えた数量</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Tr key={r.material.id}>
                <Td>{heriLabel(r.material)}</Td>
                <Td align="right" className="tnum">{r.hasRecord ? `${q4(qty(r))} ${r.material.unit}` : "-"}</Td>
                <Td align="right" className="tnum text-ink-2">{loc.loc === COMMON_LOC && r.material.reorderLevel !== undefined ? q4(r.material.reorderLevel) : "-"}</Td>
                <Td><Input name={`count_${r.material.id}`} inputMode="decimal" className="w-28" aria-label={`${heriLabel(r.material)} の数えた数量`} /></Td>
              </Tr>
            ))}
            {shown.length === 0 && <EmptyRow colSpan={4}>品番がありません</EmptyRow>}
          </tbody>
        </Table>
      </form>
    </div>
  );
}

/* ================================================================== */
/* 登録の履歴                                                             */
/* ================================================================== */

function HistoryTab({ canReverse }: { canReverse: (m: { createdBy: string }) => boolean }) {
  const db = getDb();
  const mats = new Map(heriMaterials(db, { includeInactive: true }).map((m) => [m.id, m]));
  const moves = db.stockMoves
    .filter((m) => mats.has(m.materialId) && m.status !== "draft")
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);
  return (
    <Card padded={false}>
      <div className="px-5 pt-5"><CardHeader title="登録の履歴 (新しい順・200 件)" description="取消しは逆向きの行を追加します (元の行は残ります)。月次確定した月の行は管理者が確定を解除するまで取り消せません" /></div>
      <Table minWidth="min-w-[900px]">
        <thead>
          <tr>
            <Th>日付</Th>
            <Th>品番</Th>
            <Th>操作</Th>
            <Th align="right">数量</Th>
            <Th>場所</Th>
            <Th>メモ</Th>
            <Th>登録</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {moves.map((m) => {
            const mat = mats.get(m.materialId)!;
            const reversed = m.status === "reversed";
            return (
              <Tr key={m.id} className={reversed || m.reversalOf ? "text-ink-3" : undefined}>
                <Td className="whitespace-nowrap text-xs">{fmtDate(m.date)}</Td>
                <Td>{heriLabel(mat)}</Td>
                <Td className="text-xs">{m.reversalOf ? "取消し" : (MOVE_LABEL[m.kind] ?? m.kind)}{reversed && <Badge tone="neutral" dot={false} className="ml-1">取消し済み</Badge>}</Td>
                <Td align="right" className="tnum">{q4(m.qty)} {mat.unit}</Td>
                <Td className="text-xs">{heriLocLabel(db, m.fromLoc)} → {heriLocLabel(db, m.toLoc)}</Td>
                <Td className="text-xs text-ink-2">{m.note ?? ""}</Td>
                <Td className="text-xs whitespace-nowrap">{userName(m.createdBy)}</Td>
                <Td>
                  {m.status === "confirmed" && !m.reversalOf && canReverse(m) && (
                    <form action={reverseHeriAction} className="flex gap-1">
                      <input type="hidden" name="back" value="/heri?tab=history" />
                      <input type="hidden" name="id" value={m.id} />
                      <Input name="reason" placeholder="理由" required className="w-28" aria-label="取消しの理由" />
                      <Button type="submit" size="sm" variant="secondary">取消し</Button>
                    </form>
                  )}
                </Td>
              </Tr>
            );
          })}
          {moves.length === 0 && <EmptyRow colSpan={8}>まだ登録はありません</EmptyRow>}
        </tbody>
      </Table>
    </Card>
  );
}

/* ================================================================== */
/* 品番の設定・取込                                                        */
/* ================================================================== */

function MasterTab({ sp, rows, locs }: { sp: Sp; rows: HeriRow[]; locs: ReturnType<typeof heriLocations> }) {
  const db = getDb();
  const editing = sp.edit ? rows.find((r) => r.material.id === sp.edit)?.material : undefined;
  const suppliers = db.suppliers.filter((s) => s.active !== false).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const series = [...new Set(rows.map((r) => r.material.series ?? "").filter(Boolean))];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title={editing ? `品番の変更: ${heriLabel(editing)}` : "品番を登録する"} description="規定量は共通在庫の数量と比べます (下回ったら社内連絡)。原価単価は管理会計 (管理者) で登録します" action={editing ? <Link href="/heri?tab=master" className="text-xs text-accent hover:underline">新しく登録する</Link> : undefined} />
          <form action={saveHeriMaterial} className="grid grid-cols-1 gap-2 @md:grid-cols-2">
            <input type="hidden" name="back" value={editing ? `/heri?tab=master&edit=${editing.id}` : "/heri?tab=master"} />
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="シリーズ">
              <Input name="series" list="heri-series" defaultValue={editing?.series ?? ""} placeholder="アラベスク・浮 など" />
              <datalist id="heri-series">{series.map((s) => <option key={s} value={s} />)}</datalist>
            </Field>
            <Field label="品番" required><Input name="no" required defaultValue={editing?.supplierCode ?? ""} placeholder="410" /></Field>
            <Field label="単位"><Input name="unit" defaultValue={editing?.unit ?? "帖"} /></Field>
            <Field label="規定量 (共通在庫)"><Input name="reorderLevel" inputMode="decimal" defaultValue={editing?.reorderLevel ?? ""} placeholder="空欄 = 設定なし" /></Field>
            <Field label="発注先" className="@md:col-span-2">
              <Select name="supplierId" defaultValue={editing?.supplierId ?? ""}>
                <option value="">(未設定)</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="名前 (空欄 = 縁 + シリーズ + 品番)" className="@md:col-span-2"><Input name="name" defaultValue={editing?.name ?? ""} /></Field>
            <Field label="メモ (引当・注意など)" className="@md:col-span-2"><Input name="note" defaultValue={editing?.note ?? ""} /></Field>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="lineup" value="1" defaultChecked={editing?.lineup ?? false} className="h-4 w-4" />通常ヘリ (ラインナップ)</label>
            <Field label="使う">
              <Select name="active" defaultValue={editing?.active === false ? "0" : "1"}>
                <option value="1">使う</option>
                <option value="0">使わない (一覧から外す)</option>
              </Select>
            </Field>
            <div className="@md:col-span-2"><Button type="submit">保存</Button></div>
          </form>
        </Card>
        <Card>
          <CardHeader title="縁在庫表を取り込む" description="縁在庫表 (.xlsx: シートごとに「シリーズ名」「品番 | 帖」の表) か、この画面の CSV (シリーズ・品番・共通在庫・メモ)。新しい品番を登録し、選んだ場所の数量を表の数量に合わせます (表にない品番は変えません)。右側の書き込み (引当など) は品番のメモに入れます。ラインナップのシート (通常ヘリ) は品番だけを登録し、価格は読みません。取込は数量だけで、管理会計の金額には入りません" />
          <form action={importHeriAction} className="space-y-2">
            <input type="hidden" name="back" value="/heri?tab=master" />
            <Input type="file" name="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
            <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
              <Field label="数量を合わせる場所">
                <Select name="loc" defaultValue={COMMON_LOC}>{locs.map((l) => <option key={l.loc} value={l.loc}>{l.label}</option>)}</Select>
              </Field>
              <Field label="棚卸日"><Input type="date" name="date" defaultValue={toDateKey(new Date())} /></Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="mode" value="preview" variant="secondary" size="sm">確認する (登録しない)</Button>
              <Button type="submit" name="mode" value="commit" size="sm">取り込む</Button>
            </div>
          </form>
        </Card>
      </div>
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>シリーズ</Th>
            <Th>品番</Th>
            <Th>単位</Th>
            <Th align="right">規定量</Th>
            <Th>発注先</Th>
            <Th>通常ヘリ</Th>
            <Th>状態</Th>
            <Th>メモ</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.material.id}>
              <Td className="text-xs">{r.material.series ?? "-"}</Td>
              <Td>{r.material.supplierCode ?? r.material.name}</Td>
              <Td className="text-xs">{r.material.unit}</Td>
              <Td align="right" className="tnum">{r.material.reorderLevel !== undefined ? q4(r.material.reorderLevel) : "-"}</Td>
              <Td className="text-xs">{db.suppliers.find((s) => s.id === r.material.supplierId)?.name ?? "-"}</Td>
              <Td className="text-xs">{r.material.lineup ? "○" : ""}</Td>
              <Td><StatusBadge r={r} /></Td>
              <Td className="text-xs text-ink-2">{r.material.note ?? ""}</Td>
              <Td><Link href={`/heri?tab=master&edit=${r.material.id}`} className="text-xs text-accent hover:underline">変更</Link></Td>
            </Tr>
          ))}
          {rows.length === 0 && <EmptyRow colSpan={9}>品番がありません。縁在庫表 (.xlsx) を取り込むか、上のフォームで登録してください</EmptyRow>}
        </tbody>
      </Table>
    </div>
  );
}
