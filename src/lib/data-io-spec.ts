/**
 * データ入出力 (CSV・Google スプレッドシート) の項目定義
 * 取込と書き出しで同じ見出しを使う (書き出した CSV を編集してそのまま取り込める)
 */

export type ImportTarget = "customers" | "inquiries";

export interface ColumnSpec {
  key: string;
  header: string;
  /** 見出しの別名 (既存の台帳・スプレッドシートの見出しでも取り込めるように) */
  aliases: string[];
  /** always: 必須 / new: 新規登録のとき必須 */
  required?: "always" | "new";
  note: string;
  example: string;
}

export interface TargetSpec {
  label: string;
  description: string;
  columns: ColumnSpec[];
}

export const IMPORT_SPEC: Record<ImportTarget, TargetSpec> = {
  customers: {
    label: "顧客",
    description: "顧客コードが既存の顧客と一致する行は、その顧客を更新します。顧客コードが空欄の行は新規登録します (既存の顧客との重複確認を行います)。",
    columns: [
      { key: "code", header: "顧客コード", aliases: ["コード", "顧客番号", "顧客ID", "得意先コード"], note: "既存の顧客を更新するときに指定 (空欄なら新規登録)", example: "" },
      { key: "name", header: "氏名・会社名", aliases: ["氏名", "名前", "お名前", "顧客名", "会社名", "氏名/会社名", "得意先名"], required: "new", note: "", example: "山田 花子" },
      { key: "kana", header: "フリガナ", aliases: ["ふりがな", "カナ", "氏名カナ", "フリガナ(カナ)"], note: "", example: "ヤマダ ハナコ" },
      { key: "type", header: "区分", aliases: ["個人/法人", "個人・法人", "顧客区分"], note: "個人 / 法人 (省略時は個人)", example: "個人" },
      { key: "phone", header: "電話", aliases: ["電話番号", "TEL", "携帯", "携帯電話"], note: "", example: "096-000-0000" },
      { key: "email", header: "メール", aliases: ["メールアドレス", "E-mail", "Email", "mail"], note: "", example: "" },
      { key: "postalCode", header: "郵便番号", aliases: ["〒", "郵便"], note: "", example: "861-1113" },
      { key: "address", header: "住所", aliases: ["所在地", "住所1"], note: "", example: "熊本県合志市栄0000" },
      { key: "area", header: "地区", aliases: ["地域", "エリア"], note: "", example: "栄" },
      { key: "storeId", header: "担当店舗", aliases: ["店舗", "店舗名", "担当店"], required: "new", note: "合志店・中央店・西店・玉名店・本社 (「合志」のような略称も可)", example: "合志店" },
      { key: "preferredChannel", header: "希望連絡手段", aliases: ["連絡手段", "希望する連絡手段"], note: "電話・LINE・メール・郵送 など (省略時は電話)", example: "電話" },
      { key: "tags", header: "タグ", aliases: ["分類"], note: "空白・カンマ区切りで複数", example: "リピーター" },
      { key: "notes", header: "備考", aliases: ["メモ", "注意事項"], note: "", example: "" },
    ],
  },
  inquiries: {
    label: "問い合わせ",
    description: "1 行を 1 件の問い合わせとして登録します (番号は自動)。受付日時・お名前・概要が同じ問い合わせが登録済みの行は取り込みません。",
    columns: [
      { key: "receivedAt", header: "受付日時", aliases: ["受付日", "日付", "日時", "受付"], required: "always", note: "2026-11-12 10:30 / 2026/11/12 (時刻は省略可)", example: "2026-11-12 10:30" },
      { key: "storeId", header: "担当店舗", aliases: ["店舗", "店舗名", "担当店"], required: "always", note: "合志店・中央店・西店・玉名店・本社", example: "合志店" },
      { key: "channel", header: "経路", aliases: ["入口", "受付方法", "手段", "問い合わせ方法"], note: "電話・来店・対面・郵送・メール・LINE・Web など (省略時は電話)", example: "電話" },
      { key: "category", header: "種別", aliases: ["商品", "品目", "区分"], note: "畳・襖・障子・網戸・カーテン・クロス・その他 (省略時はその他)", example: "畳" },
      { key: "contactName", header: "お名前", aliases: ["氏名", "名前", "顧客名", "お客様名"], required: "always", note: "", example: "山田 花子" },
      { key: "contactPhone", header: "電話", aliases: ["電話番号", "TEL", "連絡先"], note: "", example: "090-0000-0000" },
      { key: "customerCode", header: "顧客コード", aliases: ["コード", "顧客番号"], note: "既存の顧客に紐づけるときに指定", example: "" },
      { key: "summary", header: "概要", aliases: ["件名", "用件", "内容"], required: "always", note: "", example: "和室6畳の表替え" },
      { key: "detail", header: "詳細", aliases: ["メモ", "備考", "詳細内容"], note: "", example: "" },
      { key: "status", header: "状態", aliases: ["ステータス", "対応状況", "結果"], note: "新規・対応中・見積提出済・受注・失注・完了 (省略時は新規)", example: "新規" },
      { key: "assignee", header: "担当者", aliases: ["対応者", "担当"], note: "社員の氏名またはログイン ID", example: "" },
      { key: "nextAction", header: "次の対応", aliases: ["次のアクション"], note: "", example: "折り返し電話" },
      { key: "nextActionDue", header: "期限", aliases: ["次の対応の期限", "期日"], note: "2026-11-15", example: "" },
    ],
  },
};

/** 1 回に取り込める行数 */
export const IMPORT_MAX_ROWS = 5000;

/** 見出しの行から、項目ごとの列の位置を決める (見つからない見出しは -1) */
export function mapHeaders(target: ImportTarget, header: string[]): Record<string, number> {
  const norm = (s: string) => s.normalize("NFKC").replace(/[\s　()（）・/／*※]/g, "").toLowerCase();
  const cols = header.map(norm);
  const out: Record<string, number> = {};
  for (const c of IMPORT_SPEC[target].columns) {
    const names = [c.header, ...c.aliases].map(norm);
    out[c.key] = cols.findIndex((h) => names.includes(h));
  }
  return out;
}
