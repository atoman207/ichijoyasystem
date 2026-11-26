import type { Metadata } from "next";
import { CheckCircle2, ClipboardList, Shield, ShieldCheck, Users, XCircle } from "lucide-react";
import { syncDb } from "@/lib/db/store";
import { avatarUrl } from "@/lib/account-rules";
import { isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import { ROLE_ACCESS, ROLE_DUTIES, STORE_ORDER, STORE_PHOTO } from "@/lib/role-guide";
import type { Role, User } from "@/lib/db/types";
import { PublicShell } from "@/components/brand/PublicShell";
import { Avatar, Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import Link from "@/components/ui/Link";

export const metadata: Metadata = { title: "権限と担当" };
export const dynamic = "force-dynamic";

const ROLES: Role[] = ["admin", "hq_staff", "store_manager", "store_staff"];

/** 公開: ロールごとの権限・業務と、店舗ごとの社員 (顔写真つき) を案内する */
export default async function RolesPage() {
  const db = await syncDb();
  const members = db.users
    .filter((u) => u.active && !isDemoAccount(u) && !isReviewAccount(u))
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, "ja"));
  // 決まった並び (合志・中央・西・玉名・本部) のあとに、管理者が追加した店舗
  const stores = [...(STORE_ORDER.map((id) => db.stores.find((s) => s.id === id)).filter(Boolean) as typeof db.stores), ...db.stores.filter((s) => !(STORE_ORDER as readonly string[]).includes(s.id))];

  return (
    <PublicShell current="roles">
      <PageHeader
        icon={<ShieldCheck />}
        eyebrow="権限と担当"
        title="自分の権限と、日々の仕事を確認する"
        description="ロール (役割) ごとに見える情報とできる操作が分かれています。下の店舗ごとの顔写真から、自分がどの店舗のどの役割かを確かめ、権限と業務の目安を把握してください。"
      />

      {/* ロールの概要 */}
      <Card>
        <CardHeader icon={<Shield />} title="4 つの役割" description="役割ごとに、アクセスできることと主な業務の目安です。" />
        <ul className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          {ROLES.map((role) => (
            <li key={role} className="rounded-xl border border-line/70 p-4">
              <h3 className="text-[15px] font-semibold tracking-tight text-ink">{ROLE_LABEL[role]}</h3>
              <p className="mt-2 text-xs leading-relaxed text-ink-2">{ROLE_DESCRIPTION[role]}</p>
              <div className="mt-4 space-y-3">
                <DutyBlock icon={CheckCircle2} title="アクセスできること" items={ROLE_ACCESS[role]} />
                <DutyBlock icon={ClipboardList} title="主な業務" items={ROLE_DUTIES[role]} />
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* 店舗ごとの社員 */}
      <section className="mt-6" aria-labelledby="people-by-store">
        <CardHeader
          icon={<Users />}
          title={<span id="people-by-store">店舗・本部の担当</span>}
          description="各人のカードに、その人ができること・できないことを整理しています。"
        />
        <div className="space-y-5">
          {stores.map((store) => {
            const people = members.filter((u) => u.storeId === store.id);
            if (!people.length) return null;
            const photo = STORE_PHOTO[store.id];
            return (
              <Card key={store.id} className="overflow-hidden">
                {/* 店舗ヘッダー: 小さなサムネイル + 店名・住所 */}
                <div className="mb-4 flex items-center gap-3 border-b border-line/70 pb-4">
                  <div className="h-14 w-20 shrink-0 overflow-hidden rounded-lg border border-line/70 bg-subtle sm:h-16 sm:w-24">
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル
                      <img src={photo} alt={`${store.name}の外観`} className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold tracking-tight text-ink">{store.name}</h3>
                      <Badge tone="neutral" dot={false}>
                        {people.length} 名
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      〒{store.postalCode} {store.address}
                    </p>
                  </div>
                </div>

                <ul className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
                  {people.map((u) => (
                    <MemberCard key={u.id} user={u} storeName={store.name} />
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      </section>

      <p className="mt-8 text-center text-sm text-ink-3">
        自分のロールでログインするには{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          ログイン
        </Link>
        {" · "}
        <Link href="/home" className="font-medium text-accent hover:underline">
          ホームに戻る
        </Link>
      </p>
    </PublicShell>
  );
}

function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

function DutyBlock({ icon: Icon, title, items }: { icon: typeof CheckCircle2; title: string; items: string[] }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-accent-ink">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </p>
      <ul className="mt-1.5 space-y-1">
        {items.map((t) => (
          <li key={t} className="text-xs leading-relaxed text-ink-2">{t}</li>
        ))}
      </ul>
    </div>
  );
}

function MemberCard({ user, storeName }: { user: User; storeName: string }) {
  const { can, cannot } = permissionCards(user, storeName);
  return (
    <li className="rounded-xl border border-line/70 bg-panel p-4">
      <div className="flex items-start gap-3">
        <Avatar name={user.name} id={user.id} size={48} ring src={avatarUrl(user)} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight text-ink">{user.name}</p>
          <p className="mt-0.5 text-xs text-ink-2">{user.title || ROLE_LABEL[user.role]}</p>
          <div className="mt-2">
            <Badge tone="accent" dot={false}>
              {ROLE_LABEL[user.role]} · {storeName}
            </Badge>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2">
        <PermissionGroup title="できること" tone="can" items={can} />
        <PermissionGroup title="できないこと" tone="cannot" items={cannot} />
      </div>
    </li>
  );
}

function PermissionGroup({ title, tone, items }: { title: string; tone: "can" | "cannot"; items: string[] }) {
  const Icon = tone === "can" ? CheckCircle2 : XCircle;
  const box = tone === "can" ? "border-good/25 bg-good-soft/40" : "border-line/70 bg-subtle/50";
  const head = tone === "can" ? "text-good-ink" : "text-ink-3";
  const icon = tone === "can" ? "text-good" : "text-ink-3";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${box}`}>
      <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${head}`}>
        <Icon className={`h-3.5 w-3.5 ${icon}`} aria-hidden />
        {title}
      </p>
      <ul className="mt-1.5 space-y-1">
        {items.map((t) => (
          <li key={t} className="text-xs leading-relaxed text-ink-2">{t}</li>
        ))}
      </ul>
    </div>
  );
}

/** 人ごと・店舗ごとに具体化した権限カード用の文面 */
function permissionCards(user: User, storeName: string): { can: string[]; cannot: string[] } {
  switch (user.role) {
    case "admin":
      return {
        can: [
          "全店舗の顧客・問い合わせ・見積・受注・請求・経費・仕入を閲覧・更新できる",
          "店長承認・管理者承認の両方を決裁できる",
          "アカウントの追加・削除・ロール変更、各種設定を変更できる",
          "変更履歴・経営レポート・会計データを全社分で確認・出力できる",
        ],
        cannot: [
          "自分自身の管理者権限を外すことはできない",
          "有効な管理者が 1 人だけになる無効化・削除はできない",
        ],
      };
    case "hq_staff":
      return {
        can: [
          "全店舗の情報を横断して閲覧できる",
          "請求・入金・仕入・経費処理を全店舗分で実行できる",
          "自分のログイン ID・パスワード・顔写真・通知設定を変更できる",
          "予定表は全店舗を閲覧でき、担当または自店舗の予定を変更できる",
        ],
        cannot: [
          "承認の決裁はできない",
          "他の社員のアカウント追加・削除・ロール変更はできない",
          "設定の変更はできない (閲覧のみ)",
        ],
      };
    case "store_manager":
      return {
        can: [
          `${storeName}の顧客・問い合わせ・見積・受注・請求・経費を登録・更新できる`,
          `${storeName}の承認依頼 (見積・契約・経費) を店長として決裁できる`,
          `${storeName}の店舗スタッフのアカウントを管理できる (新規登録の申請の承認は管理者)`,
          "予定表は全店舗を閲覧でき、担当または自店舗の予定を変更できる",
        ],
        cannot: [
          "他店舗の顧客・案件・請求を登録・更新することはできない",
          "管理者承認が必要な高額案件は決裁できない",
          "ロール変更 (店長・本部・管理者にする操作) はできない",
          "設定の変更はできない (閲覧のみ)",
        ],
      };
    case "store_staff":
      return {
        can: [
          `${storeName}の顧客・問い合わせ・見積・施工進捗を登録・更新できる`,
          "金額が関わる変更は承認申請し、店長・管理者の決裁後に反映できる",
          "経費は自分が登録したものを中心に扱える",
          "予定表は全店舗を閲覧でき、担当または自店舗の予定を変更できる",
        ],
        cannot: [
          "承認の決裁はできない",
          "他の社員のアカウント管理・設定変更はできない",
          "他店舗の顧客・案件を登録・更新することはできない",
          "全社共通の予定の登録・変更はできない",
        ],
      };
    default:
      return { can: [], cannot: [] };
  }
}
