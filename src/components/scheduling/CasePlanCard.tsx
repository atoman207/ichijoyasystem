import { Suspense } from "react";
import { ClipboardList, Sparkles } from "lucide-react";
import Link from "@/components/ui/Link";
import { getDb } from "@/lib/db/store";
import type { ScheduleKind, User } from "@/lib/db/types";
import { canPlanSchedule } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays } from "@/lib/format";
import { shortDate } from "@/lib/calendar";
import { createCaseResolver } from "@/lib/db/schedule";
import { suggestScheduleDates } from "@/lib/schedule-suggest";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import { createPlanContext, activeHolds } from "@/lib/scheduling/context";
import { evaluateJob, pickDiverse, placeCandidate, type Candidate } from "@/lib/scheduling/engine";
import { buildRequest, STAGE } from "@/lib/scheduling/request";
import { describeItems, findSpec, resolveJob } from "@/lib/scheduling/spec";
import { loadMasters } from "@/lib/scheduling/masters";
import { Card, CardHeader } from "@/components/ui";
import { CandidateView, ChainHoldButton, HoldButton } from "./CandidateView";

/**
 * 案件の画面 (問い合わせ・見積・受注) の「日程の提案」
 * 画面を開いたとき (= 登録した直後も) に、次の段階の予定の候補を自動で出す:
 *  問い合わせ → 現地調査 / 見積 → 採寸 / 受注 → 引き取り → (製造) → 納品 をまとめて、または 施工
 * 候補は仮押さえ (担当者の確認・お客様への案内のあと確定) か、予定の入力へ (日時・担当を入れて開く)
 */

type RecordType = "inquiry" | "quote" | "order";

export function CasePlanCard(props: { recordType: RecordType; recordId: string; user: User }) {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader title="日程の提案" icon={<Sparkles />} description="候補を計算しています…" />
        </Card>
      }
    >
      <CasePlanInner {...props} />
    </Suspense>
  );
}

function newEventHref(recordType: RecordType, recordId: string, kind: ScheduleKind, c?: Candidate) {
  const q = new URLSearchParams({ [`${recordType}Id`]: recordId, kind });
  if (c) {
    q.set("date", c.date);
    if (c.startTime) q.set("start", c.startTime);
    if (c.assigneeIds.length) q.set("user", c.assigneeIds.join(","));
  }
  q.set("returnTo", `/${recordType === "order" ? "orders" : recordType === "quote" ? "quotes" : "inquiries"}/${recordId}`);
  return `/schedule/new?${q.toString()}`;
}

async function CasePlanInner({ recordType, recordId, user }: { recordType: RecordType; recordId: string; user: User }) {
  const db = getDb();
  const ref = createCaseResolver(db).resolve(recordType, recordId);
  if (!ref || !ref.open || !canPlanSchedule(user, ref.storeId)) return null;
  const m = loadMasters(db);
  const order = ref.orderId ? db.orders.find((o) => o.id === ref.orderId) : undefined;
  const events = db.schedule.filter((e) => (ref.orderId && e.orderId === ref.orderId) || (ref.quoteId && e.quoteId === ref.quoteId) || (ref.inquiryId && e.inquiryId === ref.inquiryId));
  const holds = activeHolds(db).filter((h) => (ref.orderId && h.orderId === ref.orderId) || (ref.quoteId && h.quoteId === ref.quoteId) || (ref.inquiryId && h.inquiryId === ref.inquiryId));
  const has = new Set([...events.map((e) => e.kind), ...holds.map((h) => h.kind)]);
  const job = resolveJob(db, m, { orderId: ref.orderId, quoteId: ref.quoteId, inquiryId: ref.inquiryId, order, caseEvents: events });
  const spec = findSpec(db, recordType, recordId);
  const specHref = `/schedule/spec?type=${recordType}&id=${recordId}`;

  // 次の段階
  let steps: ScheduleKind[] = [];
  if (recordType === "inquiry" || ref.type === "inquiry") steps = has.has("survey") || has.has("visit") ? [] : ["survey"];
  else if (ref.type === "quote") steps = has.has("measure") || has.has("survey") ? [] : ["measure"];
  else if (job.production.size) steps = !has.has("pickup") ? ["pickup", "delivery"] : !has.has("delivery") ? ["delivery"] : [];
  else steps = has.has("install") || order?.scheduledStart ? [] : ["install"];
  steps = steps.filter((k) => SUGGEST_KINDS.includes(k));

  const header = (
    <CardHeader
      title="日程の提案"
      icon={<Sparkles />}
      description={steps.length ? `次の段階 (${steps.map((k) => SCHEDULE_KIND[k].label).join(" → ")}) の候補です。店舗の仕事量・担当者の空き・製造・移動から計算しました` : "次の段階の予定 (または仮押さえ) は登録済みです"}
      action={
        <Link href={specHref} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
          <ClipboardList className="h-3.5 w-3.5" aria-hidden />
          作業の内容{spec ? "を変更" : "を登録"}
        </Link>
      }
    />
  );
  const specLine = (
    <p className="mb-3 text-xs text-ink-2">
      作業の内容: {job.items.length ? describeItems(job) : "未登録"}
      {job.deadline ? `・期限 ${shortDate(job.deadline)}` : ""}
      {job.strength !== "none" && job.preferredDates.length ? `・希望 ${job.preferredDates.map(shortDate).join("・")}${job.strength === "hard" ? " (必ず)" : ""}` : ""}
      {job.priority !== "normal" ? `・優先度 ${{ urgent: "緊急", high: "高", low: "低", normal: "" }[job.priority]}` : ""}
      {!spec && <span className="text-ink-3"> (件名・明細からの推定。登録すると精度が上がります)</span>}
    </p>
  );
  if (!steps.length)
    return (
      <Card>
        {header}
        {specLine}
        {holds.length > 0 && (
          <Link href="/schedule/planning?tab=holds" className="text-xs text-accent hover:underline">
            仮押さえ中の候補 ({holds.length} 件) を見る →
          </Link>
        )}
      </Card>
    );

  // 1 段階: 候補 3 件 / 引き取り → 納品: 引き取りの 1 位を置いた後で、製造の完成から納品の候補
  const base = { storeId: ref.storeId, orderId: ref.orderId, quoteId: ref.quoteId, inquiryId: ref.inquiryId, customerId: ref.customerId, location: ref.location };
  if (steps.length === 1) {
    const r = suggestScheduleDates(db, user, { storeId: ref.storeId, kind: steps[0], orderId: ref.orderId, quoteId: ref.quoteId, inquiryId: ref.inquiryId, customerId: ref.customerId, limit: 3 });
    const kind = steps[0];
    return (
      <Card>
        {header}
        {specLine}
        {r.candidates.length ? (
          <ul className="space-y-2">
            {r.candidates.map((c, i) => (
              <li key={`${c.date}-${c.slot}`} className="flex flex-col gap-2 rounded-xl border border-line px-3 py-2 @3xl:flex-row @3xl:items-start @3xl:justify-between">
                <CandidateView c={c} rank={i + 1} compact />
                <Link href={newEventHref(recordType, recordId, kind, c)} className="shrink-0 text-xs text-accent hover:underline">
                  この日時で予定を入力 →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">{r.notes.find((n) => n.startsWith("条件に合う日")) ?? "候補が見つかりませんでした。"}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <HoldButton base={{ ...base, kind, title: `${SCHEDULE_KIND[kind].label} ${ref.customerName ? `${ref.customerName}様` : ref.number}` }} candidates={r.candidates.slice(0, 3)} label="第 1〜3 候補を仮押さえ" />
          <Link href={newEventHref(recordType, recordId, kind)} className="text-xs text-ink-2 hover:text-accent hover:underline">
            日時を自分で決めて入力 →
          </Link>
        </div>
        {r.notes.length > 0 && (
          <details className="mt-2 text-[11px] text-ink-3">
            <summary className="cursor-pointer">計算の前提</summary>
            <ul className="mt-1 space-y-0.5">
              {r.notes.map((n) => (
                <li key={n}>・{n}</li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    );
  }

  const ctx = createPlanContext(db, user, { from: addDays(new Date().toISOString().slice(0, 10), 0), to: addDays(new Date().toISOString().slice(0, 10), 75), masters: m });
  const chain: { kind: ScheduleKind; candidates: Candidate[]; note?: string }[] = [];
  let after: string | undefined;
  for (const kind of steps) {
    const built = buildRequest(ctx, { storeId: ref.storeId, kind, orderId: ref.orderId, quoteId: ref.quoteId, inquiryId: ref.inquiryId, customerId: ref.customerId, from: after }, `chain-${kind}`);
    if ("error" in built) break;
    if (kind === "delivery" && chain[0]?.candidates[0]) built.req.afterPickup = chain[0].candidates[0].date;
    const cands = pickDiverse(evaluateJob(ctx, built.req).candidates, 3);
    chain.push({ kind, candidates: cands });
    const best = cands[0];
    if (!best) break;
    placeCandidate(ctx, built.req, best);
    if (STAGE[kind] === 2 && best.readyDate) after = addDays(best.readyDate, m.rules.deliveryGapDays + 1);
    else after = addDays(best.endDate ?? best.date, 1);
  }
  return (
    <Card>
      {header}
      {specLine}
      <ol className="space-y-3">
        {chain.map((s, i) => (
          <li key={s.kind}>
            <p className="mb-1 text-xs font-semibold text-ink">
              {i + 1}. {SCHEDULE_KIND[s.kind].label}
              {s.kind === "delivery" && chain[0]?.candidates[0]?.readyDate && <span className="ml-1 font-normal text-ink-3">(製造の完成 {shortDate(chain[0].candidates[0].readyDate)} の後)</span>}
            </p>
            {s.candidates.length ? (
              <div className="flex flex-col gap-2 rounded-xl border border-line px-3 py-2 @3xl:flex-row @3xl:items-start @3xl:justify-between">
                <CandidateView c={s.candidates[0]} compact />
                <Link href={newEventHref(recordType, recordId, s.kind, s.candidates[0])} className="shrink-0 text-xs text-accent hover:underline">
                  この日時で予定を入力 →
                </Link>
              </div>
            ) : (
              <p className="text-xs text-ink-3">候補が見つかりませんでした (期間・上限・担当者を見直してください)。</p>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-3">
        <ChainHoldButton chainId={`ch_${recordId}`.slice(0, 40)} steps={chain.map((s) => ({ base: { ...base, kind: s.kind, title: `${SCHEDULE_KIND[s.kind].label} ${ref.customerName ? `${ref.customerName}様` : ref.number}` }, candidates: s.candidates.slice(0, 3) }))} />
        <p className="mt-1 text-[11px] text-ink-3">それぞれ第 1〜3 候補を仮押さえします。担当者の確認・お客様への案内のあと、予定表 →「計画」で確定します。</p>
      </div>
    </Card>
  );
}
