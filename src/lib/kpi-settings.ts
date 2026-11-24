import type { Database, QualityKind, StoreId, User } from "@/lib/db/types";

/**
 * KPI・インセンティブの設定
 * ------------------------------------------------------------
 * 既定値は「お客様アンケート集計表」の KPI シート (2025・2026 年度の評価方法) に合わせている。
 * 設定 → KPI・インセンティブ で管理者が変更し、settings テーブルの id = "kpi" に保存する。
 * 登録済みのクレーム・手直し・口コミのポイントは登録時の値を使う (ルールを変えても過去の点数は変わらない)
 */

/** [しきい値, 金額 (円)] の組。atLeast = しきい値以上で適用 (高い順に判定) / atMost = しきい値以下で適用 (低い順に判定。最後を超えたら最後の金額) */
export type Tier = [number, number];

export interface IncentiveRules {
  /** はがき返信率 (%) 以上 → 店舗の職人 1 人あたり */
  replyRate: Tier[];
  /** 返信率がこの値 (%) 未満の店舗は、はがきの項目 (返信率・②③④・関連の MVP) を支給しない */
  replyGate: number;
  /** ① 電話対応 (全社の平均) 以上 → 事務 1 人あたり */
  phone: Tier[];
  /** ② 営業対応・③ 職人対応 (本人の平均)・④ 工事仕上り (店舗の平均) 以上 → 1 人あたり */
  score: Tier[];
  /** クレーム・手直しポイント率 (%) 以下 → 店舗の職人 1 人あたり (マイナスは減額) */
  storeQuality: Tier[];
  /** 事務のクレーム・手直しポイント率 (%) 以下 → 事務 1 人あたり */
  officeQuality: Tier[];
  /** MVP (年間の累計で順位) */
  mvp: {
    /** ② 営業対応の順位 1〜3 位 */
    sales: number[];
    /** ③ 職人対応の順位 1〜3 位 */
    craftsman: number[];
    /** 返信率 1 位の店舗の職人 */
    replyTop: number;
    /** ④ 工事仕上り 1 位の店舗の職人 */
    finishTop: number;
    /** Google 口コミの件数の順位 1〜3 位 */
    reviews: number[];
    /** クレーム・手直しの件数が最も少ない単位 (店舗または事務) の全員 */
    fewestQuality: number;
    /** クレーム・手直しポイント率が最も低い店舗の職人 */
    lowestQualityRate: number;
  };
}

export interface KpiSettings {
  /** 事務担当 (① 電話対応・事務のクレーム率の支給対象) */
  clerkUserIds: string[];
  /** 集計・順位・支給から外す社員 (経営者の家族など。記録は残る) */
  excludedUserIds: string[];
  /** 店舗ごとの事務担当 (はがき登録時の ① の担当の初期値) */
  clerkByStore: Partial<Record<StoreId, string>>;
  /** クレーム・手直しのポイント */
  qualityPoints: Record<QualityKind, number>;
  /**
   * 同じ案件のクレーム・手直しのポイントの上限 (お客様のご指示 2026-11-24「同一案件で両方発生した場合：最大 3 ポイント」)。
   * 同じ案件・同じ発生月の記録の点数を足し、この点数までにする (月締めで集計。別の月の別の手直しはそれぞれ数える。0 = 上限なし)
   */
  qualityCaseMax: number;
  /** Google 口コミ 1 ポイントあたりの支給額 (円。事務の入力月で集計し、翌月末に現金で支給) */
  reviewYenPerPoint: number;
  /** 年度の開始月 (12 = 12 月 1 日〜翌年 11 月 30 日) */
  fiscalStartMonth: number;
  incentive: IncentiveRules;
}

export const KPI_SETTINGS_ID = "kpi";

export const QUALITY_KIND_LABEL: Record<QualityKind, string> = {
  rework: "手直し",
  claim: "クレーム",
  claim_rework: "クレーム＋手直し",
};

export const QUALITY_KIND_HELP: Record<QualityKind, string> = {
  rework: "納品後、現場で終わらずにやり直すこと (持ち帰る・取りに戻るなど。自分で気づいたときも、お客様に指摘されたときも)",
  claim: "納品して現場を離れた後に、お客様から指摘されること (手直しが要らなくてもクレーム)",
  claim_rework: "現場を離れた後にお客様から指摘され (電話・アンケートなど)、手直しも必要になる",
};

/**
 * 区分の判定の目安 (お客様アンケート集計表の「クレーム手直し処理オペレーション」の定義)。
 * 判断に迷うときは社長に相談する。原因が事務なら事務、店舗なら店舗、見積りなら売上の付く店舗のポイントにする
 */
export const QUALITY_JUDGE_GUIDE: { label: string; text: string }[] = [
  { label: "クレームではない", text: "納品のときに現場で対面で指摘された (持ち帰ってやり直すなら手直し 1)・見積金額の計算の誤り・お客様の落ち度 (張り替えた障子を自分で破ったなど)・施工した箇所以外のこと (= 点検)・売上のない点検だけの案件で起きたこと" },
  { label: "手直しではない", text: "工場の中での手直し・現場で直して終わったもの (時間がかかっても。予備の引手を付けたなど)・売上のない点検だけの案件で起きたこと" },
  { label: "記録だけ (集計しない)", text: "点検 DM を見ての連絡・点検の電話がきっかけで分かったもの。削減のために記録は残す (「記録のみ」にする)" },
];

export const QUALITY_CATEGORIES = ["精度", "確認不足", "説明不足", "その他"] as const;

/**
 * LINE の「クレーム・手直し報告」の文から区分の候補を読む (登録の画面の初期値。決めるのは登録する人)。
 * 「クレーム」「苦情」「お叱り」→ クレーム、「手直し」「やり直し」「直しに行く」「再施工」「持ち帰り」→ 手直し、両方 → クレーム＋手直し。
 * 「点検 DM」「点検の電話」がきっかけなら記録のみ (集計しない) の候補
 */
export function guessQualityKind(text: string | undefined): { kind?: QualityKind; recordOnly: boolean; reason?: string } {
  const t = (text ?? "").normalize("NFKC");
  const claim = /クレーム|苦情|お叱り|お怒り|ご不満|ご指摘/.test(t) && !/クレーム(では|じゃ)な|クレームとしてはカウントしない/.test(t);
  const rework = /手直し|やり直|直しに(行|伺|いき|いく)|再施工|張り直|貼り直|持ち帰|作り直|再納品|交換に(行|伺)/.test(t);
  const recordOnly = /点検\s*(DM|ＤＭ|ダイレクトメール|の?電話)/i.test(t);
  if (claim && rework) return { kind: "claim_rework", recordOnly, reason: "「クレーム」と「手直し」の言葉" };
  if (claim) return { kind: "claim", recordOnly, reason: "「クレーム」の言葉" };
  if (rework) return { kind: "rework", recordOnly, reason: "「手直し」の言葉" };
  return { recordOnly };
}

export function defaultIncentiveRules(): IncentiveRules {
  return {
    replyRate: [[60, 70000], [50, 30000], [40, 10000], [30, 0]],
    replyGate: 30,
    phone: [[4.7, 50000], [4.4, 30000], [4.0, 10000]],
    score: [[4.7, 30000], [4.4, 15000], [4.0, 5000]],
    storeQuality: [[0, 150000], [1, 50000], [2, 20000], [2.5, 0], [3, -5000], [3.5, -10000], [4, -15000], [4.5, -20000], [5, -25000], [5.5, -30000], [6, -35000], [6.5, -40000], [7, -45000], [7.5, -50000], [8, -55000], [8.5, -60000], [9, -65000], [9.5, -70000]],
    officeQuality: [[0, 50000], [1, 20000], [2, 10000], [2.5, 0], [3, -5000], [3.5, -10000]],
    mvp: { sales: [15000, 10000, 5000], craftsman: [15000, 10000, 5000], replyTop: 30000, finishTop: 20000, reviews: [30000, 15000, 10000], fewestQuality: 30000, lowestQualityRate: 30000 },
  };
}

export function defaultKpiSettings(): KpiSettings {
  return {
    clerkUserIds: [],
    excludedUserIds: [],
    clerkByStore: {},
    qualityPoints: { rework: 1, claim: 2, claim_rework: 3 },
    qualityCaseMax: 3,
    reviewYenPerPoint: 1000,
    fiscalStartMonth: 12,
    incentive: defaultIncentiveRules(),
  };
}

const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

function tiers(v: unknown, fallback: Tier[]): Tier[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((t): t is Tier => Array.isArray(t) && t.length === 2 && Number.isFinite(Number(t[0])) && Number.isFinite(Number(t[1]))).map((t) => [Number(t[0]), Number(t[1])] as Tier);
  return out.length ? out : fallback;
}

function amounts(v: unknown, fallback: number[]): number[] {
  return Array.isArray(v) && v.every((x) => Number.isFinite(Number(x))) && v.length ? v.map(Number) : fallback;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

export function kpiSettings(db: Pick<Database, "settings"> & Partial<Pick<Database, "users">>): KpiSettings {
  const d = defaultKpiSettings();
  const v = (db.settings ?? []).find((s) => s.id === KPI_SETTINGS_ID)?.value ?? {};
  const qp = (v.qualityPoints ?? {}) as Record<string, unknown>;
  const clerks = (v.clerkByStore ?? {}) as Record<string, unknown>;
  const inc = (v.incentive ?? {}) as Record<string, unknown>;
  const mvp = (inc.mvp ?? {}) as Record<string, unknown>;
  const di = d.incentive;
  // 事務担当が未設定のときは、役職に「事務」を含む社員を対象にする
  const clerkUserIds = Array.isArray(v.clerkUserIds) ? ids(v.clerkUserIds) : (db.users ?? []).filter((u) => u.active && /事務/.test(u.title ?? "")).map((u) => u.id);
  return {
    clerkUserIds,
    excludedUserIds: ids(v.excludedUserIds),
    clerkByStore: Object.fromEntries(Object.entries(clerks).filter(([, x]) => typeof x === "string" && x)) as Partial<Record<StoreId, string>>,
    qualityPoints: {
      rework: num(qp.rework, 0, 100) ?? d.qualityPoints.rework,
      claim: num(qp.claim, 0, 100) ?? d.qualityPoints.claim,
      claim_rework: num(qp.claim_rework, 0, 100) ?? d.qualityPoints.claim_rework,
    },
    qualityCaseMax: num(v.qualityCaseMax, 0, 100) ?? d.qualityCaseMax,
    reviewYenPerPoint: num(v.reviewYenPerPoint, 0, 1_000_000) ?? d.reviewYenPerPoint,
    fiscalStartMonth: Math.round(num(v.fiscalStartMonth, 1, 12) ?? d.fiscalStartMonth),
    incentive: {
      replyRate: tiers(inc.replyRate, di.replyRate),
      replyGate: num(inc.replyGate, 0, 100) ?? di.replyGate,
      phone: tiers(inc.phone, di.phone),
      score: tiers(inc.score, di.score),
      storeQuality: tiers(inc.storeQuality, di.storeQuality),
      officeQuality: tiers(inc.officeQuality, di.officeQuality),
      mvp: {
        sales: amounts(mvp.sales, di.mvp.sales),
        craftsman: amounts(mvp.craftsman, di.mvp.craftsman),
        replyTop: num(mvp.replyTop, -1e7, 1e7) ?? di.mvp.replyTop,
        finishTop: num(mvp.finishTop, -1e7, 1e7) ?? di.mvp.finishTop,
        reviews: amounts(mvp.reviews, di.mvp.reviews),
        fewestQuality: num(mvp.fewestQuality, -1e7, 1e7) ?? di.mvp.fewestQuality,
        lowestQualityRate: num(mvp.lowestQualityRate, -1e7, 1e7) ?? di.mvp.lowestQualityRate,
      },
    },
  };
}

/** 「60:70000, 50:30000」の形 ⇔ Tier[] (設定画面の入力欄) */
export function formatTiers(t: Tier[]): string {
  return t.map(([a, b]) => `${a}:${b}`).join(", ");
}
export function parseTiers(text: string): Tier[] | null {
  const parts = text.normalize("NFKC").split(/[,、\n]+/).map((x) => x.trim()).filter(Boolean);
  const out: Tier[] = [];
  for (const p of parts) {
    const m = p.replace(/[円\s]/g, "").match(/^(-?\d+(?:\.\d+)?)%?[:：→](-?[\d]+(?:\.\d+)?)(万)?$/);
    if (!m) return null;
    out.push([Number(m[1]), Math.round(Number(m[2]) * (m[3] ? 10000 : 1))]);
  }
  return out.length ? out : null;
}

/** しきい値以上で決まる金額 (高い順に判定)。どれにも当たらなければ 0 */
export function tierAtLeast(value: number | null, t: Tier[]): number {
  if (value === null) return 0;
  const sorted = [...t].sort((a, b) => b[0] - a[0]);
  return sorted.find(([th]) => value >= th - 1e-9)?.[1] ?? 0;
}

/** しきい値以下で決まる金額 (低い順に判定)。最後のしきい値を超えたら最後の金額 */
export function tierAtMost(value: number | null, t: Tier[]): number {
  if (value === null || !t.length) return 0;
  const sorted = [...t].sort((a, b) => a[0] - b[0]);
  return sorted.find(([th]) => value <= th + 1e-9)?.[1] ?? sorted[sorted.length - 1][1];
}

/** 同じ案件のポイントの上限 (KPI の集計・インセンティブで共通。settings がなければ既定) */
export function qualityCaseMax(db: Partial<Pick<Database, "settings">>): number {
  return kpiSettings({ settings: db.settings ?? [] }).qualityCaseMax;
}

/** 支給の対象か (無効・除外の社員を除く) */
export function isPayable(u: Pick<User, "id" | "active">, s: KpiSettings): boolean {
  return u.active && !s.excludedUserIds.includes(u.id);
}

/** 日付 (YYYY-MM-DD) が属する年度。年度は開始月の 1 日から 12 か月 (例: 12 月始まり → 2025-12-01〜2026-11-30 が「2026 年度」) */
export function fiscalYearOf(date: string, startMonth: number): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (startMonth === 1) return y;
  return m >= startMonth ? y + 1 : y;
}

export function fiscalRange(fy: number, startMonth: number): { from: string; to: string } {
  if (startMonth === 1) return { from: `${fy}-01-01`, to: `${fy}-12-31` };
  const from = `${fy - 1}-${String(startMonth).padStart(2, "0")}-01`;
  const endMonth = startMonth - 1;
  const lastDay = new Date(Date.UTC(fy, endMonth, 0)).getUTCDate();
  return { from, to: `${fy}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` };
}
