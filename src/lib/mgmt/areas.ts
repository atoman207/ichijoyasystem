import type { Database, SalesArea, StoreId } from "@/lib/db/types";
import { cleanAddressText } from "@/lib/maps/address";
import { prevDay } from "./rules";

/**
 * 営業エリア (町名 → 担当店舗) と、住所からの判定
 * ------------------------------------------------------------
 * - 予定表スプレッドシートの「地域一覧」(店舗名・町名) を取り込む。町名は「下硯川町」のような町の名前と、
 *   「菊陽」「大津」のような市町村の名前が混ざっているため、住所の中に含まれるかで判定し、一番長く一致したものを使う
 * - 同じ長さで別の店舗に一致したとき・どれにも一致しないときは判定しない (要確認)。売上の帰属は施工店舗が優先で、
 *   営業エリアは初期候補 (受注店舗・内部受注の判定の参考) にだけ使う
 * - 変更は新しい行を足し、前の行は終了日で閉じる (履歴が残る)
 */

const STORE_ALIASES: Record<string, StoreId> = {
  合志: "koshi",
  中央: "chuo",
  水前寺: "chuo",
  西: "nishi",
  玉名: "tamana",
  本部: "hq",
  本社: "hq",
};

/** 「合志店」「水前寺店」(中央店の旧名) などの店舗名 → 店舗 ID */
export function storeIdOfName(db: Pick<Database, "stores">, name: string): StoreId | undefined {
  const n = name.replace(/[\s　]/g, "");
  const exact = db.stores.find((s) => s.name === n || s.shortName === n || s.id === n);
  if (exact) return exact.id;
  const key = n.replace(/店$/, "").replace(/・.*$/, "");
  return STORE_ALIASES[key] ?? db.stores.find((s) => key && (s.name.startsWith(key) || s.shortName === key))?.id;
}

const norm = (s: string) => cleanAddressText(s).replace(/[\s　]/g, "").replace(/^熊本県/, "");

/** 地域の名前の比べ方 (末尾の「町」「村」は付いていてもいなくても同じ) */
const variants = (town: string) => {
  const t = norm(town);
  const base = t.replace(/[町村]$/, "");
  return [...new Set([t, base].filter((x) => x.length >= 2))];
};

export function activeAreas(db: Pick<Database, "salesAreas">, date: string): SalesArea[] {
  return (db.salesAreas ?? []).filter((a) => a.validFrom <= date && (!a.validTo || date <= a.validTo));
}

export interface AreaMatch {
  storeId?: StoreId;
  /** 一致した地域の名前 */
  key?: string;
  status: "matched" | "ambiguous" | "unmatched" | "no_address";
  candidates: { storeId: StoreId; town: string }[];
}

/** 住所 (施工場所またはお客様の住所) から営業エリアの担当店舗を判定する */
export function matchArea(db: Pick<Database, "salesAreas">, address: string | undefined, date: string): AreaMatch {
  const addr = norm(address ?? "");
  if (!addr) return { status: "no_address", candidates: [] };
  let best = 0;
  let hits: { storeId: StoreId; town: string }[] = [];
  for (const a of activeAreas(db, date)) {
    const where = a.municipality ? `${norm(a.municipality)}${norm(a.town)}` : "";
    for (const v of variants(a.town)) {
      const hit = (where && addr.includes(where)) || addr.includes(v);
      if (!hit) continue;
      const len = where && addr.includes(where) ? where.length : v.length;
      if (len > best) {
        best = len;
        hits = [{ storeId: a.storeId, town: a.town }];
      } else if (len === best && !hits.some((h) => h.storeId === a.storeId && h.town === a.town)) hits.push({ storeId: a.storeId, town: a.town });
    }
  }
  const stores = [...new Set(hits.map((h) => h.storeId))];
  if (!hits.length) return { status: "unmatched", candidates: [] };
  if (stores.length > 1) return { status: "ambiguous", candidates: hits };
  return { status: "matched", storeId: stores[0], key: hits[0].town, candidates: hits };
}

export interface AreaImportPlan {
  rows: { storeId: StoreId; town: string; sourceRef: string }[];
  /** 店舗名が分からない行・重複・別の店舗に重なる町名 */
  problems: string[];
  byStore: Record<string, number>;
}

/** 地域一覧の行 (店舗名・町名) を確かめる */
export function planAreaImport(db: Pick<Database, "stores">, input: { store: string; town: string; ref: string }[]): AreaImportPlan {
  const rows: AreaImportPlan["rows"] = [];
  const problems: string[] = [];
  const seen = new Map<string, StoreId>();
  for (const r of input) {
    const town = r.town.replace(/[\s　]/g, "");
    if (!town) continue;
    const storeId = storeIdOfName(db, r.store);
    if (!storeId) {
      problems.push(`${r.ref}: 店舗「${r.store}」が分かりません (取り込みません)`);
      continue;
    }
    const prev = seen.get(town);
    if (prev) {
      problems.push(prev === storeId ? `${r.ref}: 「${town}」が重複しています (1 つにまとめます)` : `${r.ref}: 「${town}」が別の店舗にもあります (住所の判定は要確認になります)`);
      if (prev === storeId) continue;
    }
    seen.set(town, storeId);
    rows.push({ storeId, town, sourceRef: r.ref });
  }
  const byStore: Record<string, number> = {};
  for (const r of rows) byStore[r.storeId] = (byStore[r.storeId] ?? 0) + 1;
  for (const s of db.stores) if (s.kind === "store" && !byStore[s.id]) problems.push(`${s.name}の地域がありません (この店舗の地域は判定できません)`);
  return { rows, problems, byStore };
}

/**
 * 取り込んだ地域一覧で置き換える (mutate の中で呼ぶ)。前に取り込んだ行・手で足した行は、適用開始日の前日で閉じる
 */
export function applyAreaImport(db: Database, plan: AreaImportPlan, validFrom: string, userId: string, now: string, makeId: () => string, sourceName: string): number {
  for (const a of db.salesAreas) if (!a.validTo || a.validTo >= validFrom) a.validTo = a.validFrom >= validFrom ? prevDay(a.validFrom) : prevDay(validFrom);
  for (const r of plan.rows) {
    db.salesAreas.push({ id: makeId(), municipality: "", town: r.town, storeId: r.storeId, validFrom, source: "import", sourceRef: `${sourceName} ${r.sourceRef}`, createdBy: userId, createdAt: now });
  }
  return plan.rows.length;
}
