/**
 * 管理会計 (店舗別独立採算・売上配分・材料原価・在庫・共通経費の案分) の型
 * ------------------------------------------------------------
 * 既存の受注・仕入・経費の表は変えず、ここの表から ID で参照する (受注の店舗 storeId = 売上帰属店舗)。
 * 金額は円の整数、数量・単価は小数 4 桁まで (src/lib/mgmt/decimal.ts で計算する)。
 * 確定した行は書き換えない: 取消し・訂正は逆の行 (reversalOf) を足し、元の行には reversedBy を残す
 */
import type { StoreId } from "./types";

/** 設定マスタ (配分率・端数処理・未確定の扱いなど)。値を変えるときは新しい行を足し、前の行に validTo を入れる */
export interface MgmtRule {
  id: string;
  key: string;
  value: string;
  /** 適用開始日 (YYYY-MM-DD) */
  validFrom: string;
  /** 適用終了日 (この日まで。次の行の開始日の前日) */
  validTo?: string;
  /** confirmed = 確認済み / provisional = 暫定 (税理士・社内の確認待ち) */
  status: "confirmed" | "provisional";
  note?: string;
  createdBy: string;
  createdAt: string;
}

/** 品目 (管理会計の 7 区分: 畳・襖・リフォーム・カーテン類・自社商品・その他・諸経費) */
export interface ItemCategory {
  id: string;
  name: string;
  sort: number;
  active: boolean;
  note?: string;
  updatedAt?: string;
}

/** 営業エリア (町名 → 担当店舗)。変更は新しい行 + 前の行の validTo (履歴が残る) */
export interface SalesArea {
  id: string;
  /** 市区町村 (例: 合志市・熊本市東区) */
  municipality: string;
  /** 町名 (空 = 市区町村全体) */
  town: string;
  storeId: StoreId;
  validFrom: string;
  validTo?: string;
  source: "import" | "manual";
  sourceRef?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
}

export type WorkKind = "normal" | "reform";

/** 売上の帰属 (受注 1 件に 1 行。ID は oa_<受注 ID>)。売上帰属店舗は受注の storeId */
export interface OrderAttribution {
  id: string;
  orderId: string;
  /** 営業エリア上の担当店舗 (住所から自動判定。判定できないときは空) */
  areaStoreId?: StoreId;
  /** 判定に使った住所のキー (市区町村 + 町名) */
  areaKey?: string;
  /** 受注店舗 */
  receivedStoreId: StoreId;
  /** 実際の施工店舗 */
  workStoreId: StoreId;
  /** 工事の区分 (内部受注の配分率に使う) */
  workKind: WorkKind;
  /** 本部売上・特殊配分あり */
  hqSpecial?: boolean;
  /** 税区分 (課税・免税 (輸出など)・非課税・不課税・未設定)。税務の判断は自動で決めない */
  taxCategory?: "taxable" | "exempt" | "non_taxable" | "out_of_scope" | "unset";
  /** 売上帰属店舗が施工店舗と違う理由など */
  note?: string;
  updatedBy: string;
  updatedAt: string;
}

/**
 * 店舗別売上の調整 (内部受注の配分・本部の特殊配分・手入力の調整)。
 * 依頼元 fromStoreId に +amount、施工店舗 toStoreId に −amount (店舗の合計は常に 0。全社の外部売上は変わらない)
 */
export interface SalesAdjustment {
  id: string;
  number: string;
  kind: "internal_order" | "hq_special" | "manual";
  orderId?: string;
  /**
   * 計上日。空のときは受注の売上計上日 (施工完了前は未計上)。
   * 本部の特殊配分・手入力の調整・確定した月の訂正の行は日付を持つ
   */
  date?: string;
  /** 配分を受け取る店舗 (内部受注の依頼元) */
  fromStoreId: StoreId;
  /** 配分を渡す店舗 (施工店舗・本部) */
  toStoreId: StoreId;
  workKind?: WorkKind;
  /** 配分の基準額 (円) と、税込・税抜のどちらか */
  baseAmount?: number;
  base?: "tax_included" | "tax_excluded";
  /** 配分率 (1/10,000。20% = 2000)。金額指定のときは空 */
  rateBp?: number;
  rateSource?: "standard" | "override";
  /** 計算に使った設定の行 (MgmtRule の ID) */
  ruleIds?: string[];
  rounding?: string;
  /** 依頼元へ移す金額 (円)。取消しの行は負 */
  amount: number;
  /** 本部の特殊配分の会計上の扱い (未確定は unset) */
  treatment?: "sales_transfer" | "cost_only" | "unset";
  /** 暫定の設定で計算した (未確定の項目を含む) */
  provisional: boolean;
  status: "active" | "reversed";
  /** 取消しの行のとき、元の行 */
  reversalOf?: string;
  /** 取り消した行 (元の行に残す) */
  reversedBy?: string;
  reason?: string;
  createdBy: string;
  createdAt: string;
}

export type MaterialKind = "omote" | "chem_omote" | "heri" | "doko" | "sub" | "cloth" | "paper" | "other";

/** 材料マスタ */
export interface Material {
  id: string;
  code: string;
  name: string;
  kind: MaterialKind;
  spec?: string;
  unit: string;
  /** 畳床の厚み (mm) */
  thickness?: number;
  /** 畳床の規格 (gohachi = 五八間 / honma = 本間 / other) */
  size?: string;
  /** 品目 (ItemCategory の ID) */
  itemCategory: string;
  /** 仕入先の品番 (請求書の照合に使う) */
  supplierCode?: string;
  active: boolean;
  note?: string;
  /** 規定量 (共通在庫がこの数量を下回ったら発注する。縁在庫の画面 /heri で設定。空 = 設定なし) */
  reorderLevel?: number;
  /** 発注先 (仕入先の ID) */
  supplierId?: string;
  /** シリーズ (縁の柄の系統: アラベスク・浮・織部 など。一覧のまとまり) */
  series?: string;
  /** 通常ヘリのラインナップ (見本帳の定番) */
  lineup?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 原価単価の履歴 (単価を変えるときは新しい行。過去の原価は当時の行の単価で計算されたまま) */
export interface MaterialCost {
  id: string;
  materialId: string;
  /** 単価 (円・税抜。小数 4 桁まで) */
  unitCost: number;
  /** provisional = 仮原価 (畳表) / standard = 原価単価 */
  kind: "provisional" | "standard";
  validFrom: string;
  validTo?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
}

/** 材料構成の 1 行。materialId が空のときは種類だけ決まっていて、使う材料は製造仕様で決める (畳床など) */
export interface BomLine {
  materialId?: string;
  materialKind: MaterialKind;
  /** 商品 1 単位あたりの使用量 (半畳の主材料は 0.5 など。材料ごとの係数) */
  qty: number;
  note?: string;
}

/** 材料構成 (BOM)。商品マスタの商品、または移行データの品名 (matchName を含む) ごと */
export interface Bom {
  id: string;
  productId?: string;
  matchName?: string;
  name: string;
  lines: BomLine[];
  validFrom: string;
  validTo?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
}

/**
 * 材料の使用・原価 (受注ごと)。段階 estimate (見積の予想原価) → planned (施工・製造の使用予定) → actual (使用実績)。
 * 原価には受注ごとに一番進んだ段階の行だけを数える (同じ材料を段階ごとに二重に数えない)
 */
export interface MaterialUsage {
  id: string;
  orderId: string;
  /** 原価を計上する店舗 (施工店舗) */
  storeId: StoreId;
  materialId?: string;
  materialKind: MaterialKind;
  itemCategory: string;
  qty: number;
  /** 当時の単価 (円) と、その単価の行 */
  unitCost?: number;
  costId?: string;
  /** 円。単価・材料が決まらないとき (要確認) は空 */
  amount?: number;
  stage: "estimate" | "planned" | "actual";
  source: "bom" | "manual" | "production";
  bomId?: string;
  /** 元の明細 (品名・枚数) */
  productLabel?: string;
  sheets?: number;
  /** 畳床の製造仕様 */
  spec?: { dokoType?: string; thickness?: number; size?: string };
  needsReview?: boolean;
  reviewNote?: string;
  status: "active" | "superseded" | "reversed";
  date: string;
  stockMoveId?: string;
  reversalOf?: string;
  createdBy: string;
  createdAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

/**
 * 在庫の移動 (受入・店舗間の移動・案件への使用・返品・廃棄・棚卸の調整)。
 * 場所は "supplier" / "store:<店舗 ID>" / "order:<受注 ID>" / "disposal" / "adjust"。
 * 原価になるのは use (案件への使用) だけ。transfer は店舗間で在庫を動かすだけで、全社の在庫・原価は増えない
 */
export interface StockMove {
  id: string;
  number: string;
  date: string;
  kind: "receive" | "transfer" | "use" | "return" | "dispose" | "adjust";
  materialId: string;
  /** 数量 (正の数。adjust の減少は fromLoc に店舗) */
  qty: number;
  unitCost: number;
  amount: number;
  fromLoc?: string;
  toLoc?: string;
  /** 閲覧範囲の店舗 (受入・移動は移動先、使用・廃棄・返品は移動元) */
  storeId: StoreId;
  orderId?: string;
  purchaseId?: string;
  purchaseItemId?: string;
  usageId?: string;
  status: "draft" | "confirmed" | "reversed";
  reversalOf?: string;
  reversedBy?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

/** 仕入明細の費用区分 */
export type CostType = "material" | "outsource" | "inventory" | "store_expense" | "common_expense" | "other";

/** 仕入明細の振り分け先 (1 明細を複数の店舗・案件へ分けられる。合計は明細の金額と一致させる) */
export interface PurchaseSplit {
  storeId: StoreId;
  orderId?: string;
  itemCategory: string;
  costType: CostType;
  materialId?: string;
  qty?: number;
  /** 円 (税抜) */
  amount: number;
}

/**
 * 仕入請求書の明細ごとの振り分け (ID は pla_<仕入 ID>_<明細 ID>)。
 * ocr = 読み取った内容 (写し)、ai = 自動判定 (推定・理由・参照・信頼度)、splits = 担当者が確定した振り分け。3 つは別々に持つ
 */
export interface PurchaseLineAlloc {
  id: string;
  purchaseId: string;
  itemId: string;
  lineNo: number;
  ocr: {
    name: string;
    code?: string;
    spec?: string;
    qty?: number;
    unit?: string;
    unitPrice?: number;
    /** 明細の金額 (円・税込) と、税抜の金額 */
    amount: number;
    amountExTax: number;
    storeText?: string;
    siteText?: string;
    note?: string;
  };
  ai?: {
    storeId?: StoreId;
    orderId?: string;
    itemCategory?: string;
    costType?: CostType;
    materialId?: string;
    reason: string;
    refs: string[];
    /** 0〜100 */
    confidence: number;
    needsReview: boolean;
    candidates?: { orderId: string; label: string; score: number }[];
    method: "rules" | "rules+ai";
    at: string;
  };
  splits: PurchaseSplit[];
  status: "unassigned" | "needs_review" | "confirmed";
  reason?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  updatedAt: string;
}

/** 経費の区分 (ID は ec_<経費 ID>)。区分がない経費は店舗独自経費 (本部の経費も本部の独自経費) として数える */
export interface ExpenseClass {
  id: string;
  expenseId: string;
  allocClass: "store" | "common";
  /** 費目 (人件費・広告宣伝費・消耗品費・廃棄物処分費・システム開発費・その他) */
  costKind: string;
  note?: string;
  updatedBy: string;
  updatedAt: string;
}

/** 管理会計の手入力 (人件費・管理経費・共通経費・材料の差額調整・予算)。月 × 店舗 */
export interface MgmtEntry {
  id: string;
  month: string;
  storeId: StoreId;
  kind: "labor" | "store_expense" | "common_expense" | "other_mgmt" | "material_adjust" | "budget";
  /** 予算の指標 (sales / gross / profit) */
  metric?: string;
  itemCategory?: string;
  /** 円 (税抜) */
  amount: number;
  note?: string;
  status: "active" | "reversed";
  reversalOf?: string;
  reversedBy?: string;
  createdBy: string;
  createdAt: string;
}

/** 共通経費の案分の計算 (月ごと)。確定すると基準の粗利益・率・結果を固定して保存する */
export interface AllocationRun {
  id: string;
  number: string;
  month: string;
  status: "draft" | "held" | "confirmed" | "superseded";
  method: "gross_ratio" | "manual_ratio";
  methodReason?: string;
  targetStoreIds: StoreId[];
  pool: { source: "expense" | "purchase_line" | "entry"; id: string; label: string; amount: number }[];
  poolTotal: number;
  /** 案分の基準の粗利益 (計算時に固定。案分後の経費は入れない) */
  basis: { storeId: StoreId; gross: number; weight?: number }[];
  basisTotal: number;
  results: { storeId: StoreId; ratePpm: number; amount: number }[];
  rounding: string;
  holdReason?: string;
  /** 計算に使った設定 (キー → 値・状態・行) */
  rules: Record<string, { value: string; status: string; ruleId?: string }>;
  correctionOf?: string;
  supersededBy?: string;
  reason?: string;
  createdBy: string;
  createdAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

/** 月次確定 (ID = 月 YYYY-MM)。確定すると、その月の調整・使用・移動・手入力・案分は変えられない */
export interface PeriodClose {
  id: string;
  month: string;
  status: "closed" | "open";
  /** 確定した時点の店舗別損益 (再現用) */
  snapshot?: unknown;
  history: { action: "close" | "reopen"; by: string; at: string; reason?: string }[];
  updatedAt: string;
}
