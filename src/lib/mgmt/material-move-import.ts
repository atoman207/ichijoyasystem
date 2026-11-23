import { createHash } from "node:crypto";
import type { Database, MaterialTransfer, SalesAdjustment, StoreId } from "@/lib/db/types";
import type { XlsxSheet } from "@/lib/xlsx";
import { storeIdOfName } from "./areas";
import { closedReason } from "./close";

/**
 * これまでの「材料移動」の表 (.xlsx・月ごとのシート「2026.10」など) の取込
 * ------------------------------------------------------------
 * 店舗ごとの欄のうち、次を取り込む (金額は表のとおり税別):
 * - 襖材料・自社商品の欄 → 店舗間の材料移動 (原価の振替。material_transfers)。相手の店舗は備考 (「本部より」「合志店より」「本部へ」)、
 *   備考がなければ工場 (合志店) とする (表の決まり「支店から工場 (合志店) への材料移動はマイナスで計上」)。マイナスの行は向きを逆にする
 * - 内部受注の欄 → 店舗間の売上の調整 (sales_adjustments)。表の決まり「仕事をあげた側に記入」: その店舗が受け取る (+)、相手の店舗から引く。
 *   相手が本部なら本部の特殊配分 (店舗への売上の配分)、それ以外は手入力の調整 (過去の内部受注)。相手が分からない行は取り込まない
 * 取り込まないもの (件数と金額を報告する): その他の欄 (消耗品・販促品など。今後は案分経費) / 畳原価の合計 (移行した受注の畳原価にある) /
 * 相手の店舗が分からない行 / 月次確定済みの月 / すでに取り込んだ行
 * 古い表には同じ移動を両方の店舗の欄に書いた (+ と −) ものがあるため、同じ月・店舗の組・品名・金額の行は 1 件にまとめる
 */

export interface MoveImportRow {
  kind: "transfer" | "internal";
  sheet: string;
  month: string;
  date: string;
  /** transfer: 渡した店舗 → 受け取った店舗 / internal: 受け取る店舗 (+) ← 引かれる店舗 (−) */
  fromStoreId: StoreId;
  toStoreId: StoreId;
  name: string;
  qty: number;
  unitCost: number;
  amount: number;
  itemCategory: string;
  /** 元の行 (シート/店舗/行/欄) */
  ref: string;
  note?: string;
}

export interface MoveImportPlan {
  hash: string;
  fileName: string;
  sheets: number;
  rows: MoveImportRow[];
  skipped: { reason: string; count: number; amount: number; examples: string[] }[];
  createdAt: string;
}

const ALIASES: Record<string, StoreId> = { 工場: "koshi", 工場店: "koshi", 熊本中央: "chuo", 熊本中央店: "chuo", 水前寺: "chuo", 水前寺店: "chuo", 本部店: "hq", 本社: "hq" };

function storeOf(db: Pick<Database, "stores">, name: string): StoreId | undefined {
  const n = name.replace(/[\s　]/g, "");
  return ALIASES[n] ?? ALIASES[n.replace(/店$/, "")] ?? storeIdOfName(db, n);
}

/**
 * 備考から相手の店舗と向き (より/から = 相手から受け取った、へ/に = 相手へ渡した)。
 * 自分の店舗の名前が先に書かれていても (例: 「工場から本部販促費へ」)、自分以外の店舗を相手にする
 */
export function counterpartOf(db: Pick<Database, "stores">, note: string, self?: StoreId): { storeId?: StoreId; direction?: "from" | "to" } {
  const t = note.replace(/[\s　]/g, "");
  for (const m of t.matchAll(/(本部|本社|工場|合志|熊本中央|中央|水前寺|西|玉名)店?(より|から|へ|に)?/g)) {
    const storeId = storeOf(db, m[1]);
    if (!storeId || storeId === self) continue;
    const rest = t.slice((m.index ?? 0) + m[0].length);
    const suffix = m[2] ?? (/^[^より|から]*(へ|に)/.test(rest) ? "へ" : undefined);
    return { storeId, direction: suffix === "へ" || suffix === "に" ? "to" : suffix ? "from" : undefined };
  }
  return {};
}

const colIndex = (col: string) => [...col].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === "") return NaN;
  const n = Number(v.replace(/[,¥円\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
/** Excel の日付の数 → YYYY-MM-DD */
const excelDate = (v: string | undefined) => {
  const n = num(v);
  if (!Number.isFinite(n) || n < 30000 || n > 80000) return undefined;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
};

interface Block {
  start: number;
  title: string;
  cols: Record<string, number>;
  lastDate?: string;
}

export function planMaterialMoveImport(db: Database, sheets: XlsxSheet[], meta: { hash: string; fileName: string; now: string }): MoveImportPlan {
  const rows: MoveImportRow[] = [];
  const skip = new Map<string, { count: number; amount: number; examples: string[] }>();
  const skipped = (reason: string, amount: number, example: string) => {
    const s = skip.get(reason) ?? skip.set(reason, { count: 0, amount: 0, examples: [] }).get(reason)!;
    s.count++;
    s.amount += Math.round(amount);
    if (s.examples.length < 4) s.examples.push(example);
  };
  let sheetCount = 0;
  for (const sheet of sheets) {
    const sm = sheet.name.trim().match(/^(\d{4})\.(\d{1,2})$/);
    if (!sm) continue;
    sheetCount++;
    const month = `${sm[1]}-${sm[2].padStart(2, "0")}`;
    let store: StoreId | undefined;
    let storeName = "";
    let blocks: Block[] = [];
    const lines = [...sheet.rows.keys()].sort((a, b) => a - b);
    for (const r of lines) {
      const row = sheet.rows.get(r)!;
      const cells = [...row.entries()];
      const a = (row.get("A") ?? "").trim();
      // 店舗の見出しの行 (A 列だけ)
      if (cells.length === 1 && a && /店$|^工場$/.test(a)) {
        store = storeOf(db, a);
        storeName = a;
        blocks = [];
        if (!store) skipped("店舗名が分からない欄", 0, `${sheet.name} ${a}`);
        continue;
      }
      // 欄の見出しの行 (「日付」の列が欄の始まり。1 つ上の行が欄の名前)
      const heads = cells.filter(([, v]) => v.trim() === "日付");
      if (heads.length) {
        const above = sheet.rows.get(r - 1);
        blocks = heads.map(([c]) => {
          const start = colIndex(c);
          const cols: Record<string, number> = {};
          for (let k = start; k < start + 7; k++) {
            const h = row.get(colName(k))?.trim();
            if (!h) {
              if (k > start) break;
              continue;
            }
            if (!(h in cols)) cols[h] = k;
          }
          return { start, title: (above?.get(c) ?? "").trim(), cols };
        });
        continue;
      }
      // 畳原価の合計の行
      if (cells.some(([, v]) => /^(畳原価|畳材料)$/.test(v.trim()))) {
        const amount = cells.map(([, v]) => num(v)).find((n) => Number.isFinite(n) && Math.abs(n) >= 1);
        if (amount) skipped("畳原価の合計 (移行した受注の畳原価にあるため取り込まない)", amount, `${sheet.name} ${storeName} ${Math.round(amount).toLocaleString("ja-JP")} 円`);
        continue;
      }
      if (!store || !blocks.length) continue;
      for (const b of blocks) {
        const cell = (h: string) => (b.cols[h] ? row.get(colName(b.cols[h]))?.trim() : undefined);
        const name = cell("品目");
        const total = num(cell("合計"));
        // 日付: Excel の日付、または日だけの数 (「15」= その月の 15 日)
        const dayRaw = num(cell("日付"));
        const d = excelDate(cell("日付")) ?? (Number.isInteger(dayRaw) && dayRaw >= 1 && dayRaw <= 31 ? `${month}-${String(dayRaw).padStart(2, "0")}` : undefined);
        if (d) b.lastDate = d;
        if (!name || name === "合計" || cell("数量") === "合計" || cell("単価") === "合計" || !Number.isFinite(total) || total === 0) continue;
        const note = cell("備考") ?? "";
        const ref = `${sheet.name}/${storeName}/${r} 行/${b.title.slice(0, 6) || "欄"}`;
        const date = (d ?? b.lastDate)?.startsWith(month) ? (d ?? b.lastDate)! : `${month}-01`;
        const amount = Math.abs(Math.round(total));
        const qtyRaw = num(cell("数量"));
        const unitRaw = num(cell("単価"));
        const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
        const unitCost = Number.isFinite(unitRaw) && unitRaw >= 0 && Number.isFinite(qtyRaw) && qtyRaw > 0 ? unitRaw : amount;
        const example = `${sheet.name} ${storeName} ${name} ${Math.round(total).toLocaleString("ja-JP")} 円${note ? ` (${note})` : ""}`;
        if (/内部/.test(b.title)) {
          const cp = counterpartOf(db, note, store);
          if (!cp.storeId || cp.storeId === store) {
            skipped("内部受注の相手の店舗が備考から分からない", total, example);
            continue;
          }
          // 書いた店舗が受け取る (+)。マイナスの行・「〜へ」は向きが逆
          const receiveHere = total > 0 && cp.direction !== "to";
          rows.push({ kind: "internal", sheet: sheet.name, month, date, fromStoreId: receiveHere ? store : cp.storeId, toStoreId: receiveHere ? cp.storeId : store, name, qty: 1, unitCost: amount, amount, itemCategory: "other", ref, note: note || undefined });
          continue;
        }
        if (/襖|自社/.test(b.title)) {
          const cp = counterpartOf(db, note, store);
          const other: StoreId | undefined = cp.storeId ?? (store !== "koshi" ? "koshi" : undefined);
          if (!other || other === store) {
            skipped("材料移動の相手の店舗が分からない (工場の欄で備考なし)", total, example);
            continue;
          }
          // 受け取った (+・「〜より」) か 渡した (−・「〜へ」)
          const received = cp.direction === "to" ? total < 0 : total > 0;
          rows.push({ kind: "transfer", sheet: sheet.name, month, date, fromStoreId: received ? other : store, toStoreId: received ? store : other, name, qty: Math.abs(qty), unitCost: Math.abs(unitCost), amount, itemCategory: /自社/.test(b.title) ? "own" : "fusuma", ref, note: note || undefined });
          continue;
        }
        skipped(`「${b.title || "その他"}」の欄 (消耗品・販促品など。今後は案分経費として扱うため取り込まない)`, total, example);
      }
    }
  }
  // 両方の店舗の欄に書いた同じ移動 (+ と −) を 1 件にまとめる
  const seen = new Set<string>();
  const unique: MoveImportRow[] = [];
  for (const x of rows) {
    const k = `${x.kind}|${x.month}|${x.fromStoreId}|${x.toStoreId}|${x.name.replace(/[\s　]/g, "")}|${x.amount}`;
    if (seen.has(k)) {
      skipped("両方の店舗の欄に書かれた同じ移動 (1 件にまとめた)", x.amount, `${x.sheet} ${x.name} ${x.amount.toLocaleString("ja-JP")} 円`);
      continue;
    }
    seen.add(k);
    unique.push(x);
  }
  return { hash: meta.hash, fileName: meta.fileName, sheets: sheetCount, rows: unique, skipped: [...skip.entries()].map(([reason, v]) => ({ reason, ...v })), createdAt: meta.now };
}

export const planHash = (buf: Buffer) => createHash("sha256").update(buf).digest("hex").slice(0, 32);
export const MARK = "材料移動の表";

/** 取込 (mutate の中で呼ぶ)。すでに取り込んだ行・月次確定済みの月の行は飛ばす */
export function applyMaterialMoveImport(db: Database, plan: MoveImportPlan, input: { userId: string; now: string; makeId: (p: string) => string; number: (p: string, list: { number: string }[], date: string) => string }): { transfers: number; adjustments: number; existing: number; closed: number } {
  const done = new Set<string>([
    ...(db.materialTransfers ?? []).map((t) => t.note ?? ""),
    ...(db.salesAdjustments ?? []).map((a) => a.reason ?? ""),
  ].filter((s) => s.startsWith(MARK)).map((s) => s.split(" | ")[0]));
  let transfers = 0;
  let adjustments = 0;
  let existing = 0;
  let closed = 0;
  for (const x of plan.rows) {
    const mark = `${MARK} ${x.ref}`;
    if (done.has(mark)) {
      existing++;
      continue;
    }
    if (closedReason(db, x.date, "材料移動の表の取込")) {
      closed++;
      continue;
    }
    const memo = `${mark} | ${x.name}${x.note ? ` (${x.note})` : ""}`;
    if (x.kind === "transfer") {
      const t: MaterialTransfer = { id: input.makeId("mt"), number: input.number("MT", db.materialTransfers, x.date), date: x.date, fromStoreId: x.fromStoreId, toStoreId: x.toStoreId, name: x.name.slice(0, 80), itemCategory: x.itemCategory, qty: x.qty, unitCost: x.unitCost, amount: x.amount, note: memo.slice(0, 200), status: "active", createdBy: input.userId, createdAt: input.now };
      db.materialTransfers.push(t);
      transfers++;
    } else {
      const hq = x.toStoreId === "hq";
      const a: SalesAdjustment = { id: input.makeId("adj"), number: input.number("SA", db.salesAdjustments, x.date), kind: hq ? "hq_special" : "manual", date: x.date, fromStoreId: x.fromStoreId, toStoreId: x.toStoreId, base: "tax_excluded", amount: x.amount, treatment: hq ? "sales_transfer" : undefined, provisional: false, status: "active", reason: `${memo} (過去の${hq ? "本部の特殊配分" : "内部受注"})`.slice(0, 300), createdBy: input.userId, createdAt: input.now };
      db.salesAdjustments.push(a);
      adjustments++;
    }
    done.add(mark);
  }
  return { transfers, adjustments, existing, closed };
}
