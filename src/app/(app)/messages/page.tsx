import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canViewThread } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { relativeTime } from "@/lib/format";
import { THREAD_KIND_LABEL } from "@/lib/constants";
import { Avatar, Badge, Flash, LinkButton, LinkTabs, PageHeader, StoreTag } from "@/components/ui";

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const visible = db.threads.filter((t) => canViewThread(user, t));
  const tab = sp.tab ?? "open";
  let rows = visible;
  if (tab === "open") rows = rows.filter((t) => t.status === "open");
  else if (tab === "mine") rows = rows.filter((t) => t.participants.includes(user.id) && t.status === "open");
  else if (tab === "done") rows = rows.filter((t) => t.status === "done");
  rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const lastMsg = (id: string) => db.messages.filter((m) => m.threadId === id).sort((a, b) => b.at.localeCompare(a.at))[0];
  const mentionsMe = (id: string) => db.messages.some((m) => m.threadId === id && m.mentions.includes(user.id));

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="社内連絡" actions={<LinkButton href="/messages/new">+ 新しい連絡</LinkButton>} />
      <LinkTabs
        current={`/messages?tab=${tab}`}
        items={[
          { href: "/messages?tab=open", label: "進行中", count: visible.filter((t) => t.status === "open").length },
          { href: "/messages?tab=mine", label: "自分が参加", count: visible.filter((t) => t.participants.includes(user.id) && t.status === "open").length },
          { href: "/messages?tab=done", label: "完了", count: visible.filter((t) => t.status === "done").length },
          { href: "/messages?tab=all", label: "すべて", count: visible.length },
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
                  <span className={`text-sm ${t.status === "done" ? "text-ink-3 line-through" : "font-medium text-ink"}`}>{t.title}</span>
                  {mentionsMe(t.id) && t.status === "open" && <Badge tone="accent" dot={false}>@あなた</Badge>}
                  {t.relatedLabel && <span className="text-[11px] text-ink-3">関連: {t.relatedLabel}</span>}
                </div>
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
