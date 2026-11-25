import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { userName } from "@/lib/db/queries";
import { canViewNotice, isUnread, noticeTime } from "@/lib/change-notices";
import { markNoticesRead } from "@/lib/actions/notices";
import type { ChangeNotice } from "@/lib/db/types";
import { Badge, Button, Card, EmptyState, Flash, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  { id: "unread", label: "未読" },
  { id: "all", label: "すべて" },
  { id: "mine", label: "自分が変更した" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * 変更のお知らせ (お客様のご要望 2026-11-25「⑥ 変更時の承認・通知・履歴」)
 * 予定の変更・削除、明細・仕様・金額、作業の担当、お客様の付け替え、施工店舗・現場の住所などの変更を、担当店舗・本部・管理者に知らせる。
 * どの案件を・何をどのように (変更前 → 変更後)・いつ・誰が。案件ごとの履歴は案件の画面の「この案件の変更の履歴」
 */
export default async function NoticesPage({ searchParams }: { searchParams: Promise<{ tab?: string; store?: string; q?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : "unread";
  const q = (sp.q ?? "").trim();
  const visible = (db.changeNotices ?? []).filter((n) => canViewNotice(user, n));
  const unreadCount = visible.filter((n) => isUnread(user, n)).length;
  let list = visible.filter((n) => (tab === "unread" ? isUnread(user, n) : tab === "mine" ? n.actorId === user.id : true));
  if (sp.store) list = list.filter((n) => n.storeId === sp.store);
  if (q) list = list.filter((n) => [n.number, n.title, n.topic, ...n.lines.map((l) => `${l.label} ${l.before ?? ""} ${l.after ?? ""}`)].join(" ").includes(q));
  list = [...list].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { tab, store: sp.store, q: q || undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    return `/notices?${p.toString()}`;
  };
  const byDay = new Map<string, ChangeNotice[]>();
  for (const n of list) {
    const day = noticeTime(n.at).split(" ")[0];
    byDay.set(day, [...(byDay.get(day) ?? []), n]);
  }
  return (
    <div className="max-w-5xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="変更のお知らせ"
        description="予定の変更・削除、明細・仕様・金額、作業の担当、お客様の付け替えなどの変更です (承認なしで反映した変更を、担当店舗・本部・管理者に知らせます)。案件を押すとその画面が開きます"
        actions={
          unreadCount > 0 ? (
            <form action={markNoticesRead}>
              <input type="hidden" name="all" value="1" />
              <input type="hidden" name="returnTo" value={qs({})} />
              <Button type="submit" size="sm" variant="secondary">
                未読 {unreadCount} 件をすべて既読にする
              </Button>
            </form>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-line bg-subtle/70 p-1">
          {TABS.map((t) => (
            <Link key={t.id} href={qs({ tab: t.id })} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.id ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink"}`}>
              {t.label}
              {t.id === "unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
            </Link>
          ))}
        </div>
        <form action="/notices" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="tab" value={tab} />
          <select name="store" defaultValue={sp.store ?? ""} className="field w-auto">
            <option value="">全店舗</option>
            {db.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input name="q" defaultValue={q} placeholder="案件番号・お客様・内容で絞り込み" className="field w-56" />
          <Button type="submit" size="sm" variant="secondary">
            絞り込む
          </Button>
        </form>
      </div>
      {list.length === 0 ? (
        <Card>
          <EmptyState title={tab === "unread" ? "未読のお知らせはありません" : "お知らせはありません"} description="案件の予定・明細・担当などが変わると、ここに届きます。" />
        </Card>
      ) : (
        <div className="space-y-4">
          {[...byDay.entries()].map(([day, items]) => (
            <section key={day}>
              <h2 className="mb-1.5 text-xs font-semibold text-ink-2">{day}</h2>
              <ul className="space-y-2">
                {items.map((n) => {
                  const unread = isUnread(user, n);
                  return (
                    <li key={n.id} className={`rounded-xl border bg-panel p-3 ${unread ? "border-accent/50 ring-1 ring-accent/20" : "border-line"}`} data-testid="notice">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={unread ? "accent" : "neutral"} dot={false}>
                          {n.topic}
                        </Badge>
                        <Link href={`/notices/${n.id}/open`} className="min-w-0 text-sm font-semibold text-accent hover:underline">
                          {[n.number, n.title].filter(Boolean).join(" ")}
                        </Link>
                        <span className="text-[11px] text-ink-3">{storeName(n.storeId)}</span>
                        <span className="ml-auto text-[11px] text-ink-3 tnum">
                          {noticeTime(n.at)} · {userName(n.actorId)}
                        </span>
                      </div>
                      <table className="mt-1.5 w-full text-xs">
                        <tbody>
                          {n.lines.map((l, i) => (
                            <tr key={i} className="border-t border-line/60 first:border-t-0 align-top">
                              <td className="w-40 py-1 pr-2 text-ink-3">{l.label}</td>
                              <td className="py-1 text-ink">
                                {l.before && l.before !== "(空)" ? (
                                  <>
                                    <span className="text-ink-3 line-through decoration-ink-3/50">{l.before}</span>
                                    <span className="mx-1 text-ink-3">→</span>
                                  </>
                                ) : null}
                                <span className="font-medium">{l.after}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {unread && (
                        <form action={markNoticesRead} className="mt-1 text-right">
                          <input type="hidden" name="ids" value={n.id} />
                          <input type="hidden" name="returnTo" value={qs({})} />
                          <button type="submit" className="text-[11px] text-ink-2 hover:underline">
                            既読にする
                          </button>
                        </form>
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
