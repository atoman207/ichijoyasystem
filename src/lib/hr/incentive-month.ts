import type { Database, StoreId, User } from "@/lib/db/types";
import { monthlyAllowances } from "@/lib/kpi-monthly";
import { kpiSettings } from "@/lib/kpi-settings";
import { attendancePeriod, attendanceSettings, shiftMonth, staffCategory, type AttendanceSettings, type IncentivePay, type IncentivePeriod } from "./timecard";

/**
 * 勤務表の備考に書くインセンティブ (月ごと・社員ごと)
 * ------------------------------------------------------------
 * 社内総合マニュアル (給与〆) の決まり:
 * - インセンティブ (現金) = Google 口コミ: 前月 1 日〜末日の口コミの点 (星・コメント・写真 各 1 点) × 1,000 円 (担当者ごと)
 * - インセンティブ = 点検: 点検の電話をした人が、お客様宅に行った点検の件数 × 500 円 (アポの段階では発生しない)。
 *   今後は口コミと同じ運用に統一する予定 (お客様 2026-11-26) → 既定は前月 1 日〜末日・現金。設定で 20 日締め・給与 (成果給) に戻せる
 * - 月次の手当 (KPI の「月間人日」= 店舗の職人・「伝票件数」= 事務)。前月の分を翌月に現金で。事務の伝票件数は設定 until の月で廃止できる
 * 手入力の調整 (件数の置き換え・加算) は設定 attendance_incentive_<YYYY-MM> (勤務表の月)
 */

export type IncentiveKey = "review" | "inspection" | "manDay" | "slip" | "adjust";

export interface IncentiveItem {
  key: IncentiveKey;
  label: string;
  yen: number;
  pay: IncentivePay;
  detail: string;
}

export interface PersonIncentive {
  userId: string;
  items: IncentiveItem[];
  cash: number;
  salary: number;
}

export interface IncentiveAdjust {
  /** 点検の件数 (手入力。空 = 予定表から数えた件数) */
  inspection?: number;
  /** 口コミの点 (手入力。空 = 口コミの記録から) */
  review?: number;
  /** 加算 (円。マイナスも可) */
  cash?: number;
  salary?: number;
  note?: string;
}

export const incentiveAdjustId = (yearMonth: string) => `attendance_incentive_${yearMonth}`;

export function readIncentiveAdjust(db: Pick<Database, "settings">, yearMonth: string): Record<string, IncentiveAdjust> {
  const v = ((db.settings ?? []).find((s) => s.id === incentiveAdjustId(yearMonth))?.value ?? {}) as { items?: Record<string, unknown> };
  const out: Record<string, IncentiveAdjust> = {};
  const n = (x: unknown, min: number, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : undefined);
  for (const [id, raw] of Object.entries(v.items ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const a: IncentiveAdjust = {
      inspection: n(o.inspection, 0, 1000),
      review: n(o.review, 0, 10000),
      cash: n(o.cash, -10_000_000, 10_000_000),
      salary: n(o.salary, -10_000_000, 10_000_000),
      note: typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 200) : undefined,
    };
    if (Object.values(a).some((x) => x !== undefined)) out[id] = a;
  }
  return out;
}

/** 期間 (前月 1 日〜末日 / 締め) */
export function incentiveRange(db: Pick<Database, "settings">, yearMonth: string, period: IncentivePeriod): { from: string; to: string; label: string } {
  if (period === "closing") {
    const r = attendancePeriod(db, yearMonth);
    return { ...r, label: `${r.from.slice(5).replace("-", "/")}〜${r.to.slice(5).replace("-", "/")}` };
  }
  const prev = shiftMonth(yearMonth, -1);
  const [y, m] = prev.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${prev}-01`, to: `${prev}-${String(last).padStart(2, "0")}`, label: `${m}月分` };
}

type IncDb = Pick<
  Database,
  "settings" | "users" | "stores" | "reviews" | "schedule" | "orders" | "quotes" | "customers" | "jobSpecs" | "products" | "holidays" | "workReportDays"
>;

const fiscalYearFor = (month: string, start: number) => {
  const [y, m] = month.split("-").map(Number);
  return start === 1 ? y : m >= start ? y + 1 : y;
};

/** 点検の件数 (予定表の点検の予定。点検の電話をした人 × 予定の日が期間の中で今日まで) */
export function inspectionCounts(db: Pick<Database, "schedule">, from: string, to: string, today: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of db.schedule) {
    if (!e.inspectionBy || e.date < from || e.date > to || e.date > today) continue;
    out.set(e.inspectionBy, (out.get(e.inspectionBy) ?? 0) + 1);
  }
  return out;
}

/** 口コミの点 (担当者ごと。投稿日が期間の中) */
export function reviewPoints(db: Pick<Database, "reviews">, from: string, to: string): Map<string, { points: number; count: number }> {
  const out = new Map<string, { points: number; count: number }>();
  for (const r of db.reviews ?? []) {
    if (!r.userId || r.postedOn < from || r.postedOn > to) continue;
    const cur = out.get(r.userId) ?? { points: 0, count: 0 };
    out.set(r.userId, { points: cur.points + (r.points || 0), count: cur.count + 1 });
  }
  return out;
}

export interface MonthIncentives {
  yearMonth: string;
  persons: Map<string, PersonIncentive>;
  ranges: { review: string; inspection: string; allowance: string };
  notes: string[];
}

/** 勤務表の月 (YYYY-MM) のインセンティブ。users = 勤務表に載せる社員 */
export function monthIncentives(db: IncDb, yearMonth: string, users: User[], today: string, s: AttendanceSettings = attendanceSettings(db)): MonthIncentives {
  const adjust = readIncentiveAdjust(db, yearMonth);
  const rules = s.incentives;
  const persons = new Map<string, PersonIncentive>(users.map((u) => [u.id, { userId: u.id, items: [], cash: 0, salary: 0 }]));
  const add = (userId: string, item: IncentiveItem) => {
    const p = persons.get(userId);
    if (!p || !item.yen) return;
    p.items.push(item);
    if (item.pay === "cash") p.cash += item.yen;
    else p.salary += item.yen;
  };
  const notes: string[] = [];
  const kpi = kpiSettings(db);
  const clerks = kpi.clerkUserIds;

  const rr = incentiveRange(db, yearMonth, rules.review.period);
  if (rules.review.enabled) {
    const pts = reviewPoints(db, rr.from, rr.to);
    for (const u of users) {
      const a = adjust[u.id]?.review;
      const got = pts.get(u.id);
      const points = a ?? got?.points ?? 0;
      if (points > 0) add(u.id, { key: "review", label: "口コミ", yen: points * rules.review.yen, pay: rules.review.pay, detail: `Google 口コミ ${points} 点${a !== undefined ? " (手入力)" : got ? ` (${got.count} 件)` : ""} × ${rules.review.yen.toLocaleString()} 円 (${rr.label})` });
    }
  }

  const ir = incentiveRange(db, yearMonth, rules.inspection.period);
  if (rules.inspection.enabled) {
    const counts = inspectionCounts(db, ir.from, ir.to, today);
    for (const u of users) {
      const a = adjust[u.id]?.inspection;
      const n = a ?? counts.get(u.id) ?? 0;
      if (n > 0) add(u.id, { key: "inspection", label: "点検", yen: n * rules.inspection.yen, pay: rules.inspection.pay, detail: `点検 ${n} 件${a !== undefined ? " (手入力)" : ""} × ${rules.inspection.yen.toLocaleString()} 円 (${ir.label})` });
    }
  }

  // 月次の手当 (前月の分)
  const prev = shiftMonth(yearMonth, -1);
  if (rules.manDay.enabled || (rules.slip.enabled && (!rules.slip.until || prev <= rules.slip.until))) {
    try {
      const fy = fiscalYearFor(prev, kpi.fiscalStartMonth);
      const att = attendanceSettings(db);
      const rows = monthlyAllowances(db, fy, kpi, { today, officePeople: clerks.length }).filter((r) => r.month === prev);
      for (const r of rows) {
        if (r.perPerson <= 0) continue;
        if (r.unit === "office") {
          if (!rules.slip.enabled || (rules.slip.until && prev > rules.slip.until)) continue;
          for (const u of users) if (clerks.includes(u.id)) add(u.id, { key: "slip", label: "伝票件数", yen: r.perPerson, pay: rules.slip.pay, detail: `伝票件数の手当 ${Number(prev.slice(5))}月 (1 人あたり)` });
        } else {
          if (!rules.manDay.enabled) continue;
          for (const u of users) {
            if (u.storeId !== (r.unit as StoreId)) continue;
            const c = staffCategory(att, u, clerks);
            if (c !== "craft") continue;
            add(u.id, { key: "manDay", label: "月間人日", yen: r.perPerson, pay: rules.manDay.pay, detail: `月間人日の手当 ${Number(prev.slice(5))}月 (1 人あたり)` });
          }
        }
      }
    } catch {
      notes.push("月次の手当 (月間人日・伝票件数) を計算できませんでした。KPI → インセンティブ の月次の手当を確かめてください。");
    }
  }
  if (rules.slip.until && prev > rules.slip.until) notes.push(`事務の伝票件数の手当は ${Number(rules.slip.until.slice(5))}月分 (${rules.slip.until.slice(0, 4)}年) で廃止しています。`);

  for (const u of users) {
    const a = adjust[u.id];
    if (a?.cash) add(u.id, { key: "adjust", label: "調整 (現金)", yen: a.cash, pay: "cash", detail: a.note ?? "手入力の調整" });
    if (a?.salary) add(u.id, { key: "adjust", label: "調整", yen: a.salary, pay: "salary", detail: a.note ?? "手入力の調整" });
  }
  return { yearMonth, persons, ranges: { review: rr.label, inspection: ir.label, allowance: `${Number(prev.slice(5))}月分` }, notes };
}

/** 「インセンティブ￥5,000（現金）」 */
export function incentiveNote(p: Pick<PersonIncentive, "cash" | "salary"> | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.salary > 0) out.push(`インセンティブ￥${p.salary.toLocaleString("ja-JP")}`);
  if (p.cash > 0) out.push(`インセンティブ￥${p.cash.toLocaleString("ja-JP")}（現金）`);
  return out;
}
