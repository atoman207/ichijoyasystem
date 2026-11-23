import type { Database, Material } from "@/lib/db/types";

/**
 * 畳床の仕様の判定 (原価の自動計算で使う)
 * ------------------------------------------------------------
 * 売上明細の品名 (例: 「畳新調（建材床）」) だけでは、仕入単価の違う畳床 (種類・厚み・規格) が決まらない。
 * そこで、次の順に材料マスタの畳床を選ぶ:
 *   1. 品名と、案件の製造の予定 (予定表の製造の欄の「床」「サイズ」) から 種類・厚み・規格 を読み、材料マスタの畳床で 1 つに決まればその材料
 *   2. 決まらないときは材料構成 (BOM) の「既定の畳床」で計算し、「既定の仕様で計算」と表示する (確認すれば製造仕様で選び直せる)
 *   3. どちらもなければ要確認 (金額を入れない)
 * 規格: メーカーの取り扱いが 五八間 と 本間 の 2 種類になる前提で、畳の寸法から使う畳床の規格を決める。
 * 五八 (5 尺 8 寸 ≒ 1,760mm) 以下 (五六・五七・五八・江戸間・団地間) は五八間、それより大きい (五九〜六四・三六・本間・京間) は本間。
 * 材料マスタの規格が 六一間 などのままでも、寸法がそのまま一致すればその材料を選ぶ
 */

export type DokoSizeClass = "gohachi" | "honma";

export interface DokoHints {
  /** 種類のキー (建材・わら・3型・うす床・オールボード・たたみっこ・ポリスチレン) */
  type?: string;
  /** 厚み (mm) */
  thickness?: number;
  /** 畳の寸法の呼び名 (五八・六一・本間 など) */
  sizeRaw?: string;
  /** 使う畳床の規格 */
  sizeClass?: DokoSizeClass;
  /** 材料マスタの規格に直した寸法 (rokuichi など。一致する材料があれば優先) */
  sizeExact?: string;
}

const N = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "");

const TYPE_PATTERNS: [RegExp, string][] = [
  [/たたみっこ/, "たたみっこ"],
  [/オールボード/, "オールボード"],
  [/(?:3|三|III)型/i, "3型"],
  [/うす床|薄床|薄畳/, "うす床"],
  [/ポリスチレン|スタイロ/, "ポリスチレン"],
  [/わら|ワラ|藁/, "わら"],
  [/建材/, "建材"],
];

/** 寸法の呼び名 → 材料マスタの規格 (costing.ts の SIZE_LABEL のキー) と、使う畳床の規格 */
const SIZE_NAMES: { re: RegExp; raw: string; exact?: string; cls: DokoSizeClass }[] = [
  { re: /本間|京間|六三|六四|(?<!\d)(?:630|640)(?!\d)/, raw: "本間", exact: "honma", cls: "honma" },
  { re: /六一|(?<!\d)61(?:0)?(?!\d)/, raw: "六一", exact: "rokuichi", cls: "honma" },
  { re: /六〇|中京間|三六|(?<!\d)600(?!\d)/, raw: "六〇", exact: "rokumaru", cls: "honma" },
  { re: /六二|五九|(?<!\d)(?:620|590)(?!\d)/, raw: "五九〜六二", cls: "honma" },
  { re: /五八|江戸間|(?<!\d)58(?:0)?(?!\d)/, raw: "五八", exact: "gohachi", cls: "gohachi" },
  { re: /五六|五七|団地間|(?<!\d)(?:560|570)(?!\d)/, raw: "五六〜五七", cls: "gohachi" },
];

/** 品名・製造の予定のメモから、畳床の種類・厚み・規格を読む */
export function dokoHints(text: string): DokoHints {
  const t = N(text ?? "");
  const out: DokoHints = {};
  for (const [re, key] of TYPE_PATTERNS) {
    if (re.test(t)) {
      out.type = key;
      break;
    }
  }
  const th = t.match(/[tT]=?(\d{2})(?!\d)/) ?? t.match(/(\d{2})(?:mm|ミリ|㎜)/) ?? t.match(/床(\d{2})(?!\d)/) ?? t.match(/型(\d{2})(?!\d)/);
  if (th) {
    const n = Number(th[1]);
    if (n >= 10 && n <= 70) out.thickness = n;
  }
  // 寸法は「サイズ」の後ろを優先して読む (品名の数字を寸法と取り違えない)
  const sizePart = t.match(/サイズ([^/／]+)/)?.[1] ?? t;
  for (const s of SIZE_NAMES) {
    if (s.re.test(sizePart)) {
      out.sizeRaw = s.raw;
      out.sizeClass = s.cls;
      if (s.exact) out.sizeExact = s.exact;
      break;
    }
  }
  return out;
}

/** 材料マスタの畳床の種類のキー (名前・仕様から) */
export function dokoTypeOf(m: Pick<Material, "name" | "spec">): string | undefined {
  return dokoHints(`${m.spec ?? ""} ${m.name}`).type;
}

export interface DokoPick {
  material?: Material;
  /** 既定の畳床を使った (仕様から決まらなかった) */
  assumed: boolean;
  /** 判定の説明 (画面・原価の行に残す) */
  reason: string;
  /** 仕様に合う候補の数 (2 以上で既定がないときは要確認) */
  candidates: number;
}

const sizeClassOf = (size: string | undefined): DokoSizeClass | undefined =>
  size === "gohachi" ? "gohachi" : size === "honma" || size === "rokuichi" || size === "rokumaru" ? "honma" : undefined;

const describe = (h: DokoHints) => [h.type, h.thickness ? `${h.thickness}mm` : "", h.sizeRaw ? `寸法 ${h.sizeRaw}` : ""].filter(Boolean).join("・");

/** 判定の材料を選ぶ (材料マスタの有効な畳床から。defaultId = 材料構成の既定の畳床) */
export function pickDoko(db: Pick<Database, "materials">, hints: DokoHints, defaultId?: string): DokoPick {
  const all = (db.materials ?? []).filter((m) => m.active && m.kind === "doko");
  const fallback = defaultId ? (db.materials ?? []).find((m) => m.id === defaultId) : undefined;
  const withDefault = (why: string): DokoPick =>
    fallback ? { material: fallback, assumed: true, reason: `${why}ため、既定の畳床「${fallback.name}」で計算 (製造仕様で確認してください)`, candidates: 0 } : { assumed: false, reason: `${why}ため、畳床の仕様を選んでください`, candidates: 0 };
  if (!all.length) return withDefault("材料マスタに畳床がない");
  if (!hints.type && !hints.thickness && !hints.sizeClass) return withDefault("品名・製造の予定に畳床の仕様 (種類・厚み・寸法) がない");
  let c = all;
  const used: string[] = [];
  const narrow = (pred: (m: Material) => boolean, label: string) => {
    const next = c.filter(pred);
    if (next.length) {
      c = next;
      used.push(label);
    }
  };
  if (hints.type) narrow((m) => dokoTypeOf(m) === hints.type, `種類 ${hints.type}`);
  if (hints.thickness) narrow((m) => m.thickness === hints.thickness, `厚み ${hints.thickness}mm`);
  if (hints.sizeClass) {
    const exact = hints.sizeExact ? c.filter((m) => m.size === hints.sizeExact) : [];
    if (exact.length) {
      c = exact;
      used.push(`寸法 ${hints.sizeRaw}`);
    } else narrow((m) => sizeClassOf(m.size) === hints.sizeClass, `寸法 ${hints.sizeRaw} → ${hints.sizeClass === "gohachi" ? "五八間" : "本間"}の畳床`);
  }
  if (!used.length) return withDefault(`読み取った仕様 (${describe(hints)}) に合う畳床が材料マスタにない`);
  if (c.length === 1) return { material: c[0], assumed: false, reason: `品名・製造の予定の ${used.join("・")} から「${c[0].name}」`, candidates: 1 };
  if (fallback && c.some((m) => m.id === fallback.id)) return { material: fallback, assumed: true, reason: `${used.join("・")} に合う畳床が ${c.length} 件あるため、既定の畳床「${fallback.name}」で計算 (製造仕様で確認してください)`, candidates: c.length };
  return { assumed: false, reason: `${used.join("・")} に合う畳床が ${c.length} 件あります。畳床の仕様を選んでください`, candidates: c.length };
}

/** 受注ごとの製造の予定のメモ (予定表の製造の欄の「床」「サイズ」など)。全件を 1 回で索引にする */
export function productionNoteIndex(db: Pick<Database, "productionJobs">): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const j of db.productionJobs ?? []) {
    if (!j.orderId || j.status === "cancelled") continue;
    const notes = j.items.map((i) => i.note ?? "").filter(Boolean);
    if (notes.length) (out.get(j.orderId) ?? out.set(j.orderId, []).get(j.orderId)!).push(...notes);
  }
  return new Map([...out].map(([k, v]) => [k, v.join(" / ")]));
}

/** 1 件の受注の製造の予定のメモ */
export function productionNotes(db: Pick<Database, "productionJobs">, orderId: string): string {
  return productionNoteIndex({ productionJobs: (db.productionJobs ?? []).filter((j) => j.orderId === orderId) }).get(orderId) ?? "";
}
