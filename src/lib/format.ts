/** 表示用フォーマッタ (日本語ロケール) */

export function yen(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "¥0";
  const sign = n < 0 ? "-" : "";
  return `${sign}¥${Math.abs(Math.round(n)).toLocaleString("ja-JP")}`;
}

export function num(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "0";
  return Math.round(n).toLocaleString("ja-JP");
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function parseDate(d: string): Date {
  // "YYYY-MM-DD" または ISO 文字列
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day);
  }
  return new Date(d);
}

export function fmtDate(
  d?: string | null,
  opts: { weekday?: boolean } = {},
): string {
  if (!d) return "-";
  const dt = parseDate(d);
  if (Number.isNaN(dt.getTime())) return d;
  const base = `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}`;
  return opts.weekday ? `${base}(${WEEKDAYS[dt.getDay()]})` : base;
}

export function fmtDateTime(d?: string | null): string {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return `${fmtDate(d)} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

export function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `${y}年${Number(m)}月`;
}

export function fmtShortMonth(ym: string): string {
  const [, m] = ym.split("-");
  return `${Number(m)}月`;
}

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function toMonthKey(d: string | Date): string {
  const dt = typeof d === "string" ? parseDate(d) : d;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

export function addDays(d: string | Date, days: number): string {
  const dt = typeof d === "string" ? parseDate(d) : new Date(d);
  dt.setDate(dt.getDate() + days);
  return toDateKey(dt);
}

export function daysBetween(a: string, b: string): number {
  const da = parseDate(a).getTime();
  const db = parseDate(b).getTime();
  return Math.round((db - da) / 86400000);
}

export function relativeTime(iso: string, now = new Date()): string {
  const t = new Date(iso).getTime();
  const diff = Math.round((now.getTime() - t) / 60000);
  if (diff < 1) return "たった今";
  if (diff < 60) return `${diff}分前`;
  const h = Math.round(diff / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}日前`;
  return fmtDate(iso);
}

export function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 消費税 10% (端数切捨て) */
export const TAX_RATE = 0.1;

export function calcTax(subtotal: number): number {
  return Math.floor(subtotal * TAX_RATE);
}
