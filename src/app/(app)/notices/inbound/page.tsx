import type { Metadata } from "next";
import { Mail, MessageCircle, MessagesSquare, Hash } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageIntegrations, canSeeAllStores } from "@/lib/auth/permissions";
import { INBOUND_CHANNELS, INBOUND_CHANNEL_LABEL, inboundForUser, type InboundChannel, type InboundItem } from "@/lib/inbound/feed";
import { Badge, Button, Card, EmptyState, Flash, LinkButton, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "届いたメッセージ" };
export const dynamic = "force-dynamic";

const ICON: Record<InboundChannel, typeof Mail> = { line: MessageCircle, email: Mail, slack: Hash, chatwork: MessagesSquare };
const TONE: Record<InboundChannel, string> = { line: "bg-[#06c755]/12 text-[#047a35]", email: "bg-info-soft text-info-ink", slack: "bg-[#4a154b]/10 text-[#4a154b]", chatwork: "bg-critical-soft text-critical-ink" };

const time = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short" });

/**
 * 外部から届いたメッセージ (LINE・メール・Slack・Chatwork) の一覧 (お客様のご要望 2026-11-26。src/lib/inbound/feed.ts)。
 * 見られるのは届いた店舗の社員と本部・管理者 (permissions.ts の canSeeInboundMessage)。この画面を開くとベルの数字が消える (notify-seen.ts の in)
 */
export default async function InboundPage({ searchParams }: { searchParams: Promise<{ channel?: string; q?: string; store?: string; bulk?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const channel = INBOUND_CHANNELS.includes(sp.channel as InboundChannel) ? (sp.channel as InboundChannel) : undefined;
  const q = (sp.q ?? "").trim();
  const bulk = sp.bulk === "1";
  const all = inboundForUser(db, user, { includeBulk: true });
  const bulkCount = all.filter((i) => i.bulk && (!channel || i.channel === channel)).length;
  let list = all.filter((i) => (bulk || !i.bulk) && (!channel || i.channel === channel));
  if (sp.store) list = list.filter((i) => i.storeId === sp.store);
  if (q) list = list.filter((i) => [i.from, i.fromDetail, i.subject, i.text, i.ref].join(" ").includes(q));
  list = list.slice(0, 300);
  const countOf = (c?: InboundChannel) => all.filter((i) => !i.bulk && (!c || i.channel === c)).length;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { channel, q: q || undefined, store: sp.store, bulk: bulk ? "1" : undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return `/notices/inbound${s ? `?${s}` : ""}`;
  };
  const byDay = new Map<string, InboundItem[]>();
  for (const i of list) byDay.set(day(i.at), [...(byDay.get(day(i.at)) ?? []), i]);
  const storeName = (id: string) => (id === "hq" ? "本部・管理者" : (db.stores.find((s) => s.id === id)?.name ?? id));
  const tabs: { id?: InboundChannel; label: string }[] = [{ label: "すべて" }, ...INBOUND_CHANNELS.map((c) => ({ id: c, label: INBOUND_CHANNEL_LABEL[c] }))];

  return (
    <div className="max-w-5xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="届いたメッセージ"
        description="LINE・メール・Slack・Chatwork で届いたメッセージです (30 日分)。お客様・案件・取引先にひも付いたものは「開く」でその画面へ。届いた店舗の社員と本部・管理者に、右上のベルとトーストで知らせます"
        actions={
          <span className="flex flex-wrap gap-2">
            <LinkButton href="/notices" size="sm" variant="secondary">変更のお知らせ</LinkButton>
            {canManageIntegrations(user) && <LinkButton href="/settings?tab=integrations#inbound" size="sm" variant="secondary">受信の設定</LinkButton>}
          </span>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-xl border border-line bg-subtle/70 p-1" role="tablist">
          {tabs.map((t) => (
            <Link key={t.label} href={qs({ channel: t.id })} role="tab" aria-selected={channel === t.id} className={`rounded-lg px-3 py-1.5 text-sm ${channel === t.id ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink"}`}>
              {t.label} ({countOf(t.id)})
            </Link>
          ))}
        </div>
        <form action="/notices/inbound" className="flex flex-wrap items-center gap-2">
          {channel && <input type="hidden" name="channel" value={channel} />}
          {bulk && <input type="hidden" name="bulk" value="1" />}
          {canSeeAllStores(user) && (
            <select name="store" defaultValue={sp.store ?? ""} className="field w-auto" aria-label="店舗">
              <option value="">全店舗</option>
              {db.stores.map((s) => (
                <option key={s.id} value={s.id}>{s.kind === "hq" ? "本部・管理者 (お店の決まらないもの)" : s.name}</option>
              ))}
            </select>
          )}
          <input name="q" defaultValue={q} placeholder="送り主・件名・内容で絞り込み" className="field w-56" />
          <Button type="submit" size="sm" variant="secondary">絞り込む</Button>
        </form>
        {bulkCount > 0 && (
          <Link href={qs({ bulk: bulk ? undefined : "1" })} className="text-xs text-accent hover:underline">
            {bulk ? "自動送信・メールマガジンを隠す" : `自動送信・メールマガジンも表示 (${bulkCount})`}
          </Link>
        )}
      </div>
      {list.length === 0 ? (
        <Card>
          <EmptyState title="届いたメッセージはありません" description="LINE・メール・Slack・Chatwork でメッセージが届くと、ここに並び、右上のベルでも知らせます。" />
        </Card>
      ) : (
        <div className="space-y-4">
          {[...byDay.entries()].map(([d, items]) => (
            <section key={d}>
              <h2 className="mb-1.5 text-xs font-semibold text-ink-2">{d}</h2>
              <ul className="space-y-2">
                {items.map((i) => {
                  const Icon = ICON[i.channel];
                  return (
                    <li key={i.id} className="rounded-xl border border-line bg-panel p-3" data-testid="inbound-item" data-channel={i.channel}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${TONE[i.channel]}`}>
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                          {INBOUND_CHANNEL_LABEL[i.channel]}
                        </span>
                        <span className="min-w-0 text-sm font-semibold text-ink">{i.from}</span>
                        {i.fromDetail && <span className="min-w-0 truncate text-[11px] text-ink-3">{i.fromDetail}</span>}
                        {i.ref && <Badge dot={false}>{i.ref}</Badge>}
                        <span className="ml-auto text-[11px] text-ink-3 tnum">
                          {time(i.at)}
                          {canSeeAllStores(user) && <> · {storeName(i.storeId)}</>}
                        </span>
                      </div>
                      {i.subject && <div className="mt-1 text-sm font-medium text-ink">{i.subject}</div>}
                      <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{i.text}</p>
                      {i.href && (
                        <div className="mt-1.5 text-right">
                          <Link href={i.href} className="text-xs font-medium text-accent hover:underline">
                            開く →
                          </Link>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
