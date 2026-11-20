import type { Database, StockMove, StoreId } from "@/lib/db/types";
import { dec4, divRound, fmtDec4, qtyTimesCost, round4 } from "./decimal";
import { correctionDate } from "./close";

/**
 * 在庫と材料の移動
 * ------------------------------------------------------------
 * - 場所: "store:<店舗 ID>" (本部の倉庫は store:hq)。外の場所は "supplier" (仕入先) / "order:<受注 ID>" (案件で使用) / "disposal" (廃棄) / "adjust" (棚卸の差)
 * - 種類ごとの移動元 → 移動先:
 *   受入 receive: supplier → store / 移動 transfer: store → store / 使用 use: store → order / 返品 return: store → supplier /
 *   廃棄 dispose: store → disposal / 棚卸の調整 adjust: adjust → store (増) または store → adjust (減)
 * - 店舗間の移動は在庫を動かすだけ。全社の在庫の数量・金額は変わらず、材料費 (原価) にもならない。
 *   案件の材料費は材料の使用の行 (costing.ts) で数え、使用の移動は在庫を減らすだけ (二重に原価にしない)
 * - 取消しは逆向きの移動を足す (元の行は消さない)
 */

export const MOVE_KIND_LABEL: Record<StockMove["kind"], string> = {
  receive: "受入 (仕入)",
  transfer: "店舗間の移動",
  use: "案件への使用",
  return: "返品",
  dispose: "廃棄",
  adjust: "棚卸の調整",
};

export const storeLoc = (id: StoreId | string) => `store:${id}`;
export const locStore = (loc: string | undefined): string | undefined => (loc?.startsWith("store:") ? loc.slice(6) : undefined);

export function locLabel(db: Pick<Database, "stores" | "orders">, loc: string | undefined): string {
  if (!loc) return "-";
  if (loc === "supplier") return "仕入先";
  if (loc === "disposal") return "廃棄";
  if (loc === "adjust") return "棚卸の調整";
  // 縁在庫の画面 (src/lib/heri-stock.ts) で案件を指定せずに登録した使用
  if (loc === "used") return "使用 (案件の指定なし)";
  if (loc.startsWith("store:")) return db.stores.find((s) => s.id === loc.slice(6))?.name ?? loc.slice(6);
  if (loc.startsWith("order:")) return `案件 ${db.orders.find((o) => o.id === loc.slice(6))?.number ?? loc.slice(6)}`;
  return loc;
}

/** 種類に合った移動元・移動先か (誤りなら理由) */
export function validateMove(m: Pick<StockMove, "kind" | "fromLoc" | "toLoc" | "qty" | "unitCost" | "orderId">): string | null {
  if (!(m.qty > 0)) return "数量は 0 より大きい数で入力してください。";
  if (!(m.unitCost >= 0)) return "単価は 0 以上で入力してください。";
  const from = m.fromLoc ?? "";
  const to = m.toLoc ?? "";
  const isStore = (l: string) => l.startsWith("store:");
  switch (m.kind) {
    case "receive":
      return from === "supplier" && isStore(to) ? null : "受入は 仕入先 → 店舗 (本部) です。";
    case "transfer":
      return isStore(from) && isStore(to) && from !== to ? null : "移動は 店舗 → 別の店舗 です。";
    case "use":
      return isStore(from) && to.startsWith("order:") && m.orderId ? null : "使用は 店舗 → 案件 です (案件を選んでください)。";
    case "return":
      return isStore(from) && to === "supplier" ? null : "返品は 店舗 → 仕入先 です。";
    case "dispose":
      return isStore(from) && to === "disposal" ? null : "廃棄は 店舗 → 廃棄 です。";
    case "adjust":
      return (from === "adjust" && isStore(to)) || (isStore(from) && to === "adjust") ? null : "棚卸の調整は 調整 → 店舗 (増) か 店舗 → 調整 (減) です。";
  }
}

/** 閲覧範囲の店舗 (受入・移動・増の調整は移動先、それ以外は移動元) */
export function moveStore(m: Pick<StockMove, "kind" | "fromLoc" | "toLoc">): string | undefined {
  if (m.kind === "receive" || m.kind === "transfer" || (m.kind === "adjust" && m.fromLoc === "adjust")) return locStore(m.toLoc);
  return locStore(m.fromLoc);
}

export function moveAmount(qty: number, unitCost: number): number {
  return qtyTimesCost(qty, unitCost, "round");
}

export interface StockBalance {
  storeId: string;
  materialId: string;
  /** 数量 (小数 4 桁) と金額 (円) */
  qty: number;
  amount: number;
}

/** 在庫 (店舗 × 材料)。asOf の日までの確定した移動 (取消しの行も含む) を足し引きする */
export function stockBalances(db: Pick<Database, "stockMoves">, asOf?: string): StockBalance[] {
  const map = new Map<string, { storeId: string; materialId: string; q: bigint; a: number }>();
  const touch = (loc: string | undefined, materialId: string, sign: 1 | -1, q: bigint, a: number) => {
    const s = locStore(loc);
    if (!s) return;
    const k = `${s}|${materialId}`;
    const cur = map.get(k) ?? map.set(k, { storeId: s, materialId, q: BigInt(0), a: 0 }).get(k)!;
    cur.q += sign > 0 ? q : -q;
    cur.a += sign * a;
  };
  for (const m of db.stockMoves ?? []) {
    if (m.status === "draft") continue;
    if (asOf && m.date > asOf) continue;
    const q = dec4(m.qty);
    touch(m.fromLoc, m.materialId, -1, q, m.amount);
    touch(m.toLoc, m.materialId, 1, q, m.amount);
  }
  return [...map.values()].map((v) => ({ storeId: v.storeId, materialId: v.materialId, qty: Number(fmtDec4(v.q)), amount: v.a }));
}

/** 移動平均の単価 (その店舗の在庫の金額 ÷ 数量)。在庫がなければ undefined */
export function averageCost(db: Pick<Database, "stockMoves">, storeId: string, materialId: string, asOf?: string): number | undefined {
  const b = stockBalances(db, asOf).find((x) => x.storeId === storeId && x.materialId === materialId);
  if (!b || !(b.qty > 0)) return undefined;
  // 金額 × 10^8 ÷ (数量 × 10^4) = 単価 × 10^4
  return Number(fmtDec4(divRound(BigInt(b.amount) * BigInt(100000000), dec4(b.qty), "round")));
}

/** 全社の在庫の合計 (数量・金額)。店舗間の移動では変わらない */
export function stockTotals(db: Pick<Database, "stockMoves">, asOf?: string): { qty: Map<string, number>; amount: number } {
  const qty = new Map<string, bigint>();
  let amount = 0;
  for (const b of stockBalances(db, asOf)) {
    qty.set(b.materialId, (qty.get(b.materialId) ?? BigInt(0)) + dec4(b.qty));
    amount += b.amount;
  }
  return { qty: new Map([...qty].map(([k, v]) => [k, Number(fmtDec4(v))])), amount };
}

/** 移動を登録する (mutate の中で呼ぶ)。金額は 数量 × 単価 */
export function postMove(db: Database, input: Omit<StockMove, "amount" | "storeId" | "status" | "createdAt"> & { status?: StockMove["status"]; createdAt: string }): StockMove {
  const row: StockMove = {
    ...input,
    qty: round4(input.qty),
    unitCost: round4(input.unitCost),
    amount: moveAmount(input.qty, input.unitCost),
    storeId: (moveStore(input) ?? "hq") as StoreId,
    status: input.status ?? "confirmed",
  };
  db.stockMoves.push(row);
  return row;
}

/** 移動を取り消す: 逆向きの移動を足す (元の行に reversedBy)。確定した月の行は設定に従う */
export function reverseMove(db: Database, m: StockMove, input: { id: string; number: string; userId: string; now: string; today: string; reason: string }): StockMove | string {
  if (m.status !== "confirmed" || m.reversalOf) return "この移動は取り消せません (取消し済み、または取消しの行です)。";
  const date = correctionDate(db, m.date, input.today);
  if (date === null) return `${m.date.slice(0, 7)} は月次確定済みです。管理者が確定を解除してから取り消してください。`;
  const rev: StockMove = { ...m, id: input.id, number: input.number, date, fromLoc: m.toLoc, toLoc: m.fromLoc, status: "confirmed", reversalOf: m.id, reversedBy: undefined, note: `取消し: ${input.reason}`, createdBy: input.userId, createdAt: input.now, approvedBy: undefined, approvedAt: undefined };
  m.status = "reversed";
  m.reversedBy = rev.id;
  db.stockMoves.push(rev);
  return rev;
}

/**
 * 材料移動の月の集計 (材料移動のスプレッドシートに当たる表): 店舗 × 材料ごとの 受入・移動の入り・移動の出・使用・廃棄・返品・調整 の数量と金額
 */
export function monthlyMovement(db: Pick<Database, "stockMoves">, month: string) {
  const rows = new Map<string, { storeId: string; materialId: string; cols: Record<string, { qty: number; amount: number }> }>();
  const add = (storeId: string | undefined, materialId: string, col: string, qty: number, amount: number) => {
    if (!storeId) return;
    const k = `${storeId}|${materialId}`;
    const r = rows.get(k) ?? rows.set(k, { storeId, materialId, cols: {} }).get(k)!;
    const c = (r.cols[col] ??= { qty: 0, amount: 0 });
    c.qty = round4(c.qty + qty);
    c.amount += amount;
  };
  for (const m of db.stockMoves ?? []) {
    if (m.status === "draft" || !m.date.startsWith(month)) continue;
    const from = locStore(m.fromLoc);
    const to = locStore(m.toLoc);
    // 取消しの行は向きが逆なので、元の種類の列にマイナスで入れる
    const sign = m.reversalOf ? -1 : 1;
    const [src, dst] = m.reversalOf ? [to, from] : [from, to];
    switch (m.kind) {
      case "receive":
        add(dst, m.materialId, "receive", sign * m.qty, sign * m.amount);
        break;
      case "transfer":
        add(dst, m.materialId, "in", sign * m.qty, sign * m.amount);
        add(src, m.materialId, "out", sign * m.qty, sign * m.amount);
        break;
      case "adjust":
        if (dst) add(dst, m.materialId, "adjust", sign * m.qty, sign * m.amount);
        else add(src, m.materialId, "adjust", -sign * m.qty, -sign * m.amount);
        break;
      default:
        add(src, m.materialId, m.kind, sign * m.qty, sign * m.amount);
    }
  }
  return [...rows.values()];
}
