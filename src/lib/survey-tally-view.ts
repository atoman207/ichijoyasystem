import type { Database, StoreId, SurveyResponse, User } from "@/lib/db/types";
import { canReadStoreRecords } from "@/lib/auth/permissions";
import { deliveryOf, fmtRate, inPeriod, isCard, storeKpi, surveyKpiDate, type Period } from "@/lib/kpi";
import { countsCard, kpiBasis, periodMonths, unnamedCard, type KpiBasis } from "@/lib/kpi-basis";
import { surveyTally, surveyTallyByStore, type SurveyTally } from "@/lib/survey-tally";

/**
 * KPI → アンケート の一覧と集計表 (画面 /kpi/surveys と CSV /api/kpi/survey-tally で共通)
 * ------------------------------------------------------------
 * 絞り込み (店舗・案件の紐づけ・キーワード) と、集計に入れるはがき (kpi-basis.ts の countsCard)。
 * 集計表の列: 月 (期間が 24 か月まで) / 店舗 (シートの合計の表。店舗ごとの返信率の行つき)
 */

export interface SurveyFilter {
  store?: string;
  link?: string;
  q?: string;
}

export interface SurveyView {
  basis: KpiBasis;
  /** 絞り込んだはがき (はがき 1 枚分の回答・期間・店舗・紐づけ・キーワード) */
  rows: SurveyResponse[];
  /** 集計に入るはがき */
  counted: SurveyResponse[];
  /** 担当の名前が未記入のため数えないはがき */
  unnamed: SurveyResponse[];
  store: string;
}

type ViewDb = Pick<Database, "surveys" | "users" | "orders" | "customers" | "qualityIssues" | "reviews" | "stores" | "settings"> & Partial<Pick<Database, "schedule">>;

export function surveyView(db: ViewDb, reader: User, period: Period | null, f: SurveyFilter): SurveyView {
  const basis = kpiBasis(db);
  const store = f.store && canReadStoreRecords(reader, f.store as StoreId) ? f.store : "";
  const q = f.q?.trim() ?? "";
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  let rows = db.surveys.filter((s) => canReadStoreRecords(reader, s.storeId)).filter((s) => isCard(s) && inPeriod(surveyKpiDate(s), period) && (!store || s.storeId === store));
  if (f.link === "linked") rows = rows.filter((s) => s.orderId);
  if (f.link === "unlinked") rows = rows.filter((s) => !s.orderId);
  if (q) rows = rows.filter((s) => [s.postcardNo, s.comment, s.salesName, s.craftsmanName, users.get(s.salesUserId ?? ""), ...deliveryOf(s).map((id) => users.get(id))].some((t) => t?.includes(q)));
  return { basis, rows, counted: rows.filter((s) => countsCard(s, basis)), unnamed: rows.filter((s) => unnamedCard(s, basis)), store };
}

export type TallyAxis = "month" | "store";

export interface TallyView {
  tally: SurveyTally;
  /** 列ごとの返信率 (店舗の列のときだけ。シートの合計の表の 2 行目) */
  extraRows: { label: string; values: string[]; total: string }[];
}

/** 集計表 (列 = 月 / 店舗)。月の列は期間が 24 か月までのとき */
export function surveyTallyView(db: ViewDb, reader: User, view: SurveyView, period: Period | null, axis: TallyAxis): TallyView | null {
  if (axis === "store") {
    const stores = db.stores.filter((s) => s.kind === "store" && canReadStoreRecords(reader, s.id) && (!view.store || s.id === view.store));
    if (!stores.length) return null;
    const tally = surveyTallyByStore(view.counted, stores.map((s) => ({ id: s.id, label: s.shortName || s.name })));
    const cmap = new Map(db.customers.map((c) => [c.id, c]));
    const ks = stores.map((s) => storeKpi(db, period, s.id, cmap, view.basis));
    const ind = ks.reduce((a, k) => a + k.individualOrders, 0);
    const cards = ks.reduce((a, k) => a + k.surveys, 0);
    return {
      tally,
      extraRows: [
        { label: "個人件数 (返信率の分母)", values: ks.map((k) => k.individualOrders.toLocaleString("ja-JP")), total: ind.toLocaleString("ja-JP") },
        { label: "返信率", values: ks.map((k) => fmtRate(k.replyRate)), total: fmtRate(ind ? (cards / ind) * 100 : null) },
      ],
    };
  }
  const months = period ? periodMonths(period).map((m) => m.month) : [];
  if (!months.length || months.length > 24) return null;
  return { tally: surveyTally(view.counted, months), extraRows: [] };
}
