import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditCondolences, canEditOfficeImprovements, canViewCondolences } from "@/lib/auth/permissions";
import { CONDOLENCE_CATEGORY_LABEL, filterCondolences, filterImprovements, officeCtx, yearsOf } from "@/lib/office";
import { officeTablesReady } from "@/lib/office-tables";
import { deleteCondolence, deleteImprovement, importCondolences, importImprovements, saveCondolence, saveImprovement } from "@/lib/actions/office";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import type { CondolenceCategory } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, EmptyRow, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Pager, Select, Table, Td, Textarea, Th, Tr, paginate } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * 事務 (事務改善シート・慶弔リスト)。クライアントのスプレッドシート 2 つを画面で扱う (src/lib/office.ts)
 * - 事務改善シート: 全員が見る (年・担当・項目・検索で絞り込み)。登録・修正・削除・取込は事務担当・本部・管理者
 * - 慶弔リスト: ご家族の情報を含むため、事務担当・本部・管理者だけ (タブも出さない)
 */
export default async function OfficePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const ctx = officeCtx(db);
  const canKeicho = canViewCondolences(user, ctx);
  const tab = sp.tab === "keicho" && canKeicho ? "keicho" : "kaizen";
  const ready = officeTablesReady();

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err ?? (sp.tab === "keicho" && !canKeicho ? "慶弔リストは事務担当・本部スタッフ・管理者だけが見られます。" : undefined)} />
      <PageHeader
        title="事務"
        description="事務改善シート (事務のミス・気づき → 原因 → 具体的改善策) と慶弔リストを、スプレッドシートと同じ項目で記録します。シートの .xlsx・CSV から取り込めます"
      />
      <LinkTabs
        current={`/office?tab=${tab}`}
        items={[{ href: "/office?tab=kaizen", label: "事務改善シート", count: db.officeImprovements.length }, ...(canKeicho ? [{ href: "/office?tab=keicho", label: "慶弔リスト", count: db.condolences.length }] : [])]}
      />
      {!ready && <Note tone="warn">事務のテーブルがまだデータベースにありません (デプロイ後に作られます)。それまでは登録・取込はできません。</Note>}
      {tab === "kaizen" ? <KaizenTab sp={sp} canEdit={canEditOfficeImprovements(user, ctx)} me={user.name} /> : <KeichoTab sp={sp} canEdit={canEditCondolences(user, ctx)} />}
    </div>
  );
}

type Sp = Record<string, string | undefined>;

/** 絞り込みを保ったリンク */
function href(base: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v && k !== "msg" && k !== "err" && k !== "page") q.set(k, v);
  return `/office?${q.toString()}`;
}

function ImportForm({ action, tab, title, description }: { action: (fd: FormData) => Promise<void>; tab: string; title: string; description: string }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <form action={action} className="space-y-2">
        <input type="hidden" name="back" value={`/office?tab=${tab}`} />
        <Input type="file" name="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" name="mode" value="preview" variant="secondary" size="sm">確認する (登録しない)</Button>
          <Button type="submit" name="mode" value="commit" size="sm">取り込む</Button>
        </div>
      </form>
    </Card>
  );
}

/* ================================================================== */
/* 事務改善シート                                                          */
/* ================================================================== */

function KaizenTab({ sp, canEdit, me }: { sp: Sp; canEdit: boolean; me: string }) {
  const db = getDb();
  const all = db.officeImprovements;
  const year = Number(sp.year) || undefined;
  const filter = { year, staff: sp.staff || undefined, item: sp.item || undefined, q: sp.q || undefined };
  const rows = filterImprovements(all, filter);
  const paged = paginate(rows, sp.page, 100);
  const years = yearsOf(all.map((r) => r.year));
  const staffNames = [...new Set(all.map((r) => r.staffName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  const items = [...new Set(all.map((r) => r.item).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  const editing = sp.edit ? all.find((r) => r.id === sp.edit) : undefined;
  const showForm = canEdit && (Boolean(editing) || sp.new === "1");
  const base: Sp = { tab: "kaizen", year: sp.year, staff: sp.staff, item: sp.item, q: sp.q };
  const csv = `/api/office?${new URLSearchParams(Object.entries({ kind: "kaizen", year: sp.year, staff: sp.staff, item: sp.item, q: sp.q }).filter((e): e is [string, string] => Boolean(e[1]))).toString()}`;
  // 項目ごとの件数 (絞り込みの範囲。多い順)
  const byItem = [...rows.reduce((m, r) => m.set(r.item || "(項目なし)", (m.get(r.item || "(項目なし)") ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const noMeasure = rows.filter((r) => !r.measure).length;
  const users = db.users.filter((u) => u.active).map((u) => u.name);

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="kaizen" />
        <Field label="年">
          <Select name="year" defaultValue={sp.year ?? ""}>
            <option value="">すべて</option>
            {years.map((y) => <option key={y} value={y}>{y} 年</option>)}
          </Select>
        </Field>
        <Field label="担当">
          <Select name="staff" defaultValue={sp.staff ?? ""}>
            <option value="">すべて</option>
            {staffNames.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="項目">
          <Select name="item" defaultValue={sp.item ?? ""}>
            <option value="">すべて</option>
            {items.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="検索"><Input name="q" defaultValue={sp.q ?? ""} placeholder="内容・原因・改善策" /></Field>
        <Button type="submit" variant="secondary">絞り込む</Button>
        <span className="ml-auto flex flex-wrap gap-2">
          <LinkButton href={csv} variant="secondary" size="sm" download>CSV で書き出す</LinkButton>
          {canEdit && <LinkButton href={href(base, { new: "1" })} size="sm">新しく記録する</LinkButton>}
        </span>
      </form>

      {showForm && (
        <Card>
          <CardHeader title={editing ? "事務改善の行を修正" : "事務改善を記録"} description="起きたこと (内容) → 原因 → 具体的改善策 の順に書きます。改善策は後から追記できます" action={<Link href={href(base, {})} className="text-xs text-accent hover:underline">閉じる</Link>} />
          <form action={saveImprovement} className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
            <input type="hidden" name="back" value={href(base, editing ? { edit: editing.id } : { new: "1" })} />
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="日付" hint="分からないときは空欄にして年だけ"><Input type="date" name="date" defaultValue={editing?.date ?? (editing ? "" : toDateKey(new Date()))} /></Field>
            <Field label="年"><Input type="number" name="year" min={1990} max={2100} defaultValue={editing?.year ?? new Date().getFullYear()} /></Field>
            <Field label="担当">
              <Input name="staffName" list="office-staff" defaultValue={editing?.staffName ?? me} />
              <datalist id="office-staff">{users.map((n) => <option key={n} value={n} />)}</datalist>
            </Field>
            <Field label="項目">
              <Input name="item" list="office-items" defaultValue={editing?.item ?? ""} placeholder="仕入帳・買掛一覧・売上 など" />
              <datalist id="office-items">{items.map((n) => <option key={n} value={n} />)}</datalist>
            </Field>
            <Field label="内容" required className="@3xl:col-span-4"><Textarea name="content" rows={2} required defaultValue={editing?.content ?? ""} /></Field>
            <Field label="原因" className="@3xl:col-span-2"><Textarea name="cause" rows={3} defaultValue={editing?.cause ?? ""} /></Field>
            <Field label="具体的改善策" className="@3xl:col-span-2"><Textarea name="measure" rows={3} defaultValue={editing?.measure ?? ""} /></Field>
            <div className="flex flex-wrap gap-2 @3xl:col-span-4">
              <Button type="submit">保存</Button>
            </div>
          </form>
          {editing && (
            <form action={deleteImprovement} className="mt-3 border-t border-line pt-3">
              <input type="hidden" name="id" value={editing.id} />
              <input type="hidden" name="back" value={href(base, { edit: editing.id })} />
              <Button type="submit" variant="danger" size="sm">この行を削除する</Button>
            </form>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-4">
        <div className="min-w-0 @5xl:col-span-3">
          <Table minWidth="min-w-[860px]">
            <thead>
              <tr>
                <Th>日付</Th>
                <Th>担当</Th>
                <Th>項目</Th>
                <Th>内容</Th>
                <Th>原因</Th>
                <Th>具体的改善策</Th>
                {canEdit && <Th />}
              </tr>
            </thead>
            <tbody>
              {paged.items.map((r) => (
                <Tr key={r.id}>
                  <Td className="whitespace-nowrap text-xs">{r.date ? fmtDate(r.date) : `${r.year} 年`}</Td>
                  <Td className="whitespace-nowrap">{r.staffName || "-"}</Td>
                  <Td className="text-xs">{r.item || "-"}</Td>
                  <Td className="text-xs whitespace-pre-wrap">{r.content}</Td>
                  <Td className="text-xs whitespace-pre-wrap text-ink-2">{r.cause || "-"}</Td>
                  <Td className="text-xs whitespace-pre-wrap">{r.measure || <Badge tone="warn">改善策が未記入</Badge>}</Td>
                  {canEdit && <Td><Link href={href(base, { edit: r.id })} className="text-xs text-accent hover:underline">修正</Link></Td>}
                </Tr>
              ))}
              {paged.items.length === 0 && <EmptyRow colSpan={canEdit ? 7 : 6}>{all.length ? "条件に合う行はありません" : "まだ記録がありません。事務改善シート (.xlsx) を取り込むか、「新しく記録する」から登録してください"}</EmptyRow>}
            </tbody>
          </Table>
          <Pager paged={paged} path="/office" sp={base} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="項目ごとの件数" description={`${year ? `${year} 年・` : ""}表示中の ${rows.length} 件。改善策が未記入 ${noMeasure} 件`} />
            <ul className="space-y-1 text-sm">
              {byItem.map(([k, n]) => (
                <li key={k} className="flex items-center justify-between gap-2">
                  <Link href={href(base, { item: k === "(項目なし)" ? undefined : k })} className="truncate text-accent hover:underline">{k}</Link>
                  <span className="tnum text-ink-2">{n} 件</span>
                </li>
              ))}
              {byItem.length === 0 && <li className="text-xs text-ink-3">記録がありません</li>}
            </ul>
          </Card>
          {canEdit && (
            <ImportForm action={importImprovements} tab="kaizen" title="シートから取り込む" description="事務改善シート (.xlsx) か CSV (見出し: 年・月日・担当・項目・内容・原因・具体的改善策)。空欄の年・月日は上の行を引き継ぎます。登録済みと同じ行は取り込みません" />
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* 慶弔リスト                                                             */
/* ================================================================== */

function KeichoTab({ sp, canEdit }: { sp: Sp; canEdit: boolean }) {
  const db = getDb();
  const all = db.condolences;
  const year = Number(sp.year) || undefined;
  const category = (Object.keys(CONDOLENCE_CATEGORY_LABEL) as CondolenceCategory[]).find((c) => c === sp.category);
  const rows = filterCondolences(all, { year, category, q: sp.q || undefined });
  const paged = paginate(rows, sp.page, 100);
  const years = yearsOf(all.map((r) => r.date));
  const editing = sp.edit ? all.find((r) => r.id === sp.edit) : undefined;
  const showForm = canEdit && (Boolean(editing) || sp.new === "1");
  const base: Sp = { tab: "keicho", year: sp.year, category: sp.category, q: sp.q };
  const csv = `/api/office?${new URLSearchParams(Object.entries({ kind: "keicho", year: sp.year, category: sp.category, q: sp.q }).filter((e): e is [string, string] => Boolean(e[1]))).toString()}`;
  const total = rows.reduce((a, r) => a + (r.amount ?? 0), 0);
  const kinds = [...new Set(["通夜・葬儀", "通夜", "葬儀", "参列なし", "結婚", "出産", ...all.map((r) => r.kind).filter(Boolean)])];
  const tone = (c: CondolenceCategory) => (c === "condolence" ? "neutral" : c === "celebration" ? "good" : "info");

  return (
    <div className="space-y-4">
      <Note tone="warn">慶弔リストは社員・取引先のご家族の情報を含みます。見られるのは事務担当・本部スタッフ・管理者だけです。書き出した CSV の扱いにご注意ください。</Note>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="keicho" />
        <Field label="年">
          <Select name="year" defaultValue={sp.year ?? ""}>
            <option value="">すべて</option>
            {years.map((y) => <option key={y} value={y}>{y} 年</option>)}
          </Select>
        </Field>
        <Field label="区分">
          <Select name="category" defaultValue={sp.category ?? ""}>
            <option value="">すべて</option>
            {Object.entries(CONDOLENCE_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="検索"><Input name="q" defaultValue={sp.q ?? ""} placeholder="名前・関係・担当・備考" /></Field>
        <Button type="submit" variant="secondary">絞り込む</Button>
        <span className="ml-auto flex flex-wrap gap-2">
          <LinkButton href={csv} variant="secondary" size="sm" download>CSV で書き出す</LinkButton>
          {canEdit && <LinkButton href={href(base, { new: "1" })} size="sm">新しく記録する</LinkButton>}
        </span>
      </form>

      {showForm && (
        <Card>
          <CardHeader title={editing ? "慶弔の行を修正" : "慶弔を記録"} action={<Link href={href(base, {})} className="text-xs text-accent hover:underline">閉じる</Link>} />
          <form action={saveCondolence} className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
            <input type="hidden" name="back" value={href(base, editing ? { edit: editing.id } : { new: "1" })} />
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="年月日" required><Input type="date" name="date" required defaultValue={editing?.date ?? toDateKey(new Date())} /></Field>
            <Field label="区分">
              <Select name="category" defaultValue={editing?.category ?? "condolence"}>
                {Object.entries(CONDOLENCE_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="内容">
              <Input name="kind" list="keicho-kinds" defaultValue={editing?.kind ?? ""} placeholder="通夜・葬儀 など" />
              <datalist id="keicho-kinds">{kinds.map((k) => <option key={k} value={k} />)}</datalist>
            </Field>
            <Field label="金額 (円)"><Input name="amount" inputMode="numeric" defaultValue={editing?.amount ?? ""} placeholder="5000" /></Field>
            <Field label="名前 (喪主・お相手)" className="@3xl:col-span-2"><Input name="name" defaultValue={editing?.name ?? ""} /></Field>
            <Field label="関係" className="@3xl:col-span-2"><Input name="relation" defaultValue={editing?.relation ?? ""} placeholder="社員のご家族・取引先・地域 など" /></Field>
            <Field label="担当 (参列者)" className="@3xl:col-span-2"><Input name="attendee" defaultValue={editing?.attendee ?? ""} /></Field>
            <Field label="備考 (供花・弔電・会場など)" className="@3xl:col-span-2"><Input name="note" defaultValue={editing?.note ?? ""} /></Field>
            <div className="@3xl:col-span-4"><Button type="submit">保存</Button></div>
          </form>
          {editing && (
            <form action={deleteCondolence} className="mt-3 border-t border-line pt-3">
              <input type="hidden" name="id" value={editing.id} />
              <input type="hidden" name="back" value={href(base, { edit: editing.id })} />
              <Button type="submit" variant="danger" size="sm">この行を削除する</Button>
            </form>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-4">
        <div className="min-w-0 @5xl:col-span-3">
          <Table minWidth="min-w-[860px]">
            <thead>
              <tr>
                <Th>年月日</Th>
                <Th>区分</Th>
                <Th>内容</Th>
                <Th>名前</Th>
                <Th>関係</Th>
                <Th align="right">金額</Th>
                <Th>担当 (参列者)</Th>
                <Th>備考</Th>
                {canEdit && <Th />}
              </tr>
            </thead>
            <tbody>
              {paged.items.map((r) => (
                <Tr key={r.id}>
                  <Td className="whitespace-nowrap text-xs">{fmtDate(r.date)}</Td>
                  <Td><Badge tone={tone(r.category)}>{CONDOLENCE_CATEGORY_LABEL[r.category]}</Badge></Td>
                  <Td className="text-xs">{r.kind || "-"}</Td>
                  <Td>{r.name || "-"}</Td>
                  <Td className="text-xs">{r.relation || "-"}</Td>
                  <Td align="right" className="tnum">{r.amount !== undefined ? yen(r.amount) : "-"}</Td>
                  <Td className="text-xs">{r.attendee || "-"}</Td>
                  <Td className="text-xs text-ink-2">{r.note || ""}</Td>
                  {canEdit && <Td><Link href={href(base, { edit: r.id })} className="text-xs text-accent hover:underline">修正</Link></Td>}
                </Tr>
              ))}
              {paged.items.length === 0 && <EmptyRow colSpan={canEdit ? 9 : 8}>{all.length ? "条件に合う行はありません" : "まだ記録がありません。慶弔リスト (.xlsx) を取り込むか、「新しく記録する」から登録してください"}</EmptyRow>}
            </tbody>
          </Table>
          <Pager paged={paged} path="/office" sp={base} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="表示中の合計" />
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-ink-2">件数</dt><dd className="tnum">{rows.length} 件</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-2">金額の合計</dt><dd className="tnum">{yen(total)}</dd></div>
              {(Object.keys(CONDOLENCE_CATEGORY_LABEL) as CondolenceCategory[]).map((c) => (
                <div key={c} className="flex justify-between gap-2"><dt className="text-ink-2">{CONDOLENCE_CATEGORY_LABEL[c]}</dt><dd className="tnum">{rows.filter((r) => r.category === c).length} 件</dd></div>
              ))}
            </dl>
          </Card>
          {canEdit && (
            <ImportForm action={importCondolences} tab="keicho" title="シートから取り込む" description="慶弔リスト (.xlsx) か CSV (見出し: 年月日・内容・名前・関係・金額・担当（参列者）・備考)。「〃」は上の行と同じ値、見出しのない右の列 (弔電・会場など) は備考に入れます。登録済みと同じ行は取り込みません" />
          )}
        </div>
      </div>
    </div>
  );
}
