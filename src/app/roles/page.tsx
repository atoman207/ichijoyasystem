import type { Metadata } from "next";
import { Building, CheckCircle2, ClipboardList, Shield } from "lucide-react";
import { syncDb } from "@/lib/db/store";
import { avatarUrl } from "@/lib/account-rules";
import { isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import { ROLE_ACCESS, ROLE_DUTIES, STORE_ORDER, STORE_PHOTO } from "@/lib/role-guide";
import type { Role, User } from "@/lib/db/types";
import { PublicShell } from "@/components/brand/PublicShell";
import { Avatar } from "@/components/ui";
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
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        <header className="max-w-3xl">
          <p className="inline-flex items-center gap-2 font-maru text-[11px] tracking-[0.16em] text-neutral-400">
            <span className="h-px w-5 bg-neutral-300" aria-hidden />
            権限と担当
          </p>
          <h1 className="mt-2.5 font-maru text-2xl tracking-tight text-neutral-900 sm:text-3xl">自分の権限と、日々の仕事を確認する</h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-500">
            ロール (役割) ごとに見える情報とできる操作が分かれています。下の店舗ごとの顔写真から、自分がどの店舗のどの役割かを確かめ、権限と業務の目安を把握してください。
          </p>
        </header>

        {/* ロールの概要 */}
        <section className="mt-10" aria-labelledby="role-overview">
          <h2 id="role-overview" className="font-maru text-lg tracking-tight text-neutral-900">
            4 つの役割
          </h2>
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ROLES.map((role) => (
              <li key={role} className="rounded-2xl bg-white p-5 ring-1 ring-neutral-200/80">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-wa-green/10 text-wa-green">
                    <Shield className="h-4 w-4" aria-hidden />
                  </span>
                  <h3 className="font-maru text-base text-wa-deep">{ROLE_LABEL[role]}</h3>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-2">{ROLE_DESCRIPTION[role]}</p>
                <div className="mt-4 space-y-3">
                  <DutyBlock icon={CheckCircle2} title="アクセスできること" items={ROLE_ACCESS[role]} />
                  <DutyBlock icon={ClipboardList} title="主な業務" items={ROLE_DUTIES[role]} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* 店舗ごとの社員 */}
        <section className="mt-14" aria-labelledby="people-by-store">
          <h2 id="people-by-store" className="font-maru text-lg tracking-tight text-neutral-900">
            店舗・本社の担当
          </h2>
          <p className="mt-1 text-sm text-neutral-500">顔写真と役職から、どの店舗の誰かを確認できます。自分のカードのロール説明を読んでください。</p>

          <div className="mt-8 space-y-10">
            {stores.map((store) => {
              const people = members.filter((u) => u.storeId === store.id);
              if (!people.length) return null;
              const photo = STORE_PHOTO[store.id];
              return (
                <section key={store.id} className="overflow-hidden rounded-2xl bg-white ring-1 ring-neutral-200/80">
                  <div className="relative aspect-[2.8/1] min-h-[7.5rem] bg-neutral-100 sm:aspect-[3.2/1]">
                    {photo && (
                      // eslint-disable-next-line @next/next/no-img-element -- public の静的ファイル
                      <img src={photo} alt={`${store.name}の外観`} className="h-full w-full object-cover" />
                    )}
                    <div className="absolute inset-0 bg-linear-to-t from-black/55 via-black/10 to-transparent" aria-hidden />
                    <div className="absolute right-3 bottom-3 left-3 flex flex-wrap items-end justify-between gap-2 sm:right-5 sm:bottom-4 sm:left-5">
                      <div>
                        <p className="inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 font-maru text-sm text-wa-deep shadow-sm">
                          <Building className="h-3.5 w-3.5 text-wa-green" aria-hidden />
                          {store.name}
                        </p>
                        <p className="mt-1.5 text-xs text-white/90 drop-shadow-sm">
                          〒{store.postalCode} {store.address}
                        </p>
                      </div>
                      <span className="h-3 w-3 rounded-full ring-2 ring-white" style={{ background: store.color }} title="店舗の色" aria-hidden />
                    </div>
                  </div>

                  <ul className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
                    {people.map((u) => (
                      <MemberCard key={u.id} user={u} storeName={store.name} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>

        <p className="mt-12 text-center text-sm text-ink-3">
          自分のロールでログインするには{" "}
          <Link href="/login" className="font-medium text-wa-green hover:underline">
            ログイン
          </Link>
          {" · "}
          <Link href="/home" className="font-medium text-wa-green hover:underline">
            ホームに戻る
          </Link>
        </p>
      </div>
    </PublicShell>
  );
}

function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

function DutyBlock({ icon: Icon, title, items }: { icon: typeof CheckCircle2; title: string; items: string[] }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-wa-green">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </p>
      <ul className="mt-1.5 space-y-1">
        {items.map((t) => (
          <li key={t} className="text-xs leading-relaxed text-ink-2">
            · {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemberCard({ user, storeName }: { user: User; storeName: string }) {
  return (
    <li className="flex flex-col rounded-2xl border border-neutral-200/80 bg-neutral-50/50 p-4">
      <div className="flex items-start gap-3">
        <Avatar name={user.name} id={user.id} size={56} ring src={avatarUrl(user)} />
        <div className="min-w-0 flex-1">
          <p className="font-maru text-base text-wa-deep">{user.name}</p>
          <p className="mt-0.5 text-xs text-ink-2">{user.title || ROLE_LABEL[user.role]}</p>
          <p className="mt-2 inline-flex items-center rounded-full bg-wa-green/10 px-2 py-0.5 text-[11px] font-medium text-wa-deep">
            {ROLE_LABEL[user.role]} · {storeName}
          </p>
        </div>
      </div>
      <div className="mt-3 border-t border-line/70 pt-3">
        <p className="text-[11px] font-semibold text-ink-3">この役割でできること</p>
        <ul className="mt-1.5 space-y-1">
          {ROLE_ACCESS[user.role].slice(0, 3).map((t) => (
            <li key={t} className="text-xs leading-relaxed text-ink-2">
              · {t}
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-[11px] font-semibold text-ink-3">日々の業務</p>
        <ul className="mt-1.5 space-y-1">
          {ROLE_DUTIES[user.role].slice(0, 3).map((t) => (
            <li key={t} className="text-xs leading-relaxed text-ink-2">
              · {t}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}
