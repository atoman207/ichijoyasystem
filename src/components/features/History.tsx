import type { ReactNode } from "react";
import type { Approval, AuditLog, Database, User } from "@/lib/db/types";
import { canApprove, canCancelApproval, canViewAuditEntry } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_DECISION_HELP, APPROVAL_STATUS, APPROVAL_TYPE_LABEL, AUDIT_ACTION_LABEL } from "@/lib/constants";
import { fieldLabel, fieldValue } from "@/lib/field-labels";
import { handoverChangeLines } from "@/lib/handover";
import { cancelApproval, decideApproval } from "@/lib/actions/approvals";
import { Badge, Button, Card, CardHeader, Field, Input, StatusBadge } from "@/components/ui";

/**
 * 記録の履歴の部品 (④ 操作・変更履歴 / ③ 承認ワークフロー)
 * - RecordStamp: 登録者・最終変更者・承認者 (監査ログと記録の項目から)
 * - HistoryCard: 変更履歴 (変更前 → 変更後の値つき。閲覧できる範囲のみ)
 * - ApprovalHistoryCard: 承認・差戻し・却下・取下げの履歴 (コメント・変更の内容つき)
 * - ApprovalDecision: 承認 / 差戻し / 却下 のフォーム (承認者のみ。申請者には取下げ)
 */

type Target = { entity: string; id: string };

function logsFor(db: Database, targets: Target[]): AuditLog[] {
  const keys = new Set(targets.map((t) => `${t.entity}:${t.id}`));
  return db.auditLogs.filter((l) => keys.has(`${l.entity}:${l.entityId}`));
}

/** 登録者・最終変更者・承認者 */
export function RecordStamp({ db, targets, created, approved }: { db: Database; targets: Target[]; created?: { by?: string; at?: string }; approved?: { by?: string; at?: string }[] }) {
  const logs = logsFor(db, targets);
  const first = logs.find((l) => l.action === "create");
  const changes = logs.filter((l) => l.action === "update" || l.action === "status" || l.action === "submit" || l.action === "send");
  const last = changes[changes.length - 1];
  const approvals = [
    ...(approved ?? []).filter((a) => a.by),
    ...logs.filter((l) => l.action === "approve").map((l) => ({ by: l.userId, at: l.at })),
  ];
  const seen = new Set<string>();
  const uniq = approvals.filter((a) => {
    const k = `${a.by}|${a.at?.slice(0, 16)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const by = created?.by ?? first?.userId;
  const at = created?.at ?? first?.at;
  const rows: [string, ReactNode][] = [
    ["登録", by ? `${userName(by)}${at ? ` · ${fmtDateTime(at)}` : ""}` : "記録なし (移行データ)"],
    ["最終変更", last ? `${userName(last.userId)} · ${fmtDateTime(last.at)}` : "-"],
    ["承認", uniq.length ? uniq.map((a) => `${userName(a.by)}${a.at ? ` (${fmtDateTime(a.at)})` : ""}`).join("、") : "-"],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-line bg-subtle/50 px-3 py-2 text-xs @xl:grid-cols-3">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] text-ink-3">{k}</dt>
          <dd className="truncate text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 変更履歴 (変更前 → 変更後)。閲覧できない履歴 (ほかの社員のログインなど) は出さない */
export function HistoryCard({ db, user, targets, title = "変更履歴", description, limit = 60 }: { db: Database; user: User; targets: Target[]; title?: string; description?: string; limit?: number }) {
  const names = new Map<string, string>([...db.users.map((u) => [u.id, u.name] as [string, string]), ...db.suppliers.map((s) => [s.id, s.name] as [string, string])]);
  const all = logsFor(db, targets).filter((l) => canViewAuditEntry(user, l));
  // 閲覧の記録 (自店舗・ほかの店舗。1 人・1 件・1 日に 1 回) は変更の記録と分けて出す
  const logs = all.filter((l) => l.action !== "view");
  const views = all.filter((l) => l.action === "view").reverse();
  const shown = logs.slice(-limit).reverse();
  return (
    <Card>
      <CardHeader title={title} description={description ?? "登録・変更・承認・送付の記録 (変更した項目は変更前と変更後の値を残しています) と、閲覧の記録"} />
      {shown.length === 0 ? (
        <p className="text-xs text-ink-3">記録はありません (移行データ)</p>
      ) : (
        <ul className="max-h-96 space-y-2 overflow-y-auto text-xs">
          {shown.map((l) => (
            <li key={l.id} className="border-b border-line pb-1.5 last:border-0">
              <div className="flex flex-wrap items-center gap-1.5 text-ink-3">
                <span className="tnum">{fmtDateTime(l.at)}</span>
                <Badge tone={l.action === "approve" ? "good" : l.action === "reject" || l.action === "delete" ? "critical" : l.action === "submit" ? "warn" : "neutral"} dot={false}>{AUDIT_ACTION_LABEL[l.action]}</Badge>
                <span className="text-ink-2">{userName(l.userId)}</span>
              </div>
              <div className="text-ink">{l.summary}</div>
              {l.changes && l.changes.length > 0 && (
                <table className="mt-1 w-full table-fixed text-[11px]">
                  <tbody>
                    {l.changes.map((c, i) =>
                      c.field === "handovers" ? (
                        <tr key={i} className="align-top">
                          <td className="w-24 py-0.5 pr-2 text-ink-3">{fieldLabel(l.entity, c.field)}</td>
                          <td colSpan={2} className="py-0.5 text-ink">{handoverChangeLines(c.before, c.after).join(" / ") || "(日程の変更なし)"}</td>
                        </tr>
                      ) : (
                        <tr key={i} className="align-top">
                          <td className="w-24 py-0.5 pr-2 text-ink-3">{fieldLabel(l.entity, c.field)}</td>
                          <td className="py-0.5 pr-2 text-ink-3 line-through">{fieldValue(c.field, c.before, names)}</td>
                          <td className="py-0.5 text-ink">{fieldValue(c.field, c.after, names)}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}
      {views.length > 0 && (
        <details className="mt-3 border-t border-line pt-2 text-xs">
          <summary className="cursor-pointer text-ink-2">閲覧の記録 {views.length} 件 (1 人・1 日に 1 回)</summary>
          <ul className="mt-1.5 max-h-60 space-y-1 overflow-y-auto">
            {views.slice(0, 100).map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-2 text-ink-3">
                <span className="tnum">{fmtDateTime(l.at)}</span>
                <span className="text-ink-2">{userName(l.userId)}</span>
                <span>{l.summary}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** 承認の履歴 (申請・判断・コメント・変更の内容) */
export function ApprovalHistoryCard({ approvals, title = "承認履歴" }: { approvals: Approval[]; title?: string }) {
  const rows = [...approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Card>
      <CardHeader title={title} description={rows.length ? `${rows.length} 件 (差戻し ${rows.filter((a) => a.status === "returned").length} 回)` : undefined} />
      <ul className="space-y-2 text-xs">
        {rows.map((a) => (
          <li key={a.id} className="rounded-lg border border-line p-2">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="font-medium text-ink">{APPROVAL_TYPE_LABEL[a.type]}</span>
              <span className="flex items-center gap-1">
                <Badge tone={a.requiredRole === "admin" ? "serious" : "warn"} dot={false}>{a.requiredRole === "admin" ? "管理者" : "店長"}</Badge>
                <StatusBadge value={a.status} map={APPROVAL_STATUS} />
              </span>
            </div>
            <div className="mt-1 text-ink-3">申請 {userName(a.requestedBy)} · {fmtDateTime(a.createdAt)}{a.amount ? ` · ${yen(a.amount)}` : ""}</div>
            {a.requestComment && <div className="mt-0.5 text-ink-2">申請: {a.requestComment}</div>}
            {a.changes && a.changes.length > 0 && <ChangeList entity={a.type === "customer_change" ? "customer" : "order"} changes={a.changes} />}
            {a.decidedBy && (
              <div className="mt-0.5 text-ink-2">
                {APPROVAL_STATUS[a.status].label}: {userName(a.decidedBy)} · {fmtDateTime(a.decidedAt)}
                {a.decisionComment ? ` · 「${a.decisionComment}」` : ""}
              </div>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="text-ink-3">まだ申請されていません</li>}
      </ul>
    </Card>
  );
}

export function ChangeList({ entity, changes }: { entity: string; changes: { field: string; before: unknown; after: unknown }[] }) {
  // 受注の引取・納品の日程は、品目ごと・引き取り/納品ごとの「前 → 後」で出す (src/lib/handover.ts)
  const hv = changes.find((c) => c.field === "handovers");
  if (hv) {
    const lines = handoverChangeLines(hv.before, hv.after);
    const rest = changes.filter((c) => c !== hv);
    return (
      <div className="mt-1 text-[11px]">
        <ul className="list-disc space-y-0.5 pl-4 text-ink" data-testid="handover-change-lines">
          {(lines.length ? lines : ["(日程の変更なし)"]).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        {rest.length > 0 && <ChangeList entity={entity} changes={rest} />}
      </div>
    );
  }
  return (
    <table className="mt-1 w-full table-fixed text-[11px]">
      <tbody>
        {changes.map((c, i) => (
          <tr key={i} className="align-top">
            <td className="w-24 py-0.5 pr-2 text-ink-3">{fieldLabel(entity, c.field)}</td>
            <td className="py-0.5 pr-2 text-ink-3 line-through">{fieldValue(c.field, c.before)}</td>
            <td className="py-0.5 font-medium text-ink">{fieldValue(c.field, c.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 承認の判断 (承認 / 差戻し / 却下)。承認者でないときは待ちの表示、申請者・管理者には取下げ
 * labels: 対象に合わせた承認ボタンの文言 (例: 契約を承認する)
 */
export function ApprovalDecision({ approval, user, returnTo, approveLabel = "承認する", waitingText }: { approval: Approval; user: User; returnTo: string; approveLabel?: string; waitingText?: string }) {
  const canDecide = canApprove(user, approval);
  const canCancel = !canDecide && canCancelApproval(user, approval);
  return (
    <div>
      {approval.changes && approval.changes.length > 0 && (
        <div className="mb-3 rounded-lg border border-line bg-panel px-3 py-2">
          <div className="text-xs font-medium text-ink">変更の内容</div>
          <ChangeList entity={approval.type === "customer_change" ? "customer" : "order"} changes={approval.changes} />
        </div>
      )}
      {canDecide ? (
        <form className="space-y-2">
          <input type="hidden" name="returnTo" value={returnTo} />
          <Field label="コメント (差戻し・却下のときは理由を必ず入力)" className="w-full"><Input name="comment" placeholder="例: 領収書を確認しました / 金額の根拠を添えて再申請してください" /></Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" formAction={decideApproval.bind(null, approval.id, "approved")}>{approveLabel}</Button>
            <Button type="submit" variant="secondary" formAction={decideApproval.bind(null, approval.id, "returned")}>差し戻す</Button>
            <Button type="submit" variant="danger" formAction={decideApproval.bind(null, approval.id, "rejected")}>却下する</Button>
          </div>
          <p className="text-[11px] text-ink-3">{APPROVAL_DECISION_HELP.returned} / {APPROVAL_DECISION_HELP.rejected}</p>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-2">{waitingText ?? `${approval.requiredRole === "admin" ? "管理者" : "店長"}の判断を待っています。`}</p>
          {canCancel && (
            <form>
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" size="sm" variant="ghost" formAction={cancelApproval.bind(null, approval.id)}>申請を取り下げる</Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
