import Link from "@/components/ui/Link";
import { ImagePlus, Megaphone } from "lucide-react";
import type { Attachment, CasePost, CasePostStatus, Database, Order, User } from "@/lib/db/types";
import { canCreateCasePost, canManageCasePostSettings, canSeeAllStores } from "@/lib/auth/permissions";
import { CASE_POST_CHANNEL_LABEL, CASE_POST_STATUS, casePostAttention, casePostReviewers, lastReturnComment, reviewersConfigured, visibleCasePosts } from "@/lib/case-posts";
import { pendingLinePhotos, type HeldLinePhoto } from "@/lib/line-photos";
import { saveCasePostReviewers } from "@/lib/actions/case-posts";
import { postTablesReady } from "@/lib/posts-tables";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, LinkButton, Note, Pager, StoreTag, paginate } from "@/components/ui";

/** 施工事例の投稿の状態 */
export function CasePostStatusBadge({ p }: { p: Pick<CasePost, "status"> }) {
  const s = CASE_POST_STATUS[p.status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const STEPS: CasePostStatus[] = ["draft", "review", "approved", "posted"];

/** 進み方 (下書き → 確認依頼 → 承認済み → 投稿済み) */
export function CasePostSteps({ status }: { status: CasePostStatus }) {
  const at = status === "returned" ? 0 : STEPS.indexOf(status);
  return (
    <ol className="mb-4 flex flex-wrap gap-1 text-xs" aria-label="投稿の進み方">
      {STEPS.map((s, i) => (
        <li key={s} className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${status === "discarded" ? "bg-subtle text-ink-3" : i < at ? "bg-good-soft text-good-ink" : i === at ? "bg-ink text-white" : "bg-subtle text-ink-3"}`}>
          <span className="tnum">{i + 1}</span> {CASE_POST_STATUS[s].label.replace(/ \(.*\)$/, "")}
        </li>
      ))}
      {status === "returned" && <li><Badge tone="serious">差し戻し</Badge></li>}
      {status === "discarded" && <li><Badge tone="critical">取りやめ</Badge></li>}
    </ol>
  );
}

/** 受注の写真を選ぶ (チェックボックス + 縮小画像) */
export function PhotoChecks({ photos, selected, disabled }: { photos: Attachment[]; selected: string[]; disabled?: boolean }) {
  if (!photos.length) return <p className="text-xs text-ink-3">この案件にはまだ写真がありません。受注・施工の画面の「現場写真・資料」で登録するか、LINE の「施工事例写真」グループの写真を付けてください。</p>;
  return (
    <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4 @4xl:grid-cols-5">
      {photos.map((a) => (
        <label key={a.id} className="group relative block cursor-pointer overflow-hidden rounded-xl border border-line bg-subtle has-[:checked]:border-accent has-[:checked]:ring-2 has-[:checked]:ring-accent/40">
          <input type="checkbox" name="photoIds" value={a.id} defaultChecked={selected.includes(a.id)} disabled={disabled} className="absolute top-2 left-2 z-10 h-4 w-4" aria-label={`写真 ${a.fileName} を使う`} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/attachments/${a.id}?size=thumb`} alt={a.caption || a.fileName} loading="lazy" className="aspect-[4/3] w-full object-cover" />
          <span className="block truncate px-2 py-1 text-[11px] text-ink-3">{a.caption || fmtDateTime(a.takenAt ?? a.uploadedAt)}</span>
        </label>
      ))}
    </div>
  );
}

/** LINE のグループの写真を選ぶ (まだ付けていないもの) */
export function LinePhotoChecks({ items, name = "refs", stores }: { items: HeldLinePhoto[]; name?: string; stores?: Database["stores"] }) {
  return (
    <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4 @4xl:grid-cols-6">
      {items.map((x) => (
        <label key={x.ref} className="relative block cursor-pointer overflow-hidden rounded-xl border border-line bg-subtle has-[:checked]:border-accent has-[:checked]:ring-2 has-[:checked]:ring-accent/40">
          <input type="checkbox" name={name} value={x.ref} className="absolute top-2 left-2 z-10 h-4 w-4" aria-label={`LINE の写真 ${fmtDateTime(x.message.at)}`} />
          {x.held ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/line-photos/${x.group.id}/${x.message.id}`} alt={`LINE ${x.groupName} ${fmtDateTime(x.message.at)}`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
          ) : (
            <span className="flex aspect-[4/3] w-full items-center justify-center px-2 text-center text-[11px] text-ink-3">{x.message.fileError ? `取得できていません (${x.message.fileError})` : "保存中…"}<br />付けるときに LINE から取得します</span>
          )}
          <span className="block truncate px-2 py-1 text-[11px] text-ink-3">
            {fmtDateTime(x.message.at)} · {x.groupName}
            {stores && x.storeId ? ` · ${stores.find((s) => s.id === x.storeId)?.shortName ?? ""}` : ""}
          </span>
        </label>
      ))}
    </div>
  );
}

/** 受注・施工の画面のカード: この案件の施工事例の投稿と、投稿を作る入口 */
export function OrderCasePostsCard({ db, user, order }: { db: Database; user: User; order: Order }) {
  const posts = visibleCasePosts(db, user).filter((p) => p.orderId === order.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const canCreate = canCreateCasePost(user, order.storeId) && order.status !== "cancelled";
  const photos = db.attachments.filter((a) => a.parentType === "order" && a.parentId === order.id && a.kind === "photo").length;
  const linePhotos = canCreate ? pendingLinePhotos(db, user, "photos", order.storeId).length : 0;
  return (
    <Card>
      <CardHeader
        title="施工事例の投稿"
        icon={<Megaphone />}
        description="この案件の写真・商品名・施工内容から AI で投稿文の下書きを作り、確認する人が確認してから Instagram・ホームページなどに投稿します (お客様のお名前・番地は入れません)"
        action={canCreate ? <LinkButton href={`/materials/cases/new?order=${order.id}`} size="sm" variant="secondary">投稿を作る</LinkButton> : undefined}
      />
      {posts.length > 0 ? (
        <ul className="divide-y divide-line">
          {posts.slice(0, 6).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
              <Link href={`/materials/cases/${p.id}`} className="font-medium text-accent hover:underline">{p.number}</Link>
              <span className="min-w-0 flex-1 truncate text-ink">{p.title || "(見出しなし)"}</span>
              <CasePostStatusBadge p={p} />
              <span className="text-[11px] text-ink-3">{fmtDateTime(p.updatedAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-3">まだ投稿はありません。{photos ? `写真 ${photos} 枚があります。` : "先に「現場写真・資料」に施工の写真を登録してください。"}</p>
      )}
      {linePhotos > 0 && (
        <p className="mt-2 text-xs">
          <Link href={`/materials/cases/line?order=${encodeURIComponent(order.number)}`} className="inline-flex items-center gap-1 text-accent hover:underline"><ImagePlus className="h-3.5 w-3.5" />LINE の「施工事例写真」グループに、まだ案件に付けていない写真が {linePhotos} 枚あります</Link>
        </p>
      )}
    </Card>
  );
}

type SP = Record<string, string | undefined>;

const VIEWS: { key: string; label: string; test: (p: CasePost) => boolean }[] = [
  { key: "", label: "すべて", test: (p) => p.status !== "discarded" },
  { key: "draft", label: "下書き・差し戻し", test: (p) => p.status === "draft" || p.status === "returned" },
  { key: "review", label: "確認依頼中", test: (p) => p.status === "review" },
  { key: "approved", label: "投稿待ち", test: (p) => p.status === "approved" },
  { key: "posted", label: "投稿済み", test: (p) => p.status === "posted" },
  { key: "discarded", label: "取りやめ", test: (p) => p.status === "discarded" },
];

/** 資料・写真 → 施工事例の投稿 (一覧・確認する人の設定・LINE の写真) */
export function CasePostsTab({ db, user, sp }: { db: Database; user: User; sp: SP }) {
  const all = visibleCasePosts(db, user);
  const view = VIEWS.find((v) => v.key === (sp.view ?? "")) ?? VIEWS[0];
  const stores = db.stores.filter((s) => all.some((p) => p.storeId === s.id));
  const store = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : "";
  const rows = all.filter((p) => view.test(p) && (!store || p.storeId === store)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const paged = paginate(rows, sp.page, 50);
  const att = casePostAttention(db, user);
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const reviewers = casePostReviewers(db);
  const admin = canManageCasePostSettings(user);
  const linePhotos = pendingLinePhotos(db, user, "photos").length;
  const href = (k: string) => `/materials?tab=cases${k ? `&view=${k}` : ""}${store ? `&store=${store}` : ""}`;
  const candidates = db.users.filter((u) => u.active && u.signupStatus !== "pending" && !u.id.startsWith("u_review_")).sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin") || a.name.localeCompare(b.name, "ja"));
  return (
    <div className="space-y-4">
      {!postTablesReady(["case_posts"]) && <Note tone="warn">施工事例の投稿の表 (case_posts) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するまで、登録はできません。</Note>}
      <Note>
        進め方: 受注・施工の画面の「施工事例の投稿」→「投稿を作る」で、案件の写真・商品名・施工内容から AI が投稿文の下書きを作ります (お客様のお名前・番地・電話番号は入れず、地域は町名まで) → 担当者が直して「確認を依頼する」→ 確認する人 ({reviewers.map((u) => u.name).join("・") || "管理者"}) が承認 (または理由を付けて差し戻し) → 承認された文面をコピーし、写真を保存して Instagram・ホームページなどに投稿 →「投稿を記録する」で投稿した日・URL を残します。SNS へ自動では投稿しません。
      </Note>
      {(att.toReview.length > 0 || att.returned.length > 0 || att.toPost.length > 0 || linePhotos > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {att.toReview.length > 0 && <Link href={href("review")} className="rounded-full bg-warn-soft px-2.5 py-1 font-medium text-warn-ink hover:underline">確認を待っている投稿 {att.toReview.length} 件</Link>}
          {att.returned.length > 0 && <Link href={href("draft")} className="rounded-full bg-serious-soft px-2.5 py-1 font-medium text-serious-ink hover:underline">差し戻された投稿 {att.returned.length} 件</Link>}
          {att.toPost.length > 0 && <Link href={href("approved")} className="rounded-full bg-info-soft px-2.5 py-1 font-medium text-info-ink hover:underline">承認済みで投稿待ち {att.toPost.length} 件</Link>}
          {linePhotos > 0 && <Link href="/materials/cases/line" className="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent-ink hover:underline">LINE の施工事例写真 (案件に未登録) {linePhotos} 枚</Link>}
        </div>
      )}
      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader title="施工事例の投稿" description={`${rows.length} 件`} action={<LinkButton href="/materials/cases/line" size="sm" variant="ghost">LINE の施工事例写真</LinkButton>} />
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            {VIEWS.map((v) => (
              <Link key={v.key} href={href(v.key)} className={`rounded-full px-2.5 py-1 ${v.key === view.key ? "bg-accent-soft font-semibold text-accent-ink" : "bg-subtle text-ink-2 hover:text-ink"}`}>{v.label} ({all.filter(v.test).filter((p) => !store || p.storeId === store).length})</Link>
            ))}
            {stores.length > 1 && (
              <span className="ml-auto flex flex-wrap gap-1">
                <Link href={`/materials?tab=cases${view.key ? `&view=${view.key}` : ""}`} className={`rounded-full px-2 py-1 ${!store ? "bg-ink text-white" : "bg-subtle text-ink-2"}`}>全店</Link>
                {stores.map((s) => <Link key={s.id} href={`/materials?tab=cases${view.key ? `&view=${view.key}` : ""}&store=${s.id}`} className={`rounded-full px-2 py-1 ${store === s.id ? "bg-ink text-white" : "bg-subtle text-ink-2"}`}>{s.shortName}</Link>)}
              </span>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">番号</th><th className="px-2 py-2 text-left font-medium">見出し</th><th className="px-2 py-2 text-left font-medium">案件</th><th className="px-2 py-2 text-left font-medium">店舗</th><th className="px-2 py-2 text-left font-medium">投稿先</th><th className="px-2 py-2 text-left font-medium">状態</th><th className="px-4 py-2 text-left font-medium">更新</th></tr></thead>
            <tbody>
              {paged.items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-ink-3">該当する投稿はありません。受注・施工の画面の「施工事例の投稿」から作れます</td></tr>}
              {paged.items.map((p) => {
                const o = orders.get(p.orderId);
                const ret = p.status === "returned" ? lastReturnComment(p) : undefined;
                return (
                  <tr key={p.id} className="border-t border-line align-top hover:bg-subtle/60">
                    <td className="px-4 py-2"><Link href={`/materials/cases/${p.id}`} className="font-medium text-accent hover:underline">{p.number}</Link></td>
                    <td className="max-w-[18rem] px-2 py-2 text-xs text-ink">{p.title || "(見出しなし)"}{ret && <div className="text-serious-ink">差し戻しの理由: {ret}</div>}</td>
                    <td className="px-2 py-2 text-xs">{o ? <Link href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number}</Link> : "-"}</td>
                    <td className="px-2 py-2"><StoreTag store={db.stores.find((s) => s.id === p.storeId)} short /></td>
                    <td className="px-2 py-2 text-xs text-ink-2">{p.channels.map((c) => CASE_POST_CHANNEL_LABEL[c].replace(/ \(.*\)$/, "")).join("・") || "-"}{p.postings.length > 0 && <div className="text-ink-3">投稿 {fmtDate(p.postings[p.postings.length - 1].on)}</div>}</td>
                    <td className="px-2 py-2"><CasePostStatusBadge p={p} /></td>
                    <td className="px-4 py-2 text-[11px] text-ink-3 tnum">{fmtDateTime(p.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/materials" sp={{ ...sp, tab: "cases" }} /></div>
      </Card>

      <Card>
        <CardHeader title="投稿文を確認する人" description={`確認を依頼された投稿を承認・差し戻す人です。${reviewersConfigured(db) ? "" : "いまは既定 (本部の管理者) です。"}確認する人が自分で確認を依頼したときは、そのまま承認済みになります`} />
        <p className="mb-2 text-sm text-ink">{reviewers.map((u) => u.name).join("・") || "(該当する社員がいません)"}</p>
        {admin ? (
          <form action={saveCasePostReviewers} className="space-y-2">
            <div className="grid grid-cols-1 gap-1 @xl:grid-cols-3">
              {candidates.map((u) => (
                <label key={u.id} className="flex items-center gap-1.5 text-xs text-ink-2">
                  <input type="checkbox" name="reviewerIds" value={u.id} defaultChecked={reviewersConfigured(db) && reviewers.some((r) => r.id === u.id)} className="h-3.5 w-3.5" />
                  {u.name}{canSeeAllStores(u) ? "" : ` (${db.stores.find((s) => s.id === u.storeId)?.shortName ?? ""})`}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-ink-3">だれも選ばずに保存すると既定 (本部の管理者) に戻ります。</p>
            <Button type="submit" size="sm" variant="secondary">確認する人を保存</Button>
          </form>
        ) : (
          <p className="text-[11px] text-ink-3">確認する人の変更は管理者が行います。</p>
        )}
      </Card>
    </div>
  );
}
