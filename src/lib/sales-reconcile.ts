import type { Database, Order } from "@/lib/db/types";
import { taxRate } from "@/lib/sales-ledger";

/**
 * 売上台帳 (店舗別の xlsx) と販売管理ソフトの売上明細 (CSV) の二重計上を直す
 * ------------------------------------------------------------
 * 移行は 2 つの元データを重ねている: 売上台帳 → 受注 (店舗ごとの月の集計と一致する)、売上明細 → 伝票を台帳の受注にひも付け、
 * 台帳にない伝票だけ新しい受注 (o_s<伝票№>) にする。ひも付けの照合 (売上日 ±3 日・お名前・金額) から漏れた伝票は、
 * 同じ売上が「台帳の受注」と「伝票の受注」の 2 件になり、月の売上が台帳の集計より大きくなる。
 * 照合から漏れる主な理由: 合志店などの台帳は売上日を月末にまとめて書いている / 字体の違い (髙・高、澤・沢、德・徳) /
 * 法人名の書き方 (「上林一木新築」と「(有)上林建設」) / 伝票の店舗の推定違い / 1 つの工事を台帳では 2 店舗に分けて書いている。
 *
 * ここでは「伝票とひも付いていない台帳の受注」と「台帳とひも付いていない伝票の受注」の組を、金額・時期・お名前で見つけ、
 * 伝票の受注を台帳の受注にまとめる (台帳の受注の店舗・金額を残し、伝票の明細の経過メモ・施工担当・お客様を移して、伝票の受注を消す)。
 * 台帳の金額を残すのは、台帳の月の集計 (店舗別・全店) と一致させるため (照合済みの受注と同じ扱い)。
 * 決まった規則だけで判断する (何度実行しても同じ結果。迷う組はまとめない)
 */

const SLIP_NOTE = /^pn_s(\d+)_/;
const LEDGER_CUSTOMER = /^c_[0-9a-f]{12}$/;

/** 名前の字体・書き方のゆれをそろえる (照合のためだけ。保存する名前は変えない) */
const VARIANTS: Record<string, string> = {
  髙: "高", 﨑: "崎", 嵜: "崎", 德: "徳", 澤: "沢", 邊: "辺", 邉: "辺", 濱: "浜", 廣: "広", 櫻: "桜", 嶋: "島", 嶌: "島", 國: "国",
  槇: "槙", 冨: "富", 眞: "真", 惠: "恵", 藏: "蔵", 實: "実", 壽: "寿", 黑: "黒", 圓: "円", 齋: "斉", 齊: "斉", 斎: "斉", 龍: "竜",
  瀨: "瀬", 淵: "渕", 增: "増", 條: "条", 會: "会", 舘: "館", 萬: "万", 與: "与", 莊: "荘", 曾: "曽", 埜: "野",
  榮: "栄", 稻: "稲", 靜: "静", 專: "専", 禮: "礼", 彌: "弥", 豐: "豊", 傳: "伝", 﨔: "欅", 濵: "浜", 穗: "穂", "𠮷": "吉", 濤: "涛", 邨: "村", 峯: "峰", 嵓: "巌",
};
export function nameKey(name: string): string {
  return [...String(name ?? "").normalize("NFKC")]
    .map((ch) => VARIANTS[ch] ?? ch)
    // カタカナはひらがなにそろえる (「レンガの家」と「れんがの家」)
    .map((ch) => (ch >= "ァ" && ch <= "ヶ" ? String.fromCharCode(ch.charCodeAt(0) - 0x60) : ch))
    .join("")
    .replace(/[(（]\s*(株|有|合|資|名)\s*[)）]|株式会社|有限会社|合同会社|一般社団法人|社会福祉法人|医療法人/g, "")
    .replace(/[\s　・･.,、。()（）「」『』\-ー―‐]/g, "")
    .replace(/(様方|様|邸|さん|殿|御中)$/, "");
}

/** お名前が同じ人・会社とみてよいか (先頭の 2 文字が同じ、または 2 文字以上の片方がもう片方に含まれる) */
export function similarNames(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && x.slice(0, 2) === y.slice(0, 2)) return true;
  return (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y));
}

/** 台帳の現場名 (お名前・建物名) が、伝票の施工場所・住所の文字に含まれるか (台帳は現場名、伝票は請求先の名前で書くことがある) */
export function siteMentions(ledgerName: string, siteText: string): boolean {
  const k = nameKey(ledgerName);
  const t = nameKey(siteText);
  if (!k || !t) return false;
  return (k.length >= 2 && t.includes(k)) || (k.length >= 3 && t.startsWith(k.slice(0, 3)));
}

const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
/** 同じ時期の売上とみてよいか: 同じ月 (台帳は売上日を月末にまとめることがある) か、7 日以内 */
function sameTime(a: string, b: string): { ok: boolean; days: number } {
  const days = Math.abs(dayNo(a) - dayNo(b));
  return { ok: a.slice(0, 7) === b.slice(0, 7) || days <= 7, days };
}
/** 金額の差の割合 (0 = 同じ) */
const gap = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b)));

export interface ReconcilePair {
  /** 残す受注 (売上台帳から移行) */
  ledgerIds: string[];
  /** まとめて消す受注 (売上明細の伝票から作った o_s…) */
  slipOrderIds: string[];
  ledgerTotal: number;
  slipTotal: number;
  month: string;
  /** 照合の理由 (金額が同じ・お名前・日数) */
  reason: string;
}

export interface ReconcileReport {
  pairs: ReconcilePair[];
  ordersRemoved: number;
  customersMerged: number;
  /** 照合のあとも残った、台帳だけの受注・伝票だけの受注 (金額のある受注の件数と合計) */
  remaining: { ledgerOnly: { n: number; total: number }; slipOnly: { n: number; total: number } };
}

export const isSlipOrder = (o: Order) => o.source === "import" && o.id.startsWith("o_s") && (o.sourceRef ?? "").startsWith("売上明細");
const hasSlipNote = (o: Order) => o.progressNotes.some((n) => SLIP_NOTE.test(n.id));
export const isLedgerOnly = (o: Order) => o.source === "import" && !o.id.startsWith("o_s") && !(o.sourceRef ?? "").startsWith("売上明細") && !hasSlipNote(o) && Boolean(o.salesDate);

/** 照合だけ (データは変えない) */
export function planReconcile(db: Database): ReconcilePair[] {
  const customerById = new Map(db.customers.map((c) => [c.id, c]));
  const nm = (o: Order) => customerById.get(o.customerId)?.name ?? "";
  const ledger = db.orders.filter((o) => isLedgerOnly(o) && o.total !== 0);
  const slips = db.orders.filter((o) => isSlipOrder(o) && o.total !== 0 && o.salesDate);
  const pairs: ReconcilePair[] = [];
  const usedL = new Set<string>();
  const usedS = new Set<string>();

  /** 名前の根拠: お名前が一致 > 台帳の現場名が伝票の施工場所に書いてある */
  const nameEvidence = (l: Order, s: Order): string => {
    if (similarNames(nm(l), nm(s))) return "お名前が一致";
    if (siteMentions(nm(l), s.siteAddress ?? "") || siteMentions(nm(l), customerById.get(s.customerId)?.address ?? "")) return "現場名が施工場所と一致";
    return "";
  };
  /** 地区の一致: 台帳の地区 (受注の施工場所の欄) が伝票の施工場所・お客様の住所に書いてある */
  const areaMatch = (l: Order, s: Order): boolean => {
    const area = nameKey((l.siteAddress ?? "").replace(/[(（].*$/, ""));
    if (area.length < 2) return false;
    return nameKey(`${s.siteAddress ?? ""}${customerById.get(s.customerId)?.address ?? ""}`).includes(area);
  };

  // 1 対 1: 同じ時期 (同じ月か 7 日以内) で、金額が同じ・3% 以内・税の扱いの違い (ちょうど税率の分の差)。
  // 金額が同じでないときは名前の根拠が必要。名前の根拠がない組は、金額が同じ・3 日以内・同じ店舗か地区が一致・その金額の候補が両側に 1 件ずつのときだけ
  const bySlipMonth = new Map<string, Order[]>();
  for (const s of slips) {
    for (const k of monthsAround(s.salesDate!)) (bySlipMonth.get(k) ?? bySlipMonth.set(k, []).get(k)!).push(s);
  }
  type Cand = { l: Order; s: Order; score: number; reason: string };
  const cands: Cand[] = [];
  for (const l of ledger) {
    const pool = bySlipMonth.get(l.salesDate!.slice(0, 7)) ?? [];
    for (const s of pool) {
      if (Math.sign(s.total) !== Math.sign(l.total)) continue;
      const t = sameTime(l.salesDate!, s.salesDate!);
      if (!t.ok) continue;
      const g = gap(l.total, s.total);
      const rate = 1 + taxRate(s.salesDate!);
      const taxGap = rate > 1 ? Math.min(gap(l.total, Math.round(s.total / rate)), gap(l.total, Math.round(s.total * rate))) : 1;
      if (g > 0.03 && taxGap > 0.002) continue;
      const evidence = nameEvidence(l, s);
      let amountLabel: string;
      let amountScore: number;
      if (g <= 0.03) {
        amountLabel = g === 0 ? "金額が同じ" : `金額の差 ${Math.abs(l.total - s.total).toLocaleString("ja-JP")} 円`;
        amountScore = g * 1000;
      } else {
        amountLabel = "金額の差が税の分 (税込・税抜の扱いの違い)";
        amountScore = 40;
      }
      if (!evidence) {
        if (g !== 0 || t.days > 3) continue;
        if (l.storeId !== s.storeId && !areaMatch(l, s)) continue;
        const others = pool.filter((x) => x !== s && x.total === l.total && sameTime(l.salesDate!, x.salesDate!).days <= 3).length + ledger.filter((x) => x !== l && x.total === l.total && Math.abs(dayNo(x.salesDate!) - dayNo(s.salesDate!)) <= 3).length;
        if (others) continue;
      }
      const why = evidence || (l.storeId === s.storeId ? "同じ店舗で同じ金額の候補が 1 件" : "地区が一致し同じ金額の候補が 1 件");
      const score = amountScore + t.days + (evidence ? 0 : 20) + (l.storeId === s.storeId ? 0 : 1);
      cands.push({ l, s, score, reason: `${amountLabel}・${why}・${t.days} 日差` });
    }
  }
  cands.sort((a, b) => a.score - b.score || a.l.id.localeCompare(b.l.id) || a.s.id.localeCompare(b.s.id));
  for (const c of cands) {
    if (usedL.has(c.l.id) || usedS.has(c.s.id)) continue;
    usedL.add(c.l.id);
    usedS.add(c.s.id);
    pairs.push({ ledgerIds: [c.l.id], slipOrderIds: [c.s.id], ledgerTotal: c.l.total, slipTotal: c.s.total, month: c.l.salesDate!.slice(0, 7), reason: c.reason });
  }

  // 多 対 1: 1 つの工事を台帳では複数の行 (店舗・日) に分けた / 台帳の 1 行が複数の伝票。同じお名前・同じ月で、合計が 1% 以内
  const group = (list: Order[], used: Set<string>) => {
    const m = new Map<string, Order[]>();
    for (const o of list) {
      if (used.has(o.id)) continue;
      const k = `${o.salesDate!.slice(0, 7)}|${nameKey(nm(o)).slice(0, 2)}`;
      if (k.endsWith("|")) continue;
      (m.get(k) ?? m.set(k, []).get(k)!).push(o);
    }
    return m;
  };
  const gl = group(ledger, usedL);
  const gs = group(slips, usedS);
  for (const [k, ls] of [...gl].sort(([a], [b]) => a.localeCompare(b))) {
    const ss = gs.get(k);
    if (!ss) continue;
    if (ls.length === 1 && ss.length === 1) continue; // 1 対 1 は上で判断済み (金額の差が大きい)
    const names = [...ls, ...ss].map(nm);
    if (!names.every((n) => similarNames(n, names[0]))) continue;
    const lt = ls.reduce((a, o) => a + o.total, 0);
    const st = ss.reduce((a, o) => a + o.total, 0);
    if (gap(lt, st) > 0.01) continue;
    ls.forEach((o) => usedL.add(o.id));
    ss.forEach((o) => usedS.add(o.id));
    pairs.push({ ledgerIds: ls.map((o) => o.id).sort(), slipOrderIds: ss.map((o) => o.id).sort(), ledgerTotal: lt, slipTotal: st, month: k.slice(0, 7), reason: `同じお名前・同じ月の合計が${lt === st ? "同じ" : " 1% 以内"} (台帳 ${ls.length} 行・伝票 ${ss.length} 枚)` });
  }
  return pairs.sort((a, b) => a.month.localeCompare(b.month) || a.ledgerIds[0].localeCompare(b.ledgerIds[0]));
}

/** その月と前後の月 (7 日以内の月またぎの候補を探すため) */
function monthsAround(date: string): string[] {
  const [y, m] = date.slice(0, 7).split("-").map(Number);
  const k = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}`;
  const prev = m === 1 ? k(y - 1, 12) : k(y, m - 1);
  const next = m === 12 ? k(y + 1, 1) : k(y, m + 1);
  const d = Number(date.slice(8, 10));
  return [k(y, m), ...(d <= 7 ? [prev] : []), ...(d >= 24 ? [next] : [])];
}

/** 照合した組をまとめる (db を直接書き換える。画面では mutate の中で呼ぶ) */
export function applyReconcile(db: Database, pairs: ReconcilePair[], opts: { now: string }): ReconcileReport {
  const orderById = new Map(db.orders.map((o) => [o.id, o]));
  const remove = new Map<string, string>(); // 消す受注 → まとめ先
  const customerMoves = new Map<string, Set<string>>(); // 台帳の顧客 → まとめ先の得意先の顧客
  for (const p of pairs) {
    const ls = p.ledgerIds.map((id) => orderById.get(id)).filter((o): o is Order => Boolean(o));
    const ss = p.slipOrderIds.map((id) => orderById.get(id)).filter((o): o is Order => Boolean(o));
    if (!ls.length || !ss.length) continue;
    // 伝票の経過メモ・施工担当は、台帳の受注のうち金額の一番大きいものへ
    const main = [...ls].sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.id.localeCompare(b.id))[0];
    for (const s of ss) {
      const notes = s.progressNotes.filter((n) => !main.progressNotes.some((m) => m.id === n.id));
      main.progressNotes = [...main.progressNotes, ...notes].sort((a, b) => a.at.localeCompare(b.at));
      for (const w of s.workerIds) if (!main.workerIds.includes(w)) main.workerIds = [...main.workerIds, w];
      main.siteAddress ||= s.siteAddress;
      remove.set(s.id, main.id);
    }
    // お客様: 台帳の顧客なら、伝票の得意先の顧客 (得意先コード・電話・住所のある方) にする
    const slipCustomer = ss[0].customerId;
    for (const l of ls) {
      if (l.customerId !== slipCustomer && LEDGER_CUSTOMER.test(l.customerId) && slipCustomer.startsWith("c_s")) {
        (customerMoves.get(l.customerId) ?? customerMoves.set(l.customerId, new Set()).get(l.customerId)!).add(slipCustomer);
        l.customerId = slipCustomer;
      }
      l.updatedAt = opts.now;
    }
  }

  // 消す受注を参照している記録 (請求・予定・添付・アンケートなど) は、まとめ先の受注に付け替える
  repoint(db, remove, "orders");
  db.orders = db.orders.filter((o) => !remove.has(o.id));

  // 台帳の顧客: 1 つの得意先にだけまとめた顧客は、ほかの記録も付け替えて消す (2 つ以上に分かれた顧客は残す)
  const customerMerge = new Map<string, string>();
  for (const [from, to] of customerMoves) if (to.size === 1) customerMerge.set(from, [...to][0]);
  if (customerMerge.size) {
    const customerById = new Map(db.customers.map((c) => [c.id, c]));
    for (const [from, to] of customerMerge) {
      const src = customerById.get(from);
      const dst = customerById.get(to);
      if (!src || !dst) {
        customerMerge.delete(from);
        continue;
      }
      dst.area ||= src.area;
      if (src.code) dst.tags = [...new Set([...dst.tags, ...src.tags, `旧コード:${src.code}`])];
      if (src.createdAt < dst.createdAt) dst.createdAt = src.createdAt;
    }
    repoint(db, customerMerge, "customers");
    db.customers = db.customers.filter((c) => !customerMerge.has(c.id));
  }

  const left = { ledgerOnly: { n: 0, total: 0 }, slipOnly: { n: 0, total: 0 } };
  for (const o of db.orders) {
    if (o.total === 0) continue;
    const bucket = isLedgerOnly(o) ? left.ledgerOnly : isSlipOrder(o) ? left.slipOnly : undefined;
    if (!bucket) continue;
    bucket.n++;
    bucket.total += o.total;
  }
  return { pairs, ordersRemoved: remove.size, customersMerged: customerMerge.size, remaining: left };
}

/** 全部の表の記録で、id の参照 (項目の値・配列の要素) を付け替える。変更履歴は当時の記録なので変えない */
function repoint(db: Database, map: Map<string, string>, self: string) {
  if (!map.size) return;
  for (const [name, value] of Object.entries(db as unknown as Record<string, unknown>)) {
    if (name === self || name === "auditLogs" || !Array.isArray(value)) continue;
    for (const item of value as Record<string, unknown>[]) {
      if (!item || typeof item !== "object") continue;
      for (const [k, v] of Object.entries(item)) {
        if (k === "id") continue;
        if (typeof v === "string" && map.has(v)) item[k] = map.get(v);
        else if (Array.isArray(v) && v.some((x) => typeof x === "string" && map.has(x))) item[k] = [...new Set(v.map((x) => (typeof x === "string" && map.has(x) ? map.get(x) : x)))];
      }
    }
  }
}

/** 月ごとの照合の表 (検証の報告用): 台帳の受注・伝票の受注の合計と、まとめたあとの売上 */
export function monthlyBreakdown(db: Database): { month: string; total: number; ledger: number; slipOnly: number; ledgerOnly: number; orders: number }[] {
  const m = new Map<string, { month: string; total: number; ledger: number; slipOnly: number; ledgerOnly: number; orders: number }>();
  for (const o of db.orders) {
    if (o.status === "cancelled") continue;
    const month = (o.salesDate ?? "").slice(0, 7);
    if (!month) continue;
    const r = m.get(month) ?? m.set(month, { month, total: 0, ledger: 0, slipOnly: 0, ledgerOnly: 0, orders: 0 }).get(month)!;
    r.total += o.total;
    r.orders++;
    if (isSlipOrder(o)) r.slipOnly += o.total;
    else if (o.source === "import") {
      r.ledger += o.total;
      if (isLedgerOnly(o)) r.ledgerOnly += o.total;
    }
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}
