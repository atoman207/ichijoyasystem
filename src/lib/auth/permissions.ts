import type { Approval, ApprovalType, Attachment, AuditLog, CashEntry, DocDraft, Expense, FaxMessage, KnowledgeEntry, KnowledgeVisibility, MapDocument, PurchaseInvoice, PurchaseOrder, Role, ScheduleEvent, StoreId, Thread, User } from "@/lib/db/types";
import type { CasePost, TidyCheck } from "@/lib/db/types";

/**
 * 権限ルール
 * ------------------------------------------------------------
 * - 管理者 / 本部スタッフ: 全店舗の情報を閲覧
 * - 店長 / 店舗スタッフ: 自店舗の情報のみ。ただし進行中の案件 (問い合わせ → 入金完了まで) は、ほかの店舗の案件も閲覧のみ (canViewOpenCases)
 * - 顧客・問い合わせ・見積・受注の登録・変更: 店長は全店舗 (お客様の決定 2026-11-23。canEditCaseStore)、店舗スタッフは自店舗。
 *   請求書・入金・経費・仕入・予定表などはこれまでどおり自店舗 (canAccessStore)
 * - 閲覧の範囲の設定 (src/lib/access-policy.ts。既定 = 経営の数字・顧客情報とも全社員): 経営の数字 (canSeeAllStoreFigures) と
 *   顧客情報 (canSeeAllCustomerRecords) の閲覧だけを全店舗に広げる。policyReader が作る写しで判定し、登録・変更は本物の利用者 (canAccessStore・canEditCaseStore)
 * - 入金完了・全処理完了の案件の内容の変更: 管理者のみ (canEditCompletedCase)
 * - 承認: 店長は自店舗の「店長承認」案件、管理者は全案件。店長の申請はすべて管理者が承認する (approverRole)
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

/* ---------------- 閲覧の範囲の設定 (src/lib/access-policy.ts) ---------------- */

/** 閲覧の範囲の設定で広げた読み取り (経営の数字 / 顧客情報)。本物の利用者は変えず、写しに印を付ける */
export interface ReadWidening {
  figures?: boolean;
  customers?: boolean;
}
const READ_WIDENING = new WeakMap<User, ReadWidening>();

/** 閲覧の範囲の設定 (access_policy) から、その人の読み取りをどこまで広げるか */
export function readWideningFor(user: Pick<User, "role" | "active">, policy: { figures: string; customers: string }): ReadWidening {
  if (!user.active) return {};
  return {
    figures: policy.figures === "all",
    // 承認制 (approval) のとき、店長は全店舗の顧客情報を見られる (本部スタッフ・管理者はもともと全店舗)
    customers: policy.customers === "all" || (policy.customers === "approval" && user.role === "store_manager"),
  };
}

/** 読み取りを広げた利用者の写し (広げるものがなければそのまま返す)。画面の表示・集計・AI の読み取りにだけ使う */
export function withReadWidening(user: User, w: ReadWidening): User {
  if (!w.figures && !w.customers) return user;
  const copy = { ...user };
  const prev = READ_WIDENING.get(user);
  READ_WIDENING.set(copy, { figures: Boolean(w.figures || prev?.figures), customers: Boolean(w.customers || prev?.customers) });
  if (ALL_STORES_READ.has(user)) ALL_STORES_READ.add(copy);
  return copy;
}

/** 全店舗の経営の数字 (売上・原価・粗利・KPI の店舗の集計・管理会計・販促の分析) を見られる */
export function canSeeAllStoreFigures(user: User): boolean {
  return canSeeAllStores(user) || Boolean(user.active && READ_WIDENING.get(user)?.figures);
}

/** その店舗の経営の数字を見られる */
export function canViewStoreFigures(user: User, storeId: StoreId): boolean {
  return canSeeAllStoreFigures(user) || canAccessStore(user, storeId);
}

/** 全店舗の顧客情報 (顧客・問い合わせ・見積・受注・請求書・写真・施工の履歴) を閲覧できる (ほかの店舗は閲覧のみ) */
export function canSeeAllCustomerRecords(user: User): boolean {
  return canSeeAllStores(user) || Boolean(user.active && READ_WIDENING.get(user)?.customers);
}

/** その店舗の顧客情報を閲覧できる (進行中の案件・閲覧の申請の承認は src/lib/case-access.ts で別に判定する) */
export function canReadStoreRecords(user: User, storeId: StoreId): boolean {
  return canSeeAllCustomerRecords(user) || canAccessStore(user, storeId);
}

/** 閲覧の範囲の設定の変更: 管理者 */
export function canManageAccessPolicy(user: User): boolean {
  return user.active && user.role === "admin";
}

/** 完了した案件のお客様の閲覧を申請できる (閲覧の範囲 = 承認制のとき、全店舗を見られない人) */
export function canRequestRecordView(user: User, policy: { customers: string }): boolean {
  return user.active && policy.customers === "approval" && !canSeeAllStores(user) && user.role !== "store_manager";
}

/** AI アシスタントの閲覧範囲 (権限どおり / 全店舗) を切り替える: 管理者 */
export function canManageAssistantScope(user: User): boolean {
  return user.role === "admin";
}

export function canAccessStore(user: User, storeId: StoreId): boolean {
  return canSeeAllStores(user) || user.storeId === storeId;
}

/**
 * 顧客・問い合わせ・見積・受注 (とその現場の情報・日程・進捗・やりとり・写真) を登録・変更できる店舗:
 * 自店舗 (全店舗ロールは全店舗) と、店長はすべての店舗。
 * お客様の決定 (2026-11-23):「店長には全ての顧客の情報と見積・受注の編集権限をあたえてほしいです。承認は管理者。」
 * 店長の申請の承認は管理者 (approverRole)。入金完了・全処理完了の案件は管理者だけ (canEditCompletedCase) のまま。
 * 請求書・入金・経費・仕入・予定表・受付などは canAccessStore のまま (自店舗)
 */
export function canEditCaseStore(user: User, storeId: StoreId): boolean {
  return canAccessStore(user, storeId) || Boolean(user.active && user.role === "store_manager");
}

/**
 * 進行中の案件 (問い合わせ → 入金完了まで) は、ほかの店舗の案件も閲覧できる: 全社員 (お客様のご要望)。
 * 閲覧だけで、登録・変更はその店舗の社員と店長 (canEditCaseStore)。入金完了・全処理完了・失注のあとは通常の権限に戻る (src/lib/case-access.ts)
 */
export function canViewOpenCases(user: User): boolean {
  return Boolean(user.active);
}

/** 入金完了・全処理完了の案件の内容 (案件情報・契約内容・現場の情報・見積) を変更する: 管理者だけ (src/lib/case-access.ts) */
export function canEditCompletedCase(user: User): boolean {
  return user.role === "admin";
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
 * 店長が承認を省略できる申請の種類 (お客様の決定 2026-11-24「追加のお願い ①権限設定」: 店長の顧客情報の登録・変更、見積・受注の登録・変更は
 * 管理者の承認不要。入金・確定した売上 (施工完了した受注) の変更、経費・仕入の支払は今までどおり承認。src/lib/approval-decide.ts の settleOwnApproval)
 */
export const MANAGER_SELF_APPROVE_TYPES: readonly ApprovalType[] = ["quote", "quote_amend", "order", "order_change", "handover_change", "customer_change", "store_change"];

/**
 * 承認を省略して、自分の申請をそのまま反映する: 管理者 (社長) はすべて、店長は顧客・見積・受注 (MANAGER_SELF_APPROVE_TYPES)。
 * 申請と同時に承認済みになる (承認の記録は「…の申請のため承認を省略」として残す)。種類を渡さなければ管理者だけ (経費・仕入・文書など)。
 * 店長でも確定した売上 (施工完了した受注) に関わる変更は承認が要る (approval-decide.ts の touchesConfirmedSales)
 */
export function skipsApproval(user: Pick<User, "role">, type?: ApprovalType): boolean {
  if (user.role === "admin") return true;
  return user.role === "store_manager" && type !== undefined && MANAGER_SELF_APPROVE_TYPES.includes(type);
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
 * 承認者のロールを決める (見積・金額変更・受注 (契約)・契約内容の変更・顧客の重要情報・引取納品日の変更・経費)
 * - 本部の案件、または金額が基準以上 → 管理者
 * - 店長の申請 → 管理者 (自店舗・ほかの店舗の案件とも。お客様の決定 2026-11-23「承認は管理者」。
 *   店長はほかの店舗の案件も変更できる (canEditCaseStore) ため、その店舗の店長に回さない)
 * - 店舗の案件 → 店長。ただし、その店舗に申請者以外の有効な店長がいないとき (店長のいない店舗) は、承認できる人がいないので管理者
 * - 店長として数えるのは、申請者と同じ種類のアカウントだけ (社員の申請は社員の店長、デモ用アカウントの申請はデモ用の店長)。
 *   本番データにデモ用アカウントを加えても、社員の申請の承認先は変わらない
 */
export function approverRole(users: Pick<User, "id" | "email" | "role" | "storeId" | "active">[], storeId: StoreId, overThreshold: boolean, requesterId: string): "store_manager" | "admin" {
  if (storeId === "hq" || overThreshold) return "admin";
  const requester = users.find((u) => u.id === requesterId);
  if (requester?.role === "store_manager") return "admin";
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

/**
 * 新規登録の申請 (希望のロール・所属) を承認・却下できるか。管理者だけ (お客様のご要望 2026-11-26「管理者の承認を得て初めてログインし、正常に利用できるように」。
 * それまでは店舗スタッフの申請を所属店舗の店長も承認できた)
 */
export function canApproveSignup(user: User): boolean {
  return user.role === "admin";
}

/** ロール・所属・役職を変えられるか (管理者。テスト期間中のアカウントの変更の停止の対象外 = お客様のご要望 2026-11-26) */
export function canChangeUserRole(user: User): boolean {
  return user.role === "admin";
}

/** 店舗のロール (店長・店舗スタッフ) は本部ではなく店舗に所属させる (店舗の範囲で権限を判定するため) */
export function roleStoreProblem(role: Role, store: { id: string; kind?: string } | undefined): string | undefined {
  if ((role === "store_manager" || role === "store_staff") && (!store || store.kind === "hq" || store.id === "hq")) return "店長・店舗スタッフは、所属する店舗 (本部以外) を選んでください。";
  return undefined;
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

/**
 * 帳票 (見積書・請求書・領収書) の出力・印刷 (お客様のご要望 2026-11-25「⑥」: 全社員が出力できる。出力の記録 = doc_outputs)。
 * access = 記録の閲覧の判定 (case-access.ts の *AccessInfo)。見られる記録なら出力できる。金額・請求内容・入金を変える権限とは別
 */
export function canOutputDocument(user: User, access: "edit" | "view" | "none"): boolean {
  return user.active && access !== "none";
}

/**
 * 領収書の発行 (支払方法の内訳つき。src/lib/receipts.ts)。現場で集金した社員が発行するため、帳票の出力と同じく記録を見られる社員。
 * 発行しても入金の記録は変わらない (入金の記録は請求書の店舗の社員: recordPayment)
 */
export function canIssueReceipt(user: User, access: "edit" | "view" | "none"): boolean {
  return canOutputDocument(user, access);
}

/** 領収書の取り消し (書き損じ・作り直し): 請求書の店舗の社員・本部・管理者と、発行した本人 */
export function canVoidReceipt(user: User, r: { storeId: StoreId; createdBy: string }): boolean {
  return user.active && (canAccessStore(user, r.storeId) || r.createdBy === user.id);
}

/**
 * 問い合わせの削除 (誤って登録した問い合わせ。お客様のご要望 2026-11-25。src/lib/inquiry-delete.ts):
 * 店長以上 (店長・本部・管理者) は承認なしで削除 (その問い合わせを変更できる店舗)
 */
export function canDeleteInquiryDirect(user: User, storeId: StoreId): boolean {
  return (user.role === "admin" || user.role === "hq_staff" || user.role === "store_manager") && canEditCaseStore(user, storeId);
}

/** 問い合わせの削除の申請: 店舗スタッフ (所属店舗の問い合わせ。所属店舗の店長が承認する = approverRole) */
export function canRequestInquiryDelete(user: User, storeId: StoreId): boolean {
  return user.role === "store_staff" && canEditCaseStore(user, storeId);
}

/** 削除した問い合わせを元に戻す: 管理者 */
export function canRestoreInquiry(user: User): boolean {
  return user.role === "admin";
}

/** 請求書の発行 (受注から): 店長・本部・管理者 (その店舗の請求書。canAccessStore と合わせて使う) */
export function canIssueInvoice(user: User): boolean {
  return canManageFinance(user) || isManagerOrAbove(user);
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

/** 試験期間のデータの本番への引き継ぎ: 対象の一覧を見て「引き継ぐ・引き継がない」を決める (管理者・本部スタッフ) */
export function canReviewCarryover(user: User): boolean {
  return canSeeAllStores(user);
}

/** 試験期間のデータの本番への引き継ぎ: 最終判断 (この内容で引き継ぐと決める) は管理者だけ */
export function canDecideCarryover(user: User): boolean {
  return user.role === "admin";
}

export const ROLE_ORDER: Role[] =["admin", "store_manager", "store_staff", "hq_staff"];

/** 経費を閲覧・申請・削除できるか (店舗スタッフは自分の経費のみ) */
export function canViewExpense(user: User, e: Pick<Expense, "storeId" | "submittedBy">): boolean {
  if (canSeeAllStores(user)) return true;
  if (user.role === "store_manager") return e.storeId === user.storeId;
  return e.submittedBy === user.id;
}

/* ---------------- チャット (チャンネル・DM。src/lib/chat。お客様のご要望 2026-11-25) ---------------- */

/** 店長以上 (店長・本部・管理者): 重要メッセージ・@全員・「店長以上だけ」の資料・店長のチャンネル・チャンネルの追加 */
export function isChatLead(user: Pick<User, "role">): boolean {
  return user.role === "admin" || user.role === "hq_staff" || user.role === "store_manager";
}

/** 重要メッセージ (確認のお願い) を送れる・@全員 を使える: 管理者・本部・店長 (お客様の決定 2026-11-25) */
export function canSendImportantChat(user: Pick<User, "role">): boolean {
  return isChatLead(user);
}

/** チャンネルを追加できる: 有効な社員なら誰でも (Slack と同じ。2026-11-26 のご要望) */
export function canCreateChatChannel(user: Pick<User, "role"> & { active?: boolean }): boolean {
  return user.active !== false;
}

/**
 * チャンネル・DM を見られるか
 * - 全社: 有効な社員全員 / 店舗: その店舗の社員と本部・管理者 / 店長: 店長以上
 * - 追加したチャンネル: 公開 (public) は社員なら誰でも見て参加できる、非公開はメンバーだけ
 * - DM: 参加している本人だけ。管理者も見られない (お客様の決定 2026-11-25「■5」)
 */
export function canViewChatChannel(user: Pick<User, "id" | "role" | "storeId" | "active">, ch: { kind: string; storeId?: string; memberIds: string[]; visibility?: string }): boolean {
  if (!user.active) return false;
  switch (ch.kind) {
    case "all":
      return true;
    case "store":
      return user.storeId === ch.storeId || user.role === "admin" || user.role === "hq_staff";
    case "managers":
      return isChatLead(user);
    case "custom":
      return ch.visibility === "public" || ch.memberIds.includes(user.id);
    default:
      return ch.memberIds.includes(user.id);
  }
}

/** チャンネル・DM に送れるか (追加したチャンネルはメンバーだけ。公開のチャンネルは参加してから) */
export function canPostChatChannel(user: Pick<User, "id" | "role" | "storeId" | "active">, ch: { kind: string; storeId?: string; memberIds: string[]; visibility?: string }): boolean {
  if (!canViewChatChannel(user, ch)) return false;
  return ch.kind === "custom" || ch.kind === "dm" ? ch.memberIds.includes(user.id) : true;
}

/** 追加したチャンネルにメンバーを足せる: そのチャンネルのメンバー (Slack と同じ。外すのは作成した人・管理者) */
export function canAddChatMembers(user: Pick<User, "id">, ch: { kind: string; memberIds: string[] }): boolean {
  return ch.kind === "custom" && ch.memberIds.includes(user.id);
}

/** 追加したチャンネルの名前・説明・公開範囲の変更、メンバーを外す、アーカイブ: 作成した人・管理者 */
export function canManageChatChannel(user: Pick<User, "id" | "role">, ch: { kind: string; createdBy?: string }): boolean {
  return ch.kind === "custom" && (ch.createdBy === user.id || user.role === "admin");
}

/** チャットの資料・写真を見られるか (公開範囲が「店長以上」の資料は店長以上だけ。チャンネルを見られることが前提) */
export function canViewChatFile(user: Pick<User, "role">, access: string): boolean {
  return access !== "managers" || isChatLead(user);
}

/** メッセージの削除: 送った本人。管理者はチャンネルの不適切な投稿も消せる (DM は本人だけ) */
export function canDeleteChatMessage(user: Pick<User, "id" | "role">, m: { userId: string }, ch: { kind: string }): boolean {
  return m.userId === user.id || (user.role === "admin" && ch.kind !== "dm");
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

/** レポート・分析 (経営ダッシュボード) を閲覧できる: 店長・本部スタッフ・管理者。閲覧の範囲 = 経営の数字は全社員 のときは全員 (policyReader の写しで判定) */
export function canViewReports(user: User): boolean {
  return isManagerOrAbove(user) || canSeeAllStoreFigures(user);
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

/** 請求書の発行 (案件ごと・締め日のまとめ請求) と、お客様の請求の締め (まとめ請求の条件) の設定: 店長・本部スタッフ・管理者 (店長は自店舗。src/lib/billing.ts) */
export function canIssueInvoices(user: User): boolean {
  return canManageFinance(user) || isManagerOrAbove(user);
}

/** 売掛一覧 (基準日の売掛残高・年齢・CSV): 本部スタッフ・管理者は全店舗、店長は自店舗 (src/lib/ar-ap.ts) */
export function canViewReceivables(user: User): boolean {
  return canManageFinance(user) || user.role === "store_manager";
}

/** 買掛一覧 (基準日の買掛残高・支払方法別・CSV): 仕入請求書を見られる人 (本部スタッフ・管理者は全件、店長は自店舗。canViewPurchase) */
export function canViewPayables(user: User): boolean {
  return canRegisterPurchase(user);
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
/** 顧客の重要情報 (氏名・電話・住所など) の変更を承認なしで反映できる: 管理者と店長 (全店舗のお客様。お客様の決定 2026-11-24「追加 ①」)。店舗スタッフは設定しだいで承認の申請 */
export function canApplyCustomerChange(user: User, _storeId: StoreId): boolean {
  void _storeId;
  return user.role === "admin" || user.role === "store_manager";
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

/* ---------------- 施工事例の投稿 (src/lib/case-posts.ts。資料・写真 → 施工事例の投稿) ---------------- */

type PostRef = Pick<CasePost, "storeId" | "createdBy" | "status">;

/** 投稿文を確認する人 (設定 → 資料・写真 → 施工事例の投稿 の「確認する人」。既定は本部の管理者) */
export function isCasePostReviewer(user: User, reviewerIds: readonly string[]): boolean {
  return user.active && reviewerIds.includes(user.id);
}

/** 案件の店舗の担当者 (店舗のロールは自店舗、本部・管理者は全店舗) と作成者 */
function isPostMember(user: User, p: Pick<CasePost, "storeId" | "createdBy">): boolean {
  return user.active && (p.createdBy === user.id || canAccessStore(user, p.storeId));
}

/** 施工事例の投稿を作る: その案件の店舗の担当者 (店舗スタッフも可) */
export function canCreateCasePost(user: User, storeId: StoreId): boolean {
  return user.active && canAccessStore(user, storeId);
}

/** 投稿を見る: 作成者・案件の店舗の担当者・確認する人 */
export function canViewCasePost(user: User, p: Pick<CasePost, "storeId" | "createdBy">, reviewerIds: readonly string[]): boolean {
  return isPostMember(user, p) || isCasePostReviewer(user, reviewerIds);
}

/**
 * 写真・商品名・施工内容・投稿文を直す: 下書き・差し戻しは担当者と確認する人、確認依頼の間は確認する人だけ、
 * 承認済みは担当者と確認する人 (確認する人以外が直すと下書きに戻る = 承認した文面だけを投稿する)。投稿済み・取りやめは直さない
 */
export function canEditCasePost(user: User, p: PostRef, reviewerIds: readonly string[]): boolean {
  const reviewer = isCasePostReviewer(user, reviewerIds);
  if (p.status === "review") return reviewer;
  if (p.status === "draft" || p.status === "returned" || p.status === "approved") return reviewer || isPostMember(user, p);
  return false;
}

/** 確認を頼む (下書き・差し戻し → 確認依頼): 担当者と確認する人 */
export function canRequestCasePostReview(user: User, p: PostRef, reviewerIds: readonly string[]): boolean {
  return (p.status === "draft" || p.status === "returned") && (isPostMember(user, p) || isCasePostReviewer(user, reviewerIds));
}

/** 承認 (確認依頼 → 承認済み): 確認する人。自分が作った投稿は承認できない (管理者 = 社長は省略できる skipsApproval) */
export function canApproveCasePost(user: User, p: PostRef, reviewerIds: readonly string[]): boolean {
  return p.status === "review" && isCasePostReviewer(user, reviewerIds) && (p.createdBy !== user.id || skipsApproval(user));
}

/** 差し戻し (確認依頼・承認済み → 差し戻し。理由が必要): 確認する人 */
export function canReturnCasePost(user: User, p: PostRef, reviewerIds: readonly string[]): boolean {
  return (p.status === "review" || p.status === "approved") && isCasePostReviewer(user, reviewerIds);
}

/** 確認依頼の取り下げ (確認依頼 → 下書き): 担当者 */
export function canWithdrawCasePost(user: User, p: PostRef): boolean {
  return p.status === "review" && isPostMember(user, p);
}

/** 投稿したことの記録 (投稿先・日・URL): 承認済み・投稿済みの投稿を、担当者と確認する人 */
export function canRecordCasePosting(user: User, p: PostRef, reviewerIds: readonly string[]): boolean {
  return (p.status === "approved" || p.status === "posted") && (isPostMember(user, p) || isCasePostReviewer(user, reviewerIds));
}

/** 取りやめ (投稿前) と、取りやめた投稿を下書きに戻す: 担当者と確認する人 */
export function canDiscardCasePost(user: User, p: PostRef, reviewerIds: readonly string[]): boolean {
  return p.status !== "posted" && (isPostMember(user, p) || isCasePostReviewer(user, reviewerIds));
}

/** 確認する人の設定・LINE の施工事例写真の「対象外」: 管理者 (対象外は写真を見られる人も可。src/lib/line-photos.ts) */
export function canManageCasePostSettings(user: User): boolean {
  return user.role === "admin";
}

/* ---------------- 整理整頓チェック (src/lib/tidy.ts。KPI → 整理整頓) ---------------- */

/** チェックを記録する: その店舗のメンバー (店舗スタッフも自店舗を記録できる)・本部・管理者 */
export function canRecordTidyCheck(user: User, storeId: StoreId): boolean {
  return user.active && canAccessStore(user, storeId);
}

/** 全店舗のチェックを見る: 店長・本部・管理者 (店舗スタッフは自店舗) */
export function canViewAllTidyChecks(user: User): boolean {
  return canSeeAllStores(user) || user.role === "store_manager";
}

export function canViewTidyCheck(user: User, c: Pick<TidyCheck, "storeId">): boolean {
  return canViewAllTidyChecks(user) || c.storeId === user.storeId;
}

/** チェックの修正・写真の追加・要改善の対応の記録: その店舗のメンバー・本部・管理者 */
export function canEditTidyCheck(user: User, c: Pick<TidyCheck, "storeId">): boolean {
  return user.active && canAccessStore(user, c.storeId);
}

/** チェックの削除: チェックした人・登録した人・その店舗の店長・本部・管理者 */
export function canDeleteTidyCheck(user: User, c: Pick<TidyCheck, "storeId" | "checkedBy" | "createdBy">): boolean {
  if (!user.active) return false;
  if (canSeeAllStores(user)) return true;
  if (user.role === "store_manager" && user.storeId === c.storeId) return true;
  return canAccessStore(user, c.storeId) && (c.checkedBy === user.id || c.createdBy === user.id);
}

/** チェック項目の変更 (まとめて差し替え): 管理者 */
export function canManageTidyItems(user: User): boolean {
  return user.role === "admin";
}

/** LINE の「施工事例写真」「整理整頓の確認」グループの写真を見る・案件やチェックに付ける: グループの店舗のメンバー (店舗のないグループは全社員) */
export function canUseLineGroupPhotos(user: User, groupStoreId: StoreId | undefined): boolean {
  return user.active && (groupStoreId ? canAccessStore(user, groupStoreId) : true);
}

/**
 * 畳製造予定 (/schedule/production。お客様のご要望 2026-11-23「■3」) の繰り越し・製造日の変更・製造日未定・製造済み・手で足した行:
 * 有効な社員全員 (作業場では店舗をまたいで製造するため。予定表と同じく全社で共有。操作は変更履歴に残る)。
 * 製造日を変えても、予定表の引取日・納品日は変わらない
 */
export function canEditProduction(user: User): boolean {
  return Boolean(user.active);
}

/**
 * 予定表 (スプレッドシート) の予定を新システムへ取り込む (予定表 →「スプレッドシートの取込」。本部スタッフ・管理者)。
 * 顧客・案件 (問い合わせ) の登録と、以前に移行した予定の書き換え・削除をまとめて行うため、全店舗を扱える人だけ
 */
export function canImportScheduleSheet(user: User): boolean {
  return Boolean(user.active) && canImportData(user);
}
