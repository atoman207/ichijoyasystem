import type { Metadata } from "next";
import { CheckCircle2, ClipboardList, Shield, ShieldCheck, Users } from "lucide-react";
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
  const stores = STORE_ORDER.map((id) => db.stores.find((s) => s.id === id)).filter(Boolean) as typeof db.stores;

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
          title={<span id="people-by-store">店舗・本社の担当</span>}
          description="顔写真と役職から、どの店舗の誰かを確認できます。自分のカードのロール説明を読んでください。"
        />
        <div className="space-y-6">
          {stores.map((store) => {
            const people = members.filter((u) => u.storeId === store.id);
            if (!people.length) return null;
            const photo = STORE_PHOTO[store.id];
            return (
              <Card key={store.id} padded={false} className="overflow-hidden">
                <div className="relative aspect-[4.6/1] min-h-[5rem] bg-subtle @3xl:aspect-[5.8/1]">
                  {photo && (
                    // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル
                    <img src={photo} alt={`${store.name}の外観`} className="h-full w-full object-cover" />
                  )}
                  <div className="absolute inset-0 bg-linear-to-t from-ink/55 via-ink/10 to-transparent" aria-hidden />
                  <div className="absolute right-3 bottom-3 left-3 flex flex-wrap items-end justify-between gap-2 sm:right-5 sm:bottom-4 sm:left-5">
                    <div>
                      <p className="inline-flex items-center rounded-full bg-white/95 px-3 py-1 text-sm font-semibold text-ink shadow-xs">
                        {store.name}
                      </p>
                      <p className="mt-1.5 text-xs text-white/90 drop-shadow-sm">
                        〒{store.postalCode} {store.address}
                      </p>
                    </div>
                  </div>
                </div>

                <ul className="grid grid-cols-1 gap-3 p-4 sm:p-5 @3xl:grid-cols-2 @5xl:grid-cols-3">
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
  const permissions = permissionLines(user, storeName);
  return (
    <li className="flex flex-col rounded-xl border border-line/70 bg-panel p-4">
      <div className="flex items-start gap-3">
        <Avatar name={user.name} id={user.id} size={56} ring src={avatarUrl(user)} />
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
      <div className="mt-3 border-t border-line/70 pt-3">
        <p className="text-[11px] font-semibold text-ink-3">この人の権限 (具体)</p>
        <ul className="mt-1.5 space-y-1">
          {permissions.map((t) => (
            <li key={t} className="text-xs leading-relaxed text-ink-2">{t}</li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function permissionLines(user: User, storeName: string): string[] {
  switch (user.role) {
    case "admin":
      return [
        "全店舗の顧客・問い合わせ・見積・受注・請求・経費・仕入を閲覧/更新できます。",
        "承認は店長承認/管理者承認の両方を決裁できます。",
        "アカウント追加・削除・ロール変更、各種設定変更を実行できます。",
        "変更履歴・経営レポート・会計データを全社分で確認/出力できます。",
      ];
    case "hq_staff":
      return [
        "全店舗の情報を閲覧できます (本部の横断確認)。",
        "請求・入金・仕入・経費処理を全店舗分で実行できます。",
        "設定変更やロール変更、承認決裁はできません。",
        "アカウントは自分の設定のみ変更できます。",
      ];
    case "store_manager":
      return [
        `${storeName}の顧客・問い合わせ・見積・受注・請求・経費を登録/更新できます。`,
        `${storeName}の承認依頼 (見積・契約・経費) を店長として決裁できます。`,
        `${storeName}の店舗スタッフの申請承認とアカウント管理ができます。`,
        "予定表は全店舗を閲覧でき、担当または自店舗予定を変更できます。",
      ];
    case "store_staff":
      return [
        `${storeName}の顧客・問い合わせ・見積・施工進捗を登録/更新できます。`,
        "金額が関わる変更は承認申請し、店長/管理者の決裁後に反映されます。",
        "承認決裁、他社員のアカウント管理、設定変更はできません。",
        "予定表は全店舗を閲覧でき、担当または自店舗予定を変更できます。",
      ];
    default:
      return [];
  }
}
