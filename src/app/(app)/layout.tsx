import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { notificationsFor, storeById, storeName } from "@/lib/db/queries";
import { canApproveSignup, canExportAccounting, canExportData, canManageMaps, canManageSettings, canManageUsers, canRegisterPurchase, canSeeAllStores, canTriageFax, canViewFax, canViewReports, canViewSuppliers } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/store";
import { avatarUrl } from "@/lib/account-rules";
import { ROLE_LABEL, APPROVAL_TYPE_LABEL } from "@/lib/constants";
import { AppShell, type NavItem, type NotificationItem } from "@/components/layout/AppShell";
import { logout } from "@/lib/actions/auth";
import { canViewMgmt } from "@/lib/mgmt/access";
import { yen } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const n = notificationsFor(user);
  const allStores = canSeeAllStores(user);
  const store = storeById(user.storeId);
  const signups = canManageUsers(user) ? getDb().users.filter((u) => u.signupStatus === "pending" && canApproveSignup(user, u)) : [];
  // FAX: 要確認の受信 (仕分けをする本部・管理者)、自分が担当の未確認の返信、自分が送って失敗した送信
  const faxes = getDb().faxMessages;
  const faxReview = canTriageFax(user) ? faxes.filter((f) => f.direction === "inbound" && f.triage === "review").length : 0;
  const faxReplies = faxes.filter((f) => f.direction === "inbound" && f.assignedUserId === user.id && f.purchaseOrderId && !f.checkedAt && (f.triage === "auto" || f.triage === "accepted") && canViewFax(user, f)).length;
  const faxFailed = faxes.filter((f) => f.direction === "outbound" && f.userId === user.id && (f.status === "failed" || f.status === "unknown") && !f.nextRetryAt).length;

  // short: ヘッダーのタブに表示する短い名前 (正式名はツールチップに表示)
  const nav: NavItem[] = [
    { href: "/", label: "ダッシュボード", short: "ホーム", icon: "dashboard" },
    { href: "/customers", label: "顧客", icon: "customers", group: "営業・施工" },
    { href: "/inquiries", label: "問い合わせ", icon: "inquiries", group: "営業・施工", badge: n.newInquiries || undefined },
    { href: "/quotes", label: "見積", icon: "quotes", group: "営業・施工" },
    { href: "/orders", label: "受注・施工", icon: "orders", group: "営業・施工" },
    { href: "/cases", label: "案件の進捗 (問い合わせ〜入金・全処理完了)", short: "案件進捗", icon: "cases", group: "営業・施工" },
    { href: "/schedule", label: "予定表", icon: "schedule", group: "営業・施工", badge: n.myConflicts || undefined, pinned: true },
    { href: "/invoices", label: "請求・入金", icon: "invoices", group: "経理", badge: n.overdueInvoices || undefined },
    { href: "/finance", label: "入出金の予定 (未入金・支払待ち)", short: "入出金予定", icon: "finance", group: "経理" },
    { href: "/expenses", label: "経費精算", icon: "expenses", group: "経理" },
    { href: "/cashbook", label: "現金出納帳", short: "現金出納", icon: "cashbook", group: "経理" },
  ];
  if (canRegisterPurchase(user)) {
    nav.push({ href: "/purchases", label: "仕入・買掛 (支払依頼)", short: "仕入・買掛", icon: "purchases", group: "経理" });
  }
  nav.push({ href: "/purchase-orders", label: "発注書 (仕入先への発注・FAX 送信)", short: "発注書", icon: "purchaseOrders", group: "経理" });
  if (canViewSuppliers(user)) {
    nav.push({ href: "/suppliers", label: "仕入先・協力業者", short: "取引先", icon: "suppliers", group: "経理" });
  }
  if (canExportAccounting(user)) {
    nav.push({ href: "/accounting", label: "会計データの出力 (仕訳・明細)", short: "会計データ", icon: "accounting", group: "経理" });
  }
  nav.push(
    { href: "/capture", label: "書類取込 (紙→データ)", short: "書類取込", icon: "capture", group: "業務支援" },
    { href: "/approvals", label: "承認", icon: "approvals", group: "業務支援", badge: n.pendingApprovals.length || undefined },
    { href: "/messages", label: "社内連絡・業務依頼", short: "社内連絡", icon: "messages", group: "業務支援", badge: n.mentions.length + n.taskCount || undefined },
    { href: "/fax", label: "FAX 送受信 (受信の仕分け・発注書の送信の記録)", short: "FAX", icon: "fax", group: "業務支援", badge: faxReview + faxReplies + faxFailed || undefined },
    { href: "/contacts", label: "連絡履歴 (お客様・協力業者)", short: "連絡履歴", icon: "contacts", group: "業務支援" },
    { href: "/ai", label: "AIアシスタント (質問・検索・文書の作成)", short: "AI", icon: "ai", group: "業務支援" },
    { href: "/knowledge", label: "社内資料 (ナレッジ・AI の回答の根拠)", short: "社内資料", icon: "knowledge", group: "業務支援" },
    { href: "/materials", label: "資料・写真", icon: "materials", group: "業務支援" },
  );
  nav.push({ href: "/kpi", label: "KPI (アンケート・クレーム・口コミ・インセンティブ)", short: "KPI", icon: "kpi", group: "管理" });
  if (canViewReports(user)) {
    nav.push({ href: "/reports", label: "経営ダッシュボード (売上・受注・施工・請求・経費)", short: "経営", icon: "reports", group: "管理" });
  }
  if (canViewMgmt(user)) {
    nav.push({ href: "/management", label: "管理会計 (店舗別損益・内部受注・材料原価・在庫・共通経費の案分)", short: "管理会計", icon: "management", group: "管理" });
  }
  if (canExportData(user)) {
    nav.push({ href: "/data", label: "データ入出力 (CSV・スプレッドシート)", short: "入出力", icon: "dataio", group: "管理" });
  }
  if (canManageMaps(user)) {
    nav.push({ href: "/maps", label: "地図・住宅地図 (場所・住宅地図の PDF・一括処理)", short: "地図", icon: "maps", group: "管理" });
  }
  nav.push({ href: "/audit", label: "変更履歴", icon: "audit", group: "管理" });
  nav.push({ href: "/settings", label: canManageSettings(user) ? "設定" : canManageUsers(user) ? "設定 (閲覧・自店舗のアカウント管理)" : "設定 (閲覧)", short: "設定", icon: "settings", group: "管理", badge: signups.length || undefined });
  nav.push({ href: "/help", label: "使い方 (操作説明)", short: "使い方", icon: "help", group: "管理" });

  const notifications: NotificationItem[] = [
    ...n.pendingApprovals.map<NotificationItem>((a) => ({
      kind: "approval",
      title: `承認依頼: ${APPROVAL_TYPE_LABEL[a.type]}`,
      detail: `${a.title} (${yen(a.amount)})`,
      href: "/approvals?tab=mine",
    })),
    ...n.mentions.map<NotificationItem>((m) => ({
      kind: "mention",
      title: `${m.from} さんからメンション`,
      detail: m.body,
      href: `/messages/${m.threadId}`,
    })),
  ];
  for (const t of n.tasks) {
    notifications.push({ kind: "task", title: t.title, detail: t.detail, href: `/messages/${t.threadId}` });
  }
  for (const e of n.assignedEvents) {
    notifications.push({
      kind: "schedule",
      title: `${e.updated ? "予定が変更されました" : "予定の担当になりました"}: ${e.title}`,
      detail: `${e.when} · ${e.updated ? "変更" : "登録"} ${e.by}`,
      href: `/schedule/${e.id}`,
    });
  }
  if (n.myConflicts > 0) {
    notifications.push({ kind: "conflict", title: `あなたの予定が ${n.myConflicts} 件重複しています`, detail: "今後 2 週間に時間の重なる予定があります。予定表で日時・担当を調整してください", href: "/schedule?view=list&user=me&store=all&conflicts=1" });
  }
  if (n.newInquiries > 0) {
    notifications.push({ kind: "inquiry", title: `未対応の問い合わせ ${n.newInquiries} 件`, detail: "担当者の割当と初回対応をお願いします", href: "/inquiries?status=new" });
  }
  if (n.overdueInvoices > 0) {
    notifications.push({ kind: "overdue", title: `支払期日超過の請求 ${n.overdueInvoices} 件`, detail: "入金確認・督促が必要です", href: "/invoices?status=overdue" });
  }
  if (faxReview > 0) {
    notifications.push({ kind: "fax", title: `要確認の受信 FAX ${faxReview} 件`, detail: "未登録の番号からの FAX です。「取り込む」か「不要」を選んでください", href: "/fax?tab=review" });
  }
  if (faxReplies > 0) {
    notifications.push({ kind: "fax", title: `発注書への返信 FAX ${faxReplies} 件`, detail: "仕入先からの返信を確認してください (納期・数量の回答など)", href: "/fax?tab=inbox&unchecked=1" });
  }
  if (faxFailed > 0) {
    notifications.push({ kind: "fax", title: `FAX の送信に失敗 ${faxFailed} 件`, detail: "理由を確認して再送してください", href: "/fax?tab=outbox" });
  }
  if (signups.length > 0) {
    notifications.push({ kind: "signup", title: `新規登録の申請 ${signups.length} 件`, detail: `${signups.slice(0, 3).map((u) => `${u.name} (${ROLE_LABEL[u.role]})`).join("・")}${signups.length > 3 ? " ほか" : ""}。承認または却下してください`, href: "/staff#signups" });
  }

  return (
    <AppShell
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
        roleLabel: ROLE_LABEL[user.role],
        storeLabel: allStores ? "全店舗" : storeName(user.storeId),
        storeColor: allStores ? "#4a5ae8" : (store?.color ?? "#4a5ae8"),
        scopeLabel: allStores ? "全店舗の情報を閲覧できます" : `${storeName(user.storeId)} の情報のみ閲覧できます`,
        avatarSrc: avatarUrl(user),
        canManageStaff: canManageUsers(user),
      }}
      nav={nav}
      notifications={notifications}
      counts={{ approvals: n.pendingApprovals.length, mentions: n.mentions.length, signups: signups.length }}
      logoutAction={logout}
    >
      {children}
    </AppShell>
  );
}
