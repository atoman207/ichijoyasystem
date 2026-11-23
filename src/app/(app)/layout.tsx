import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { notificationsFor, storeById, storeName } from "@/lib/db/queries";
import { canApproveSignup, canExportAccounting, canExportData, canManageMaps, canManageSettings, canManageUsers, canRegisterPurchase, canSeeAllStores, canTriageFax, canViewFax, canViewRegistry, canViewReports, canViewSuppliers } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/store";
import { avatarUrl } from "@/lib/account-rules";
import { ROLE_LABEL, APPROVAL_TYPE_LABEL } from "@/lib/constants";
import { AppShell, type NavItem, type NotificationItem } from "@/components/layout/AppShell";
import { logout } from "@/lib/actions/auth";
import { canViewMgmt } from "@/lib/mgmt/access";
import { canViewPromoAnalysis } from "@/lib/auth/permissions";
import { yen } from "@/lib/format";
import { policyReader } from "@/lib/access-policy";
import { canApproveLeave } from "@/lib/auth/permissions";
import { canManageHeriStock } from "@/lib/auth/permissions";
import { officeCtx } from "@/lib/office";
import { heriBelow } from "@/lib/heri-stock";
import { canManageKnowledgeSources, canViewKnowledge } from "@/lib/auth/permissions";
import { isManagerOrAbove } from "@/lib/auth/permissions";
import { liveSignature } from "@/lib/notify-live";
import { BACKEND } from "@/lib/db/store";
import { knowledgeSources } from "@/lib/knowledge";
import { myReviewItems, reviewCtx } from "@/lib/knowledge-review";
import { cronHealth } from "@/lib/knowledge-sync";
import { docDraftAttention } from "@/lib/doc-drafts";
import { casePostAttention } from "@/lib/case-posts";
import { pendingReceptionCount } from "@/lib/reception";

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
  // 休暇の申請 (承認できる人: 店長は自店舗の社員、管理者は全員。src/lib/hr)
  const leavePending = (getDb().leaveRequests ?? []).filter((r) => r.status === "pending" && canApproveLeave(user, r));

  // short: ヘッダーのタブに表示する短い名前 (正式名はツールチップに表示)
  const nav: NavItem[] = [
    { href: "/", label: "ダッシュボード", short: "ホーム", icon: "dashboard" },
    { href: "/customers", label: "顧客", icon: "customers", group: "営業・施工" },
    { href: "/inquiries", label: "問い合わせ", icon: "inquiries", group: "営業・施工", badge: n.newInquiries + pendingReceptionCount(getDb(), user) || undefined },
    { href: "/quotes", label: "見積", icon: "quotes", group: "営業・施工" },
    { href: "/orders", label: "受注・施工", icon: "orders", group: "営業・施工" },
    { href: "/cases", label: "案件の進捗 (問い合わせ〜入金・全処理完了)", short: "案件進捗", icon: "cases", group: "営業・施工" },
    { href: "/schedule", label: "予定表", icon: "schedule", group: "営業・施工", badge: n.myConflicts || undefined, pinned: true },
    { href: "/work-reports", label: "作業日報 (引取・納品の件数・枚数の月次集計)", short: "作業日報", icon: "workReport", group: "営業・施工" },
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
  nav.push({ href: "/leave", label: "有給・休日出勤 (休暇の申請・承認・振休・年度の取得状況)", short: "有給・休暇", icon: "leave", group: "業務支援", badge: leavePending.length || undefined });
  // 事務 (事務改善シート・慶弔リスト) と縁在庫。縁在庫のバッジ = 共通在庫が規定量を下回った品番の数 (事務担当・本部・管理者・店長)
  const heriBadge = canManageHeriStock(user, officeCtx(getDb())) || user.role === "store_manager" ? heriBelow(getDb()).length : 0;
  nav.push({ href: "/office", label: "事務 (事務改善シート・慶弔リスト)", short: "事務", icon: "office", group: "業務支援" });
  nav.push({ href: "/heri", label: "縁在庫 (品番 × 場所の数量・入庫・振り分け・使用・棚卸)", short: "縁在庫", icon: "heri", group: "業務支援", badge: heriBadge || undefined });
  nav.push({ href: "/kpi", label: "KPI (アンケート・クレーム・口コミ・インセンティブ)", short: "KPI", icon: "kpi", group: "管理" });
  // 経営の数字の画面は、閲覧の範囲の設定で全社員に広げられる (src/lib/access-policy.ts)
  const figureReader = policyReader(getDb(), user);
  if (canViewReports(figureReader)) {
    nav.push({ href: "/reports", label: "経営ダッシュボード (売上・受注・施工・請求・経費)", short: "経営", icon: "reports", group: "管理" });
  }
  if (canViewPromoAnalysis(figureReader)) {
    nav.push({ href: "/promotions", label: "販促と媒体の分析 (チラシ・イベント・DM の反応)", short: "販促分析", icon: "promotions", group: "管理" });
  }
  if (canViewMgmt(figureReader)) {
    nav.push({ href: "/management", label: "管理会計 (店舗別損益・内部受注・材料原価・在庫・共通経費の案分)", short: "管理会計", icon: "management", group: "管理" });
  }
  if (canExportData(user)) {
    nav.push({ href: "/data", label: "データ入出力 (CSV・スプレッドシート)", short: "入出力", icon: "dataio", group: "管理" });
  }
  if (canViewRegistry(user)) {
    nav.push({ href: "/registry", label: "データ台帳 (全データ・クライアント資料・社内の活動の一覧)", short: "データ台帳", icon: "registry", group: "管理" });
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
      detail: a.type === "record_view" || a.type === "handover_change" ? a.title : `${a.title} (${yen(a.amount)})`,
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
  // 文書の下書き (src/lib/doc-drafts.ts): 承認を待っている文書 (承認できる人)・差し戻された自分の文書
  const drafts = docDraftAttention(getDb(), user);
  if (drafts.toApprove.length > 0) {
    notifications.push({ kind: "approval", title: `文書の承認依頼 ${drafts.toApprove.length} 件`, detail: `${drafts.toApprove.slice(0, 3).map((d) => d.title).join("・")}${drafts.toApprove.length > 3 ? " ほか" : ""}。内容を読んで承認するか差し戻してください`, href: "/ai/drafts?view=approve" });
  }
  if (drafts.returned.length > 0) {
    notifications.push({ kind: "task", title: `差し戻された文書 ${drafts.returned.length} 件`, detail: "理由を確かめて文面を直し、もう一度「内容を確認した」を押してください", href: "/ai/drafts?view=returned" });
  }
  // 施工事例の投稿 (src/lib/case-posts.ts): 確認を待っている投稿 (確認する人)・差し戻された自分の投稿・承認されてまだ投稿していない自分の投稿
  const posts = casePostAttention(getDb(), user);
  if (posts.toReview.length > 0) {
    notifications.push({ kind: "approval", title: `施工事例の投稿の確認依頼 ${posts.toReview.length} 件`, detail: `${posts.toReview.slice(0, 3).map((p) => p.title || p.number).join("・")}${posts.toReview.length > 3 ? " ほか" : ""}。投稿文と写真を確かめて承認するか差し戻してください`, href: "/materials?tab=cases&view=review" });
  }
  if (posts.returned.length > 0) {
    notifications.push({ kind: "task", title: `差し戻された施工事例の投稿 ${posts.returned.length} 件`, detail: "理由を確かめて直し、もう一度「確認を依頼する」を押してください", href: "/materials?tab=cases&view=draft" });
  }
  if (posts.toPost.length > 0) {
    notifications.push({ kind: "task", title: `承認された施工事例の投稿 ${posts.toPost.length} 件 (投稿待ち)`, detail: "文面をコピー・写真を保存して投稿し、投稿したら記録してください", href: "/materials?tab=cases&view=approved" });
  }
  if (leavePending.length > 0) {
    const nameOf = (id: string) => getDb().users.find((u) => u.id === id)?.name ?? "";
    notifications.push({ kind: "approval", title: `休暇の申請 ${leavePending.length} 件`, detail: `${leavePending.slice(0, 3).map((r) => `${nameOf(r.userId)} ${r.date.slice(5).replace("-", "/")}`).join("・")}${leavePending.length > 3 ? " ほか" : ""}。承認または却下してください`, href: "/leave?tab=approve" });
  }
  // 社内資料: 自分が担当で確認期限を過ぎたもの / スプレッドシートの同期の失敗・定期の同期の停止 (本部・管理者)。src/lib/knowledge-review.ts・knowledge-sync.ts
  {
    const kdb = getDb();
    const mine = myReviewItems(kdb.knowledge.filter((k) => canViewKnowledge(user, k)), user.id, reviewCtx(kdb));
    if (mine.overdue.length > 0) {
      notifications.push({ kind: "knowledge", title: `確認期限を過ぎた社内資料 ${mine.overdue.length} 件`, detail: `${mine.overdue.slice(0, 3).map((k) => k.title).join("・")}${mine.overdue.length > 3 ? " ほか" : ""}。内容を確かめて「確認した」を押してください`, href: "/knowledge?health=mine" });
    }
    if (canManageKnowledgeSources(user)) {
      const sources = knowledgeSources(kdb);
      for (const s of sources.filter((x) => x.failCount)) {
        notifications.push({ kind: "knowledge", title: `社内資料の同期に失敗: ${s.label}`, detail: `${s.failCount} 回続けて失敗 · ${(s.lastError ?? "").slice(0, 80)}`, href: `/knowledge/sources/${s.id}` });
      }
      const cron = cronHealth(kdb);
      if (sources.length && !cron.ok && BACKEND === "supabase") notifications.push({ kind: "knowledge", title: "社内資料の定期の同期が止まっています", detail: cron.detail, href: "/knowledge" });
    }
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
        canApprove: isManagerOrAbove(user),
      }}
      nav={nav}
      notifications={notifications}
      counts={{ approvals: n.pendingApprovals.length, mentions: n.mentions.length, signups: signups.length }}
      live={{ sig: liveSignature(user, n).sig }}
      logoutAction={logout}
    >
      {children}
    </AppShell>
  );
}
