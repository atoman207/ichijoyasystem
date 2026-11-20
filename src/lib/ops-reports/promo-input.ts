import type { PromotionArea } from "@/lib/db/types";

/**
 * 販促の記録の入力の読み取り (画面のフォーム・テストで共通。サーバー専用の import をしない)
 */

/**
 * 地域と部数 (1 行に 1 地域): 「合志市須屋 3000」「合志市須屋, 3,000部」「合志市須屋<TAB>3000」。
 * 同じ地域は合計する。読めない行はエラーとして返す
 */
export function parseAreas(text: string): { areas: PromotionArea[]; errors: string[] } {
  const areas: PromotionArea[] = [];
  const errors: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.normalize("NFKC").trim();
    if (!line) continue;
    const m = /^(.+?)[\s,、\t]+([\d,]+)\s*(?:部|枚|通|件)?$/.exec(line);
    const area = m?.[1].replace(/[,、\s]+$/, "").trim() ?? "";
    const copies = m ? Number(m[2].replace(/,/g, "")) : NaN;
    if (!m || !area || !Number.isInteger(copies) || copies < 0 || copies > 10_000_000) {
      errors.push(`${i + 1} 行目「${raw.trim().slice(0, 30)}」: 「地域 部数」の形で書いてください (例: 合志市須屋 3000)`);
      continue;
    }
    const cur = areas.find((a) => a.area === area.slice(0, 60));
    if (cur) cur.copies += copies;
    else areas.push({ area: area.slice(0, 60), copies });
  }
  return { areas, errors };
}

export const areasText = (areas: PromotionArea[]) => areas.map((a) => `${a.area} ${a.copies}`).join("\n");

export interface EventSheetRow {
  line: number;
  name: string;
  phone?: string;
  address?: string;
  summary?: string;
}

/**
 * イベントの受付票 (1 行に 1 枚): 「氏名, 電話, 住所, 内容」(タブ・カンマ・読点で区切る。電話・住所・内容は省略できる)。
 * 表計算ソフトから貼り付けた行 (タブ区切り) もそのまま読める。1 行目が見出し (氏名・お名前) なら飛ばす
 */
export function parseEventSheet(text: string): { rows: EventSheetRow[]; errors: string[] } {
  const rows: EventSheetRow[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const cols = (line.includes("\t") ? line.split("\t") : line.split(/[,，、]/)).map((c) => c.trim());
    if (i === 0 && /^(氏名|お名前|名前)$/.test(cols[0])) continue;
    const name = cols[0]?.slice(0, 60) ?? "";
    if (!name) {
      errors.push(`${i + 1} 行目: 氏名がありません`);
      continue;
    }
    const phone = cols[1] && /\d/.test(cols[1]) ? cols[1].normalize("NFKC").slice(0, 30) : undefined;
    // 電話を省いて住所を 2 列目に書いたとき
    const rest = phone ? cols.slice(2) : cols.slice(1);
    rows.push({ line: i + 1, name, phone, address: rest[0]?.slice(0, 120) || undefined, summary: rest.slice(1).join(" ").slice(0, 200) || undefined });
  }
  if (rows.length > 200) errors.push(`一度に登録できるのは 200 枚までです (${rows.length} 枚)。分けて登録してください。`);
  return { rows, errors };
}
