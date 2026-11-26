import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { assignableRoles, assignableStore, canChangeUserRole, canManageUser, canManageUserAvatar, canManageUsers, canSeeAllStores, isDemoAccount } from "@/lib/auth/permissions";
import { AvatarUploader } from "@/components/settings/AvatarUploader";
import { avatarPhotoViews } from "@/lib/avatar-photos";
import { deleteUser, resetUserPassword, toggleUserActive, updateUserProfile, updateUserRole } from "@/lib/actions/accounts";
import { ACCOUNT_LOCK_MESSAGE, PASSWORD_LOCK_MESSAGE, accountEditLocked, avatarUrl, credentialStatus } from "@/lib/account-rules";
import { updateUserNotify } from "@/lib/actions/settings-ops";
import { NotifyPrefsForm } from "@/components/settings/NotifyPrefsForm";
import { AccountLockButton } from "@/components/settings/AccountLockButton";
import { fmtDateTime } from "@/lib/format";
import { AUDIT_ACTION_LABEL, ENTITY_LABEL, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import { Avatar, Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, Note, PageHeader, Select, StoreTag } from "@/components/ui";

export const metadata: Metadata = { title: "アカウント" };

/**
 * ユーザーごとのアカウント管理 (管理者はすべて、店長は自店舗の店舗スタッフ)
 * 社員管理 (/staff) から開いたときは ?from=staff。戻り先・操作のあとの表示を社員管理にそろえる
 */
export default async function UserAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string; from?: string }> }) {
  const { id } = await params;
  const { msg, err, from } = await searchParams;
  const fromStaff = from === "staff";
  const list = fromStaff ? "/staff" : "/settings?tab=users";
  const user = await requireUser();
  if (!canManageUsers(user)) redirect(`${list}${list.includes("?") ? "&" : "?"}err=` + encodeURIComponent("アカウントの管理は管理者と店長が行えます。"));
  const db = getDb();
  const u = db.users.find((x) => x.id === id);
  if (!u) notFound();
  if (u.id === user.id && user.role !== "admin") redirect("/profile");
  if (!canManageUser(user, u)) redirect(`${list}${list.includes("?") ? "&" : "?"}err=` + encodeURIComponent("店長が管理できるのは、自店舗の店舗スタッフのアカウントです。"));
  if (u.signupStatus === "pending") redirect(`${list}#signups`);
  const uploads = db.attachments.filter((a) => a.uploadedBy === u.id).length;
  const store = db.stores.find((s) => s.id === u.storeId);
  const returnTo = `/settings/users/${u.id}${fromStaff ? "?from=staff" : ""}`;
  const logs = db.auditLogs.filter((l) => l.userId === u.id).slice(-20).reverse();
  const lastLogin = [...db.auditLogs].reverse().find((l) => l.userId === u.id && l.action === "login");
  const cred = credentialStatus(db.auditLogs, u.id);
  const passwordLabel =
    cred.password === "initial" ? <span className="text-warn-ink">初期パスワードのまま ({cred.passwordAt ? fmtDateTime(cred.passwordAt) : "-"} に設定。本人はまだ変更していません)</span>
    : cred.password === "own" ? `本人が設定 (${cred.passwordAt ? fmtDateTime(cred.passwordAt) : "-"})`
    : u.passwordHash ? "設定済み" : u.password ? "サンプルデータ (平文)" : "未設定";
  const loginIdLabel = cred.loginIdChangedAt ? `${cred.loginIdChangedBySelf ? "本人" : "管理者・店長"}が ${fmtDateTime(cred.loginIdChangedAt)} に変更${cred.loginIdBefore ? ` (変更前: ${cred.loginIdBefore})` : ""}` : "変更なし";
  const scope = canSeeAllStores(u) ? "全店舗の情報を閲覧・登録・編集できます" : `${store?.name ?? u.storeId} の情報だけを閲覧・登録・編集できます (予定表は全店舗を閲覧)`;
  // テスト期間中はアカウントの変更を止める。通知の受け取り方は変更可。ボタンは押すと理由を出す
  const locked = accountEditLocked();
  // 管理者のロール・所属・役職の変更はテスト期間中も (canChangeUserRole)
  const roleEdit = canChangeUserRole(user);
  const lockBtn = (label: string, variant: "primary" | "secondary" | "danger" = "primary") => <AccountLockButton label={label} variant={variant} message={ACCOUNT_LOCK_MESSAGE} />;
  const lockPwBtn = (label: string, variant: "primary" | "secondary" | "danger" = "primary") => <AccountLockButton label={label} variant={variant} message={PASSWORD_LOCK_MESSAGE} />;

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={u.name}
        badge={<span className="flex gap-1"><Badge tone={u.active ? "good" : "neutral"}>{u.active ? "有効" : "無効"}</Badge>{isDemoAccount(u) && <Badge tone="accent" dot={false}>デモ用</Badge>}</span>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{ROLE_LABEL[u.role]} · <StoreTag store={store} /> · {u.title}</span>}
        back={fromStaff ? { href: "/staff", label: "社員管理" } : { href: "/settings?tab=users", label: "ユーザーと権限" }}
      />
      {locked && (
        <div className="mb-4">
          <Note tone="warn">テスト期間中のため、現在はアカウントの情報 (氏名・ログイン ID・電話・有効と無効) の変更・削除と、パスワードの再設定はできません。{roleEdit ? "ロール・所属・役職 (権限) と通知の受け取り方は変更できます。" : "通知の受け取り方は変更できます。"}</Note>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="アカウント情報" description="氏名・ログイン ID などを変更します。ログイン ID を変えたら本人に伝えてください" />
            <form action={updateUserProfile.bind(null, u.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="氏名" required><Input name="name" defaultValue={u.name} required /></Field>
              <Field label="フリガナ"><Input name="kana" defaultValue={u.kana} /></Field>
              <Field label="ログイン ID (メールアドレス可)" required><Input name="email" defaultValue={u.email} required autoCapitalize="none" spellCheck={false} /></Field>
              <Field label="役職・担当"><Input name="title" defaultValue={u.title} /></Field>
              <Field label="電話"><Input name="phone" defaultValue={u.phone} /></Field>
              <div className="flex items-end">{locked ? lockBtn("変更する") : <Button type="submit" size="sm">変更する</Button>}</div>
            </form>
          </Card>

          <Card>
            <CardHeader title="ロール・所属 (権限)" description="ロールで操作できる内容、所属で閲覧・登録・編集できる店舗が決まります。本人の次の画面表示から反映されます" />
            {roleEdit ? (
              <form action={updateUserRole} className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-4">
                <input type="hidden" name="userId" value={u.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <Field label="ロール"><Select name="role" defaultValue={u.role}>{assignableRoles(user).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
                <Field label="所属"><Select name="storeId" defaultValue={u.storeId}>{db.stores.filter((s) => assignableStore(user, s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                <Field label="役職・担当"><Input name="title" defaultValue={u.title} maxLength={60} /></Field>
                <div className="flex items-end"><Button type="submit" size="sm" variant="secondary">変更する</Button></div>
              </form>
            ) : (
              <p className="text-xs text-ink-3">ロール・所属の変更 (店長・本部スタッフにする、ほかの店舗に移すなど) は管理者に依頼してください。</p>
            )}
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
            <div className="mb-3 flex items-center gap-3">
              <Avatar name={u.name} id={u.id} size={56} src={avatarUrl(u)} />
              <p className="text-[11px] leading-relaxed text-ink-3">
                {u.avatarKey && u.avatarHidden ? "顔写真は「表示しない」になっています (写真は残っています)。" : "顔写真は本人がプロフィールで登録します。"}
                {canManageUserAvatar(user, u) && u.id !== user.id ? " 管理者は下の「顔写真」で変更・表示しない・以前の写真に戻すができます。" : ""}
              </p>
            </div>
            <Dl columns={1} items={[["状態", u.active ? "有効 (ログインできます)" : "無効 (ログインできません)"], ["ログイン ID", <span key="id" className="font-mono text-[13px]">{u.email}</span>], ["ログイン ID の変更", loginIdLabel], ["最終ログイン", lastLogin ? fmtDateTime(lastLogin.at) : "-"], ["パスワード", passwordLabel]]} />
            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">パスワードは暗号化 (ハッシュ) して保存しているため、管理者を含め誰も中身を見られません。忘れたときは下の「パスワードの再設定」で新しいパスワードを決めて本人に伝えます。</p>
            <form action={toggleUserActive.bind(null, u.id)} className="mt-4">
              <input type="hidden" name="returnTo" value={returnTo} />
              {locked && u.id !== user.id ? lockBtn(u.active ? "無効にする (ログインを止める)" : "有効にする", u.active ? "danger" : "secondary") : <Button type="submit" size="sm" variant={u.active ? "danger" : "secondary"} disabled={u.id === user.id}>{u.active ? "無効にする (ログインを止める)" : "有効にする"}</Button>}
              {u.id === user.id && <p className="mt-1 text-[11px] text-ink-3">自分自身は無効にできません。</p>}
            </form>
          </Card>
          {u.id !== user.id && canManageUserAvatar(user, u) && (
            <Card id="avatar">
              <CardHeader title="顔写真" description="管理者が変更できます。写真は削除されず、「表示しない」・以前の写真に戻すができます" />
              <AvatarUploader name={u.name} id={u.id} self={false} returnTo={returnTo} hidden={Boolean(u.avatarHidden)} {...avatarPhotoViews(u, fmtDateTime, (x) => db.users.find((y) => y.id === x)?.name)} />
            </Card>
          )}
          <Card>
            <CardHeader title="通知の受け取り方" description="承認依頼・承認の結果・メンション・業務依頼をメール・Chatwork でも知らせる設定" />
            <NotifyPrefsForm u={u} action={updateUserNotify.bind(null, u.id)} returnTo={returnTo} />
          </Card>
          <Card>
            <CardHeader title="パスワードの再設定" description="ログイン中の端末はログアウトされます。新しいパスワードは本人に直接伝えてください" />
            <form action={resetUserPassword} className="space-y-2">
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="新しいパスワード (8 文字以上)" required><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
              {locked ? lockPwBtn("再設定する", "secondary") : <Button type="submit" size="sm" variant="secondary">再設定する</Button>}
            </form>
          </Card>
          {u.id !== user.id && (
            <Card id="delete">
              <CardHeader title="アカウントの削除" description="退職などで不要になったアカウントを削除します。過去の記録 (案件の登録者・変更履歴など) の名前は「-」の表示になり、元に戻せません" />
              {uploads > 0 ? (
                <p className="text-xs leading-relaxed text-ink-2">資料・写真を {uploads} 件登録しているため、登録者の記録を残すために削除できません。上の「無効にする」でログインを止めてください。</p>
              ) : (
                <form action={deleteUser.bind(null, u.id)} className="space-y-2">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="listTo" value={list} />
                  <label className="flex items-start gap-2 text-xs text-ink-2">
                    <input type="checkbox" name="confirm" value="1" required className="mt-0.5 h-4 w-4" />
                    {u.name} さんのアカウントを削除します (元に戻せません)
                  </label>
                  {locked ? lockBtn("削除する", "danger") : <Button type="submit" size="sm" variant="danger">削除する</Button>}
                </form>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
