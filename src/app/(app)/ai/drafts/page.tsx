import { requireUser } from "@/lib/auth/session";
import { BACKEND, getDb } from "@/lib/db/store";
import { missingTables } from "@/lib/db/supabase";
import { canViewDocDraft } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { DOC_DRAFT_FORMAT_LABEL, docDraftAttention, isReturned, lastEvent } from "@/lib/doc-drafts";
import type { DocDraft, DocDraftStatus } from "@/lib/db/types";
import Link from "@/components/ui/Link";
import { DocDraftStatusBadge } from "@/components/features/DocDrafts";
import { Button, EmptyRow, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Pager, Table, Td, Th, Tr, paginate } from "@/components/ui";

export const dynamic = "force-dynamic";

type View = "all" | "mine" | "approve" | "tosend" | "returned" | DocDraftStatus;

/**
 * 文書の下書きの一覧 (AI アシスタント →「文書の作成」で保存した文書)
 * 見られる範囲は permissions.ts の canViewDocDraft (店舗のロールは所属店舗の文書と自分の文書)
 */
export default async function DocDraftsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const views: View[] = ["all", "mine", "approve", "tosend", "returned", "draft", "reviewed", "approved", "sent", "discarded"];
  const view: View = (views as string[]).includes(sp.view ?? "") ? (sp.view as View) : "all";
  const q = (sp.q ?? "").trim().normalize("NFKC").toLowerCase();
  const visible = (db.docDrafts ?? []).filter((d) => canViewDocDraft(user, d));
  const att = docDraftAttention(db, user);
  const pick = (v: View): DocDraft[] => {
    switch (v) {
      case "all":
        return visible.filter((d) => d.status !== "discarded");
      case "mine":
        return visible.filter((d) => d.createdBy === user.id);
      case "approve":
        return att.toApprove;
      case "tosend":
        return visible.filter((d) => d.status === "approved");
      case "returned":
        return visible.filter((d) => isReturned(d));
      default:
        return visible.filter((d) => d.status === v);
    }
  };
  const rows = pick(view)
    .filter((d) => !q || `${d.number} ${d.title} ${d.subject ?? ""} ${d.body} ${d.refs.map((r) => r.label).join(" ")}`.normalize("NFKC").toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const paged = paginate(rows, sp.page, 50);
  const tableMissing = BACKEND === "supabase" && missingTables().includes("doc_drafts");
  const href = (v: View) => (v === "all" ? "/ai/drafts" : `/ai/drafts?view=${v}`);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="文書の下書き"
        back={{ href: "/ai?tab=draft", label: "文書の作成" }}
        description="AI アシスタントで作って保存した文書です。下書き → 内容を確認した → 承認 → 送信 の順に進めます。承認のあとに文面を直すと下書きに戻ります"
        actions={<LinkButton href="/ai?tab=draft" size="sm">新しく作る</LinkButton>}
      />
      {tableMissing && <Note tone="warn">データベースに文書の下書きの表がまだありません。管理者がデプロイ (npm run deploy) するか npm run db:migrate を実行するまで、保存はできません。</Note>}
      <LinkTabs
        current={href(view)}
        items={[
          { href: href("all"), label: "すべて (破棄を除く)", count: pick("all").length },
          { href: href("mine"), label: "自分の文書", count: pick("mine").length },
          { href: href("approve"), label: "承認待ち (自分が承認する)", count: att.toApprove.length },
          { href: href("returned"), label: "差し戻し", count: pick("returned").length },
          { href: href("tosend"), label: "送信待ち", count: pick("tosend").length },
          { href: href("draft"), label: "下書き" },
          { href: href("reviewed"), label: "確認済み" },
          { href: href("sent"), label: "送信済み" },
          { href: href("discarded"), label: "破棄" },
        ]}
      />
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        {view !== "all" && <input type="hidden" name="view" value={view} />}
        <div className="w-full @xl:w-80"><Input name="q" defaultValue={sp.q} placeholder="番号・件名・本文・記録で探す" aria-label="文書を探す" /></div>
        <Button type="submit" variant="secondary" size="sm">探す</Button>
        <span className="text-xs text-ink-3">{rows.length} 件</span>
      </form>
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>番号</Th>
            <Th>文書</Th>
            <Th>状態</Th>
            <Th>関係する記録</Th>
            <Th>作成</Th>
            <Th>更新</Th>
          </tr>
        </thead>
        <tbody>
          {paged.items.length === 0 && <EmptyRow colSpan={6}>{view === "approve" ? "承認を待っている文書はありません" : "当てはまる文書はありません"}</EmptyRow>}
          {paged.items.map((d) => {
            const ev = lastEvent(d);
            return (
              <Tr key={d.id}>
                <Td><Link href={`/ai/drafts/${d.id}`} className="font-medium text-accent hover:underline">{d.number}</Link></Td>
                <Td>
                  <div className="text-ink">{d.title}</div>
                  <div className="text-[11px] text-ink-3">{DOC_DRAFT_FORMAT_LABEL[d.format]} · 第 {d.version} 版{isReturned(d) && ev?.comment ? ` · 差し戻しの理由: ${ev.comment.slice(0, 60)}` : ""}</div>
                </Td>
                <Td><DocDraftStatusBadge d={d} /></Td>
                <Td>
                  <div className="flex flex-wrap gap-x-2 text-xs">
                    {d.refs.length ? d.refs.map((r) => <Link key={`${r.type}:${r.id}`} href={r.href} className="text-accent hover:underline">{r.label}</Link>) : <span className="text-ink-3">なし</span>}
                  </div>
                </Td>
                <Td className="text-xs">{userName(d.createdBy)}<div className="text-[11px] text-ink-3">{fmtDateTime(d.createdAt)}</div></Td>
                <Td className="text-xs">{fmtDateTime(d.updatedAt)}<div className="text-[11px] text-ink-3">{d.status === "sent" && d.sentAt ? `送信 ${fmtDateTime(d.sentAt)} ${userName(d.sentBy)}` : userName(d.updatedBy ?? d.createdBy)}</div></Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <Pager paged={paged} path="/ai/drafts" sp={sp} />
    </div>
  );
}
