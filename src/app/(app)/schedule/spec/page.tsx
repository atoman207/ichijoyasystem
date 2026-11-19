import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { JobSpec } from "@/lib/db/types";
import { canPlanSchedule } from "@/lib/auth/permissions";
import { saveJobSpecForm } from "@/lib/actions/scheduling";
import { loadMasters, RESOURCE_TYPES } from "@/lib/scheduling/masters";
import { describeItems, findSpec, resolveJob, SPEC_SOURCE_LABEL } from "@/lib/scheduling/spec";
import { planTablesReady } from "@/lib/scheduling/tables";
import { Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, Textarea } from "@/components/ui";

export const metadata: Metadata = { title: "作業の内容" };

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 作業の内容 (予定・案件ごと): 作業種別と数量・標準時間・人数・技能・車両・製造日数・引取可能日・期限・お客様の希望 (日・曜日・時間帯・時刻・強さ)・都合の悪い日・優先度
 * 件名・メモから読むのではなく専用の項目として持つ (src/lib/scheduling/spec.ts)
 */
export default async function JobSpecPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const type = (["order", "quote", "inquiry", "event"] as const).find((t) => t === sp.type);
  const id = sp.id ?? "";
  if (!type || !id) notFound();
  const rec =
    type === "order" ? db.orders.find((x) => x.id === id) : type === "quote" ? db.quotes.find((x) => x.id === id) : type === "inquiry" ? db.inquiries.find((x) => x.id === id) : db.schedule.find((x) => x.id === id);
  if (!rec) notFound();
  if (!canPlanSchedule(user, rec.storeId)) redirect(`/schedule?err=${encodeURIComponent("この記録の作業の内容を登録する権限がありません。")}`);
  const m = loadMasters(db);
  const spec: JobSpec | undefined = findSpec(db, type, id);
  const order = type === "order" ? db.orders.find((o) => o.id === id) : type === "event" && "orderId" in rec && rec.orderId ? db.orders.find((o) => o.id === rec.orderId) : undefined;
  const guess = resolveJob(db, m, { eventId: type === "event" ? id : undefined, orderId: order?.id, quoteId: type === "quote" ? id : undefined, inquiryId: type === "inquiry" ? id : undefined, order, text: "title" in rec ? `${rec.title}\n${"memo" in rec ? (rec.memo ?? "") : ""}` : "" });
  const items = spec?.items.length ? spec.items : guess.items.map((i) => ({ workTypeId: i.workType.id, qty: i.qty }));
  const label = "number" in rec ? `${{ order: "受注", quote: "見積", inquiry: "問い合わせ", event: "予定" }[type]} ${rec.number}` : `予定 ${"title" in rec ? rec.title : ""}`;
  const back = type === "event" ? `/schedule/${id}` : `/${type === "order" ? "orders" : type === "quote" ? "quotes" : "inquiries"}/${id}`;
  const here = `/schedule/spec?type=${type}&id=${id}`;
  const rows = [...items, ...Array.from({ length: Math.max(2, 6 - items.length) }, () => undefined)];
  const prefDates = [...(spec?.preferredDates ?? []), "", "", ""].slice(0, 3);
  const avoidDates = [...(spec?.avoidDates ?? []), "", "", ""].slice(0, 3);

  return (
    <div className="@container">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="作業の内容" icon={<ClipboardList />} description={label} back={{ href: back, label: "元の画面" }} />
      {!planTablesReady() && <Note tone="warn">作業の内容の表がまだデータベースにありません (デプロイで作られます)。</Note>}
      {!spec && guess.items.length > 0 && (
        <Note tone="accent">
          いまは {SPEC_SOURCE_LABEL[guess.source]}: {describeItems(guess)}。確かめて保存すると、次の提案から登録した値を使います。
        </Note>
      )}
      <form action={saveJobSpecForm} className="mt-3 grid grid-cols-1 gap-4 @5xl:grid-cols-2">
        <input type="hidden" name="recordType" value={type} />
        <input type="hidden" name="recordId" value={id} />
        <input type="hidden" name="back" value={here} />
        <Card>
          <CardHeader title="作業と数量" description="作業種別 (標準工数・製造の工程) は 予定表 →「仕事量と提案の設定」→「作業種別」" />
          <div className="space-y-2">
            {rows.map((it, i) => (
              <div key={i} className="flex gap-2">
                <Select name={`it.${i}.workTypeId`} defaultValue={it?.workTypeId ?? ""} aria-label={`作業 ${i + 1}`}>
                  <option value="">-</option>
                  {m.workTypes
                    .filter((w) => w.active || w.id === it?.workTypeId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </Select>
                <Input type="number" min={0} step="0.5" name={`it.${i}.qty`} defaultValue={it?.qty ?? ""} className="w-24" aria-label={`数量 ${i + 1}`} />
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label="現場の作業時間 (分)" hint={`空欄 = 標準 (いまの目安 ${guess.minutesOverride ?? "作業種別から"})`}>
              <Input type="number" min={15} max={1440} name="minutes" defaultValue={spec?.minutes ?? ""} />
            </Field>
            <Field label="必要な人数" hint="空欄 = 作業種別・実績から">
              <Input type="number" min={1} max={6} name="staffCount" defaultValue={spec?.staffCount ?? ""} />
            </Field>
            <Field label="製造日数 (日)" hint={`空欄 = 作業種別から (${guess.leadDays} 日)`}>
              <Input type="number" min={0} max={60} name="productionDays" defaultValue={spec?.productionDays ?? ""} />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            <span className="font-medium">追加で必要な技能:</span>
            {m.skills.map((s) => (
              <label key={s.id} className="inline-flex items-center gap-1">
                <input type="checkbox" name="skills" value={s.id} defaultChecked={spec?.skills.includes(s.id)} /> {s.name}
              </label>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            <span className="font-medium">追加で必要な車両・設備:</span>
            {RESOURCE_TYPES.map((t) => (
              <label key={t.type} className="inline-flex items-center gap-1">
                <input type="checkbox" name="resourceKinds" value={t.type} defaultChecked={spec?.resourceKinds.includes(t.type)} /> {t.label}
              </label>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="日程の条件" description="お客様の希望・期限・優先度。「必ず」の希望は、その日 (曜日) 以外を提案しません" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="引き取りができる最初の日">
              <Input type="date" name="pickupFrom" defaultValue={spec?.pickupFrom ?? ""} />
            </Field>
            <Field label="納品・完了の期限">
              <Input type="date" name="deadline" defaultValue={spec?.deadline ?? ""} />
            </Field>
            {prefDates.map((d, i) => (
              <Field key={`p${i}`} label={`お客様の希望の日 ${i + 1}`}>
                <Input type="date" name="preferredDates" defaultValue={d} />
              </Field>
            ))}
            <Field label="希望の時間帯">
              <Select name="preferredSlot" defaultValue={spec?.preferredSlot ?? ""}>
                <option value="">指定なし</option>
                <option value="am">午前</option>
                <option value="pm">午後</option>
                <option value="day">終日</option>
              </Select>
            </Field>
            <Field label="希望の開始時刻">
              <Input type="time" name="preferredTime" defaultValue={spec?.preferredTime ?? ""} />
            </Field>
            <Field label="希望の強さ">
              <Select name="preferenceStrength" defaultValue={spec?.preferenceStrength ?? "none"}>
                <option value="none">なし</option>
                <option value="soft">できれば (近い日も提案)</option>
                <option value="hard">必ず (希望以外は提案しない)</option>
              </Select>
            </Field>
            <Field label="優先度">
              <Select name="priority" defaultValue={spec?.priority ?? "normal"}>
                <option value="urgent">緊急</option>
                <option value="high">高</option>
                <option value="normal">ふつう</option>
                <option value="low">低</option>
              </Select>
            </Field>
            {avoidDates.map((d, i) => (
              <Field key={`a${i}`} label={`都合の悪い日 ${i + 1}`}>
                <Input type="date" name="avoidDates" defaultValue={d} />
              </Field>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            <span className="font-medium">希望の曜日:</span>
            {WEEK.map((w, k) => (
              <label key={w} className="inline-flex items-center gap-1">
                <input type="checkbox" name="preferredWeekdays" value={k} defaultChecked={spec?.preferredWeekdays.includes(k)} /> {w}
              </label>
            ))}
          </div>
          <Field label="メモ (駐車・在宅の時間など)" className="mt-2">
            <Textarea name="note" rows={2} defaultValue={spec?.note ?? ""} />
          </Field>
          {spec && (
            <label className="mt-2 inline-flex items-center gap-1 text-xs text-ink-3">
              <input type="checkbox" name="remove" /> 作業の内容を削除する (件名・明細からの推定に戻す)
            </label>
          )}
        </Card>
        <div className="@5xl:col-span-2">
          <Button type="submit">保存する</Button>
        </div>
      </form>
    </div>
  );
}
