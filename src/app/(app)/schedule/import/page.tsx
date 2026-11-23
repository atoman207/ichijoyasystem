import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { CalendarCheck2, FileSpreadsheet, TriangleAlert } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportScheduleSheet } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { isDateKey, shortDate } from "@/lib/calendar";
import { addDays, fmtDateTime, toDateKey } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, LinkButton, Note, PageHeader, Select } from "@/components/ui";
import { SheetUploader } from "@/components/schedule/SheetUploader";
import { BATCH_RE, readBatchMonths } from "@/lib/schedule-sheet/batch";
import { planSheetImport, sheetSettings, type PlanItem, type SheetPlan } from "@/lib/schedule-sheet/plan";
import { applyScheduleSheet, discardScheduleSheet, removeScheduleSheetMonth, saveScheduleSheetAliases } from "@/lib/actions/schedule-sheet";

/**
 * 予定表 →「スプレッドシートの取込」(お客様のご要望 2026-11-23「■ 予定表の新システムへの移行について」)
 * 予定表のスプレッドシート (月のファイル) の明日以降の予定を新システムへ一括で移行する。
 * ファイルを読み込む → 照合 (顧客・案件・登録済みの予定・担当者) を確かめる →「この内容で取り込む」
 */

type SP = Record<string, string | undefined>;

const STATUS: Record<PlanItem["status"], { label: string; tone: string }> = {
  add: { label: "追加", tone: "bg-info-soft text-info-ink" },
  update: { label: "書き換え", tone: "bg-accent-soft text-accent-ink" },
  same: { label: "変更なし", tone: "bg-subtle text-ink-3" },
  duplicate: { label: "登録済み", tone: "bg-subtle text-ink-3" },
  kept: { label: "新システムで変更済み", tone: "bg-warn-soft text-warn-ink" },
};

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="text-lg font-semibold text-ink tnum">{value.toLocaleString()}</div>
      {hint && <div className="text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

function timeOf(it: PlanItem): string {
  return it.ev.startTime ? `${it.ev.startTime.replace(/^0/, "")}${it.ev.endTime ? `–${it.ev.endTime.replace(/^0/, "")}` : ""}` : it.ev.slot === "pm" ? "午後" : "午前";
}

export default async function ScheduleImportPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canImportScheduleSheet(user)) redirect("/schedule?err=" + encodeURIComponent("予定表の取込は本部スタッフ・管理者が行えます。"));
  const db = getDb();
  const today = toDateKey(new Date());
  const tomorrow = addDays(today, 1);
  const from = isDateKey(sp.from) && sp.from >= today ? sp.from : tomorrow;
  const batch = sp.batch && BATCH_RE.test(sp.batch) ? sp.batch : undefined;
  const loaded = batch ? await readBatchMonths(batch) : null;
  const settings = sheetSettings(db);
  const storeName = new Map(db.stores.map((s) => [s.id, s.shortName || s.name]));
  const users = db.users.filter((u) => u.active && !u.id.startsWith("u_review")).sort((a, b) => a.storeId.localeCompare(b.storeId) || a.name.localeCompare(b.name, "ja"));
  const userName = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "";
  const plan: SheetPlan | null = loaded?.months.length ? planSheetImport(db, loaded.months, { from }) : null;
  const last = settings.lastImport;

  const header = (
    <PageHeader
      title="スプレッドシートの予定表の取込"
      icon={<FileSpreadsheet />}
      back={{ href: "/schedule", label: "予定表" }}
      description="予定表のスプレッドシート (月のファイル) の明日以降の予定を、新システムの予定表へまとめて移行します。新システムに登録のないお客様は顧客と案件 (問い合わせ) を登録し、登録済みのお客様は今の顧客・案件にひも付けます。"
    />
  );

  if (!plan) {
    return (
      <div>
        <Flash msg={sp.msg} err={sp.err} />
        {header}
        <div className="@container grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <Card className="@4xl:col-span-2">
            <CardHeader title="1. 予定表のファイルを読み込む" description="読み込むだけでは何も変わりません。次の画面で内容を確かめてから取り込みます" />
            <SheetUploader from={sp.from} />
            {batch && !loaded && <p className="mt-2 text-xs text-critical-ink">読み込んだファイルが見つかりません (取込のあとか、破棄しました)。もう一度選んでください。</p>}
          </Card>
          <Card>
            <CardHeader title="ファイルの用意のしかた" />
            <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-2">
              <li>Google スプレッドシートで予定表の月のファイル (例: 「2026.11」「2026.12」) を開く</li>
              <li>「ファイル」→「ダウンロード」→「Microsoft Excel (.xlsx)」で保存する</li>
              <li>保存したファイル (例: 2026.12.xlsx) をこの画面で選ぶ。明日以降の予定がある月をすべて選びます</li>
            </ol>
            <p className="mt-2 text-xs text-ink-3">ファイル名の「年.月」で月を見分けます。名前を変えたときは「2026.12.xlsx」のようにしてください。</p>
            {last && (
              <div className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2" data-testid="sheet-last-import">
                <div className="font-medium text-ink">前回の取込</div>
                <div>
                  {fmtDateTime(last.at)} {userName(last.by) || "システム"} ({last.label})
                </div>
                <div>{last.summary}</div>
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }

  const c = plan.counts;
  const byDate = new Map<string, PlanItem[]>();
  for (const it of plan.items) (byDate.get(it.ev.date) ?? byDate.set(it.ev.date, []).get(it.ev.date)!).push(it);
  const dates = [...byDate.keys()].sort();
  const groupOf = new Map(plan.groups.map((g) => [g.gkey, g]));
  const live = (keys: string[]) => keys.some((k) => plan.items.find((i) => i.key === k && (i.status === "add" || i.status === "update")));
  const liveGroups = plan.groups.filter((g) => live(g.eventKeys)).sort((a, b) => Number(b.ambiguous) - Number(a.ambiguous) || a.name.localeCompare(b.name, "ja"));
  const nameRows = [
    ...plan.persons.map((p) => ({ name: p.name, count: p.count, example: "右上・事務の欄の予定", userId: p.userId })),
    ...plan.unknownNames.filter((u) => !plan.persons.some((p) => p.name === u.name)).map((u) => ({ name: u.name, count: u.count, example: u.example, userId: undefined as string | undefined })),
  ];
  const back = `/schedule/import?batch=${batch}`;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      {header}
      <div className="@container space-y-4">
        <Card>
          <CardHeader title="読み込んだファイル" description={`取り込むのは ${shortDate(plan.from)} 以降の予定です (読み込んだ月の範囲。${shortDate(plan.from)} より前の予定は変えません)`} />
          <ul className="divide-y divide-line text-sm" data-testid="sheet-months">
            {Object.entries(loaded!.index.months)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, m]) => {
                const pm = plan.months.find((x) => x.label === m.label);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="font-medium text-ink">{m.label}</span>
                    <span className="text-xs text-ink-3">{m.file}</span>
                    <span className="text-xs text-ink-2">
                      日別のシート {m.days} 日・取り込む範囲の書き込み {pm?.events ?? 0} 件
                    </span>
                    {m.problems.length > 0 && <span className="text-xs text-warn-ink">注意: {m.problems.join(" / ")}</span>}
                    <form action={removeScheduleSheetMonth} className="ml-auto">
                      <input type="hidden" name="batch" value={batch} />
                      <input type="hidden" name="month" value={key} />
                      <button type="submit" className="text-xs text-ink-3 underline hover:text-critical">外す</button>
                    </form>
                  </li>
                );
              })}
          </ul>
          <div className="mt-3">
            <SheetUploader batch={batch} from={sp.from} />
          </div>
        </Card>

        <Card>
          <CardHeader title="取り込む内容" description="予定表に載せる予定・登録する顧客と案件の数です。下で一つずつ確かめられます" />
          <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4 @4xl:grid-cols-6" data-testid="sheet-counts">
            <Stat label="追加する予定" value={c.add} />
            <Stat label="書き換える予定" value={c.update} hint="以前の移行・前回の取込" />
            <Stat label="新システムに登録済み" value={c.duplicate} hint="取り込まない" />
            <Stat label="消す予定" value={c.remove} hint="スプレッドシートにない" />
            <Stat label="新しい顧客" value={c.newCustomers} />
            <Stat label="既存の顧客にひも付け" value={c.linkedCustomers} />
            <Stat label="新しい案件 (問い合わせ)" value={c.newCases} />
            <Stat label="進行中の案件にひも付け" value={c.linkedCases} />
            <Stat label="お客様の候補を確かめる" value={c.ambiguous} hint="候補が複数" />
            <Stat label="変更なし" value={c.same} />
            {c.kept > 0 && <Stat label="新システムで変更済み" value={c.kept} hint="上書きしない" />}
          </div>
        </Card>

        {nameRows.length > 0 && (
          <Card>
            <CardHeader
              title="担当者の名前の対応"
              description="予定表の右上の予定 (光子 など)・事務の欄の人・「時間・担当」の欄の名前を、新システムの社員にします。決めた対応は次の取込でも使います"
            />
            <form action={saveScheduleSheetAliases} className="space-y-2" data-testid="sheet-aliases">
              <input type="hidden" name="batch" value={batch} />
              <input type="hidden" name="from" value={from} />
              <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
                {nameRows.map((r) => {
                  const current = settings.aliases[r.name] ?? r.userId ?? "";
                  return (
                    <label key={r.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-ink">「{r.name}」</span>
                        <span className="ml-1 text-[11px] text-ink-3">
                          {r.count} 件 · {r.example}
                        </span>
                      </span>
                      <Select name={`alias:${r.name}`} defaultValue={current} className="w-44" aria-label={`「${r.name}」の社員`}>
                        <option value="">未設定 (担当なし)</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({storeName.get(u.storeId) ?? u.storeId})
                          </option>
                        ))}
                        <option value="-">担当にしない</option>
                      </Select>
                    </label>
                  );
                })}
              </div>
              <Button type="submit" variant="secondary" size="sm">
                対応を保存して照合し直す
              </Button>
            </form>
          </Card>
        )}

        <form action={applyScheduleSheet} className="space-y-4">
          <input type="hidden" name="batch" value={batch} />
          {liveGroups.length > 0 && (
            <Card>
              <CardHeader
                title={`お客様の照合 (${liveGroups.length} 件)`}
                description="予定表の「(地区)名前」を、新システムの顧客 (姓と地区・住所) と照らし合わせました。候補が複数のもの (要確認) を上に出しています。選び直すと取り込むときに使います"
              />
              <div className="divide-y divide-line" data-testid="sheet-groups">
                {liveGroups.map((g) => (
                  <div key={g.gkey} className="flex flex-col gap-1 py-2 @3xl:flex-row @3xl:items-center @3xl:gap-3">
                    <div className="min-w-0 flex-1 text-sm">
                      <span className="font-medium text-ink">
                        {g.area ? `(${g.area}) ` : ""}
                        {g.name}
                      </span>
                      <span className="ml-1 text-[11px] text-ink-3">
                        {storeName.get(g.storeId) ?? g.storeId} · 予定 {g.eventKeys.length} 件
                      </span>
                      {g.ambiguous && <Badge tone="warn">要確認</Badge>}
                      <div className="text-[11px] text-ink-3">
                        {g.choice === "new" ? "新しい顧客と案件 (問い合わせ) を登録します" : g.caseRef ? `案件: ${g.caseRef.label}` : "案件: 新しい問い合わせを登録します (予定表から移行)"}
                      </div>
                    </div>
                    <Select name={`pick:${g.gkey}`} defaultValue={g.auto} className="w-full @3xl:w-96" aria-label={`${g.area ?? ""}${g.name} の顧客`}>
                      {g.candidates.map((cand) => (
                        <option key={cand.id} value={cand.id}>
                          {cand.label}
                          {cand.openCase ? " · 進行中の案件あり" : ""}
                          {cand.last ? ` · 最終 ${cand.last.slice(0, 7)}` : ""}
                        </option>
                      ))}
                      <option value="new">新しい顧客として登録する</option>
                      <option value="none">顧客にひも付けない</option>
                    </Select>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="取り込む予定" description="日ごとの一覧です。「登録済み」は新システムに同じ予定があるため取り込みません" />
            <div className="space-y-1" data-testid="sheet-days">
              {dates.map((d, i) => {
                const list = byDate.get(d)!;
                const n = list.filter((x) => x.status === "add" || x.status === "update").length;
                return (
                  <details key={d} open={i < 2} className="rounded-lg border border-line">
                    <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium text-ink">
                      {shortDate(d)} <span className="text-xs font-normal text-ink-3">取り込む {n} 件 / 書き込み {list.length} 件</span>
                    </summary>
                    <ul className="divide-y divide-line border-t border-line text-xs">
                      {list.map((it) => {
                        const g = it.gkey ? groupOf.get(it.gkey) : undefined;
                        const st = STATUS[it.status];
                        return (
                          <li key={it.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5" data-testid="sheet-item">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${st.tone}`}>{st.label}</span>
                            <span className="text-ink-3">{storeName.get(it.storeId) ?? it.storeId}</span>
                            <span className="tnum text-ink-2">{timeOf(it)}</span>
                            <span className="font-medium text-ink">{SCHEDULE_KIND[it.ev.kind].label}</span>
                            <span className="text-ink">{it.title}</span>
                            {it.ev.countText && <span className="text-ink-2">{it.ev.countText}</span>}
                            {it.assigneeIds.length > 0 && <span className="text-ink-3">担当: {it.assigneeIds.map(userName).join("・")}</span>}
                            {it.dupOf && (
                              <Link href={`/schedule/${it.dupOf.id}`} className="text-accent-ink underline">
                                登録済み: {it.dupOf.title}
                              </Link>
                            )}
                            {g && it.status !== "duplicate" && <span className="text-ink-3">→ {g.choice === "new" ? "新しい顧客" : g.choice === "none" ? "顧客なし" : (g.candidates.find((x) => x.id === g.choice)?.label ?? "")}</span>}
                            {it.ev.remark && <span className="basis-full text-[11px] text-ink-3">{it.ev.remark}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                );
              })}
            </div>
          </Card>

          {(plan.remove.length > 0 || plan.keep.length > 0) && (
            <Card>
              <CardHeader title={`消す予定 (${plan.remove.length} 件)`} description="以前に移行した予定のうち、今のスプレッドシートにないもの (日付が変わった・取りやめた予定など)。変更履歴に残します" />
              <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-ink-2 @3xl:grid-cols-2" data-testid="sheet-remove">
                {plan.remove.map((r) => (
                  <li key={r.id}>
                    {shortDate(r.date)} {storeName.get(r.storeId) ?? r.storeId} {r.title}
                  </li>
                ))}
              </ul>
              {plan.keep.length > 0 && (
                <Note tone="warn">
                  新システムで変更された予定 {plan.keep.length} 件はスプレッドシートになくても残します: {plan.keep.slice(0, 5).map((k) => `${shortDate(k.date)} ${k.title}`).join("、")}
                  {plan.keep.length > 5 ? " ほか" : ""}
                </Note>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title="2. 取り込む" />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="取り込む最初の日" hint="この日以降の予定を取り込みます (既定は明日)">
                <Input type="date" name="from" defaultValue={from} min={today} className="w-44" />
              </Field>
              <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="confirm" value="1" className="h-4 w-4 accent-accent" required />
                内容を確かめました
              </label>
              <Button type="submit" data-testid="sheet-apply">
                <CalendarCheck2 /> この内容で取り込む
              </Button>
            </div>
            <p className="mt-2 text-xs text-ink-3">
              取り込んだあとは予定表 (新システム) で予定を入れ・直してください。スプレッドシートを直してから取り込み直すこともできます (新システムで変えた予定は上書きしません)。
            </p>
          </Card>
        </form>

        <div className="flex flex-wrap items-center gap-3">
          <form action={`/schedule/import`} className="flex items-end gap-2">
            <input type="hidden" name="batch" value={batch} />
            <Field label="取り込む最初の日を変えて照合し直す">
              <Input type="date" name="from" defaultValue={from} min={today} className="w-44" />
            </Field>
            <Button type="submit" variant="secondary" size="sm">
              照合し直す
            </Button>
          </form>
          <form action={discardScheduleSheet}>
            <input type="hidden" name="batch" value={batch} />
            <Button type="submit" variant="ghost" size="sm">
              <TriangleAlert /> 読み込んだ内容を破棄する
            </Button>
          </form>
          <LinkButton href={back} variant="ghost" size="sm">
            最新の状態で照合し直す
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
