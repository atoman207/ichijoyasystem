import type { Metadata } from "next";
import { ImagePlus } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { lineGroupsFor } from "@/lib/line-groups";
import { pendingLinePhotos } from "@/lib/line-photos";
import { attachLinePhotosToOrder, dismissLinePhotos } from "@/lib/actions/line-photos";
import { LinePhotoChecks } from "@/components/case-posts/CasePostParts";
import { Button, Card, CardHeader, EmptyState, Field, Flash, Input, Note, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "LINE の施工事例写真" };

/** LINE の「施工事例写真」グループに届いた写真を、受注 (案件) の写真に付ける・対象外にする (src/lib/line-photos.ts) */
export default async function LineCasePhotosPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const items = pendingLinePhotos(db, user, "photos");
  const groups = lineGroupsFor(db, "photos");
  const back = `/materials/cases/line${sp.order ? `?order=${encodeURIComponent(sp.order)}` : ""}`;
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="LINE の施工事例写真"
        icon={<ImagePlus />}
        description="LINE の「施工事例写真」グループに届いた写真のうち、まだ案件に付けていないものです。写真を選び、受注番号を入れて「案件に付ける」を押すと、その案件の「現場写真・資料」に保存し、施工事例の投稿で使えるようになります"
        back={{ href: "/materials?tab=cases", label: "施工事例の投稿" }}
      />
      {groups.length === 0 && <Note tone="warn">「施工事例写真」の用途の LINE グループがまだありません。管理者が 設定 → 外部連携・AI の「LINE グループ」で、社内の施工事例写真のグループの用途を「施工事例写真」にしてください。</Note>}
      {items.length === 0 ? (
        <EmptyState title="案件に付けていない写真はありません" description="グループに写真が届くと、ここに並びます (このサーバーに保存し、300 件まで残します)" icon={<ImagePlus />} />
      ) : (
        <form className="space-y-4">
          <input type="hidden" name="returnTo" value={back} />
          <Card>
            <CardHeader title={`写真 (${items.length} 枚)`} description="付ける写真を選んでください (1 回に 20 枚まで)。同じ案件の写真をまとめて選べます" />
            <LinePhotoChecks items={items.slice(0, 120)} stores={db.stores} />
          </Card>
          <Card>
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-[1fr_auto] @3xl:items-end">
              <Field label="付ける案件 (受注番号)" hint="受注・施工の画面の番号 (例: O-2026-0012)"><Input name="orderRef" defaultValue={sp.order ?? ""} placeholder="O-2026-…" /></Field>
              <Button type="submit" formAction={attachLinePhotosToOrder}>選んだ写真を案件に付ける</Button>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 border-t border-line pt-3 @3xl:grid-cols-[1fr_auto] @3xl:items-end">
              <Field label="対象外にする理由 (任意)"><Input name="reason" placeholder="例: 施工事例に使わない写真" /></Field>
              <Button type="submit" formAction={dismissLinePhotos} variant="ghost">選んだ写真を対象外にする</Button>
            </div>
          </Card>
        </form>
      )}
    </div>
  );
}
