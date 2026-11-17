import type { Metadata } from "next";
import {
  ArrowRight,
  Bot,
  Building,
  CalendarDays,
  ChartColumn,
  CircleCheck,
  ClipboardCheck,
  FileText,
  Hammer,
  History,
  Inbox,
  Landmark,
  LockKeyhole,
  MessagesSquare,
  Receipt,
  ScanLine,
  ShieldCheck,
  Store,
  UserPlus,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser, safeNext } from "@/lib/auth/session";
import { hasReviewAccess, REVIEW_ACCOUNTS } from "@/lib/auth/review";
import { reviewLogin } from "@/lib/actions/auth";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import type { Role } from "@/lib/db/types";
import { LoginForm, PlainLoginForm, type LoginAccount } from "@/components/features/LoginForm";
import { PublicShell } from "@/components/brand/PublicShell";
import Link from "@/components/ui/Link";

export const metadata: Metadata = { title: { absolute: "一畳屋 統合業務システム" } };
export const dynamic = "force-dynamic";

/** 業務の流れ (どの段階の記録も ID でつながる) */
const FLOW = [
  { icon: Inbox, title: "問い合わせ", desc: "電話・LINE・Web・AI 受付をまとめて登録し、担当者を決める" },
  { icon: FileText, title: "見積", desc: "手書きの見積書も読み取り、金額は承認を経て確定" },
  { icon: Hammer, title: "受注・施工", desc: "採寸・引き取り・施工の日程と担当職人を予定表へ" },
  { icon: ChartColumn, title: "売上", desc: "店舗別・担当者別の売上をその場で集計" },
  { icon: Receipt, title: "請求", desc: "請求書を発行し、お客様へ PDF のリンクを送付" },
  { icon: Wallet, title: "入金", desc: "入金を消し込み、未入金・期日超過を知らせる" },
];

const FEATURES = [
  { icon: CalendarDays, title: "全社の予定表", desc: "全社員・全店舗の予定を一つのカレンダーで共有。案件の現地調査・施工は担当者の予定に自動で入り、重複も知らせます。" },
  { icon: Users, title: "顧客と案件の一元管理", desc: "お客様ごとに問い合わせ・見積・施工・請求・やりとりの履歴を時系列で表示。どの画面からも前後の記録へ移れます。" },
  { icon: ClipboardCheck, title: "承認のワークフロー", desc: "見積・契約・経費など金額に関わる変更は、店長・管理者の承認を経て反映。差戻し・却下も記録に残ります。" },
  { icon: ChartColumn, title: "経営ダッシュボード", desc: "売上・受注・施工・請求・経費を期間・店舗・担当者で比較。CSV でも取り出せます。" },
  { icon: ScanLine, title: "紙の書類をデータに", desc: "手書きの見積書・図面・レシート・アンケートはがきを写真で読み取り、入力の手間を減らします。" },
  { icon: Bot, title: "AI アシスタント", desc: "顧客・案件の検索、社内資料に基づく回答、お客様へのご案内文の作成を手伝います。" },
  { icon: MessagesSquare, title: "LINE・Chatwork・メール連携", desc: "現場ごとの LINE グループの写真を自動で保存。承認依頼やメンションは Chatwork・メールでも届きます。" },
  { icon: Landmark, title: "経理と会計データ", desc: "経費精算・仕入・現金出納帳を記録し、会計ソフトに取り込める仕訳を出力します。" },
];

const ROLE_ICON: Record<Role, React.ComponentType<{ className?: string }>> = {
  admin: UserRound,
  hq_staff: Building,
  store_manager: Store,
  store_staff: Users,
};

const ROLE_ACCOUNT: Record<Role, string> = {
  admin: "すべてのアカウントの追加・削除・権限の変更",
  hq_staff: "自分のアカウントの管理",
  store_manager: "自店舗のスタッフのアカウントの追加・削除・申請の承認",
  store_staff: "自分のアカウントの管理",
};

const SECURITY = [
  { icon: LockKeyhole, title: "権限で見える範囲を制限", desc: "店舗のスタッフは自店舗の情報だけ。ロールごとに操作できる内容が決まっています。" },
  { icon: History, title: "すべての変更を記録", desc: "誰が・いつ・何を変えたかを、変更前と変更後の値とともに残します。" },
  { icon: ShieldCheck, title: "金額は承認を経て反映", desc: "見積・契約・支払いに関わる変更は、承認されるまで確定しません。" },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; err?: string }> }) {
  const { next: rawNext, err } = await searchParams;
  const next = safeNext(rawNext);
  // ログイン済みならそのまま移動する (期限切れ・無効な Cookie のときはこの画面を表示)
  if (await getSessionUser()) redirect(next);
  const db = await syncDb();
  // テスト用アカウントの一覧は、平文パスワードを持つサンプルデータのときだけ表示する (本番データでは表示しない)
  const accounts: LoginAccount[] = db.users
    .filter((u) => u.active && u.password)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, password: u.password!, role: u.role, storeId: u.storeId, title: u.title }));
  const demo = accounts.length > 0;
  // 確認用リンクを開いた端末: ロールのボタンでパスワードなしでログインできる (本番データのとき)
  const review = !demo && (await hasReviewAccess());
  const stores = db.stores.map((s) => ({ id: s.id, name: s.name, color: s.color, address: s.address }));
  const storeMap = new Map(db.stores.map((s) => [s.id, s.name]));

  return (
    <PublicShell current="login">
      {/* ヒーロー: システムの説明とログイン */}
      <section className="relative overflow-hidden bg-linear-to-br from-accent-strong via-[#3a46c9] to-[#6a78f0] text-white">
        <div className="tatami-pattern absolute inset-0 opacity-80" aria-hidden />
        <div className="absolute -top-24 -right-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 -left-16 h-72 w-72 rounded-full bg-black/10 blur-3xl" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:py-16">
          <div className="max-w-xl self-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs ring-1 ring-white/20">
              株式会社一畳屋 · 社員専用の業務システム
            </span>
            <h1 className="mt-5 text-[30px] leading-tight font-semibold tracking-tight sm:text-[40px]">
              畳・内装の仕事を、
              <br />
              問い合わせから入金まで一つの画面で。
            </h1>
            <p className="mt-5 text-sm leading-relaxed text-white/85 sm:text-base">
              一畳屋 統合業務システムは、合志・中央・西・玉名の各店舗と本社の社員が、お客様の情報・見積・工事の予定・請求をみんなで同じ最新の状態で扱うための仕組みです。
              紙やスプレッドシート、電話のメモに分かれていた情報を一か所に集め、誰が見ても「いま、どの案件が、どこまで進んでいるか」が分かります。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a href="#login" className="inline-flex h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-medium text-accent-strong shadow-sm hover:bg-white/90">
                ログイン <ArrowRight className="h-4 w-4" />
              </a>
              <Link href="/signup" className="inline-flex h-11 items-center gap-2 rounded-xl bg-white/10 px-5 text-sm font-medium ring-1 ring-white/30 hover:bg-white/20">
                <UserPlus className="h-4 w-4" /> 新規登録 (社員の方)
              </Link>
            </div>
            <dl className="mt-8 grid max-w-lg grid-cols-3 gap-3 text-center">
              {[
                ["5", "拠点 (4 店舗 + 本社)"],
                ["6", "工程を ID でつなぐ"],
                ["4", "種類の権限"],
              ].map(([n, l]) => (
                <div key={l} className="rounded-xl bg-white/10 px-2 py-3 ring-1 ring-white/15">
                  <dt className="sr-only">{l}</dt>
                  <dd className="text-2xl font-semibold tnum">{n}</dd>
                  <dd className="mt-0.5 text-[11px] text-white/75">{l}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* ログイン */}
          <div id="login" className="scroll-mt-20">
            <div className="rounded-2xl bg-panel p-5 text-ink shadow-xl ring-1 ring-black/5 sm:p-6">
              <h2 className="text-xl font-semibold tracking-tight">ログイン</h2>
              <p className="mt-1 mb-4 text-sm text-ink-2">
                {demo ? "テスト用: ロールと店舗を選ぶと、メールアドレスとパスワードが自動で入力されます。" : "社員ごとのログイン ID とパスワードを入力してください。"}
              </p>
              {err && (
                <p role="alert" className="mb-4 rounded-xl border border-critical/30 bg-critical/5 px-4 py-3 text-sm text-critical-ink">
                  {err}
                </p>
              )}
              {review && (
                <div className="mb-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
                  <h3 className="text-sm font-semibold">確認用ログイン</h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-2">
                    ロールを選ぶと、パスワードを入力せずにその権限の画面に入れます。確認用のアカウントで操作するため、社員のアカウントには影響しません。
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
                  <p className="mt-3 text-xs text-ink-3">社員のアカウントでログインする場合は、下にログイン ID とパスワードを入力してください。</p>
                </div>
              )}
              {demo ? <LoginForm accounts={accounts} stores={stores} next={next} /> : <PlainLoginForm next={next} />}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-ink-3">
                <span>パスワードを忘れた場合は、管理者または店長にお問い合わせください。</span>
                <Link href="/signup" className="font-medium text-accent hover:underline">新規登録 →</Link>
              </div>
            </div>

            {demo && (
              <details className="group mt-4 rounded-2xl bg-panel text-ink shadow-card">
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
          </div>
        </div>
      </section>

      {/* 業務の流れ */}
      <section id="about" className="scroll-mt-16 border-b border-line bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="システムについて" title="ひとつのお仕事を、最初から最後までつなげて管理">
            お客様からのお問い合わせを受けてから、工事を終えて代金をいただくまでの記録を、すべて同じ番号 (ID) でつなげています。
            担当が替わっても、店舗が違っても、前後の経緯をすぐにたどれます。
          </SectionTitle>
          <ol className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {FLOW.map((f, i) => (
              <li key={f.title} className="relative rounded-2xl border border-line bg-canvas p-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">{i + 1}</span>
                  <f.icon className="h-4 w-4 text-accent" aria-hidden />
                </div>
                <div className="mt-3 text-sm font-semibold text-ink">{f.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-ink-2">{f.desc}</p>
                {i < FLOW.length - 1 && <ArrowRight className="absolute top-1/2 -right-2.5 hidden h-4 w-4 -translate-y-1/2 text-line-strong lg:block" aria-hidden />}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 主な機能 */}
      <section id="features" className="scroll-mt-16">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="主な機能" title="現場・店舗・本社の仕事を、それぞれの画面で">
            スマートフォンでも使えます。現場では写真と予定、店舗では見積と顧客対応、本社では承認と経営数値を中心に使います。
          </SectionTitle>
          <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-2xl bg-panel p-5 shadow-card ring-1 ring-line/60">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <f.icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 text-sm font-semibold text-ink">{f.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{f.desc}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 権限と新規登録 */}
      <section id="roles" className="scroll-mt-16 border-y border-line bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="権限" title="役割に合わせて、見える情報とできる操作を分けています">
            新規登録のときに自分の役割を選んで申請します。管理者 (店舗スタッフは所属店舗の店長も) が承認すると使えるようになります。
          </SectionTitle>
          <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(["admin", "hq_staff", "store_manager", "store_staff"] as Role[]).map((r) => {
              const Icon = ROLE_ICON[r];
              return (
                <li key={r} className="rounded-2xl border border-line bg-canvas p-5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-panel text-accent shadow-xs">
                      <Icon className="h-4.5 w-4.5" aria-hidden />
                    </span>
                    <h3 className="text-sm font-semibold text-ink">{ROLE_LABEL[r]}</h3>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-ink-2">{ROLE_DESCRIPTION[r]}</p>
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-3">
                    <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" aria-hidden />
                    アカウント: {ROLE_ACCOUNT[r]}
                  </p>
                </li>
              );
            })}
          </ul>

          <div className="mt-10 grid grid-cols-1 gap-4 rounded-2xl bg-accent-soft p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div>
              <h3 className="text-base font-semibold text-accent-ink">新規登録の流れ</h3>
              <ol className="mt-3 grid grid-cols-1 gap-3 text-sm text-ink sm:grid-cols-3">
                {[
                  ["申請", "氏名・ログイン ID・パスワード・希望する役割と所属を入力"],
                  ["承認", "管理者 (店舗スタッフは所属店舗の店長も) が内容を確かめて承認"],
                  ["ログイン", "登録したログイン ID とパスワードで使い始める"],
                ].map(([t, d], i) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">{i + 1}</span>
                    <span>
                      <span className="block font-medium">{t}</span>
                      <span className="block text-xs text-ink-2">{d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <Link href="/signup" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover">
              <UserPlus className="h-4 w-4" /> 新規登録を申請する
            </Link>
          </div>
        </div>
      </section>

      {/* 安全性と拠点 */}
      <section>
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-14 sm:px-6 lg:grid-cols-2">
          <div>
            <SectionTitle eyebrow="安心して使うために" title="大切なお客様の情報を守ります" />
            <ul className="mt-6 space-y-3">
              {SECURITY.map((s) => (
                <li key={s.title} className="flex items-start gap-3 rounded-2xl bg-panel p-4 shadow-card ring-1 ring-line/60">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-good-soft text-good-ink">
                    <s.icon className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-ink">{s.title}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{s.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <SectionTitle eyebrow="対象拠点" title="熊本の 4 店舗と本社で使っています" />
            <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {stores.map((s) => (
                <li key={s.id} className="rounded-2xl bg-panel p-4 shadow-card ring-1 ring-line/60">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
                    {s.name}
                  </div>
                  {s.address && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{s.address}</p>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="max-w-3xl">
      <div className="text-xs font-semibold tracking-wide text-accent">{eyebrow}</div>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h2>
      {children && <p className="mt-3 text-sm leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}
