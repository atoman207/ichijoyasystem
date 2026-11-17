import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser } from "@/lib/auth/session";
import { PublicShell } from "@/components/brand/PublicShell";
import { SignupForm } from "@/components/features/SignupForm";

export const metadata: Metadata = { title: "新規登録" };
export const dynamic = "force-dynamic";

/** 社員の新規登録 (申請)。承認されるまでログインできない */
export default async function SignupPage() {
  if (await getSessionUser()) redirect("/");
  const db = await syncDb();
  const stores = db.stores.map((s) => ({ id: s.id, name: s.name, color: s.color }));
  return (
    <PublicShell current="signup">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:py-14">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">新規登録</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            一畳屋の社員の方は、ここからアカウントを申請できます。自分の役割 (ロール) と所属を選んでください。
          </p>
          <ol className="mt-6 space-y-3 text-sm">
            {[
              ["申請する", "この画面で氏名・ログイン ID・パスワード・役割・所属を入力します。"],
              ["承認を待つ", "店舗スタッフは所属店舗の店長または管理者、店長・本部スタッフ・管理者は管理者が承認します。"],
              ["ログインする", "承認されたら、登録したログイン ID とパスワードでログインします。"],
            ].map(([t, d], i) => (
              <li key={t} className="flex items-start gap-3 rounded-2xl bg-panel p-4 shadow-card ring-1 ring-line/60">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">{i + 1}</span>
                <span>
                  <span className="block font-medium text-ink">{t}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{d}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-[11px] leading-relaxed text-ink-3">
            お客様・取引先の方の登録はできません。工事のご相談は各店舗へお問い合わせください。
          </p>
        </div>
        <div className="rounded-2xl bg-panel p-5 shadow-card ring-1 ring-line/60 sm:p-6">
          <SignupForm stores={stores} />
        </div>
      </div>
    </PublicShell>
  );
}
