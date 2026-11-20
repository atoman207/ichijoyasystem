/**
 * 事務 (事務改善シート・慶弔リスト) の型
 * ------------------------------------------------------------
 * クライアントがスプレッドシートで付けていた 事務改善シート・慶弔リスト を画面で扱う (src/lib/office.ts・/office)。
 * 慶弔リストは社員・取引先のご家族の情報を含むため、見られるのは事務担当・本部スタッフ・管理者だけ (permissions.ts の canViewCondolences)
 */

/** 事務改善シートの 1 行 (事務のミス・気づき → 原因 → 具体的改善策) */
export interface OfficeImprovement {
  id: string;
  /** 年 (シートの「年」。日付のない行もこの年で絞り込む) */
  year: number;
  /** 日付 (YYYY-MM-DD。月日が分からない行は空) */
  date?: string;
  /** 担当 (名前の文字。社員にひも付くときは staffId) */
  staffName: string;
  staffId?: string;
  /** 項目 (仕入帳・買掛一覧・売上 など) */
  item: string;
  /** 内容 (起きたこと) */
  content: string;
  /** 原因 */
  cause?: string;
  /** 具体的改善策 */
  measure?: string;
  /** manual = 画面で登録 / import = シート (.xlsx・CSV) から取込 */
  source: "manual" | "import";
  /** 取込元 (ファイル名と行) */
  sourceRef?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

export type CondolenceCategory = "condolence" | "celebration" | "other";

/** 慶弔リストの 1 行 (通夜・葬儀・結婚・出産などへの対応の記録) */
export interface Condolence {
  id: string;
  /** 年月日 (YYYY-MM-DD) */
  date: string;
  /** 区分 (弔事・慶事・その他) */
  category: CondolenceCategory;
  /** 内容 (通夜・葬儀・参列なし・結婚 など) */
  kind: string;
  /** 名前 (喪主・お相手) */
  name: string;
  /** 関係 (社員のご家族・取引先・地域 など) */
  relation?: string;
  /** 金額 (円。香典・お祝いなど) */
  amount?: number;
  /** 担当 (参列者) */
  attendee?: string;
  /** 備考 (供花・弔電・会場など) */
  note?: string;
  source: "manual" | "import";
  sourceRef?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}
