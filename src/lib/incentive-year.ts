import type { Database, StoreId } from "@/lib/db/types";
import { storeOfLabel } from "@/lib/survey-workbook/tabs";

/**
 * 年度ごとのインセンティブの設定 (settings の id = `incentive_<年度>`)
 * ------------------------------------------------------------
 * - adjust: 調整額 (社員 ID か「name:<名前>」→ 金額・理由)
 * - assign: 所属の月割り (社員 ID か「name:<名前>」→ [{ 所属 (店舗 or 事務), 月数 }])。空の配列 = この年度は対象外 (入社前・退職後)。
 *   KPI シートの集計表と同じく、店舗・事務で決まる項目 (返信率・④・クレーム率・それぞれの MVP・① 電話対応) は
 *   「所属ごとの金額 × 月数 ÷ 12」の合計 (円未満は四捨五入)。年度の途中で店舗を移った社員・途中から入った社員に使う
 *   (例: 2025 年度の集計表 = 店舗を移った社員は 合志 8 か月 + 中央 4 か月、途中から入った事務は 事務 7 か月)。② 営業・③ 職人・口コミの MVP は本人の値なので月割りしない
 * - extra: アカウントのない対象者 (パートの事務など)。キーは「name:<名前>」
 * 書き込みは src/lib/actions/kpi.ts (管理者)。ほかの項目を消さないように、項目ごとに書き換える
 */

export type IncentiveUnit = StoreId | "office";

export interface AssignSegment {
  unit: IncentiveUnit;
  /** 月数 (1〜12) */
  months: number;
}

export interface IncentiveExtra {
  /** 「name:<名前>」 */
  key: string;
  name: string;
  unit: IncentiveUnit;
}

export interface IncentiveYear {
  adjust: Record<string, { amount: number; note?: string }>;
  assign: Record<string, AssignSegment[]>;
  extra: IncentiveExtra[];
}

export const incentiveYearId = (fy: number) => `incentive_${fy}`;

/** 「name:<名前>」のキー (空白を詰める) */
export const extraKey = (name: string) => `name:${name.normalize("NFKC").replace(/\s+/g, "").trim()}`;

const isUnit = (v: unknown, units: string[]): v is IncentiveUnit => typeof v === "string" && (v === "office" || units.includes(v));

export function readIncentiveYear(db: Pick<Database, "settings"> & Partial<Pick<Database, "stores">>, fy: number): IncentiveYear {
  const v = ((db.settings ?? []).find((s) => s.id === incentiveYearId(fy))?.value ?? {}) as Record<string, unknown>;
  const units = (db.stores ?? []).filter((s) => s.kind === "store").map((s) => s.id as string);
  const adjust: IncentiveYear["adjust"] = {};
  const rawAdj = v.adjust && typeof v.adjust === "object" ? (v.adjust as Record<string, { amount?: unknown; note?: unknown }>) : {};
  for (const [k, a] of Object.entries(rawAdj)) {
    const amount = Number(a?.amount);
    if (!Number.isFinite(amount)) continue;
    adjust[k] = { amount: Math.round(amount), note: typeof a?.note === "string" && a.note ? a.note : undefined };
  }
  const assign: IncentiveYear["assign"] = {};
  const rawAssign = v.assign && typeof v.assign === "object" ? (v.assign as Record<string, unknown>) : {};
  for (const [k, list] of Object.entries(rawAssign)) {
    if (!Array.isArray(list)) continue;
    const segs = list
      .map((x) => x as { unit?: unknown; months?: unknown })
      .filter((x) => isUnit(x.unit, units) && Number.isFinite(Number(x.months)) && Number(x.months) > 0)
      .map((x) => ({ unit: x.unit as IncentiveUnit, months: Math.min(12, Math.round(Number(x.months) * 10) / 10) }));
    // 空の配列は「この年度は対象外」
    if (segs.length || list.length === 0) assign[k] = segs;
  }
  const extra: IncentiveExtra[] = [];
  if (Array.isArray(v.extra)) {
    for (const x of v.extra as { name?: unknown; unit?: unknown }[]) {
      if (typeof x?.name !== "string" || !x.name.trim() || !isUnit(x.unit, units)) continue;
      const key = extraKey(x.name);
      if (!extra.some((e) => e.key === key)) extra.push({ key, name: x.name.normalize("NFKC").trim(), unit: x.unit });
    }
  }
  return { adjust, assign, extra };
}

/** 年度の設定の 1 項目だけを書き換える (mutate の中で呼ぶ) */
export function writeIncentiveYearPart<K extends keyof IncentiveYear>(db: Pick<Database, "settings">, fy: number, key: K, value: IncentiveYear[K], by: string, now: string): void {
  const id = incentiveYearId(fy);
  const row = db.settings.find((s) => s.id === id);
  const cur = (row?.value ?? {}) as Record<string, unknown>;
  const next = { ...cur, [key]: value };
  if (row) Object.assign(row, { value: next, updatedBy: by, updatedAt: now });
  else db.settings.push({ id, value: next, updatedBy: by, updatedAt: now });
}

/**
 * 所属の月割りの入力「合志 8, 中央 4」「事務 7」→ 区間。店舗は名前・略称・ID のどれでもよい。空 = 設定しない (今の所属で 12 か月)。
 * 「対象外」「なし」「0」= この年度は対象外 (空の配列)。月数の合計は 12 まで
 */
export function parseAssign(text: string, stores: { id: string; name: string; shortName?: string; kind?: string }[]): AssignSegment[] | { error: string } | null {
  const t = text.normalize("NFKC").trim();
  if (!t) return null;
  if (/^(対象外|なし|無し|0)$/.test(t)) return [];
  const segs: AssignSegment[] = [];
  for (const part of t.split(/[,、\n/／]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(.+?)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:か月|ヶ月|カ月|ケ月|月)?$/);
    if (!m) return { error: `「${part}」の形が正しくありません (例: 合志 8, 中央 4)` };
    const label = m[1].trim().replace(/店$/, "");
    const months = Number(m[2]);
    let unit: IncentiveUnit | undefined;
    if (/^事務$/.test(label)) unit = "office";
    else {
      unit = stores.find((s) => s.kind !== "hq" && [s.id, s.name, s.name.replace(/店$/, ""), s.shortName, s.shortName?.replace(/店$/, "")].filter(Boolean).includes(label))?.id;
      // 店舗の名前を変えていても、シートの書き方 (合志・工場・中央・西・玉名) で読める
      const known = storeOfLabel(label);
      if (!unit && known && known !== "office" && known !== "hq" && stores.some((s) => s.id === known)) unit = known;
    }
    if (!unit) return { error: `「${m[1].trim()}」は店舗の名前 (または「事務」) ではありません` };
    if (!(months > 0) || months > 12) return { error: `「${part}」の月数は 1〜12 で入力してください` };
    const cur = segs.find((x) => x.unit === unit);
    if (cur) cur.months += months;
    else segs.push({ unit, months });
  }
  const total = segs.reduce((a, s) => a + s.months, 0);
  if (total > 12 + 1e-9) return { error: `月数の合計が ${total} か月です (12 か月まで)` };
  return segs;
}

/** 区間 → 入力欄の文字「合志 8, 中央 4」 */
export function formatAssign(segs: AssignSegment[] | undefined, stores: { id: string; shortName?: string; name: string }[]): string {
  if (!segs) return "";
  if (!segs.length) return "対象外";
  return segs.map((s) => `${s.unit === "office" ? "事務" : (stores.find((x) => x.id === s.unit)?.shortName ?? stores.find((x) => x.id === s.unit)?.name ?? s.unit).replace(/店$/, "")} ${s.months}`).join(", ");
}
