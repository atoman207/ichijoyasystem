import type { Database, Order, QualityIssue, StoreId, SurveyResponse } from "@/lib/db/types";

/**
 * KPI の集計の基本 (期間・案件の日付・はがきの見分け方)
 * ------------------------------------------------------------
 * kpi.ts (集計) と kpi-basis.ts (分母・数え方) の両方が使う。kpi.ts から同じ名前で使える (互換のため再公開)
 */

export interface Period {
  from: string;
  to: string;
}

export const inPeriod = (date: string | undefined, p: Period | null): boolean => Boolean(date) && (!p || (date! >= p.from && date! <= p.to));

export const orderDate = (o: Pick<Order, "salesDate" | "completedAt" | "contractDate">): string => (o.salesDate ?? o.completedAt?.slice(0, 10) ?? o.contractDate).slice(0, 10);

/** はがきの回答日 (なければ登録日)。画面の表示用 */
export const surveyDate = (s: Pick<SurveyResponse, "answeredOn" | "receivedAt">): string => (s.answeredOn ?? s.receivedAt).slice(0, 10);

/**
 * KPI の期間の判定に使う日: 集計月 (countMonth = シートの「月」の列。はがきを集計した月) があればその月の 1 日、なければ回答日 → 登録日。
 * スプレッドシートでは前月のはがきを月初にまとめて入力していたため、入力の日 (移行データの登録日) は集計月の翌月になっていることが多い
 */
export const surveyKpiDate = (s: Pick<SurveyResponse, "answeredOn" | "receivedAt" | "countMonth">): string => (s.countMonth && /^\d{4}-\d{2}$/.test(s.countMonth) ? `${s.countMonth}-01` : surveyDate(s));

/** 集計の対象になる案件 (キャンセルを除く) */
export function periodOrders(db: Pick<Database, "orders">, p: Period | null, storeId?: StoreId): Order[] {
  return db.orders.filter((o) => countedOrder(o) && (!storeId || o.storeId === storeId) && inPeriod(orderDate(o), p));
}

/** 案件として数える状態か (キャンセル・承認待ち・差戻しを除く) */
export const countedOrder = (o: Pick<Order, "status">): boolean => o.status !== "cancelled" && o.status !== "pending_approval" && o.status !== "returned";

/**
 * はがき 1 枚分の回答か。移行データ (スプレッドシート) は ハガキ№ のある行だけ (シートの返信数 = ハガキ№ の数)。
 * № のない行は 2 人目以降の担当 (職人・営業) の行で、②③ の個人評価にだけ使う。写真・手入力で登録したはがきは 1 枚ずつ
 */
export const isCard = (s: Pick<SurveyResponse, "postcardNo" | "source">): boolean => Boolean(s.postcardNo) || s.source === "capture" || s.source === "manual";

/** 集計に入れるクレーム・手直し (記録のみのものを除く) */
export const countedIssue = (q: Pick<QualityIssue, "counted">): boolean => q.counted !== false;

/** 担当職人 (③ の評価対象。複数のことがある)。移行データは担当職人の 1 人 */
export function deliveryOf(s: Pick<SurveyResponse, "deliveryUserIds" | "craftsmanUserId">): string[] {
  if (s.deliveryUserIds && s.deliveryUserIds.length) return s.deliveryUserIds;
  return s.craftsmanUserId ? [s.craftsmanUserId] : [];
}
