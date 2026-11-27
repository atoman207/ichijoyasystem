import type { Database, MaterialOrder, MaterialOrderCategory, MaterialOrderStatus, Order, Quote, QuoteItem, StoreId } from "@/lib/db/types";
import type { Tone } from "@/lib/constants";
import { lineKind } from "@/lib/line-kind";

/**
 * 材料発注 (お客様のご要望 2026-11-27「■4 材料発注フロー」「■5 案件画面と材料発注の連動」「■6 リフォーム案件の発注管理」)
 * ------------------------------------------------------------
 * 受注した案件の見積の明細から、発注が要る材料を自動で出す (保存しない。毎回計算):
 * - 襖紙: 品番 (のぞみ177・みやこ310／306 など) ごとに必要な紙の枚数を計算する
 *   片面 = 襖 1 枚に紙 1 枚 / 両面 = 2 枚 (品番が 2 つ「のぞみ177+しずか381」なら各 1 枚) /
 *   中サイズ (中ウラ・中襖) = 襖 2 枚で紙 1 枚 / 小サイズ (天袋・地袋・天ウラ) = 襖 3 枚で紙 1 枚 (両面は倍)。仏間一式など枚数の分からない行は空 (手で入れる)
 * - カーテン・クロス: 都度発注 (見積の数量・単位のまま)
 * - 障子・網戸・畳は在庫を使うので出さない。リフォームは案件ごとに手で足す (見積の明細から選ぶ・手書きの発注一覧を撮影して読み取る)
 * 人が決めたこと (発注状況・発注者・発注日時・発注数量・メモ) だけを material_orders に保存する (key = auto:<受注>:<明細>:<品番の番号>)。
 * 在庫補充など案件にひも付かない発注・リフォームの手配は行ごと保存する。
 * このファイルは画面・サーバー・テストから読むため、サーバー専用の import をしない
 */

export const MATERIAL_STATUS: Record<MaterialOrderStatus, { label: string; tone: Tone }> = {
  unordered: { label: "未発注", tone: "critical" },
  ordered: { label: "発注済み", tone: "good" },
  stock: { label: "在庫使用", tone: "info" },
  separate: { label: "別途発注", tone: "accent" },
  not_needed: { label: "発注不要", tone: "neutral" },
};
export const MATERIAL_STATUSES = Object.keys(MATERIAL_STATUS) as MaterialOrderStatus[];

export const MATERIAL_CATEGORY: Record<MaterialOrderCategory, string> = {
  fusuma: "襖紙",
  curtain: "カーテン",
  cloth: "クロス",
  reform: "リフォーム",
  tatami: "畳",
  shoji: "障子",
  amido: "網戸",
  other: "その他",
};
export const MATERIAL_CATEGORIES = Object.keys(MATERIAL_CATEGORY) as MaterialOrderCategory[];

/** 受注から自動で出す受注の状態 (契約の承認待ち〜施工中)。施工完了のあとは保存した行だけ */
const OPEN_ORDER: Order["status"][] = ["pending_approval", "returned", "confirmed", "scheduled", "in_progress"];

/* ---------------- 襖紙の枚数 ---------------- */

export interface FusumaPaper {
  /** 品番 (例: のぞみ177)。分からなければ空の配列 */
  codes: string[];
  /** 1 = 片面 / 2 = 両面 */
  sides: 1 | 2;
  /** std = 普通 / mid = 中サイズ (襖 2 枚で紙 1 枚) / small = 小サイズ (天袋・地袋。襖 3 枚で紙 1 枚) */
  size: "std" | "mid" | "small";
  /** 品番ごとの紙の枚数 (分からなければ undefined) */
  sheets?: number;
  /** 在庫の紙・クロスを使うと書いてある */
  stock: boolean;
}

const SIZE_PER_SHEET = { std: 1, mid: 2, small: 3 } as const;
/** 品番の前の言葉として読まない (「片ウラ 301」の「ウラ」など) */
const NOT_SERIES = new Set(["ウラ", "ウラ貼", "ウラ開", "ダンボール", "プリント", "ベニヤ", "クロス"]);

/** 明細の品名・仕様から品番を読む (のぞみ177・みやこ 310／306・TS-228・数字だけの 301/306) */
export function paperCodes(text: string): string[] {
  const t = text.normalize("NFKC");
  const out: string[] = [];
  const re = /([ぁ-ゖ]{2,6}|[ァ-ヺー]{2,6}|[A-Za-z]{1,4}-?)\s*(\d{2,4})((?:\s*[／/]\s*\d{2,4})*)/g;
  for (const m of t.matchAll(re)) {
    const series = m[1];
    if (NOT_SERIES.has(series.replace(/-$/, ""))) continue;
    const nums = [m[2], ...(m[3] ? m[3].split(/[／/]/).map((x) => x.trim()).filter(Boolean) : [])];
    for (const n of nums) out.push(`${series}${n}`);
  }
  if (!out.length) {
    // 品番の名前がない数字 (「片ウラ 301/306」「板戸 310」)
    for (const m of t.matchAll(/(?:^|[\s　])(\d{3})((?:\s*[／/]\s*\d{3})*)(?=[\s　]|$)/g)) {
      out.push(m[1], ...(m[2] ? m[2].split(/[／/]/).map((x) => x.trim()).filter(Boolean) : []));
    }
  }
  return [...new Set(out)];
}

/** 襖紙の必要枚数 (明細 1 行)。qty = 襖の枚数 (単位が 式 などなら枚数は分からない) */
export function fusumaPaper(text: string, qty: number, unit: string | undefined): FusumaPaper {
  const t = text.normalize("NFKC");
  const codes = paperCodes(t);
  const sides: 1 | 2 = /両面/.test(t) ? 2 : 1;
  const size: FusumaPaper["size"] = /天袋|天ウラ|天裏|地袋|小襖|小サイズ|天井?袋/.test(t) ? "small" : /中(?:ウラ|裏|襖|サイズ|袋)/.test(t) ? "mid" : "std";
  const countable = qty > 0 && (!unit || /^(枚|本|面|組|ヶ所|か所|箇所)$/.test(unit));
  const stock = /在庫/.test(t);
  // 品番が 2 つ (裏表で違う紙) か、両面の片方が在庫 (「のぞみ186/在庫クロス」) なら 1 つの品番は片面ぶん
  const perCode = codes.length >= 2 || (sides === 2 && stock) ? 1 : sides;
  const sheets = countable ? Math.ceil(qty / SIZE_PER_SHEET[size]) * perCode : undefined;
  return { codes, sides, size, sheets, stock };
}

/* ---------------- 受注から自動で出す行 ---------------- */

export interface AutoMaterial {
  key: string;
  orderId: string;
  lineId: string;
  category: MaterialOrderCategory;
  name: string;
  code?: string;
  qtyAuto?: number;
  unit?: string;
  spec: string;
}

const SIZE_LABEL = { std: "", mid: "中サイズ", small: "小サイズ" } as const;
const NOT_PAPER = /ベニア|加工|修理|補修|骨|枠|戸車|レール|調整|処分/;
const CLOTH = /クロス|壁紙/;

/** 受注 1 件の見積の明細から、発注が要る材料 (襖紙・カーテン・クロス) */
export function autoMaterials(o: Pick<Order, "id">, q: Pick<Quote, "items"> | undefined): AutoMaterial[] {
  const out: AutoMaterial[] = [];
  for (const it of q?.items ?? []) {
    const k = lineKind(it.name, it.spec)?.kind;
    const text = `${it.name} ${it.spec ?? ""}`.trim();
    const where = `${text} (${it.qty}${it.unit})`;
    // 紙を張らない作業 (ベニアの交換・加工・修理・骨・枠・戸車) は襖紙にしない (要るときは手で足す)
    if ((k === "fusuma" || k === "butsuma") && NOT_PAPER.test(text) && !paperCodes(text).length) continue;
    if (k === "fusuma" || k === "butsuma") {
      const p = fusumaPaper(text, k === "butsuma" ? 0 : it.qty, it.unit);
      const note = [p.sides === 2 ? "両面" : "片面", SIZE_LABEL[p.size], p.stock ? "在庫の記載あり" : "", p.sheets === undefined ? "枚数は手で入力" : ""].filter(Boolean).join("・");
      const codes = p.codes.length ? p.codes : [""];
      codes.forEach((code, i) =>
        out.push({
          key: `auto:${o.id}:${it.id}:${i}`,
          orderId: o.id,
          lineId: it.id,
          category: "fusuma",
          name: code.replace(/[\d-]+$/, "") ? `襖紙 ${code.replace(/[\d-]+$/, "")}` : "襖紙",
          code: code || undefined,
          qtyAuto: p.sheets,
          unit: "枚",
          spec: `${where} → ${note}`,
        }),
      );
    } else if (k === "curtain" || (k === "reform" && CLOTH.test(text))) {
      const code = text.normalize("NFKC").match(/[A-Za-z]{1,4}-?\d{2,6}(?:-\d+)?/)?.[0];
      out.push({ key: `auto:${o.id}:${it.id}:0`, orderId: o.id, lineId: it.id, category: k === "curtain" ? "curtain" : "cloth", name: it.name, code, qtyAuto: it.qty > 0 ? it.qty : undefined, unit: it.unit, spec: where });
    }
  }
  return out;
}

/* ---------------- 一覧の行 ---------------- */

export interface MaterialRow {
  /** auto:… または mo:<保存した行の ID> */
  key: string;
  id?: string;
  orderId?: string;
  orderNumber?: string;
  orderStatus?: Order["status"];
  quoteId?: string;
  customerId?: string;
  customerName?: string;
  caseTitle?: string;
  storeId: StoreId;
  pickup?: string;
  delivery?: string;
  install?: string;
  neededBy?: string;
  category: MaterialOrderCategory;
  name: string;
  code?: string;
  spec?: string;
  qtyAuto?: number;
  /** 発注する数量 (手で変えた値、なければ自動の必要数量) */
  qty?: number;
  qtyEdited: boolean;
  unit?: string;
  status: MaterialOrderStatus;
  orderedBy?: string;
  orderedAt?: string;
  supplierName?: string;
  note?: string;
  source: MaterialOrder["source"];
  lineId?: string;
  warnings: string[];
  /** 未発注で必要な日まで 3 日以内 (過ぎたものを含む) */
  urgent: boolean;
}

type PlanDb = Pick<Database, "orders" | "quotes" | "customers" | "schedule" | "materialOrders">;

/** 案件の引取・納品・工事の日 (予定表の予定。これからの予定 → なければ最初の予定) */
export function caseDates(db: Pick<Database, "schedule">, orderId: string, today: string): { pickup?: string; delivery?: string; install?: string } {
  const evs = db.schedule.filter((e) => e.orderId === orderId);
  const pick = (kinds: string[]) => {
    const ds = evs.filter((e) => kinds.includes(e.kind)).map((e) => e.date).sort();
    return ds.find((d) => d >= today) ?? ds[0];
  };
  return { pickup: pick(["pickup", "onsite_quote"]), delivery: pick(["delivery"]), install: pick(["install"]) };
}

const addDaysKey = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/**
 * 材料発注の一覧の行 (自動の行 + 保存した行)。opts.orderIds = 案件の画面 (その受注だけ)。
 * 並び = 未発注を先に、必要な日 (必要日 → 納品 → 工事 → 引取) の近い順
 */
export function materialRows(db: PlanDb, today: string, opts: { orderIds?: string[]; storeId?: StoreId | "all" } = {}): MaterialRow[] {
  const saved = new Map<string, MaterialOrder>();
  const loose: MaterialOrder[] = [];
  for (const m of db.materialOrders ?? []) {
    if (m.key) saved.set(m.key, m);
    else loose.push(m);
  }
  const only = opts.orderIds ? new Set(opts.orderIds) : undefined;
  const store = opts.storeId && opts.storeId !== "all" ? opts.storeId : undefined;
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const rows: MaterialRow[] = [];
  const base = (o: Order | undefined, storeId: StoreId) => {
    const c = o ? customers.get(o.customerId) : undefined;
    return { orderId: o?.id, orderNumber: o?.number, orderStatus: o?.status, quoteId: o?.quoteId, customerId: c?.id, customerName: c?.name, caseTitle: o?.title, storeId: o?.storeId ?? storeId, ...(o ? caseDates(db, o.id, today) : {}) };
  };
  const fromSaved = (m: MaterialOrder, o: Order | undefined, auto?: AutoMaterial): MaterialRow => {
    const warnings: string[] = [];
    if (auto && m.status === "ordered" && m.qtyAuto !== undefined && auto.qtyAuto !== undefined && m.qtyAuto !== auto.qtyAuto) warnings.push(`見積の数量が変わりました (発注したとき ${m.qtyAuto} → 今 ${auto.qtyAuto})`);
    if (m.key && !auto && m.status !== "not_needed") warnings.push("見積の明細にありません (明細を変えた・消した)");
    const qtyAuto = auto ? auto.qtyAuto : m.qtyAuto;
    return {
      key: m.key ?? `mo:${m.id}`,
      id: m.id,
      ...base(o, m.storeId),
      neededBy: m.neededBy,
      category: auto?.category ?? m.category,
      name: auto?.name ?? m.name,
      code: auto?.code ?? m.code,
      spec: auto?.spec ?? m.spec,
      qtyAuto,
      qty: m.qty ?? qtyAuto,
      qtyEdited: m.qty !== undefined,
      unit: auto?.unit ?? m.unit,
      status: m.status,
      orderedBy: m.orderedBy,
      orderedAt: m.orderedAt,
      supplierName: m.supplierName,
      note: m.note,
      source: m.source,
      lineId: auto?.lineId,
      warnings,
      urgent: false,
    };
  };
  const seenKeys = new Set<string>();
  for (const o of db.orders) {
    if (only ? !only.has(o.id) : !OPEN_ORDER.includes(o.status)) continue;
    if (store && o.storeId !== store) continue;
    if (o.status === "cancelled" || o.source === "import") continue;
    for (const a of autoMaterials(o, o.quoteId ? quotes.get(o.quoteId) : undefined)) {
      seenKeys.add(a.key);
      const m = saved.get(a.key);
      rows.push(m ? fromSaved(m, o, a) : { key: a.key, ...base(o, o.storeId), category: a.category, name: a.name, code: a.code, spec: a.spec, qtyAuto: a.qtyAuto, qty: a.qtyAuto, qtyEdited: false, unit: a.unit, status: "unordered", source: "auto", lineId: a.lineId, warnings: a.qtyAuto === undefined ? ["枚数を入れてください"] : [], urgent: false });
    }
  }
  // 保存した自動の行のうち、明細から消えた・受注が完了した行 (発注の記録を残す)
  for (const m of saved.values()) {
    if (seenKeys.has(m.key!)) continue;
    const o = m.orderId ? orders.get(m.orderId) : undefined;
    if (only ? !(m.orderId && only.has(m.orderId)) : store && m.storeId !== store) continue;
    if (!only && o && !OPEN_ORDER.includes(o.status) && m.status !== "unordered") continue;
    rows.push(fromSaved(m, o));
  }
  for (const m of loose) {
    if (only ? !(m.orderId && only.has(m.orderId)) : store && m.storeId !== store) continue;
    const o = m.orderId ? orders.get(m.orderId) : undefined;
    if (!only && o && !OPEN_ORDER.includes(o.status) && m.status !== "unordered") continue;
    rows.push(fromSaved(m, o));
  }
  for (const r of rows) {
    const need = needDate(r);
    r.urgent = r.status === "unordered" && Boolean(need) && need! <= addDaysKey(today, 3);
  }
  return rows.sort((a, b) => Number(a.status !== "unordered") - Number(b.status !== "unordered") || (needDate(a) ?? "9999").localeCompare(needDate(b) ?? "9999") || (a.orderNumber ?? "").localeCompare(b.orderNumber ?? "") || a.key.localeCompare(b.key));
}

/** 必要な日 (手で入れた日 → 納品 → 工事 → 引取) */
export function needDate(r: Pick<MaterialRow, "neededBy" | "delivery" | "install" | "pickup">): string | undefined {
  return r.neededBy ?? r.delivery ?? r.install ?? r.pickup;
}

/** 状況ごとの件数 */
export function statusCounts(rows: MaterialRow[]): Record<MaterialOrderStatus, number> {
  const out = Object.fromEntries(MATERIAL_STATUSES.map((s) => [s, 0])) as Record<MaterialOrderStatus, number>;
  for (const r of rows) out[r.status] += 1;
  return out;
}

/** 案件ごとにまとめる (一覧の表示。並びは行の並びのまま) */
export function groupByCase(rows: MaterialRow[]): { key: string; rows: MaterialRow[] }[] {
  const out = new Map<string, MaterialRow[]>();
  for (const r of rows) {
    const k = r.orderId ?? `store:${r.storeId}`;
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return [...out].map(([key, rs]) => ({ key, rows: rs }));
}

/** 見積の明細のうち、リフォームの手配として足せる行 (案件の画面の「見積の明細から追加」) */
export function reformLines(q: Pick<Quote, "items"> | undefined): QuoteItem[] {
  return (q?.items ?? []).filter((it) => {
    const k = lineKind(it.name, it.spec)?.kind;
    // クロスは受注から自動で出すので除く
    return (k === "reform" && !CLOTH.test(`${it.name} ${it.spec ?? ""}`)) || k === "misc" || k === undefined;
  });
}
