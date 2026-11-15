import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { canViewThread } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { postMessage, setThreadStatus, taskStep } from "@/lib/actions/messages";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { TASK_STATUS, THREAD_KIND_LABEL } from "@/lib/constants";
import type { MessageEvent } from "@/lib/db/types";
import { Avatar, Badge, Button, Card, CardHeader, Field, Flash, PageHeader, StatusBadge, StoreTag, Textarea } from "@/components/ui";

const EVENT_LABEL: Record<MessageEvent, { label: string; tone: "info" | "accent" | "good" | "serious" }> = {
  ack: { label: "確認しました", tone: "info" },
  report: { label: "報告", tone: "accent" },
  confirm: { label: "完了 (報告を確認)", tone: "good" },
  reopen: { label: "差し戻し", tone: "serious" },
};

function relatedHref(type?: string, id?: string) {
  if (!type || !id) return undefined;
  const map: Record<string, string> = { inquiry: "/inquiries", quote: "/quotes", order: "/orders", invoice: "/invoices", expense: "/expenses", purchase: "/purchases", customer: "/customers", supplier: "/suppliers" };
  return map[type] ? `${map[type]}/${id}` : undefined;
}

export default async function ThreadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const t = db.threads.find((x) => x.id === id);
  if (!t) notFound();
  if (!canViewThread(user, t)) redirect("/messages?err=" + encodeURIComponent("このスレッドを閲覧する権限がありません。"));
  const messages = db.messages.filter((m) => m.threadId === id).sort((a, b) => a.at.localeCompare(b.at));
  const users = db.users.filter((u) => u.active && u.id !== user.id);
  const href = relatedHref(t.relatedType, t.relatedId);
  const isTask = Boolean(t.taskStatus);
  const isAssignee = (t.assigneeIds ?? []).includes(user.id);
  const isRequester = t.createdBy === user.id || user.role === "admin";
  const overdue = isTask && t.taskStatus !== "confirmed" && t.dueDate && t.dueDate < toDateKey(new Date());

  return (
    <div className="max-w-3xl">
      <Flash msg={msg} err={err} />
      <PageHeader
        title={t.title}
        badge={<><Badge dot={false}>{THREAD_KIND_LABEL[t.kind]}</Badge>{t.taskStatus ? <StatusBadge value={t.taskStatus} map={TASK_STATUS} /> : t.status === "done" && <Badge tone="good">完了</Badge>}{overdue && <Badge tone="critical" dot={false}>期限超過</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{t.storeId && <StoreTag store={db.stores.find((s) => s.id === t.storeId)} />}作成 {userName(t.createdBy)} {fmtDateTime(t.createdAt)} · 参加 {t.participants.map((p) => userName(p)).join("・")}{href && <> · 関連: <Link href={href} className="text-accent hover:underline">{t.relatedLabel ?? t.relatedType}</Link></>}</span>}
        back={{ href: "/messages", label: "社内連絡" }}
        actions={
          !isTask ? (
            <form action={setThreadStatus.bind(null, t.id, t.status === "done" ? "open" : "done")}>
              <Button type="submit" variant="secondary" size="sm">{t.status === "done" ? "再開する" : "完了にする"}</Button>
            </form>
          ) : undefined
        }
      />

      {isTask && (
        <Card className="mb-4 border-accent/30">
          <CardHeader title="業務依頼" description={`依頼 ${userName(t.createdBy)} → 依頼先 ${(t.assigneeIds ?? []).map((a) => userName(a)).join("・")}${t.dueDate ? ` · 期限 ${fmtDate(t.dueDate)}` : ""}`} />
          <ol className="mb-3 flex flex-wrap gap-1 text-xs">
            {(["requested", "acknowledged", "reported", "confirmed"] as const).map((s, i) => {
              const order = ["requested", "acknowledged", "reported", "confirmed"].indexOf(t.taskStatus!);
              return (
                <li key={s} className={`rounded-full px-2.5 py-1 ${i < order ? "bg-good-soft text-good-ink" : i === order ? "bg-ink text-white" : "bg-subtle text-ink-3"}`}>
                  {i + 1}. {["依頼", "確認・対応中", "報告", "完了"][i]}
                </li>
              );
            })}
          </ol>
          <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-ink-2 @xl:grid-cols-4">
            <div><div className="text-ink-3">依頼</div>{fmtDateTime(t.createdAt)}</div>
            <div><div className="text-ink-3">確認</div>{t.acknowledgedAt ? fmtDateTime(t.acknowledgedAt) : "-"}</div>
            <div><div className="text-ink-3">報告</div>{t.reportedAt ? fmtDateTime(t.reportedAt) : "-"}</div>
            <div><div className="text-ink-3">完了</div>{t.confirmedAt ? `${fmtDateTime(t.confirmedAt)} (${userName(t.confirmedBy)})` : "-"}</div>
          </div>
          {isAssignee && (t.taskStatus === "requested" || t.taskStatus === "acknowledged") && (
            <div className="space-y-3 border-t border-line pt-3">
              {t.taskStatus === "requested" && (
                <form action={taskStep.bind(null, t.id, "ack")}>
                  <Button type="submit" variant="secondary" size="sm">依頼を確認しました (対応します)</Button>
                </form>
              )}
              <form action={taskStep.bind(null, t.id, "report")} className="space-y-2">
                <Field label="対応の報告" required><Textarea name="body" required rows={3} placeholder="例: 現地調査に同行し、採寸結果を見積に入力しました" /></Field>
                <Button type="submit" size="sm">報告する</Button>
              </form>
            </div>
          )}
          {isRequester && t.taskStatus === "reported" && (
            <div className="space-y-2 border-t border-line pt-3">
              <form action={taskStep.bind(null, t.id, "confirm")} className="flex flex-wrap items-end gap-2">
                <Field label="ひとこと (任意)" className="flex-1"><Textarea name="body" rows={1} placeholder="例: ありがとうございました" /></Field>
                <Button type="submit" size="sm">報告を確認して完了にする</Button>
              </form>
              <form action={taskStep.bind(null, t.id, "reopen")} className="flex flex-wrap items-end gap-2">
                <Field label="差し戻す理由" className="flex-1"><Textarea name="body" rows={1} required placeholder="例: 写真も添付してください" /></Field>
                <Button type="submit" size="sm" variant="secondary">差し戻す</Button>
              </form>
            </div>
          )}
          {!isAssignee && !isRequester && t.taskStatus !== "confirmed" && <p className="text-xs text-ink-3">依頼先・依頼した人が操作します。</p>}
        </Card>
      )}

      <div className="space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex gap-3 ${m.userId === user.id ? "flex-row-reverse" : ""}`}>
            <Avatar name={userName(m.userId)} id={m.userId} size={32} />
            <div className={`max-w-[80%] rounded-xl border px-4 py-2.5 ${m.userId === user.id ? "border-accent/20 bg-accent-soft" : "border-line bg-panel"}`}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                <span className="font-medium text-ink-2">{userName(m.userId)}</span>
                <span className="tnum">{fmtDateTime(m.at)}</span>
                {m.event && <Badge tone={EVENT_LABEL[m.event].tone} dot={false}>{EVENT_LABEL[m.event].label}</Badge>}
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink">{m.body}</p>
              {m.mentions.length > 0 && <div className="mt-1 text-[11px] text-accent">@{m.mentions.map((x) => userName(x)).join(" @")}</div>}
            </div>
          </div>
        ))}
      </div>
      <Card className="mt-6">
        <form action={postMessage.bind(null, t.id)} className="space-y-3">
          <Field label="返信"><Textarea name="body" required placeholder="返信を入力" /></Field>
          <Field label="メンション (任意・複数選択可)">
            <select name="mentions" multiple className="field h-28">
              {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.title})</option>)}
            </select>
          </Field>
          <Button type="submit">投稿する</Button>
        </form>
      </Card>
    </div>
  );
}
