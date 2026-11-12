import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { canViewThread } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { postMessage, setThreadStatus } from "@/lib/actions/messages";
import { fmtDateTime } from "@/lib/format";
import { THREAD_KIND_LABEL } from "@/lib/constants";
import { Avatar, Badge, Button, Card, Field, Flash, PageHeader, StoreTag, Textarea } from "@/components/ui";

function relatedHref(type?: string, id?: string) {
  if (!type || !id) return undefined;
  const map: Record<string, string> = { inquiry: "/inquiries", quote: "/quotes", order: "/orders", invoice: "/invoices", expense: "/expenses", purchase: "/purchases", customer: "/customers" };
  return `${map[type]}/${id}`;
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

  return (
    <div className="max-w-3xl">
      <Flash msg={msg} err={err} />
      <PageHeader
        title={t.title}
        badge={<><Badge dot={false}>{THREAD_KIND_LABEL[t.kind]}</Badge>{t.status === "done" && <Badge tone="good">完了</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{t.storeId && <StoreTag store={db.stores.find((s) => s.id === t.storeId)} />}作成 {userName(t.createdBy)} {fmtDateTime(t.createdAt)} · 参加 {t.participants.map((p) => userName(p)).join("・")}{href && <> · 関連: <Link href={href} className="text-accent hover:underline">{t.relatedLabel ?? t.relatedType}</Link></>}</span>}
        back={{ href: "/messages", label: "社内連絡" }}
        actions={
          <form action={setThreadStatus.bind(null, t.id, t.status === "done" ? "open" : "done")}>
            <Button type="submit" variant="secondary" size="sm">{t.status === "done" ? "再開する" : "完了にする"}</Button>
          </form>
        }
      />
      <div className="space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex gap-3 ${m.userId === user.id ? "flex-row-reverse" : ""}`}>
            <Avatar name={userName(m.userId)} id={m.userId} size={32} />
            <div className={`max-w-[80%] rounded-xl border px-4 py-2.5 ${m.userId === user.id ? "border-accent/20 bg-accent-soft" : "border-line bg-panel"}`}>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-3"><span className="font-medium text-ink-2">{userName(m.userId)}</span><span className="tnum">{fmtDateTime(m.at)}</span></div>
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
