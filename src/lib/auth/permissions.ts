import type { Approval, Attachment, AuditLog, CashEntry, DocDraft, Expense, FaxMessage, KnowledgeEntry, KnowledgeVisibility, MapDocument, PurchaseInvoice, PurchaseOrder, Role, ScheduleEvent, StoreId, Thread, User } from "@/lib/db/types";

/**
 * 権限ルール
 * ------------------------------------------------------------
 * - 管理者 / 本部スタッフ: 全店舗の情報を閲覧
 * - 店長 / 店舗スタッフ: 自店舗の情報のみ
 * - 承認: 店長は自店舗の「店長承認」案件、管理者は全案件
 * - 設定 (商品・承認ルール): 管理者のみ
 * - アカウント: 管理者は全員、店長は自店舗の店舗スタッフ (追加・変更・削除・新規登録の承認)。自分のログイン ID・パスワード・顔写真は本人
 * - 請求書の発行: 管理者・本部スタッフ・店長。入金の登録: 自店舗のメンバー (店舗スタッフも可)
 * - 仕入: 登録と支払依頼は店長 (自店舗)・本部スタッフ・管理者、支払の承認は管理者、支払完了と経費の精算は本部スタッフ・管理者
 * - 現金出納帳: 全員が自店舗 (全店舗ロールは全店舗)。会計データの出力: 本部スタッフ・管理者
 * - 承認: 自分が申請したものは承認できない (店長の申請は管理者が承認する)。管理者 (社長) の申請は承認を省略し、申請と同時に承認済みにする (skipsApproval)
 * - 経費: 店舗スタッフは自分の経費のみ、店長は自店舗、全店舗ロールは全件
 * - 社内連絡: 参加しているスレッド・自店舗のスレッド・全社向け (店舗指定なし) のスレッド。全店舗ロールは全件
 * - 予定表 (全社カレンダー): 全ロールが全店舗・全社員の予定を閲覧。登録は自店舗 (全店舗ロールは全店舗)、
 *   変更・削除は登録者・担当者・その店舗のメンバー。全社共通の予定は店長以上と本部スタッフ
 * - 発注書: 閲覧・作成・変更・FAX 送信は自店舗 (全店舗ロールは全件)。手書きの発注書と同じく、店舗の担当者が自店舗の名前で発注する
 * - FAX: 全店舗ロールは全件。店長・店舗スタッフは自店舗の FAX と、自分が送った・担当の FAX。
 *   受信 FAX の仕分け (要確認・不要の番号) は本部スタッフ・管理者。ひも付けの修正は本部スタッフ・管理者・自店舗の FAX の店長と、担当・登録した本人。
 *   不要に仕分けた FAX の完全な削除は管理者だけ (AI の判定だけでは削除しない)
 * - 地図・住宅地図: 場所と住宅地図の PDF は、その場所を参照する記録 (顧客・案件・予定) を見られる人が見られる (src/lib/maps/access.ts)。
 *   登録・差し替え・位置の修正は記録を扱える人、PDF の取り消しは登録した本人・その店舗の店長・管理者 (ほかの場所でも使っている PDF は取り消せない)。
 *   一括の正規化・PDF の一括取込・重複した場所のまとめは本部スタッフ・管理者
 */

/**
 * AI アシスタントの読み取り (検索・集計・SQL) だけで全店舗を見られるようにした利用者の写し
 * (設定 → AI アシスタント →「チャットボットの管理」の「AI アシスタントの閲覧範囲」= 全店舗のとき。src/lib/assistant/scope.ts)。
 * 本物の利用者は変えないので、画面・登録・変更・承認・実行の権限はそのまま
 */
const ALL_STORES_READ = new WeakSet<User>();
export function withAllStoresReadScope(user: User): User {
  const copy = { ...user };
  ALL_STORES_READ.add(copy);
  return copy;
}

export function canSeeAllStores(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff" || ALL_STORES_READ.has(user);
}

/** AI アシスタントの閲覧範囲 (権限どおり / 全店舗) を切り替える: 管理者 */
export function canManageAssistantScope(user: User): boolean {
  return user.role === "admin";
}

export function canAccessStore(user: User, storeId: StoreId): boolean {
  return canSeeAllStores(user) || user.storeId === storeId;
}

/** ユーザーが閲覧できる範囲に絞り込む */
export function scopeByStore<T extends { storeId: StoreId }>(user: User, items: T[]): T[] {
  if (canSeeAllStores(user)) return items;
  return items.filter((i) => i.storeId === user.storeId);
}

/** すべての承認依頼 (店長承認・管理者承認) を承認できる (自分の申請を除く) */
export function canApproveAll(user: User): boolean {
  return user.role === "admin";
}

/**
 * 承認を省略して、自分の申請をそのまま反映する: 管理者 (社長)。
 * 管理者は最終の承認者で、ほかに承認できる人がいないため、見積・契約 (受注)・契約内容の変更・経費・仕入の支払の申請は
 * 申請と同時に承認済みになる (承認の記録は「管理者の申請のため承認を省略」として残す。src/lib/approval-decide.ts の settleOwnApproval)
 */
export function skipsApproval(user: Pick<User, "role">): boolean {
  return user.role === "admin";
}

/** 承認申請の取下げ: 申請者本人と管理者 */
export function canCancelApproval(user: User, approval: Pick<Approval, "requestedBy">): boolean {
  return approval.requestedBy === user.id || canApproveAll(user);
}

export function canApprove(user: User, approval: Pick<Approval, "storeId" | "requiredRole" | "requestedBy">): boolean {
  if (approval.requestedBy === user.id) return false;
  if (canApproveAll(user)) return true;
  if (user.role === "store_manager") {
    return approval.requiredRole === "store_manager" && approval.storeId === user.storeId;
  }
  return false;
}

/**
 * 承認者のロールを決める (見積・金額変更・受注 (契約)・経費)
 * - 本部の案件、または金額が基準以上 → 管理者
 * - 店舗の案件 → 店長。ただし、その店舗に申請者以外の有効な店長がいないとき
 *   (店長のいない店舗・店長本人の申請) は、承認できる人がいないので管理者
 * - 店長として数えるのは、申請者と同じ種類のアカウントだけ (社員の申請は社員の店長、デモ用アカウントの申請はデモ用の店長)。
 *   本番データにデモ用アカウントを加えても、社員の申請の承認先は変わらない
 */
export function approverRole(users: Pick<User, "id" | "email" | "role" | "storeId" | "active">[], storeId: StoreId, overThreshold: boolean, requesterId: string): "store_manager" | "admin" {
  if (storeId === "hq" || overThreshold) return "admin";
  const requester = users.find((u) => u.id === requesterId);
  const demo = requester ? isDemoAccount(requester) : false;
  // 確認用アカウント (お客様の画面確認用) は、実際の承認先の判定に入れない
  const hasManager = users.some(
    (u) => u.active && u.role === "store_manager" && u.storeId === storeId && u.id !== requesterId && !isReviewAccount(u) && isDemoAccount(u) === demo,
  );
  return hasManager ? "store_manager" : "admin";
}

/** デモ用アカウント (架空の 15 名。ログイン ID が予約ドメイン @ichijoya.example。src/lib/db/master.ts の USERS) */
export const DEMO_EMAIL_DOMAIN = "@ichijoya.example";
export function isDemoAccount(user: Pick<User, "email">): boolean {
  return user.email.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN);
}

/** 確認用アカウント (確認用リンクのロールボタンでログインするアカウント。src/lib/auth/review.ts) */
export function isReviewAccount(user: Pick<User, "id">): boolean {
  return user.id.startsWith("u_review_");
}

/** 承認者の説明 (監査ログ・メッセージ用) */
export function approverLabel(role: "store_manager" | "admin", overThreshold: boolean, thresholdLabel: string): string {
  if (role === "store_manager") return "店長承認";
  return overThreshold ? `管理者承認 (${thresholdLabel}以上)` : "管理者承認";
}

export function isManagerOrAbove(user: User): boolean {
  return user.role === "admin" || user.role === "store_manager";
}

export function canManageSettings(user: User): boolean {
  return user.role === "admin";
}

/** チャットボットの回答の修正・追加・削除、学習の実行、利用状況の確認 */
export function canManageChatbot(user: User): boolean {
  return user.role === "admin";
}

/**
 * アカウント管理 (社員の追加・変更・パスワードの再設定・有効と無効・削除・新規登録の承認)
 * - 管理者: すべてのアカウント (ロール・所属も変更できる)
 * - 店長: 自店舗の店舗スタッフ (ロールは店舗スタッフ・所属は自店舗に固定)
 */
export function canManageUsers(user: User): boolean {
  return user.role === "admin" || user.role === "store_manager";
}

/** そのアカウントを管理できるか (自分自身は プロフィール から変更する) */
export function canManageUser(user: User, target: Pick<User, "id" | "role" | "storeId">): boolean {
  if (user.role === "admin") return true;
  return user.role === "store_manager" && target.id !== user.id && target.role === "store_staff" && target.storeId === user.storeId;
}

/** アカウントに設定できるロール */
export function assignableRoles(user: User): Role[] {
  if (user.role === "admin") return [...ROLE_ORDER];
  return user.role === "store_manager" ? ["store_staff"] : [];
}

/** アカウントに設定できる所属 (店長は自店舗のみ) */
export function assignableStore(user: User, storeId: StoreId): boolean {
  return user.role === "admin" || (user.role === "store_manager" && storeId === user.storeId);
}

/** 新規登録の申請 (希望のロール・所属) を承認・却下できるか */
export function canApproveSignup(user: User, req: Pick<User, "id" | "role" | "storeId">): boolean {
  return canManageUser(user, req);
}

export function canManageFinance(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff";
}

export function canResetData(user: User): boolean {
  return user.role === "admin";
}

/** バックアップ (データベース・添付ファイル・写真を VPS に保存) をいつでも実行する・一覧を見る */
export function canRunBackup(user: User): boolean {
  return user.role === "admin";
}

/**
 * バックアップのダウンロード (データベース・添付ファイル・写真・チャットボット。社外に保管するため): 管理者。
 * お客様の個人情報をすべて含むため、初期パスワードのままの管理者はダウンロードできない (api/backups/download で確かめる)
 */
export function canDownloadBackup(user: User): boolean {
  return user.role === "admin";
}

/** 予定表は全社で共有する (予定の重複防止・人員配置の調整・社内の情報共有のため、全ロールが全店舗の予定を閲覧) */
export function canViewCompanySchedule(user: User): boolean {
  return user.active;
}

/** 全社共通の予定 (全店舗のカレンダーに載る社内行事・全社会議など) を登録・変更できる */
export function canManageCompanyEvents(user: User): boolean {
  return user.role !== "store_staff";
}

/** 予定を変更・削除できるか: 登録者・担当者・その店舗のメンバー (全店舗ロールは全件) */
export function canEditEvent(user: User, e: Pick<ScheduleEvent, "storeId" | "assigneeIds" | "createdBy" | "companyWide">): boolean {
  if (e.companyWide && !canManageCompanyEvents(user)) return false;
  return canAccessStore(user, e.storeId) || e.assigneeIds.includes(user.id) || e.createdBy === user.id;
}

/**
 * 添付ファイル (資料・写真) の削除: 登録した本人・管理者・その店舗の店長。
 * 閲覧と登録は添付先の記録 (顧客・案件など) の権限に従う (src/lib/attachments.ts)
 */
export function canDeleteAttachment(user: User, a: Pick<Attachment, "uploadedBy" | "storeId">): boolean {
  return a.uploadedBy === user.id || user.role === "admin" || (user.role === "store_manager" && user.storeId === a.storeId);
}

/** データの取込 (CSV・Google スプレッドシート): 書き出しと同じく全店舗を扱うロール (管理者・本部スタッフ) */
export function canImportData(user: User): boolean {
  return canSeeAllStores(user);
}

export const ROLE_ORDER: Role[] =["admin", "store_manager", "store_staff", "hq_staff"];

/** 経費を閲覧・申請・削除できるか (店舗スタッフは自分の経費のみ) */
export function canViewExpense(user: User, e: Pick<Expense, "storeId" | "submittedBy">): boolean {
  if (canSeeAllStores(user)) return true;
  if (user.role === "store_manager") return e.storeId === user.storeId;
  return e.submittedBy === user.id;
}

/** 社内連絡のスレッドを閲覧・返信できるか */
export function canViewThread(user: User, t: Pick<Thread, "storeId" | "participants" | "createdBy">): boolean {
  return canSeeAllStores(user) || t.participants.includes(user.id) || t.createdBy === user.id || !t.storeId || t.storeId === user.storeId;
}

/**
 * 業務依頼の「報告の確認 (完了)」「差し戻し」ができる: 依頼した人・管理者。
 * システム (外部連携。AI 受付の引き継ぎで店長が引き継ぎ先のとき) が依頼した業務は、依頼先が自分で完了にできる (確かめる人がいないため)
 */
export function canConfirmTask(user: User, t: Pick<Thread, "createdBy" | "assigneeIds">): boolean {
  return t.createdBy === user.id || user.role === "admin" || (t.createdBy === "system" && (t.assigneeIds ?? []).includes(user.id));
}

/** 資料台帳 (経営・人事・経理の資料を含む Google ドライブの共有資料一覧) を閲覧できる: 管理者・本部スタッフ */
export function canViewSourceFiles(user: User): boolean {
  return canSeeAllStores(user);
}

/** レポート・分析を閲覧できる: 店長・本部スタッフ・管理者 */
export function canViewReports(user: User): boolean {
  return isManagerOrAbove(user) || canSeeAllStores(user);
}

/** 全データのエクスポート (JSON / CSV): 管理者・本部スタッフ */
export function canExportData(user: User): boolean {
  return canSeeAllStores(user);
}

/** KPI (アンケート・クレーム・手直し・口コミの集計) を閲覧できる: 全員 (店舗スタッフは自店舗と全社の集計、社員別は自分の分) */
export function canViewKpi(user: User): boolean {
  return user.active;
}

/** アンケート・口コミの修正・削除、クレーム・手直しの削除: 店長・本部スタッフ・管理者 (登録は全員。はがきの取込・案件からの報告) */
export function canManageKpi(user: User): boolean {
  return isManagerOrAbove(user) || canSeeAllStores(user);
}

/** 社員別の KPI・インセンティブ (支給額) を閲覧できる: 管理者・本部スタッフは全員、店長は自店舗の社員、店舗スタッフは自分 */
export function canViewStaffKpi(user: User, target: Pick<User, "id" | "storeId">): boolean {
  if (canSeeAllStores(user)) return true;
  if (user.role === "store_manager") return target.storeId === user.storeId;
  return target.id === user.id;
}

/* ---------------- Phase 4: 経費・仕入・現金出納・会計・履歴 ---------------- */

/** 仕入先・協力業者の台帳を見る: 本部スタッフ・管理者・店長 (店長は支払依頼・やりとりの記録に使う) */
export function canViewSuppliers(user: User): boolean {
  return canManageFinance(user) || user.role === "store_manager";
}

/** 仕入先・協力業者の登録・変更: 本部スタッフ・管理者 */
export function canEditSuppliers(user: User): boolean {
  return canManageFinance(user);
}

/** 仕入請求書の登録と支払依頼: 本部スタッフ・管理者 (全店舗)、店長 (自店舗) */
export function canRegisterPurchase(user: User): boolean {
  return canManageFinance(user) || user.role === "store_manager";
}

/** 仕入請求書を見る: 本部スタッフ・管理者は全件、店長は自店舗 */
export function canViewPurchase(user: User, p: Pick<PurchaseInvoice, "storeId">): boolean {
  return canManageFinance(user) || (user.role === "store_manager" && p.storeId === user.storeId);
}

/** 仕入の支払完了・経費の精算 (お金を払う処理): 本部スタッフ・管理者 */
export function canPay(user: User): boolean {
  return canManageFinance(user);
}

/** 現金出納帳: 全員が自店舗 (全店舗ロールは全店舗) を閲覧・記帳 */
export function canViewCashbook(user: User, storeId: StoreId): boolean {
  return user.active && canAccessStore(user, storeId);
}

/** 現金出納の行の変更・削除: 記帳した本人 (手入力の行)・その店舗の店長・本部スタッフ・管理者。自動の記帳は本部スタッフ・管理者のみ削除できる */
export function canEditCashEntry(user: User, c: Pick<CashEntry, "storeId" | "recordedBy" | "source">): boolean {
  if (canManageFinance(user)) return true;
  if (c.source !== "manual" && c.source !== "opening") return false;
  return (c.recordedBy === user.id && canAccessStore(user, c.storeId)) || (user.role === "store_manager" && user.storeId === c.storeId);
}

/** 会計データ (仕訳・明細) の出力と、会計の設定: 本部スタッフ・管理者 */
export function canExportAccounting(user: User): boolean {
  return canManageFinance(user);
}

/** 店舗スタッフが自店舗の履歴を見られる対象 (案件・顧客・予定・請求など。経費・承認・設定などは見ない) */
/** 店舗スタッフが見られる変更履歴の対象 (所属店舗のもの)。AI の SQL の範囲 (model.ts の scopeStatements) も同じものを使う */
export const STAFF_AUDIT_ENTITIES = new Set(["customer", "inquiry", "quote", "order", "invoice", "payment", "schedule", "document", "attachment", "survey", "quality", "review", "comm", "cash", "thread", "purchase_order", "fax", "map_location", "map_document", "work_report", "doc_draft"]);

/**
 * 変更履歴 (監査ログ) の閲覧範囲
 * - 管理者: すべて
 * - 本部スタッフ: すべて (ほかの社員のログイン・ログアウトを除く)
 * - 店長: 自店舗の記録と自分の操作 (ほかの社員のログイン・ログアウトを除く)
 * - 店舗スタッフ: 自分の操作と、自店舗の案件・顧客・予定・請求などの記録
 */
export function canViewAuditEntry(user: User, l: Pick<AuditLog, "userId" | "storeId" | "entity">): boolean {
  if (user.role === "admin") return true;
  if (l.userId === user.id) return true;
  if (l.entity === "session") return false;
  if (user.role === "hq_staff") return true;
  if (!l.storeId || l.storeId !== user.storeId) return false;
  if (user.role === "store_manager") return true;
  return STAFF_AUDIT_ENTITIES.has(l.entity);
}

/** 変更履歴の書き出し (CSV): 管理者・本部スタッフ */
/** 顧客の重要情報を承認なしで変更できる (その店舗の承認者 = 店長と管理者) */
export function canApplyCustomerChange(user: User, storeId: StoreId): boolean {
  return user.role === "admin" || (user.role === "store_manager" && user.storeId === storeId);
}

export function canExportAudit(user: User): boolean {
  return canSeeAllStores(user);
}

/** 外部連携の接続確認 (テスト送信) と送信履歴の閲覧: 管理者 */
export function canManageIntegrations(user: User): boolean {
  return user.role === "admin";
}

/**
 * 顧客の新規登録 (重複を防ぐため、登録できる人を絞る)。
 * 管理者・本部スタッフ・事務担当 (設定 → KPI・インセンティブ の事務担当) は常に可。
 * mode: office = 事務のみ (初期設定) / office_and_managers = 店長も可 / all = 全員
 */
export function canCreateCustomer(user: User, ctx: { mode: "office" | "office_and_managers" | "all"; clerkUserIds: string[] }): boolean {
  if (user.role === "admin" || user.role === "hq_staff" || ctx.clerkUserIds.includes(user.id)) return true;
  if (ctx.mode === "all") return true;
  return ctx.mode === "office_and_managers" && user.role === "store_manager";
}

/**
 * 社内資料 (ナレッジ) を閲覧できる (AI アシスタントも同じ範囲で回答に使う)。
 * visibility: all (既定) = 全員 / manager = 店長・本部スタッフ・管理者 / hq = 本部スタッフ・管理者 / admin = 管理者のみ
 */
export function canViewKnowledge(user: User, k: Pick<KnowledgeEntry, "visibility">): boolean {
  switch (k.visibility ?? "all") {
    case "all":
      return true;
    case "manager":
      return user.role === "admin" || user.role === "hq_staff" || user.role === "store_manager";
    case "hq":
      return user.role === "admin" || user.role === "hq_staff";
    case "admin":
      return user.role === "admin";
  }
  return false;
}

/** 社内資料の「見られる人」のうち、この人が見られるもの (資料庫の検索の範囲にも使う) */
export function knowledgeVisibilities(user: User): KnowledgeVisibility[] {
  return (["all", "manager", "hq", "admin"] as const).filter((v) => canViewKnowledge(user, { visibility: v }));
}

/** データ台帳 (/registry: 全データの一覧・データフォルダー・クライアント資料の資料庫・全社の活動): 管理者・本部スタッフ */
export function canViewRegistry(user: User): boolean {
  return canSeeAllStores(user);
}

/** データ台帳の資料の扱いの変更 (見られる人・分類・社内資料への登録・取り込まない)・資料の追加: 管理者・本部スタッフ */
export function canManageRegistry(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff";
}

/** 資料庫の資料を見られるか (見られる人 + 店舗の資料は所属店舗だけ。店舗のロールにほかの店舗の数字を見せない) */
export function canViewMaterial(user: User, m: { visibility: KnowledgeVisibility; storeId?: StoreId }): boolean {
  if (!canViewKnowledge(user, { visibility: m.visibility })) return false;
  if (canSeeAllStores(user)) return true;
  return !m.storeId || m.storeId === user.storeId;
}

/** AI アシスタントの相談履歴: 自分の履歴は全員。全員の履歴の閲覧・検索は管理者・本部スタッフ (店長は自店舗の社員の分) */
export function canViewChatLog(user: User, log: { userId: string; storeId?: string }): boolean {
  if (log.userId === user.id) return true;
  if (canSeeAllStores(user)) return true;
  return user.role === "store_manager" && log.storeId === user.storeId;
}

/** 相談の回答を社内資料 (よくある質問) として登録できる: 社内資料を編集できる人 */
export function canShareChatToKnowledge(user: User): boolean {
  return canEditKnowledge(user);
}

/** 社内資料 (ナレッジ) の登録・修正: 店長・本部スタッフ・管理者 (閲覧と AI での利用は全員。visibility で絞れる) */
export function canEditKnowledge(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff" || user.role === "store_manager";
}

/** 社内資料の取込元 (Google スプレッドシート) の登録・同期: 本部スタッフ・管理者 */
export function canManageKnowledgeSources(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff";
}

/* ---------------- 文書の下書き (AI アシスタントの「文書の作成」。src/lib/doc-drafts.ts) ---------------- */

type DraftRef = Pick<DocDraft, "storeId" | "createdBy" | "status">;

/** 文書を承認できるロール: 管理者・本部スタッフ・その店舗の店長 */
function isDraftApprover(user: User, d: Pick<DocDraft, "storeId">): boolean {
  return user.role === "admin" || user.role === "hq_staff" || (user.role === "store_manager" && user.storeId === d.storeId);
}

/** 文書の下書きを見られる: 作成者と、文書の店舗を見られる人 (店舗のロールは自店舗、本部・管理者は全店舗) */
export function canViewDocDraft(user: User, d: Pick<DocDraft, "storeId" | "createdBy">): boolean {
  return d.createdBy === user.id || canAccessStore(user, d.storeId);
}

/** 文面の修正: 送信前の文書を、作成者と承認できる人 (修正すると確認・承認はやり直し) */
export function canEditDocDraft(user: User, d: DraftRef): boolean {
  return (d.status === "draft" || d.status === "reviewed" || d.status === "approved") && canViewDocDraft(user, d) && (d.createdBy === user.id || isDraftApprover(user, d));
}

/** 「内容を確認した」(下書き → 確認済み): 文書を見られる人 (作成者を含む) */
export function canReviewDocDraft(user: User, d: DraftRef): boolean {
  return d.status === "draft" && canViewDocDraft(user, d);
}

/** 承認 (確認済み → 承認済み): 管理者・本部スタッフ・その店舗の店長。作成者は自分の文書を承認できない (管理者 = 社長は省略できる skipsApproval) */
export function canApproveDocDraft(user: User, d: DraftRef): boolean {
  return d.status === "reviewed" && canViewDocDraft(user, d) && isDraftApprover(user, d) && (d.createdBy !== user.id || skipsApproval(user));
}

/** 差し戻し (確認済み・承認済み → 下書き): 作成者と承認できる人 */
export function canReturnDocDraft(user: User, d: DraftRef): boolean {
  return (d.status === "reviewed" || d.status === "approved") && canViewDocDraft(user, d) && (d.createdBy === user.id || isDraftApprover(user, d));
}

/** 破棄 (送信前) と、破棄した文書を下書きに戻す: 作成者と承認できる人 */
export function canDiscardDocDraft(user: User, d: DraftRef): boolean {
  return d.status !== "sent" && canViewDocDraft(user, d) && (d.createdBy === user.id || isDraftApprover(user, d));
}

/** 送信 (メール・LINE・Chatwork) と「郵送・手渡しで送った」の記録: 承認済みの文書を、作成者と承認できる人 */
export function canSendDocDraft(user: User, d: DraftRef): boolean {
  return d.status === "approved" && canViewDocDraft(user, d) && (d.createdBy === user.id || isDraftApprover(user, d));
}

/* ---------------- 発注書・FAX ---------------- */

/**
 * 発注書を作成・変更し、FAX で送れる: 全員 (店舗のロールは自店舗の名前で発注する。手書きの発注書と同じく店舗の担当者が発注するため。
 * 店長のいない店舗 (合志店) でも発注できる)。どの発注書を扱えるかは canEditPurchaseOrder (店舗の範囲)
 */
export function canManagePurchaseOrders(user: User): boolean {
  return user.active;
}

/** 発注書を見る: 自店舗 (全店舗ロールは全件)。店舗スタッフも自店舗の発注を確認できる */
export function canViewPurchaseOrder(user: User, po: Pick<PurchaseOrder, "storeId">): boolean {
  return canAccessStore(user, po.storeId);
}

/** その発注書を変更・送信・取消できる */
export function canEditPurchaseOrder(user: User, po: Pick<PurchaseOrder, "storeId">): boolean {
  return canManagePurchaseOrders(user) && canAccessStore(user, po.storeId);
}

/** 受信 FAX の仕分け (要確認の FAX の「取り込む」「不要」・不要な番号の台帳・送信元を仕入先として登録): 本部スタッフ・管理者 */
export function canTriageFax(user: User): boolean {
  return canSeeAllStores(user);
}

/**
 * FAX を見る (PDF を含む)
 * - 全店舗ロール: すべて
 * - 店長・店舗スタッフ: 自店舗の FAX (送信と、取り込んだ受信) と、自分が送った・担当の FAX。要確認・不要の受信 FAX は見えない
 */
export function canViewFax(user: User, f: Pick<FaxMessage, "storeId" | "direction" | "triage" | "userId" | "assignedUserId">): boolean {
  if (canSeeAllStores(user)) return true;
  if (f.userId === user.id || f.assignedUserId === user.id) return true;
  if (f.storeId !== user.storeId) return false;
  return f.direction === "outbound" || f.triage === "auto" || f.triage === "accepted";
}

/** FAX のひも付け (仕入先・発注書・案件・担当者) の修正: 本部スタッフ・管理者、自店舗の FAX の店長、自店舗の FAX のうち担当・登録した本人 */
export function canEditFaxLinks(user: User, f: Pick<FaxMessage, "storeId" | "assignedUserId" | "userId">): boolean {
  if (canSeeAllStores(user)) return true;
  if (user.storeId !== f.storeId) return f.assignedUserId === user.id || f.userId === user.id;
  return user.role === "store_manager" || f.assignedUserId === user.id || f.userId === user.id;
}

/** FAX 番号の台帳に登録する (次から自動で判別される。全社に効くため): 本部スタッフ・管理者・店長 */
export function canRegisterFaxNumber(user: User): boolean {
  return canSeeAllStores(user) || user.role === "store_manager";
}

/** 不要に仕分けた FAX の完全な削除 (PDF を含む): 管理者 */
export function canDeleteFax(user: User): boolean {
  return user.role === "admin";
}

/* ---------------- 地図・住宅地図 ---------------- */

/**
 * 地図の一括処理 (顧客の住所の正規化・住宅地図の PDF の一括取込・重複した場所のまとめ)、地図の管理画面: 本部スタッフ・管理者
 * (全店舗の住所を扱うため、データの取込と同じ範囲)
 */
export function canManageMaps(user: User): boolean {
  return canSeeAllStores(user);
}

/**
 * 住宅地図の PDF の取り消し (台帳は残し、ファイルの本体を消す): 登録した本人・管理者・その店舗の店長。
 * ほかの場所でも使っている PDF は取り消せない (先にこの場所から外す。src/lib/actions/maps.ts)
 */
export function canRemoveMapDocument(user: User, d: Pick<MapDocument, "uploadedBy" | "storeId">): boolean {
  return d.uploadedBy === user.id || user.role === "admin" || (user.role === "store_manager" && user.storeId === d.storeId);
}

/* ---------------- 予定の計画 (src/lib/scheduling) ---------------- */

/** 予定の計画 (作業の内容の登録・仮押さえ・確定・お客様への候補の案内・製造の予定・全体の最適化の実行): その店舗のメンバー・本部・管理者 */
export function canPlanSchedule(user: User, storeId: StoreId): boolean {
  return canAccessStore(user, storeId);
}

/** 計画のマスタ (作業種別・製造工程・技能・車両と設備・経路・最適化の重み・計画の基準) の変更: 管理者 */
export function canManageScheduling(user: User): boolean {
  return user.role === "admin";
}

/** 休日カレンダー (会社の休業日の登録・変更・まとめて登録、祝日の追加・変更・外す): 管理者。見るのは全員 */
export function canManageHolidays(user: User): boolean {
  return user.role === "admin";
}

/** 社員の勤務と技能の設定: 管理者は全員、店長は自店舗の社員 */
export function canEditStaffProfile(user: User, target: Pick<User, "storeId">): boolean {
  return user.role === "admin" || (user.role === "store_manager" && user.storeId === target.storeId);
}

/** 仮押さえへの「行ける / 行けない」の返事: 担当者本人と、その店舗のメンバー */
export function canAckHold(user: User, h: { storeId: StoreId; assigneeIds: string[] }): boolean {
  return h.assigneeIds.includes(user.id) || canAccessStore(user, h.storeId);
}

/** 提案の検証 (過去の予定との比較) の実行: 全店舗を見られるロール (管理者・本部)。重みの適用は管理者 */
export function canRunScheduleBacktest(user: User): boolean {
  return canSeeAllStores(user);
}

/* ---------------- 事務 (事務改善シート・慶弔リスト。src/lib/office.ts・/office) ---------------- */

/** 事務の権限の判定に使う情報: 事務担当の社員 (設定 → KPI・インセンティブ の事務担当。src/lib/office.ts の officeCtx で作る) */
export interface OfficeCtx {
  clerkUserIds: string[];
  /** 慶弔リストを見られる人: all = 有効な社員全員 (既定。お客様の決定 2026-11-20) / office = 事務担当・本部スタッフ・管理者だけ (設定の id = office_access) */
  condolenceViewers: "all" | "office";
}

/** 事務の担当: 管理者・本部スタッフ・事務担当に選ばれた社員 (店舗ロールでも可。顧客の新規登録と同じ考え方) */
function isOfficeStaff(user: User, ctx: OfficeCtx): boolean {
  return user.active && (user.role === "admin" || user.role === "hq_staff" || ctx.clerkUserIds.includes(user.id));
}

/** 事務改善シートを見る・書き出す: 全員 (事務のミスと改善策を全社で共有するため) */
export function canViewOfficeImprovements(user: User): boolean {
  return user.active;
}

/** 事務改善シートの登録・修正・削除・取込: 事務担当・本部スタッフ・管理者 */
export function canEditOfficeImprovements(user: User, ctx: OfficeCtx): boolean {
  return isOfficeStaff(user, ctx);
}

/**
 * 慶弔リストの閲覧・登録・修正・削除・取込・書き出し: 事務担当・本部スタッフ・管理者。
 * 社員・取引先のご家族の情報 (喪主・関係・金額) を含むため、ほかの社員には画面のタブも出さない。
 * AI の SQL (src/lib/datastore/model.ts の scopeStatements) では全店舗ロールだけが見られる
 */
export function canViewCondolences(user: User, ctx: OfficeCtx): boolean {
  return isOfficeStaff(user, ctx) || (user.active && ctx.condolenceViewers === "all");
}

/** 慶弔リストを見られる人の切り替え (全社員 / 事務担当・本部・管理者): 管理者 */
export function canManageOfficeAccess(user: User): boolean {
  return user.role === "admin";
}

export function canEditCondolences(user: User, ctx: OfficeCtx): boolean {
  return isOfficeStaff(user, ctx);
}

/* ---------------- 縁在庫 (src/lib/heri-stock.ts・/heri) ---------------- */

/**
 * 縁在庫 (品番 × 場所の数量・規定量・登録の履歴) を見る: 全員。
 * 原価・単価・金額はこの画面と書き出しに出さない (原価は管理会計 /management の権限 src/lib/mgmt/access.ts のまま)
 */
export function canViewHeriStock(user: User): boolean {
  return user.active;
}

/** 縁の品番の登録・変更 (発注先・単位・規定量)・縁在庫表の取込: 事務担当・本部スタッフ・管理者 */
export function canManageHeriStock(user: User, ctx: OfficeCtx): boolean {
  return isOfficeStaff(user, ctx);
}

export type HeriOp = "receive" | "transfer" | "use" | "count";

/**
 * 縁の数量の登録 (場所は "store:<店舗 ID>"。共通在庫は store:hq)
 * - 入庫 (仕入先 → 共通在庫など): 事務担当・本部スタッフ・管理者
 * - 振り分け (場所 → 場所): 事務担当・本部スタッフ・管理者。店長は共通在庫と自店舗の間
 * - 使用: 全員。店舗ロールは自店舗の在庫か共通在庫から
 * - 棚卸 (数えた数量の登録): 事務担当・本部スタッフ・管理者。店長は自店舗
 */
export function canRecordHeriMove(user: User, op: HeriOp, loc: { from?: string; to?: string }, ctx: OfficeCtx): boolean {
  if (!user.active) return false;
  if (isOfficeStaff(user, ctx)) return true;
  const own = `store:${user.storeId}`;
  const common = "store:hq";
  switch (op) {
    case "receive":
      return false;
    case "transfer":
      return user.role === "store_manager" && (loc.from === own || loc.to === own) && [loc.from, loc.to].every((l) => l === own || l === common);
    case "use":
      return loc.from === own || loc.from === common;
    case "count":
      return user.role === "store_manager" && loc.to === own;
  }
  return false;
}

/** 縁の登録の取消し (逆向きの行を追加。元の行は残す): 登録した本人・事務担当・本部スタッフ・管理者 */
export function canReverseHeriMove(user: User, m: { createdBy: string }, ctx: OfficeCtx): boolean {
  return user.active && (m.createdBy === user.id || isOfficeStaff(user, ctx));
}

/* ---------------- 作業日報・販促と媒体の分析 (src/lib/ops-reports・/work-reports・/promotions) ---------------- */

/** 作業日報 (店舗・月ごとの引取・納品・施工・見積の件数・枚数・担当) の閲覧・印刷・CSV: その店舗のメンバー (全店舗ロールは全店舗) */
export function canViewWorkReport(user: User, storeId: StoreId): boolean {
  return user.active && canAccessStore(user, storeId);
}

/** 作業日報の手入力 (チラシの配布人・枚数・地域、来店数、メモ): その店舗のメンバー (事務担当を含む。全店舗ロールは全店舗) */
export function canEditWorkReport(user: User, storeId: StoreId): boolean {
  return user.active && canAccessStore(user, storeId);
}

/** 作業日報の係数 (障子・網戸の襖換算) と、媒体の対応表 (過去の値の読み替え) の変更: 本部スタッフ・管理者 */
export function canManageOpsReportSettings(user: User): boolean {
  return user.active && canSeeAllStores(user);
}

/** 販促と媒体の分析 (媒体別・町別・チラシの反応・年度の比較・CSV) と販促の記録の閲覧: 店長 (自店舗)・本部スタッフ・管理者 */
export function canViewPromoAnalysis(user: User): boolean {
  return user.active && canViewReports(user);
}

/** 販促の記録 (チラシ・イベント・点検の DM・テレアポ) の登録・変更・削除と、イベントの受付票の一括登録: 本部スタッフ・管理者 (全店舗)・店長 (自店舗) */
export function canEditPromotion(user: User, storeId: StoreId): boolean {
  return user.active && (canSeeAllStores(user) || (user.role === "store_manager" && user.storeId === storeId));
}

/* ---------------- 有給・休日出勤 (src/lib/hr/leave.ts・/leave) ---------------- */

/** 休暇・有給の残日数・休日出勤を見る: 本人、店長は自店舗の社員、本部スタッフ (事務)・管理者は全員 */
export function canViewLeaveOf(user: User, target: { id: string; storeId: StoreId }): boolean {
  if (target.id === user.id || canSeeAllStores(user)) return true;
  return user.role === "store_manager" && target.storeId === user.storeId;
}

/** 社員ごとの一覧・年度の取得状況・CSV を見る: 店長 (自店舗の社員)・本部スタッフ・管理者 */
export function canViewLeaveReport(user: User): boolean {
  return canSeeAllStores(user) || user.role === "store_manager";
}

/**
 * 休暇 (有給・振休・特別休暇) を申請できる: 本人。店長は自店舗の社員の分、本部スタッフ (事務)・管理者は全員の分を代わりに申請できる
 * (紙・LINE で受けた申請の登録。承認できる人が登録したときはそのまま承認済みになる)
 */
export function canRequestLeaveFor(user: User, target: { id: string; storeId: StoreId }): boolean {
  return canViewLeaveOf(user, target);
}

/**
 * 休暇の申請を承認・却下できる: 管理者は全件 (管理者自身の申請は承認を省略し、申請と同時に承認済み)、
 * 店長は自店舗の社員の申請 (自分の申請は管理者が承認する)。本部スタッフは承認しない
 */
export function canApproveLeave(user: User, req: { userId: string; storeId: StoreId }): boolean {
  if (user.role === "admin") return true;
  return user.role === "store_manager" && req.storeId === user.storeId && req.userId !== user.id;
}

/**
 * 休暇の取消し: 申請中は本人・申請した人・承認できる人。
 * 承認済みは承認できる人 (店長・管理者) と、まだ始まっていない休暇の本人 (予定表の「休暇」も消える)
 */
export function canCancelLeave(user: User, req: { userId: string; storeId: StoreId; requestedBy: string; status: string; date: string }, today: string): boolean {
  if (req.status === "pending") return req.userId === user.id || req.requestedBy === user.id || canApproveLeave(user, req);
  if (req.status !== "approved") return false;
  return canApproveLeave(user, req) || (req.userId === user.id && req.date > today);
}

/** 休日出勤の登録・削除と、振休の登録 (承認済みとして): 本部スタッフ (事務)・管理者は全員、店長は自店舗の社員 */
export function canRegisterHolidayWork(user: User, target: { storeId: StoreId }): boolean {
  return canSeeAllStores(user) || (user.role === "store_manager" && target.storeId === user.storeId);
}

/** 有給の付与の登録・修正・削除、切り替え時点の残日数の取込、社員の基準日・雇い入れ日の設定: 本部スタッフ (事務)・管理者 */
export function canManageLeaveGrants(user: User): boolean {
  return canSeeAllStores(user);
}

/** 有給・振休のルール (振休のため込みの上限・有給の消化の順番・年度・締め日・半日の時間帯) の変更: 管理者 */
export function canManageLeaveSettings(user: User): boolean {
  return user.role === "admin";
}
