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
  LayoutGrid,
  Route,
  Wallet,
} from "lucide-react";
import { redirect } from "next/navigation";
import { syncDb } from "@/lib/db/store";
import { getSessionUser } from "@/lib/auth/session";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import type { Role } from "@/lib/db/types";
import { PublicShell } from "@/components/brand/PublicShell";
import { Badge, Card, CardHeader, IconTile, LinkButton, PageHeader } from "@/components/ui";
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

/** ログイン前の公開ホーム。ログインは /login、業務画面はログイン後の / */
export default async function HomePage() {
  if (await getSessionUser()) redirect("/");
  const db = await syncDb();
  const shops = db.stores.filter((s) => s.kind === "store");
  const hq = db.stores.find((s) => s.kind === "hq");

  return (
    <PublicShell current="home">
      {/* ログイン後の画面と同じ構成: ページの見出し → カード */}
      <PageHeader
        eyebrow="株式会社一畳屋 · 社員専用"
        title="一畳屋 統合業務システム"
        description="問い合わせから入金まで、ひとつの画面で。4 店舗と本社の社員が、お客様・見積・工事の予定・請求を同じ最新の情報で扱います。"
      />

      {/* 店舗 (公式サイトの写真) */}
      <Card id="stores" className="mt-6 scroll-mt-24">
        <CardHeader icon={<Store />} title="熊本の 4 店舗と本社が、同じ情報でつながります" description="どの店舗で受けたお問い合わせも、ほかの店舗・本社からすぐに確認できます。予定表は全店舗で共有しています。" />
        <ul className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          {shops.map((s) => (
            <li key={s.id} className="group overflow-hidden rounded-xl border border-line/70 bg-panel">
              <div className="relative aspect-[2.4/1] overflow-hidden bg-subtle">
                {STORE_PHOTO[s.id] && (
                  // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル (最適化済みの WebP)
                  <img src={STORE_PHOTO[s.id]} alt={`${s.name}の外観`} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                )}
                <div className="absolute inset-0 bg-linear-to-t from-ink/45 via-transparent to-transparent" aria-hidden />
                <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-0.5 text-xs font-semibold text-ink shadow-xs">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                  {s.name}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-ink-2">
                <span>〒{s.postalCode} {s.address}</span>
                <a href={`tel:${s.phone.replace(/[^0-9]/g, "")}`} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                  <Phone className="h-3.5 w-3.5" aria-hidden /> {s.phone}
                </a>
              </div>
            </li>
          ))}
        </ul>
        {hq && (
          <div className="mt-3 grid grid-cols-1 overflow-hidden rounded-xl border border-line/70 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="relative aspect-[2.4/1] @3xl:aspect-auto">
              {/* eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル */}
              <img src={STORE_PHOTO.hq} alt={`${hq.name}の外観`} loading="lazy" className="h-full w-full object-cover" />
            </div>
            <div className="bg-subtle/60 p-5 sm:p-6">
              <Badge tone="accent" dot={false}>
                本部
              </Badge>
              <h3 className="mt-2 text-[15px] font-semibold tracking-tight text-ink">{hq.name}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
                経理・承認・経営の数字を全店舗まとめて確認します。各店舗の見積・請求・入金も、本社からリアルタイムで見えます。
              </p>
              <p className="mt-3 text-xs text-ink-3">
                〒{hq.postalCode} {hq.address} · TEL {hq.phone}
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* 解決する課題 */}
      <Card id="issues" className="mt-6 scroll-mt-24">
        <CardHeader
          icon={<Layers />}
          title="毎日の「困った」を、仕組みで解決します"
          description="これまで人の記憶や電話・紙に頼っていた仕事を、データベースと自動の仕組みに置き換えました。左が「これまで」、右が「これから」です。"
        />
        <ul className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
          {ISSUES.map((it) => (
            <li key={it.before} className="overflow-hidden rounded-xl border border-line/70">
              <div className="grid grid-cols-1 @xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <div className="bg-subtle/60 p-4">
                  <div className="text-[11px] font-semibold tracking-wide text-ink-3">これまで</div>
                  <p className="mt-1 text-sm leading-relaxed text-ink-2">{it.before}</p>
                </div>
                <div className="flex items-center justify-center px-3 py-2">
                  <IconTile size="sm">
                    <it.icon />
                  </IconTile>
                </div>
                <div className="p-4">
                  <div className="text-[11px] font-semibold tracking-wide text-accent-ink">これから</div>
                  <p className="mt-1 text-sm leading-relaxed text-ink">{it.after}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 border-t border-line/70 px-4 py-2 text-[11px] text-ink-3">
                <span className="font-semibold text-ink-2">仕組み</span>
                {it.tech}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* 仕組みと強み */}
      <Card id="about" className="mt-6 scroll-mt-24">
        <CardHeader
          icon={<Database />}
          title="入口はいろいろ、情報はひとつに"
          description="電話・LINE・紙の書類など、どこから入った情報も 1 つのデータベースに集まり、必要な人の画面・帳票・会計データとして取り出せます。"
        />
        <div className="grid grid-cols-1 items-stretch gap-3 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
          <DiagramColumn title="入口" items={INPUTS} />
          <div className="relative rounded-xl border border-accent/25 bg-accent-soft/60 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <IconTile size="sm">
                <Database />
              </IconTile>
              <div>
                <div className="text-sm font-semibold tracking-tight text-ink">一畳屋 統合データベース</div>
                <div className="text-[11px] text-ink-3">すべての記録を ID でつなぎ、権限と履歴で守る</div>
              </div>
            </div>
            <ul className="mt-4 grid grid-cols-3 gap-1.5">
              {CORE.map((c) => (
                <li key={c} className="rounded-lg bg-panel px-2 py-1.5 text-center text-[11px] font-medium text-ink-2 ring-1 ring-line/70">
                  {c}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {["権限の確認", "承認", "変更の記録", "毎日のバックアップ"].map((t) => (
                <Badge key={t} tone="accent">
                  {t}
                </Badge>
              ))}
            </div>
            <ArrowRight className="absolute top-1/2 -left-3 hidden h-4 w-4 -translate-y-1/2 text-ink-3 @4xl:block" aria-hidden />
            <ArrowRight className="absolute top-1/2 -right-3 hidden h-4 w-4 -translate-y-1/2 text-ink-3 @4xl:block" aria-hidden />
          </div>
          <DiagramColumn title="使う場面" items={OUTPUTS} />
        </div>

        <ul className="mt-4 grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {STRENGTHS.map((s) => (
            <li key={s.title} className="rounded-xl border border-line/70 p-4">
              <div className="flex items-center justify-between">
                <IconTile size="sm">
                  <s.icon />
                </IconTile>
                <span className="text-lg font-bold tracking-tight text-accent-ink">{s.big}</span>
              </div>
              <h3 className="mt-3 text-sm font-semibold tracking-tight text-ink">{s.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{s.desc}</p>
              <p className="mt-2 font-mono text-[10px] tracking-wide text-ink-3 uppercase">{s.tech}</p>
            </li>
          ))}
        </ul>
      </Card>

      {/* 業務の流れ */}
      <Card id="flow" className="mt-6 scroll-mt-24">
        <CardHeader
          icon={<Route />}
          title="ひとつのお仕事を、最初から最後までつなげて管理"
          description="お客様からのお問い合わせを受けてから、工事を終えて代金をいただくまでの記録を、すべて同じ番号 (ID) でつなげています。担当が替わっても、店舗が違っても、前後の経緯をすぐにたどれます。"
        />
        <ol className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-6">
          {FLOW.map((f, i) => (
            <li key={f.title} className="relative rounded-xl border border-line/70 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white tnum">{i + 1}</span>
                <f.icon className="h-4 w-4 text-accent" aria-hidden />
              </div>
              <div className="mt-3 text-sm font-semibold tracking-tight text-ink">{f.title}</div>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.desc}</p>
              {i < FLOW.length - 1 && <ArrowRight className="absolute top-1/2 -right-2.5 hidden h-4 w-4 -translate-y-1/2 text-ink-3 @5xl:block" aria-hidden />}
            </li>
          ))}
        </ol>
      </Card>

      {/* 主な機能 */}
      <Card id="features" className="mt-6 scroll-mt-24">
        <CardHeader
          icon={<LayoutGrid />}
          title="現場・店舗・本社の仕事を、それぞれの画面で"
          description="スマートフォンでも使えます。現場では写真と予定、店舗では見積と顧客対応、本社では承認と経営数値を中心に使います。"
        />
        <ul className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="rounded-xl border border-line/70 p-4">
              <IconTile size="sm">
                <f.icon />
              </IconTile>
              <h3 className="mt-3 text-sm font-semibold tracking-tight text-ink">{f.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.desc}</p>
            </li>
          ))}
        </ul>
      </Card>

      {/* 権限と新規登録 */}
      <Card id="roles" className="mt-6 scroll-mt-24">
        <CardHeader
          icon={<ShieldCheck />}
          title="役割に合わせて、見える情報とできる操作を分けています"
          description={
            <>
              新規登録のときに自分の役割を選んで申請します。管理者 (店舗スタッフは所属店舗の店長も) が承認すると使えるようになります。店舗ごとの担当者・顔写真つきの詳しい案内は{" "}
              <Link href="/roles" className="font-medium text-accent hover:underline">
                権限と担当
              </Link>
              のページで確認できます。
            </>
          }
        />
        <ul className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          {(["admin", "hq_staff", "store_manager", "store_staff"] as Role[]).map((r) => {
            const Icon = ROLE_ICON[r];
            return (
              <li key={r} className="rounded-xl border border-line/70 p-4">
                <div className="flex items-center gap-2.5">
                  <IconTile size="sm">
                    <Icon />
                  </IconTile>
                  <h3 className="text-sm font-semibold tracking-tight text-ink">{ROLE_LABEL[r]}</h3>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">{ROLE_DESCRIPTION[r]}</p>
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-3">
                  <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                  アカウント: {ROLE_ACCOUNT[r]}
                </p>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 grid grid-cols-1 gap-4 rounded-xl border border-line/70 bg-subtle/60 p-4 sm:p-5 @4xl:grid-cols-[minmax(0,1fr)_auto] @4xl:items-center">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-ink">新規登録の流れ</h3>
            <ol className="mt-3 grid grid-cols-1 gap-3 text-sm text-ink @3xl:grid-cols-3">
              {[
                ["申請", "氏名・ログイン ID・パスワード・希望する役割と所属を入力"],
                ["承認", "管理者 (店舗スタッフは所属店舗の店長も) が内容を確かめて承認"],
                ["ログイン", "登録したログイン ID とパスワードで使い始める"],
              ].map(([t, d], i) => (
                <li key={t} className="flex items-start gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white tnum">{i + 1}</span>
                  <span>
                    <span className="block font-medium">{t}</span>
                    <span className="block text-sm text-ink-2">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <LinkButton href="/signup">
            <UserPlus className="h-4 w-4" aria-hidden /> 新規登録を申請する
          </LinkButton>
        </div>
      </Card>

      {/* 安全性 */}
      <div className="mt-6">
        <Card>
          <CardHeader icon={<LockKeyhole />} title="大切なお客様の情報を守ります" description="安心して使うために" />
          <ul className="space-y-2.5">
            {SECURITY.map((s) => (
              <li key={s.title} className="flex items-start gap-3 rounded-xl border border-line/70 p-4">
                <IconTile size="sm">
                  <s.icon />
                </IconTile>
                <span>
                  <span className="block text-sm font-semibold tracking-tight text-ink">{s.title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-ink-2">{s.desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </PublicShell>
  );
}

function DiagramColumn({ title, items }: { title: string; items: { icon: React.ComponentType<{ className?: string }>; label: string }[] }) {
  return (
    <div className="rounded-xl border border-line/70 bg-subtle/60 p-4">
      <div className="text-[11px] font-semibold tracking-wide text-ink-3">{title}</div>
      <ul className="mt-3 space-y-1.5">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2.5 rounded-lg bg-panel px-3 py-2 text-sm text-ink ring-1 ring-line/70">
            <it.icon className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            {it.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
