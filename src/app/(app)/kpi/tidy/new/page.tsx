import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canRecordTidyCheck } from "@/lib/auth/permissions";
import { createTidyCheck } from "@/lib/actions/tidy";
import { pendingLinePhotos } from "@/lib/line-photos";
import { postTablesReady } from "@/lib/posts-tables";
import { TidyForm } from "@/components/tidy/TidyForm";
import { Flash, Note, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "整理整頓チェックを記録する" };

export default async function NewTidyCheckPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  if (!db.stores.some((s) => canRecordTidyCheck(user, s.id))) redirect(`/kpi/tidy?err=${encodeURIComponent("整理整頓チェックを記録する権限がありません。")}`);
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="整理整頓チェックを記録する" description="項目ごとに 良い / 要改善 / 対象外 を選びます。要改善は内容と直す期限を入れると、直すまで一覧に残ります。写真は記録のあとの画面で追加できます" back={{ href: "/kpi/tidy", label: "整理整頓" }} />
      {!postTablesReady(["tidy_checks"]) && <Note tone="warn">整理整頓チェックの表 (tidy_checks) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するまで記録できません。</Note>}
      <TidyForm db={db} user={user} action={createTidyCheck} linePhotos={pendingLinePhotos(db, user, "tidy")} submitLabel="記録する" />
    </div>
  );
}
