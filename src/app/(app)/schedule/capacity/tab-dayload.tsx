import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageSettings } from "@/lib/auth/permissions";
import { updateDayLoad } from "@/lib/actions/day-load";
import { DAY_LOAD_DEFAULTS, PER_EVENT_OPTIONS, SHEET_ITEMS, SHEET_ITEM_LABEL, perEventKindsLabel, readDayLoadSettings, sheetNum, storeCapacity } from "@/lib/day-sheet";
import { SCHEDULE_KIND } from "@/lib/constants";
import { isClosedDay } from "@/lib/schedule-capacity";
import { toDateKey } from "@/lib/format";
import { Button, Card, CardHeader, Field, Input, Note } from "@/components/ui";

/**
 * 1 日の対応可能枚数 (お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」③)。
 * 対応可能枚数 = 対象人数 × 1 人の枚数。換算作業量 = 畳 + 襖 + 障子 × 0.5 + 網戸 × 0.5 + 見積など 件数 × 3 + 前日繰越。計算は src/lib/day-sheet.ts
 */
export async function DayLoadTab() {
  const user = await requireUser();
  const db = getDb();
  const admin = canManageSettings(user);
  const set = readDayLoadSettings(db);
  const today = toDateKey(new Date());
  const stores = db.stores.filter((s) => s.kind !== "hq");
  return (
    <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader title="1 日の対応可能枚数" description="予定表の「日」の一番下に出す、その日の作業量の上限です。対応可能枚数 = 対象人数 × 1 人の枚数" />
        <form action={updateDayLoad} className="space-y-4">
          <fieldset disabled={!admin} className="space-y-4">
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-6">
              <Field label="1 人の 1 日の枚数" hint={`既定 ${DAY_LOAD_DEFAULTS.perPerson} 枚`}>
                <Input type="number" inputMode="decimal" name="perPerson" min={1} max={99} step={0.5} defaultValue={set.perPerson} required />
              </Field>
              {SHEET_ITEMS.map((k) => (
                <Field key={k} label={`${SHEET_ITEM_LABEL[k]} 1 枚の換算`} hint={`既定 ${DAY_LOAD_DEFAULTS.weights[k]}`}>
                  <Input type="number" inputMode="decimal" name={`w.${k}`} min={0} max={10} step={0.1} defaultValue={set.weights[k]} required />
                </Field>
              ))}
            </div>
            <div className="space-y-1.5 text-sm text-ink">
              <label className="flex items-start gap-2">
                <input type="checkbox" name="subtractLeave" value="1" defaultChecked={set.subtractLeave} className="mt-0.5 h-4 w-4" />
                <span>
                  休暇の人を、その日の対象人数から引く <span className="text-xs text-ink-3">(予定表の「休暇・不在」の予定。終日 1 人・午前 / 午後 0.5 人)</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" name="countDelivery" value="1" defaultChecked={set.countDelivery} className="mt-0.5 h-4 w-4" />
                <span>
                  納品の枚数も作業量に数える <span className="text-xs text-ink-3">(既定は数えない = これまでのスプレッドシートの「上限」の行と同じく、引取の欄の枚数だけ。表替えは同じ畳を午前に引き取って午後に納品するため)</span>
                </span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
              <div className="rounded-xl border border-line px-3 py-2.5">
                <p className="mb-1 text-sm font-semibold text-ink">見積・現調・現場管理などの予定</p>
                <p className="mb-2 text-[11px] leading-relaxed text-ink-3">
                  1 件を決まった枚数で作業量に足します (枚数の欄には出しません)。これまでのスプレッドシートで見積の行に「襖 3」と書いていたのと同じです。
                </p>
                <div className="max-w-[200px]">
                  <Field label="1 件の換算 (枚)" hint={`既定 ${DAY_LOAD_DEFAULTS.perEvent} 枚`}>
                    <Input type="number" inputMode="decimal" name="perEvent" min={0} max={99} step={0.5} defaultValue={set.perEvent} required />
                  </Field>
                </div>
                <p className="mt-2 mb-1 text-[11px] text-ink-3">1 件で数える予定の種類</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {PER_EVENT_OPTIONS.map((k) => (
                    <label key={k} className="inline-flex items-center gap-1.5 text-sm text-ink">
                      <input type="checkbox" name="perEventKinds" value={k} defaultChecked={set.perEventKinds.includes(k)} className="h-4 w-4" />
                      {SCHEDULE_KIND[k].label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-line px-3 py-2.5">
                <p className="mb-1 text-sm font-semibold text-ink">前日繰越</p>
                <label className="flex items-start gap-2 text-sm text-ink">
                  <input type="checkbox" name="carry" value="1" defaultChecked={set.carry} className="mt-0.5 h-4 w-4" />
                  <span>
                    前日の超過分を翌日の作業量に繰り越す <span className="text-xs text-ink-3">(スプレッドシートの「繰り越し」の行と同じ。休業日はそのまま次の営業日へ)</span>
                  </span>
                </label>
                <div className="mt-2 max-w-[220px]">
                  <Field label="繰り越しを数え始める日" hint="この日の前日繰越は 0 枚から">
                    <Input type="date" name="carryFrom" defaultValue={set.carryFrom} required />
                  </Field>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-3">実際の進み具合とずれたときは、予定表の日の表示の一番下の「前日繰越を直す」で、店舗・日ごとに枚数を直せます (店舗の社員・本部・管理者)。</p>
              </div>
              {stores.map((s) => {
                const members = db.users.filter((u) => u.active && u.storeId === s.id);
                const st = set.stores[s.id];
                const ex = new Set(st?.excludeUserIds ?? []);
                const cap = storeCapacity(db, set, s.id, today, db.schedule.filter((e) => e.kind === "leave"), isClosedDay(db, today));
                return (
                  <div key={s.id} className="rounded-xl border border-line px-3 py-2.5">
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                      {s.name}
                      <span className="ml-auto text-xs font-normal text-ink-2 tnum">今日: {sheetNum(cap?.people ?? 0) || "0"} 人 × {sheetNum(set.perPerson)} = {sheetNum(cap?.capacity ?? 0) || "0"} 枚</span>
                    </p>
                    <p className="mb-1 text-[11px] text-ink-3">対象人数に入れる社員 (チェックを外すと対象外)</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {members.map((u) => (
                        <label key={u.id} className="inline-flex items-center gap-1.5 text-sm text-ink">
                          <input type="checkbox" name={`${s.id}.include`} value={u.id} defaultChecked={!ex.has(u.id)} className="h-4 w-4" />
                          {u.name}
                          {u.title && <span className="text-[11px] text-ink-3">{u.title.replace(s.name, "").trim()}</span>}
                        </label>
                      ))}
                      {members.length === 0 && <span className="text-xs text-ink-3">この店舗の社員はいません</span>}
                    </div>
                    <div className="mt-2 max-w-[200px]">
                      <Field label="人数を手で決める (任意)" hint="空欄 = チェックした社員の数">
                        <Input type="number" inputMode="decimal" name={`${s.id}.people`} min={0} max={99} step={0.5} defaultValue={st?.people ?? ""} placeholder={String(members.filter((u) => !ex.has(u.id)).length)} />
                      </Field>
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
          {admin ? <Button type="submit">保存する</Button> : <Note>設定の変更は管理者が行います。</Note>}
        </form>
      </Card>
      <Card className="@5xl:self-start">
        <CardHeader title="計算のしかた" />
        <ul className="space-y-1.5 text-xs leading-relaxed text-ink-2">
          <li>・対応可能枚数 = 対象人数 × {sheetNum(set.perPerson)} 枚。対象人数は店舗の社員のうちチェックした人 (人数を手で決めた店舗はその人数) から、その日の休暇の人を引いた数です。</li>
          <li>
            ・換算作業量 = 畳 × {set.weights.tatami} + 襖 × {set.weights.fusuma} + 障子 × {set.weights.shoji} + 網戸 × {set.weights.amido} + 見積など 件数 × {sheetNum(set.perEvent) || "0"} (表替え・張替えと新調は同じ扱い)。
          </li>
          <li>
            ・作業量に数えるのは、その日の 引き取り・現場見積 (現見)・施工・採寸{set.countDelivery ? "・納品" : ""} の予定の枚数です。採寸の枚数は「新」(新調) に出します。新調も表替え・張替えと同じ換算です。
          </li>
          <li>
            ・{perEventKindsLabel(set.perEventKinds)} の予定は 1 件 = {sheetNum(set.perEvent) || "0"} 枚として作業量に足します (枚数の欄には出しません)。{PER_EVENT_OPTIONS.filter((k) => !set.perEventKinds.includes(k))
              .map((k) => SCHEDULE_KIND[k].short)
              .join("・")}
            などの予定は数えません。
          </li>
          <li>
            ・
            {set.carry
              ? `前日繰越 = 前日の (換算作業量 + 前日繰越 − 対応可能枚数) の超えた分。${set.carryFrom} から数えます。休業日は対応可能 0 枚のため、そのまま次の営業日に繰り越します。`
              : "前日の超過分は繰り越しません (日ごとに計算)。"}
          </li>
          <li>・枚数は、受注・見積の明細、移行した予定表の枚数、予定の「仕事内容」(予定を押した画面で直せます) から読み取ります。</li>
          <li>・作業量の合計 (前日繰越を含む) が対応可能枚数を超えた日は、予定表の日の表示の一番下に「○枚オーバー」、店舗を選んだ週・月の表示に赤の「作業 26/22」を出します。</li>
          <li>
            ・候補日の提案 (AI) の上限は「<Link href="/schedule/capacity?tab=capacity" className="underline">1 日の上限</Link>」の畳の製造の枚数です (この設定とは別)。
          </li>
        </ul>
      </Card>
    </div>
  );
}
