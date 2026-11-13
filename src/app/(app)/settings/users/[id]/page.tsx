import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageSettings, canSeeAllStores, isDemoAccount } from "@/lib/auth/permissions";
import { resetUserPassword, toggleUserActive, updateUserProfile, updateUserRole } from "@/lib/actions/settings";
import { fmtDateTime } from "@/lib/format";
import { AUDIT_ACTION_LABEL, ENTITY_LABEL, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import type { Role } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, PageHeader, Select, StoreTag } from "@/components/ui";

export const metadata: Metadata = { title: "アカウント" };

/** ユーザーごとのアカウント管理 (管理者のみ) */
export default async function UserAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  if (!canManageSettings(user)) redirect("/settings?tab=users&err=" + encodeURIComponent("アカウントの管理は管理者のみ行えます。"));
  const db = getDb();
  const u = db.users.find((x) => x.id === id);
  if (!u) notFound();
  const store = db.stores.find((s) => s.id === u.storeId);
  const returnTo = `/settings/users/${u.id}`;
  const logs = db.auditLogs.filter((l) => l.userId === u.id).slice(-20).reverse();
  const lastLogin = [...db.auditLogs].reverse().find((l) => l.userId === u.id && l.action === "login");
  const scope = canSeeAllStores(u) ? "全店舗の情報を閲覧・登録・編集できます" : `${store?.name ?? u.storeId} の情報だけを閲覧・登録・編集できます (予定表は全店舗を閲覧)`;

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={u.name}
        badge={<span className="flex gap-1"><Badge tone={u.active ? "good" : "neutral"}>{u.active ? "有効" : "無効"}</Badge>{isDemoAccount(u) && <Badge tone="accent" dot={false}>デモ用</Badge>}</span>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{ROLE_LABEL[u.role]} · <StoreTag store={store} /> · {u.title}</span>}
        back={{ href: "/settings?tab=users", label: "ユーザーと権限" }}
      />

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="アカウント情報" description="氏名・ログイン ID などを変更します。ログイン ID を変えたら本人に伝えてください" />
            <form action={updateUserProfile.bind(null, u.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="氏名" required><Input name="name" defaultValue={u.name} required /></Field>
              <Field label="フリガナ"><Input name="kana" defaultValue={u.kana} /></Field>
              <Field label="ログイン ID (メールアドレス可)" required><Input name="email" defaultValue={u.email} required autoCapitalize="none" spellCheck={false} /></Field>
              <Field label="役職・担当"><Input name="title" defaultValue={u.title} /></Field>
              <Field label="電話"><Input name="phone" defaultValue={u.phone} /></Field>
              <div className="flex items-end"><Button type="submit" size="sm">変更する</Button></div>
            </form>
          </Card>

          <Card>
            <CardHeader title="ロール・所属 (権限)" description="ロールで操作できる内容、所属で閲覧・登録・編集できる店舗が決まります。本人の次の画面表示から反映されます" />
            <form action={updateUserRole} className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="ロール"><Select name="role" defaultValue={u.role}>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
              <Field label="所属"><Select name="storeId" defaultValue={u.storeId}>{db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <div className="flex items-end"><Button type="submit" size="sm" variant="secondary">変更する</Button></div>
            </form>
            <div className="mt-4 rounded-xl bg-subtle/70 px-4 py-3 text-xs leading-relaxed text-ink-2">
              <div><span className="font-medium text-ink">{ROLE_LABEL[u.role]}:</span> {ROLE_DESCRIPTION[u.role]}</div>
              <div className="mt-1"><span className="font-medium text-ink">店舗の範囲:</span> {scope}</div>
              <div className="mt-1 text-ink-3">操作ごとの詳細は「ユーザーと権限」の権限一覧を参照してください。</div>
            </div>
          </Card>

          <Card>
            <CardHeader title="最近の操作" description="このユーザーの操作の記録 (直近 20 件)" />
            <ul className="divide-y divide-line text-xs">
              {logs.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                  <span className="tnum text-ink-3">{fmtDateTime(l.at)}</span>
                  <Badge dot={false}>{AUDIT_ACTION_LABEL[l.action]}</Badge>
                  <span className="text-ink-3">{ENTITY_LABEL[l.entity] ?? l.entity}</span>
                  <span className="min-w-0 text-ink">{l.summary}</span>
                </li>
              ))}
              {logs.length === 0 && <li className="py-2 text-ink-3">記録はありません。</li>}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="状態" />
            <Dl columns={1} items={[["状態", u.active ? "有効 (ログインできます)" : "無効 (ログインできません)"], ["最終ログイン", lastLogin ? fmtDateTime(lastLogin.at) : "-"], ["パスワード", u.passwordHash ? "設定済み (ハッシュで保存)" : u.password ? "サンプルデータ (平文)" : "未設定"]]} />
            <form action={toggleUserActive.bind(null, u.id)} className="mt-4">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Button type="submit" size="sm" variant={u.active ? "danger" : "secondary"} disabled={u.id === user.id}>{u.active ? "無効にする (ログインを止める)" : "有効にする"}</Button>
              {u.id === user.id && <p className="mt-1 text-[11px] text-ink-3">自分自身は無効にできません。</p>}
            </form>
          </Card>
          <Card>
            <CardHeader title="パスワードの再設定" description="ログイン中の端末はログアウトされます。新しいパスワードは本人に直接伝えてください" />
            <form action={resetUserPassword} className="space-y-2">
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="新しいパスワード (8 文字以上)" required><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
              <Button type="submit" size="sm" variant="secondary">再設定する</Button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
