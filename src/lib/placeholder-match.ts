import type { Customer, Database } from "@/lib/db/types";
import { addressMatch, areaInAddress, nameMatch, type NameMatch } from "@/lib/customer-match";
import { customerHasPhone, phoneDigits } from "@/lib/customer-contacts";
import { cleanAddressText } from "@/lib/maps/address";

/**
 * 予定表 (スプレッドシート) から移行した予定の「仮のお客様」(タグ「予定表から登録」) と、同じ人らしいお客様・受付の照合
 * (お客様のご連絡 2026-11-27「既存案件への紐付けができませんでした」)
 * ------------------------------------------------------------
 * 予定表には名字と地区しか書かれていないため、取込は名字 + 地区で仮のお客様を作り、予定と案件 (問い合わせ) をそこにつないでいる
 * (src/lib/schedule-sheet/plan.ts)。そのため、問合せ登録で本当のお客様 (または新しく登録したお客様) を選ぶと、予定表の案件が
 * 「このお客様の案件」に出ず、既存の案件に追加できなかった。ここでは、
 *   - 受付の内容 (お名前・電話・住所・メモの日程) と、
 *   - 選んだお客様 (お名前・電話・住所・地区)
 * から、同じ人らしい仮のお客様を探す。手書きの名字は読み違えることがあるので、町名 (地区) と予定の日が合えば名字が違っても候補にする。
 * データは変えない (純粋関数。画面の部品からも読める)。付け替えは src/lib/placeholder-customer.ts
 */

export const PLACEHOLDER_TAG = "予定表から登録";

/** 予定表の取込で仮に作った顧客 (電話・住所なし) */
export function isPlaceholderCustomer(c: Pick<Customer, "tags"> | undefined): boolean {
  return Boolean(c?.tags?.includes(PLACEHOLDER_TAG));
}

/** 照合する人 (受付の内容か、選んだお客様) */
export interface PlaceholderPerson {
  name?: string;
  kana?: string;
  phones?: (string | undefined)[];
  /** 住所 (依頼主・施工現場など。どれかの町名が合えばよい) */
  addresses?: (string | undefined)[];
  /** 移行した顧客の地区 */
  area?: string;
  /** メモの日程の日 (YYYY-MM-DD)。仮のお客様の予定の日と比べる */
  dates?: string[];
}

export interface PlaceholderMatch {
  customer: Customer;
  name?: NameMatch;
  phone: boolean;
  town: boolean;
  /** 予定の日が一致した日 (YYYY-MM-DD) */
  dates: string[];
  /** 今日以降の予定の件数と最初の日 */
  upcoming: { count: number; first?: string };
  score: number;
  /** 候補にした理由 (画面に出す) */
  reason: string;
}

const squash = (s: string | undefined) => cleanAddressText(s ?? "").replace(/[\s　]+/g, "");
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 仮のお客様の場所 (地区か住所) */
export const placeholderPlace = (c: Pick<Customer, "area" | "address">) => c.area || c.address || "";

/** 仮のお客様の町名 (地区・住所) が、人の住所・地区と合う */
export function townMatches(ph: Pick<Customer, "area" | "address">, who: Pick<PlaceholderPerson, "addresses" | "area">): boolean {
  for (const a of who.addresses ?? []) {
    if (!a?.trim()) continue;
    if (ph.area && areaInAddress(ph.area, a)) return true;
    if (ph.address && addressMatch(a, ph.address)) return true;
  }
  const area = squash(who.area);
  if (area.length >= 2) {
    if (ph.area && squash(ph.area) === area) return true;
    if (ph.address && areaInAddress(who.area, ph.address)) return true;
  }
  return false;
}

/**
 * 同じ人らしい仮のお客様 (点数の高い順)。候補にするのは 電話番号の一致 / お名前 (氏名) の一致 / 名字と町名の一致 / 町名と予定の日の一致。
 * excludeId = 選んだお客様自身、visible = 見られるお客様だけ
 */
export function placeholderMatches(
  db: Pick<Database, "customers" | "schedule">,
  who: PlaceholderPerson,
  opts: { excludeId?: string; visible?: (c: Customer) => boolean; today?: string; limit?: number } = {},
): PlaceholderMatch[] {
  const today = opts.today ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const phones = [...new Set((who.phones ?? []).map((p) => phoneDigits(p)).filter((d) => d.length >= 9))];
  const wanted = new Set((who.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const placeholders = db.customers.filter((c) => isPlaceholderCustomer(c) && c.id !== opts.excludeId && (!opts.visible || opts.visible(c)));
  if (!placeholders.length) return [];
  const ids = new Set(placeholders.map((c) => c.id));
  const datesOf = new Map<string, string[]>();
  for (const e of db.schedule) {
    if (!e.customerId || !ids.has(e.customerId)) continue;
    const list = datesOf.get(e.customerId) ?? [];
    list.push(e.date);
    datesOf.set(e.customerId, list);
  }
  const out: PlaceholderMatch[] = [];
  for (const c of placeholders) {
    // 仮のお客様のお名前はふつう名字だけ (予定表の書き方)。名字だけが同じ「お名前の一致」は名字の一致として扱う
    const matched = nameMatch({ name: who.name, kana: who.kana }, c);
    const name: NameMatch | undefined = matched === "full" && squash(c.name).length < 4 && !/[\s　]/.test(c.name.trim()) ? "surname" : matched;
    const phone = phones.some((d) => customerHasPhone(c, d));
    const town = townMatches(c, who);
    const evDates = datesOf.get(c.id) ?? [];
    const dates = [...new Set(evDates.filter((d) => wanted.has(d)))].sort();
    if (!(phone || name === "full" || (name && town) || (town && dates.length))) continue;
    const coming = evDates.filter((d) => d >= today).sort();
    const score = (phone ? 300 : 0) + (name === "full" ? 150 : name ? 80 : 0) + (town ? 60 : 0) + Math.min(dates.length, 2) * 50 + (coming.length ? 10 : 0);
    const place = placeholderPlace(c);
    const reason = [
      "予定表から移行した仮の登録",
      phone ? "電話番号が一致" : "",
      name === "full" ? "お名前が一致" : name ? "名字が一致" : "",
      town ? `町名${place ? ` (${place.slice(0, 20)})` : ""}が一致` : "",
      dates.length ? `予定の日 (${dates.map(md).join("・")}) が一致` : "",
      !name && who.name ? `お名前は「${c.name}」(メモ: ${who.name.slice(0, 20)})` : "",
    ]
      .filter(Boolean)
      .join("・");
    out.push({ customer: c, name, phone, town, dates, upcoming: { count: coming.length, first: coming[0] }, score, reason });
  }
  return out.sort((a, b) => b.score - a.score || (b.upcoming.first ? 1 : 0) - (a.upcoming.first ? 1 : 0) || (b.customer.updatedAt ?? "").localeCompare(a.customer.updatedAt ?? "")).slice(0, opts.limit ?? 5);
}

/** 選んだお客様と同じ人らしい仮のお客様 (選んだお客様の お名前・電話・住所・地区で照合) */
export function placeholdersForCustomer(db: Pick<Database, "customers" | "schedule">, c: Customer, opts: { visible?: (c: Customer) => boolean; today?: string; limit?: number } = {}): PlaceholderMatch[] {
  return placeholderMatches(db, { name: c.name, kana: c.kana, phones: [c.phone, ...(c.contacts ?? []).map((x) => x.phone)], addresses: [c.address], area: c.area }, { ...opts, excludeId: c.id });
}
