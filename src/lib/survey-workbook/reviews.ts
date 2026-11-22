import type { StoreId } from "@/lib/db/types";
import { sha } from "./claims";
import { foldName, type StaffMatch } from "./staff";
import { nk, nkTight, validDate, type WorkbookTab } from "./tabs";

/**
 * 「Google口コミ集計」のタブ → Google 口コミ
 * ------------------------------------------------------------
 * 列 (見出しの行で探す): 事務入力日 (月/日)・担当者・ポイント・お客様ニックネーム・支払日・(確認の)チェック・その右の備考。
 * - 入力日に年がないため、上から順に読み、月が半年以上戻ったら次の年とする。最後の行は今日まで 1 年以内 (startYear で最初の行の年を指定できる)
 * - 口コミの日 (postedOn) = 事務の入力日 (KPI は「事務の入力月で集計し、翌月末に支給」)
 * - 支払日「－」= 支給なし (経営者の家族など)、「未払」= 未払い。どちらもメモに残す (支給の対象は 設定 → KPI の「集計・順位・支給から外す社員」で決める)
 * - 同じ入力日・担当者・お客様の行が 2 つあるとき (「カウント済」の再記入) は 1 件にする
 */

export interface ReviewSheetRow {
  row: number;
  month: number;
  day: number;
  staff: string;
  points: number;
  reviewer: string;
  pay: string;
  check: string;
  extra: string;
}

export interface ReviewRecord {
  key: string;
  sourceRef: string;
  hash: string;
  postedOn: string;
  staff: StaffMatch;
  storeId: StoreId;
  points: number;
  reviewerName?: string;
  note?: string;
  rows: number[];
  notes: string[];
}

function findColumns(rows: string[][]) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = rows[r].map(nkTight);
    const at = (re: RegExp) => cells.findIndex((c) => re.test(c));
    const date = at(/入力日|^日付$|^投稿日$/);
    const staff = at(/^担当者?$/);
    const points = at(/^ポイント$/);
    if (date < 0 || staff < 0 || points < 0) continue;
    const check = at(/チェック|確認/);
    return { header: r, date, staff, points, reviewer: at(/ニックネーム|お客様|お名前/), pay: at(/支払/), check, extra: check >= 0 ? check + 1 : -1 };
  }
  return null;
}

export function parseReviewTab(tab: WorkbookTab): { rows: ReviewSheetRow[]; problems: string[] } {
  const c = findColumns(tab.rows);
  if (!c) return { rows: [], problems: [`「${tab.title}」: 見出し (事務入力日・担当者・ポイント) の行が見つかりません`] };
  const out: ReviewSheetRow[] = [];
  const problems: string[] = [];
  for (let r = c.header + 1; r < tab.rows.length; r++) {
    const row = tab.rows[r];
    const d = nkTight(row[c.date]).match(/^(\d{1,2})[/月.-](\d{1,2})日?$/);
    if (!d) continue;
    const month = Number(d[1]);
    const day = Number(d[2]);
    const staff = nk(row[c.staff]);
    const points = Number(nkTight(row[c.points]));
    if (!staff) continue;
    if (!Number.isFinite(points) || points < 0 || points > 10) {
      problems.push(`「${tab.title}」${r + 1} 行目: ポイント「${nk(row[c.points])}」が数ではありません`);
      continue;
    }
    out.push({ row: r + 1, month, day, staff, points, reviewer: c.reviewer >= 0 ? nk(row[c.reviewer]) : "", pay: c.pay >= 0 ? nk(row[c.pay]) : "", check: c.check >= 0 ? nk(row[c.check]) : "", extra: c.extra >= 0 ? nk(row[c.extra]) : "" });
  }
  return { rows: out, problems };
}

/** 行の年 (上から読み、月が 6 か月以上戻ったら次の年)。最初の行の年 = startYear、なければ 最後の行が今日以前の 1 年以内になる年 */
export function inferYears(rows: Pick<ReviewSheetRow, "month" | "day">[], today: string, startYear?: number): { years: number[]; startYear: number } {
  const rel: number[] = [];
  let y = 0;
  let prev = 0;
  for (const r of rows) {
    if (prev && r.month < prev - 5) y++;
    rel.push(y);
    prev = r.month;
  }
  if (startYear) return { years: rel.map((x) => startYear + x), startYear };
  const ty = Number(today.slice(0, 4));
  const last = rows.at(-1);
  const lastMd = last ? `${String(last.month).padStart(2, "0")}-${String(last.day).padStart(2, "0")}` : "01-01";
  const lastYear = lastMd <= today.slice(5) ? ty : ty - 1;
  const start = lastYear - (rel.at(-1) ?? 0);
  return { years: rel.map((x) => start + x), startYear: start };
}

const PAY_NONE = /^[－ー\-―–—]+$/;

function payNote(pay: string, year: number, month: number): string | undefined {
  const t = nkTight(pay);
  if (!t) return undefined;
  if (PAY_NONE.test(t)) return "支給なし (シートの支払日: －)";
  if (/未払/.test(t)) return "未払い (シートの記入)";
  const m = t.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
  if (m) {
    const pm = Number(m[1]);
    const pd = Number(m[2]);
    const py = pm < month ? year + 1 : year;
    return validDate(py, pm, pd) ? `支払日: ${py}-${String(pm).padStart(2, "0")}-${String(pd).padStart(2, "0")}` : `支払日: ${pay}`;
  }
  return `支払日: ${pay}`;
}

/** シートの行 → 口コミの記録 (担当者の照合・年の決定・同じ行の重なり) */
export function buildReviewRecords(rows: ReviewSheetRow[], match: (name: string) => StaffMatch, opts: { today: string; startYear?: number }): { records: ReviewRecord[]; startYear: number; problems: string[]; ignored: number } {
  const { years, startYear } = inferYears(rows, opts.today, opts.startYear);
  const problems: string[] = [];
  const byKey = new Map<string, ReviewRecord>();
  let ignored = 0;
  rows.forEach((r, i) => {
    const year = years[i];
    if (!validDate(year, r.month, r.day)) {
      problems.push(`${r.row} 行目: ${year}年${r.month}月${r.day}日 は正しい日付ではありません (年の決め方を確かめてください)`);
      return;
    }
    const staff = match(r.staff);
    if (!staff.key) {
      ignored++;
      return;
    }
    const postedOn = `${year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`;
    // 印はシートに書かれた名前で作る (担当者の名前の対応を変えても、同じ口コミを付け替えるだけで二重にしない)
    const key = `${postedOn}|${foldName(r.staff)}|${nkTight(r.reviewer)}`;
    const notes = [payNote(r.pay, year, r.month), r.check ? `確認: ${r.check}` : undefined, r.extra ? `備考: ${r.extra}` : undefined].filter((x): x is string => Boolean(x));
    const prev = byKey.get(key);
    if (prev) {
      // 再記入 (「カウント済」など): 1 件にまとめ、支払日のある方を残す
      prev.rows.push(r.row);
      const merged = [...new Set([...(prev.note ? prev.note.split(" / ") : []), ...notes])];
      const paid = merged.filter((n) => n.startsWith("支払日:"));
      prev.note = (paid.length ? merged.filter((n) => !/^未払い/.test(n)) : merged).join(" / ") || undefined;
      prev.notes.push(`シートに 2 回書かれています (${prev.rows.join("・")} 行目)。1 件として取り込みます`);
      prev.hash = sha(JSON.stringify([prev.postedOn, prev.staff.key, prev.points, prev.reviewerName, prev.note]));
      return;
    }
    const rec: ReviewRecord = {
      key,
      sourceRef: `sheet:reviews:${sha(key)}`,
      hash: "",
      postedOn,
      staff,
      storeId: staff.storeId,
      points: r.points,
      reviewerName: r.reviewer || undefined,
      note: notes.join(" / ") || undefined,
      rows: [r.row],
      notes: staff.userId ? [] : [`担当者「${r.staff}」の社員のアカウントが見つかりません (支給の計算には入りません)`],
    };
    rec.hash = sha(JSON.stringify([rec.postedOn, rec.staff.key, rec.points, rec.reviewerName, rec.note]));
    byKey.set(key, rec);
  });
  return { records: [...byKey.values()], startYear, problems, ignored };
}
