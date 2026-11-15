import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canViewThread } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, relativeTime, toDateKey } from "@/lib/format";
import { TASK_STATUS, THREAD_KIND_LABEL } from "@/lib/constants";
import type { Thread } from "@/lib/db/types";
import { Avatar, Badge, Flash, LinkButton, LinkTabs, PageHeader, StatusBadge, StoreTag } from "@/components/ui";

const openTask = (t: Thread) => Boolean(t.taskStatus && t.taskStatus !== "confirmed");

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const visible = db.threads.filter((t) => canViewThread(user, t));
  const toMe = visible.filter((t) => openTask(t) && (t.assigneeIds ?? []).includes(user.id));
  const byMe = visible.filter((t) => openTask(t) && t.createdBy === user.id);
  const awaitingMe = byMe.filter((t) => t.taskStatus === "reported");
  const overdue = (t: Thread) => openTask(t) && Boolean(t.dueDate && t.dueDate < today);
  const tab = sp.tab ?? (toMe.length ? "tasks" : "open");
  let rows = visible;
  if (tab === "open") rows = rows.filter((t) => t.status === "open");
  else if (tab === "mine") rows = rows.filter((t) => t.participants.includes(user.id) && t.status === "open");
  else if (tab === "tasks") rows = toMe;
  else if (tab === "requested") rows = byMe;
  else if (tab === "alltasks") rows = rows.filter((t) => t.taskStatus);
  else if (tab === "done") rows = rows.filter((t) => t.status === "done");
  rows = [...rows].sort((a, b) => (tab === "tasks" || tab === "requested" ? (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") : 0) || b.updatedAt.localeCompare(a.updatedAt));
  const lastMsg = (id: string) => db.messages.filter((m) => m.threadId === id).sort((a, b) => b.at.localeCompare(a.at))[0];
  const mentionsMe = (id: string) => db.messages.some((m) => m.threadId === id && m.mentions.includes(user.id));

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="社内連絡・業務依頼" actions={<><LinkButton href="/messages/new?kind=request" variant="secondary">+ 業務を依頼</LinkButton><LinkButton href="/messages/new?kind=notice">+ 新しい連絡</LinkButton></>} />
      <LinkTabs
        current={`/messages?tab=${tab}`}
        items={[
          { href: "/messages?tab=tasks", label: "自分への依頼", count: toMe.length },
          { href: "/messages?tab=requested", label: `自分が依頼${awaitingMe.length ? ` (報告あり ${awaitingMe.length})` : ""}`, count: byMe.length },
          { href: "/messages?tab=open", label: "進行中", count: visible.filter((t) => t.status === "open").length },
          { href: "/messages?tab=mine", label: "自分が参加", count: visible.filter((t) => t.participants.includes(user.id) && t.status === "open").length },
          { href: "/messages?tab=alltasks", label: "業務依頼 (すべて)", count: visible.filter((t) => t.taskStatus).length },
          { href: "/messages?tab=done", label: "完了", count: visible.filter((t) => t.status === "done").length },
        ]}
      />
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
        {rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-3">該当する連絡はありません</li>}
        {rows.map((t) => {
          const m = lastMsg(t.id);
          const count = db.messages.filter((x) => x.threadId === t.id).length;
          return (
            <li key={t.id} className="px-4 py-3 hover:bg-subtle/70">
              <Link href={`/messages/${t.id}`} className="block">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={t.kind === "request" ? "warn" : t.kind === "question" ? "info" : t.kind === "report" ? "good" : "neutral"} dot={false}>{THREAD_KIND_LABEL[t.kind]}</Badge>
                  {t.taskStatus && <StatusBadge value={t.taskStatus} map={TASK_STATUS} />}
                  <span className={`text-sm ${t.status === "done" ? "text-ink-3 line-through" : "font-medium text-ink"}`}>{t.title}</span>
                  {mentionsMe(t.id) && t.status === "open" && <Badge tone="accent" dot={false}>@あなた</Badge>}
                  {overdue(t) && <Badge tone="critical" dot={false}>期限超過</Badge>}
                  {t.relatedLabel && <span className="text-[11px] text-ink-3">関連: {t.relatedLabel}</span>}
                </div>
                {t.taskStatus && (
                  <div className="mt-1 text-xs text-ink-2">
                    依頼 {userName(t.createdBy)} → {(t.assigneeIds ?? []).map((a) => userName(a)).join("・")}
                    {t.dueDate && <span className={overdue(t) ? "ml-2 font-medium text-critical" : "ml-2 text-ink-3"}>期限 {fmtDate(t.dueDate)}</span>}
                  </div>
                )}
                {m && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-ink-2">
                    <Avatar name={userName(m.userId)} id={m.userId} size={18} />
                    <span className="truncate">{userName(m.userId)}: {m.body}</span>
                  </div>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-3">
                  {t.storeId && <StoreTag store={storeMap.get(t.storeId)} short />}
                  <span>{count} 件のメッセージ</span>
                  <span>参加: {t.participants.map((p) => userName(p).split(" ")[0]).join("・")}</span>
                  <span>{relativeTime(t.updatedAt)}</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
