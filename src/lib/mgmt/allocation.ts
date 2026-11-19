import type { AllocationRun, Database, StoreId } from "@/lib/db/types";
import { apportion, ratioPpm, type ApportionMethod } from "./decimal";
import { ruleAt, type RuleValue } from "./rules";
import { baseLedger, type LedgerRow } from "./ledger";
import { closedReason } from "./close";

/**
 * 共通経費の案分 (月ごと)
 * ------------------------------------------------------------
 * - 案分する経費 (pool): 共通経費に区分した経費 + 仕入明細の「共通経費」+ 手入力の共通経費
 * - 基準: 設定 alloc.basis (2025-07〜 粗利益の比率。粗利益 = 管理売上 − 材料費 − 外注費)。案分の結果は基準に入れない (循環しない)
 * - 対象の店舗: 4 店舗 (設定 alloc.include_hq で本部を含める)
 * - 基準の合計が 0 以下・マイナスの店舗があるときは保留 (held)。管理者が「指定の比率」を理由とともに選んだときだけ案分する
 * - 端数: 設定 alloc.rounding。店舗の案分額の合計は必ず共通経費の合計と一致する
 * - 確定 (confirmed) すると、基準の粗利益・率・結果・使った設定を保存する。訂正は新しい計算を確定し、前の行を superseded にする
 */

export const RUN_STATUS_LABEL: Record<AllocationRun["status"], string> = { draft: "計算中 (未確定)", held: "保留", confirmed: "確定", superseded: "訂正済み (前の確定)" };

export const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
};

export interface AllocationPreview {
  month: string;
  status: "ok" | "held" | "empty";
  holdReason?: string;
  method: AllocationRun["method"];
  targetStoreIds: StoreId[];
  pool: AllocationRun["pool"];
  poolTotal: number;
  basis: AllocationRun["basis"];
  basisTotal: number;
  results: AllocationRun["results"];
  rounding: ApportionMethod;
  rules: AllocationRun["rules"];
  basisKind: "gross" | "sales";
}

const GROSS_METRICS = new Set(["sales", "adj_internal", "adj_hq", "adj_manual"]);
const COST_METRICS = new Set(["material", "outsource"]);

/** 店舗ごとの 管理売上 と 粗利益 (元帳から。案分額は含まない) */
export function storeGross(rows: LedgerRow[]): Map<string, { sales: number; gross: number }> {
  const out = new Map<string, { sales: number; gross: number }>();
  for (const r of rows) {
    const cur = out.get(r.storeId) ?? out.set(r.storeId, { sales: 0, gross: 0 }).get(r.storeId)!;
    if (GROSS_METRICS.has(r.metric)) {
      cur.sales += r.amount;
      cur.gross += r.amount;
    } else if (COST_METRICS.has(r.metric)) cur.gross -= r.amount;
  }
  return out;
}

/** 案分の計算 (保存はしない)。manual は管理者が指定した比率 (店舗 → 重み) */
export function previewAllocation(db: Database, month: string, opts: { manual?: Record<string, number>; rows?: LedgerRow[] } = {}): AllocationPreview {
  const { from, to } = monthRange(month);
  const rows = opts.rows ?? baseLedger(db, from, to);
  const used: Record<string, RuleValue> = {
    "alloc.basis": ruleAt(db, "alloc.basis", to),
    "alloc.include_hq": ruleAt(db, "alloc.include_hq", to),
    "alloc.nonpositive": ruleAt(db, "alloc.nonpositive", to),
    "alloc.rounding": ruleAt(db, "alloc.rounding", to),
  };
  const rules: AllocationRun["rules"] = Object.fromEntries(Object.entries(used).map(([k, v]) => [k, { value: v.value, status: v.status, ruleId: v.ruleId }]));
  const basisKind = used["alloc.basis"].value === "sales" ? "sales" : "gross";
  const rounding = (used["alloc.rounding"].value === "largest_share" ? "largest_share" : "largest_remainder") as ApportionMethod;
  const targets = db.stores.filter((s) => (s.kind === "store" || used["alloc.include_hq"].value === "yes") && (!s.closedOn || s.closedOn >= `${month}-01`) && (!s.openedOn || s.openedOn <= to)).map((s) => s.id);
  const pool = rows.filter((r) => r.metric === "common_pool").map((r) => ({ source: (r.source.kind === "purchase_line" ? "purchase_line" : r.source.kind === "expense" ? "expense" : "entry") as AllocationRun["pool"][number]["source"], id: r.source.id, label: r.source.label, amount: r.amount }));
  const poolTotal = pool.reduce((a, p) => a + p.amount, 0);
  const g = storeGross(rows);
  const basis = targets.map((id) => ({ storeId: id, gross: basisKind === "sales" ? (g.get(id)?.sales ?? 0) : (g.get(id)?.gross ?? 0) }));
  const basisTotal = basis.reduce((a, b) => a + b.gross, 0);
  const base = { month, method: "gross_ratio" as AllocationRun["method"], targetStoreIds: targets, pool, poolTotal, basis, basisTotal, rounding, rules, basisKind } as const;
  if (poolTotal === 0) return { ...base, status: "empty", results: [] };

  if (opts.manual) {
    const weights = targets.map((id) => Math.max(0, Math.round(opts.manual![id] ?? 0)));
    const wsum = weights.reduce((a, b) => a + b, 0);
    if (wsum <= 0) return { ...base, method: "manual_ratio", status: "held", holdReason: "指定の比率の合計が 0 です。", results: [] };
    const amounts = apportion(poolTotal, weights, rounding);
    return { ...base, method: "manual_ratio", basis: basis.map((b, i) => ({ ...b, weight: weights[i] })), status: "ok", results: targets.map((id, i) => ({ storeId: id, ratePpm: ratioPpm(weights[i], wsum) ?? 0, amount: amounts[i] })) };
  }
  const label = basisKind === "sales" ? "売上" : "粗利益";
  if (basisTotal <= 0) return { ...base, status: "held", holdReason: `対象の店舗の${label}の合計が ${basisTotal.toLocaleString("ja-JP")} 円 (0 以下) のため、自動で案分しません。管理者が案分の方法 (指定の比率) を選んでください。`, results: [] };
  const negative = basis.filter((b) => b.gross < 0);
  if (negative.length) return { ...base, status: "held", holdReason: `${label}がマイナスの店舗があるため (${negative.map((b) => `${db.stores.find((s) => s.id === b.storeId)?.name ?? b.storeId} ${b.gross.toLocaleString("ja-JP")} 円`).join("・")})、自動で案分しません。管理者が案分の方法を選んでください。`, results: [] };
  const amounts = apportion(poolTotal, basis.map((b) => b.gross), rounding);
  return { ...base, status: "ok", results: targets.map((id, i) => ({ storeId: id, ratePpm: ratioPpm(basis[i].gross, basisTotal) ?? 0, amount: amounts[i] })) };
}

/** 確定した案分 (その月の最新の確定) */
export function confirmedRun(db: Pick<Database, "allocationRuns">, month: string): AllocationRun | undefined {
  return (db.allocationRuns ?? []).filter((r) => r.month === month && r.status === "confirmed").sort((a, b) => (b.confirmedAt ?? "").localeCompare(a.confirmedAt ?? ""))[0];
}

/**
 * 案分を確定する (mutate の中で呼ぶ)。その月の前の確定は superseded にする (訂正の履歴)。
 * 保留の計算・合計の合わない計算は確定しない
 */
export function confirmAllocation(db: Database, p: AllocationPreview, input: { id: string; number: string; userId: string; now: string; reason?: string; methodReason?: string }): AllocationRun | string {
  const closed = closedReason(db, `${p.month}-01`, "案分の確定");
  if (closed) return closed;
  if (p.status !== "ok") return p.holdReason ?? "案分する共通経費がありません。";
  const sum = p.results.reduce((a, r) => a + r.amount, 0);
  if (sum !== p.poolTotal) return `案分額の合計 (${sum}) が共通経費 (${p.poolTotal}) と一致しません。`;
  if (p.method === "manual_ratio" && !input.methodReason?.trim()) return "指定の比率で案分するときは、理由を入力してください。";
  const prev = confirmedRun(db, p.month);
  if (prev && !input.reason?.trim()) return "確定済みの案分を訂正するときは、訂正の理由を入力してください。";
  const run: AllocationRun = {
    id: input.id,
    number: input.number,
    month: p.month,
    status: "confirmed",
    method: p.method,
    methodReason: input.methodReason?.trim() || undefined,
    targetStoreIds: p.targetStoreIds,
    pool: p.pool,
    poolTotal: p.poolTotal,
    basis: p.basis,
    basisTotal: p.basisTotal,
    results: p.results,
    rounding: p.rounding,
    rules: p.rules,
    correctionOf: prev?.id,
    reason: input.reason?.trim() || undefined,
    createdBy: input.userId,
    createdAt: input.now,
    confirmedBy: input.userId,
    confirmedAt: input.now,
  };
  if (prev) {
    prev.status = "superseded";
    prev.supersededBy = run.id;
  }
  db.allocationRuns.push(run);
  return run;
}
