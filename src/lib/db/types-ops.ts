/**
 * 作業日報 (F-11) と販促・媒体の分析 (F-13) の型
 * ------------------------------------------------------------
 * - 作業日報の件数・枚数・担当は予定表 (schedule) と受注・見積から毎回計算する (src/lib/ops-reports/work-report.ts)。
 *   ここに持つのは予定からわからない手入力の項目 (チラシの配布人・枚数・地域、来店数) だけ (店舗 × 日に 1 行)
 * - 販促の記録 (チラシ・イベント・点検の DM・テレアポ) は promotions。反応 (問い合わせ・成約・売上) は問い合わせの媒体
 *   (Inquiry.media) と販促 (Inquiry.promotionId) から計算する (src/lib/ops-reports/promo-analysis.ts)
 * - 媒体の分類のラベルと、過去のデータの読み替えの対応表は src/lib/media.ts
 */
import type { StoreId } from "./types";

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
