/**
 * 作業日報 (F-11) と販促・媒体の分析 (F-13) の型
 * ------------------------------------------------------------
 * - 作業日報の件数・枚数・担当は予定表 (schedule) と受注・見積から毎回計算する (src/lib/ops-reports/work-report.ts)。
 *   ここに持つのは予定からわからない手入力の項目 (チラシの配布人・枚数・地域、来店数) だけ (店舗 × 日に 1 行)
 * - 販促の記録 (チラシ・イベント・点検の DM・テレアポ) は promotions。反応 (問い合わせ・成約・売上) は問い合わせの媒体
 *   (Inquiry.media) と販促 (Inquiry.promotionId) から計算する (src/lib/ops-reports/promo-analysis.ts)
 * - 媒体の分類のラベルと、過去のデータの読み替えの対応表は src/lib/media.ts
 */
import type { StoreId, TatamiRoom } from "./types";

/**
 * 全社共通の媒体の分類 (お客様が当社を知ったきっかけ)。問い合わせ・顧客・アンケートで同じ分類を使う。
 * unknown = 不明 (お客様に聞けなかった)。値のない問い合わせ (移行前・自動受付) は「未分類」として数える
 */
export type MediaKey =
  | "repeat"
  | "referral"
  | "flyer"
  | "dm"
  | "teleapo"
  | "event"
  | "store"
  | "web"
  | "map"
  | "sns"
  | "tv_radio"
  | "paper"
  | "business"
  | "other"
  | "unknown";

/** 作業日報のチラシの配布 (1 日に複数の行) */
export interface WorkReportFlyer {
  /** 配布人 (書かれたまま。社員・アルバイト・業者の名前) */
  distributor: string;
  /** 配布人のうち、名前が一致した社員 */
  userIds: string[];
  /** 配布した枚数 */
  copies: number;
  /** 配布した地域 (町名。例: 合志市須屋)。部数あたりの反応の集計に使う */
  area?: string;
  /** 受注のポスティングの実績から (お客様のご要望 2026-11-27「■3」。作業日報で計算して出す行。手入力の行にはない) */
  orderId?: string;
  orderNumber?: string;
}

/** 作業日報の手入力 (店舗 × 日に 1 行。ID は wr_<storeId>_<YYYY-MM-DD>) */
export interface WorkReportDay {
  id: string;
  storeId: StoreId;
  /** YYYY-MM-DD */
  date: string;
  /** 来店数 (その日に店舗へ来られたお客様の数) */
  visitors?: number;
  flyers: WorkReportFlyer[];
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

/** 販促の種類: チラシ (折込・ポスティング) / イベント / 点検の DM / テレアポ / その他 */
export type PromotionKind = "flyer" | "event" | "dm" | "teleapo" | "other";
/** planned = 計画 (年間のチラシ計画など) / done = 実施済み / cancelled = 中止 */
export type PromotionStatus = "planned" | "done" | "cancelled";

/** 地域ごとの部数 (チラシ。DM・テレアポは送付先・架電先の地域と件数) */
export interface PromotionArea {
  area: string;
  copies: number;
}

/** 販促の記録 */
export interface Promotion {
  id: string;
  /** 例: PR-2026-0001 */
  number: string;
  kind: PromotionKind;
  title: string;
  /** 実施した店舗 (全社のものは hq) */
  storeId: StoreId;
  status: PromotionStatus;
  /** 配布日・開催日・送付日 (配布月はこの日の月) */
  startDate: string;
  /** 複数日にわたるとき (イベントの最終日・ポスティングの終了日) */
  endDate?: string;
  /** 地域ごとの部数。空なら地域なし (copies だけ) */
  areas: PromotionArea[];
  /** 部数・通数・件数の合計 (地域があれば地域の合計) */
  copies: number;
  /** 費用 (円・税込。任意) */
  cost?: number;
  /** この販促から来た問い合わせの媒体 (チラシ → flyer など) */
  media: MediaKey;
  /** 配布業者・新聞・会場など */
  vendor?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

/* ---------------- 畳製造予定 (お客様のご要望 2026-11-23「■3. 畳製造予定表」。src/lib/production) ---------------- */

/**
 * 畳製造予定の行で人が決めたこと (製造日の変更・繰り越し・製造日未定・製造済み) と、手で足した製造の予定。
 * 製造の予定そのもの (いつ・どの店舗の・どの案件 (仕様) の・何畳) は、受注の引取日・採寸日と予定表の引き取りの予定から毎回計算する
 * (src/lib/production/plan.ts)。この表に行がなければ「元の日 (引取日・採寸日) に製造」。
 * 製造日を変えても、予定表の引取日・納品日の予定は変えない (お客様のご指示)。
 */
export interface TatamiProduction {
  /** tp_<元の印> (元ごとに 1 行) / 手で足した行は tp_<ID> */
  id: string;
  /**
   * 元の印: ho:<受注の引取・納品の日程の行 ID> / ord:<受注 ID> (日程の行がない受注) / ev:<予定表の予定 ID> (移行した予定表・受注にひも付かない予定) /
   * man:<ID> (手で足した行)
   */
  sourceKey: string;
  storeId: StoreId;
  orderId?: string;
  eventId?: string;
  customerId?: string;
  /** 製造日 (人が決めた日)。空なら元の日 (引取日・採寸日) */
  date?: string;
  /** 製造日未定 (長期預かりなど) */
  undecided?: boolean;
  /** 製造日を決めたときの元の日 (あとで引取日が変わったことを知らせる) */
  baseDate?: string;
  /** planned = 予定 / done = 製造済み / cancelled = 製造しない (一覧から外す) */
  status: "planned" | "done" | "cancelled";
  doneAt?: string;
  doneBy?: string;
  /** 手で足した行の内容 (元の記録がない行) */
  title?: string;
  spec?: string;
  qty?: number;
  /** へり無し畳の枚数 (手で足した行) */
  herinashi?: number;
  /** 畳の製造の仕様 (部屋ごと)。受注のない行 (移行した予定表の引き取り・手で足した行) の仕様。受注の行は受注の tatamiRooms */
  rooms?: TatamiRoom[];
  note?: string;
  /** 繰り越し・日付の変更などの記録 (新しい 30 件) */
  history: TatamiProductionEvent[];
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface TatamiProductionEvent {
  at: string;
  by: string;
  action: "create" | "carry" | "move" | "undecided" | "auto" | "done" | "reopen" | "cancel" | "edit";
  from?: string;
  to?: string;
  note?: string;
}
