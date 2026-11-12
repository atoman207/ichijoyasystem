import type { Product, Store, Supplier, User } from "./types";

/**
 * マスタデータ (店舗・ユーザー・商品・仕入先)
 * 店舗情報は https://ichijoya.co.jp/about/ の会社概要に基づく。
 * ユーザーはすべてデモ用の架空の人物。
 */

export const DEMO_PASSWORD = "demo1234";

export const STORES: Store[] = [
  {
    id: "koshi",
    code: "KS",
    name: "合志店",
    shortName: "合志",
    kind: "store",
    postalCode: "861-1113",
    address: "熊本県合志市栄3415-11 栄工業団地内",
    phone: "096-348-3176",
    managerUserId: "u02",
    color: "#2a78d6",
  },
  {
    id: "chuo",
    code: "CH",
    name: "中央店",
    shortName: "中央",
    kind: "store",
    postalCode: "862-0926",
    address: "熊本県熊本市東区保田窪2-1-21",
    phone: "096-380-0002",
    managerUserId: "u03",
    color: "#eb6834",
  },
  {
    id: "nishi",
    code: "NS",
    name: "西店",
    shortName: "西",
    kind: "store",
    postalCode: "861-4101",
    address: "熊本県熊本市南区近見1-1-5",
    phone: "096-320-0003",
    managerUserId: "u04",
    color: "#1baf7a",
  },
  {
    id: "tamana",
    code: "TM",
    name: "玉名店",
    shortName: "玉名",
    kind: "store",
    postalCode: "865-0023",
    address: "熊本県玉名市大倉750-8",
    phone: "0968-70-0004",
    managerUserId: "u05",
    color: "#eda100",
  },
  {
    id: "hq",
    code: "HQ",
    name: "本社・坪井ショールーム",
    shortName: "本社",
    kind: "hq",
    postalCode: "860-0863",
    address: "熊本県熊本市中央区坪井5丁目2-27",
    phone: "0120-158-108",
    managerUserId: "u01",
    color: "#e87ba4",
  },
];

export const USERS: User[] = [
  { id: "u01", name: "山田 太郎", kana: "ヤマダ タロウ", email: "yamada@ichijoya.example", password: DEMO_PASSWORD, role: "admin", storeId: "hq", title: "代表取締役 (システム管理者)", phone: "090-0000-0001", active: true },
  { id: "u02", name: "田中 健一", kana: "タナカ ケンイチ", email: "tanaka@ichijoya.example", password: DEMO_PASSWORD, role: "store_manager", storeId: "koshi", title: "合志店 店長", phone: "090-0000-0002", active: true },
  { id: "u03", name: "佐藤 美咲", kana: "サトウ ミサキ", email: "sato@ichijoya.example", password: DEMO_PASSWORD, role: "store_manager", storeId: "chuo", title: "中央店 店長", phone: "090-0000-0003", active: true },
  { id: "u04", name: "鈴木 大輔", kana: "スズキ ダイスケ", email: "suzuki@ichijoya.example", password: DEMO_PASSWORD, role: "store_manager", storeId: "nishi", title: "西店 店長", phone: "090-0000-0004", active: true },
  { id: "u05", name: "高橋 直樹", kana: "タカハシ ナオキ", email: "takahashi@ichijoya.example", password: DEMO_PASSWORD, role: "store_manager", storeId: "tamana", title: "玉名店 店長", phone: "090-0000-0005", active: true },
  { id: "u06", name: "中村 花子", kana: "ナカムラ ハナコ", email: "nakamura@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "koshi", title: "合志店 営業・受付", phone: "090-0000-0006", active: true },
  { id: "u07", name: "小林 翔太", kana: "コバヤシ ショウタ", email: "kobayashi@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "koshi", title: "合志店 施工担当 (畳職人)", phone: "090-0000-0007", active: true },
  { id: "u08", name: "加藤 由美", kana: "カトウ ユミ", email: "kato@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "chuo", title: "中央店 営業・受付", phone: "090-0000-0008", active: true },
  { id: "u09", name: "渡辺 拓也", kana: "ワタナベ タクヤ", email: "watanabe@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "chuo", title: "中央店 施工担当", phone: "090-0000-0009", active: true },
  { id: "u10", name: "伊藤 さくら", kana: "イトウ サクラ", email: "ito@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "nishi", title: "西店 営業・受付", phone: "090-0000-0010", active: true },
  { id: "u11", name: "松本 隆", kana: "マツモト タカシ", email: "matsumoto@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "nishi", title: "西店 施工担当", phone: "090-0000-0011", active: true },
  { id: "u12", name: "木村 彩", kana: "キムラ アヤ", email: "kimura@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "tamana", title: "玉名店 営業・受付", phone: "090-0000-0012", active: true },
  { id: "u13", name: "林 大地", kana: "ハヤシ ダイチ", email: "hayashi@ichijoya.example", password: DEMO_PASSWORD, role: "store_staff", storeId: "tamana", title: "玉名店 施工担当", phone: "090-0000-0013", active: true },
  { id: "u14", name: "山本 恵", kana: "ヤマモト メグミ", email: "yamamoto@ichijoya.example", password: DEMO_PASSWORD, role: "hq_staff", storeId: "hq", title: "本部 経理担当", phone: "090-0000-0014", active: true },
  { id: "u15", name: "井上 誠", kana: "イノウエ マコト", email: "inoue@ichijoya.example", password: DEMO_PASSWORD, role: "hq_staff", storeId: "hq", title: "本部 総務・ショールーム受付", phone: "090-0000-0015", active: true },
];

/** 店舗ごとの営業担当 / 施工担当 */
export const SALES_BY_STORE: Record<string, string> = {
  koshi: "u06",
  chuo: "u08",
  nishi: "u10",
  tamana: "u12",
  hq: "u15",
};

export const WORKER_BY_STORE: Record<string, string> = {
  koshi: "u07",
  chuo: "u09",
  nishi: "u11",
  tamana: "u13",
  hq: "u07",
};

/**
 * 商品マスタ
 * 単価は税抜。Web サイト掲載の税込価格 (例: 古都 27,500円) は単価×1.1 に一致する。
 */
export const PRODUCTS: Product[] = [
  // 畳 (1畳あたり・工賃配送込)
  { id: "p_t_kiwami", category: "tatami", name: "畳表替え 極み", grade: "熊本産 最高級", unit: "畳", unitPrice: 40000, description: "こだわりの最高級熊本産い草", active: true },
  { id: "p_t_koto", category: "tatami", name: "畳表替え 古都", grade: "熊本産 上級", unit: "畳", unitPrice: 25000, description: "おすすめ", active: true },
  { id: "p_t_sakura", category: "tatami", name: "畳表替え さくら", grade: "熊本産 ひのみどり", unit: "畳", unitPrice: 18000, description: "おすすめ", active: true },
  { id: "p_t_yasuragi", category: "tatami", name: "畳表替え やすらぎ", grade: "熊本産", unit: "畳", unitPrice: 15000, description: "おすすめ", active: true },
  { id: "p_t_kizuna", category: "tatami", name: "畳表替え きずな", grade: "熊本産", unit: "畳", unitPrice: 12000, description: "おすすめ", active: true },
  { id: "p_t_nagomi", category: "tatami", name: "畳表替え なごみ", grade: "熊本産 中級", unit: "畳", unitPrice: 10000, description: "おてごろ", active: true },
  { id: "p_t_megumi", category: "tatami", name: "畳表替え めぐみ", grade: "中国産 上級", unit: "畳", unitPrice: 8000, description: "おてごろ", active: true },
  { id: "p_t_herinashi", category: "tatami", name: "へり無し畳 新調 (琉球畳風)", grade: "半畳", unit: "枚", unitPrice: 13000, sizeLabel: "半畳", description: "和紙・樹脂表も選択可", active: true },
  { id: "p_t_shincho", category: "tatami", name: "畳 新調 (畳床込)", grade: "熊本産", unit: "畳", unitPrice: 32000, description: "新築・畳床交換", active: true },
  { id: "p_t_disposal", category: "tatami", name: "古畳 引取・処分", unit: "畳", unitPrice: 1000, active: true },
  // 襖 (片面1枚)
  { id: "p_f_torinoko", category: "fusuma", name: "襖張替え 最高級鳥の子和紙", grade: "こだわり", unit: "面", unitPrice: 14000, active: true },
  { id: "p_f_suzaku", category: "fusuma", name: "襖張替え 朱雀", grade: "高級糸入り (全28柄)", unit: "面", unitPrice: 12000, active: true },
  { id: "p_f_chidori", category: "fusuma", name: "襖張替え ちどり", grade: "柿渋・消臭抗菌 (全32柄)", unit: "面", unitPrice: 9000, active: true },
  { id: "p_f_nozomi", category: "fusuma", name: "襖張替え のぞみ", grade: "糸入り (全37柄)", unit: "面", unitPrice: 7000, active: true },
  { id: "p_f_shizuka", category: "fusuma", name: "襖張替え しずか", grade: "プリント紙 (全30柄)", unit: "面", unitPrice: 5000, active: true },
  // 障子 (大 185×92cm / 中 120×92cm / 小 50×92cm)
  { id: "p_s_eco_l", category: "shoji", name: "障子張替え エコノミー", unit: "枚", unitPrice: 3000, sizeLabel: "大", active: true },
  { id: "p_s_eco_m", category: "shoji", name: "障子張替え エコノミー", unit: "枚", unitPrice: 2500, sizeLabel: "中", active: true },
  { id: "p_s_eco_s", category: "shoji", name: "障子張替え エコノミー", unit: "枚", unitPrice: 1500, sizeLabel: "小", active: true },
  { id: "p_s_strike_l", category: "shoji", name: "障子張替え ストライク", unit: "枚", unitPrice: 4000, sizeLabel: "大", active: true },
  { id: "p_s_strike_m", category: "shoji", name: "障子張替え ストライク", unit: "枚", unitPrice: 3000, sizeLabel: "中", active: true },
  { id: "p_s_puraka_l", category: "shoji", name: "障子張替え プラカ 無地", unit: "枚", unitPrice: 6000, sizeLabel: "大", active: true },
  { id: "p_s_puraka_m", category: "shoji", name: "障子張替え プラカ 無地", unit: "枚", unitPrice: 5000, sizeLabel: "中", active: true },
  { id: "p_s_warlon_l", category: "shoji", name: "障子張替え ワーロン柄入り", unit: "枚", unitPrice: 10000, sizeLabel: "大", active: true },
  { id: "p_s_warlon_m", category: "shoji", name: "障子張替え ワーロン柄入り", unit: "枚", unitPrice: 8000, sizeLabel: "中", active: true },
  // アミ戸
  { id: "p_a_18_l", category: "amido", name: "網戸張替え 18メッシュ", unit: "枚", unitPrice: 3000, sizeLabel: "大", active: true },
  { id: "p_a_18_m", category: "amido", name: "網戸張替え 18メッシュ", unit: "枚", unitPrice: 2500, sizeLabel: "中", active: true },
  { id: "p_a_24_l", category: "amido", name: "網戸張替え 24メッシュ", unit: "枚", unitPrice: 4000, sizeLabel: "大", active: true },
  { id: "p_a_24_m", category: "amido", name: "網戸張替え 24メッシュ", unit: "枚", unitPrice: 3000, sizeLabel: "中", active: true },
  { id: "p_a_bug_l", category: "amido", name: "網戸張替え 虫が嫌がる網", unit: "枚", unitPrice: 6000, sizeLabel: "大", active: true },
  { id: "p_a_pet_l", category: "amido", name: "網戸張替え ペットディフェンス", unit: "枚", unitPrice: 12000, sizeLabel: "大", active: true },
  { id: "p_a_pet_m", category: "amido", name: "網戸張替え ペットディフェンス", unit: "枚", unitPrice: 9000, sizeLabel: "中", active: true },
  // 窓周り・クロス
  { id: "p_c_curtain", category: "curtain", name: "オーダーカーテン (ドレープ+レース)", unit: "窓", unitPrice: 25000, active: true },
  { id: "p_c_blind", category: "curtain", name: "アルミブラインド", unit: "窓", unitPrice: 18000, active: true },
  { id: "p_w_cloth", category: "cloth", name: "クロス張替え (量産品)", unit: "㎡", unitPrice: 1200, active: true },
  // 共通
  { id: "p_misc", category: "other", name: "諸経費 (一式)", unit: "式", unitPrice: 3000, active: true },
];

export const SUPPLIERS: Supplier[] = [
  { id: "s01", name: "熊本県い草生産者協同組合", category: "い草・畳表", phone: "0965-00-0001", email: "order@igusa.example", paymentTerms: "月末締め 翌月末払い", closingDay: 31 },
  { id: "s02", name: "九州畳材 株式会社", category: "畳床・畳縁", phone: "096-000-0002", email: "sales@kyushu-tatami.example", paymentTerms: "月末締め 翌月末払い", closingDay: 31 },
  { id: "s03", name: "和紙工房 ふすま堂", category: "襖紙・障子紙", phone: "096-000-0003", paymentTerms: "20日締め 翌月15日払い", closingDay: 20 },
  { id: "s04", name: "ホームセンター アグリ 合志店", category: "消耗品・工具", phone: "096-000-0004", paymentTerms: "都度払い", closingDay: 31 },
  { id: "s05", name: "熊本運輸サービス", category: "配送・引取", phone: "096-000-0005", paymentTerms: "月末締め 翌月末払い", closingDay: 31 },
  { id: "s06", name: "西日本インテリア商会", category: "カーテン・ブラインド", phone: "092-000-0006", paymentTerms: "月末締め 翌々月10日払い", closingDay: 31 },
];
