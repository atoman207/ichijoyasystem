"use client";

import { useState } from "react";
import type { OrderHandover } from "@/lib/db/types";
import { handoverGroups } from "@/lib/handover";
import { convertQuoteToOrder } from "@/lib/actions/quotes";
import { HandoverEditor } from "./HandoverEditor";
import type { QuoteOrderPlan } from "./quick-types";

/**
 * 見積を受注にする (品目ごとの引取日・納品日 (施工日) を同じ画面で。お客様のご要望 2026-11-25「③④」・2026-11-26「③ 受注登録時の日程設定」)。
 * 予定表の小さな画面 (CaseWork) と見積の画面 (#to-order) で共通。材料は src/lib/quote-order-plan.ts の quoteOrderPlan。
 * - 日程の案は 手書きの日時 → 同じ案件の登録済みの引き取り・納品の予定 (引き継ぐ) → 訪問の日。引取日・納品日はそれぞれ「未定」にもできる
 * - 同じ案件の登録済みの予定 (訪問・引き取り・納品) をどう使うかを出す。既定は使い回す (二重にしない)。
 *   「登録済みの予定はそのまま残して新しく追加する」を選ぶと existingEvents = add (src/lib/db/handover-events.ts の noAdopt)
 */

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * 受注にしたとき予定表がどうなるか (お客様のご要望 2026-11-25): 作業 (引取・1 日の施工) が訪問 (見積・現調・現見) と同じ日なら、その訪問の予定を
 * 「現見」に切り替える (新しい予定は足さない)。別の日なら訪問の予定は残して、作業の予定を足す。サーバーの判定は src/lib/visit-adopt.ts
 */
export function VisitNote({ rows, visits }: { rows: OrderHandover[]; visits: { date: string; label: string; time: string }[] }) {
  const work = handoverGroups(rows).filter((g) => g.role === "pickup" || (g.role === "install" && !g.endDate));
  if (!visits.length || !work.length) return null;
  const switched = visits.filter((v) => work.some((g) => g.date === v.date));
  const kept = visits.filter((v) => !switched.includes(v));
  const added = work.filter((g) => !visits.some((v) => v.date === g.date));
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-accent/30 bg-accent-soft/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-ink" data-testid="visit-note">
      {switched.map((v) => (
        <p key={`s${v.date}`}>
          <span className="font-semibold text-accent-ink">{md(v.date)} の{v.label}{v.time ? ` (${v.time})` : ""}の予定を「現見」に切り替えます</span> (同じ日に作業するため、新しい予定は足しません)。
        </p>
      ))}
      {kept.length > 0 && added.length > 0 && (
        <p>
          {kept.map((v) => `${md(v.date)} の${v.label}`).join("・")}の予定はそのまま残し、{added.map((g) => md(g.date)).join("・")} の作業の予定を追加します (見積のみの訪問で、作業は別の日)。
        </p>
      )}
      {!switched.length && <p className="text-ink-2">訪問の日にその場で作業する (現見になった) ときは、引取日 (施工日) を訪問の日 ({visits.map((v) => md(v.date)).join("・")}) にしてください。訪問の予定がそのまま「現見」に切り替わります。</p>}
    </div>
  );
}

/** 同じ案件の登録済みの引き取り・納品の予定をどう使うか (既定 = この受注の予定として使い回す) */
function ExistingNote({ rows, existing, addNew }: { rows: OrderHandover[]; existing: QuoteOrderPlan["existing"]; addNew: boolean }) {
  if (!existing.length) return null;
  const groups = handoverGroups(rows);
  const roleCount = { pickup: groups.filter((g) => g.role === "pickup").length, delivery: groups.filter((g) => g.role === "delivery").length };
  const used = { pickup: 0, delivery: 0 };
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-warn/40 bg-warn-soft/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-ink" data-testid="existing-note">
      <p className="font-semibold text-warn-ink">この案件には予定表に登録済みの予定があります</p>
      <ul className="space-y-0.5">
        {existing.map((e) => {
          const reuse = !addNew && used[e.kind] < roleCount[e.kind];
          if (reuse) used[e.kind] += 1;
          return (
            <li key={e.id}>
              ・{md(e.date)} {e.label}
              {e.time ? ` (${e.time})` : ""} →{" "}
              {reuse ? <span className="font-medium text-accent-ink">この受注の{e.label}の予定として使います (上の日程に合わせて日時を変えます。二重にしません)</span> : <span className="text-ink-2">そのまま残します</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function QuoteToOrderForm({ plan, returnTo, submitLabel }: { plan: QuoteOrderPlan; returnTo?: string; submitLabel?: string }) {
  const [addNew, setAddNew] = useState(false);
  return (
    <HandoverEditor
      action={convertQuoteToOrder.bind(null, plan.quoteId)}
      initial={plan.initial}
      saved={[]}
      suggested
      own={plan.own}
      workerIds={plan.workerIds}
      siteAddress={plan.siteAddress}
      users={plan.users}
      stores={plan.stores}
      storeId={plan.storeId}
      currentUserId={plan.currentUserId}
      submitLabel={submitLabel ?? (plan.own ? "受注を登録して予定表に載せる" : "受注を登録 (承認を申請) して予定表に載せる")}
      hidden={{ ...(returnTo ? { returnTo } : {}), onsite: plan.onsite ? "1" : "0", existingEvents: addNew ? "add" : "reuse" }}
      planNote={(rows) => (
        <>
          <VisitNote rows={rows} visits={addNew ? [] : plan.visits} />
          <ExistingNote rows={rows} existing={plan.existing} addNew={addNew} />
        </>
      )}
      extra={
        <div className="space-y-1.5">
          <p className="rounded-lg bg-info-soft px-3 py-2 text-[11px] leading-relaxed text-info-ink">
            見積 {plan.quoteNumber} ({yen(plan.total)}) を受注にします。{plan.approvalNote}
            {plan.sourceText ? ` 手書きの見積書の日時 (${plan.sourceText}) から日程の案を入れています。` : ""}
            {plan.inheritedText ? ` ${plan.inheritedText}の日程を引き継いでいます。` : ""}
            {!plan.sourceText && !plan.inheritedText ? " 引取日・納品日 (施工日) を品目ごとに入れてください。決まっていない日は「未定」にできます。" : " 必要なら変えてください (決まっていない日は「未定」)。"}
            畳は引取の当日納品、襖・障子・網戸は別の日、同じ品目を 2 日に分けるときは「分けて納品」。
          </p>
          {(plan.existing.length > 0 || plan.visits.length > 0) && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-ink">
              <input type="checkbox" checked={addNew} onChange={(e) => setAddNew(e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" data-testid="existing-add-new" />
              <span>
                登録済みの予定はそのまま残して、受注の予定を新しく追加する
                <span className="block text-ink-3">(別の工事の予定など、使い回さない理由があるときだけ。通常は印を付けずに登録すると、登録済みの予定がこの受注の予定に変わり、二重になりません)</span>
              </span>
            </label>
          )}
          <label className="block">
            <span className="label">メモ (任意)</span>
            <input name="note" maxLength={300} placeholder="例: 現場でご注文いただきました" className="field" />
          </label>
        </div>
      }
    />
  );
}
