import type { Database, MgmtEntry, StoreId } from "@/lib/db/types";
import { apportion, ratioPpm, type ApportionMethod } from "./decimal";
import { ruleAt, type RuleValue } from "./rules";
import { baseLedger, basisFromExTax, type LedgerRow } from "./ledger";
import { monthRange, storeGross } from "./allocation";
import { closedReason } from "./close";

/**
 * 畳表 (い草) の仮原価と実際の仕入の差額
 * ------------------------------------------------------------
 * 畳表は相場で仕入値が変わるため、店舗には商品ごとの仮原価 (材料の単価の「仮原価」) × 使用数量 で材料費を計上する。
 * 実際の仕入金額との差額は、各店舗の粗利益の比率で案分する (お客様のご説明 2026-11-23。設定 omote.diff_method)。
 * - 実際の仕入金額: 期間の畳表の在庫の受入 (仕入明細を「在庫」で確定したもの。取消しは差し引く)
 * - 仮原価で計上した金額: 期間の材料費のうち畳表の行 (材料の使用の行・自動計算)
 * - 案分の基準: 期間の各店舗の粗利益 (管理売上 − 材料費 − 外注費。この差額自体は基準に入れない)。対象の店舗は共通経費の案分と同じ
 * - 期間は管理者が選ぶ (毎月・四半期・決算期)。仕入と使用の月がずれると 1 か月の差額は大きく振れるため、長めの期間でもよい
 * - 確定すると、店舗ごとの差額を手入力の「材料の差額調整」(品目 = 畳) として期間の最後の月に登録する。
 *   行の metric に期間 (omote_diff:<開始月>:<終了月>) を持たせ、重なる期間の二重の確定を断る。取消しは逆の行
 */

export const omoteDiffKey = (fromMonth: string, toMonth: string) => `omote_diff:${fromMonth}:${toMonth}`;

export function parseOmoteDiffKey(metric: string | undefined): { from: string; to: string } | null {
  const m = metric?.match(/^omote_diff:(\d{4}-\d{2}):(\d{4}-\d{2})$/);
  return m ? { from: m[1], to: m[2] } : null;
}

export interface OmoteDiffPreview {
  fromMonth: string;
  toMonth: string;
  method: RuleValue;
  status: "ok" | "held" | "empty" | "off";
  holdReason?: string;
  /** 実際の仕入金額 (表示の金額。既定は税抜) と、受入の件数 */
  purchases: number;
  receiveCount: number;
  /** 仮原価で計上した金額と、行の数 */
  booked: number;
  bookedCount: number;
  /** 差額 (実際の仕入 − 仮原価の計上。正 = 店舗の材料費を増やす) */
  diff: number;
  targetStoreIds: StoreId[];
  basis: { storeId: StoreId; gross: number }[];
  basisTotal: number;
  results: { storeId: StoreId; ratePpm: number; amount: number }[];
  rounding: ApportionMethod;
  /** 重なる期間ですでに確定した差額 (あれば二重に確定しない) */
  overlap?: string;
}

/** 確定済みの (取り消していない) 差額の行 */
export function omoteDiffEntries(db: Pick<Database, "mgmtEntries">): MgmtEntry[] {
  return (db.mgmtEntries ?? []).filter((e) => e.kind === "material_adjust" && e.status === "active" && !e.reversalOf && parseOmoteDiffKey(e.metric));
}

/** 期間の差額の計算 (保存はしない) */
export function previewOmoteDiff(db: Database, fromMonth: string, toMonth: string, opts: { rows?: LedgerRow[] } = {}): OmoteDiffPreview {
  const from = monthRange(fromMonth).from;
  const to = monthRange(toMonth).to;
  const method = ruleAt(db, "omote.diff_method", to);
  const rounding = (ruleAt(db, "alloc.rounding", to).value === "largest_share" ? "largest_share" : "largest_remainder") as ApportionMethod;
  const includeHq = ruleAt(db, "alloc.include_hq", to).value === "yes";
  // 確定済みの差額の行は基準・計上額に入れない (確定のあとに計算し直しても同じ結果)
  const diffIds = new Set(omoteDiffEntries(db).map((e) => e.id));
  const rows = (opts.rows ?? baseLedger(db, from, to)).filter((r) => !(r.source.kind === "entry" && diffIds.has(r.source.id)));

  const omoteIds = new Set((db.materials ?? []).filter((m) => m.kind === "omote").map((m) => m.id));
  let purchases = 0;
  let receiveCount = 0;
  for (const m of db.stockMoves ?? []) {
    if (m.kind !== "receive" || m.status === "draft" || !omoteIds.has(m.materialId) || m.date < from || m.date > to) continue;
    purchases += basisFromExTax(db, m.amount, m.date) * (m.reversalOf ? -1 : 1);
    receiveCount++;
  }
  const omoteRows = rows.filter((r) => r.metric === "material" && r.materialKind === "omote");
  const booked = omoteRows.reduce((a, r) => a + r.amount, 0);
  const diff = purchases - booked;

  const targets = db.stores.filter((s) => (s.kind === "store" || includeHq) && (!s.closedOn || s.closedOn >= from) && (!s.openedOn || s.openedOn <= to)).map((s) => s.id);
  const g = storeGross(rows);
  const basis = targets.map((id) => ({ storeId: id, gross: g.get(id)?.gross ?? 0 }));
  const basisTotal = basis.reduce((a, b) => a + b.gross, 0);
  const overlapRow = omoteDiffEntries(db).find((e) => {
    const p = parseOmoteDiffKey(e.metric)!;
    return p.from <= toMonth && fromMonth <= p.to;
  });
  const overlap = overlapRow ? `${parseOmoteDiffKey(overlapRow.metric)!.from}〜${parseOmoteDiffKey(overlapRow.metric)!.to} の差額を確定済みです (期間が重なります)` : undefined;
  const base = { fromMonth, toMonth, method, purchases, receiveCount, booked, bookedCount: omoteRows.length, diff, targetStoreIds: targets, basis, basisTotal, rounding, overlap } as const;

  if (method.value !== "gross_ratio") return { ...base, status: "off", holdReason: method.value === "manual" ? "設定が「担当者が差額を手入力」のため、自動で案分しません (手入力のタブで店舗ごとに登録してください)。" : "設定が「未確定」のため計算しません。", results: [] };
  if (!receiveCount && !omoteRows.length) return { ...base, status: "empty", results: [] };
  if (diff === 0) return { ...base, status: "empty", results: [] };
  if (basisTotal <= 0) return { ...base, status: "held", holdReason: `対象の店舗の粗利益の合計が ${basisTotal.toLocaleString("ja-JP")} 円 (0 以下) のため、自動で案分しません。期間を広げるか、手入力で登録してください。`, results: [] };
  const negative = basis.filter((b) => b.gross < 0);
  if (negative.length) return { ...base, status: "held", holdReason: `粗利益がマイナスの店舗があるため (${negative.map((b) => `${db.stores.find((s) => s.id === b.storeId)?.name ?? b.storeId} ${b.gross.toLocaleString("ja-JP")} 円`).join("・")})、自動で案分しません。期間を広げるか、手入力で登録してください。`, results: [] };
  const amounts = apportion(diff, basis.map((b) => b.gross), rounding);
  return { ...base, status: "ok", results: targets.map((id, i) => ({ storeId: id, ratePpm: ratioPpm(basis[i].gross, basisTotal) ?? 0, amount: amounts[i] })) };
}

/** 差額を確定する (mutate の中で呼ぶ)。店舗ごとの「材料の差額調整」の行を登録する。誤りなら理由を返す */
export function confirmOmoteDiff(db: Database, p: OmoteDiffPreview, input: { userId: string; now: string; makeId: () => string }): MgmtEntry[] | string {
  if (p.status !== "ok") return p.holdReason ?? "確定する差額がありません。";
  if (p.overlap) return `${p.overlap}。先に取り消してから確定してください。`;
  const closed = closedReason(db, `${p.toMonth}-01`, "畳表の差額の確定");
  if (closed) return closed;
  const sum = p.results.reduce((a, r) => a + r.amount, 0);
  if (sum !== p.diff) return `案分額の合計 (${sum}) が差額 (${p.diff}) と一致しません。`;
  const key = omoteDiffKey(p.fromMonth, p.toMonth);
  const note = `畳表の差額 ${p.fromMonth}〜${p.toMonth} (実際の仕入 ${p.purchases.toLocaleString("ja-JP")} 円 − 仮原価の計上 ${p.booked.toLocaleString("ja-JP")} 円 = ${p.diff.toLocaleString("ja-JP")} 円を粗利益の比率で案分)`;
  const rows: MgmtEntry[] = p.results
    .filter((r) => r.amount !== 0)
    .map((r) => ({ id: input.makeId(), month: p.toMonth, storeId: r.storeId, kind: "material_adjust", metric: key, itemCategory: "tatami", amount: r.amount, note, status: "active", createdBy: input.userId, createdAt: input.now }));
  db.mgmtEntries.push(...rows);
  return rows;
}

/** 確定した差額を取り消す (mutate の中で呼ぶ)。期間の行ごとに逆の行を足す */
export function reverseOmoteDiff(db: Database, key: string, input: { userId: string; now: string; makeId: () => string; reason: string }): MgmtEntry[] | string {
  const p = parseOmoteDiffKey(key);
  if (!p) return "差額の期間が正しくありません。";
  const closed = closedReason(db, `${p.to}-01`, "畳表の差額の取消し");
  if (closed) return closed;
  const targets = omoteDiffEntries(db).filter((e) => e.metric === key);
  if (!targets.length) return "取り消す差額の行がありません。";
  const revs: MgmtEntry[] = targets.map((e) => ({ ...e, id: input.makeId(), amount: -e.amount, reversalOf: e.id, reversedBy: undefined, note: `取消し: ${input.reason} (${e.note ?? ""})`, createdBy: input.userId, createdAt: input.now }));
  for (const e of targets) {
    e.status = "reversed";
    e.reversedBy = revs.find((r) => r.reversalOf === e.id)!.id;
  }
  db.mgmtEntries.push(...revs);
  return revs;
}
