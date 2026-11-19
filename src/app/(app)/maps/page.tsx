import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageMaps } from "@/lib/auth/permissions";
import { mapIndex } from "@/lib/maps/resolve";
import { normalizeAddress } from "@/lib/maps/address";
import { geocodingEnabled, zenrinStatus } from "@/lib/maps/providers";
import { BATCH_COUNT_LABEL, importRoot, listImportFolders, readBatchState } from "@/lib/maps/batch";
import { MAP_TABLES } from "@/lib/maps/store";
import { missingTables } from "@/lib/db/supabase";
import { fmtDateTime } from "@/lib/format";
import { Badge, Card, CardHeader, Flash, Input, Note, PageHeader, Stat } from "@/components/ui";
import { BatchRunner } from "@/components/maps/BatchRunner";

export const metadata: Metadata = { title: "地図・住宅地図" };

/** 地図・住宅地図の管理 (本部スタッフ・管理者): 状況・ゼンリンの接続状態・一括処理・重複した場所・場所の検索 */
export default async function MapsPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string; q?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canManageMaps(user)) redirect("/?err=" + encodeURIComponent("地図・住宅地図の管理は本部スタッフ・管理者が使えます。各顧客・案件・予定の画面の「地図・住宅地図」から使ってください。"));
  const db = getDb();
  const idx = mapIndex(db);
  const active = db.mapLocations.filter((l) => l.status === "active");
  const docs = db.mapDocuments.filter((d) => d.status === "active");
  const shared = docs.filter((d) => (idx.locationsByDoc.get(d.id) ?? []).length > 1).length;
  const verified = active.filter((l) => l.coordStatus === "verified").length;
  const zenrin = zenrinStatus();
  const state = readBatchState(db);
  const folders = await listImportFolders();
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const missing = missingTables().filter((t) => MAP_TABLES.includes(t));
  const q = sp.q?.trim() ?? "";
  const qKey = q ? normalizeAddress(q).key.replace(/^熊本県/, "") : "";
  const found = q ? active.filter((l) => l.address.includes(q) || (qKey && l.addressKey.includes(qKey))).slice(0, 50) : [];
  const recent = [...db.mapDocuments].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).slice(0, 15);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="地図・住宅地図" description="顧客・案件・予定の場所 (Google マップ) と、許諾を確認した住宅地図 (PDF) の管理。各画面の「地図・住宅地図」と同じデータです" />
      {missing.length > 0 && (
        <div className="mb-4"><Note tone="warn">地図の表 ({missing.join("・")}) がまだデータベースにありません。デプロイ (npm run deploy) か npm run db:migrate の後に使えます。それまでは各画面に住所の文字と Google マップのリンクだけを表示します。</Note></div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="場所" value={`${active.length.toLocaleString()} か所`} sub={`位置 確認済み ${verified.toLocaleString()}`} />
        <Stat label="住宅地図 (使用中)" value={`${docs.length.toLocaleString()} 件`} sub={`複数の場所で共用 ${shared}`} />
        <Stat label="重複した場所" value={`${idx.duplicateKeys.size} 件`} tone={idx.duplicateKeys.size ? "warn" : undefined} />
        <Stat label="顧客" value={`${db.customers.length.toLocaleString()} 件`} sub="住所の文字は変えずに照合" />
      </div>

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <Card>
          <CardHeader title="外部サービスの接続" />
          <ul className="space-y-2 text-xs">
            <li>
              <div className="flex items-center gap-2"><span className="font-medium text-ink">ゼンリン 住宅地図 (自動取得)</span><Badge tone={zenrin.enabled ? "good" : "warn"}>{zenrin.enabled ? "接続済み" : "使えません"}</Badge></div>
              {!zenrin.enabled && <ul className="mt-1 list-disc pl-5 text-ink-3">{zenrin.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              <p className="mt-1 text-ink-3">ログイン画面の自動操作・ダウンロードの自動化・アカウントの使い回しは行いません。許諾を確認した PDF を画面または一括取込で登録してください。</p>
            </li>
            <li className="flex items-center gap-2"><span className="font-medium text-ink">Google マップのリンク</span><Badge tone="good">使えます (API キー不要)</Badge></li>
            <li className="flex items-center gap-2"><span className="font-medium text-ink">住所から位置を求める (Google Geocoding)</span><Badge tone={geocodingEnabled() ? "good" : "neutral"}>{geocodingEnabled() ? "設定済み" : "未設定 (GOOGLE_MAPS_API_KEY)"}</Badge></li>
          </ul>
        </Card>

        <Card>
          <CardHeader title="場所を探す" description="住所の一部で探します (例: 須屋 / 健軍3-12)" />
          <form className="flex gap-2"><Input name="q" defaultValue={q} placeholder="住所" /><button type="submit" className="shrink-0 rounded-xl border border-line px-3 text-sm">探す</button></form>
          {q && (
            <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto text-xs">
              {found.length === 0 && <li className="text-ink-3">見つかりません</li>}
              {found.map((l) => <li key={l.id}><Link href={`/maps/locations/${l.id}`} className="text-accent hover:underline">{l.address}</Link> <span className="text-ink-3">住宅地図 {(idx.docsByLocation.get(l.id) ?? []).length} 件{l.coordStatus === "verified" ? " · 位置 確認済み" : ""}</span></li>)}
            </ul>
          )}
        </Card>

        <Card className="@3xl:col-span-2">
          <CardHeader title="一括処理 (1 万件以上の顧客にも対応)" description={`少しずつ処理し、途中で止まっても続きから再開できます。取込フォルダー: ${importRoot()}`} />
          <BatchRunner current={state.current?.status === "running" ? state.current : undefined} folders={folders} labels={BATCH_COUNT_LABEL} />
          {state.history.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-1 text-xs font-semibold text-ink-2">これまでの一括処理</h3>
              <ul className="space-y-1 text-[11px] text-ink-2">
                {state.history.map((h) => (
                  <li key={h.id}>
                    {fmtDateTime(h.startedAt)} {h.kind === "normalize" ? "住所の正規化" : `一括取込 ${h.folder}`}{h.dryRun ? " (試し)" : ""} · {h.status === "done" ? "完了" : h.status === "running" ? "途中" : "取り消し"} · {h.cursor}/{h.total} 件 · {users.get(h.startedBy) ?? "-"}
                    {h.status !== "running" && <> · <a href={`/api/maps/batch/report?job=${h.id}`} className="text-accent hover:underline">報告 (CSV)</a></>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {idx.duplicateKeys.size > 0 && (
          <Card>
            <CardHeader title="重複した場所" description="同じ番地の場所が 2 つ以上あります。場所の画面でまとめられます" />
            <ul className="space-y-1 text-xs">
              {[...idx.duplicateKeys.values()].slice(0, 50).map((list) => <li key={list[0].addressKey}>{list.map((l) => <Link key={l.id} href={`/maps/locations/${l.id}`} className="mr-2 text-accent hover:underline">{l.address}</Link>)}</li>)}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title="最近の住宅地図" />
          {recent.length === 0 ? <p className="text-xs text-ink-3">まだ登録されていません。</p> : (
            <ul className="space-y-1 text-xs">
              {recent.map((d) => {
                const locId = (idx.locationsByDoc.get(d.id) ?? [])[0];
                return <li key={d.id}>{locId ? <Link href={`/maps/locations/${locId}`} className="text-accent hover:underline">{d.title}</Link> : d.title} <span className="text-ink-3">{d.status === "active" ? "" : d.status === "replaced" ? "(差し替え済み) " : "(取り消し) "}{users.get(d.uploadedBy) ?? "-"} {fmtDateTime(d.uploadedAt)}</span></li>;
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
