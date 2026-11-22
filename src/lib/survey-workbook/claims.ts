import { createHash } from "node:crypto";
import type { Customer, Database, Order, QualityKind, StoreId } from "@/lib/db/types";
import { QUALITY_CATEGORIES } from "@/lib/kpi-settings";
import { isDitto, nk, nkTight, parseMonth, parseYear, storeOfLabel, ym, type WorkbookTab } from "./tabs";

/**
 * 「クレーム手直し内容」のタブ → クレーム・手直しの記録
 * ------------------------------------------------------------
 * 列 (見出しの行で探す): 年・月・店舗・カテゴリー・クレームor手直し・内容・原因・対策・現場名・発生由来。年の左の列の「クレームとしてはカウントしない」も読む。
 * - 「同上」「〃」は上の行と同じ
 * - クレームの行の次の行が同じ月・店舗・現場の手直しで、内容が「同上」(または同じ・空欄) なら 1 件の「クレーム＋手直し」(シートのクレーム 1 + 手直し 1 = 3 点)
 * - 集計に入れない (counted = false): 「クレームとしてはカウントしない」・発生由来が点検 DM・点検電話・「カウントしない」(クレーム手直し処理オペレーションの定義)。
 *   クレームだけ数えない組は「手直し」として数える
 * - 区分 (クレーム・手直し) が空欄の行はクレームとして数え「要確認」にする (KPI のシートの手計算がクレームとして数えていたため)。
 *   内容が空欄の行 (区分はある) は「(内容はシートに未記入)」で数える
 * - 同じ月・店舗・区分・現場で内容もほぼ同じ行 (二重の記入。KPI のシートは 1 件と数えている) は 1 件にする
 * - 期間の重なるタブ (「2024.1～」と「2025.12～」): 新しいタブの始まりの月からは新しいタブだけを使う
 * - 日はシートにないため発生日は月の 1 日。案件 (受注) は 現場名 (「（地区）名前邸」) と店舗・月で 1 件に決まるときだけひも付ける
 */

export interface ClaimSheetRow {
  sheet: string;
  row: number;
  year: number;
  month: number;
  store: StoreId | "office";
  kind: "claim" | "rework" | "";
  category?: string;
  description: string;
  cause: string;
  countermeasure: string;
  site: string;
  origin: string;
  /** 「クレームとしてはカウントしない」などの印 */
  notCountedMark: string;
  raw: { description: string; site: string };
}

export interface ClaimRecord {
  /** 同じ行を 2 回取り込まないための印 (年月・単位・区分・現場名・同じ組の何番目か) */
  key: string;
  sourceRef: string;
  hash: string;
  occurredOn: string;
  storeId: StoreId;
  attribution: "store" | "office";
  kind: QualityKind;
  category?: string;
  description: string;
  cause?: string;
  countermeasure?: string;
  siteName?: string;
  origin?: string;
  counted: boolean;
  /** 取り込むときの注意 (画面の確認に出す) */
  notes: string[];
  /** 要確認 (区分が空欄など) */
  review?: string;
  rows: { sheet: string; row: number }[];
}

interface Columns {
  year: number;
  month: number;
  store: number;
  category: number;
  kind: number;
  description: number;
  cause: number;
  countermeasure: number;
  site: number;
  origin: number;
  mark: number;
}

function findColumns(rows: string[][]): { header: number; col: Columns } | null {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = rows[r].map(nkTight);
    const at = (re: RegExp) => cells.findIndex((c) => re.test(c));
    const year = at(/^年$/);
    const kind = at(/^クレーム(or|・|\/)?手直し$/i);
    const description = at(/^内容$/);
    if (year < 0 || kind < 0 || description < 0) continue;
    return {
      header: r,
      col: { year, month: at(/^月$/), store: at(/^店舗$/), category: at(/^カテゴリー?$/), kind, description, cause: at(/^原因$/), countermeasure: at(/^対策/), site: at(/^現場名?$/), origin: at(/^(発生)?由来$/), mark: year - 1 },
    };
  }
  return null;
}

const cell = (row: string[], i: number) => (i >= 0 ? nk(row[i] ?? "") : "");

/** タブの行を読む (年・月のない行・空の行は読まない) */
export function parseClaimTab(tab: WorkbookTab): { rows: ClaimSheetRow[]; problems: string[]; empty: number; start?: string } {
  const found = findColumns(tab.rows);
  if (!found) return { rows: [], problems: [`「${tab.title}」: 見出し (年・月・店舗・クレームor手直し・内容) の行が見つかりません`], empty: 0 };
  const { header, col } = found;
  const out: ClaimSheetRow[] = [];
  const problems: string[] = [];
  let empty = 0;
  let prev: ClaimSheetRow | undefined;
  for (let r = header + 1; r < tab.rows.length; r++) {
    const row = tab.rows[r];
    const year = parseYear(row[col.year]);
    const month = parseMonth(row[col.month]);
    if (!year || !month) continue;
    const storeLabel = cell(row, col.store);
    const kindRaw = nkTight(row[col.kind]);
    const kind: ClaimSheetRow["kind"] = /^クレーム/.test(kindRaw) ? "claim" : /^手直し/.test(kindRaw) ? "rework" : "";
    const rawDesc = cell(row, col.description);
    const rawSite = cell(row, col.site);
    const pick = (raw: string, before: string | undefined) => (isDitto(raw) ? (before ?? "") : raw);
    const description = pick(rawDesc, prev?.description);
    const cause = pick(cell(row, col.cause), prev?.cause);
    const countermeasure = pick(cell(row, col.countermeasure), prev?.countermeasure);
    const site = pick(rawSite, prev?.site);
    if (!kind && !description) {
      empty++;
      continue;
    }
    const store = storeOfLabel(storeLabel);
    if (!store) {
      problems.push(`「${tab.title}」${r + 1} 行目: 店舗「${storeLabel || "(空欄)"}」が分かりません (合志・中央・西・玉名・事務)`);
      continue;
    }
    const categoryRaw = cell(row, col.category);
    const parsed: ClaimSheetRow = {
      sheet: tab.title,
      row: r + 1,
      year,
      month,
      store,
      kind,
      category: (QUALITY_CATEGORIES as readonly string[]).includes(categoryRaw) ? categoryRaw : undefined,
      description,
      cause,
      countermeasure,
      site,
      origin: cell(row, col.origin),
      notCountedMark: cell(row, col.mark),
      raw: { description: rawDesc, site: rawSite },
    };
    out.push(parsed);
    prev = parsed;
  }
  // タブの期間の始まり: 名前 (「2025.12～」) か、名前に書いていなければ最も古い行の月
  const m = nk(tab.title).match(/(20\d\d)[.年/-](\d{1,2})/);
  const oldest = out.map((r) => ym(r.year, r.month)).sort()[0];
  return { rows: out, problems, empty, start: m ? ym(Number(m[1]), Number(m[2])) : oldest };
}

/** 集計に入れない印 (シートの左の列・発生由来) */
function notCountedReason(r: ClaimSheetRow): string | undefined {
  if (/カウントしない|数えない/.test(r.notCountedMark)) return `シート: ${r.notCountedMark}`;
  if (/カウントしない|数えない/.test(r.origin)) return `シート (発生由来): ${r.origin}`;
  if (/点検/.test(r.origin)) return `発生由来が「${r.origin}」(点検 DM・点検電話がきっかけのものは数えない)`;
  return undefined;
}

const blankish = (v: string) => !v || isDitto(v);

/** 組 (クレームの行 + 次の手直しの行) か */
function pairs(a: ClaimSheetRow, b: ClaimSheetRow | undefined): boolean {
  if (!b || a.kind !== "claim" || b.kind !== "rework") return false;
  if (a.year !== b.year || a.month !== b.month || a.store !== b.store) return false;
  const sameDesc = blankish(b.raw.description) || b.description === a.description;
  const sameSite = blankish(b.raw.site) || nkTight(b.site) === nkTight(a.site);
  return sameDesc && sameSite;
}

/** 文の似ている度合い (2 文字の組の一致。0〜1) が 0.6 以上か */
function similar(a: string, b: string): boolean {
  const grams = (t: string) => {
    const s = nkTight(t).replace(/[、。,.!！?？()（）]/g, "");
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  if (!x.length || !y.length) return nkTight(a) === nkTight(b);
  const pool = [...y];
  let common = 0;
  for (const g of x) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      common++;
      pool.splice(i, 1);
    }
  }
  return (2 * common) / (x.length + y.length) >= 0.6;
}

const joinDistinct = (...xs: (string | undefined)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].join("\n") || undefined;

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** シートの行 → 記録 (組をまとめ、期間の重なるタブは新しいタブを使う) */
export function buildClaimRecords(tabs: { title: string; rows: ClaimSheetRow[]; start?: string }[]): { records: ClaimRecord[]; overlapSkipped: number } {
  // 新しいタブの始まりの月から先は新しいタブだけ
  const sorted = [...tabs].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const owner = (sheet: string, month: string) => {
    const later = sorted.filter((t) => t.start && t.start <= month).at(-1);
    return !later || later.title === sheet || !sorted.find((t) => t.title === sheet)?.start;
  };
  const records: ClaimRecord[] = [];
  const seen = new Map<string, number>();
  let overlapSkipped = 0;
  for (const tab of sorted) {
    const rows = tab.rows.filter((r) => {
      const ok = owner(tab.title, ym(r.year, r.month));
      if (!ok) overlapSkipped++;
      return ok;
    });
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      const pair = pairs(a, b);
      if (pair) i++;
      const notes: string[] = [];
      const ra = notCountedReason(a);
      const rb = pair ? notCountedReason(b!) : undefined;
      let kind: QualityKind;
      let counted = true;
      if (pair) {
        if (!ra && !rb) kind = "claim_rework";
        else if (ra && !rb) {
          kind = "rework";
          notes.push(`クレームとしては数えない (${ra})。手直しとして数えます`);
        } else if (!ra && rb) {
          kind = "claim";
          notes.push(`手直しとしては数えない (${rb})。クレームとして数えます`);
        } else {
          kind = "claim_rework";
          counted = false;
          notes.push(ra!);
        }
      } else if (a.kind === "claim" || a.kind === "rework") {
        kind = a.kind;
        if (ra) {
          counted = false;
          notes.push(ra);
        }
      } else {
        // 区分が空欄: KPI のシートはクレームとして数えていた。数えたうえで「要確認」にする
        kind = "claim";
        if (ra) {
          counted = false;
          notes.push(ra);
        }
      }
      const review = a.kind ? undefined : "シートの区分 (クレーム・手直し) が空欄でした。KPI のシートに合わせてクレームとして数えています。違うときは詳細の画面で区分を直してください";
      const office = a.store === "office";
      const storeId: StoreId = a.store === "office" ? "hq" : a.store;
      const site = nk(a.site).replace(/\s*\n\s*/g, " ");
      const base = `${ym(a.year, a.month)}|${a.store}|${kind}|${nkTight(site) || nkTight(a.description).slice(0, 24)}`;
      const description = joinDistinct(a.description, pair ? b!.description : undefined) ?? "(内容はシートに未記入)";
      // 二重の記入 (同じ月・店舗・区分・現場で内容がほぼ同じ): 先の記録に行を足すだけにする
      const twin = records.find((x) => x.key.startsWith(`${base}#`) && similar(x.description, description));
      if (twin) {
        twin.rows.push(...(pair ? [{ sheet: a.sheet, row: a.row }, { sheet: b!.sheet, row: b!.row }] : [{ sheet: a.sheet, row: a.row }]));
        twin.notes.push(`シートに同じ内容の行がもう 1 つあります (${a.sheet} ${a.row} 行目)。1 件として取り込みます`);
        continue;
      }
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const key = `${base}#${n}`;
      const rec: ClaimRecord = {
        key,
        sourceRef: `sheet:claims:${sha(key)}`,
        hash: "",
        occurredOn: `${ym(a.year, a.month)}-01`,
        storeId,
        attribution: office ? "office" : "store",
        kind,
        category: a.category ?? (pair ? b!.category : undefined),
        description,
        cause: joinDistinct(a.cause, pair ? b!.cause : undefined),
        countermeasure: joinDistinct(a.countermeasure, pair ? b!.countermeasure : undefined),
        siteName: site || undefined,
        origin: joinDistinct(a.origin && !/カウントしない/.test(a.origin) ? a.origin : undefined, pair && b!.origin && !/カウントしない/.test(b!.origin) ? b!.origin : undefined),
        counted,
        notes,
        review,
        rows: pair ? [{ sheet: a.sheet, row: a.row }, { sheet: b!.sheet, row: b!.row }] : [{ sheet: a.sheet, row: a.row }],
      };
      rec.hash = sha(JSON.stringify([rec.occurredOn, rec.storeId, rec.attribution, rec.kind, rec.category, rec.description, rec.cause, rec.countermeasure, rec.siteName, rec.origin, rec.counted]));
      records.push(rec);
    }
  }
  return { records, overlapSkipped };
}

/* ------------------------------------------------------------------ */
/* 現場名 → 案件 (受注)                                                  */
/* ------------------------------------------------------------------ */

const NAME_NOISE = /(様邸|邸|様|さん|方|宅)$/u;
const COMPANY = /(株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲)/g;

/** 地名の比較用 (ヶ/ケ をそろえる)。placeKey は 市・区・郡・町・村 も除く (「玉名田崎」と「玉名市田崎」を同じに) */
const placeRaw = (s: string) => nkTight(s).replace(/ヶ/g, "ケ");
const placeKey = (s: string) => placeRaw(s).replace(/[市区郡町村]/g, "");

/** 「（滑石）坂西邸」→ { area: 滑石, names: [坂西] }。改行で続く会社名 (工務店など) も名前の候補 */
export function parseSiteName(site: string): { area?: string; names: string[] } {
  const t = nk(site);
  const m = t.match(/^[(（【\[]\s*([^)）】\]]+?)\s*[)）】\]]\s*([\s\S]*)$/);
  const area = m ? nkTight(m[1]) : undefined;
  const rest = m ? m[2] : t;
  const names = rest
    .split(/[\n\s]+/)
    .map((x) => nkTight(x).replace(COMPANY, "").replace(NAME_NOISE, ""))
    .filter((x) => x.length >= 2 && !isDitto(x));
  return { area, names };
}

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const orderDay = (o: Pick<Order, "salesDate" | "completedAt" | "contractDate">) => (o.salesDate ?? o.completedAt?.slice(0, 10) ?? o.contractDate ?? "").slice(0, 10);

export interface OrderIndex {
  byMonth: Map<string, { o: Order; name: string; place: string; placeK: string }[]>;
}

/** 受注を月ごとに引けるようにする (照合のたびに全件を見ない) */
export function orderIndex(db: Pick<Database, "orders" | "customers">): OrderIndex {
  const customers = new Map<string, Customer>(db.customers.map((c) => [c.id, c]));
  const byMonth = new Map<string, { o: Order; name: string; place: string; placeK: string }[]>();
  for (const o of db.orders) {
    if (o.status === "cancelled") continue;
    const d = orderDay(o);
    if (!d) continue;
    const c = customers.get(o.customerId);
    const where = `${o.siteAddress ?? ""} ${c?.address ?? ""}`;
    const row = { o, name: nkTight(c?.name ?? "").replace(COMPANY, ""), place: placeRaw(where), placeK: placeKey(where) };
    const k = d.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), row]);
  }
  return { byMonth };
}

/**
 * 現場名・店舗・月から案件を探す。発生の月と前 4 か月の受注のうち、名前 (と地区) が合うもの。
 * 別のお客様が 2 人以上当たるときは決めない (間違えてひも付けない)。同じお客様の受注が複数なら、発生の月までで最も新しいもの
 */
export function matchOrder(idx: OrderIndex, rec: Pick<ClaimRecord, "siteName" | "storeId" | "attribution" | "occurredOn">): { order?: Order; candidates: number } {
  if (!rec.siteName) return { candidates: 0 };
  const { area, names } = parseSiteName(rec.siteName);
  if (!names.length) return { candidates: 0 };
  const month = rec.occurredOn.slice(0, 7);
  const pool = [0, -1, -2, -3, -4].flatMap((d) => idx.byMonth.get(monthShift(month, d)) ?? []);
  const areaRaw = area ? placeRaw(area) : "";
  const areaKey = area ? placeKey(area) : "";
  const areaOk = (x: { place: string; placeK: string }) => !areaRaw || x.place.includes(areaRaw) || (areaKey.length >= 2 && x.placeK.includes(areaKey));
  const pick = (sameStore: boolean) =>
    pool.filter((x) => (!sameStore || rec.attribution === "office" || x.o.storeId === rec.storeId) && names.some((n) => x.name.includes(n)) && areaOk(x) && !/諸経費/.test(x.o.title ?? ""));
  let hits = pick(true);
  if (!hits.length) hits = pick(false);
  if (!hits.length) return { candidates: 0 };
  const customers = new Set(hits.map((h) => h.o.customerId));
  if (customers.size > 1) return { candidates: customers.size };
  const best = [...hits].sort((a, b) => orderDay(b.o).localeCompare(orderDay(a.o)))[0];
  return { order: best.o, candidates: 1 };
}
