import type { Metadata } from "next";
import {
  ArrowRight,
  Bot,
  Building,
  CalendarDays,
  CalendarX2,
  ChartColumn,
  CircleCheck,
  ClipboardCheck,
  CloudUpload,
  Database,
  Eye,
  FileSpreadsheet,
  FileText,
  Hammer,
  History,
  Inbox,
  KeyRound,
  Landmark,
  Layers,
  LockKeyhole,
  MessageCircle,
  MessagesSquare,
  MonitorSmartphone,
  PenLine,
  Phone,
  Receipt,
  ScanLine,
  ShieldCheck,
  Signature,
  Store,
  UserPlus,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser } from "@/lib/auth/session";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import type { Role, StoreId } from "@/lib/db/types";
import { PublicShell } from "@/components/brand/PublicShell";
import { HeroCarousel, type HeroSlide } from "@/components/brand/HeroCarousel";
import Link from "@/components/ui/Link";

export const metadata: Metadata = { title: { absolute: "一畳屋 統合業務システム" } };
export const dynamic = "force-dynamic";

/** このシステムが解決する課題 (これまで → これから) と、それを支える仕組み */
const ISSUES = [
  {
    icon: Layers,
    before: "お客様の情報が、紙の台帳・Excel・LINE・電話のメモにバラバラ",
    after: "すべて 1 つのデータベースに集約。問い合わせから入金までを同じ番号でつなぐ",
    tech: "統合データベース · ID で記録を連結",
  },
  {
    icon: Eye,
    before: "「あの案件、いまどうなってる？」を電話で聞いて回る",
    after: "見積・工事日程・請求・入金の状態が記録から自動で決まり、誰でも一覧で分かる",
    tech: "案件の状態を自動判定",
  },
  {
    icon: CalendarX2,
    before: "予定のダブルブッキング、伝え漏れ",
    after: "全社共通の予定表。担当者の予定が重なると、その場で赤く知らせる",
    tech: "重複の自動検出 · 通知",
  },
  {
    icon: Wallet,
    before: "請求のし忘れ、入金の確認漏れ",
    after: "未請求・未入金・支払期限の超過を自動で抜き出して知らせる",
    tech: "売掛の自動集計 · 期日アラート",
  },
  {
    icon: Signature,
    before: "金額の承認が口頭で、あとから経緯が分からない",
    after: "金額に応じて承認者が自動で決まり、誰が・いつ・何を承認したか残る",
    tech: "承認ワークフロー · 変更前後の履歴",
  },
  {
    icon: PenLine,
    before: "手書きの見積書やレシートを、もう一度パソコンに打ち込む",
    after: "写真を撮るだけで AI が読み取り。人が確かめてから登録する",
    tech: "AI 文字認識 + 人の確認",
  },
];

/** 仕組みの図: 入口 → 統合データベース → 使う場面 */
const INPUTS = [
  { icon: Phone, label: "電話・来店" },
  { icon: MessageCircle, label: "LINE・Chatwork" },
  { icon: Inbox, label: "Web フォーム・AI 受付" },
  { icon: ScanLine, label: "紙の書類 (写真)" },
];
const CORE = ["顧客", "問い合わせ", "見積", "受注・施工", "予定", "請求・入金", "経費・仕入", "承認", "変更履歴"];
const OUTPUTS = [
  { icon: MonitorSmartphone, label: "スマホ・PC の画面" },
  { icon: ChartColumn, label: "経営ダッシュボード" },
  { icon: FileSpreadsheet, label: "会計データ (CSV)" },
  { icon: FileText, label: "見積書・請求書 PDF" },
];

/** 強み (技術の言葉を、仕事の言葉で) */
const STRENGTHS = [
  { icon: Database, big: "1 か所", title: "情報はいつも最新・ひとつだけ", desc: "全店舗が同じデータを見るので、「どれが最新？」が起きません。", tech: "Single Source of Truth" },
  { icon: KeyRound, big: "4 × 5", title: "役割と店舗で見える範囲を制御", desc: "4 つの役割と 5 つの拠点の組み合わせで、必要な情報だけを表示します。", tech: "ロールベースのアクセス制御" },
  { icon: History, big: "すべて", title: "誰が・いつ・何を変えたか残る", desc: "登録・変更・承認は、変更前と変更後の値つきで記録されます。", tech: "監査ログ" },
  { icon: CloudUpload, big: "毎日", title: "自動バックアップと暗号化通信", desc: "毎日 3:30 にデータと写真を自動で保存。通信は HTTPS で暗号化します。", tech: "定期バックアップ · TLS" },
  { icon: Bot, big: "左下", title: "分からないことはチャットで質問", desc: "よくある質問は蓄えた回答で即答し、初めての質問だけ AI が答えます。", tech: "データベース優先の AI" },
  { icon: MonitorSmartphone, big: "どこでも", title: "現場でもスマホでそのまま", desc: "写真の登録・予定の確認・承認を、現場からスマートフォンで行えます。", tech: "レスポンシブ設計" },
];

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

/** 店舗の写真 (公式サイトの会社・店舗案内の写真。public/brand/stores) */
const STORE_PHOTO: Record<string, string> = {
  koshi: "/brand/stores/koshi.webp",
  chuo: "/brand/stores/chuo.webp",
  nishi: "/brand/stores/nishi.webp",
  tamana: "/brand/stores/tamana.webp",
  hq: "/brand/stores/hq.webp",
};

/** ヒーローの背景 (4 店舗と本社の写真) と、写真ごとに表示する紹介文。5 秒ごとに切り替わる (HeroCarousel) */
const HERO_ADVANTAGES: { store: StoreId; title: string; text: string }[] = [
  {
    store: "koshi",
    title: "案件の進み具合が、一目で分かる",
    text: "問い合わせから見積・工事・請求・入金までを同じ番号でつなぎます。",
  },
  {
    store: "chuo",
    title: "4 店舗と本社で、同じ情報を見る",
    text: "どの店舗のお客様情報も、ほかの店舗や本社からすぐに確認できます。",
  },
  {
    store: "nishi",
    title: "紙の書類も、写真でそのまま登録",
    text: "手書きの見積書やレシートを撮るだけで、入力の手間を減らします。",
  },
  {
    store: "tamana",
    title: "予定の重なりを、その場で防ぐ",
    text: "全社の予定表で工事と調査を共有し、担当が重なるとすぐ知らせます。",
  },
  {
    store: "hq",
    title: "金額の変更は、承認してから確定",
    text: "だれが・いつ・何を変えたかを残し、安心して任せられます。",
  },
];

/** ログイン前の公開ホーム。ログインは /login、業務画面はログイン後の / */
export default async function HomePage() {
  if (await getSessionUser()) redirect("/");
  const db = await syncDb();
  const storeMap = new Map(db.stores.map((s) => [s.id, s.name]));
  const shops = db.stores.filter((s) => s.kind === "store");
  const hq = db.stores.find((s) => s.kind === "hq");
  const heroSlides: HeroSlide[] = HERO_ADVANTAGES.map((a) => ({ src: STORE_PHOTO[a.store], place: storeMap.get(a.store) ?? "", title: a.title, text: a.text }));

  return (
    <PublicShell current="home">
      <HeroCarousel
        slides={heroSlides}
        intro={
          <>
            <p className="font-maru text-base tracking-wide text-white/90 drop-shadow-sm sm:text-lg">株式会社一畳屋</p>
            <h1 className="mt-2 font-maru text-[2.5rem] leading-tight tracking-tight drop-shadow-sm sm:text-6xl">
              統合業務システム
            </h1>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-white/95 drop-shadow-sm sm:text-xl">
              問い合わせから入金まで、ひとつの画面で。
            </p>
          </>
        }
      />

      {/* 店舗 (公式サイトの写真) */}
      <section id="stores" className="scroll-mt-20 bg-wa-paper">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="対象拠点" title="熊本の 4 店舗と本社が、同じ情報でつながります">
            どの店舗で受けたお問い合わせも、ほかの店舗・本社からすぐに確認できます。予定表は全店舗で共有しています。
          </SectionTitle>
          <ul className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {shops.map((s) => (
              <li key={s.id} className="group overflow-hidden rounded-3xl bg-white shadow-card ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-lift">
                <div className="relative aspect-[2.4/1] overflow-hidden bg-wa-cream">
                  {STORE_PHOTO[s.id] && (
                    // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル (最適化済みの WebP)
                    <img src={STORE_PHOTO[s.id]} alt={`${s.name}の外観`} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  )}
                  <div className="absolute inset-0 bg-linear-to-t from-black/55 via-black/0 to-transparent" aria-hidden />
                  <span className="absolute bottom-3 left-4 rounded-full bg-white px-3.5 py-1 font-maru text-base text-wa-deep shadow-md">{s.name}</span>
                  <span className="absolute top-3 right-3 h-3 w-3 rounded-full ring-2 ring-white" style={{ background: s.color }} title="グラフ・予定表での店舗の色" aria-hidden />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 text-xs text-ink-2">
                  <span>〒{s.postalCode} {s.address}</span>
                  <a href={`tel:${s.phone.replace(/[^0-9]/g, "")}`} className="inline-flex items-center gap-1 font-medium text-wa-green hover:underline">
                    <Phone className="h-3.5 w-3.5" aria-hidden /> {s.phone}
                  </a>
                </div>
              </li>
            ))}
          </ul>
          {hq && (
            <div className="mt-5 grid grid-cols-1 overflow-hidden rounded-3xl bg-wa-deep text-white shadow-card sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="relative aspect-[2.4/1] sm:aspect-auto">
                {/* eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル */}
                <img src={STORE_PHOTO.hq} alt={`${hq.name}の外観`} loading="lazy" className="h-full w-full object-cover" />
              </div>
              <div className="relative p-6">
                <div className="tatami-weave absolute inset-0 opacity-50" aria-hidden />
                <div className="relative">
                  <div className="font-maru text-xs text-wa-yellow">本部</div>
                  <h3 className="mt-1 font-maru text-xl">{hq.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/85">
                    経理・承認・経営の数字を全店舗まとめて確認します。各店舗の見積・請求・入金も、本社からリアルタイムで見えます。
                  </p>
                  <p className="mt-3 text-xs text-white/70">
                    〒{hq.postalCode} {hq.address} · TEL {hq.phone}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 解決する課題 */}
      <section id="issues" className="scroll-mt-20 border-y border-black/5 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="このシステムが解決すること" title="毎日の「困った」を、仕組みで解決します">
            これまで人の記憶や電話・紙に頼っていた仕事を、データベースと自動の仕組みに置き換えました。左が「これまで」、右が「これから」です。
          </SectionTitle>
          <ul className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {ISSUES.map((it) => (
              <li key={it.before} className="overflow-hidden rounded-3xl bg-wa-cream ring-1 ring-black/5">
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                  <div className="p-5">
                    <div className="text-[11px] font-semibold tracking-wide text-wa-red">これまで</div>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{it.before}</p>
                  </div>
                  <div className="flex items-center justify-center px-1 max-sm:pb-1" aria-hidden>
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-wa-green text-white shadow-md">
                      <it.icon className="h-5 w-5" />
                    </span>
                  </div>
                  <div className="bg-white p-5">
                    <div className="text-[11px] font-semibold tracking-wide text-wa-green">これから</div>
                    <p className="mt-1.5 text-sm leading-relaxed font-medium text-ink">{it.after}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 border-t border-black/5 bg-white/60 px-5 py-2 text-[11px] text-ink-3">
                  <span className="rounded bg-wa-deep px-1.5 py-0.5 font-mono text-[10px] text-white">仕組み</span>
                  {it.tech}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 仕組みと強み */}
      <section id="about" className="relative scroll-mt-20 overflow-hidden bg-wa-deep text-white">
        <div className="tatami-weave absolute inset-0 opacity-70" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="仕組みと強み" title="入口はいろいろ、情報はひとつに" dark>
            電話・LINE・紙の書類など、どこから入った情報も 1 つのデータベースに集まり、必要な人の画面・帳票・会計データとして取り出せます。
          </SectionTitle>

          <div className="mt-10 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
            <DiagramColumn title="入口" items={INPUTS} />
            <div className="relative rounded-3xl bg-white p-5 text-ink shadow-xl">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green text-white">
                  <Database className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <div className="font-maru text-base text-wa-deep">一畳屋 統合データベース</div>
                  <div className="text-[11px] text-ink-3">すべての記録を ID でつなぎ、権限と履歴で守る</div>
                </div>
              </div>
              <ul className="mt-4 grid grid-cols-3 gap-2">
                {CORE.map((c) => (
                  <li key={c} className="rounded-xl bg-wa-cream px-2 py-2 text-center text-[11px] font-medium text-wa-deep ring-1 ring-wa-green/15">
                    {c}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap gap-1.5 text-[10px]">
                {["権限の確認", "承認", "変更の記録", "毎日のバックアップ"].map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-full bg-wa-green/10 px-2 py-0.5 text-wa-deep">
                    <CircleCheck className="h-3 w-3 text-wa-green" aria-hidden /> {t}
                  </span>
                ))}
              </div>
              <ArrowRight className="absolute top-1/2 -left-4 hidden h-5 w-5 -translate-y-1/2 text-wa-yellow lg:block" aria-hidden />
              <ArrowRight className="absolute top-1/2 -right-4 hidden h-5 w-5 -translate-y-1/2 text-wa-yellow lg:block" aria-hidden />
            </div>
            <DiagramColumn title="使う場面" items={OUTPUTS} />
          </div>

          <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STRENGTHS.map((s) => (
              <li key={s.title} className="rounded-3xl bg-white/8 p-5 ring-1 ring-white/15 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-wa-yellow text-wa-deep">
                    <s.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="font-maru text-2xl text-wa-yellow">{s.big}</span>
                </div>
                <h3 className="mt-4 font-maru text-base">{s.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-white/80">{s.desc}</p>
                <p className="mt-3 font-mono text-[10px] tracking-wide text-white/50 uppercase">{s.tech}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 業務の流れ */}
      <section id="flow" className="scroll-mt-20 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="業務の流れ" title="ひとつのお仕事を、最初から最後までつなげて管理">
            お客様からのお問い合わせを受けてから、工事を終えて代金をいただくまでの記録を、すべて同じ番号 (ID) でつなげています。
            担当が替わっても、店舗が違っても、前後の経緯をすぐにたどれます。
          </SectionTitle>
          <ol className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {FLOW.map((f, i) => (
              <li key={f.title} className="relative rounded-2xl border border-black/5 bg-wa-cream p-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wa-green font-maru text-[11px] text-white">{i + 1}</span>
                  <f.icon className="h-4 w-4 text-wa-green" aria-hidden />
                </div>
                <div className="mt-3 font-maru text-sm text-wa-deep">{f.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-ink-2">{f.desc}</p>
                {i < FLOW.length - 1 && <ArrowRight className="absolute top-1/2 -right-2.5 hidden h-4 w-4 -translate-y-1/2 text-wa-green/50 lg:block" aria-hidden />}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 主な機能 */}
      <section id="features" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="主な機能" title="現場・店舗・本社の仕事を、それぞれの画面で">
            スマートフォンでも使えます。現場では写真と予定、店舗では見積と顧客対応、本社では承認と経営数値を中心に使います。
          </SectionTitle>
          <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-3xl bg-white p-5 shadow-card ring-1 ring-black/5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-wa-green/10 text-wa-green">
                  <f.icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 font-maru text-sm text-wa-deep">{f.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{f.desc}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 権限と新規登録 */}
      <section id="roles" className="scroll-mt-20 border-y border-black/5 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <SectionTitle eyebrow="権限" title="役割に合わせて、見える情報とできる操作を分けています">
            新規登録のときに自分の役割を選んで申請します。管理者 (店舗スタッフは所属店舗の店長も) が承認すると使えるようになります。
            店舗ごとの担当者・顔写真つきの詳しい案内は{" "}
            <Link href="/roles" className="font-medium text-wa-green hover:underline">
              権限と担当
            </Link>
            のページで確認できます。
          </SectionTitle>
          <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(["admin", "hq_staff", "store_manager", "store_staff"] as Role[]).map((r) => {
              const Icon = ROLE_ICON[r];
              return (
                <li key={r} className="rounded-3xl border border-black/5 bg-wa-cream p-5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-wa-green shadow-xs">
                      <Icon className="h-4.5 w-4.5" aria-hidden />
                    </span>
                    <h3 className="font-maru text-sm text-wa-deep">{ROLE_LABEL[r]}</h3>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-ink-2">{ROLE_DESCRIPTION[r]}</p>
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-3">
                    <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-wa-green" aria-hidden />
                    アカウント: {ROLE_ACCOUNT[r]}
                  </p>
                </li>
              );
            })}
          </ul>

          <div className="mt-10 grid grid-cols-1 gap-4 rounded-3xl bg-wa-green/10 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div>
              <h3 className="font-maru text-base text-wa-deep">新規登録の流れ</h3>
              <ol className="mt-3 grid grid-cols-1 gap-3 text-sm text-ink sm:grid-cols-3">
                {[
                  ["申請", "氏名・ログイン ID・パスワード・希望する役割と所属を入力"],
                  ["承認", "管理者 (店舗スタッフは所属店舗の店長も) が内容を確かめて承認"],
                  ["ログイン", "登録したログイン ID とパスワードで使い始める"],
                ].map(([t, d], i) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-wa-green font-maru text-[11px] text-white">{i + 1}</span>
                    <span>
                      <span className="block font-medium">{t}</span>
                      <span className="block text-xs text-ink-2">{d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <Link href="/signup" className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-wa-green px-6 font-maru text-sm text-white shadow-md hover:bg-wa-deep">
              <UserPlus className="h-4 w-4" /> 新規登録を申請する
            </Link>
          </div>
        </div>
      </section>

      {/* 安全性 */}
      <section>
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-8 px-4 py-14 sm:px-6 lg:grid-cols-2">
          <div>
            <SectionTitle eyebrow="安心して使うために" title="大切なお客様の情報を守ります" />
            <ul className="mt-6 space-y-3">
              {SECURITY.map((s) => (
                <li key={s.title} className="flex items-start gap-3 rounded-2xl bg-white p-4 shadow-card ring-1 ring-black/5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-wa-green/10 text-wa-green">
                    <s.icon className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-maru text-sm text-wa-deep">{s.title}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{s.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <figure className="overflow-hidden rounded-3xl bg-white shadow-card ring-1 ring-black/5">
            {/* eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル */}
            <img src="/brand/intro.webp" alt="張り替えた畳の和室で遊ぶ子どもたち" loading="lazy" className="aspect-[1.43/1] w-full object-cover" />
            <figcaption className="px-5 py-3 font-maru text-xs text-wa-deep">いい畳で、お客様の暮らしを豊かに。その仕事を支える仕組みです。</figcaption>
          </figure>
        </div>
      </section>
    </PublicShell>
  );
}

function SectionTitle({ eyebrow, title, children, dark = false }: { eyebrow: string; title: string; children?: React.ReactNode; dark?: boolean }) {
  return (
    <div className="max-w-3xl">
      <div className={`inline-flex items-center gap-2 font-maru text-xs ${dark ? "text-wa-yellow" : "text-wa-green"}`}>
        <span className={`h-px w-6 ${dark ? "bg-wa-yellow" : "bg-wa-green"}`} aria-hidden />
        {eyebrow}
      </div>
      <h2 className={`mt-2 font-maru text-2xl tracking-tight sm:text-[30px] ${dark ? "text-white" : "text-wa-deep"}`}>{title}</h2>
      {children && <p className={`mt-3 text-sm leading-relaxed ${dark ? "text-white/80" : "text-ink-2"}`}>{children}</p>}
    </div>
  );
}

function DiagramColumn({ title, items }: { title: string; items: { icon: React.ComponentType<{ className?: string }>; label: string }[] }) {
  return (
    <div className="rounded-3xl bg-white/8 p-4 ring-1 ring-white/15">
      <div className="font-maru text-xs text-wa-yellow">{title}</div>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2.5 rounded-xl bg-white/10 px-3 py-2 text-sm">
            <it.icon className="h-4 w-4 shrink-0 text-wa-yellow" aria-hidden />
            {it.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
