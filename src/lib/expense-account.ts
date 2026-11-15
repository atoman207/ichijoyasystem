import { EXPENSE_ACCOUNTS } from "@/lib/constants";

/**
 * 経費の勘定科目の候補
 * ------------------------------------------------------------
 * 支払先・品目・内容の言葉と金額から、勘定科目の候補を理由つきで最大 3 つ挙げる。
 * - ルール (この表): API キーがなくても動く。入力しながら候補を出す画面と、AI の候補の補完に使う
 * - AI: レシートの読取 (src/lib/ai/ocr.ts) と「AI で候補を出す」(src/lib/actions/expenses.ts) が理由つきの候補を返す
 * 候補はあくまで提案。登録する科目は担当者が選ぶ
 */

export type ExpenseAccount = (typeof EXPENSE_ACCOUNTS)[number];

export interface AccountCandidate {
  account: ExpenseAccount;
  reason: string;
  /** rule = 言葉のルール / ai = AI の提案 */
  source: "rule" | "ai";
}

const RULES: { account: ExpenseAccount; words: RegExp; reason: string }[] = [
  { account: "車両費 (ガソリン代)", words: /ガソリン|給油|軽油|ハイオク|レギュラー|ENEOS|エネオス|出光|コスモ石油|昭和シェル|apollostation|アポロ|SS\b|洗車|オイル交換|タイヤ|車検|自動車整備/i, reason: "給油・車両の維持に関する支払" },
  { account: "旅費交通費", words: /ETC|高速|NEXCO|駐車|パーキング|タクシー|JR|新幹線|バス|電車|切符|乗車券|航空|宿泊|ホテル/i, reason: "移動・駐車・宿泊の支払" },
  { account: "通信費", words: /切手|郵便|ゆうパック|レターパック|携帯|スマホ|通信|インターネット|プロバイダ|docomo|ドコモ|au\b|ソフトバンク|楽天モバイル|NTT/i, reason: "郵便・電話・通信の支払" },
  { account: "荷造運賃", words: /宅急便|宅配|ヤマト運輸|佐川|西濃|運送|送料|配送料|梱包|ダンボール|段ボール/i, reason: "発送・運送の支払" },
  { account: "会議費", words: /会議|打合せ|打ち合わせ|弁当|飲料|お茶|コーヒー|カフェ|喫茶|スターバックス|ドトール/i, reason: "打合せ・会議の飲食 (少額)" },
  { account: "接待交際費", words: /接待|贈答|手土産|お歳暮|お中元|御祝|ご祝儀|香典|居酒屋|会食|懇親/i, reason: "取引先との飲食・贈答" },
  { account: "水道光熱費", words: /電気|電力|ガス(?!リン)|水道|九州電力|西部ガス/i, reason: "電気・ガス・水道の料金" },
  { account: "修繕費", words: /修理|修繕|補修|メンテナンス|点検費/i, reason: "設備・道具の修理" },
  { account: "広告宣伝費", words: /広告|チラシ|折込|ポスティング|看板|のぼり|DM|ダイレクトメール|求人|印刷(?=.*チラシ)/i, reason: "広告・チラシ・販促" },
  { account: "材料費", words: /い草|畳表|畳床|畳縁|へり|襖紙|ふすま紙|障子紙|網戸|ネット|材料|資材|木材|合板|糊|のり/i, reason: "施工に使う材料の購入" },
  { account: "新聞図書費", words: /新聞|書籍|雑誌|本\b|図書|書店|紀伊國屋|TSUTAYA/i, reason: "新聞・書籍の購入" },
  { account: "支払手数料", words: /手数料|振込手数料|ATM|代引/i, reason: "振込・取扱の手数料" },
  { account: "租税公課", words: /収入印紙|印紙|証明書|住民票|印鑑証明|登記|自動車税|固定資産税|手数料\(行政\)/i, reason: "印紙・証明書・税金" },
  { account: "福利厚生費", words: /健康診断|慶弔|社員旅行|忘年会|新年会|差し入れ|救急箱/i, reason: "社員の福利厚生" },
  { account: "消耗品費", words: /ホームセンター|コメリ|カインズ|ナフコ|ハンズマン|ダイソー|セリア|文具|事務用品|コピー用紙|トナー|インク|電池|テープ|養生|軍手|作業着|カッター|工具|ドライバー|ビス|釘|掃除|洗剤|ゴミ袋|アスクル|モノタロウ|Amazon|アマゾン/i, reason: "事務用品・消耗品・小さな道具の購入" },
];

/** 備品 (道具・機械) を表す言葉。10 万円以上なら固定資産の候補にする */
const EQUIPMENT_WORDS = /工具|電動|インパクト|丸ノコ|丸のこ|ミシン|機械|パソコン|PC|プリンター|複合機|タブレット|iPad|カメラ|脚立|台車|棚|机|椅子|備品/i;

/**
 * ルールによる候補 (理由つき・最大 3 件)。言葉が見つからなければ空
 * 10 万円以上の備品は「工具器具備品」(固定資産) を先頭に、10 万円未満の備品は「消耗品費」を候補にする
 */
export function suggestAccounts(input: { vendor?: string; description?: string; items?: string[]; amount?: number }): AccountCandidate[] {
  const text = [input.vendor, input.description, ...(input.items ?? [])].filter(Boolean).join(" ").normalize("NFKC");
  if (!text.trim()) return [];
  const out: AccountCandidate[] = [];
  const add = (account: ExpenseAccount, reason: string) => {
    if (!out.some((c) => c.account === account)) out.push({ account, reason, source: "rule" });
  };
  const amount = input.amount ?? 0;
  if (EQUIPMENT_WORDS.test(text)) {
    if (amount >= 100_000) add("工具器具備品", "10 万円以上の備品・道具 (固定資産として計上)");
    else add("消耗品費", "10 万円未満の備品・道具");
  }
  for (const r of RULES) if (r.words.test(text)) add(r.account, r.reason);
  return out.slice(0, 3);
}

/** AI の候補とルールの候補をまとめる (AI を優先し、同じ科目は 1 つに。最大 3 件) */
export function mergeCandidates(ai: AccountCandidate[], rule: AccountCandidate[]): AccountCandidate[] {
  const out: AccountCandidate[] = [];
  for (const c of [...ai, ...rule]) if (!out.some((x) => x.account === c.account)) out.push(c);
  return out.slice(0, 3);
}

export function isExpenseAccount(v: unknown): v is ExpenseAccount {
  return typeof v === "string" && (EXPENSE_ACCOUNTS as readonly string[]).includes(v);
}

/** 保存された候補 (取込書類の _accountCandidates など) を安全に読む */
export function readCandidates(raw: unknown): AccountCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: AccountCandidate[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || !isExpenseAccount(r.account)) continue;
    if (out.some((x) => x.account === r.account)) continue;
    out.push({ account: r.account, reason: typeof r.reason === "string" ? r.reason.slice(0, 120) : "", source: r.source === "rule" ? "rule" : "ai" });
  }
  return out.slice(0, 3);
}
