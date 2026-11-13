import type { Customer, Database, StoreId } from "@/lib/db/types";

/**
 * 既存顧客との重複確認
 * ------------------------------------------------------------
 * 登録しようとしている内容と、全店舗の既存顧客を照合する (他店舗で登録済みのお客様も見つけるため)。
 * - high (重複の可能性が高い): 電話番号・メールアドレスが一致 / 氏名と住所・郵便番号が一致
 * - check (要確認): 同じ姓で、既存顧客の地区が住所に含まれる (移行した顧客は「(地区) 姓」の形で、電話番号がないため)
 * - sameName (参考): 氏名だけが一致
 * high と check があるときは、確認のうえで登録する (顧客登録・問い合わせからの登録・CSV 取込)
 */

export interface DuplicateInput {
  name: string;
  kana?: string;
  phone?: string;
  email?: string;
  postalCode?: string;
  address?: string;
}

export interface DuplicateMatch {
  id: string;
  code: string;
  name: string;
  storeId: StoreId;
  area?: string;
  reasons: string[];
}

export interface DuplicateResult {
  high: DuplicateMatch[];
  check: DuplicateMatch[];
  sameName: DuplicateMatch[];
  sameNameTotal: number;
}

const LIMIT = 10;

/** 全角英数・半角カナを揃え、空白を除く */
export function normText(s: string | undefined): string {
  return (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
}

/** 氏名: 敬称 (様・さん・殿) を除く */
export function normName(s: string | undefined): string {
  return normText(s).replace(/(様|さま|さん|殿)$/u, "");
}

/** 電話番号: 数字だけ (10 桁未満は照合しない) */
export function normPhone(s: string | undefined): string {
  const d = (s ?? "").normalize("NFKC").replace(/\D/g, "");
  return d.length >= 10 ? d : "";
}

function normAddress(s: string | undefined): string {
  return normText(s)
    .replace(/[‐‑‒–—―ー−－]/g, "-")
    .replace(/^(熊本県)/u, "")
    .replace(/(丁目|番地|番|号)/gu, "-")
    .replace(/-+$/u, "");
}

/** 氏名の最初の語 (姓)。空白がなければ全体 */
function surname(name: string): string {
  const first = (name ?? "").normalize("NFKC").trim().split(/[\s　]+/)[0] ?? "";
  return normName(first);
}

export function findDuplicateCustomers(db: Pick<Database, "customers">, input: DuplicateInput, excludeId?: string): DuplicateResult {
  const name = normName(input.name);
  const phone = normPhone(input.phone);
  const email = normText(input.email);
  const postal = (input.postalCode ?? "").replace(/\D/g, "");
  const address = normAddress(input.address);
  const sei = surname(input.name);
  const high: DuplicateMatch[] = [];
  const check: DuplicateMatch[] = [];
  const sameName: DuplicateMatch[] = [];
  let sameNameTotal = 0;
  if (!name && !phone && !email) return { high, check, sameName, sameNameTotal };

  for (const c of db.customers) {
    if (c.id === excludeId) continue;
    const reasons: string[] = [];
    const cName = normName(c.name);
    const sameFullName = Boolean(name) && cName === name;
    if (phone && normPhone(c.phone) === phone) reasons.push("電話番号が一致");
    if (email && email.includes("@") && normText(c.email) === email) reasons.push("メールアドレスが一致");
    const cAddr = normAddress(c.address);
    if (sameFullName && address.length >= 4 && cAddr.length >= 4 && (cAddr === address || cAddr.startsWith(address) || address.startsWith(cAddr))) reasons.push("氏名と住所が一致");
    const cPostal = (c.postalCode ?? "").replace(/\D/g, "");
    if (sameFullName && postal.length === 7 && cPostal === postal) reasons.push("氏名と郵便番号が一致");
    if (reasons.length) {
      high.push(view(c, reasons));
      continue;
    }
    // 移行した顧客 (姓だけ・住所の欄は地区名) との照合: 同じ姓 + 地区が住所に含まれる
    const area = normText(c.area);
    if (sei && cName === sei && area.length >= 2 && address.includes(area)) {
      check.push(view(c, [`同じ姓「${c.name}」で、地区「${c.area}」が住所に含まれる`]));
      continue;
    }
    if (sameFullName) {
      sameNameTotal += 1;
      if (sameName.length < LIMIT) sameName.push(view(c, ["氏名が一致"]));
    }
  }
  return { high: high.slice(0, LIMIT), check: check.slice(0, LIMIT), sameName, sameNameTotal };
}

function view(c: Customer, reasons: string[]): DuplicateMatch {
  return { id: c.id, code: c.code, name: c.name, storeId: c.storeId, area: c.area, reasons };
}

/** 確認が必要な重複候補があるか (high または check) */
export function needsConfirmation(r: DuplicateResult): boolean {
  return r.high.length > 0 || r.check.length > 0;
}

/** 変更履歴・メッセージ用の候補の一覧 (例: C-00012 山田, C-00034 山田) */
export function candidateLabel(r: DuplicateResult, max = 3): string {
  const all = [...r.high, ...r.check];
  return all.slice(0, max).map((m) => `${m.code} ${m.name}`).join("、") + (all.length > max ? ` ほか ${all.length - max} 件` : "");
}
