import { redirect } from "next/navigation";
import { ArrowRightLeft, Download } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canDecideCarryover, canReviewCarryover } from "@/lib/auth/permissions";
import { carryoverView, isTestWeekDb } from "@/lib/carryover-server";
import { KIND_JA, RECORD_HREF, SPECIAL_JA, jst, type CarryGroup } from "@/lib/carryover";
import { TABLES } from "@/lib/db/schema";
import { userName } from "@/lib/db/queries";
import { decideCarryover, setCarryoverDecision, setCarryoverScope } from "@/lib/actions/carryover";
import { Badge, Button, Card, CardHeader, Flash, Input, Note, PageHeader, Stat, StoreTag, Table, Td, Textarea, Th, Tr } from "@/components/ui";

/**
 * 本番への引き継ぎ (試験期間 2026-11-23〜11-30。お客様のご要望 2026-11-23「■1」: 期間中に本番さながらに登録したデータを、
 * 11/30 に最終判断して 12/1 以降の本番に引き継ぐ)。期間中に増えた・変わった記録を「まとまり」ごとに並べ、引き継ぐかを決める。
 * 計算は src/lib/carryover.ts (12/1 に本番へ書く道具 scripts/ops/testweek-carryover.mjs と同じ)。判断はテスト用のデータベースにだけ残す
 */
export const maxDuration = 60;

const LABEL = new Map(TABLES.map((t) => [t.collection, t.label]));

function detail(g: CarryGroup): string {
  return Object.entries(g.counts)
    .map(([c, n]) => `${(LABEL.get(c) ?? c).replace(/ \(.*$/, "")} ${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${KIND_JA[k as keyof typeof KIND_JA]}${v}`).join("・")}`)
    .join(" / ");
}

function DecisionButtons({ g }: { g: CarryGroup }) {
  const btn = (decision: string, text: string, variant: "secondary" | "ghost" = "secondary") => (
    <form action={setCarryoverDecision} className="inline">
      <input type="hidden" name="groupId" value={g.id} />
      <input type="hidden" name="label" value={g.label} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" size="sm" variant={variant}>{text}</Button>
    </form>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {g.selected ? btn("exclude", "引き継がない") : btn("include", "引き継ぐ")}
      {g.decision && btn("clear", "自動に戻す", "ghost")}
    </div>
  );
}

export default async function CarryoverPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canReviewCarryover(user)) redirect("/data?err=" + encodeURIComponent("本番への引き継ぎは管理者・本部スタッフが確かめます。"));
  const db = getDb();
  const header = (
    <PageHeader
      title="本番への引き継ぎ (試験期間)"
      icon={<ArrowRightLeft />}
      back={{ href: "/data", label: "データ入出力" }}
      description="試験期間 (11/23〜11/30) に登録・変更した記録を、つながる記録の「まとまり」(お客様 → 問い合わせ → 見積 → 受注・写真・やりとり・承認・変更履歴) ごとに並べています。引き継ぐものを確かめ、11/30 に最終判断してください。12 月 1 日の朝、この判断で本番のデータベースに引き継ぎます"
    />
  );
  if (!isTestWeekDb(db)) {
    return (
      <div>
        {header}
        <Note>いまは試験期間のテスト用のデータベースではありません。この画面は試験期間 (テスト用のサーバー) で使います。</Note>
      </div>
    );
  }
  const v = await carryoverView(db);
  if ("error" in v) {
    return (
      <div>
        {header}
        <Flash msg={sp.msg} err={sp.err} />
        <Note tone="warn">{v.error} システムの担当者にご連絡ください。</Note>
      </div>
    );
  }
  const { plan, review } = v;
  const showAll = sp.all === "1";
  const noise = plan.groups.filter((g) => !g.selected && !g.pulled.length && g.reason.startsWith("変更履歴だけ"));
  const groups = plan.groups.filter((g) => showAll || !noise.includes(g));
  const selected = plan.groups.filter((g) => g.selected);
  const rowCount = Object.values(plan.rows).reduce((a, r) => a + r.upsert.length + r.delete.length, 0);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const choosable = plan.settings.filter((s) => !s.reason.startsWith("サーバーの動き"));
  const canDecide = canDecideCarryover(user);

  return (
    <div>
      {header}
      <Flash msg={sp.msg} err={sp.err} />
      {v.mismatch && <Note tone="warn">期間の始まりの控えが、テスト用のデータベースの元と違います。システムの担当者にご連絡ください (引き継ぎは止まります)。</Note>}

      <div className="mb-4 grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        <Stat label="引き継ぐまとまり" value={`${selected.length} 件`} sub={`全 ${plan.groups.length - noise.length} 件 (変更履歴だけの ${noise.length} 件を除く)`} />
        <Stat label="引き継ぐ行" value={`${rowCount.toLocaleString("ja-JP")} 行`} sub={`写真・資料のファイル ${v.files} 件`} />
        <Stat label="期間" value={`${review.since ?? "はじめ"} 〜 ${review.until ?? "おわり"}`} sub="最初の操作の日がこの期間のまとまり" />
        <Stat label="最終判断" value={review.decidedAt ? jst(review.decidedAt).slice(5) : "まだ"} sub={review.decidedAt ? `${userName(review.decidedBy ?? "")} が決定` : "11/30 に管理者が決めます"} />
      </div>

      <Card className="mb-4">
        <CardHeader title="自動の判断" description="何もしなければ、次のとおりに引き継ぎます。まとまりごとに「引き継ぐ」「引き継がない」で変えられます" />
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">
          <li>期間中に登録した問い合わせ・お客様・見積・受注・予定・写真・やりとり・承認・変更履歴などを、つながる記録ごとに引き継ぎます (本番の記録の変更も)</li>
          <li>お客様名・件名・要約に「練習」「テスト」とあるまとまりは、練習として引き継ぎません</li>
          <li>ログイン・閲覧だけの変更履歴は引き継ぎません。メール・LINE の送信は期間中も本物のため、送信の記録は引き継ぐ案件と一緒に残ります</li>
          <li>設定の変更は、下の「引き継ぐ設定」で選んだものだけ。社員のプロフィール (通知先など) の変更は引き継ぎます</li>
          <li>12 月 1 日の朝 (本番で登録を始める前) に引き継ぎます。期間中に本番の側で変わった記録・同じ番号の記録があれば、何も書かずに止まります</li>
        </ul>
      </Card>

      <Card className="mb-4">
        <CardHeader title="引き継ぐ期間と設定" />
        <form action={setCarryoverScope} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label className="text-ink-2">はじめ (最初の操作の日)<Input type="date" name="since" defaultValue={review.since ?? ""} className="mt-1 h-8 w-40" /></label>
            <span className="pb-2 text-ink-3">〜</span>
            <label className="text-ink-2">おわり<Input type="date" name="until" defaultValue={review.until ?? ""} className="mt-1 h-8 w-40" /></label>
            <span className="pb-2 text-ink-3">空欄 = 期間のはじめ・おわりまで (11/23 の会議から 11/30 まですべて)</span>
          </div>
          <div className="text-xs">
            <div className="mb-1 text-ink-2">引き継ぐ設定 (期間中に変えた設定)</div>
            {choosable.length === 0 ? (
              <p className="text-ink-3">期間中に変えた設定はありません</p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {choosable.map((s) => (
                  <label key={`${s.coll}:${s.id}`} className="flex items-center gap-1.5">
                    <input type="checkbox" name="settings" value={s.coll === "settings" ? s.id : `${s.coll}:${s.id}`} defaultChecked={s.selected} className="h-4 w-4" />
                    {SPECIAL_JA[s.coll] ?? s.coll} {s.id} ({KIND_JA[s.kind]})
                  </label>
                ))}
              </div>
            )}
          </div>
          <Button type="submit" size="sm" variant="secondary">保存</Button>
        </form>
      </Card>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5">
          <CardHeader
            title="期間中の記録のまとまり"
            description={`○ = 引き継ぐ / × = 引き継がない / △ = 引き継ぐほかの記録が参照するため一部を引き継ぐ。計算 ${jst(v.computedAt)}`}
            action={
              <a href="/api/carryover" download className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-subtle hover:text-ink">
                <Download className="h-3 w-3" aria-hidden /> 一覧 (CSV)
              </a>
            }
          />
        </div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[1080px]">
          <thead>
            <tr><Th className="pl-5">引き継ぐ</Th><Th>内容</Th><Th>店舗</Th><Th>最初の操作</Th><Th>操作した人</Th><Th>記録の内訳</Th><Th>理由</Th><Th className="pr-5">判断</Th></tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <Tr><Td colSpan={8} className="pl-5 text-ink-3">期間中に登録・変更した記録はまだありません</Td></Tr>
            )}
            {groups.map((g) => {
              const href = RECORD_HREF[g.rootColl] ? `${RECORD_HREF[g.rootColl]}${g.id}` : null;
              return (
                <Tr key={g.id}>
                  <Td className="pl-5"><span id={`g-${g.id}`} />{g.selected ? <Badge tone="good">○ 引き継ぐ</Badge> : g.pulled.length ? <Badge tone="warn">△ 一部</Badge> : <Badge tone="neutral">× 引き継がない</Badge>}</Td>
                  <Td>{href ? <Link href={href} className="text-accent hover:underline">{g.label}</Link> : g.label}</Td>
                  <Td>{g.store ? <StoreTag store={storeMap.get(g.store)} short /> : "-"}</Td>
                  <Td className="tnum text-xs">{jst(g.first) || "-"}{g.last && g.last !== g.first ? <span className="block text-[11px] text-ink-3">最後 {jst(g.last)}</span> : null}</Td>
                  <Td className="text-xs">{g.actors.join("・") || "-"}</Td>
                  <Td className="text-[11px] text-ink-2">{detail(g)}</Td>
                  <Td className="text-[11px] text-ink-3">{g.reason || (g.selected ? "期間中に登録" : "")}{g.pulled.length ? <span className="block">ほかの記録が参照: {g.pulled.join("、")}</span> : null}</Td>
                  <Td className="pr-5">{g.reason.startsWith("変更履歴だけ") ? <span className="text-[11px] text-ink-3">-</span> : <DecisionButtons g={g} />}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
        <p className="px-5 py-3 text-[11px] text-ink-3">
          {noise.length > 0 && !showAll && <>変更履歴だけのまとまり (ログイン・閲覧など) {noise.length} 件は表示していません (<Link href="/data/carryover?all=1" className="text-accent hover:underline">すべて表示</Link>)。</>}
          {plan.users.length > 0 && ` 社員のプロフィールの変更 ${plan.users.length} 名分 (${plan.users.map((u) => u.name).join("・")}) も引き継ぎます。`}
        </p>
      </Card>

      <Card>
        <CardHeader title="最終判断 (11/30)" description="この一覧のとおりに引き継ぐと決めます。決めたあとに判断・期間・設定を変えると、最終判断は取り消しになります" />
        {review.decidedAt ? (
          <div className="space-y-2 text-sm">
            <p><Badge tone="good">決定済み</Badge> {jst(review.decidedAt)} {userName(review.decidedBy ?? "")}{review.note ? ` — ${review.note}` : ""}</p>
            {canDecide && (
              <form action={decideCarryover}>
                <input type="hidden" name="undo" value="1" />
                <Button type="submit" size="sm" variant="ghost">最終判断を取り消す</Button>
              </form>
            )}
          </div>
        ) : canDecide ? (
          <form action={decideCarryover} className="space-y-2">
            <Textarea name="note" rows={2} placeholder="メモ (任意。例: 11/23 の会議分と 11/24〜11/30 の本番同様の運用分を引き継ぐ)" className="text-xs" />
            <Button type="submit" size="sm">この内容で引き継ぐと決める</Button>
          </form>
        ) : (
          <Note>最終判断は管理者が行います。</Note>
        )}
      </Card>
    </div>
  );
}
