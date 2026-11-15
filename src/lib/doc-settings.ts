import type { Database } from "@/lib/db/types";

/**
 * 帳票 (見積書・請求書・領収書の PDF) に載せる会社情報
 * ------------------------------------------------------------
 * 設定 → 帳票 で管理者が入力し、settings テーブルの id = "documents" に保存する。
 * 登録番号・振込先などの実際の値はコードに書かない (公開リポジトリのため)。未入力の項目は帳票に出さない
 */

export interface BankAccount {
  bank: string;
  branch: string;
  /** 普通 / 当座 */
  type: string;
  number: string;
  holder: string;
}

export interface DocumentSettings {
  companyName: string;
  /** 本社の郵便番号・住所・電話 (空なら店舗マスタの本社を使う) */
  postalCode: string;
  address: string;
  tel: string;
  fax: string;
  email: string;
  website: string;
  /** 適格請求書発行事業者の登録番号 (T + 13 桁) */
  registrationNumber: string;
  /** 帳票に担当店舗の住所・電話も載せる */
  showStore: boolean;
  bankAccounts: BankAccount[];
  /** 見積の有効期限 (日数) */
  quoteValidDays: number;
  /** 請求書の支払期限 (発行日からの日数) */
  paymentDays: number;
  /** 見積書の定型の備考 */
  quoteNote: string;
  /** 請求書の定型の備考 */
  invoiceNote: string;
}

export const DOCUMENT_SETTINGS_ID = "documents";

export function defaultDocumentSettings(db: Pick<Database, "stores">): DocumentSettings {
  const hq = db.stores.find((s) => s.id === "hq");
  return {
    companyName: "株式会社一畳屋",
    postalCode: hq?.postalCode ?? "",
    address: hq?.address ?? "",
    tel: hq?.phone ?? "",
    fax: "",
    email: "",
    website: "",
    registrationNumber: "",
    showStore: true,
    bankAccounts: [],
    quoteValidDays: 30,
    paymentDays: 30,
    quoteNote: "本見積の有効期限内にご用命ください。施工日程はご注文後にご相談のうえ決定いたします。",
    invoiceNote: "お振込手数料はお客様にてご負担くださいますようお願いいたします。",
  };
}

const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
};

/** 保存された値 (古い形・欠けた値を含む) を既定値と合わせて読む */
export function documentSettings(db: Pick<Database, "stores" | "settings">): DocumentSettings {
  const d = defaultDocumentSettings(db);
  const v = (db.settings ?? []).find((s) => s.id === DOCUMENT_SETTINGS_ID)?.value ?? {};
  const banks = Array.isArray(v.bankAccounts)
    ? (v.bankAccounts as Record<string, unknown>[])
        .map((b) => ({ bank: str(b?.bank, 60) ?? "", branch: str(b?.branch, 60) ?? "", type: str(b?.type, 10) ?? "普通", number: str(b?.number, 20) ?? "", holder: str(b?.holder, 80) ?? "" }))
        .filter((b) => b.bank && b.number)
    : d.bankAccounts;
  return {
    companyName: str(v.companyName, 80) || d.companyName,
    postalCode: str(v.postalCode, 10) ?? d.postalCode,
    address: str(v.address, 120) ?? d.address,
    tel: str(v.tel, 30) ?? d.tel,
    fax: str(v.fax, 30) ?? d.fax,
    email: str(v.email, 120) ?? d.email,
    website: str(v.website, 120) ?? d.website,
    registrationNumber: str(v.registrationNumber, 20) ?? d.registrationNumber,
    showStore: typeof v.showStore === "boolean" ? v.showStore : d.showStore,
    bankAccounts: banks,
    quoteValidDays: int(v.quoteValidDays, 1, 365) ?? d.quoteValidDays,
    paymentDays: int(v.paymentDays, 0, 365) ?? d.paymentDays,
    quoteNote: str(v.quoteNote, 600) ?? d.quoteNote,
    invoiceNote: str(v.invoiceNote, 600) ?? d.invoiceNote,
  };
}

/** 登録番号の形 (T + 13 桁)。空は「未設定」として許す */
export function validRegistrationNumber(v: string): boolean {
  return v === "" || /^T\d{13}$/.test(v);
}
