import type { KnowledgeVisibility, StoreId } from "@/lib/db/types";

/**
 * データ台帳: ファイルの分類 (どの業務の資料か・誰が見てよいか・どう取り込むか)
 * ------------------------------------------------------------
 * クライアント資料 (source/ の分野ごとのフォルダー。src/lib/registry/source.ts) は、場所と名前の規則で分ける (下の RULES。上から順に最初に当たったもの)。
 * 名前で決まる資料 (マニュアル・議事録など) は名前の規則、それ以外は分野のフォルダー (SOURCE_FOLDERS) の規則が受け持つ。
 * 画面から追加したファイルは、名前と中身の言葉で分ける (GENERIC)。
 * 中身に個人情報らしいもの (電話番号・メールが多い・生年月日・口座・マイナンバー・健康) があれば、見られる人を本部以上に上げる (piiSignals)。
 * 社員の実名・原価などの値はここに書かない (規則はファイル名・シート名の言葉だけ)
 */

/**
 * 取り込み方:
 * - knowledge: 内容を資料庫に入れ、選んだシート・節を社内資料 (knowledge) にも登録する (AI が最優先で使う)
 * - materials: 内容を資料庫に入れる (AI が search_materials で探す)
 * - structured: システムの表にすでに取り込んだデータ (売上・予定表など)。資料庫には見出し・件数の要約だけ
 * - ledger: 文字のないファイル (写真・動画)。台帳だけ
 * - exclude: 個人の情報 (健康・ご家族・給与など)。内容は取り込まない
 */
export type RegistryAction = "knowledge" | "materials" | "structured" | "ledger" | "exclude";

export const ACTION_LABEL: Record<RegistryAction, string> = {
  knowledge: "社内資料に登録",
  materials: "資料庫 (AI が検索)",
  structured: "システムのデータに取込済み",
  ledger: "台帳のみ (写真・動画)",
  exclude: "取り込まない (個人情報など)",
};

export const VISIBILITY_RANK: Record<KnowledgeVisibility, number> = { all: 0, manager: 1, hq: 2, admin: 3 };
export const maxVisibility = (a: KnowledgeVisibility, b: KnowledgeVisibility): KnowledgeVisibility => (VISIBILITY_RANK[a] >= VISIBILITY_RANK[b] ? a : b);

/** 資料の分類 (社内資料の分類と同じ言葉 + クライアント資料に多いもの) */
export const REGISTRY_CATEGORIES = [
  "社内ルール",
  "マニュアル",
  "お客様対応",
  "商品・価格",
  "施工・作業手順",
  "研修・教育",
  "議事録・決定事項",
  "経営・計画",
  "販促・広告",
  "事務手続き・書式",
  "補助金・申請",
  "協力業者・仕入先",
  "店舗・設備・車両",
  "売上・実績",
  "予定・作業日報",
  "人事・労務",
  "参考資料 (社外)",
  "写真・動画",
  "その他",
] as const;

interface SheetRule {
  /** 取り込まないシート (様式の部品・マスタの写しなど) */
  skip?: RegExp;
  /** このシートだけ取り込む (ほかはシート名だけ記録) */
  only?: RegExp;
  /** 社内資料に登録するシート (knowledge のとき。なければ取り込むシートすべて) */
  knowledge?: RegExp;
  /** シートごとの見られる人 (ファイルの設定より広くはしない) */
  visibility?: [RegExp, KnowledgeVisibility][];
  /** シートごとの分類 */
  category?: [RegExp, string][];
  /** 1 つのシートを、日付で始まる行 (会議の見出し) ごとに分ける (議事録) */
  splitByDate?: boolean;
}

export interface RegistryRule {
  id: string;
  test: RegExp;
  action: RegistryAction;
  category: string;
  visibility: KnowledgeVisibility;
  /** 台帳に出す説明 (なぜこの扱いか) */
  note: string;
  /** structured のとき: 取り込み先 */
  importedTo?: string;
  sheets?: SheetRule;
  /** 店舗の資料のときだけ visibility を使い、店舗が決まらない (全店の) 資料は本部以上にする (店舗のロールにほかの店舗・全社の数字を見せない) */
  storeScoped?: boolean;
}

/** 名前に含まれることが多い、表計算の部品のシート (様式の雛形・マスタの写し) */
const PARTS_SHEETS = /マスタ|^import_|^sector$|^channel$|^caution$|^shouhin$|^選択肢$|BK$|^管理用$|^表紙$|^Sheet\d*$|^シート\d+$|商品並べ替え|配布形態/i;

/**
 * source/ の分野のフォルダー (先頭の階層)。ここに置いた資料は、名前の規則に当たらなければこのフォルダーの扱いになる。
 * フォルダーを増やす・名前を変えるときはここと source/README.md を直す (店舗の名前 (合志・中央・西・玉名・本部) はフォルダー名に入れない: storeFromPath が店舗と読むため)
 */
export interface SourceFolder {
  folder: string;
  label: string;
  /** フォルダーに置くもの (source/README.md と台帳の説明) */
  holds: string;
  action: RegistryAction;
  category: string;
  visibility: KnowledgeVisibility;
}
export const SOURCE_FOLDERS: SourceFolder[] = [
  { folder: "01_社内ルール・マニュアル", label: "社内ルール・マニュアル", holds: "社内総合マニュアル・顧客対応マニュアル・事務改善シート・書類の保管期限・旅費規程", action: "materials", category: "社内ルール", visibility: "manager" },
  { folder: "02_お客様対応・アンケート", label: "お客様対応・アンケート", holds: "アンケートはがき・アンケートの集計・TEL待ちリスト・点検とテレアポ", action: "materials", category: "お客様対応", visibility: "manager" },
  { folder: "03_売上・実績", label: "売上・実績", holds: "店舗別の売上台帳・販売管理ソフトの売上明細 (CSV)", action: "materials", category: "売上・実績", visibility: "hq" },
  { folder: "04_予定表・作業日報", label: "予定表・作業日報", holds: "予定スプレッド (月ごと・過去分)・店舗の作業日報・休日カレンダー", action: "materials", category: "予定・作業日報", visibility: "manager" },
  { folder: "05_販促・広告", label: "販促・広告", holds: "チラシ・折込とポスティング・DM・口コミ・パンフレット・SNS・YouTube・イベント・名刺・看板・販促の計画と分析", action: "materials", category: "販促・広告", visibility: "manager" },
  { folder: "06_研修・教育", label: "研修・教育", holds: "研修・教育カリキュラムとその進み具合", action: "materials", category: "研修・教育", visibility: "manager" },
  { folder: "07_議事録・会議", label: "議事録・会議", holds: "議事録・会議資料", action: "materials", category: "議事録・決定事項", visibility: "manager" },
  { folder: "08_経営・計画", label: "経営・計画", holds: "経営事項審査・新店舗の工程", action: "materials", category: "経営・計画", visibility: "hq" },
  { folder: "09_事務手続き・書式", label: "事務手続き・書式", holds: "事務の覚書・届出の様式・行政 (市役所など) の様式と見積・入札の申請", action: "materials", category: "事務手続き・書式", visibility: "hq" },
  { folder: "10_補助金・助成金", label: "補助金・助成金", holds: "補助金・助成金・くまモンの申請 (計画・様式・実績報告・写真)", action: "materials", category: "補助金・申請", visibility: "hq" },
  { folder: "11_取引先・仕入先", label: "取引先・仕入先", holds: "取引先の請求書・見積書・発注書と発注の管理・契約と取引先の情報", action: "materials", category: "協力業者・仕入先", visibility: "hq" },
  { folder: "12_商品・価格", label: "商品・価格", holds: "縁 (ヘリ) のラインナップと在庫・取扱商品 (クロス・クラッシーノ)・ミニ畳体験", action: "materials", category: "商品・価格", visibility: "hq" },
  { folder: "13_店舗・設備・車両", label: "店舗・設備・車両", holds: "車両点検表・設備・畳の製造と材料 (発注・移動・棚卸)", action: "materials", category: "店舗・設備・車両", visibility: "hq" },
  { folder: "14_施工事例", label: "施工事例", holds: "施工事例の写真と資料 (畳・襖・クロス・畳勉強会)", action: "materials", category: "施工・作業手順", visibility: "all" },
  { folder: "15_人事・労務", label: "人事・労務", holds: "求人。社員・ご家族の個人の情報 (健康診断・就労証明・有給・慶弔・給与・社員の写真) は「個人の情報（取り込まない）」に置く (中身を読まない)", action: "materials", category: "人事・労務", visibility: "admin" },
  { folder: "16_社外の参考資料", label: "社外の参考資料", holds: "社外の講座・SNS の資料・地域の事業の案内", action: "materials", category: "参考資料 (社外)", visibility: "manager" },
  { folder: "20_写真", label: "写真", holds: "現場写真 (現場ごと)・イベント・施工写真・ショールーム・CM の写真など (資料の一部の写真はその資料のフォルダー)", action: "ledger", category: "写真・動画", visibility: "manager" },
  { folder: "21_動画・音声", label: "動画・音声", holds: "CM・テーマソング・作業手順の動画など", action: "ledger", category: "写真・動画", visibility: "manager" },
  { folder: "30_書類の見本", label: "書類の見本", holds: "お客様の書類の見本 (手書きの見積書など)", action: "materials", category: "事務手続き・書式", visibility: "hq" },
  { folder: "99_その他", label: "その他", holds: "どの分野にも当たらないもの・読めない形式", action: "ledger", category: "その他", visibility: "hq" },
];

const escapeRe = (t: string) => t.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

function folderRules(): RegistryRule[] {
  return SOURCE_FOLDERS.map((f) => ({
    id: `folder:${f.folder.replace(/^\d+_/, "")}`,
    test: new RegExp(`^${escapeRe(f.folder.normalize("NFKC"))}/`),
    action: f.action,
    category: f.category,
    visibility: f.visibility,
    note: `${f.label} のフォルダーの資料`,
  }));
}

/** ルール (上から順に最初に当たったもの)。test はsource/ からの相対パス (NFKC で正規化したもの) */
export const RULES: RegistryRule[] = [
  /* ---- 取り込まない (個人の情報) ---- */
  { id: "health", test: /健診|健康診断|人間ドック|checkup|medicalcheck|e96b480a0de9b8f5bd15bc9789d2d501/i, action: "exclude", category: "人事・労務", visibility: "admin", note: "健康診断の申込 (社員の個人情報)。内容は取り込みません" },
  { id: "employment-cert", test: /(^|\/)(3_25037_|3_55144_|大谷\d)/, action: "exclude", category: "人事・労務", visibility: "admin", note: "就労証明書 (社員とご家族の個人情報)。内容は取り込みません" },
  { id: "self-intro", test: /自己紹介\.docx$/, action: "exclude", category: "人事・労務", visibility: "admin", note: "個人の自己紹介。内容は取り込みません" },
  { id: "condolence", test: /慶弔リスト/, action: "exclude", category: "人事・労務", visibility: "admin", note: "慶弔 (ご家族の情報)。事務 → 慶弔リスト (/office) で取り込みます" },
  { id: "leave", test: /有給管理表|休日出勤管理表/, action: "exclude", category: "人事・労務", visibility: "admin", note: "社員ごとの有給・休日出勤。有給・休日出勤 (/leave) で取り込みます" },
  { id: "salary", test: /給与シュミレーション|給与|源泉|使用人名簿|(?<!工事)履歴書/, action: "exclude", category: "人事・労務", visibility: "admin", note: "給与・社員の名簿。内容は取り込みません" },
  { id: "personal", test: /^15_人事・労務\/個人の情報/, action: "exclude", category: "人事・労務", visibility: "admin", note: "社員・ご家族の個人の情報 (人事・労務 → 個人の情報 のフォルダー)。内容は取り込みません" },

  /* ---- システムのデータに取込済み (要約だけ) ---- */
  { id: "sales-ledger", test: /^03_売上・実績\/.*売上\.xlsx$/, action: "structured", category: "売上・実績", visibility: "hq", importedTo: "orders・customers (売上台帳)", note: "店舗別の売上台帳。受注・顧客として取込済み" },
  { id: "sales-csv", test: /^03_売上・実績\/(?:[^/]+\/)?[^/]+\.csv$/i, action: "structured", category: "売上・実績", visibility: "hq", importedTo: "orders・customers (販売管理ソフトの売上明細)", note: "販売管理ソフトの売上明細。データ入出力 → 売上明細の取込 で取込済み" },
  { id: "work-report", test: /作業日報\.xlsx$/, action: "structured", category: "予定・作業日報", visibility: "manager", importedTo: "schedule (予定の担当者を補完)", note: "店舗の作業日報。予定表の担当者として取込済み (月次の集計は 作業日報 /work-reports)" },
  {
    id: "schedule-sheet",
    test: /^04_予定表・作業日報\/予定表\//,
    action: "structured",
    category: "予定・作業日報",
    visibility: "manager",
    importedTo: "schedule (予定表)",
    note: "予定スプレッド (日別の引き取り・納品・見積)。予定表として取込済み。入力ルールのシートは資料として残します",
    sheets: { only: /ルール|説明|使い方/ },
  },
  { id: "holiday-calendar", test: /休日カレンダー/, action: "structured", category: "予定・作業日報", visibility: "manager", importedTo: "holidays (会社の休業日・社内行事)", note: "休日カレンダー。会社の休業日・社内行事として取込済み (予定表 → 休日カレンダー)" },
  { id: "tel-wait", test: /TEL待ちリスト/, action: "structured", category: "お客様対応", visibility: "manager", importedTo: "inquiries (TEL待ち・イベント来店)", note: "お客様の連絡待ちの一覧。問い合わせとして取込済み" },
  { id: "survey-answers", test: /アンケートハガキ/, action: "structured", category: "お客様対応", visibility: "manager", importedTo: "surveys (お客様アンケート)", note: "アンケートはがきの回答。お客様アンケートとして取込済み" },
  { id: "photo-sites", test: /^20_写真\/現場写真\//, action: "ledger", category: "写真・動画", visibility: "manager", importedTo: "photo_albums (現場写真台帳)", note: "現場写真。資料・写真 → 現場写真台帳 に登録済み" },
  { id: "photo-events", test: /^20_写真\/イベント\//, action: "ledger", category: "写真・動画", visibility: "all", note: "イベントの写真" },

  /* ---- 社内資料に登録 (AI が最優先で使う) ---- */
  {
    id: "manual",
    test: /社内総合マニュアル/,
    action: "knowledge",
    category: "マニュアル",
    visibility: "all",
    note: "社内総合マニュアル (経営理念・社内規定・事務・営業・現場)。シートごとに社内資料に登録",
    sheets: {
      visibility: [[/原価|業者価格|仕入|卸|掛率/, "hq"]],
      category: [
        [/経営理念|社内規定/, "社内ルール"],
        [/価格表|商品知識|補助金/, "商品・価格"],
        [/【現場】/, "施工・作業手順"],
        [/クレーム/, "お客様対応"],
        [/【事務】|事務改善/, "マニュアル"],
      ],
    },
  },
  { id: "customer-manual", test: /顧客対応マニュアル/, action: "knowledge", category: "お客様対応", visibility: "all", note: "お客様対応マニュアル (理念・対応の基本・よくある質問)" },
  { id: "minutes", test: /(^|\/)[^/]*議事録[^/]*$/, action: "knowledge", category: "議事録・決定事項", visibility: "manager", note: "会議の議事録。会議ごとに日付つきで社内資料に登録", sheets: { splitByDate: true } },
  { id: "meeting", test: /会議資料/, action: "knowledge", category: "議事録・決定事項", visibility: "manager", note: "会議の資料 (議題・進行表・原案)" },
  {
    id: "training",
    test: /研修\.xlsx$/,
    action: "knowledge",
    category: "研修・教育",
    visibility: "manager",
    note: "研修 (クレーム・アンケート研修・社員シャッフル・工場の整頓)",
    // 店舗ごとのクレーム・アンケートの件数 (全店の数字) と人の配置の案は本部以上 (店舗のロールにほかの店舗・全社の数字を見せない: お客様の決定 2026-11-20)
    sheets: { visibility: [[/アドレス/, "admin"], [/シャッフル.*案|クレーム研修|アンケート研修/, "hq"]], knowledge: /^(?!.*アドレス)/ },
  },
  {
    id: "curriculum",
    test: /教育カリキュラム/,
    action: "knowledge",
    category: "研修・教育",
    visibility: "hq",
    note: "教育カリキュラムと作業手順 (襖・障子・網戸)。社員ごとの進み具合のシートは本部以上で、社内資料には登録しない",
    sheets: { visibility: [[/手順|^カリキュラム$/, "all"]], knowledge: /手順|^カリキュラム$/, category: [[/手順/, "施工・作業手順"]] },
  },
  {
    id: "inspection",
    test: /点検関連/,
    action: "knowledge",
    category: "お客様対応",
    visibility: "all",
    note: "点検・テレアポ (トークマニュアル・点検のルール・点検の内容・単価)。結果の入力シートは店長以上",
    sheets: { visibility: [[/結果/, "hq"]], knowledge: /マニュアル|ルール|内容|単価|オペレーション/ },
  },
  { id: "telapo-rule", test: /テレアポルール/, action: "knowledge", category: "お客様対応", visibility: "all", note: "テレアポのルール" },
  {
    id: "events",
    test: /イベント関連/,
    action: "knowledge",
    category: "販促・広告",
    visibility: "all",
    note: "イベント (準備物・注意事項・特価・受付・人員計画・割引の併用・計画表)。アンケート結果・客数は店長以上",
    sheets: { visibility: [[/アンケート|客数/, "hq"]] },
  },
  { id: "flyer-plan", test: /年間チラシ計画/, action: "knowledge", category: "販促・広告", visibility: "hq", note: "年間のチラシ計画・町別の反応率・個人の売上目標 (全店の数字のため本部以上)", sheets: { knowledge: /チラシ計画|反応率|個人件数/ } },
  { id: "promo-plan", test: /^05_販促・広告\/(?:[^/]+\/)?販促\.xlsx$/, action: "knowledge", category: "経営・計画", visibility: "hq", note: "販促計画・売上アップの行動計画 (全店・店舗ごとの目標のため本部以上)" },
  { id: "sns", test: /SNS管理表/, action: "knowledge", category: "販促・広告", visibility: "all", note: "SNS の運用 (キャッチコピー・ネタ帳・お客様の悩み・畳の効能)" },
  // お客様アンケート集計表: タブごとの CSV (Google スプレッドシートのダウンロード。新しい版) はタブで扱いを分ける。
  // クレーム手直し内容・Google口コミ集計・集計表は KPI → スプレッドシートの取込 (src/lib/survey-workbook/) でシステムのデータに取込済み
  { id: "survey-claims", test: /お客様アンケート集計表.*クレーム手直し内容[^/]*\.csv$/, action: "structured", category: "お客様対応", visibility: "hq", importedTo: "quality_issues (クレーム・手直し)", note: "クレーム・手直しの一覧 (全店の記録・現場名を含む)。KPI → スプレッドシートの取込 で取込済み" },
  { id: "survey-reviews", test: /お客様アンケート集計表.*口コミ集計[^/]*\.csv$/, action: "structured", category: "お客様対応", visibility: "hq", importedTo: "google_reviews (Google 口コミ)", note: "Google 口コミの記録 (担当者・ポイント・支払日)。KPI → スプレッドシートの取込 で取込済み" },
  { id: "survey-history", test: /お客様アンケート集計表.*(集計|比較)\s*\.csv$/, action: "structured", category: "お客様対応", visibility: "hq", importedTo: "survey_history (アンケートの過去の集計)", note: "H26〜R4 のアンケートの集計表 (全社・店舗ごとの数字)。KPI → アンケート の「年度ごとの比較」に取込済み" },
  { id: "survey-comments", test: /お客様アンケート集計表.*コメント\s*\.csv$/, action: "materials", category: "お客様対応", visibility: "hq", note: "お客様の声の分類と件数 (年度・店舗ごと。全店の数字のため本部以上)" },
  { id: "survey-operation", test: /お客様アンケート集計表.*オペレーション\s*\.csv$/, action: "knowledge", category: "お客様対応", visibility: "manager", note: "クレーム・手直しの定義・判断の事例・事務と店舗の処理の手順" },
  { id: "survey-kpi-tab", test: /お客様アンケート集計表.*KPI\s*\.csv$/, action: "knowledge", category: "お客様対応", visibility: "hq", note: "KPI・インセンティブの評価方法と年度ごとの集計 (全店・社員ごとの数字のため本部以上)" },
  // .xlsx (全タブ) は資料庫だけ (社内資料・取込はタブごとの CSV の新しい版を使う。同じ内容を社内資料に二重に入れない)
  { id: "survey-kpi", test: /お客様アンケート集計表/, action: "materials", category: "お客様対応", visibility: "hq", note: "アンケートの KPI・クレーム手直し・口コミ・集計表 (全店の数字のため本部以上。クレーム手直しの処理は店長以上)。社内資料・システムの取込はタブごとの CSV (新しい版) から", sheets: { visibility: [[/オペレーション/, "manager"]] } },
  { id: "media", test: /情報媒体/, action: "knowledge", category: "販促・広告", visibility: "hq", note: "情報媒体 (当社を知ったきっかけ) の月別集計 (全社の数字のため本部以上) と聞き方 (全員)", sheets: { visibility: [[/媒体の聞き方/, "all"]], skip: /フォームの回答/ } },
  { id: "kaizen", test: /事務改善シート/, action: "knowledge", category: "マニュアル", visibility: "all", note: "事務改善シート (起きたこと・原因・改善策)。事務 (/office) でも取り込めます" },
  { id: "heri", test: /ヘリ.*ラインナップ|縁在庫表/, action: "knowledge", category: "商品・価格", visibility: "all", note: "縁 (ヘリ) のラインナップ・在庫。縁在庫 (/heri) でも取り込めます" },
  { id: "doc-retention", test: /書類保管期限/, action: "knowledge", category: "社内ルール", visibility: "all", note: "書類の保管期限" },
  { id: "vehicles", test: /車両点検表/, action: "knowledge", category: "店舗・設備・車両", visibility: "all", note: "車両 (車番・使用者・車検・オイル交換の予定)" },
  {
    id: "office-memo",
    test: /今村覚書/,
    action: "knowledge",
    category: "事務手続き・書式",
    visibility: "hq",
    note: "事務の覚書 (年間の手続き・納税・月末月初の締め・売掛買掛)。場所の案内は全員",
    sheets: { visibility: [[/何がどこにあるか/, "all"]], skip: /給与/ },
  },
  { id: "bid", test: /^09_事務手続き・書式\/.*指名願い/, action: "knowledge", category: "事務手続き・書式", visibility: "hq", note: "入札参加資格の申請 (提出方法・必要書類)" },
  { id: "mini-tatami", test: /ミニ畳体験/, action: "knowledge", category: "商品・価格", visibility: "all", note: "ミニ畳体験の材料とサイズ" },

  /* ---- 資料庫 (AI が検索) ---- */
  { id: "office-forms", test: /^09_事務手続き・書式\/届出・様式\//, action: "materials", category: "事務手続き・書式", visibility: "hq", note: "事務の届出・書式" },
  { id: "city-forms", test: /熊本市様式|市役所管財課|修理見積書|^09_事務手続き・書式\/行政の様式/, action: "materials", category: "事務手続き・書式", visibility: "hq", note: "行政 (熊本市・県・八代市など) の様式・見積・届出" },
  { id: "dunning", test: /督促状/, action: "materials", category: "事務手続き・書式", visibility: "admin", note: "督促状 (取引先の名前を含む)" },
  { id: "contractor-invoice", test: /晃陽建設|請求書|御見積書|Invoice|LION/i, action: "materials", category: "協力業者・仕入先", visibility: "hq", note: "取引先の請求書・見積書" },
  { id: "facilities", test: /設備関係/, action: "materials", category: "店舗・設備・車両", visibility: "hq", note: "設備・ユニフォームなどの業者と金額" },
  { id: "subsidy", test: /補助金|助成金|くまモン/, action: "materials", category: "補助金・申請", visibility: "hq", note: "補助金・助成金・くまモンの申請 (事業計画・様式)" },
  { id: "audit-docs", test: /経営審査/, action: "materials", category: "経営・計画", visibility: "admin", note: "経営事項審査 (決算の数字・工事の経歴)" },
  { id: "contracts", test: /契約書|ヒアリングシート/, action: "materials", category: "協力業者・仕入先", visibility: "hq", note: "取引先との契約・ヒアリング" },
  { id: "products-ext", test: /クラッシーノ|クロス/, action: "materials", category: "商品・価格", visibility: "hq", note: "取扱商品の説明・契約" },
  { id: "orders-forms", test: /発注書|発注管理票|FAX用紙|ＦＡＸ用紙|今村作業内容|畳　一畳屋|畳 一畳屋|様式第14/, action: "materials", category: "協力業者・仕入先", visibility: "hq", note: "発注書・発注の管理・作業の内容" },
  {
    id: "posting",
    test: /折込|オリコミ|ポス|ハイコム|すぱいす|spice_appli|エリア分布|2021年1月\.xlsx$/i,
    action: "materials",
    category: "販促・広告",
    visibility: "manager",
    note: "チラシの折込・ポスティング (配布の地域と枚数・料金・申込)。店舗の資料はその店舗の店長以上、全店の資料は本部以上",
    sheets: { skip: PARTS_SHEETS },
    storeScoped: true,
  },
  { id: "promo-misc", test: /^05_販促・広告\/|SAWAチラシ|chirashi/i, action: "materials", category: "販促・広告", visibility: "manager", note: "販促の資料 (PR 情報・チラシ・看板・広告)" },
  { id: "cases", test: /施工事例/, action: "materials", category: "施工・作業手順", visibility: "all", note: "施工事例" },
  { id: "production", test: /畳製造|製造時間表|材料発注|材料移動|棚卸/, action: "materials", category: "店舗・設備・車両", visibility: "hq", note: "畳の製造・材料の発注と移動・棚卸 (単価を含むため本部以上)" },
  { id: "new-store", test: /新店舗工程表/, action: "materials", category: "経営・計画", visibility: "hq", note: "新店舗 (近見店・玉名店) の工程と備品" },
  { id: "curriculum-progress", test: /カリキュラム進捗/, action: "materials", category: "研修・教育", visibility: "hq", note: "社員ごとの育成カリキュラムの進み具合" },
  { id: "recruit", test: /^15_人事・労務\/求人\/|掲載手順書/, action: "materials", category: "人事・労務", visibility: "hq", note: "求人の原稿・求人広告の掲載手順" },
  { id: "external", test: /リールナレッジ|instagram|Meta_AI|Lesson5|柳井|台湾|モニターツアー|Taiwan/i, action: "materials", category: "参考資料 (社外)", visibility: "manager", note: "社外の参考資料 (SNS・動画・地域の事業の案内)" },
  { id: "office-misc", test: /^09_事務手続き・書式\//, action: "materials", category: "事務手続き・書式", visibility: "hq", note: "事務の資料" },
  { id: "top-pdf", test: /^30_書類の見本\//, action: "materials", category: "事務手続き・書式", visibility: "hq", note: "お客様の書類の見本 (手書きの見積書など)" },

  /* ---- 分野のフォルダー (上の規則に当たらない資料。あとから追加した資料もここで分かれる) ---- */
  ...folderRules(),
];

/** フォルダ名 (台帳の「フォルダ」の表示。資料庫の folder = source/ の先頭の階層) */
export const FOLDER_LABEL: Record<string, string> = {
  ...Object.fromEntries(SOURCE_FOLDERS.map((f) => [f.folder, f.label])),
  "": "source 直下",
};

const KIND_DEFAULT: Record<string, Pick<RegistryRule, "action" | "category" | "visibility" | "note">> = {
  image: { action: "ledger", category: "写真・動画", visibility: "manager", note: "画像 (文字なし)" },
  media: { action: "ledger", category: "写真・動画", visibility: "manager", note: "動画・音声" },
  other: { action: "ledger", category: "その他", visibility: "hq", note: "読み取れない形式" },
};

/** 中身の言葉で分ける (画面から追加したファイル・規則に当たらないファイル) */
const GENERIC: [RegExp, string, KnowledgeVisibility][] = [
  [/議事録|会議|決定事項/, "議事録・決定事項", "manager"],
  [/マニュアル|手順書|手引|ルール/, "マニュアル", "all"],
  [/価格表|単価表|料金表|商品/, "商品・価格", "all"],
  [/研修|教育|カリキュラム/, "研修・教育", "all"],
  [/チラシ|折込|ポスティング|販促|広告|イベント|SNS|インスタ/i, "販促・広告", "manager"],
  [/補助金|助成金/, "補助金・申請", "hq"],
  [/請求書|見積書|発注書|契約書/, "協力業者・仕入先", "hq"],
  [/届出|申請書|様式/, "事務手続き・書式", "hq"],
  [/計画|目標|戦略/, "経営・計画", "manager"],
];

export interface Classification {
  ruleId: string;
  action: RegistryAction;
  category: string;
  visibility: KnowledgeVisibility;
  note: string;
  importedTo?: string;
  sheets?: SheetRule;
  storeId?: StoreId;
  recordDate?: string;
}

/** パスの正規化 (全角英数・記号を半角に。区切りは /) */
export const normPath = (p: string) => p.normalize("NFKC").replace(/\\/g, "/");

/** パス・名前から店舗 (1 つに決まるときだけ) */
export function storeFromPath(p: string): StoreId | undefined {
  const n = normPath(p);
  const hits = new Set<StoreId>();
  if (/合志/.test(n)) hits.add("koshi");
  if (/中央/.test(n)) hits.add("chuo");
  if (/西店|(^|\/)西(\/|$)|西作業/.test(n)) hits.add("nishi");
  if (/玉名/.test(n)) hits.add("tamana");
  if (/本部/.test(n)) hits.add("hq");
  return hits.size === 1 ? [...hits][0] : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d?: number) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && (!d || (d >= 1 && d <= 31));

/** 名前の日付 (令和 R8.5月27 / 2026.8.18 / 2025.10 など)。日がなければ月の 1 日 */
export function dateFromName(name: string): string | undefined {
  const n = name.normalize("NFKC");
  // 令和: R8.5月27 / R7.9月 / 令和8年5月
  let m = /(?:R|令和)\s?(\d{1,2})[.年]\s?(\d{1,2})月?(?:[.\s]?(\d{1,2})日?)?/.exec(n);
  if (m) {
    const y = 2018 + Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : undefined;
    if (valid(y, mo, d)) return `${y}-${pad(mo)}-${pad(d ?? 1)}`;
  }
  m = /(20\d\d)[.\-/年](\d{1,2})(?:[.\-/月](\d{1,2}))?/.exec(n);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : undefined;
    if (valid(y, mo, d)) return `${y}-${pad(mo)}-${pad(d ?? 1)}`;
  }
  return undefined;
}

export function classifyPath(relPath: string, kind: string): Classification {
  const p = normPath(relPath);
  const name = p.split("/").pop() ?? p;
  const rule = RULES.find((r) => r.test.test(p));
  const base = rule ?? (KIND_DEFAULT[kind] ? { id: `kind:${kind}`, ...KIND_DEFAULT[kind] } : undefined);
  const out: Classification = base
    ? { ruleId: base.id, action: base.action, category: base.category, visibility: base.visibility, note: base.note, importedTo: rule?.importedTo, sheets: rule?.sheets }
    : { ruleId: "generic", action: "materials", category: "その他", visibility: "hq", note: "ほかの規則に当たらない資料 (本部以上)" };
  // 写真・動画は文字を読まないので、資料のフォルダーにあっても台帳だけ (分類・見られる人はそのフォルダー・規則のもの)
  if ((kind === "image" || kind === "media") && out.action === "materials") out.action = "ledger";
  if (!rule && !KIND_DEFAULT[kind]) {
    const g = GENERIC.find(([re]) => re.test(name));
    if (g) Object.assign(out, { category: g[1], visibility: maxVisibility(g[2], "manager"), note: `名前から分類 (${g[1]})` });
  }
  out.storeId = storeFromPath(p);
  out.recordDate = dateFromName(name);
  if (rule?.storeScoped && !out.storeId) {
    out.visibility = maxVisibility(out.visibility, "hq");
    out.note = `${out.note} (店舗が決まらないため本部以上)`;
  }
  return out;
}

/** 画面から追加したファイル: 名前と中身の言葉で分ける (見られる人は選んだもの。分類だけ推定) */
export function guessCategory(name: string, text: string): string {
  const head = `${name}\n${text.slice(0, 3000)}`;
  return GENERIC.find(([re]) => re.test(head))?.[1] ?? "その他";
}

/** シートの扱い: 取り込むか・社内資料に登録するか・見られる人・分類 */
export function sheetPolicy(c: Classification, sheetName: string): { keep: boolean; knowledge: boolean; visibility: KnowledgeVisibility; category: string } {
  const s = c.sheets;
  const n = sheetName.normalize("NFKC").trim();
  let keep = true;
  if (s?.only && !s.only.test(n)) keep = false;
  if (s?.skip?.test(n)) keep = false;
  // 規則にシートの指定がないときも、表計算の部品 (マスタの写し・取込用のシート) は除く
  if (!s?.skip && /マスタ|^import_\d|BK$/i.test(n)) keep = false;
  const vis = s?.visibility?.find(([re]) => re.test(n))?.[1];
  // シートの設定は広げる方向 (all) にも使えるが、ファイルが除外・本部以上の設定のときは広げない
  const visibility = vis ? (c.action === "exclude" ? c.visibility : vis) : c.visibility;
  const category = s?.category?.find(([re]) => re.test(n))?.[1] ?? c.category;
  const knowledge = c.action === "knowledge" && keep && (!s?.knowledge || s.knowledge.test(n));
  return { keep, knowledge, visibility, category };
}

/* ================================================================== */
/* 個人情報らしいもの                                                     */
/* ================================================================== */

export interface PiiSignals {
  phones: number;
  emails: number;
  postal: number;
  /** 生年月日・口座・マイナンバー・健康・病歴などの言葉 */
  markers: string[];
}

/** 言葉だけでなく値が書かれているもの (空の様式・手順の説明では上げない) */
const MARKERS: [RegExp, string][] = [
  [/生年月日.{0,15}(\d{2,4}\s?[年./-]|[昭平令][和成]?\s?\d)/, "生年月日"],
  [/(口座番号|普通預金|当座預金|普通|当座).{0,20}\d{7}/, "口座"],
  [/(マイナンバー|個人番号).{0,10}\d{4}\s?\d{4}\s?\d{4}/, "マイナンバー"],
  [/病歴|既往歴/, "健康"],
  [/(基本給|手取り|支給額|総支給).{0,10}[\d,]{5,}/, "給与"],
];

export function piiSignals(text: string): PiiSignals {
  const t = text.normalize("NFKC");
  const phones = new Set(t.match(/0\d{1,4}-\d{1,4}-\d{3,4}|0[789]0\d{8}/g) ?? []);
  const emails = new Set(t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []);
  const postal = new Set(t.match(/〒\s?\d{3}-\d{4}/g) ?? []);
  return { phones: phones.size, emails: emails.size, postal: postal.size, markers: MARKERS.filter(([re]) => re.test(t)).map(([, l]) => l) };
}

/** 個人情報らしいものが多いとき、見られる人を上げる (理由つき) */
export function piiVisibility(sig: PiiSignals, current: KnowledgeVisibility): { visibility: KnowledgeVisibility; reason?: string } {
  if (sig.markers.length) return { visibility: maxVisibility(current, "admin"), reason: `個人情報らしい言葉 (${sig.markers.join("・")})` };
  if (sig.phones >= 8 || sig.emails >= 5 || sig.postal >= 5) return { visibility: maxVisibility(current, "hq"), reason: `電話番号 ${sig.phones}・メール ${sig.emails}・郵便番号 ${sig.postal} 件` };
  return { visibility: current };
}

/** 分類の結果の指紋 (規則を変えたら、その資料だけ読み直すため) */
export function classificationKey(c: Classification): string {
  const sheets = c.sheets
    ? JSON.stringify(c.sheets, (_, v) => (v instanceof RegExp ? v.toString() : v))
    : "";
  return [c.ruleId, c.action, c.category, c.visibility, c.note, c.importedTo ?? "", c.storeId ?? "", c.recordDate ?? "", sheets].join("|");
}


/* ================================================================== */
/* 認証情報 (ID・パスワード・暗証番号) を伏せる                              */
/* ================================================================== */

/** 伏せたあとの印 */
export const REDACTED = "［伏せ字］";
const SECRET_KEY = "(?:パスワード|ﾊﾟｽﾜｰﾄﾞ|パスコード|パス|PW|ＰＷ|pwd|pass(?:word|code)?|暗証番号|暗証|(?:ログイン|ユーザー?|利用者|契約法人|事業者|ミーティング\\s?)?(?:ID|ＩＤ))";
/** 値は英数字・記号 (認証情報は ASCII)。日本語の説明は伏せない */
const SECRET_VALUE = "[A-Za-z0-9@._\\-!#$%&*+/=?^~]{3,}(?:[ \\u3000][0-9]{3,4})*";
const SECRET_RE = new RegExp(`(${SECRET_KEY}\\s*[:：=＝]\\s*)(${SECRET_VALUE})`, "gi");
const SECRET_URL_RE = /([?&](?:pwd|pass|password|passcode|token|key|apikey|api_key)=)[^&\s|]+/gi;

/**
 * 資料の文字から、ID・パスワード・暗証番号などの値を伏せる (資料庫・社内資料・AI に渡さない)。
 * 「ID：abc123」「PW: 1234」「パス：xyz」「?pwd=…」のように、言葉のあとに値が書かれているものだけ (「ID 等は別紙」は伏せない)
 */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  const out = text
    .replace(SECRET_URL_RE, (_, key: string) => {
      count++;
      return `${key}${REDACTED}`;
    })
    .replace(SECRET_RE, (m: string, key: string, value: string) => {
      if (value === REDACTED) return m;
      count++;
      return `${key}${REDACTED}`;
    });
  return { text: out, count };
}
