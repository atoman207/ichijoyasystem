import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { notificationsFor, storeById, storeName } from "@/lib/db/queries";
import { canExportAccounting, canExportData, canManageSettings, canRegisterPurchase, canSeeAllStores, canViewReports, canViewSuppliers } from "@/lib/auth/permissions";
import { ROLE_LABEL, APPROVAL_TYPE_LABEL } from "@/lib/constants";
import { AppShell, type NavItem, type NotificationItem } from "@/components/layout/AppShell";
import { logout } from "@/lib/actions/auth";
import { yen } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const n = notificationsFor(user);
  const allStores = canSeeAllStores(user);
  const store = storeById(user.storeId);

  // short: ヘッダーのタブに表示する短い名前 (正式名はツールチップに表示)
  const nav: NavItem[] = [
    { href: "/", label: "ダッシュボード", short: "ホーム", icon: "dashboard" },
    { href: "/customers", label: "顧客", icon: "customers", group: "営業・施工" },
    { href: "/inquiries", label: "問い合わせ", icon: "inquiries", group: "営業・施工", badge: n.newInquiries || undefined },
    { href: "/quotes", label: "見積", icon: "quotes", group: "営業・施工" },
    { href: "/orders", label: "受注・施工", icon: "orders", group: "営業・施工" },
    { href: "/cases", label: "案件の進捗 (問い合わせ〜入金・全処理完了)", short: "案件進捗", icon: "cases", group: "営業・施工" },
    { href: "/schedule", label: "予定表", icon: "schedule", group: "営業・施工", badge: n.myConflicts || undefined },
    { href: "/invoices", label: "請求・入金", icon: "invoices", group: "経理", badge: n.overdueInvoices || undefined },
    { href: "/finance", label: "入出金の予定 (未入金・支払待ち)", short: "入出金予定", icon: "finance", group: "経理" },
    { href: "/expenses", label: "経費精算", icon: "expenses", group: "経理" },
    { href: "/cashbook", label: "現金出納帳", short: "現金出納", icon: "cashbook", group: "経理" },
  ];
  if (canRegisterPurchase(user)) {
    nav.push({ href: "/purchases", label: "仕入・買掛 (支払依頼)", short: "仕入・買掛", icon: "purchases", group: "経理" });
  }
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
    { href: "/contacts", label: "連絡履歴 (お客様・協力業者)", short: "連絡履歴", icon: "contacts", group: "業務支援" },
    { href: "/ai", label: "AIアシスタント (質問・検索・文書の作成)", short: "AI", icon: "ai", group: "業務支援" },
    { href: "/knowledge", label: "社内資料 (ナレッジ・AI の回答の根拠)", short: "社内資料", icon: "knowledge", group: "業務支援" },
    { href: "/materials", label: "資料・写真", icon: "materials", group: "業務支援" },
  );
  nav.push({ href: "/kpi", label: "KPI (アンケート・クレーム・口コミ・インセンティブ)", short: "KPI", icon: "kpi", group: "管理" });
  if (canViewReports(user)) {
    nav.push({ href: "/reports", label: "経営ダッシュボード (売上・受注・施工・請求・経費)", short: "経営", icon: "reports", group: "管理" });
  }
  if (canExportData(user)) {
    nav.push({ href: "/data", label: "データ入出力 (CSV・スプレッドシート)", short: "入出力", icon: "dataio", group: "管理" });
  }
  nav.push({ href: "/audit", label: "変更履歴", icon: "audit", group: "管理" });
  nav.push({ href: "/settings", label: canManageSettings(user) ? "設定" : "設定 (閲覧)", short: "設定", icon: "settings", group: "管理" });
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
      }}
      nav={nav}
      notifications={notifications}
      counts={{ approvals: n.pendingApprovals.length, mentions: n.mentions.length }}
      logoutAction={logout}
    >
      {children}
    </AppShell>
  );
}
