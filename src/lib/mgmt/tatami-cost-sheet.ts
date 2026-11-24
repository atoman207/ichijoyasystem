import type { Database, Material, MaterialCost, MaterialKind } from "@/lib/db/types";
import { readXlsx } from "@/lib/xlsx";
import { xlsxRows } from "@/lib/survey-workbook/read";
import { setMaterialCost } from "./costing";
import { round4 } from "./decimal";

/**
 * 「新原本」右上の畳材料原価単価表 (売上台帳 .xlsx)
 * ------------------------------------------------------------
 * 品・単価・数量が 3 列組で並ぶ。列の塊で種類を決める:
 *   畳縁 (heri) → 畳表い草 (omote・仮原価) → 化学畳表 (chem_omote) → 畳床 (doko) → 副資材 (sub)
 * 単価は適用開始日つきで登録し、過去の使用実績・確定した原価は変えない (setMaterialCost)。
 */

export const SHEET_NAME = "新原本";
/** 令和 7 年度の単価表 (7 月〜) の既定の適用開始日 */
export const DEFAULT_VALID_FROM = "2025-07-01";

export interface TatamiCostRow {
  name: string;
  unitCost: number;
  kind: MaterialKind;
  /** 材料コード (再取込で同じ行に当てる) */
  code: string;
  unit: string;
  itemCategory: string;
  costKind: MaterialCost["kind"];
  thickness?: number;
  size?: string;
  spec?: string;
  /** 表の列番号 (0 始まり。照合用) */
  col: number;
  row: number;
}

export interface TatamiCostPlan {
  sheet: string;
  validFrom: string;
  rows: TatamiCostRow[];
  skipped: string[];
}

const N = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, " ").trim();
const keyOf = (s: string) => N(s).replace(/[\s　]/g, "");

const SKIP_NAME = /^(品|単価|数量|副|【|※)/;

/** 列の塊 (0 = 最初の 品列) → 材料の種類。マイトスタットだけ副資材 */
function kindOf(group: number, name: string): MaterialKind | null {
  const t = keyOf(name);
  if (/^マイトスタット/.test(t)) return "sub";
  if (group <= 2) return "heri";
  if (group === 3 || group === 4) return "omote";
  if (group === 5 || group === 6) return "chem_omote";
  if (group >= 7) return "doko";
  return null;
}

function dokoMeta(name: string): { thickness?: number; size?: string; spec?: string } {
  const t = keyOf(name);
  const out: { thickness?: number; size?: string; spec?: string } = {};
  if (/AB下ぺフ|オールボード/.test(t)) out.spec = "オールボード";
  else if (/3型|三型/.test(t)) out.spec = "3型";
  const th = t.match(/(?:ぺフ|型|床)(\d{2})(?!\d)/) ?? t.match(/(\d{2})(?=五八|六〇|六一|本間)/);
  if (th) {
    const n = Number(th[1]);
    if (n >= 10 && n <= 70) out.thickness = n;
  }
  if (/五八/.test(t)) out.size = "gohachi";
  else if (/六〇/.test(t)) out.size = "rokumaru";
  else if (/六一/.test(t)) out.size = "rokuichi";
  else if (/本間/.test(t)) out.size = "honma";
  return out;
}

/** コード (再取込で安定。40 文字まで) */
export function materialCode(kind: MaterialKind, name: string): string {
  const prefix: Record<MaterialKind, string> = {
    heri: "HERI",
    omote: "OMOTE",
    chem_omote: "CHEM",
    doko: "DOKO",
    sub: "SUB",
    cloth: "CLOTH",
    paper: "PAPER",
    other: "MAT",
  };
  const body = keyOf(name)
    .replace(/（引目カラーも）/g, "")
    .replace(/[（）()・･／/]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const code = `${prefix[kind]}-${body}`;
  return code.slice(0, 40);
}

function unitOf(kind: MaterialKind): string {
  if (kind === "heri") return "枚分";
  if (kind === "sub") return "枚";
  return "枚";
}

function parsePrice(raw: string): number | undefined {
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? round4(n) : undefined;
}

/**
 * 売上台帳 .xlsx (シート「新原本」) または、すでに表にした行から単価表を読む。
 * rows を渡すときは 0 始まりの 2 次元配列 (Excel の 1 行目 = rows[0])
 */
export function parseTatamiCostSheet(input: { buf?: Buffer; rows?: string[][]; validFrom?: string; sheetName?: string }): TatamiCostPlan {
  const validFrom = input.validFrom && /^\d{4}-\d{2}-\d{2}$/.test(input.validFrom) ? input.validFrom : DEFAULT_VALID_FROM;
  let sheet = input.sheetName ?? SHEET_NAME;
  let grid = input.rows;
  if (!grid) {
    if (!input.buf) throw new Error("ファイルまたは表が必要です。");
    const sh = readXlsx(input.buf, { sheet: (n) => N(n) === SHEET_NAME })[0];
    if (!sh) throw new Error(`シート「${SHEET_NAME}」が見つかりません。`);
    sheet = sh.name;
    grid = xlsxRows(sh.rows);
  }
  const rows: TatamiCostRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  // Excel 行 10〜18 (0 始まり 9〜17)、列 V 以降 (21〜) が単価表
  for (let r = 9; r <= 17; r++) {
    const row = grid[r] ?? [];
    for (let c = 21; c <= 55; c += 3) {
      const name = N(String(row[c] ?? ""));
      if (!name || SKIP_NAME.test(name)) continue;
      const price = parsePrice(String(row[c + 1] ?? ""));
      if (price === undefined) {
        skipped.push(`${name} (単価なし)`);
        continue;
      }
      const group = Math.floor((c - 21) / 3);
      const kind = kindOf(group, name);
      if (!kind) {
        skipped.push(name);
        continue;
      }
      const code = materialCode(kind, name);
      if (seen.has(code)) continue;
      seen.add(code);
      const doko = kind === "doko" ? dokoMeta(name) : {};
      rows.push({
        name,
        unitCost: price,
        kind,
        code,
        unit: unitOf(kind),
        itemCategory: "tatami",
        costKind: kind === "omote" ? "provisional" : "standard",
        thickness: doko.thickness,
        size: doko.size,
        spec: doko.spec,
        col: c,
        row: r + 1,
      });
    }
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "ja"));
  return { sheet, validFrom, rows, skipped };
}

export interface ApplyTatamiCostResult {
  added: number;
  updated: number;
  costs: number;
  unchanged: number;
  codes: string[];
}

function findMaterial(db: Database, row: TatamiCostRow): Material | undefined {
  return db.materials.find((m) => m.code === row.code) ?? db.materials.find((m) => m.kind === row.kind && keyOf(m.name) === keyOf(row.name));
}

/** いま有効な単価と同じなら新しい行を足さない */
function sameCost(db: Database, materialId: string, validFrom: string, unitCost: number, kind: MaterialCost["kind"]): boolean {
  const cur = (db.materialCosts ?? [])
    .filter((c) => c.materialId === materialId && c.validFrom <= validFrom && (!c.validTo || validFrom <= c.validTo))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom) || b.createdAt.localeCompare(a.createdAt))[0];
  return Boolean(cur && cur.unitCost === unitCost && cur.kind === kind);
}

/**
 * 単価表を材料マスタへ反映 (mutate の中で呼ぶ)。
 * 既存の材料は名前・仕様を整え、単価が変わったときだけ新しい適用開始日の行を足す。
 */
export function applyTatamiCostPlan(
  db: Database,
  plan: TatamiCostPlan,
  opts: { userId: string; now: string; makeId: (prefix: string) => string; forceCost?: boolean },
): ApplyTatamiCostResult {
  let added = 0;
  let updated = 0;
  let costs = 0;
  let unchanged = 0;
  const codes: string[] = [];
  for (const row of plan.rows) {
    let m = findMaterial(db, row);
    if (!m) {
      m = {
        id: opts.makeId("mat"),
        code: row.code,
        name: row.name,
        kind: row.kind,
        unit: row.unit,
        itemCategory: row.itemCategory,
        thickness: row.thickness,
        size: row.size,
        spec: row.spec,
        active: true,
        createdAt: opts.now,
        updatedAt: opts.now,
        note: `新原本 単価表 (${plan.sheet})`,
      };
      db.materials.push(m);
      added++;
    } else {
      const before = JSON.stringify({ name: m.name, kind: m.kind, unit: m.unit, thickness: m.thickness, size: m.size, spec: m.spec, active: m.active });
      m.name = row.name;
      m.kind = row.kind;
      m.unit = row.unit;
      m.itemCategory = row.itemCategory;
      if (row.thickness !== undefined) m.thickness = row.thickness;
      if (row.size) m.size = row.size;
      if (row.spec) m.spec = row.spec;
      m.active = true;
      m.updatedAt = opts.now;
      if (m.code !== row.code && !db.materials.some((x) => x.code === row.code && x.id !== m!.id)) m.code = row.code;
      const after = JSON.stringify({ name: m.name, kind: m.kind, unit: m.unit, thickness: m.thickness, size: m.size, spec: m.spec, active: m.active });
      if (before !== after) updated++;
    }
    codes.push(m.code);
    if (!opts.forceCost && sameCost(db, m.id, plan.validFrom, row.unitCost, row.costKind)) {
      unchanged++;
      continue;
    }
    setMaterialCost(db, { materialId: m.id, unitCost: row.unitCost, kind: row.costKind, validFrom: plan.validFrom, note: `新原本 ${plan.sheet}` }, opts.userId, opts.makeId("mc"), opts.now);
    costs++;
  }
  return { added, updated, costs, unchanged, codes };
}

/** CSV (画面の一括取込と同じ列) に書き出す */
export function tatamiCostCsv(plan: TatamiCostPlan): string {
  const lines = ["コード,名前,種類,単位,品目,単価,単価の種類,適用開始日,厚み,規格,仕入先の品番"];
  for (const r of plan.rows) {
    lines.push([r.code, r.name, r.kind, r.unit, r.itemCategory, String(r.unitCost), r.costKind, plan.validFrom, r.thickness ?? "", r.size ?? "", ""].join(","));
  }
  return lines.join("\n") + "\n";
}
