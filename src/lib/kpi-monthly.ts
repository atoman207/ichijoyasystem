import type { Database, StoreId } from "@/lib/db/types";
import { buildWorkReport } from "@/lib/ops-reports/work-report";
import { fiscalMonths } from "@/lib/kpi-basis";
import type { KpiSettings } from "@/lib/kpi-settings";
import { incentiveYearId } from "@/lib/incentive-year";

/**
 * 月次の手当 (KPI シートの「月間人日」「伝票件数」。月締め・翌月に現金で支給)
 * ------------------------------------------------------------
 * - 月間人日 (店舗): 人日 = 畳と襖類 (係数後) の枚数 ÷ 人日 (作業日報)。基準 (既定 11) 以上の月は
 *   (2.5 万円 × 人数 − 総残業代) ÷ 人数 を 1 人あたりに支給
 * - 伝票件数 (事務): 月の伝票の件数 (個人以外 = 業者を含む) が 事務 1 人 110 件 × 人数 (既定 220 件) 以上の月は
 *   (1 万円 × 人数 − 総残業代) ÷ 人数
 * シートは「クリア月は 1 を入力」。システムは目安の値 (人日 = 作業日報 /work-reports と同じ計算・伝票件数 = システムの受注の件数) を出し、
 * 事務・本部が実績の値 (またはクリアの印)・人数・総残業代を入れて決める (残業代はシステムにないため手入力)。
 * 目安の値だけでは支給にしない (予定表から作る人日・移行した伝票を含む件数は、シートの数え方と同じとは限らないため)。
 * 保存先は年度の設定 (settings の id = incentive_<年度>) の monthly (src/lib/incentive-year.ts と同じ行)
 */

export type MonthlyUnit = StoreId | "office";

export interface MonthlyEntry {
  /** 実績の値 (人日・伝票件数)。空 = 目安の値を使う */
  value?: number;
  /** クリアの印 (シートの「1」)。空 = 値と基準で決める */
  cleared?: boolean;
  /** 人数 (空 = 店舗の社員・事務担当の人数) */
  people?: number;
  /** 総残業代 (円) */
  overtime?: number;
  note?: string;
}

export interface MonthlyRow {
  unit: MonthlyUnit;
  month: string;
  /** 目安の値 (作業日報の人日 / システムの受注の件数) */
  auto: number | null;
  /** 目安の内訳 */
  autoNote: string;
  /** 実績の値 (手入力。なければ空) */
  value: number | null;
  /** 目安の値なら基準以上 (支給は実績の値・印で決める) */
  autoClears: boolean;
  /** 基準 */
  threshold: number;
  cleared: boolean;
  /** クリアの決め方 (manual = 手で印を付けた / value = 実績の値と基準 / none = 未入力) */
  clearedBy: "manual" | "value" | "none";
  people: number;
  overtime: number;
  /** 1 人あたりの支給額 (円) */
  perPerson: number;
  entry?: MonthlyEntry;
}

export const monthlyKey = (unit: MonthlyUnit, month: string) => `${unit}|${month}`;

export function readMonthlyEntries(db: Pick<Database, "settings">, fy: number): Record<string, MonthlyEntry> {
  const v = ((db.settings ?? []).find((s) => s.id === incentiveYearId(fy))?.value ?? {}) as { monthly?: Record<string, MonthlyEntry> };
  const out: Record<string, MonthlyEntry> = {};
  for (const [k, e] of Object.entries(v.monthly ?? {})) {
    if (!/^[a-z0-9_-]+\|\d{4}-\d{2}$/.test(k) || !e || typeof e !== "object") continue;
    const num = (x: unknown, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : undefined);
    const entry: MonthlyEntry = {
      value: num(e.value, 100000),
      cleared: typeof e.cleared === "boolean" ? e.cleared : undefined,
      people: num(e.people, 100),
      overtime: num(e.overtime, 100_000_000),
      note: typeof e.note === "string" && e.note ? e.note.slice(0, 200) : undefined,
    };
    if (Object.values(entry).some((x) => x !== undefined)) out[k] = entry;
  }
  return out;
}

type MonthlyDb = Pick<Database, "schedule" | "orders" | "quotes" | "customers" | "users" | "settings" | "stores" | "jobSpecs" | "products" | "holidays" | "workReportDays">;

/** 月の伝票の件数の目安 (システムの受注。キャンセルを除く・契約日の月・業者を含む) */
export function slipCount(db: Pick<Database, "orders">, month: string): number {
  return db.orders.filter((o) => o.status !== "cancelled" && o.contractDate?.slice(0, 7) === month).length;
}

/** 年度の月次の手当の表 (店舗 × 月の人日、事務 × 月の伝票件数)。今日より後の月は出さない */
export function monthlyAllowances(db: MonthlyDb, fy: number, s: KpiSettings, opts: { today: string; officePeople: number; storePeople?: (storeId: StoreId) => number }): MonthlyRow[] {
  const rules = s.incentive.monthly;
  const entries = readMonthlyEntries(db, fy);
  const months = fiscalMonths(fy, s.fiscalStartMonth).filter((m) => m <= opts.today.slice(0, 7));
  const stores = db.stores.filter((x) => x.kind === "store");
  const rows: MonthlyRow[] = [];
  const pay = (cleared: boolean, yen: number, people: number, overtime: number) => (cleared && people > 0 ? Math.max(0, Math.round((yen * people - overtime) / people)) : 0);
  for (const month of months) {
    for (const st of stores) {
      const e = entries[monthlyKey(st.id, month)];
      let auto: number | null = null;
      let autoNote = "作業日報のデータなし";
      try {
        const r = buildWorkReport(db, st.id, month);
        const total = r.tatami.total + r.fusumaWeighted.total;
        if (r.personDays > 0) {
          auto = Math.round((total / r.personDays) * 10) / 10;
          autoNote = `作業日報: 畳 ${r.tatami.total} + 襖類 (係数後) ${r.fusumaWeighted.total} = ${Math.round(total * 10) / 10} 枚 ÷ ${r.personDays} 人日`;
        }
      } catch {
        /* 作業日報を作れない月 (予定がない) は目安なし */
      }
      const value = e?.value ?? null;
      const people = e?.people ?? opts.storePeople?.(st.id) ?? db.users.filter((u) => u.active && u.storeId === st.id).length;
      const cleared = e?.cleared ?? (value !== null && value >= rules.manDayMin);
      const overtime = e?.overtime ?? 0;
      rows.push({ unit: st.id, month, auto, autoNote, value, autoClears: auto !== null && auto >= rules.manDayMin, threshold: rules.manDayMin, cleared, clearedBy: e?.cleared !== undefined ? "manual" : value !== null ? "value" : "none", people, overtime, perPerson: pay(cleared, rules.manDayYen, people, overtime), entry: e });
    }
    const e = entries[monthlyKey("office", month)];
    const auto = slipCount(db, month);
    const people = e?.people ?? opts.officePeople;
    const threshold = rules.slipPerClerk * Math.max(1, people);
    const value = e?.value ?? null;
    const cleared = e?.cleared ?? (value !== null && value >= threshold);
    const overtime = e?.overtime ?? 0;
    rows.push({ unit: "office", month, auto, autoNote: "システムの受注の件数 (契約日の月・業者を含む。移行した伝票の数え方はシートと違うことがあるため目安)", value, autoClears: auto >= threshold, threshold, cleared, clearedBy: e?.cleared !== undefined ? "manual" : value !== null ? "value" : "none", people, overtime, perPerson: pay(cleared, rules.slipYen, people, overtime), entry: e });
  }
  return rows;
}
