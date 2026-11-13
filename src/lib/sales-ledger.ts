import type { Channel, Customer, CustomerType, Database, Order, OrderAmounts, ServiceCategory, StoreId, User } from "./db/types";

/**
 * 販売管理ソフトの「売上明細」CSV の取込
 * ------------------------------------------------------------
 * - 画面 (src/lib/actions/sales-ledger.ts) とコマンド (scripts/import/import-sales-csv.mjs) の両方で使うため、
 *   ほかのモジュールに依存しない (import は型だけ)。ブラウザでも動く
 * - 顧客は得意先コード (c_s<コード>)、売上は伝票№ (o_s<伝票№>) で登録・更新する。何度取り込んでも同じ状態になる
 * - 伝票ごとに内容の指紋 (ハッシュ) を受注の経過メモの ID に残し、次回以降は追加・変更された伝票だけを書き込む
 * - 売上台帳から移行済みの受注とは 売上日 (±3 日)・お客様の名前・金額 で照合し、同じものは新しく作らずにひも付ける。
 *   ひも付いた台帳の顧客は得意先コードの顧客に統合する (受注・予定・アンケートなどの参照を付け替える)
 * - 売上明細の金額は 2021-02 までは税抜、2021-03 から個人向けは税込 (法人向けの多くは税抜のまま)。
 *   受注の合計・内訳は売上台帳と同じ税込にそろえる (税抜の伝票は売上日の税率を掛ける)
 */

export interface SalesLine {
  item: string;
  productCode: string;
  productName: string;
  qty: number;
  unitPrice: number;
  amount: number;
}

export interface SalesStaff {
  code: string;
  name: string;
}

export interface SalesSlip {
  no: string;
  date: string;
  pickupDate?: string;
  customerCode: string;
  customerName: string;
  media: string;
  tel: string;
  fax: string;
  mobile: string;
  address: string;
  site: string;
  kubun: string;
  lines: SalesLine[];
  /** 名前のない列 (担当者コードと氏名の組) を位置ごとに */
  staff: (SalesStaff | null)[];
  fingerprint: string;
}

export interface ParsedSalesCsv {
  slips: SalesSlip[];
  rows: number;
  repaired: number;
  skipped: { line: number; reason: string }[];
}

export interface SalesImportReport {
  slips: number;
  unchanged: number;
  customersCreated: number;
  customersUpdated: number;
  customersMerged: number;
  ordersCreated: number;
  ordersUpdated: number;
  ordersLinked: number;
  storeByDefault: number;
  staffMatched: string[];
  staffUnmatched: string[];
  /** 新規・更新した受注のうち、売上明細の金額が税抜だったもの (税込に換算した) */
  taxExcluded: number;
}

const KUBUN = new Set(["個人", "建設", "不動産", "その他", "", "個人オーナー", "賃貸", "LINE@会員", "団地退去", "旅館・ホテル", "医療施設", "営業店", "その他施設", "寺・神社", "官公庁", "保育施設", "外注", "マンション", "業者紹介", "官公庁(子)"]);
const CORPORATE_KUBUN = new Set(["建設", "不動産", "旅館・ホテル", "医療施設", "営業店", "その他施設", "寺・神社", "官公庁", "官公庁(子)", "保育施設", "外注", "マンション", "業者紹介"]);
const ITEM_KEY: Record<string, keyof OrderAmounts> = {
  畳: "tatami",
  襖: "fusuma",
  障子: "shoji",
  網戸: "amido",
  カーテン: "curtain",
  クロス: "cloth",
  "自社商品&小売": "own",
  その他売り: "own",
  諸経費: "misc",
  雑工事: "misc",
  "": "misc",
  値引: "discount",
};
const CATEGORY_KEYS: [keyof OrderAmounts, ServiceCategory, string][] = [
  ["tatami", "tatami", "畳"],
  ["fusuma", "fusuma", "襖"],
  ["shoji", "shoji", "障子"],
  ["amido", "amido", "網戸"],
  ["curtain", "curtain", "カーテン"],
  ["cloth", "cloth", "クロス"],
];

const nk = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim();
const compact = (v: string) => nk(v).replace(/\s/g, "");
const num = (v: string) => {
  if (!nk(v)) return 0;
  const n = Number(nk(v).replace(/[,¥円]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const isNum = (v: string) => /^-?\d+(\.\d+)?$/.test(nk(v).replace(/,/g, ""));

function toDate(v: string): string | undefined {
  const m = nk(v).match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** FNV-1a (32 bit)。ブラウザとサーバーで同じ値になる軽い指紋 */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * CSV を伝票ごとにまとめる。
 * 販売管理ソフトの出力は値を引用符で囲まないため、施工場所などにカンマがあると列がずれる。
 * 「得意先区分・品目・商品コード」の並びを目印に列を組み直す (目印の前の余分な列は施工場所、商品名の余分な列は商品名に戻す)
 */
export function parseSalesCsv(text: string): ParsedSalesCsv {
  const physical = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const skipped: ParsedSalesCsv["skipped"] = [];
  const head = physical.findIndex((l) => l.split(",")[0]?.trim() === "伝票№");
  if (head < 0) throw new Error("売上明細の見出し (伝票№・売上日・…) が見つかりません。販売管理ソフトの「売上明細」の CSV を選んでください。");
  // 住所・施工場所に改行があると 1 行が複数行に分かれる。「伝票№,売上日」で始まらない行は前の行の続きとしてつなぐ
  const records: { line: number; raw: string }[] = [];
  const startsRecord = (l: string) => /^\s*\d+\s*,\s*\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\s*,/.test(l);
  for (let i = head + 1; i < physical.length; i++) {
    const l = physical[i];
    if (!l.replace(/,/g, "").trim()) continue;
    const last = records[records.length - 1];
    if (!startsRecord(l) && last) last.raw = `${last.raw.replace(/,+$/, "")},${l}`;
    else records.push({ line: i + 1, raw: l });
  }
  const slips = new Map<string, SalesSlip & { order: number }>();
  let rows = 0;
  let repaired = 0;
  for (const { line, raw } of records) {
    rows++;
    const f = raw.split(",");
    const anchorOk = (k: number) => KUBUN.has(nk(f[k])) && nk(f[k + 1]) in ITEM_KEY && /^\d*$/.test(nk(f[k + 2]));
    let k = 11;
    if (!anchorOk(11)) {
      k = -1;
      for (let j = 12; j + 6 < f.length; j++) if (anchorOk(j)) { k = j; break; }
      if (k < 0 && nk(f[12]) in ITEM_KEY) k = 11; // 得意先区分が新しい値のとき
      if (k < 0) { skipped.push({ line, reason: "列の並びを読み取れません" }); continue; }
      if (k !== 11) repaired++;
    }
    // 商品名にカンマがある場合: 数量・単価・金額 (数字 3 つ) が並ぶ位置を探す
    const findTriple = (ok: (v: string) => boolean) => {
      for (let x = k + 4; x + 2 < f.length; x++) if (ok(f[x]) && ok(f[x + 1]) && isNum(f[x + 2])) return x;
      return -1;
    };
    let j = findTriple(isNum);
    if (j < 0) j = findTriple((v) => isNum(v) || !nk(v)); // 数量・単価が空の行
    if (j < 0) { skipped.push({ line, reason: "数量・単価・金額を読み取れません" }); continue; }
    if (j !== k + 4) repaired++;
    const no = nk(f[0]);
    const date = toDate(f[1]);
    if (!no || !date) { skipped.push({ line, reason: "伝票№または売上日がありません" }); continue; }
    const staff: (SalesStaff | null)[] = [];
    const tail = f.slice(j + 3).map(nk);
    for (let p = 0; p + 1 < tail.length; p += 2) staff.push(tail[p] && tail[p + 1] && isNum(tail[p]) && !isNum(tail[p + 1]) ? { code: tail[p], name: tail[p + 1] } : null);
    const lineItem: SalesLine = { item: nk(f[k + 1]), productCode: nk(f[k + 2]), productName: f.slice(k + 3, j).map(nk).join(","), qty: num(f[j]), unitPrice: num(f[j + 1]), amount: num(f[j + 2]) };
    let s = slips.get(no);
    if (!s) {
      s = {
        no,
        date,
        pickupDate: toDate(f[2]),
        customerCode: nk(f[3]),
        customerName: nk(f[4]),
        media: nk(f[5]),
        tel: nk(f[6]),
        fax: nk(f[7]),
        mobile: nk(f[8]),
        address: nk(f[9]),
        site: f.slice(10, k).map(nk).filter(Boolean).join(","),
        kubun: nk(f[k]),
        lines: [],
        staff: [],
        fingerprint: "",
        order: slips.size,
      };
      slips.set(no, s);
    }
    s.lines.push(lineItem);
    staff.forEach((st, p) => {
      if (st && !s.staff[p]) s.staff[p] = st;
    });
  }
  const out = [...slips.values()]
    .sort((a, b) => a.order - b.order)
    .map((x) => {
      const s: SalesSlip = { no: x.no, date: x.date, pickupDate: x.pickupDate, customerCode: x.customerCode, customerName: x.customerName, media: x.media, tel: x.tel, fax: x.fax, mobile: x.mobile, address: x.address, site: x.site, kubun: x.kubun, lines: x.lines, staff: Array.from(x.staff, (st) => st ?? null), fingerprint: "" };
      if (s.pickupDate === undefined) delete s.pickupDate;
      s.fingerprint = slipFingerprint(s);
      return s;
    });
  return { slips: out, rows, repaired, skipped };
}

/** 伝票の内容の指紋 (fingerprint 以外の項目から計算する) */
export function slipFingerprint(s: SalesSlip): string {
  return fnv(JSON.stringify({ ...s, fingerprint: undefined }));
}

/** 画面から届いた伝票の形を確かめ、指紋を計算し直す。形が違うときは null */
export function normalizeSlip(v: unknown): SalesSlip | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 500) : "");
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  if (!str(o.no) || !/^\d{4}-\d{2}-\d{2}$/.test(str(o.date)) || !Array.isArray(o.lines) || !Array.isArray(o.staff) || o.lines.length > 500) return null;
  const s: SalesSlip = {
    no: str(o.no),
    date: str(o.date),
    pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(str(o.pickupDate)) ? str(o.pickupDate) : undefined,
    customerCode: str(o.customerCode),
    customerName: str(o.customerName),
    media: str(o.media),
    tel: str(o.tel),
    fax: str(o.fax),
    mobile: str(o.mobile),
    address: str(o.address),
    site: str(o.site),
    kubun: str(o.kubun),
    lines: (o.lines as Record<string, unknown>[]).map((l) => ({ item: str(l?.item), productCode: str(l?.productCode), productName: str(l?.productName), qty: n(l?.qty), unitPrice: n(l?.unitPrice), amount: n(l?.amount) })),
    staff: (o.staff as unknown[]).slice(0, 10).map((x) => (x && typeof x === "object" && str((x as SalesStaff).code) ? { code: str((x as SalesStaff).code), name: str((x as SalesStaff).name) } : null)),
    fingerprint: "",
  };
  if (s.pickupDate === undefined) delete s.pickupDate;
  s.fingerprint = slipFingerprint(s);
  return s;
}

/* ------------------------------------------------------------------ */
/* 取込                                                                 */
/* ------------------------------------------------------------------ */

/** 売上日の消費税率 */
export function taxRate(date: string): number {
  if (date < "1989-04-01") return 0;
  if (date < "1997-04-01") return 0.03;
  if (date < "2014-04-01") return 0.05;
  if (date < "2019-10-01") return 0.08;
  return 0.1;
}

const isoAt = (date: string, h: number) => new Date(`${date}T${String(h).padStart(2, "0")}:00:00+09:00`).toISOString();
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const NOTE_PREFIX = "pn_s";
const MANAGED_TAG = /^(媒体|区分):/;
const NOTE_BEGIN = "【販売管理ソフト】";
const INCLUSIVE_FROM = "2021-03-01";

function mediaChannel(media: string): Channel {
  if (/紹介|知人|口コミ|リピーター/.test(media)) return "referral";
  if (/ホームページ|Google|ネット|Web/i.test(media)) return "web";
  if (/LINE/i.test(media)) return "line";
  if (/イベント|催事/.test(media)) return "event";
  if (/来店|ショールーム|店舗/.test(media)) return "visit";
  if (/DM/.test(media)) return "mail";
  return "unknown";
}

function mediaStore(media: string): StoreId | undefined {
  if (/玉名/.test(media)) return "tamana";
  if (/中央/.test(media)) return "chuo";
  if (/西店/.test(media)) return "nishi";
  if (/合志/.test(media)) return "koshi";
  if (/本社|ショールーム/.test(media)) return "hq";
  return undefined;
}

/** 住所の市区町村 (熊本市は区まで) */
function areaOf(address: string): string {
  const a = nk(address).replace(/\s/g, "").replace(/^熊本県/, "");
  return a.match(/^(熊本市.+?区|.+?郡.+?[町村]|.+?市)/)?.[1] ?? "";
}

/** 担当者コード → 社員。氏名の一致 > 名前 (姓なし) の一致 > 姓だけの一致 (CSV でその姓が 1 人のときだけ) */
function matchStaff(users: User[], slips: SalesSlip[]): Map<string, User> {
  const dir = new Map<string, string>();
  for (const s of slips) for (const st of s.staff) if (st && !dir.has(st.code)) dir.set(st.code, compact(st.name));
  const names = [...dir.values()];
  const out = new Map<string, User>();
  for (const [code, name] of dir) {
    const cands = users.map((u) => ({ u, n: compact(u.name) })).filter(({ n }) => n.length >= 2);
    const exact = cands.find(({ n }) => n === name);
    const given = cands.filter(({ n }) => n.length >= 3 && name.endsWith(n));
    const family = cands.filter(({ n }) => name.startsWith(n) && names.filter((x) => x.startsWith(n)).length === 1);
    const hit = exact ?? (given.length === 1 ? given[0] : undefined) ?? (family.length === 1 ? family[0] : undefined);
    if (hit) out.set(code, hit.u);
  }
  return out;
}

function amountsOf(slips: SalesSlip[], factor: number): OrderAmounts {
  const a: OrderAmounts = { tatami: 0, fusuma: 0, shoji: 0, amido: 0, curtain: 0, cloth: 0, own: 0, misc: 0, discount: 0 };
  for (const s of slips) for (const l of s.lines) if (Number.isFinite(l.amount)) a[ITEM_KEY[l.item] ?? "misc"] += l.amount;
  for (const k of Object.keys(a) as (keyof OrderAmounts)[]) a[k] = Math.round(a[k] * factor);
  return a;
}

function titleOf(a: OrderAmounts): { title: string; category: ServiceCategory } {
  const cats = CATEGORY_KEYS.filter(([k]) => a[k] > 0);
  const main = [...CATEGORY_KEYS].sort((x, y) => a[y[0]] - a[x[0]])[0];
  return { title: cats.length ? cats.map(([, , l]) => l).join("・") : a.own > 0 ? "自社商品" : "諸経費・その他", category: a[main[0]] > 0 ? main[1] : "other" };
}

function noteBody(s: SalesSlip, inclusive: boolean): string {
  const lines = s.lines.map((l) => `${l.item || "-"} ${l.productName || ""} ${l.qty}×${yen(l.unitPrice)}=${yen(l.amount)}`.replace(/\s+/g, " "));
  const staff = s.staff.filter((x): x is SalesStaff => Boolean(x)).map((x) => `${x.code} ${x.name}`);
  return [
    `販売管理ソフトの売上明細より取込 (伝票№${s.no}${s.pickupDate ? `・引上日 ${s.pickupDate}` : ""})`,
    `明細 (${inclusive ? "税込" : "税抜"}): ${lines.join(" / ")}`,
    staff.length ? `担当者欄: ${staff.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function surname(name: string): string {
  const n = nk(name).replace(/(様|邸|さん)$/, "");
  return n.includes(" ") ? n.split(" ")[0] : n.slice(0, 2);
}

function similarName(ledgerName: string, csvName: string): boolean {
  const a = compact(ledgerName).replace(/(様|邸|さん)$/, "");
  const b = compact(csvName);
  const sn = compact(surname(csvName));
  if (!a || !b) return false;
  return a === b || (sn.length >= 1 && a.includes(sn)) || (a.length >= 2 && b.includes(a));
}

const LEDGER_CUSTOMER = /^c_[0-9a-f]{12}$/;

/**
 * 伝票をデータベースに反映する (db を直接書き換える。画面では mutate の中で呼ぶ)。
 * 取り込む伝票が全件のときは、照合できた受注から担当者・お客様ごとの店舗を学習し、照合できない伝票の店舗に使う
 */
export function applySalesSlips(db: Database, slips: SalesSlip[], opts: { now: string; userId: string }): SalesImportReport {
  const report: SalesImportReport = { slips: slips.length, unchanged: 0, customersCreated: 0, customersUpdated: 0, customersMerged: 0, ordersCreated: 0, ordersUpdated: 0, ordersLinked: 0, storeByDefault: 0, staffMatched: [], staffUnmatched: [], taxExcluded: 0 };
  const staffMap = matchStaff(db.users, slips);
  const staffDir = new Map<string, string>();
  for (const s of slips) for (const st of s.staff) if (st) staffDir.set(st.code, st.name);
  for (const [code, name] of staffDir) (staffMap.has(code) ? report.staffMatched : report.staffUnmatched).push(`${code} ${name}${staffMap.has(code) ? ` → ${staffMap.get(code)!.name}` : ""}`);

  const customerById = new Map(db.customers.map((c) => [c.id, c]));
  const managerOf = new Map(db.stores.map((s) => [s.id, s.managerUserId]));
  const fallbackUser = db.users.find((u) => u.role === "admin" && u.active)?.id ?? opts.userId;

  // 前回までに取り込んだ伝票 (経過メモの ID: pn_s<伝票№>_<指紋>)
  const linked = new Map<string, { order: Order; fingerprint: string }>();
  for (const o of db.orders)
    for (const n of o.progressNotes)
      if (n.id.startsWith(NOTE_PREFIX)) {
        const [no, fp] = n.id.slice(NOTE_PREFIX.length).split("_");
        linked.set(no, { order: o, fingerprint: fp ?? "" });
      }
  const linkedOrders = new Set([...linked.values()].map((x) => x.order.id));

  // 照合の候補: 売上台帳から移行した受注 (まだ伝票とひも付いていないもの) を売上日ごとに
  const ledgerByDate = new Map<string, Order[]>();
  for (const o of db.orders) {
    if (o.source !== "import" || linkedOrders.has(o.id) || o.id.startsWith("o_s") || !o.salesDate) continue;
    const list = ledgerByDate.get(o.salesDate) ?? [];
    list.push(o);
    ledgerByDate.set(o.salesDate, list);
  }
  const used = new Set<string>();

  // 同じ得意先・同じ売上日の伝票は 1 件の受注として照合する (売上台帳は 1 日 1 行にまとめているため)
  const todo = slips.filter((s) => linked.get(s.no)?.fingerprint !== s.fingerprint);
  report.unchanged = slips.length - todo.length;
  const groups = new Map<string, SalesSlip[]>();
  for (const s of todo) {
    const key = `${s.customerCode}|${s.date}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const matchOf = new Map<string, Order>(); // 伝票№ → 台帳の受注
  const inclusiveOf = new Map<string, boolean>(); // 伝票№ → 金額が税込か (台帳の合計と比べて判定できたもの)
  for (const group of groups.values()) {
    if (group.some((s) => linked.has(s.no))) continue;
    const first = group[0];
    const gross = group.reduce((a, s) => a + s.lines.reduce((b, l) => b + (Number.isFinite(l.amount) ? l.amount : 0), 0), 0);
    const taxed = Math.round(gross * (1 + taxRate(first.date)));
    let best: { o: Order; score: number } | undefined;
    for (let d = -3; d <= 3; d++) {
      const day = new Date(Date.parse(`${first.date}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
      for (const o of ledgerByDate.get(day) ?? []) {
        if (used.has(o.id)) continue;
        const c = customerById.get(o.customerId);
        if (!c || !similarName(c.name, first.customerName)) continue;
        const diff = Math.min(Math.abs(o.total - taxed), Math.abs(o.total - gross));
        if (diff > Math.max(100, Math.abs(o.total) * 0.03)) continue;
        const score = Math.abs(d) * 10 + diff / Math.max(1, Math.abs(o.total));
        if (!best || score < best.score) best = { o, score };
      }
    }
    if (best) {
      used.add(best.o.id);
      const inclusive = taxed === gross ? undefined : Math.abs(best.o.total - gross) <= Math.abs(best.o.total - taxed);
      for (const s of group) {
        matchOf.set(s.no, best.o);
        if (inclusive !== undefined) inclusiveOf.set(s.no, inclusive);
      }
    }
  }

  // 税込・税抜の判定: 2021-03 から個人向けは税込、法人向けの多くは税抜のまま。照合できない伝票は
  // 同じ得意先 > 同じ得意先区分 の多数決 (前回までの取込分も経過メモの「明細 (税込)/(税抜)」から数える)
  const votes = { code: new Map<string, [number, number]>(), kubun: new Map<string, [number, number]>() };
  const vote = (m: Map<string, [number, number]>, key: string, inclusive: boolean) => {
    const x = m.get(key) ?? [0, 0];
    x[inclusive ? 0 : 1]++;
    m.set(key, x);
  };
  for (const s of todo) {
    const inc = inclusiveOf.get(s.no);
    if (inc === undefined || s.date < INCLUSIVE_FROM) continue;
    vote(votes.code, s.customerCode, inc);
    vote(votes.kubun, s.kubun, inc);
  }
  const todoNos = new Set(todo.map((s) => s.no));
  for (const o of db.orders) {
    if (!o.salesDate || o.salesDate < INCLUSIVE_FROM || !o.customerId.startsWith("c_s")) continue;
    for (const n of o.progressNotes) {
      if (!n.id.startsWith(NOTE_PREFIX) || todoNos.has(n.id.slice(NOTE_PREFIX.length).split("_")[0])) continue;
      const inc = n.body.includes("明細 (税込)") ? true : n.body.includes("明細 (税抜)") ? false : undefined;
      if (inc === undefined) continue;
      vote(votes.code, o.customerId.slice(3), inc);
      const kubun = customerById.get(o.customerId)?.tags.find((t) => t.startsWith("区分:"))?.slice(3);
      if (kubun !== undefined) vote(votes.kubun, kubun, inc);
    }
  }
  const majority = (x: [number, number] | undefined) => (x ? x[0] >= x[1] : undefined);
  const isInclusive = (s: SalesSlip): boolean =>
    inclusiveOf.get(s.no) ?? (s.date < INCLUSIVE_FROM ? false : (majority(votes.code.get(s.customerCode)) ?? majority(votes.kubun.get(s.kubun)) ?? !CORPORATE_KUBUN.has(s.kubun)));

  // 店舗の学習: 照合できた受注の店舗を、担当者コード・得意先コードごとに数える
  const staffStores = new Map<string, Map<StoreId, number>>();
  const customerStores = new Map<string, Map<StoreId, number>>();
  const countUp = (m: Map<string, Map<StoreId, number>>, key: string, store: StoreId) => {
    const x = m.get(key) ?? new Map<StoreId, number>();
    x.set(store, (x.get(store) ?? 0) + 1);
    m.set(key, x);
  };
  const top = (m: Map<StoreId, number> | undefined, min = 0.6): StoreId | undefined => {
    if (!m) return undefined;
    const total = [...m.values()].reduce((a, v) => a + v, 0);
    const [store, n] = [...m].sort((a, b) => b[1] - a[1])[0] ?? [];
    return store && n / total >= min ? store : undefined;
  };
  const areaStores = new Map<string, Map<StoreId, number>>();
  for (const s of todo) {
    const o = matchOf.get(s.no) ?? linked.get(s.no)?.order;
    if (!o || o.storeId === "hq") continue;
    for (const st of s.staff.slice(0, 2)) if (st) countUp(staffStores, st.code, o.storeId);
    countUp(customerStores, s.customerCode, o.storeId);
  }
  for (const o of db.orders) {
    const area = o.storeId !== "hq" && o.siteAddress ? areaOf(o.siteAddress) : "";
    if (area) countUp(areaStores, area, o.storeId);
  }
  const staffStore = (st: SalesStaff | null | undefined): StoreId | undefined => {
    if (!st) return undefined;
    const u = staffMap.get(st.code);
    if (u && u.storeId !== "hq" && u.role !== "hq_staff") return u.storeId;
    return top(staffStores.get(st.code));
  };
  const storeFor = (s: SalesSlip): StoreId | undefined => {
    const existing = customerById.get(`c_s${s.customerCode}`);
    return top(customerStores.get(s.customerCode), 0.5) ?? (existing && existing.storeId !== "hq" ? existing.storeId : undefined) ?? staffStore(s.staff[1]) ?? staffStore(s.staff[0]) ?? mediaStore(s.media) ?? top(areaStores.get(areaOf(s.site || s.address)), 0.5);
  };

  // 顧客: 得意先コードごとに最新の伝票の内容で登録・更新
  const byCustomer = new Map<string, SalesSlip[]>();
  for (const s of todo) {
    const list = byCustomer.get(s.customerCode);
    if (list) list.push(s);
    else byCustomer.set(s.customerCode, [s]);
  }
  const mergeInto = new Map<string, Map<string, number>>(); // 台帳の顧客 → (得意先の顧客 → 件数)
  for (const [code, list] of byCustomer) {
    if (!code) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const latest = list[list.length - 1];
    const pick = (f: (s: SalesSlip) => string) => [...list].reverse().map(f).find(Boolean) ?? "";
    const id = `c_s${code}`;
    let c = customerById.get(id);
    const store = list.map(storeFor).find(Boolean);
    const phone = pick((s) => s.tel) || pick((s) => s.mobile);
    const extra = [pick((s) => s.mobile) && pick((s) => s.mobile) !== phone ? `携帯: ${pick((s) => s.mobile)}` : "", pick((s) => s.fax) ? `FAX: ${pick((s) => s.fax)}` : "", `得意先コード: ${code}`].filter(Boolean).join(" / ");
    const kubun = pick((s) => s.kubun);
    const media = list.map((s) => s.media).find(Boolean) ?? "";
    const type: CustomerType = CORPORATE_KUBUN.has(kubun) ? "corporate" : "individual";
    const managedNote = `${NOTE_BEGIN}${extra}`;
    const fields = {
      name: latest.customerName || c?.name || code,
      type,
      phone,
      address: pick((s) => s.address),
    };
    if (!c) {
      c = {
        id,
        code: `T-${code}`,
        kana: "",
        postalCode: "",
        storeId: store ?? "hq",
        preferredChannel: "phone",
        firstContactChannel: mediaChannel(media),
        tags: [media && `媒体:${media}`, kubun && `区分:${kubun}`].filter(Boolean) as string[],
        notes: managedNote,
        createdAt: isoAt(list[0].date, 9),
        updatedAt: isoAt(latest.date, 18),
        ...fields,
      } satisfies Customer;
      db.customers.push(c);
      customerById.set(id, c);
      report.customersCreated++;
    } else {
      const before = JSON.stringify(c);
      Object.assign(c, fields);
      if (store && c.storeId === "hq") c.storeId = store;
      c.tags = [...c.tags.filter((t) => !MANAGED_TAG.test(t)), ...([media && `媒体:${media}`, kubun && `区分:${kubun}`].filter(Boolean) as string[])];
      const userNotes = c.notes.split("\n").filter((l) => !l.startsWith(NOTE_BEGIN));
      c.notes = [managedNote, ...userNotes].filter(Boolean).join("\n");
      if (isoAt(latest.date, 18) > c.updatedAt) c.updatedAt = isoAt(latest.date, 18);
      if (JSON.stringify(c) !== before) report.customersUpdated++;
    }
    for (const s of list) {
      const o = matchOf.get(s.no);
      if (o && o.customerId !== id && LEDGER_CUSTOMER.test(o.customerId)) {
        const m = mergeInto.get(o.customerId) ?? new Map<string, number>();
        m.set(id, (m.get(id) ?? 0) + 1);
        mergeInto.set(o.customerId, m);
      }
    }
  }

  // 受注
  const ordersById = new Map(db.orders.map((o) => [o.id, o]));
  for (const s of todo) {
    const customerId = `c_s${s.customerCode}`;
    const inclusive = isInclusive(s);
    const amounts = amountsOf([s], inclusive ? 1 : 1 + taxRate(s.date));
    const total = Object.values(amounts).reduce((a, v) => a + v, 0);
    const worker = s.staff[1] ? staffMap.get(s.staff[1].code) : undefined;
    const input = s.staff[2] ? staffMap.get(s.staff[2].code) : undefined;
    const note = { id: `${NOTE_PREFIX}${s.no}_${s.fingerprint}`, at: isoAt(s.date, 18), userId: input?.id ?? fallbackUser, kind: "complete" as const, body: noteBody(s, inclusive) };
    const prev = linked.get(s.no)?.order;
    const ledger = matchOf.get(s.no);
    const target = prev ?? ledger;
    if (!inclusive && (!target || target.id === `o_s${s.no}`)) report.taxExcluded++;
    if (target) {
      target.progressNotes = [...target.progressNotes.filter((n) => !n.id.startsWith(`${NOTE_PREFIX}${s.no}_`)), note];
      if (worker && !target.workerIds.includes(worker.id)) target.workerIds = [...target.workerIds, worker.id];
      if (target.id === `o_s${s.no}`) {
        const { title, category } = titleOf(amounts);
        Object.assign(target, { customerId, title, category, total, amounts, contractDate: s.date, salesDate: s.date, completedAt: s.date, siteAddress: s.site || s.address, updatedAt: opts.now });
        report.ordersUpdated++;
      } else if (prev) {
        report.ordersUpdated++;
      } else {
        report.ordersLinked++;
      }
      continue;
    }
    const store = storeFor(s);
    if (!store) report.storeByDefault++;
    const storeId = store ?? "hq";
    const { title, category } = titleOf(amounts);
    const o: Order = {
      id: `o_s${s.no}`,
      number: `S-${s.no}`,
      customerId,
      storeId,
      title,
      category,
      contractDate: s.date,
      total,
      status: "paid",
      scheduledStart: s.date,
      scheduledEnd: s.date,
      workerIds: worker ? [worker.id] : [],
      siteAddress: s.site || s.address,
      completedAt: s.date,
      salesDate: s.date,
      progressNotes: [note],
      createdBy: input?.id ?? managerOf.get(storeId) ?? fallbackUser,
      createdAt: isoAt(s.date, 18),
      updatedAt: isoAt(s.date, 18),
      amounts,
      source: "import",
      sourceRef: `売上明細#伝票№${s.no}`,
    };
    if (ordersById.has(o.id)) Object.assign(ordersById.get(o.id)!, o);
    else {
      db.orders.push(o);
      ordersById.set(o.id, o);
    }
    report.ordersCreated++;
  }

  // 台帳の顧客の統合 (照合できた得意先が 1 つだけのとき)
  const refs = new Map<string, Record<string, unknown>[]>(); // 顧客 ID → その顧客を参照している行
  if (mergeInto.size) {
    for (const value of Object.values(db as unknown as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      for (const item of value as Record<string, unknown>[]) {
        const ref = typeof item.customerId === "string" ? item.customerId : item.parentType === "customer" && typeof item.parentId === "string" ? item.parentId : undefined;
        if (!ref || !mergeInto.has(ref)) continue;
        const list = refs.get(ref);
        if (list) list.push(item);
        else refs.set(ref, [item]);
      }
    }
  }
  const remove = new Set<string>();
  for (const [from, targets] of mergeInto) {
    if (targets.size !== 1) continue;
    const to = [...targets.keys()][0];
    const src = customerById.get(from);
    const dst = customerById.get(to);
    if (!src || !dst) continue;
    for (const item of refs.get(from) ?? []) {
      if (item.customerId === from) item.customerId = to;
      if (item.parentType === "customer" && item.parentId === from) item.parentId = to;
    }
    dst.area ||= src.area;
    if (src.code) dst.tags = [...new Set([...dst.tags, ...src.tags, `旧コード:${src.code}`])];
    if (src.createdAt < dst.createdAt) dst.createdAt = src.createdAt;
    remove.add(from);
    report.customersMerged++;
  }
  if (remove.size) db.customers = db.customers.filter((c) => !remove.has(c.id));
  return report;
}
