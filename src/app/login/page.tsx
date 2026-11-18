import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser, safeNext } from "@/lib/auth/session";
import { hasReviewAccess, REVIEW_ACCOUNTS } from "@/lib/auth/review";
import { reviewLogin } from "@/lib/actions/auth";
import { ROLE_LABEL } from "@/lib/constants";
import { LoginForm, PlainLoginForm, type LoginAccount } from "@/components/features/LoginForm";
import { PublicShell } from "@/components/brand/PublicShell";
import { LogIn } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import Link from "@/components/ui/Link";

export const metadata: Metadata = { title: "ログイン" };
export const dynamic = "force-dynamic";

/** 社員のログイン。ホームとは分け、入力に集中できるシンプルな画面にする */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; err?: string }> }) {
  const { next: rawNext, err } = await searchParams;
  const next = safeNext(rawNext);
  if (await getSessionUser()) redirect(next);
  const db = await syncDb();
  const accounts: LoginAccount[] = db.users
    .filter((u) => u.active && u.password)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, password: u.password!, role: u.role, storeId: u.storeId, title: u.title }));
  const demo = accounts.length > 0;
  const review = !demo && (await hasReviewAccess());
  const stores = db.stores.map((s) => ({ id: s.id, name: s.name, color: s.color, address: s.address }));
  const storeMap = new Map(db.stores.map((s) => [s.id, s.name]));

  return (
    <PublicShell current="login">
      <div className="mx-auto flex max-w-md flex-col pt-2 sm:pt-6">
        <PageHeader
          icon={<LogIn />}
          title="ログイン"
          description={demo ? "テスト用: ロールと店舗を選ぶと、ログイン ID とパスワードが自動で入ります。" : "社員のログイン ID とパスワードを入力してください。"}
        />

        <Card className="sm:p-6">
          {err && (
            <p role="alert" className="mb-4 rounded-xl border border-critical/30 bg-critical/5 px-4 py-3 text-sm text-critical-ink">
              {err}
            </p>
          )}
          {review && (
            <div className="mb-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
              <h2 className="text-sm font-semibold">確認用ログイン</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-2">
                ロールを選ぶと、パスワードなしでその権限の画面に入れます。社員のアカウントには影響しません。
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {REVIEW_ACCOUNTS.map((a) => (
                  <form key={a.id} action={reviewLogin.bind(null, a.id)}>
                    <button
                      type="submit"
                      className="flex w-full flex-col items-start rounded-xl border border-line bg-panel px-3 py-2.5 text-left transition hover:border-accent hover:bg-accent/5 focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25"
                    >
                      <span className="text-sm font-semibold">{a.label}としてログイン</span>
                      <span className="mt-0.5 text-[11px] leading-snug text-ink-3">{a.desc}</span>
                    </button>
                  </form>
                ))}
              </div>
              <p className="mt-3 text-xs text-ink-3">社員アカウントで入る場合は、下のフォームを使ってください。</p>
            </div>
          )}
          {demo ? <LoginForm accounts={accounts} stores={stores} next={next} /> : <PlainLoginForm next={next} />}
          <div className="mt-4 space-y-2 border-t border-line pt-4 text-xs text-ink-3">
            <p>パスワードを忘れた場合は、管理者または店長にお問い合わせください。</p>
            <p>
              アカウントをお持ちでない方は{" "}
              <Link href="/signup" className="font-medium text-accent hover:underline">
                新規登録
              </Link>
            </p>
          </div>
        </Card>

        {demo && (
          <details className="group mt-4 rounded-2xl border border-line/70 bg-panel text-ink shadow-card">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3 text-sm font-medium select-none">
              <span className="whitespace-nowrap">テスト用アカウント一覧 ({accounts.length} 名)</span>
              <span className="text-xs text-ink-3">
                パスワードは共通: <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink">{accounts[0]?.password}</code>
              </span>
            </summary>
            <div className="max-h-72 overflow-auto border-t border-line">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-subtle/70 text-left text-[11px] text-ink-2">
                    <th className="px-4 py-2 font-semibold">ロール</th>
                    <th className="px-3 py-2 font-semibold">氏名 / 所属</th>
                    <th className="px-4 py-2 font-semibold">メール</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="px-4 py-1.5 whitespace-nowrap text-ink-2">{ROLE_LABEL[a.role]}</td>
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{a.name}</div>
                        <div className="text-[11px] text-ink-3">{storeMap.get(a.storeId)} · {a.title}</div>
                      </td>
                      <td className="px-4 py-1.5 font-mono text-[11px] text-ink-2">{a.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        <p className="mt-8 text-center text-xs text-ink-3">
          <Link href="/home" className="hover:text-ink hover:underline">
            ← ホームに戻る
          </Link>
        </p>
      </div>
    </PublicShell>
  );
}
