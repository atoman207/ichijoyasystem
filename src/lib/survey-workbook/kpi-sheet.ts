import type { Database, StoreId } from "@/lib/db/types";
import { countedIssue, deliveryOf, inPeriod, isCard, periodOrders, surveyDate, type Period } from "@/lib/kpi";
import type { StaffMatch } from "./staff";
import { nk, nkTight, parseNum, storeOfLabel, type WorkbookTab } from "./tabs";

/**
 * 「KPI」のタブ (手計算の集計) → システムの集計との照合 (書き込まない)
 * ------------------------------------------------------------
 * 年度の表 (「2026年」→ 見出し「項目・対象・累計・12月…11月」) ごとに、月ごとの クレーム件数・手直し件数 (店舗・事務)、
 * Google 口コミの件数・ポイント (社員) と、累計の ハガキ返信率・①〜④ の平均・クレーム手直しポイント率 を読み、
 * 同じ期間のシステムの値 (取り込んだクレーム・手直し、口コミ、アンケートはがき) と並べる。
 * シートは手計算のため、締め日 (12/20 など)・転記の時期で少しずれることがある (差は「確かめるところ」として出す)
 */

type Metric = "claims" | "rework" | "reviews" | "reviewPoints" | "reply" | "phone" | "sales" | "craft" | "finish" | "qrate";

export const METRIC_LABEL: Record<Metric, string> = {
  claims: "クレーム件数",
  rework: "手直し件数",
  reviews: "Google 口コミ件数",
  reviewPoints: "Google 口コミポイント",
  reply: "ハガキ返信率 (%)",
  phone: "① 電話対応 (平均)",
  sales: "② 営業対応 (平均)",
  craft: "③ 職人対応 (平均)",
  finish: "④ 工事仕上り (平均)",
  qrate: "クレーム・手直しポイント率 (%)",
};

export interface KpiYear {
  label: string;
  /** 月の列 → YYYY-MM */
  months: string[];
  period: Period;
  monthly: { metric: "claims" | "rework" | "reviews" | "reviewPoints"; target: string; values: (number | undefined)[] }[];
  totals: { metric: "reply" | "phone" | "sales" | "craft" | "finish" | "qrate"; target: string; value: number | undefined }[];
}

/** KPI のタブを年度の表に分けて読む */
export function parseKpiTab(tab: WorkbookTab): { years: KpiYear[]; problems: string[] } {
  const years: KpiYear[] = [];
  const problems: string[] = [];
  const rows = tab.rows;
  for (let r = 0; r < rows.length; r++) {
    const y = nkTight(rows[r][1]).match(/^(20\d\d)年$/);
    if (!y) continue;
    const year = Number(y[1]);
    const head = rows[r + 1] ?? [];
    const monthCols: { col: number; m: number }[] = [];
    for (let c = 3; c < Math.min(head.length, 20); c++) {
      const m = nkTight(head[c]).match(/^(\d{1,2})月$/);
      if (m) monthCols.push({ col: c, m: Number(m[1]) });
    }
    if (!monthCols.length) {
      problems.push(`KPI ${year}年: 月の見出しがありません`);
      continue;
    }
    // 12 月から始まる年度 (前年 12/1〜11/30) か、1 月からの年
    const fromDec = monthCols[0].m === 12;
    const months = monthCols.map(({ m }) => `${fromDec && m === 12 ? year - 1 : year}-${String(m).padStart(2, "0")}`);
    const period: Period = { from: `${months[0]}-01`, to: endOf(months.at(-1)!) };
    const ky: KpiYear = { label: `${year}年`, months, period, monthly: [], totals: [] };
    let item = "";
    let target = "";
    for (let k = r + 2; k < rows.length; k++) {
      const row = rows[k];
      if (/^20\d\d年$/.test(nkTight(row[1]))) break;
      const c0 = nkTight(row[0]);
      const c1 = nkTight(row[1]);
      const c2 = nkTight(row[2]);
      // 項目が 1 列目 (グーグルクチコミ・クレーム) か 2 列目 (それ以外) に書かれている
      if (/グーグル|クチコミ|口コミ/.test(c0)) item = "reviews";
      else if (/^クレーム$/.test(c0)) item = "claims";
      else if (c1) {
        if (/手直し件数/.test(c1)) item = "rework";
        else if (/クレーム件数/.test(c1)) item = "claims2";
        else if (/ハガキ返信率/.test(c1)) item = "reply";
        else if (/電話対応/.test(c1)) item = "phone";
        else if (/営業対応/.test(c1)) item = "sales";
        else if (/職人対応/.test(c1)) item = "craft";
        else if (/工事仕上/.test(c1)) item = "finish";
        else if (/クレーム.*手直し.*率/.test(c1)) item = "qrate";
        else if (/月間人日|伝票件数/.test(c1)) item = "other";
      }
      const values = monthCols.map(({ col }) => parseNum(row[col]));
      if (item === "reviews" || item === "claims") {
        // 1 列目 = 項目、2 列目 = 社員・店舗 (空欄は上と同じ)、3 列目 = 件数 / ポイント
        if (c1) target = nk(row[1]);
        if (!target || !/^(件数|ポイント)$/.test(c2)) continue;
        if (item === "claims" && c2 === "ポイント") continue;
        ky.monthly.push({ metric: item === "reviews" ? (c2 === "件数" ? "reviews" : "reviewPoints") : "claims", target, values });
        continue;
      }
      // 2 列目 = 項目 (空欄は上と同じ)、3 列目 = 社員・店舗
      const t = nk(row[2]);
      if (!t || /^(件数|ポイント)$/.test(t)) continue;
      if (item === "rework") ky.monthly.push({ metric: "rework", target: t, values });
      else if (["reply", "phone", "sales", "craft", "finish", "qrate"].includes(item)) ky.totals.push({ metric: item as KpiYear["totals"][number]["metric"], target: t, value: parseNum(row[3]) });
    }
    years.push(ky);
  }
  if (!years.length) problems.push("KPI: 年度の表 (「2026年」の行) が見つかりません");
  return { years, problems };
}

function endOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export interface ReconRow {
  metric: Metric;
  label: string;
  target: string;
  month?: string;
  sheet: number | undefined;
  system: number | null;
  ok: boolean;
}

export interface ReconYear {
  label: string;
  period: Period;
  rows: ReconRow[];
  matched: number;
  differ: number;
}

type ReconDb = Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews" | "users">;

/**
 * シートの値とシステムの値を並べる。match = 社員の照合 (取込と同じ対応表)。
 * システムの値はアンケート (はがき)・取り込んだクレーム・手直し・口コミから kpi.ts と同じ決め方で数える
 */
export function reconcileKpi(db: ReconDb, years: KpiYear[], match: (name: string) => StaffMatch): ReconYear[] {
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  return years.map((y) => {
    const rows: ReconRow[] = [];
    const push = (metric: Metric, target: string, sheet: number | undefined, system: number | null, month?: string, digits = 0) => {
      if (sheet === undefined && (system === null || system === 0)) return;
      const ok = sheet !== undefined && system !== null && Math.abs(sheet - system) < (digits ? 0.5 * 10 ** -digits + 1e-9 : 0.5);
      rows.push({ metric, label: METRIC_LABEL[metric], target, month, sheet, system: system === null ? null : digits ? Number(system.toFixed(digits)) : system, ok });
    };
    const issues = db.qualityIssues.filter(countedIssue);
    const unitOf = (target: string): { storeId?: StoreId; office: boolean } | null => {
      const s = storeOfLabel(target);
      if (!s) return null;
      return s === "office" ? { office: true } : { storeId: s, office: false };
    };
    for (const m of y.monthly) {
      y.months.forEach((month, i) => {
        const p: Period = { from: `${month}-01`, to: endOf(month) };
        const sheet = m.values[i];
        if (m.metric === "claims" || m.metric === "rework") {
          const u = unitOf(m.target);
          if (!u) return;
          const kinds = m.metric === "claims" ? ["claim", "claim_rework"] : ["rework", "claim_rework"];
          const n = issues.filter((q) => kinds.includes(q.kind) && inPeriod(q.occurredOn, p) && (u.office ? q.attribution === "office" : q.storeId === u.storeId && q.attribution !== "office")).length;
          push(m.metric, m.target, sheet, n, month);
        } else {
          const s = match(m.target);
          if (!s.key) return;
          const mine = db.reviews.filter((r) => r.userId === s.key && inPeriod(r.postedOn, p));
          push(m.metric, m.target, sheet, m.metric === "reviews" ? mine.length : mine.reduce((a, r) => a + r.points, 0), month);
        }
      });
    }
    // 累計 (年度の期間): はがき・クレーム手直し
    const cards = db.surveys.filter((s) => isCard(s) && inPeriod(surveyDate(s), y.period));
    const all = db.surveys.filter((s) => inPeriod(surveyDate(s), y.period));
    const avg = (xs: (number | undefined)[]) => {
      const v = xs.filter((x): x is number => typeof x === "number");
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    for (const t of y.totals) {
      const u = unitOf(t.target);
      if (t.metric === "reply" && u?.storeId) {
        const orders = periodOrders(db, y.period, u.storeId).filter((o) => customers.get(o.customerId)?.type !== "corporate").length;
        const n = cards.filter((c) => c.storeId === u.storeId).length;
        push("reply", t.target, t.value, orders ? (n / orders) * 100 : null, undefined, 1);
      } else if (t.metric === "phone") {
        push("phone", t.target, t.value, avg(cards.map((c) => c.phoneScore)), undefined, 2);
      } else if (t.metric === "finish" && u?.storeId) {
        push("finish", t.target, t.value, avg(cards.filter((c) => c.storeId === u.storeId).map((c) => c.finishScore)), undefined, 2);
      } else if (t.metric === "sales" || t.metric === "craft") {
        const s = match(t.target);
        if (!s.userId) continue;
        const v = t.metric === "sales" ? avg(cards.filter((c) => c.salesUserId === s.userId).map((c) => c.salesScore)) : avg(all.filter((c) => deliveryOf(c).includes(s.userId!)).map((c) => c.craftsmanScore));
        push(t.metric, t.target, t.value, v, undefined, 2);
      } else if (t.metric === "qrate" && u) {
        const orders = u.office ? periodOrders(db, y.period).filter((o) => o.storeId !== "hq").length : periodOrders(db, y.period, u.storeId).length;
        const pts = issues.filter((q) => inPeriod(q.occurredOn, y.period) && (u.office ? q.attribution === "office" : q.storeId === u.storeId && q.attribution !== "office")).reduce((a, q) => a + q.points, 0);
        push("qrate", t.target, t.value, orders ? (pts / orders) * 100 : null, undefined, 2);
      }
    }
    return { label: y.label, period: y.period, rows, matched: rows.filter((r) => r.ok).length, differ: rows.filter((r) => !r.ok).length };
  });
}
