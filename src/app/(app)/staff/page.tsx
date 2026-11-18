import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { UserCog } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageUsers } from "@/lib/auth/permissions";
import { storeName } from "@/lib/db/queries";
import { UsersTab } from "@/components/settings/UsersTab";
import { Flash, LinkButton, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "社員管理" };

/**
 * 社員管理 (ヘッダーのアバターのメニューから開く)
 * - 管理者: 全社員のアカウント。店長: 自店舗の社員 (管理できるのは店舗スタッフ)。権限の判定は permissions.ts の canManageUser
 * - 中身は 設定 → ユーザーと権限 と同じ部品 (UsersTab の view = "staff")。デモ用・確認用のアカウントは設定のほうに表示する
 */
export default async function StaffPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { msg, err } = await searchParams;
  const user = await requireUser();
  if (!canManageUsers(user)) redirect("/?err=" + encodeURIComponent("社員管理は管理者と店長が行えます。自分のログイン ID・パスワードはプロフィールで変更できます。"));
  const admin = user.role === "admin";
  const store = storeName(user.storeId);

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title="社員管理"
        icon={<UserCog />}
        description={
          admin
            ? "全社員のアカウントの追加・変更・パスワードの再設定・有効と無効の切り替え、新規登録の申請の承認を行います。氏名を押すと、その社員のアカウント画面を開きます"
            : `${store} の店舗スタッフのアカウントの追加・変更・パスワードの再設定・有効と無効の切り替え、新規登録の申請の承認を行います。店長・本部スタッフへの変更やほかの店舗への異動は管理者に依頼してください`
        }
        actions={admin ? <LinkButton href="/settings?tab=users" variant="secondary" size="sm">デモ用・確認用のアカウント (設定)</LinkButton> : undefined}
      />
      <UsersTab db={getDb()} user={user} view="staff" />
    </div>
  );
}
