import Link from "@/components/ui/Link";
import type { Database, User } from "@/lib/db/types";
import { TASK_STATUS } from "@/lib/constants";
import { CASE_REQUEST_ANCHOR, CASE_REQUEST_KIND, CASE_REQUEST_KINDS, caseRequestsOf } from "@/lib/case-requests";
import { sendCaseRequest } from "@/lib/actions/case-quick";
import { taskStep } from "@/lib/actions/messages";
import { staffForStore } from "@/lib/staff-choices";
import { Badge, Button, Card, CardHeader, StatusBadge } from "@/components/ui";

const fmt = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/**
 * この案件への依頼 (メンション) (お客様のご要望 2026-11-25「⑪」)。送った内容・日時・送信者・送信先・対応の状態を残し、
 * 依頼を受けた人はここで「確認しました」を押せる (報告・日程の登録は依頼の画面で)。下で新しい依頼も送れる
 */
export function CaseRequestsCard({ db, user, ids, caseId, storeId, returnTo }: { db: Database; user: User; ids: (string | undefined)[]; caseId: string; storeId: string; returnTo: string }) {
  const list = caseRequestsOf(db, ids);
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const firstBody = (threadId: string) => db.messages.find((m) => m.threadId === threadId)?.body ?? "";
  const lastReply = (threadId: string, createdBy: string) => db.messages.filter((m) => m.threadId === threadId && m.userId !== createdBy).at(-1);
  const staff = staffForStore(db, storeId as never);
  return (
    <Card id={CASE_REQUEST_ANCHOR}>
      <CardHeader title="この案件への依頼" description="日程変更依頼・仕様変更依頼・クレーム・手直しなど、担当店舗・担当者に送った依頼 (送った内容・日時・送信者・送信先・対応の状態)" />
      {list.length === 0 ? (
        <p className="text-xs text-ink-3">まだ依頼はありません。</p>
      ) : (
        <ol className="space-y-2" data-testid="case-requests">
          {list.slice(0, 30).map((t) => {
            const mine = (t.assigneeIds ?? []).includes(user.id);
            const reply = lastReply(t.id, t.createdBy);
            const body = firstBody(t.id).split("\n").filter((l) => l && !/^(【|案件:|場所:|宛先:|案件を開く:)/.test(l)).join(" ");
            return (
              <li key={t.id} className={`rounded-lg border px-3 py-2 text-xs ${mine && t.taskStatus === "requested" ? "border-accent/50 bg-accent-soft/20" : "border-line"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={t.caseRequest === "claim" ? "critical" : "accent"} dot={false}>
                    {t.caseRequest ? CASE_REQUEST_KIND[t.caseRequest].label : "依頼"}
                  </Badge>
                  {t.taskStatus && <StatusBadge value={t.taskStatus} map={TASK_STATUS} />}
                  <span className="text-ink-3 tnum">{fmt(t.createdAt)}</span>
                  <span className="text-ink-2">
                    {name(t.createdBy)} → {t.assigneeStoreId ? `${storeName(t.assigneeStoreId)} (店舗)` : (t.assigneeIds ?? []).map(name).join("・")}
                  </span>
                  {t.dueDate && <span className="text-ink-3">期限 {t.dueDate.slice(5).replace("-", "/")}</span>}
                </div>
                {body && <p className="mt-1 whitespace-pre-wrap text-ink">{body.slice(0, 300)}</p>}
                {reply && (
                  <p className="mt-1 text-ink-2">
                    <span className="text-ink-3">{name(reply.userId)} ({fmt(reply.at)}): </span>
                    {reply.body.slice(0, 200)}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  {mine && t.taskStatus === "requested" && (
                    <form action={taskStep.bind(null, t.id, "ack")}>
                      <input type="hidden" name="returnTo" value={`${returnTo}#${CASE_REQUEST_ANCHOR}`} />
                      <Button type="submit" size="sm">
                        確認しました (対応します)
                      </Button>
                    </form>
                  )}
                  <Link href={`/messages/${t.id}`} className="text-accent hover:underline">
                    {mine && t.taskStatus !== "confirmed" ? "依頼の画面を開く (日程の登録・報告)" : "依頼の画面を開く"}
                  </Link>
                  {t.eventId && db.schedule.some((e) => e.id === t.eventId) && (
                    <Link href={`/schedule/${t.eventId}`} className="text-accent hover:underline">
                      依頼を送った予定
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <details className="mt-3 border-t border-line pt-2">
        <summary className="cursor-pointer text-sm font-medium text-accent">担当店舗・担当者に依頼を送る</summary>
        <form action={sendCaseRequest} className="mt-2 space-y-2">
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="returnTo" value={`${returnTo}#${CASE_REQUEST_ANCHOR}`} />
          <fieldset>
            <legend className="label">依頼の種類</legend>
            <div className="flex flex-wrap gap-1.5">
              {CASE_REQUEST_KINDS.map((k, i) => (
                <label key={k} className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:font-medium">
                  <input type="radio" name="kind" value={k} required defaultChecked={i === 0} className="h-3.5 w-3.5" />
                  {CASE_REQUEST_KIND[k].label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            <label className="block">
              <span className="label">宛先</span>
              <select name="target" defaultValue="store" className="field">
                <option value="store">店舗の店長・スタッフ全員</option>
                <option value="users">下で選んだ担当者</option>
              </select>
            </label>
            <label className="block">
              <span className="label">店舗</span>
              <select name="storeId" defaultValue={storeId} className="field">
                {db.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.id === storeId ? " (担当店舗)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend className="label">担当者 (宛先を「担当者」にしたとき)</legend>
            <div className="flex flex-wrap gap-1">
              {staff.map((u) => (
                <label key={u.id} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                  <input type="checkbox" name="assigneeIds" value={u.id} className="h-3.5 w-3.5" />
                  {u.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="label">内容 (「その他」は必須)</span>
            <textarea name="note" rows={3} maxLength={2000} className="field" placeholder="例: お客様のご都合で引取を 12/3 の午後に変えたいとのことです" />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label">期限</span>
              <select name="due" defaultValue="none" className="field w-auto">
                <option value="none">期限なし</option>
                <option value="noon">本日12時まで</option>
                <option value="today">本日中</option>
                <option value="tomorrow">明日中</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-xs">
              <input type="checkbox" name="urgent" value="1" className="h-4 w-4" />
              至急
            </label>
            <Button type="submit" size="sm">
              依頼を送る
            </Button>
          </div>
        </form>
      </details>
    </Card>
  );
}
