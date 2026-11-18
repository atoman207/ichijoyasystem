import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser } from "@/lib/auth/session";
import { PublicShell } from "@/components/brand/PublicShell";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: { absolute: "一畳屋 統合業務システム" } };
export const dynamic = "force-dynamic";

const STORE_PHOTO: Record<string, string> = {
  koshi: "/brand/stores/koshi.webp",
  chuo: "/brand/stores/chuo.webp",
  nishi: "/brand/stores/nishi.webp",
  tamana: "/brand/stores/tamana.webp",
  hq: "/brand/stores/hq.webp",
};

export default async function HomePage() {
  if (await getSessionUser()) redirect("/");
  const db = await syncDb();

  return (
    <PublicShell current="home">
      <PageHeader eyebrow="社員専用" title="店舗一覧" description="各拠点の写真" />

      <Card id="stores" padded={false} className="mt-4 overflow-hidden">
        <ul className="grid grid-cols-1 gap-0 @3xl:grid-cols-2">
          {db.stores.map((s) => (
            <li key={s.id} className="relative overflow-hidden border border-line/70 bg-subtle">
              {/* eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル (最適化済みの WebP) */}
              <img src={STORE_PHOTO[s.id]} alt={`${s.name}の外観`} loading="lazy" className="aspect-[2.4/1] w-full object-cover" />
              <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-panel/95 px-2.5 py-0.5 text-xs font-semibold text-ink">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                {s.name}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </PublicShell>
  );
}
