import type { Customer, Database, StoreId } from "@/lib/db/types";
import type { ItemFact, OrderFact } from "@/lib/assistant/facts";

/**
 * 販促の商品の KPI (スプレッドシート「販促」の「2025年度2026年度販促計画」の KPI の表と「畳表出数表」をシステムで集計)
 * ------------------------------------------------------------
 * お客様のご要望 (■7「販促についても独自の KPI を設定して管理…将来的には新システムで集計できれば」)。経営分析用 (インセンティブに入れない)。
 * - 年度 = 7 月〜翌 6 月 (年間チラシ計画・販促計画と同じ。「2026年度」= 2026-07〜2027-06)。設定 promo_kpi の fyStartMonth
 * - 個人のお客様の受注 (顧客の種類が法人でない) を売上計上日 (施工完了) の月で数える。明細は 売上の分析 (src/lib/assistant/facts.ts) と同じ
 *   (移行した受注 = 売上台帳の経過メモの明細、新システム = 見積・請求書の明細。金額は税込)
 * - 畳・襖・障子・網戸: 売上 (税込) = その品目の明細の合計 (縁・防虫加工・引手などの付属を含む)、
 *   枚数 = 本体の明細の数量 (付属を除く)、平均単価 (税抜) = 売上 ÷ 枚数 ÷ 1.1 (シートの「売上/枚数/1.1」)
 * - 畳表・襖紙の内訳 (件数ベース): 受注ごとに一番枚数の多い種類 (キーワード) の列で 1 件
 * - マイトスタット (防虫加工): 防虫の明細のある受注の件数と枚数
 * - 10 万円以上のリフォーム: クロス・雑工事 (諸経費を除く) の金額が 10 万円以上の受注の件数と、その金額
 * - 畳表の出数: 畳表の種類ごとの枚数 (11 月〜翌 10 月。全てのお客様)
 * 種類の名前・キーワードは設定 (販促と媒体の分析 → 商品の KPI、本部・管理者) で変えられる。単価・原価はコードに書かない
 * このファイルは画面・CSV・テストで共通に使う (サーバー専用の import をしない)
 */

export const PROMO_KPI_SETTINGS_ID = "promo_kpi";
export const PROMO_GBP_SETTINGS_ID = "promo_gbp";

export interface GradeRule {
  /** 種類の名前 (列の名前) */
  label: string;
  /** 品名・仕様に含まれる言葉 (どれか 1 つ) */
  keywords: string[];
  /** 件数ベースの表の列 (畳表: なごみ・きずな・…・めぐみ以下・ヘリ付き化学表)。なし = 種類の名前 */
  group?: string;
}

export interface PromoKpiSettings {
  /** 年度の開始月 (7 = 7 月〜翌 6 月) */
  fyStartMonth: number;
  /** 畳表の種類 (上から順に照合)。出数表の列 */
  omote: GradeRule[];
  /** 襖紙の種類 (上から順に照合) */
  fusuma: GradeRule[];
  /** 付属 (枚数に数えない明細) の言葉 */
  accessory: string[];
  /** ヘリ無し (全ヘリ無しの列) の言葉 */
  heriNashi: string[];
  /** 防虫加工 (マイトスタット) の言葉 */
  mite: string[];
  /** リフォームの金額の下限 (円・税込) */
  reformMin: number;
  /** 国産の畳表の種類 (出数表の「国産」の割合) */
  domestic: string[];
}

export const DEFAULT_PROMO_KPI: PromoKpiSettings = {
  fyStartMonth: 7,
  // 販促の「畳表出数表」の列 (上から順に照合)。件数ベースの列 (販促計画の KPI) は group
  omote: [
    { label: "極み", keywords: ["極み"], group: "極み" },
    { label: "古都", keywords: ["古都"], group: "古都" },
    { label: "さくら", keywords: ["さくら"], group: "さくら" },
    { label: "やすらぎ", keywords: ["やすらぎ"], group: "やすらぎ" },
    { label: "一畳屋", keywords: ["一畳屋"], group: "その他" },
    { label: "きずな", keywords: ["きずな"], group: "きずな" },
    { label: "なごみ", keywords: ["なごみ"], group: "なごみ" },
    { label: "国産目積", keywords: ["目積"], group: "その他" },
    { label: "めぐみ", keywords: ["めぐみ"], group: "めぐみ以下" },
    { label: "格安", keywords: ["格安", "借家", "団地"], group: "めぐみ以下" },
    { label: "樹脂", keywords: ["樹脂", "化学表", "美草", "MIGUSA", "ダイケン", "セキスイ"], group: "ヘリ付き化学表" },
    { label: "和紙", keywords: ["和紙", "清流", "カクテル"], group: "ヘリ付き化学表" },
    // 「中国産」は「国産」を含むため、その他国産より先に照合する
    { label: "その他中国産", keywords: ["中国産"], group: "めぐみ以下" },
    { label: "その他国産", keywords: ["国産", "八代産", "熊本県産", "熊本産", "JAS"], group: "その他" },
  ],
  // 販促計画の「〇〇系」(同じ価格帯。のぞみ系は凛を含む)
  fusuma: [
    { label: "しずか系", keywords: ["しずか"] },
    { label: "のぞみ系", keywords: ["のぞみ", "凛"] },
    { label: "ちどり系", keywords: ["ちどり"] },
    { label: "朱雀系", keywords: ["朱雀"] },
    { label: "鳥の子系", keywords: ["鳥の子"] },
  ],
  accessory: ["縁", "ヘリ代", "防虫", "マイト", "加工", "乾燥", "処分", "引手", "引き手", "取手", "戸車", "下地", "補修", "シール", "スベル", "交換", "ローラー", "その他", "製造費", "割付", "胴張", "ベニア", "枠", "レール", "カギ", "敷居", "運搬", "出張", "諸経費"],
  heriNashi: ["ヘリ無", "へり無", "縁無", "縁なし", "ヘリなし", "琉球"],
  mite: ["防虫", "マイト"],
  reformMin: 100000,
  domestic: ["極み", "古都", "さくら", "やすらぎ", "一畳屋", "きずな", "なごみ", "国産目積", "その他国産"],
};

/** 畳表の件数ベースの列 (販促計画の KPI の表の並び) */
export const OMOTE_GROUPS = ["なごみ", "きずな", "やすらぎ", "さくら", "古都", "極み", "めぐみ以下", "ヘリ付き化学表", "全ヘリ無し", "その他"] as const;

const words = (v: unknown, fallback: string[]): string[] => (Array.isArray(v) ? v.map((x) => String(x).normalize("NFKC").trim()).filter(Boolean).slice(0, 60) : fallback);

function rules(v: unknown, fallback: GradeRule[]): GradeRule[] {
  if (!Array.isArray(v)) return fallback;
  const out = v
    .map((x) => x as { label?: unknown; keywords?: unknown; group?: unknown })
    .filter((x) => typeof x.label === "string" && x.label.trim())
    .map((x) => ({ label: String(x.label).normalize("NFKC").trim().slice(0, 20), keywords: words(x.keywords, []), group: typeof x.group === "string" && x.group.trim() ? x.group.normalize("NFKC").trim().slice(0, 20) : undefined }))
    .filter((x) => x.keywords.length);
  return out.length ? out.slice(0, 40) : fallback;
}

export function promoKpiSettings(db: Pick<Database, "settings">): PromoKpiSettings {
  const v = ((db.settings ?? []).find((s) => s.id === PROMO_KPI_SETTINGS_ID)?.value ?? {}) as Record<string, unknown>;
  const d = DEFAULT_PROMO_KPI;
  const m = Number(v.fyStartMonth);
  const min = Number(v.reformMin);
  return {
    fyStartMonth: Number.isInteger(m) && m >= 1 && m <= 12 ? m : d.fyStartMonth,
    omote: rules(v.omote, d.omote),
    fusuma: rules(v.fusuma, d.fusuma),
    accessory: words(v.accessory, d.accessory),
    heriNashi: words(v.heriNashi, d.heriNashi),
    mite: words(v.mite, d.mite),
    reformMin: Number.isFinite(min) && min >= 0 ? Math.round(min) : d.reformMin,
    domestic: words(v.domestic, d.domestic),
  };
}

/** 種類の設定の入力欄「名前: 言葉, 言葉 → 列」(1 行に 1 つ) ⇔ GradeRule[] */
export function formatRules(list: GradeRule[]): string {
  return list.map((r) => `${r.label}: ${r.keywords.join(", ")}${r.group && r.group !== r.label ? ` → ${r.group}` : ""}`).join("\n");
}
export function parseRules(text: string): GradeRule[] | { error: string } {
  const out: GradeRule[] = [];
  for (const line of text.normalize("NFKC").split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    const m = line.match(/^([^:]+?)\s*:\s*(.+?)(?:\s*(?:→|->)\s*(.+))?$/);
    if (!m) return { error: `「${line}」は「名前: 言葉, 言葉 → 列」の形で入力してください` };
    const keywords = m[2].split(/[,、]+/).map((x) => x.trim()).filter(Boolean);
    if (!keywords.length) return { error: `「${line}」に言葉がありません` };
    out.push({ label: m[1].trim().slice(0, 20), keywords, group: m[3]?.trim().slice(0, 20) || undefined });
  }
  return out.length ? out : { error: "種類を 1 つ以上入力してください" };
}

/** 年度の月 (開始月から 12 か月) */
export function promoFyMonths(fy: number, startMonth: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m0 = startMonth - 1 + i;
    const y = startMonth === 1 ? fy : fy + Math.floor(m0 / 12);
    out.push(`${y}-${String((m0 % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** 日付の属する販促の年度 (7 月始まり: 2026-07-01〜2027-06-30 = 2026 年度) */
export const promoFyOf = (date: string, startMonth: number): number => {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return startMonth === 1 || m >= startMonth ? y : y - 1;
};

export const PRODUCT_CATS = ["tatami", "fusuma", "shoji", "amido"] as const;
export type ProductCat = (typeof PRODUCT_CATS)[number];
export const PRODUCT_LABEL: Record<ProductCat, string> = { tatami: "畳", fusuma: "襖", shoji: "障子", amido: "網戸" };

export interface CatCell {
  /** 売上 (税込) */
  sales: number;
  /** 枚数 (本体の明細の数量) */
  qty: number;
  /** 平均単価 (税抜) = 売上 ÷ 枚数 ÷ 1.1 */
  unitPrice: number | null;
}

export interface ProductMonth {
  month: string;
  cats: Record<ProductCat, CatCell>;
  /** 畳表の件数ベース (列 → 件数) */
  omote: Record<string, number>;
  /** 襖紙の件数ベース */
  fusuma: Record<string, number>;
  mite: { orders: number; qty: number };
  reform: { orders: number; sales: number };
  /** 個人のお客様の受注 (明細のあるもの) */
  orders: number;
}

export interface ProductKpi {
  storeId: StoreId | "all";
  months: ProductMonth[];
  total: ProductMonth;
}

const lineName = (i: Pick<ItemFact, "product">) => i.product.replace(/^(畳|襖|障子|網戸)\s*/, "").normalize("NFKC");
const hasAny = (text: string, list: string[]) => list.some((w) => w && text.includes(w));
const emptyCell = (): CatCell => ({ sales: 0, qty: 0, unitPrice: null });
const emptyMonth = (month: string): ProductMonth => ({ month, cats: { tatami: emptyCell(), fusuma: emptyCell(), shoji: emptyCell(), amido: emptyCell() }, omote: {}, fusuma: {}, mite: { orders: 0, qty: 0 }, reform: { orders: 0, sales: 0 }, orders: 0 });

/** 明細の畳表の種類 (出数表の列)。当たらなければ undefined */
export function omoteGrade(i: Pick<ItemFact, "product">, s: PromoKpiSettings): GradeRule | undefined {
  const t = lineName(i);
  return s.omote.find((r) => hasAny(t, r.keywords));
}

/** 本体の明細か (付属 = 縁・防虫加工・引手などは枚数に数えない) */
export function isMainLine(i: Pick<ItemFact, "product" | "qty">, s: PromoKpiSettings): boolean {
  return i.qty > 0 && !hasAny(lineName(i), s.accessory);
}

/** 受注 1 件の商品の KPI (個人のお客様の受注だけを呼ぶ) */
function addOrder(m: ProductMonth, f: Pick<OrderFact, "items">, s: PromoKpiSettings): void {
  let any = false;
  const omoteQty = new Map<string, number>();
  let heriAll = true;
  let heriMain = 0;
  const fusumaQty = new Map<string, number>();
  let miteQty = 0;
  let reform = 0;
  for (const i of f.items) {
    const t = lineName(i);
    if ((PRODUCT_CATS as readonly string[]).includes(i.cat)) {
      const c = m.cats[i.cat as ProductCat];
      c.sales += i.amount;
      any = true;
      if (isMainLine(i, s)) {
        c.qty += i.qty;
        if (i.cat === "tatami") {
          heriMain++;
          const heri = hasAny(t, s.heriNashi);
          if (!heri) heriAll = false;
          const g = omoteGrade(i, s);
          const col = heri ? "全ヘリ無し" : (g?.group ?? g?.label ?? "その他");
          omoteQty.set(col, (omoteQty.get(col) ?? 0) + i.qty);
        } else if (i.cat === "fusuma") {
          const g = s.fusuma.find((r) => hasAny(t, r.keywords));
          const col = g?.label ?? "その他";
          fusumaQty.set(col, (fusumaQty.get(col) ?? 0) + i.qty);
        }
      }
    }
    if (hasAny(t, s.mite) && i.qty > 0) miteQty += i.qty;
    if ((i.cat === "cloth" || i.cat === "misc") && !/諸経費|出張|運搬|処分/.test(t)) reform += i.amount;
  }
  // 件数ベース: 受注ごとに一番枚数の多い種類で 1 件 (全部ヘリ無しの受注は「全ヘリ無し」)
  const top = (q: Map<string, number>) => [...q].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (heriMain > 0) {
    const col = heriAll ? "全ヘリ無し" : top(new Map([...omoteQty].filter(([k]) => k !== "全ヘリ無し"))) ?? "その他";
    m.omote[col] = (m.omote[col] ?? 0) + 1;
  }
  const fz = top(fusumaQty);
  if (fz) m.fusuma[fz] = (m.fusuma[fz] ?? 0) + 1;
  if (miteQty > 0) {
    m.mite.orders++;
    m.mite.qty += miteQty;
  }
  if (reform >= s.reformMin) {
    m.reform.orders++;
    m.reform.sales += reform;
  }
  if (any) m.orders++;
}

function finish(m: ProductMonth): ProductMonth {
  for (const c of PRODUCT_CATS) {
    const x = m.cats[c];
    x.unitPrice = x.qty > 0 ? Math.round(x.sales / x.qty / 1.1) : null;
  }
  return m;
}

function sumMonths(month: string, list: ProductMonth[]): ProductMonth {
  const t = emptyMonth(month);
  for (const m of list) {
    for (const c of PRODUCT_CATS) {
      t.cats[c].sales += m.cats[c].sales;
      t.cats[c].qty += m.cats[c].qty;
    }
    for (const [k, v] of Object.entries(m.omote)) t.omote[k] = (t.omote[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.fusuma)) t.fusuma[k] = (t.fusuma[k] ?? 0) + v;
    t.mite.orders += m.mite.orders;
    t.mite.qty += m.mite.qty;
    t.reform.orders += m.reform.orders;
    t.reform.sales += m.reform.sales;
    t.orders += m.orders;
  }
  return finish(t);
}

/**
 * 店舗ごと (+ 全店) の月別の商品の KPI。facts = 売上の分析用データ (salesFacts)。今日より後の月は空
 */
export function productKpis(facts: OrderFact[], customers: Map<string, Pick<Customer, "type">>, storeIds: StoreId[], months: string[], s: PromoKpiSettings): ProductKpi[] {
  const first = months[0];
  const last = months[months.length - 1];
  const cells = new Map<string, ProductMonth>();
  const cell = (storeId: string, month: string) => {
    const k = `${storeId}|${month}`;
    let m = cells.get(k);
    if (!m) cells.set(k, (m = emptyMonth(month)));
    return m;
  };
  const stores = new Set<string>(storeIds);
  for (const f of facts) {
    const month = f.salesDate?.slice(0, 7);
    if (!month || month < first || month > last || !stores.has(f.storeId) || f.status === "cancelled") continue;
    if (customers.get(f.customerId)?.type === "corporate") continue;
    addOrder(cell(f.storeId, month), f, s);
  }
  const out: ProductKpi[] = storeIds.map((storeId) => {
    const ms = months.map((month) => finish(cells.get(`${storeId}|${month}`) ?? emptyMonth(month)));
    return { storeId, months: ms, total: sumMonths("total", ms) };
  });
  if (storeIds.length > 1) {
    const ms = months.map((month) => sumMonths(month, out.map((k) => k.months.find((m) => m.month === month)!)));
    out.push({ storeId: "all", months: ms, total: sumMonths("total", ms) });
  }
  return out;
}

/** 畳表の出数 (種類ごとの枚数。全てのお客様・全店舗、期間 = from〜to の売上計上日) */
export function omoteCounts(facts: OrderFact[], from: string, to: string, s: PromoKpiSettings, storeIds?: StoreId[]): { label: string; qty: number }[] {
  const stores = storeIds ? new Set<string>(storeIds) : undefined;
  const by = new Map<string, number>();
  for (const f of facts) {
    const d = f.salesDate ?? "";
    if (!d || d < from || d > to || f.status === "cancelled" || (stores && !stores.has(f.storeId))) continue;
    for (const i of f.items) {
      if (i.cat !== "tatami" || !isMainLine(i, s)) continue;
      const g = omoteGrade(i, s);
      const k = g?.label ?? "その他";
      by.set(k, (by.get(k) ?? 0) + i.qty);
    }
  }
  const order = [...s.omote.map((r) => r.label), "その他"];
  return order.filter((k, i) => order.indexOf(k) === i).map((label) => ({ label, qty: Math.round((by.get(label) ?? 0) * 10) / 10 })).filter((x) => x.qty > 0 || x.label !== "その他");
}

/* ------------------------------------------------------------------ */
/* Google ビジネスプロフィール (通話・ウェブサイトへのアクセス・プロフィール閲覧)  */
/* ------------------------------------------------------------------ */

export type GbpMetric = "calls" | "web" | "views";
export const GBP_LABEL: Record<GbpMetric, string> = { calls: "通話", web: "ウェブサイトへのアクセス", views: "プロフィール閲覧" };
export type GbpValues = Partial<Record<GbpMetric, number>>;

/** 店舗 × 月 → 値 (キー `${店舗}|${YYYY-MM}`) */
export function readGbp(db: Pick<Database, "settings">): Record<string, GbpValues> {
  const v = ((db.settings ?? []).find((s) => s.id === PROMO_GBP_SETTINGS_ID)?.value ?? {}) as { months?: Record<string, GbpValues> };
  const out: Record<string, GbpValues> = {};
  for (const [k, x] of Object.entries(v.months ?? {})) {
    if (!/^[a-z0-9_-]+\|\d{4}-\d{2}$/.test(k) || !x || typeof x !== "object") continue;
    const e: GbpValues = {};
    for (const m of ["calls", "web", "views"] as GbpMetric[]) {
      const n = Number(x[m]);
      if (Number.isFinite(n) && n >= 0) e[m] = Math.round(n);
    }
    if (Object.keys(e).length) out[k] = e;
  }
  return out;
}

/**
 * スプレッドシート「販促」の「グーグルアクセス」のタブ (CSV) → 店舗 × 月の値。
 * 年の見出し「2026年」→ 表の見出し「通話 | ウェブサイトへのアクセス | プロフィール閲覧」(横に並ぶ) → 月の列「1月〜12月」、行 = 店舗 (SR = 本部・ショールーム)
 */
export function parseGbpSheet(rows: string[][], storeOf: (label: string) => StoreId | undefined): { values: { storeId: StoreId; month: string; metric: GbpMetric; value: number }[]; problems: string[] } {
  const values: { storeId: StoreId; month: string; metric: GbpMetric; value: number }[] = [];
  const problems: string[] = [];
  const nk = (v: unknown) => String(v ?? "").normalize("NFKC").replace(/\s+/g, "");
  let year: number | undefined;
  let metricAt: { col: number; metric: GbpMetric }[] = [];
  let monthCols: { col: number; month: number; metric: GbpMetric; labelCol: number }[] = [];
  for (const row of rows) {
    const c0 = nk(row[0]);
    const y = c0.match(/^(20\d\d)年$/);
    if (y) {
      year = Number(y[1]);
      metricAt = [];
      monthCols = [];
      continue;
    }
    // 表の名前の行 (通話・ウェブサイト・プロフィール)
    const names: { col: number; metric: GbpMetric }[] = [];
    row.forEach((v, col) => {
      const t = nk(v);
      if (t === "通話") names.push({ col, metric: "calls" });
      else if (/^ウェブサイト/.test(t)) names.push({ col, metric: "web" });
      else if (/^プロフィール/.test(t)) names.push({ col, metric: "views" });
    });
    if (names.length) {
      metricAt = names;
      monthCols = [];
      continue;
    }
    // 月の見出しの行
    const ms: { col: number; month: number; metric: GbpMetric; labelCol: number }[] = [];
    row.forEach((v, col) => {
      const m = nk(v).match(/^(\d{1,2})月$/);
      if (!m || !metricAt.length) return;
      const owner = [...metricAt].reverse().find((x) => x.col <= col);
      // 店舗の名前は表の名前 (通話など) と同じ列 (1 月の列がない年もあるため、月の列の左ではなく表の名前の列)
      if (owner) ms.push({ col, month: Number(m[1]), metric: owner.metric, labelCol: owner.col });
    });
    if (ms.length) {
      monthCols = ms;
      continue;
    }
    if (!year || !monthCols.length) continue;
    // 店舗の行 (表ごとに店舗の名前の列がある: 月の列の左)
    for (const metric of new Set(monthCols.map((x) => x.metric))) {
      const cols = monthCols.filter((x) => x.metric === metric);
      const labelCol = cols[0].labelCol;
      const label = nk(row[labelCol]);
      if (!label || /小計|合計/.test(label)) continue;
      const storeId = storeOf(label);
      if (!storeId) {
        if (label && !/^\d/.test(label)) problems.push(`${year}年 ${GBP_LABEL[metric]}: 「${label}」は店舗の名前ではありません`);
        continue;
      }
      for (const c of cols) {
        const raw = nk(row[c.col]).replace(/,/g, "");
        if (!/^\d+$/.test(raw)) continue;
        values.push({ storeId, month: `${year}-${String(c.month).padStart(2, "0")}`, metric, value: Number(raw) });
      }
    }
  }
  if (!values.length) problems.push("グーグルアクセスの表 (年の見出し・通話・月の列・店舗の行) が見つかりません");
  return { values, problems: [...new Set(problems)].slice(0, 10) };
}
