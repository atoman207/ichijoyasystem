import type { AuditChange, Database, StoreId, TidyCheck, TidyItemResult, TidyResult, User } from "@/lib/db/types";
import type { Tone } from "@/lib/constants";
import { canViewTidyCheck } from "@/lib/auth/permissions";

/**
 * 整理整頓チェック (お客様のご要望 2026-11-23「■8. 整理整頓チェック」)
 * ------------------------------------------------------------
 * - チェック項目は設定 (settings の id = "tidy_items"。管理者が KPI → 整理整頓 → チェック項目 で 1 行 1 項目に貼り付けて差し替える)。
 *   いまの項目は暫定 (provisional)。お客様が使っているチェック項目の資料をいただいたら差し替える
 * - 項目のキーは名前から決める (同じ名前なら同じキー)。チェックには項目のキーと名前の写しを残すので、項目を変えても過去の記録は変わらない
 * - 結果は 良い (ok) / 要改善 (ng) / 対象外 (na)。点数 = 良い ÷ (良い + 要改善) × 100 (対象外は数えない)
 * - 要改善は期限を決めて、直したら「直した」を記録する (未対応の一覧・期限切れ)
 * - インセンティブ (src/lib/incentive.ts) には入れない
 * このファイルは画面・テストからも読み込む (サーバー専用の import をしない)。権限は permissions.ts、操作は src/lib/actions/tidy.ts
 */

export const TIDY_ITEMS_SETTING_ID = "tidy_items";

export const TIDY_RESULT: Record<TidyResult, { label: string; tone: Tone }> = {
  ok: { label: "良い", tone: "good" },
  ng: { label: "要改善", tone: "serious" },
  na: { label: "対象外", tone: "neutral" },
};
export const TIDY_RESULTS = Object.keys(TIDY_RESULT) as TidyResult[];

export interface TidyItemDef {
  key: string;
  label: string;
  group?: string;
}

export interface TidySettings {
  items: TidyItemDef[];
  /** 暫定の項目 (お客様のチェック項目の資料を待っている) */
  provisional: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/** 名前から項目のキー (同じ名前なら同じキー。FNV-1a 32 bit) */
export function tidyItemKey(label: string, group?: string): string {
  const s = `${(group ?? "").normalize("NFKC").trim()}|${label.normalize("NFKC").replace(/\s+/g, "").trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t${h.toString(36)}`;
}

const def = (group: string, label: string): TidyItemDef => ({ key: tidyItemKey(label, group), label, group });

/** 暫定のチェック項目 (一般的な 5S の項目。お客様のチェック項目の資料をいただいたら差し替える) */
export const DEFAULT_TIDY_ITEMS: TidyItemDef[] = [
  def("作業場", "床に畳くず・ゴミ・端材が落ちていない"),
  def("作業場", "道具・機械が決まった場所に戻されている"),
  def("作業場", "材料 (畳表・縁・畳床・襖紙) が種類ごとに整理されている"),
  def("作業場", "不要な物・使わない物が置かれていない"),
  def("作業場", "通路・出入口・非常口に物を置いていない"),
  def("店舗", "入口・駐車場がきれいに掃除されている"),
  def("店舗", "見本・展示・カタログが整っている"),
  def("店舗", "机・カウンターの上が片付いている"),
  def("車両", "車内に不要な物・ゴミがない"),
  def("車両", "荷台の道具・資材が固定・整理されている"),
  def("安全", "消火器・分電盤の前に物を置いていない"),
  def("安全", "刃物・工具が安全に保管されている"),
];

export function tidySettings(db: Pick<Database, "settings">): TidySettings {
  const row = (db.settings ?? []).find((s) => s.id === TIDY_ITEMS_SETTING_ID);
  const v = row?.value as { items?: unknown; provisional?: unknown } | undefined;
  const items = Array.isArray(v?.items)
    ? (v!.items as unknown[])
        .map((x) => x as Partial<TidyItemDef>)
        .filter((x) => typeof x?.label === "string" && x.label.trim())
        .map((x) => ({ key: typeof x.key === "string" && x.key ? x.key : tidyItemKey(x.label!, x.group), label: x.label!.trim(), group: typeof x.group === "string" && x.group.trim() ? x.group.trim() : undefined }))
    : [];
  if (!items.length) return { items: DEFAULT_TIDY_ITEMS, provisional: true };
  return { items, provisional: v?.provisional !== false, updatedAt: row?.updatedAt, updatedBy: row?.updatedBy };
}

/** 見出しの行 (■作業場・◆作業場・【作業場】・# 作業場・「作業場:」のようにコロンで終わる行) */
const GROUP_RE = /^(?:[■◆#]+\s*(.+?)|【(.+?)】|\[(.+?)\]|(.+?)[:：])\s*$/;
/** 行の頭の番号・記号 (1. ・ - □ ☐ など) */
const BULLET_RE = /^(?:[\d０-９]+[.．)）、\s]+|[・\-‐－*＊□☐✓✔○◯●◇]+\s*)/;

/**
 * 貼り付けた文 (1 行 1 項目) から項目の一覧を作る。見出しの行 (■作業場 など) の下の項目はその見出しの項目。
 * 同じ名前の項目は 1 つにする。行の頭の番号・記号は外す
 */
export function parseTidyItemsText(text: string): { items: TidyItemDef[]; skipped: string[] } {
  const items: TidyItemDef[] = [];
  const skipped: string[] = [];
  let group: string | undefined;
  for (const raw of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.normalize("NFKC").replace(/\t/g, " ").trim();
    if (!line) continue;
    const g = GROUP_RE.exec(line);
    if (g && !BULLET_RE.test(line)) {
      group = (g[1] ?? g[2] ?? g[3] ?? g[4] ?? "").trim().slice(0, 40) || undefined;
      continue;
    }
    const label = line.replace(BULLET_RE, "").trim().slice(0, 120);
    if (!label) continue;
    const key = tidyItemKey(label, group);
    if (items.some((x) => x.key === key)) {
      skipped.push(label);
      continue;
    }
    items.push({ key, label, group });
  }
  return { items: items.slice(0, 100), skipped };
}

/** 項目の一覧を貼り付けの形 (見出し + 1 行 1 項目) に戻す */
export function tidyItemsText(items: TidyItemDef[]): string {
  const out: string[] = [];
  let group: string | undefined;
  for (const it of items) {
    if ((it.group ?? "") !== (group ?? "")) {
      if (out.length) out.push("");
      if (it.group) out.push(`■${it.group}`);
      group = it.group;
    }
    out.push(it.label);
  }
  return out.join("\n");
}

/** 点数 (良い ÷ (良い + 要改善) × 100、小数 1 桁) と件数 */
export function tidyScore(items: Pick<TidyItemResult, "result">[]): { score?: number; okCount: number; ngCount: number; naCount: number } {
  const okCount = items.filter((i) => i.result === "ok").length;
  const ngCount = items.filter((i) => i.result === "ng").length;
  const naCount = items.filter((i) => i.result === "na").length;
  const base = okCount + ngCount;
  return { score: base ? Math.round((okCount / base) * 1000) / 10 : undefined, okCount, ngCount, naCount };
}

export function scoreTone(score: number | undefined): Tone {
  if (score === undefined) return "neutral";
  return score >= 90 ? "good" : score >= 70 ? "warn" : "serious";
}

export const fmtScore = (score: number | undefined) => (score === undefined ? "-" : `${score.toFixed(score % 1 ? 1 : 0)} 点`);

export interface TidyInputItem {
  key: string;
  result: string;
  note?: string;
  dueDate?: string;
}

/**
 * 画面の入力から項目ごとの結果を作る (項目の名前は設定の写し)。前の記録 (修正のとき) の要改善の対応は、同じ項目が要改善のままなら残す。
 * 答えていない項目は対象外にする
 */
export function buildTidyItems(defs: TidyItemDef[], input: TidyInputItem[], previous?: TidyItemResult[]): TidyItemResult[] {
  const byKey = new Map(input.map((i) => [i.key, i]));
  const prev = new Map((previous ?? []).map((i) => [i.key, i]));
  // 修正のとき: 設定から外れた項目も、前の記録にあれば残す (過去の記録を変えない)
  const keys = [...defs.map((d) => d.key), ...(previous ?? []).map((p) => p.key).filter((k) => !defs.some((d) => d.key === k))];
  return keys.map((key) => {
    const d = defs.find((x) => x.key === key) ?? prev.get(key)!;
    const inp = byKey.get(key);
    const result: TidyResult = inp && (TIDY_RESULTS as string[]).includes(inp.result) ? (inp.result as TidyResult) : (prev.get(key)?.result ?? "na");
    const note = (inp?.note ?? prev.get(key)?.note ?? "").trim().slice(0, 300) || undefined;
    const row: TidyItemResult = { key, label: prev.get(key)?.label ?? d.label, group: prev.get(key)?.group ?? d.group, result, note };
    if (result === "ng") {
      const p = prev.get(key);
      const due = inp?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(inp.dueDate) ? inp.dueDate : p?.result === "ng" ? p.dueDate : undefined;
      Object.assign(row, { dueDate: due, fixStatus: p?.result === "ng" ? (p.fixStatus ?? "open") : "open", fixedAt: p?.result === "ng" ? p.fixedAt : undefined, fixedBy: p?.result === "ng" ? p.fixedBy : undefined, fixNote: p?.result === "ng" ? p.fixNote : undefined });
    }
    return row;
  });
}

/** 修正の変更履歴 (項目ごとの結果の変更) */
export function tidyChanges(before: TidyCheck, after: Pick<TidyCheck, "date" | "place" | "comment" | "items" | "storeId" | "checkedBy">): AuditChange[] {
  const out: AuditChange[] = [];
  for (const k of ["date", "storeId", "checkedBy", "place", "comment"] as const) if ((before[k] ?? "") !== (after[k] ?? "")) out.push({ field: k, before: before[k] ?? "", after: after[k] ?? "" });
  for (const it of after.items) {
    const b = before.items.find((x) => x.key === it.key);
    if (b?.result !== it.result) out.push({ field: `item:${it.label}`, before: b ? TIDY_RESULT[b.result].label : "", after: TIDY_RESULT[it.result].label });
  }
  return out;
}

/* ================================================================== */
/* 要改善の対応                                                          */
/* ================================================================== */

export interface TidyFollowUp {
  check: TidyCheck;
  item: TidyItemResult;
  overdue: boolean;
}

/** 直していない要改善 (期限の近い順・期限なしは後) */
export function openFollowUps(checks: TidyCheck[], today: string): TidyFollowUp[] {
  return checks
    .flatMap((check) => check.items.filter((i) => i.result === "ng" && i.fixStatus !== "fixed").map((item) => ({ check, item, overdue: Boolean(item.dueDate && item.dueDate < today) })))
    .sort((a, b) => (a.item.dueDate ?? "9999").localeCompare(b.item.dueDate ?? "9999") || b.check.date.localeCompare(a.check.date));
}

/* ================================================================== */
/* 集計 (店舗 × 月)                                                       */
/* ================================================================== */

/** today を含む月から n か月さかのぼった月 (古い順。YYYY-MM) */
export function monthsBack(today: string, n: number): string[] {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export interface TidyCell {
  count: number;
  /** 点数の平均 (点数のあるチェックだけ) */
  avg?: number;
  ng: number;
}

/** 店舗 × 月の集計 (件数・平均点・要改善の数) */
export function tidySummary(checks: TidyCheck[], storeIds: StoreId[], months: string[]): Map<StoreId, Map<string, TidyCell>> {
  const out = new Map<StoreId, Map<string, TidyCell>>();
  for (const s of storeIds) out.set(s, new Map(months.map((m) => [m, { count: 0, ng: 0 }])));
  const sums = new Map<string, { sum: number; n: number }>();
  for (const c of checks) {
    const cell = out.get(c.storeId)?.get(c.date.slice(0, 7));
    if (!cell) continue;
    cell.count += 1;
    cell.ng += c.ngCount;
    if (c.score !== undefined && c.score !== null) {
      const k = `${c.storeId}|${c.date.slice(0, 7)}`;
      const a = sums.get(k) ?? { sum: 0, n: 0 };
      a.sum += Number(c.score);
      a.n += 1;
      sums.set(k, a);
    }
  }
  for (const [k, a] of sums) {
    const [s, m] = k.split("|");
    const cell = out.get(s as StoreId)?.get(m);
    if (cell) cell.avg = Math.round((a.sum / a.n) * 10) / 10;
  }
  return out;
}

/** よく要改善になる項目 (名前ごとの回数。多い順) */
export function frequentNg(checks: TidyCheck[], limit = 8): { label: string; group?: string; count: number; of: number }[] {
  const m = new Map<string, { label: string; group?: string; count: number; of: number }>();
  for (const c of checks) {
    for (const i of c.items) {
      if (i.result === "na") continue;
      const k = `${i.group ?? ""}|${i.label}`;
      const a = m.get(k) ?? { label: i.label, group: i.group, count: 0, of: 0 };
      a.of += 1;
      if (i.result === "ng") a.count += 1;
      m.set(k, a);
    }
  }
  return [...m.values()].filter((x) => x.count > 0).sort((a, b) => b.count - a.count || b.count / b.of - a.count / a.of).slice(0, limit);
}

/** 見られるチェック (店舗スタッフは自店舗、店長・本部・管理者は全店舗) */
export function visibleTidyChecks(db: Pick<Database, "tidyChecks">, user: User): TidyCheck[] {
  return (db.tidyChecks ?? []).filter((c) => canViewTidyCheck(user, c));
}

/** 番号 (TC-2026-0001) */
export function nextTidyNumber(list: { number: string }[], dateKey: string): string {
  const head = `TC-${dateKey.slice(0, 4)}-`;
  const max = list.filter((x) => x.number.startsWith(head)).reduce((m, x) => Math.max(m, Number(x.number.slice(head.length)) || 0), 0);
  return `${head}${String(max + 1).padStart(4, "0")}`;
}

/** 1 つのチェックの写真の上限 */
export const TIDY_MAX_PHOTOS = 30;
