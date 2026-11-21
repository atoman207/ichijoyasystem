import type { StoreId } from "./types";

/**
 * 文書の下書き (AI アシスタント →「文書の作成」で作った文面を保存し、確認 → 承認 → 送信まで管理する) の型
 * ------------------------------------------------------------
 * 進み方: draft (下書き) → reviewed (確認済み) → approved (承認済み) → sent (送信済み)。discarded = 破棄。
 * 承認のあとに文面を直すと下書きに戻る (承認した文面 = 送った文面)。処理は src/lib/doc-drafts.ts、操作は src/lib/actions/doc-drafts.ts
 */

export type DocDraftStatus = "draft" | "reviewed" | "approved" | "sent" | "discarded";
export type DocDraftFormat = "email" | "line" | "document";
export type DocDraftRefType = "quote" | "order" | "inquiry" | "invoice" | "customer";
/** 送った方法 (manual_* = 郵送・手渡しなどシステムの外で渡して記録だけ残した) */
export type DocDraftChannel = "email" | "line" | "chatwork" | "manual_mail" | "manual_hand";

/** 下書きにひも付いた記録 (見積・受注・問い合わせ・請求・顧客) */
export interface DocDraftRef {
  type: DocDraftRefType;
  id: string;
  /** 表示名 (例: 受注 O-2026-0012) */
  label: string;
  href: string;
}

/** 文面の版 (作成・修正のたびに 1 つ増える。新しい 50 版を残す) */
export interface DocDraftVersion {
  v: number;
  at: string;
  by: string;
  subject?: string;
  body: string;
  /** 修正の理由・メモ */
  note?: string;
  /** ai = AI・定型文で作成 / edit = 人が修正 / copy = 別の文書の複製 */
  source: "ai" | "edit" | "copy";
}

export type DocDraftAction = "create" | "edit" | "review" | "approve" | "return" | "discard" | "restore" | "send" | "send_failed" | "send_skipped" | "record_manual" | "copy";

/** 処理の記録 (誰が・いつ・何をしたか) */
export interface DocDraftEvent {
  at: string;
  by: string;
  action: DocDraftAction;
  from?: DocDraftStatus;
  to?: DocDraftStatus;
  /** 差し戻しの理由・送信の失敗の理由など */
  comment?: string;
  /** その時点の版 */
  version?: number;
}

export interface DocDraft {
  id: string;
  /** 文書番号 (例: DOC-2026-0001) */
  number: string;
  /** 一覧に出す名前 (ひな形の名前 + 関係する記録) */
  title: string;
  /** ひな形 (src/lib/ai/draft.ts の DRAFT_TEMPLATES のキー) */
  template: string;
  format: DocDraftFormat;
  audience: "customer" | "internal";
  /** 件名 (メール) */
  subject?: string;
  body: string;
  status: DocDraftStatus;
  /** 閲覧範囲の店舗 (関係する記録の店舗、なければ作成者の店舗) */
  storeId: StoreId;
  refs: DocDraftRef[];
  /** 最初の文面を作ったもの */
  provider: "claude" | "openai" | "rules";
  /** 作成のときの要点・依頼 */
  notes?: string;
  /** いまの版 */
  version: number;
  versions: DocDraftVersion[];
  events: DocDraftEvent[];
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  sentBy?: string;
  sentAt?: string;
  channel?: DocDraftChannel;
  /** 宛先 (メールアドレス・LINE の ID・Chatwork のルーム ID・郵送先のメモ) */
  recipient?: string;
  recipientLabel?: string;
  /** 送信履歴 (deliveries) の ID */
  deliveryIds: string[];
  /** やりとり履歴 (comm_logs) の ID */
  commLogId?: string;
  /** 複製の元の文書 */
  copiedFrom?: string;
}
