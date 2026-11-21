/**
 * 要約の種類と内容の区分 (画面の部品からも読むため、サーバー専用のものを読み込まない)
 * 要約の本体は summary.ts
 */

export type SummaryKind = "quote" | "order" | "expense" | "customer" | "inquiry";

export const SUMMARY_KIND_LABEL: Record<SummaryKind, string> = { quote: "見積", order: "受注・施工", expense: "経費", customer: "顧客", inquiry: "問い合わせ" };

/** 内容の区分 (絞り込み・節ごとの要約) */
export type SummarySection = "progress" | "schedule" | "billing" | "comms" | "quotes" | "approvals";

export const SECTION_LABEL: Record<SummarySection, string> = {
  quotes: "見積・受注",
  progress: "進捗・作業",
  schedule: "予定",
  billing: "請求・入金",
  comms: "やりとり",
  approvals: "承認・変更",
};

/** 根拠の記号の頭文字 (回答の [P3] など) */
export const SECTION_REF: Record<SummarySection, string> = { quotes: "Q", progress: "P", schedule: "S", billing: "B", comms: "C", approvals: "A" };

/** 記録の種類ごとに選べる区分 (並び順) */
export const SECTIONS_BY_KIND: Record<SummaryKind, SummarySection[]> = {
  order: ["progress", "schedule", "billing", "comms", "quotes", "approvals"],
  quote: ["quotes", "schedule", "comms", "approvals"],
  inquiry: ["quotes", "schedule", "comms"],
  customer: ["quotes", "progress", "schedule", "billing", "comms"],
  expense: ["approvals"],
};

/** 期間の選択肢 (日数。0 = 全期間) */
export const SUMMARY_PERIODS: { days: number; label: string }[] = [
  { days: 0, label: "全期間" },
  { days: 30, label: "直近 30 日" },
  { days: 90, label: "直近 3 か月" },
  { days: 365, label: "直近 1 年" },
];

export interface SummaryOptions {
  /** 期間 (YYYY-MM-DD。両端を含む) */
  from?: string;
  to?: string;
  /** 内容の区分 (空 = すべて) */
  sections?: SummarySection[];
}

/** 根拠の記録 (画面にリンクで出す) */
export interface SummarySource {
  ref: string;
  section: SummarySection;
  date?: string;
  label: string;
  href?: string;
}

export interface SectionSummary {
  key: SummarySection;
  label: string;
  /** 節の要約 (根拠の記号 [P3] を含む) */
  text: string;
  /** 期間の中の記録の数 */
  count: number;
  /** 要約に使った記録の数 (多すぎるときは新しいものから) */
  used: number;
}

/** 要約の結果 (Server Action の戻り値。そのまま画面に渡す) */
export interface SummaryResult {
  ok: boolean;
  provider: "claude" | "openai" | "rules";
  /** 全体の要約 (概要・要点・次に必要な対応) */
  overview: string;
  sections: SectionSummary[];
  sources: SummarySource[];
  /** コピー用の全文 (根拠の記号つき) */
  text: string;
  /** 期間・区分の説明 */
  scope: string;
  /** 記録の画面 */
  record?: { label: string; href: string };
  /** AI の呼び出しの回数 (節ごと + 全体) */
  calls?: number;
  message?: string;
}
