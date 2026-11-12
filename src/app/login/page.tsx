import type { Metadata } from "next";
import { ChartColumn, ClipboardCheck, Layers, Sparkles } from "lucide-react";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser, safeNext } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/constants";
import { LoginForm, PlainLoginForm, type LoginAccount } from "@/components/features/LoginForm";
import { IchijoyaLogo } from "@/components/brand/Logo";

export const metadata: Metadata = { title: "ログイン" };
export const dynamic = "force-dynamic";

const FEATURES = [
  { icon: Layers, title: "一つの基盤に集約", desc: "顧客・問い合わせ・見積・受注・施工・請求・入金を ID で連結" },
  { icon: ClipboardCheck, title: "承認と変更履歴", desc: "金額・契約は承認を経て反映。変更前の値も残る" },
  { icon: ChartColumn, title: "リアルタイムの経営把握", desc: "店舗別・担当者別・期間別のダッシュボード" },
  { icon: Sparkles, title: "AI で紙と電話をデータに", desc: "手書き見積・レシートの読取、AI 電話受付、文面作成" },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  // ログイン済みならそのまま移動する (期限切れ・無効な Cookie のときはログイン画面を表示)
  if (await getSessionUser()) redirect(next);
  const db = await syncDb();
  // テスト用アカウントの一覧は、平文パスワードを持つサンプルデータのときだけ表示する (本番データでは表示しない)
  const accounts: LoginAccount[] = db.users
    .filter((u) => u.active && u.password)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, password: u.password!, role: u.role, storeId: u.storeId, title: u.title }));
  const demo = accounts.length > 0;
  const stores = db.stores.map((s) => ({ id: s.id, name: s.name, color: s.color }));
  const storeMap = new Map(db.stores.map((s) => [s.id, s.name]));

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* ブランド面 */}
      <section className="relative overflow-hidden bg-linear-to-br from-accent-strong via-[#3a46c9] to-[#6a78f0] text-white">
        <div className="tatami-pattern absolute inset-0 opacity-80" aria-hidden />
        <div className="absolute -top-24 -right-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 -left-16 h-72 w-72 rounded-full bg-black/10 blur-3xl" aria-hidden />
        <div className="relative flex h-full flex-col px-6 py-8 sm:px-10 lg:px-14 lg:py-12">
          <div className="flex items-center gap-4">
            <IchijoyaLogo variant="white" title="株式会社一畳屋" className="h-9 w-auto sm:h-10" />
            <div className="border-l border-white/25 pl-4 text-xs leading-snug text-white/75">
              株式会社一畳屋
              <br />
              統合業務システム
            </div>
          </div>

          <div className="mt-8 max-w-md lg:mt-16">
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight sm:text-[34px]">
              会社全体の情報を、
              <br />
              一つの基盤に。
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-white/80">
              問い合わせ → 見積 → 受注・施工 → 売上 → 請求 → 入金 を ID で連結。どの店舗・どの担当者が更新しても、全員が同じ最新情報を見られます。
            </p>
          </div>

          <ul className="mt-8 hidden max-w-lg gap-3 sm:grid sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-3 rounded-xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur-sm">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15">
                  <f.icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{f.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-white/70">{f.desc}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-auto hidden pt-10 lg:block">
            <div className="text-[11px] font-medium tracking-wide text-white/60">対象拠点</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {stores.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs ring-1 ring-white/15">
                  <span className="h-2 w-2 rounded-full ring-2 ring-white/40" style={{ background: s.color }} aria-hidden />
                  {s.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ログインフォーム */}
      <section className="flex items-start justify-center px-4 py-8 sm:px-8 lg:items-center lg:py-12">
        <div className="w-full max-w-xl">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold tracking-tight text-ink">ログイン</h2>
            <p className="mt-1 text-sm text-ink-2">
              {demo ? "テスト用: ロールと店舗を選ぶと、メールアドレスとパスワードが自動で入力されます。" : "社員ごとのログイン ID とパスワードを入力してください。"}
            </p>
          </div>
          <div className="rounded-2xl border border-line/70 bg-panel p-5 shadow-card sm:p-6">
            {demo ? <LoginForm accounts={accounts} stores={stores} next={next} /> : <PlainLoginForm next={next} />}
          </div>

          {!demo && (
            <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
              パスワードを忘れた場合は管理者にお問い合わせください。この画面のアドレスとログイン情報は社外に共有しないでください。
            </p>
          )}

          {demo && (
          <details className="group mt-4 rounded-2xl border border-line/70 bg-panel shadow-card">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3 text-sm font-medium text-ink select-none">
              <span className="whitespace-nowrap">テスト用アカウント一覧 ({accounts.length} 名)</span>
              <span className="text-xs text-ink-3">
                パスワードは共通: <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink">{accounts[0]?.password}</code>
              </span>
            </summary>
            <div className="overflow-x-auto border-t border-line">
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
                        <div className="font-medium text-ink">{a.name}</div>
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

          {demo && (
            <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
              これは機能検証用のデモ環境です。すべてのデータは架空のサンプルで、ログイン情報はテスト用にあらかじめ入力されています。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
