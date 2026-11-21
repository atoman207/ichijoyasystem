import clsx from "clsx";
import type { Database, DocDraft, DocDraftRefType, DocDraftStatus, User } from "@/lib/db/types";
import { canViewDocDraft } from "@/lib/auth/permissions";
import { DOC_DRAFT_STATUS, docDraftAttention, isReturned } from "@/lib/doc-drafts";
import { fmtDateTime } from "@/lib/format";
import Link from "@/components/ui/Link";
import { Badge, Card, CardHeader } from "@/components/ui";

/** 文書の状態 (色 + ラベル。差し戻されたものは「差し戻し」と出す) */
export function DocDraftStatusBadge({ d }: { d: Pick<DocDraft, "status" | "events"> }) {
  if (isReturned(d as DocDraft)) return <Badge tone="serious">差し戻し (下書き)</Badge>;
  const s = DOC_DRAFT_STATUS[d.status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const STEPS: DocDraftStatus[] = ["draft", "reviewed", "approved", "sent"];
const STEP_LABEL: Record<DocDraftStatus, string> = { draft: "下書き", reviewed: "内容の確認", approved: "承認", sent: "送信", discarded: "破棄" };

/** 進み方 (下書き → 確認 → 承認 → 送信) のどこにいるか */
export function DocDraftSteps({ status }: { status: DocDraftStatus }) {
  const at = STEPS.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="文書の進み方">
      {STEPS.map((s, i) => {
        const done = status !== "discarded" && i < at;
        const cur = i === at;
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              className={clsx(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                cur ? "border-accent bg-accent-soft font-semibold text-accent-ink" : done ? "border-good/40 bg-good-soft text-good-ink" : "border-line text-ink-3",
              )}
              aria-current={cur ? "step" : undefined}
            >
              {done ? "✓ " : `${i + 1}. `}
              {STEP_LABEL[s]}
            </span>
            {i < STEPS.length - 1 && <span className="text-ink-3" aria-hidden>→</span>}
          </li>
        );
      })}
      {status === "discarded" && <li><Badge tone="critical">破棄</Badge></li>}
    </ol>
  );
}

/** 「文書の作成」の下に出す最近の文書と、承認待ち・差し戻しの件数 */
export function RecentDocDrafts({ db, user }: { db: Database; user: User }) {
  const list = (db.docDrafts ?? []).filter((d) => canViewDocDraft(user, d));
  const mine = list.filter((d) => d.createdBy === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const att = docDraftAttention(db, user);
  return (
    <Card className="mt-4">
      <CardHeader
        title="保存した文書"
        description="保存した下書きは、確認 → 承認 → 送信 (メール・LINE・Chatwork) の順に進めます。版の履歴と処理の記録が残ります"
        action={<Link href="/ai/drafts" className="text-xs font-medium text-accent hover:underline">すべての文書 ({list.length})</Link>}
      />
      {(att.toApprove.length > 0 || att.returned.length > 0 || att.toSend.length > 0) && (
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          {att.toApprove.length > 0 && <Link href="/ai/drafts?view=approve" className="rounded-full bg-warn-soft px-2.5 py-1 font-medium text-warn-ink hover:underline">承認待ち {att.toApprove.length} 件</Link>}
          {att.returned.length > 0 && <Link href="/ai/drafts?view=returned" className="rounded-full bg-serious-soft px-2.5 py-1 font-medium text-serious-ink hover:underline">差し戻された文書 {att.returned.length} 件</Link>}
          {att.toSend.length > 0 && <Link href="/ai/drafts?view=tosend" className="rounded-full bg-info-soft px-2.5 py-1 font-medium text-info-ink hover:underline">送信待ち {att.toSend.length} 件</Link>}
        </div>
      )}
      {mine.length === 0 ? (
        <p className="text-xs text-ink-3">まだ保存した文書はありません。上で下書きを作って「下書きとして保存」を押してください。</p>
      ) : (
        <ul className="divide-y divide-line">
          {mine.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Link href={`/ai/drafts/${d.id}`} className="font-medium text-accent hover:underline">{d.number}</Link>
              <span className="min-w-0 flex-1 truncate text-ink">{d.title}</span>
              <DocDraftStatusBadge d={d} />
              <span className="text-[11px] text-ink-3">{fmtDateTime(d.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 記録の画面 (見積・受注・問い合わせ・請求・顧客) の「この記録の文書」: ひも付いた文書 (下書き〜送信済み) と、文書を作る入口。
 * 文書からも記録へ、記録からも文書へ辿れる
 */
export function RecordDocDrafts({ db, user, type, id, number }: { db: Database; user: User; type: DocDraftRefType; id: string; number?: string }) {
  const list = (db.docDrafts ?? []).filter((d) => d.refs.some((r) => r.type === type && r.id === id) && canViewDocDraft(user, d)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="rounded-xl border border-line bg-panel p-3" data-testid="record-drafts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">この記録の文書{list.length ? ` (${list.length})` : ""}</span>
        <Link href={`/ai?tab=draft${number ? `&ref=${encodeURIComponent(number)}` : ""}`} className="rounded-lg border border-line px-3 py-1 text-xs font-medium text-accent hover:bg-accent-soft">文書を作る</Link>
      </div>
      {list.length > 0 ? (
        <ul className="mt-2 divide-y divide-line">
          {list.slice(0, 6).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
              <Link href={`/ai/drafts/${d.id}`} className="font-medium text-accent hover:underline">{d.number}</Link>
              <span className="min-w-0 flex-1 truncate text-ink">{d.title}</span>
              <DocDraftStatusBadge d={d} />
              <span className="text-[11px] text-ink-3">{fmtDateTime(d.updatedAt)}</span>
            </li>
          ))}
          {list.length > 6 && <li className="py-1.5 text-[11px]"><Link href="/ai/drafts" className="text-accent hover:underline">ほか {list.length - 6} 件 (文書の一覧)</Link></li>}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-ink-3">お客様へのご案内・報告などの文書は、AI で下書きを作り、確認 → 承認 → 送信の順に進めます。</p>
      )}
    </div>
  );
}
