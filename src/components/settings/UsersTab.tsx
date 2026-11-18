import type { Database, Role, User } from "@/lib/db/types";
import { assignableRoles, assignableStore, canApproveSignup, canManageUser, canManageUsers, isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import { approveSignup, createUser, rejectSignup, resetUserPassword, toggleUserActive, updateUserRole } from "@/lib/actions/accounts";
import { ACCOUNT_LOCK_MESSAGE, accountEditLocked, avatarUrl, credentialStatus } from "@/lib/account-rules";
import { fmtDateTime } from "@/lib/format";
import { Avatar, Badge, Button, buttonClass, Card, CardHeader, Field, Input, Note, Select, StoreTag } from "@/components/ui";
import Link from "@/components/ui/Link";
import { PermissionTableCard } from "./PermissionTableCard";
import { AccountLockButton } from "./AccountLockButton";

/**
 * 設定 → ユーザーと権限、および 社員管理 (/staff。ヘッダーのアバターのメニューから開く)。管理者はすべて、店長は自店舗の店舗スタッフを管理する
 * - view = "staff": 社員だけを表示する (デモ用・確認用のアカウントを除く。店長は自店舗の社員のみ)。操作のあとは /staff に戻る
 */
export function UsersTab({ db, user, view = "settings" }: { db: Database; user: User; view?: "settings" | "staff" }) {
  const admin = user.role === "admin";
  const staffView = view === "staff";
  const base = staffView ? "/staff" : "/settings?tab=users";
  const detail = (id: string, hash = "") => `/settings/users/${id}${staffView ? "?from=staff" : ""}${hash}`;
  const inScope = (u: User) => !staffView || (!isDemoAccount(u) && !isReviewAccount(u) && (admin || u.storeId === user.storeId));
  const back = <input type="hidden" name="returnTo" value={base} />;
  const manager = canManageUsers(user);
  const roles = assignableRoles(user);
  const stores = db.stores.filter((s) => assignableStore(user, s.id));
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const signups = db.users.filter((u) => u.signupStatus === "pending" && canApproveSignup(user, u));
  const otherSignups = manager ? db.users.filter((u) => u.signupStatus === "pending" && !canApproveSignup(user, u)).length : 0;
  // 有効なアカウントを先に並べる (移行時のアカウントを無効にして作り直した社員は、同じ名前が有効・無効の 2 行になるため)
  const members = db.users.filter((u) => u.signupStatus !== "pending" && inScope(u)).sort((a, b) => Number(b.active) - Number(a.active));
  const managed = members.filter((u) => canManageUser(user, u));
  const initialPw = new Set(manager ? managed.filter((u) => u.active && credentialStatus(db.auditLogs, u.id).password === "initial").map((u) => u.id) : []);
  const inactive = (u: User) => (u.active ? "" : " · 無効");
  const roleOptions = (list: Role[]) => list.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>);
  // テスト期間中はアカウントの変更を止める (パスワードの再設定を除く)。ボタンは押すと理由を出す
  const locked = manager && accountEditLocked();
  const lockBtn = (label: string, variant: "primary" | "secondary" | "ghost" | "danger" = "primary") => <AccountLockButton label={label} variant={variant} message={ACCOUNT_LOCK_MESSAGE} />;

  return (
    <div className="space-y-4">
      {locked && <Note tone="warn">テスト期間中のため、現在はアカウントの情報 (氏名・ログイン ID・役職・電話・ロール・所属・有効と無効) の変更と、アカウントの追加・削除はできません。パスワードの再設定はできます。</Note>}
      {manager && (signups.length > 0 || otherSignups > 0) && (
        <Card id="signups" padded={false}>
          <div className="px-5 pt-5">
            <CardHeader
              title={`新規登録の申請 (${signups.length} 件)`}
              description={admin ? "ログイン画面から申請されたアカウントです。ロール・所属を確かめて承認すると、本人が登録したログイン ID とパスワードでログインできます。心当たりのない申請は却下してください" : "自店舗の店舗スタッフとしての申請です。本人に確かめてから承認してください (店長・本部スタッフ・管理者の申請は管理者が承認します)"}
            />
          </div>
          {signups.length === 0 ? (
            <p className="px-5 pb-5 text-xs text-ink-3">あなたが承認できる申請はありません (ほかに管理者の承認を待つ申請が {otherSignups} 件あります)。</p>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {signups.map((u) => {
                const role = roles.includes(u.role) ? u.role : roles[0];
                const store = assignableStore(user, u.storeId) ? u.storeId : user.storeId;
                return (
                  <li key={u.id} className="grid grid-cols-1 gap-3 px-5 py-4 @3xl:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{u.name}</span>
                        {u.kana && <span className="text-xs text-ink-3">{u.kana}</span>}
                        <Badge tone="warn">承認待ち</Badge>
                      </div>
                      <div className="mt-1 text-xs text-ink-2">
                        ログイン ID: <span className="font-mono">{u.email}</span> · 希望: {ROLE_LABEL[u.role]} / {storeName(u.storeId)}
                        {u.signupRequestedAt && <> · 申請 {fmtDateTime(u.signupRequestedAt)}</>}
                      </div>
                      {u.signupNote && <p className="mt-1 rounded-lg bg-subtle px-3 py-2 text-xs whitespace-pre-wrap text-ink-2">{u.signupNote}</p>}
                    </div>
                    {locked ? (
                      <div className="flex flex-wrap items-start gap-2">
                        {lockBtn("承認する")}
                        {lockBtn("却下", "ghost")}
                      </div>
                    ) : (
                    <div className="flex flex-wrap items-end gap-2">
                      <form action={approveSignup.bind(null, u.id)} className="flex flex-wrap items-end gap-2">
                        {back}
                        <Field label="ロール">
                          <Select name="role" defaultValue={role} className="h-9 w-36">{roleOptions(roles)}</Select>
                        </Field>
                        <Field label="所属">
                          <Select name="storeId" defaultValue={store} className="h-9 w-32">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                        </Field>
                        <Button type="submit" size="sm">承認する</Button>
                      </form>
                      <form action={rejectSignup.bind(null, u.id)}>
                        {back}
                        <Button type="submit" size="sm" variant="ghost">却下</Button>
                      </form>
                    </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card className="@4xl:col-span-2" padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-subtle text-xs text-ink-2">
                  <th className="px-4 py-2 text-left font-medium">氏名</th>
                  <th className="px-3 py-2 text-left font-medium">ロール</th>
                  <th className="px-3 py-2 text-left font-medium">所属</th>
                  {manager && <th className="px-3 py-2 text-left font-medium">ログイン ID</th>}
                  <th className="px-3 py-2 text-left font-medium">状態</th>
                  {manager && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {members.map((u) => {
                  const can = canManageUser(user, u);
                  return (
                    <tr key={u.id} className="border-t border-line">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={u.name} id={u.id} size={28} src={avatarUrl(u)} />
                          <div className="min-w-0">
                            <div className="font-medium">
                              {can ? <Link href={detail(u.id)} className="text-accent hover:underline">{u.name}</Link> : u.id === user.id ? <Link href="/profile" className="text-accent hover:underline">{u.name}</Link> : u.name}
                            </div>
                            <div className="text-[11px] text-ink-3">{u.title}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">{ROLE_LABEL[u.role]}</td>
                      <td className="px-3 py-2"><StoreTag store={db.stores.find((s) => s.id === u.storeId)} short /></td>
                      {manager && <td className="px-3 py-2 font-mono text-[11px] text-ink-2">{can || u.id === user.id ? u.email : ""}</td>}
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={u.active ? "good" : "neutral"}>{u.active ? "有効" : "無効"}</Badge>
                          {initialPw.has(u.id) && <Badge tone="warn" dot={false}>初期パスワード</Badge>}
                        </div>
                      </td>
                      {manager && (
                        <td className="px-4 py-2 text-right align-top">
                          {can && (
                            <div className="flex flex-wrap items-start justify-end gap-1">
                              {locked ? lockBtn("編集", "secondary") : <Link href={detail(u.id)} className={buttonClass("secondary", "sm")}>編集</Link>}
                              {u.id !== user.id &&
                                (locked ? (
                                  <>
                                    {lockBtn(u.active ? "無効化" : "有効化", "ghost")}
                                    {lockBtn("削除…", "ghost")}
                                  </>
                                ) : (
                                  <>
                                    <form action={toggleUserActive.bind(null, u.id)}>
                                      {back}
                                      <Button type="submit" size="sm" variant="ghost">{u.active ? "無効化" : "有効化"}</Button>
                                    </form>
                                    <Link href={detail(u.id, "#delete")} className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs text-critical hover:bg-critical-soft">削除…</Link>
                                  </>
                                ))}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="ロールと権限" />
            <ul className="space-y-2 text-xs text-ink-2">
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <li key={r}><span className="font-medium text-ink">{ROLE_LABEL[r]}</span>: {ROLE_DESCRIPTION[r]}</li>)}
            </ul>
            {!admin && manager && <p className="mt-3 text-[11px] text-ink-3">店長は、{storeName(user.storeId)} の店舗スタッフのアカウントを追加・変更・削除できます。</p>}
          </Card>
          {manager && (
            <Card>
              <CardHeader title={admin ? "ユーザーを追加" : `${storeName(user.storeId)} のスタッフを追加`} />
              <form action={createUser} className="space-y-2">
                {back}
                <Field label="氏名" required><Input name="name" required /></Field>
                <Field label="フリガナ"><Input name="kana" /></Field>
                <Field label="ログイン ID (メールアドレス可)" required><Input name="email" required autoCapitalize="none" spellCheck={false} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="ロール"><Select name="role" defaultValue="store_staff">{roleOptions(roles)}</Select></Field>
                  <Field label="所属"><Select name="storeId" defaultValue={admin ? "koshi" : user.storeId}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                </div>
                <Field label="役職・担当"><Input name="title" placeholder="例: 営業・受付" /></Field>
                <Field label="初期パスワード (8 文字以上)" required><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
                {locked ? lockBtn("追加する") : <Button type="submit" size="sm">追加する</Button>}
              </form>
            </Card>
          )}
          {admin && (
            <Card>
              <CardHeader title="ロール・所属の変更" description="移行時にロール・所属を推定で設定しています。実際と異なる場合はここで直します (空欄の項目は変更しません)" />
              <form action={updateUserRole} className="space-y-2">
                {back}
                <Field label="ユーザー">
                  <Select name="userId" required defaultValue="">
                    <option value="" disabled>選択してください</option>
                    {members.map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_LABEL[u.role]} / {storeName(u.storeId)}{inactive(u)})</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="新しいロール"><Select name="role" defaultValue=""><option value="">変更しない</option>{roleOptions(roles)}</Select></Field>
                  <Field label="新しい所属"><Select name="storeId" defaultValue=""><option value="">変更しない</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                </div>
                <Field label="役職・担当 (空欄なら変更しない)"><Input name="title" placeholder="例: 店長" /></Field>
                {locked ? lockBtn("変更する", "secondary") : <Button type="submit" size="sm" variant="secondary">変更する</Button>}
              </form>
            </Card>
          )}
          {manager && managed.some((u) => u.active) && (
            <Card>
              <CardHeader title="パスワードの再設定" description={admin ? "パスワードを忘れた社員の代わりに設定します" : "パスワードを忘れた自店舗のスタッフの代わりに設定します"} />
              <form action={resetUserPassword} className="space-y-2">
                {back}
                <Field label="ユーザー">
                  <Select name="userId" required defaultValue="">
                    <option value="" disabled>選択してください</option>
                    {managed.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                  </Select>
                </Field>
                <Field label="新しいパスワード (8 文字以上)" required><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
                <Button type="submit" size="sm" variant="secondary">再設定する</Button>
              </form>
            </Card>
          )}
          {!manager && <Note>アカウントの追加・変更は管理者と店長が行います。自分のログイン ID・パスワード・顔写真は <Link href="/profile" className="text-accent hover:underline">プロフィール</Link> で変更できます。</Note>}
        </div>
      </div>
      <PermissionTableCard />
    </div>
  );
}
