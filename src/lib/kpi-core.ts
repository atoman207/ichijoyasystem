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

/** クレームが発生した記録か (クレーム・クレーム＋手直し) */
export const isClaimIssue = (q: Pick<QualityIssue, "kind">): boolean => q.kind === "claim" || q.kind === "claim_rework";
/** 手直しが発生した記録か (手直し・クレーム＋手直し) */
export const isReworkIssue = (q: Pick<QualityIssue, "kind">): boolean => q.kind === "rework" || q.kind === "claim_rework";

/**
 * 同じ案件の記録をまとめる印。案件 (受注) にひも付いた記録は受注ごと。
 * ひも付いていない記録 (LINE の報告・スプレッドシートの取込で案件が決まらないもの) は 店舗・発生月・現場名 が同じなら同じ案件、
 * 現場名もなければ記録ごと
 */
export function issueCaseKey(q: Pick<QualityIssue, "id" | "orderId" | "storeId" | "occurredOn" | "siteName">): string {
  if (q.orderId) return `o:${q.orderId}`;
  const site = (q.siteName ?? "").normalize("NFKC").replace(/[\s　]+/g, "");
  return site ? `s:${q.storeId}|${q.occurredOn.slice(0, 7)}|${site}` : `q:${q.id}`;
}

export interface IssuePoints {
  /** 上限を当てたあとのポイント (インセンティブ・ポイント率に使う) */
  points: number;
  /** 記録の点数の合計 (上限の前) */
  raw: number;
  /** 上限で減った案件の数 */
  cappedCases: number;
}

/**
 * 上限を当てる単位: 同じ案件 (issueCaseKey) の同じ発生月。クレーム・手直しは月締めで集計していて (KPI シート「月締めで集計」)、
 * 同じ案件でも別の月に起きた別のクレーム・手直しはそれぞれ数える (お客様アンケート集計表の KPI シートの手計算と同じ)
 */
export const issueCapKey = (q: Pick<QualityIssue, "id" | "orderId" | "storeId" | "occurredOn" | "siteName">): string => `${issueCaseKey(q)}#${q.occurredOn.slice(0, 7)}`;

/**
 * クレーム・手直しのポイントの合計 (お客様のご指示 2026-11-24「クレーム 2 点・手直し 1 点・同一案件で両方発生した場合は最大 3 点」)。
 * 同じ案件・同じ月 (issueCapKey) の記録の点数を足し、caseMax 点までにする (0 以下 = 上限なし)。
 * 単位 (店舗・事務・担当者) ごとに絞った記録を渡す
 */
export function issuePoints(issues: Pick<QualityIssue, "id" | "orderId" | "storeId" | "occurredOn" | "siteName" | "points">[], caseMax: number): IssuePoints {
  const byCase = new Map<string, number>();
  let raw = 0;
  for (const q of issues) {
    raw += q.points;
    const k = issueCapKey(q);
    byCase.set(k, (byCase.get(k) ?? 0) + q.points);
  }
  if (!(caseMax > 0)) return { points: raw, raw, cappedCases: 0 };
  let points = 0;
  let cappedCases = 0;
  for (const v of byCase.values()) {
    if (v > caseMax + 1e-9) cappedCases++;
    points += Math.min(v, caseMax);
  }
  return { points, raw, cappedCases };
}

/**
 * 経営管理の指標 (インセンティブのポイントとは別。実数と割合):
 * クレーム発生件数 = クレーム・クレーム＋手直しの記録 / 手直し発生件数 = 手直し・クレーム＋手直しの記録 /
 * 合計 = クレーム + 手直し (クレーム＋手直しの記録はそれぞれに 1 件) / 発生した案件 = クレーム・手直しのあった案件 (重複なし)
 */
export interface IssueCounts {
  claims: number;
  reworks: number;
  total: number;
  cases: number;
}

export function issueCounts(issues: Pick<QualityIssue, "id" | "orderId" | "storeId" | "occurredOn" | "siteName" | "kind">[]): IssueCounts {
  const claims = issues.filter(isClaimIssue).length;
  const reworks = issues.filter(isReworkIssue).length;
  return { claims, reworks, total: claims + reworks, cases: new Set(issues.map(issueCaseKey)).size };
}

/** 担当職人 (③ の評価対象。複数のことがある)。移行データは担当職人の 1 人 */
export function deliveryOf(s: Pick<SurveyResponse, "deliveryUserIds" | "craftsmanUserId">): string[] {
  if (s.deliveryUserIds && s.deliveryUserIds.length) return s.deliveryUserIds;
  return s.craftsmanUserId ? [s.craftsmanUserId] : [];
}
