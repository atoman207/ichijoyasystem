import type { Database, StoreId } from "@/lib/db/types";
import { countedIssue, inPeriod, type Period } from "@/lib/kpi-core";
import { denomSummary, kpiBasis, personScores, unnamedCard, type KpiBasis } from "@/lib/kpi-basis";
import { surveyKpiDate } from "@/lib/kpi-core";
import { computeIncentives } from "@/lib/incentive";
import { kpiSettings } from "@/lib/kpi-settings";
import type { StaffMatch } from "./staff";
import { nk, nkTight, parseNum, storeOfLabel, type WorkbookTab } from "./tabs";

/**
 * 「KPI」のタブ (手計算の集計) → システムの集計との照合 (書き込まない)
 * ------------------------------------------------------------
 * 年度の表 (「2026年」→ 見出し「項目・対象・累計・12月…11月」) ごとに、月ごとの クレーム件数・手直し件数 (店舗・事務)、
 * Google 口コミの件数・ポイント (社員) と、累計の ハガキ返信率・①〜④ の平均・クレーム手直しポイント率 を読み、
 * 同じ期間のシステムの値 (取り込んだクレーム・手直し、口コミ、アンケートはがき) と並べる。
 * シートは手計算のため、締め日 (12/20 など)・転記の時期で少しずれることがある (差は「確かめるところ」として出す)。
 * 累計の値 (返信率・平均・ポイント率) は年間インセンティブ (src/lib/incentive.ts) と同じ計算 = 支給額のもとの値で比べる。
 * 「クレーム手直しポイント率 / ポイント合計 / 分母」の表 (シートの右側) があれば、ポイント合計と分母 (施工件数) も比べる
 */

type Metric = "claims" | "rework" | "reviews" | "reviewPoints" | "reply" | "phone" | "sales" | "craft" | "finish" | "qrate" | "qpoints" | "sites";

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
  qpoints: "クレーム・手直しポイント合計",
  sites: "施工件数 (ポイント率の分母)",
};

export interface KpiYear {
  label: string;
  /** 月の列 → YYYY-MM */
  months: string[];
  period: Period;
  monthly: { metric: "claims" | "rework" | "reviews" | "reviewPoints"; target: string; values: (number | undefined)[] }[];
  totals: { metric: "reply" | "phone" | "sales" | "craft" | "finish" | "qrate" | "qpoints" | "sites"; target: string; value: number | undefined }[];
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
    ky.totals.push(...sideTable(rows, r));
    years.push(ky);
  }
  if (!years.length) problems.push("KPI: 年度の表 (「2026年」の行) が見つかりません");
  return { years, problems };
}

/**
 * 年度の表の右側の「クレーム手直しポイント率 | クレーム手直しポイント合計 | 分母」の表 (店舗・事務ごとの ポイント合計・分母 = 施工件数)。
 * 見出しの行から下へ、店舗の名前が続くあいだ読む
 */
function sideTable(rows: string[][], start: number): KpiYear["totals"] {
  const out: KpiYear["totals"] = [];
  for (let k = start + 1; k < rows.length; k++) {
    if (/^20\d\d年$/.test(nkTight(rows[k][1]))) break;
    const c = rows[k].findIndex((v) => /^クレーム手直しポイント合計$/.test(nkTight(v)));
    if (c < 1 || !/分母/.test(nkTight(rows[k][c + 1]))) continue;
    for (let j = k + 1; j < Math.min(rows.length, k + 10); j++) {
      const target = nk(rows[j][c - 1]);
      if (!target || !storeOfLabel(target)) break;
      out.push({ metric: "qpoints", target, value: parseNum(rows[j][c]) });
      out.push({ metric: "sites", target, value: parseNum(rows[j][c + 1]) });
    }
    break;
  }
  return out;
}

function endOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/**
 * 照合の結果: ok = 一致 / differ = 差 (確かめるところ) / sheet = シート側の計算の誤り (原因が分かっている差) /
 * pending = シートがまだ集計していない月 (シートの値のある最後の月より後。システムの値だけを出す)
 */
export type ReconStatus = "ok" | "differ" | "sheet" | "pending";

export interface ReconRow {
  metric: Metric;
  label: string;
  target: string;
  month?: string;
  sheet: number | undefined;
  system: number | null;
  ok: boolean;
  status: ReconStatus;
  /** システムの値の計算 (例: 「105 枚 ÷ 個人件数 249」) */
  detail?: string;
  /** 差の原因 (シート側の誤りのとき) */
  cause?: string;
}

export interface ReconYear {
  label: string;
  /** 年度の期間 (シートの表の 12 か月) */
  period: Period;
  /** 累計 (返信率・平均・ポイント率) を比べた期間 = シートの月ごとの値が入っている最後の月まで (年度の途中のシート) */
  compared: Period;
  rows: ReconRow[];
  matched: number;
  differ: number;
  /** シート側の誤り (原因が分かっている差) */
  sheetErrors: number;
  /** シートがまだ集計していない月の行 */
  pending: number;
}

type ReconDb = Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews" | "users"> & Partial<Pick<Database, "settings" | "stores">>;

/**
 * シートの値とシステムの値を並べる。match = 社員の照合 (取込と同じ対応表)。
 * システムの値はアンケート (はがき)・取り込んだクレーム・手直し・口コミから kpi.ts と同じ決め方で数える
 */
export function reconcileKpi(db: ReconDb, years: KpiYear[], match: (name: string) => StaffMatch, basisIn?: KpiBasis): ReconYear[] {
  const basis = basisIn ?? kpiBasis(db);
  const settings = kpiSettings({ settings: db.settings ?? [], users: db.users });
  return years.map((y) => {
    const rows: ReconRow[] = [];
    const through = lastFilledMonth(y);
    const close = (a: number | undefined, b: number | null, digits: number) => a !== undefined && b !== null && Math.abs(a - b) < (digits ? 0.5 * 10 ** -digits + 1e-9 : 0.5);
    type SheetStyle = { value: number | null; cause: string } | undefined;
    const push = (metric: Metric, target: string, sheet: number | undefined, system: number | null, month?: string, digits = 0, detail?: string, sheetStyles: SheetStyle[] = []) => {
      if (sheet === undefined && (system === null || system === 0)) return;
      const ok = close(sheet, system, digits);
      // シートの値のある最後の月より後の月 (まだ転記していない月。空欄・0 が入っている) は差に数えない
      const later = Boolean(month && through && month > through);
      // シート側の計算の誤り (原因の分かっている差): シートの数え方で計算し直すとシートの値になる
      const known = ok || later ? undefined : sheetStyles.find((x) => x && close(sheet, x.value, digits));
      const status: ReconStatus = ok ? "ok" : later ? "pending" : known ? "sheet" : "differ";
      rows.push({ metric, label: METRIC_LABEL[metric], target, month, sheet, system: system === null ? null : digits ? Number(system.toFixed(digits)) : system, ok, status, detail, cause: known?.cause });
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
    // 累計 (年度の期間): 年間インセンティブと同じ計算 (分母・はがきの数え方・平均は kpi-basis.ts)。
    // シートの期間はまだ途中のことがある (例: 8 月分まで) ため、シートに値のある月の最後までで比べる
    const period: Period = through ? { from: y.period.from, to: endOf(through) } : y.period;
    // シート (ピボット) の平均の計算: 合計点は「店舗」のある行すべて (ハガキ№ のない行を含む)、枚数は ハガキ№ のある行だけ。
    // システムは № のない行をはがきとして数えないため、その行があると ①・④ がずれる (シート側の誤り)
    const pivotAvg = (score: "phoneScore" | "finishScore", storeId?: StoreId): { value: number | null; cause: string } | undefined => {
      const rowsIn = db.surveys.filter((s) => s.storeId !== "hq" && (!storeId || s.storeId === storeId) && inPeriod(surveyKpiDate(s), period));
      const noNo = rowsIn.filter((s) => !s.postcardNo && typeof s[score] === "number");
      if (!noNo.length) return undefined;
      const counted = rowsIn.filter((s) => s.postcardNo).length;
      const sum = rowsIn.reduce((a, s) => a + (typeof s[score] === "number" ? (s[score] as number) : 0), 0);
      const extra = noNo.reduce((a, s) => a + (s[score] as number), 0);
      const days = [...new Set(noNo.map((s) => (s.answeredOn ?? s.receivedAt).slice(0, 10)))].join("・");
      return { value: counted ? sum / counted : null, cause: `シートの合計点に ハガキ№ のない行 ${noNo.length} 行 (入力日 ${days}) の ${extra} 点が入り、枚数には入っていないためです (${sum} 点 ÷ ${counted} 枚)。№ のない行を除くとシステムの値になります` };
    };
    const allUsers = { ...db, users: db.users.map((u) => ({ ...u, active: true })) };
    const inc = computeIncentives(allUsers, period, { ...settings, excludedUserIds: [] }, {}, basis);
    const people = personScores(db.surveys, period, basis);
    // シートのピボットは「担当の名前が一つでも未記入の場合ノーカウント」を当てていない: 名前が空欄のはがきも数えたときの値
    const unnamed = basis.requireStaffNames ? db.surveys.filter((s) => unnamedCard(s, basis) && inPeriod(surveyKpiDate(s), period)) : [];
    const loose = { ...basis, requireStaffNames: false };
    const incLoose = unnamed.length ? computeIncentives(allUsers, period, { ...settings, excludedUserIds: [] }, {}, loose) : undefined;
    const peopleLoose = unnamed.length ? personScores(db.surveys, period, loose) : undefined;
    const unnamedCause = (storeId?: StoreId): string => {
      const list = unnamed.filter((s) => !storeId || s.storeId === storeId);
      return `シートは担当の名前が空欄のはがき ${list.length} 枚 (${list.slice(0, 5).map((s) => `No.${s.postcardNo ?? "なし"}`).join("・")}) も数えています。KPI の決まり「担当の名前が一つでも未記入の場合ノーカウント」ではシステムの値です`;
    };
    const looseUnit = (u: { storeId?: StoreId; office: boolean }) => (u.office ? incLoose?.office : incLoose?.units.find((x) => x.unit === u.storeId));

    const unitRow = (u: { storeId?: StoreId; office: boolean }) => (u.office ? inc.office : inc.units.find((x) => x.unit === u.storeId));
    for (const t of y.totals) {
      const u = unitOf(t.target);
      const ur = u ? unitRow(u) : undefined;
      if (t.metric === "reply" && u?.storeId && ur) {
        const lu = looseUnit(u);
        push("reply", t.target, t.value, ur.replyRate, undefined, 1, `${ur.cards} 枚 ÷ 個人件数 ${ur.individual} (${ur.denominators ? denomSummary(ur.denominators.individual) : ""})`, [lu ? { value: lu.replyRate, cause: unnamedCause(u.storeId) } : undefined]);
      } else if (t.metric === "phone") {
        push("phone", t.target, t.value, inc.companyPhoneAvg, undefined, 2, `${inc.companyPhoneCount} 枚の平均`, [pivotAvg("phoneScore"), incLoose ? { value: incLoose.companyPhoneAvg, cause: unnamedCause() } : undefined]);
      } else if (t.metric === "finish" && u?.storeId && ur) {
        const lu = looseUnit(u);
        push("finish", t.target, t.value, ur.finishAvg, undefined, 2, `${ur.finishCount} 枚の平均`, [pivotAvg("finishScore", u.storeId), lu ? { value: lu.finishAvg, cause: unnamedCause(u.storeId) } : undefined]);
      } else if (t.metric === "sales" || t.metric === "craft") {
        const s = match(t.target);
        if (!s.userId) continue;
        const key = t.metric === "sales" ? "sales" : "craft";
        const v = people.get(s.userId)?.[key];
        const lv = peopleLoose?.get(s.userId)?.[key];
        push(t.metric, t.target, t.value, v?.avg ?? null, undefined, 2, v ? `${v.sum} 点 ÷ ${v.n} 枚${v.blank ? ` (空欄 ${v.blank})` : ""}` : undefined, [lv && lv.n !== v?.n ? { value: lv.avg, cause: unnamedCause() } : undefined]);
      } else if (t.metric === "qrate" && ur) {
        push("qrate", t.target, t.value, ur.qualityRate, undefined, 2, `${ur.qualityPoints} 点 ÷ 施工件数 ${ur.orders}`);
      } else if (t.metric === "qpoints" && ur) {
        push("qpoints", t.target, t.value, ur.qualityPoints, undefined, 0);
      } else if (t.metric === "sites" && ur) {
        push("sites", t.target, t.value, ur.orders, undefined, 0, ur.denominators ? denomSummary(ur.denominators.sites) : "4 店舗の合計");
      }
    }
    return { label: y.label, period: y.period, compared: period, rows, matched: rows.filter((r) => r.status === "ok").length, differ: rows.filter((r) => r.status === "differ").length, sheetErrors: rows.filter((r) => r.status === "sheet").length, pending: rows.filter((r) => r.status === "pending").length };
  });
}

/** シートの月ごとの値 (クレーム・手直し・口コミ) が入っている最後の月 (年度の途中のシートの累計の期間) */
export function lastFilledMonth(y: KpiYear): string | undefined {
  let last = -1;
  for (const m of y.monthly) m.values.forEach((v, i) => v !== undefined && (m.metric === "rework" || m.metric === "reviews") && i > last && (last = i));
  return last >= 0 ? y.months[last] : undefined;
}
