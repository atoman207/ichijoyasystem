import clsx from "clsx";
import { CheckCircle2, CircleDashed, CircleHelp } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { ScheduleKind, User } from "@/lib/db/types";
import { canEditStaffProfile, canManageScheduling } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { saveProcessesForm, saveResourcesForm, saveRoutingForm, saveRulesForm, saveSkillsForm, saveStaffProfileForm, saveWeightsForm, saveWorkTypesForm } from "@/lib/actions/scheduling";
import { defaultProfile, loadMasters, PROCESS_KEYS, RESOURCE_KIND_LABEL, RESOURCE_TYPES, SKILL_LEVEL_LABEL, WEIGHT_LABEL, WORK_CATEGORY_LABEL, type Weights, type WorkCategory } from "@/lib/scheduling/masters";
import { readiness, type ReadyStatus } from "@/lib/scheduling/readiness";
import { googleKey, routingStatus } from "@/lib/geo/routing";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select } from "@/components/ui";

/**
 * 仕事量と提案の設定のタブ (マスタ)。保存は src/lib/actions/scheduling.ts (管理者。社員の勤務と技能は店長も自店舗)
 * 値はすべて一畳屋の実際の数字に置き換える前提 (初期値は「暫定」)
 */

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const SITE_KINDS: ScheduleKind[] = ["survey", "measure", "pickup", "delivery", "install"];

function AdminNote({ admin }: { admin: boolean }) {
  return admin ? null : <Note>この設定の変更は管理者が行います。値の見直しが必要なときは管理者に依頼してください。</Note>;
}

/* ---------------- 準備の状況 ---------------- */

const READY: Record<ReadyStatus, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  done: { label: "登録済み", icon: CheckCircle2, cls: "text-good-ink" },
  provisional: { label: "暫定・一部", icon: CircleDashed, cls: "text-warn-ink" },
  missing: { label: "未登録", icon: CircleHelp, cls: "text-critical-ink" },
};

export async function ReadyTab() {
  await requireUser();
  const items = readiness(getDb());
  const done = items.filter((i) => i.status === "done").length;
  return (
    <Card>
      <CardHeader title="一畳屋に用意していただく情報" description={`提案を一畳屋の実際の仕事に合わせるための情報です (${done}/${items.length} 項目が登録済み)。未登録の項目は、暫定の値・過去の実績からの推定で動いています`} />
      <ul className="divide-y divide-line">
        {items.map((i) => {
          const r = READY[i.status];
          return (
            <li key={i.key} className="flex items-start gap-3 py-2.5">
              <r.icon className={clsx("mt-0.5 h-5 w-5 shrink-0", r.cls)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {i.label} <span className={clsx("ml-1 text-xs font-normal", r.cls)}>{r.label}</span>
                </p>
                <p className="text-xs text-ink-2">{i.detail}</p>
              </div>
              <Link href={i.tab === "backtest" ? "/schedule/capacity?tab=backtest" : `/schedule/capacity?tab=${i.tab}`} className="shrink-0 text-xs text-accent hover:underline">
                設定 →
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ---------------- 作業種別 ---------------- */

export async function WorkTab() {
  const user = await requireUser();
  const db = getDb();
  const m = loadMasters(db);
  const admin = canManageScheduling(user);
  const rows = [...m.workTypes, undefined];
  return (
    <form action={saveWorkTypesForm} className="space-y-3">
      <AdminNote admin={admin} />
      <Note tone="accent">
        現場の時間は「基本 + 1 枚あたり × 枚数」(分)。製造は工程と 1 枚あたりの時間 (分)。製造日数は引き取りから納品までの最短の日数 (乾燥・取り寄せを含む)。「暫定」のチェックは、一畳屋の確認がとれたら外してください。名前を空にすると削除します。
      </Note>
      <fieldset disabled={!admin} className="space-y-3">
        {rows.map((w, i) => (
          <Card key={w?.id ?? "new"} className={clsx(!w && "border-dashed")}>
            <p className="mb-2 text-sm font-semibold text-ink">{w ? w.name : "新しい作業種別を追加"}</p>
            <input type="hidden" name={`wt.${i}.id`} value={w?.id ?? ""} />
            <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-4">
              <Field label="名前">
                <Input name={`wt.${i}.name`} defaultValue={w?.name ?? ""} placeholder="例: 畳 表替え (特上)" />
              </Field>
              <Field label="分類">
                <Select name={`wt.${i}.category`} defaultValue={w?.category ?? "tatami"}>
                  {(Object.keys(WORK_CATEGORY_LABEL) as WorkCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {WORK_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="単位">
                <Input name={`wt.${i}.unit`} defaultValue={w?.unit ?? "枚"} />
              </Field>
              <Field label="見分ける言葉 (読点区切り)" hint="件名・メモ・明細にこの言葉があればこの種別">
                <Input name={`wt.${i}.keywords`} defaultValue={w?.keywords.join("、") ?? ""} />
              </Field>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 @3xl:grid-cols-5">
              {SITE_KINDS.map((k) => (
                <Field key={k} label={`${SCHEDULE_KIND[k].label}の時間 (基本 / 1 枚)`}>
                  <div className="flex gap-1">
                    <Input type="number" min={0} name={`wt.${i}.site.${k}.base`} defaultValue={w?.site[k]?.[0] ?? ""} aria-label={`${SCHEDULE_KIND[k].label} 基本`} />
                    <Input type="number" min={0} step="0.5" name={`wt.${i}.site.${k}.per`} defaultValue={w?.site[k]?.[1] ?? ""} aria-label={`${SCHEDULE_KIND[k].label} 1 枚あたり`} />
                  </div>
                </Field>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 @3xl:grid-cols-4">
              <Field label="必要な人数">
                <Input type="number" min={1} max={6} name={`wt.${i}.staffCount`} defaultValue={w?.staffCount ?? 1} />
              </Field>
              <Field label="製造日数 (日)">
                <Input type="number" min={0} max={60} name={`wt.${i}.leadDays`} defaultValue={w?.leadDays ?? 0} />
              </Field>
              {[0, 1].map((j) => (
                <Field key={j} label={`製造の工程 ${j + 1} / 1 枚の分`}>
                  <div className="flex gap-1">
                    <Select name={`wt.${i}.proc.${j}.key`} defaultValue={w?.processes[j]?.processKey ?? ""} aria-label={`工程 ${j + 1}`}>
                      <option value="">なし</option>
                      {[...new Set([...PROCESS_KEYS.map((p) => p.key), ...m.processes.map((p) => p.key)])].map((k) => (
                        <option key={k} value={k}>
                          {PROCESS_KEYS.find((p) => p.key === k)?.name ?? m.processes.find((p) => p.key === k)?.name ?? k}
                        </option>
                      ))}
                    </Select>
                    <Input type="number" min={0} name={`wt.${i}.proc.${j}.min`} defaultValue={w?.processes[j]?.minutesPerUnit ?? ""} aria-label={`工程 ${j + 1} の 1 枚あたりの分`} />
                  </div>
                </Field>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              <span className="font-medium">必要な技能:</span>
              {m.skills.map((s) => (
                <label key={s.id} className="inline-flex items-center gap-1">
                  <input type="checkbox" name={`wt.${i}.skills`} value={s.id} defaultChecked={w?.skills.includes(s.id)} /> {s.name}
                </label>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              <span className="font-medium">必要な車両・設備:</span>
              {RESOURCE_TYPES.map((t) => (
                <label key={t.type} className="inline-flex items-center gap-1">
                  <input type="checkbox" name={`wt.${i}.resourceKinds`} value={t.type} defaultChecked={w?.resourceKinds.includes(t.type)} /> {t.label}
                </label>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 @3xl:grid-cols-3">
              {[0, 1, 2].map((j) => (
                <Field key={j} label={`材料 ${j + 1} / 1 枚あたりの数量`}>
                  <div className="flex gap-1">
                    <Select name={`wt.${i}.mat.${j}.id`} defaultValue={w?.materials[j]?.materialId ?? ""} aria-label={`材料 ${j + 1}`}>
                      <option value="">なし</option>
                      {(db.materials ?? [])
                        .filter((x) => x.active)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                    </Select>
                    <Input type="number" min={0} step="0.01" name={`wt.${i}.mat.${j}.qty`} defaultValue={w?.materials[j]?.qtyPerUnit ?? ""} aria-label={`材料 ${j + 1} の数量`} />
                  </div>
                </Field>
              ))}
            </div>
            <div className="mt-2 flex gap-4 text-xs text-ink-2">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" name={`wt.${i}.active`} defaultChecked={w ? w.active : true} /> 使う
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" name={`wt.${i}.provisional`} defaultChecked={w ? w.provisional : true} /> 暫定 (一畳屋の確認待ち)
              </label>
            </div>
          </Card>
        ))}
      </fieldset>
      {admin && <Button type="submit">作業種別を保存する</Button>}
    </form>
  );
}

/* ---------------- 製造の工程 ---------------- */

export async function ProductionTab() {
  const user = await requireUser();
  const db = getDb();
  const m = loadMasters(db);
  const admin = canManageScheduling(user);
  const stores = db.stores.filter((s) => !s.closedOn);
  const rows = [...m.processes, undefined, undefined];
  const staff = db.users.filter((u) => u.active && u.role !== "hq_staff");
  return (
    <form action={saveProcessesForm} className="space-y-3">
      <AdminNote admin={admin} />
      <Note tone="accent">作業場 (店舗) ごとの工程と 1 日の処理能力 (時間)。空欄の能力は、畳は「引き取る畳の枚数の上限 × 30 分」、ほかは 1 日 4 時間で仮に計算します。ほかの店舗の分も作る作業場は「受け持つ店舗」を選びます。種類を空にすると削除します。</Note>
      <fieldset disabled={!admin} className="space-y-3">
        {rows.map((p, i) => (
          <Card key={p?.id ?? `new-${i}`} className={clsx(!p && "border-dashed")}>
            <input type="hidden" name={`pr.${i}.id`} value={p?.id ?? ""} />
            <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-4">
              <Field label="工程の種類">
                <Select name={`pr.${i}.key`} defaultValue={p?.key ?? ""}>
                  <option value="">{p ? "削除する" : "追加しない"}</option>
                  {PROCESS_KEYS.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="名前">
                <Input name={`pr.${i}.name`} defaultValue={p?.name ?? ""} />
              </Field>
              <Field label="作業場の店舗">
                <Select name={`pr.${i}.storeId`} defaultValue={p?.storeId ?? ""}>
                  <option value="">選ぶ</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="1 日の処理能力 (時間)" hint={p?.minutesPerDay === undefined ? "空欄 = 仮の計算" : undefined}>
                <Input type="number" min={0} step="0.5" name={`pr.${i}.hoursPerDay`} defaultValue={p?.minutesPerDay !== undefined ? p.minutesPerDay / 60 : ""} />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              <span className="font-medium">作業する曜日 (空 = 休業日以外):</span>
              {WEEK.map((d, k) => (
                <label key={d} className="inline-flex items-center gap-1">
                  <input type="checkbox" name={`pr.${i}.workdays`} value={k} defaultChecked={p?.workdays.includes(k)} /> {d}
                </label>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              <span className="font-medium">受け持つほかの店舗:</span>
              {stores.map((s) => (
                <label key={s.id} className="inline-flex items-center gap-1">
                  <input type="checkbox" name={`pr.${i}.servesStores`} value={s.id} defaultChecked={p?.servesStores.includes(s.id)} /> {s.shortName}
                </label>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              <span className="font-medium">製造の担当:</span>
              {staff.map((u) => (
                <label key={u.id} className="inline-flex items-center gap-1">
                  <input type="checkbox" name={`pr.${i}.staffIds`} value={u.id} defaultChecked={p?.staffIds.includes(u.id)} /> {u.name}
                </label>
              ))}
            </div>
            <div className="mt-2 flex gap-4 text-xs text-ink-2">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" name={`pr.${i}.active`} defaultChecked={p ? p.active : true} /> 使う
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" name={`pr.${i}.provisional`} defaultChecked={p ? p.provisional : true} /> 暫定
              </label>
            </div>
          </Card>
        ))}
      </fieldset>
      {admin && <Button type="submit">製造の工程を保存する</Button>}
    </form>
  );
}

/* ---------------- 社員の勤務と技能 ---------------- */

export async function StaffTab({ focus }: { focus?: string }) {
  const user = await requireUser();
  const db = getDb();
  const m = loadMasters(db);
  const admin = canManageScheduling(user);
  const staff = db.users.filter((u) => u.active && u.role !== "hq_staff" && (admin || canEditStaffProfile(user, u) || u.id === user.id));
  const target: User | undefined = staff.find((u) => u.id === focus) ?? staff.find((u) => canEditStaffProfile(user, u));
  const stores = db.stores.filter((s) => s.kind === "store" && !s.closedOn);
  const p = target ? (m.profiles.get(target.id) ?? undefined) : undefined;
  const d = target ? defaultProfile(target) : undefined;
  const editable = target ? canEditStaffProfile(user, target) : false;
  return (
    <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[260px_minmax(0,1fr)]">
      <Card padded={false} className="@5xl:self-start">
        <ul className="divide-y divide-line">
          {staff.map((u) => (
            <li key={u.id}>
              <Link href={`/schedule/capacity?tab=staff&user=${u.id}`} className={clsx("flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-subtle", target?.id === u.id && "bg-accent-soft font-semibold text-accent-ink")}>
                <span className="min-w-0 truncate">{u.name}</span>
                <span className={clsx("shrink-0 text-[10px]", m.profiles.has(u.id) ? "text-good-ink" : "text-ink-3")}>{m.profiles.has(u.id) ? "設定済み" : "未設定"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <div className="space-y-4">
        {target && d && (
          <Card>
            <CardHeader title={`${target.name} の勤務と技能`} description={`${target.title}・${db.stores.find((s) => s.id === target.storeId)?.shortName ?? ""}。${p ? "" : "未設定のため、肩書きからの推定で提案しています (技能・勤務の条件は確かめていません)。"}`} />
            {!editable && <Note>この社員の設定の変更は、管理者とその店舗の店長が行います。</Note>}
            <form action={saveStaffProfileForm.bind(null, target.id)} className="space-y-3">
              <input type="hidden" name="back" value={`/schedule/capacity?tab=staff&user=${target.id}`} />
              <fieldset disabled={!editable} className="space-y-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-2">技能と熟練度</p>
                  <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-3">
                    {m.skills.map((s) => (
                      <Field key={s.id} label={s.name}>
                        <Select name={`skill.${s.id}`} defaultValue={String((p ?? d).skills[s.id] ?? 0)}>
                          <option value="0">なし</option>
                          {([1, 2, 3] as const).map((lv) => (
                            <option key={lv} value={lv}>
                              {SKILL_LEVEL_LABEL[lv]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                  <span className="font-medium">勤務する曜日:</span>
                  {WEEK.map((w, k) => (
                    <label key={w} className="inline-flex items-center gap-1">
                      <input type="checkbox" name="workDays" value={k} defaultChecked={(p ?? d).workDays.includes(k)} /> {w}
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
                  <Field label="勤務の開始">
                    <Input type="time" name="workStart" defaultValue={p?.workStart ?? ""} />
                  </Field>
                  <Field label="勤務の終了">
                    <Input type="time" name="workEnd" defaultValue={p?.workEnd ?? ""} />
                  </Field>
                  <Field label="休憩 (分)">
                    <Input type="number" min={0} max={180} name="breakMinutes" defaultValue={(p ?? d).breakMinutes} />
                  </Field>
                  <Field label="1 日の最大作業時間 (時間)">
                    <Input type="number" min={1} max={16} step="0.5" name="maxHoursPerDay" defaultValue={(p ?? d).maxMinutesPerDay / 60} />
                  </Field>
                  <Field label="1 日の最大件数" hint="空欄 = 店舗の設定">
                    <Input type="number" min={1} max={20} name="maxEventsPerDay" defaultValue={p?.maxEventsPerDay ?? ""} />
                  </Field>
                  <Field label="連続勤務の上限 (日)">
                    <Input type="number" min={1} max={14} name="maxConsecutiveDays" defaultValue={(p ?? d).maxConsecutiveDays} />
                  </Field>
                  <Field label="月の残業の上限 (時間)">
                    <Input type="number" min={0} max={160} name="overtimeCapHours" defaultValue={(p ?? d).overtimeCapMonthly / 60} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" name="fieldWork" defaultChecked={(p ?? d).fieldWork} /> 現場に出る
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" name="production" defaultChecked={(p ?? d).production} /> 製造の担当
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" name="canDrive" defaultChecked={(p ?? d).canDrive} /> 車両を運転できる
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" name="needsCompanion" defaultChecked={(p ?? d).needsCompanion} /> 一人では行かない (同行が必要)
                  </label>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                  <span className="font-medium">応援に行ける店舗:</span>
                  {stores
                    .filter((s) => s.id !== target.storeId)
                    .map((s) => (
                      <label key={s.id} className="inline-flex items-center gap-1">
                        <input type="checkbox" name="supportStores" value={s.id} defaultChecked={(p ?? d).supportStores.includes(s.id)} /> {s.shortName}
                      </label>
                    ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                  <span className="font-medium">同行できる人 (空 = 熟練の人なら誰でも):</span>
                  {db.users
                    .filter((u) => u.active && u.id !== target.id && u.role !== "hq_staff")
                    .map((u) => (
                      <label key={u.id} className="inline-flex items-center gap-1">
                        <input type="checkbox" name="mentorIds" value={u.id} defaultChecked={(p ?? d).mentorIds.includes(u.id)} /> {u.name}
                      </label>
                    ))}
                </div>
                <Field label="メモ">
                  <Input name="note" defaultValue={p?.note ?? ""} />
                </Field>
                {p && (
                  <label className="inline-flex items-center gap-1 text-xs text-ink-3">
                    <input type="checkbox" name="remove" /> 設定を消す (肩書きからの推定に戻す)
                  </label>
                )}
              </fieldset>
              {editable && <Button type="submit">保存する</Button>}
            </form>
          </Card>
        )}
        <Card>
          <CardHeader title="技能の一覧" description="作業種別の「必要な技能」と、社員の熟練度で使います。名前を空にすると削除します" />
          <form action={saveSkillsForm} className="space-y-2">
            <fieldset disabled={!admin} className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
              {[...m.skills, undefined, undefined].map((s, i) => (
                <div key={s?.id ?? `new-${i}`} className="flex gap-2">
                  <Input name={`sk.${i}.id`} defaultValue={s?.id ?? ""} placeholder="ID (英数字)" className="w-36" aria-label="技能の ID" />
                  <Input name={`sk.${i}.name`} defaultValue={s?.name ?? ""} placeholder="技能の名前" aria-label="技能の名前" />
                </div>
              ))}
            </fieldset>
            {admin && <Button type="submit" size="sm">技能の一覧を保存する</Button>}
          </form>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- 車両・設備 ---------------- */

export async function ResourcesTab() {
  const user = await requireUser();
  const db = getDb();
  const m = loadMasters(db);
  const admin = canManageScheduling(user);
  const stores = db.stores.filter((s) => !s.closedOn);
  const rows = [...m.resources, undefined, undefined, undefined];
  return (
    <form action={saveResourcesForm} className="space-y-3">
      <AdminNote admin={admin} />
      <Note tone="accent">店舗ごとの車両・機械・工具。登録した店舗では、作業種別の「必要な車両・設備」の空きを確かめ、予定を確定すると予約します。積める数は畳の枚数 (空欄 = 制限なし)。名前を空にすると削除します。</Note>
      <fieldset disabled={!admin}>
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="bg-subtle text-left text-ink-2">
                  <th className="px-3 py-2 font-medium">名前</th>
                  <th className="px-2 py-2 font-medium">種類</th>
                  <th className="px-2 py-2 font-medium">店舗</th>
                  <th className="px-2 py-2 font-medium">積める数</th>
                  <th className="px-2 py-2 font-medium">免許など</th>
                  <th className="px-2 py-2 font-medium">メモ</th>
                  <th className="px-2 py-2 font-medium">使う</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r?.id ?? `new-${i}`} className="border-t border-line">
                    <td className="px-3 py-1.5">
                      <input type="hidden" name={`rs.${i}.id`} value={r?.id ?? ""} />
                      <Input name={`rs.${i}.name`} defaultValue={r?.name ?? ""} placeholder={r ? "" : "例: 軽トラック 1 号"} aria-label="名前" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Select name={`rs.${i}.type`} defaultValue={r?.type ?? "truck"} aria-label="種類">
                        {RESOURCE_TYPES.map((t) => (
                          <option key={t.type} value={t.type}>
                            {RESOURCE_KIND_LABEL[t.kind]}: {t.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Select name={`rs.${i}.storeId`} defaultValue={r?.storeId ?? ""} aria-label="店舗">
                        <option value="">選ぶ</option>
                        {stores.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.shortName}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" min={1} name={`rs.${i}.capacityUnits`} defaultValue={r?.capacityUnits ?? ""} className="w-20" aria-label="積める数" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input name={`rs.${i}.license`} defaultValue={r?.license ?? ""} className="w-28" aria-label="免許など" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input name={`rs.${i}.note`} defaultValue={r?.note ?? ""} aria-label="メモ" />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" name={`rs.${i}.active`} defaultChecked={r ? r.active : true} aria-label="使う" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </fieldset>
      {admin && <Button type="submit">車両・設備を保存する</Button>}
    </form>
  );
}

/* ---------------- 経路 ---------------- */

export async function RoutingTab() {
  const user = await requireUser();
  const db = getDb();
  const m = loadMasters(db);
  const admin = canManageScheduling(user);
  const r = m.routing;
  const st = routingStatus(r);
  return (
    <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader title="移動時間の求め方" description="既定は社内の計算 (お客様の住所を社外に送りません)。実際の道路の経路・時間帯の混雑を使うときは Google Routes API を使えます" />
        <AdminNote admin={admin} />
        <form action={saveRoutingForm} className="space-y-3">
          <fieldset disabled={!admin} className="space-y-3">
            <Field label="経路サービス">
              <Select name="provider" defaultValue={r.provider}>
                <option value="local">社内の計算 (距離からの目安。社外に送らない)</option>
                <option value="google">Google の経路 (Routes API。キーと社内の承認が必要)</option>
              </Select>
            </Field>
            <label className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft/40 px-3 py-2 text-xs text-ink-2">
              <input type="checkbox" name="approved" defaultChecked={r.policy.approved} className="mt-0.5" />
              <span>
                <strong className="text-ink">社内の承認:</strong> 現場の位置 (緯度経度) を Google の経路サービスに送ることを、社内の方針として認めました。住所・お客様の名前は送りません。
                {r.policy.approved && r.policy.by && (
                  <span className="mt-0.5 block text-ink-3">
                    承認: {r.policy.by} ({r.policy.at?.slice(0, 10)})
                  </span>
                )}
              </span>
            </label>
            <Field label="承認の根拠・メモ">
              <Input name="policyNote" defaultValue={r.policy.note ?? ""} placeholder="例: 2026-12 役員会で承認" />
            </Field>
            <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
              <Field label="送る位置の細かさ">
                <Select name="precision" defaultValue={r.precision}>
                  <option value="area">町名の単位 (約 1 km に丸める。家は分からない)</option>
                  <option value="exact">地図で確かめた家の位置</option>
                </Select>
              </Field>
              <Field label="1 か月の上限 (出発 × 到着の組)" hint="超えたら月末まで社内の計算">
                <Input type="number" min={0} name="monthlyElementLimit" defaultValue={r.monthlyElementLimit} />
              </Field>
              <Field label="社内の計算: 朝夕の混雑の係数" hint="1.25 = 25% 遅い (熊本市・合志市・菊陽町の 7:30〜9:00・17:00〜18:30)">
                <Input type="number" min={1} max={2} step="0.05" name="rushFactor" defaultValue={r.rushFactor} />
              </Field>
              <label className="flex items-center gap-2 pt-6 text-xs text-ink-2">
                <input type="checkbox" name="trafficAware" defaultChecked={r.trafficAware} /> Google: 時間帯の交通状況を反映する (料金が上がります)
              </label>
            </div>
          </fieldset>
          {admin && <Button type="submit">経路の設定を保存する</Button>}
        </form>
      </Card>
      <Card className="@5xl:self-start">
        <CardHeader title="いまの状態" />
        <ul className="space-y-1.5 text-xs text-ink-2">
          <li>
            使っている計算: <Badge tone={st.ready ? "good" : "neutral"}>{st.ready ? "Google の経路" : "社内の計算"}</Badge>
          </li>
          {st.reason && <li>{st.reason}</li>}
          <li>API キー (GOOGLE_MAPS_API_KEY): {googleKey() ? "設定済み" : "未設定"}</li>
          <li>
            今月の問い合わせ: {st.usedThisMonth} / {st.limit} 件
          </li>
          <li>保存した経路: {st.cached} 件 (30 日再利用)</li>
          {st.lastError && <li className="text-critical-ink">直近の失敗: {st.lastError}</li>}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-3">失敗・時間切れ・上限超えのときは自動で社内の計算に切り替えます (10 分は Google を呼びません)。キーは .env.local に入れて npm run env:apply で本番に写します。Google Maps Platform の請求の上限 (予算アラート) も設定してください。</p>
      </Card>
    </div>
  );
}

/* ---------------- 計画の基準 ---------------- */

export async function RulesTab() {
  const user = await requireUser();
  const m = loadMasters(getDb());
  const admin = canManageScheduling(user);
  const r = m.rules;
  return (
    <Card>
      <CardHeader title="計画の基準" description="製造と納品のつながり・仮押さえの期限・お客様の希望と緊急の判断の基準" />
      <AdminNote admin={admin} />
      <form action={saveRulesForm} className="space-y-3">
        <fieldset disabled={!admin} className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
          <label className="flex items-center gap-2 text-xs text-ink-2 @3xl:col-span-3">
            <input type="checkbox" name="productionStartsNextDay" defaultChecked={r.productionStartsNextDay} /> 引き取りの翌日から製造する (外すと引き取りの日から)
          </label>
          <Field label="製造の完成から納品までの日数">
            <Input type="number" min={0} max={14} name="deliveryGapDays" defaultValue={r.deliveryGapDays} />
          </Field>
          <Field label="引き取りから納品までの標準の日数" hint="作業種別に製造日数がないとき">
            <Input type="number" min={0} max={30} name="standardTurnaroundDays" defaultValue={r.standardTurnaroundDays} />
          </Field>
          <Field label="仮押さえの有効な日数">
            <Input type="number" min={1} max={30} name="holdDays" defaultValue={r.holdDays} />
          </Field>
          <Field label="お客様の希望の日から何日以内を「近い」とするか">
            <Input type="number" min={0} max={60} name="preferenceToleranceDays" defaultValue={r.preferenceToleranceDays} />
          </Field>
          <Field label="期限まで何日以内を「緊急」とするか">
            <Input type="number" min={0} max={30} name="urgentWithinDays" defaultValue={r.urgentWithinDays} />
          </Field>
        </fieldset>
        {admin && <Button type="submit">計画の基準を保存する</Button>}
      </form>
    </Card>
  );
}

/* ---------------- 最適化の重み ---------------- */

export async function WeightsTab() {
  const user = await requireUser();
  const m = loadMasters(getDb());
  const admin = canManageScheduling(user);
  const w = m.weights;
  return (
    <Card>
      <CardHeader title="最適化の重み" description="候補の点数で何を重視するか (0〜100)。減点の項目は、その分だけ点数を下げます。「提案の検証」で過去の予定と比べた重みを適用することもできます" />
      <AdminNote admin={admin} />
      {w.tunedAt && (
        <p className="mb-2 text-xs text-ink-3">
          検証から適用: {w.tunedAt.slice(0, 10)} ({w.tunedBy}){w.tuneNote ? `・${w.tuneNote}` : ""}
        </p>
      )}
      <form action={saveWeightsForm} className="space-y-3">
        <fieldset disabled={!admin} className="space-y-3">
          <Field label="最も重視する指標" hint="検証の重みの調整の目的にも使います">
            <Select name="focus" defaultValue={w.focus}>
              <option value="balanced">バランス (当時の判断との一致・移動・早さ)</option>
              <option value="travel">移動の少なさ</option>
              <option value="speed">早さ (お客様を待たせない)</option>
              <option value="deadline">期限を守る</option>
              <option value="revenue">売上・粗利 (早く・多く回る)</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
            {(Object.keys(WEIGHT_LABEL) as (keyof Weights)[]).map((k) => (
              <Field key={k} label={WEIGHT_LABEL[k]}>
                <Input type="number" min={0} max={100} step="0.5" name={k} defaultValue={Math.round(w[k] * 1000) / 10} />
              </Field>
            ))}
          </div>
        </fieldset>
        {admin && <Button type="submit">重みを保存する</Button>}
      </form>
    </Card>
  );
}

