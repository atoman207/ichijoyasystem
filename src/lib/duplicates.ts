import type { Customer, Database, StoreId } from "@/lib/db/types";

/**
 * 既存顧客との重複確認
 * ------------------------------------------------------------
 * 登録しようとしている内容と、全店舗の既存顧客を照合する (他店舗で登録済みのお客様も見つけるため)。
 * 一畳屋の運用では住所がいちばんの目印 (同じ氏名・電話が別住所で登録されることがある)。
 * - high: 住所+氏名、住所+電話、電話のみ (住所の入力がない／同じ)、メール、氏名+郵便番号
 * - check: 住所のみ・同じ姓+地区、電話は一致するが住所が異なる (別住所の可能性)
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
  /** ほかの連絡先 (夫・姉など) の電話番号 */
  otherPhones?: string[];
}

export interface DuplicateMatch {
  id: string;
  code: string;
  name: string;
  storeId: StoreId;
  area?: string;
  address?: string;
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

/** 住所: 都道府県・丁目などをそろえて比較用にする */
export function normAddress(s: string | undefined): string {
  return normText(s)
    .replace(/[‐‑‒–—―ー−－]/g, "-")
    .replace(/^(熊本県)/u, "")
    .replace(/(丁目|番地|番|号)/gu, "-")
    .replace(/-+$/u, "");
}

/** 住所が同じ・一方が他方を含む (短い地区名だけの誤一致を避けるため 4 文字以上) */
export function addressesRelated(a: string | undefined, b: string | undefined): boolean {
  const x = normAddress(a);
  const y = normAddress(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  // 長い方に短い方が含まれる (町名・番地の抜き出し)
  const [long, short] = x.length >= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

/** 氏名の最初の語 (姓)。空白がなければ全体 */
function surname(name: string): string {
  const first = (name ?? "").normalize("NFKC").trim().split(/[\s　]+/)[0] ?? "";
  return normName(first);
}

export function findDuplicateCustomers(db: Pick<Database, "customers">, input: DuplicateInput, excludeId?: string): DuplicateResult {
  const name = normName(input.name);
  const phone = normPhone(input.phone);
  // 入力された電話番号 (主 + ほかの連絡先) と、既存の顧客の電話番号 (主 + ほかの連絡先) のどれかが一致すれば候補にする
  const phones = new Set([phone, ...(input.otherPhones ?? []).map(normPhone)].filter(Boolean));
  const email = normText(input.email);
  const postal = (input.postalCode ?? "").replace(/\D/g, "");
  const address = normAddress(input.address);
  const sei = surname(input.name);
  const high: DuplicateMatch[] = [];
  const check: DuplicateMatch[] = [];
  const sameName: DuplicateMatch[] = [];
  let sameNameTotal = 0;
  // 住所だけでも照合する (電話・氏名がなくても候補を出す)
  if (!name && !phones.size && !email && address.length < 4) return { high, check, sameName, sameNameTotal };

  for (const c of db.customers) {
    if (c.id === excludeId) continue;
    const reasons: string[] = [];
    const cName = normName(c.name);
    const sameFullName = Boolean(name) && cName === name;
    const cAddr = normAddress(c.address);
    const addrHit = addressesRelated(address, c.address) || (address.length >= 4 && c.area && normText(c.area).length >= 2 && address.includes(normText(c.area)));
    let phoneHit = false;
    let phoneReason = "";
    if (phones.size) {
      if (phones.has(normPhone(c.phone))) {
        phoneHit = true;
        phoneReason = "電話番号が一致";
      } else {
        const hit = (c.contacts ?? []).find((x) => phones.has(normPhone(x.phone)));
        if (hit) {
          phoneHit = true;
          phoneReason = `電話番号が一致 (${hit.relation}${hit.name ? ` ${hit.name}` : ""} の番号)`;
        }
      }
    }
    if (email && email.includes("@") && normText(c.email) === email) reasons.push("メールアドレスが一致");
    if (sameFullName && addrHit) reasons.push("氏名と住所が一致");
    else if (addrHit && sei && (cName === sei || sameFullName)) reasons.push(`同じ姓と住所が一致`);
    else if (addrHit && address.length >= 6 && (cAddr.length >= 6 || (c.area && normText(c.area).length >= 2))) {
      // 住所だけの一致は下の check へ (ここでは reasons に入れない)
    }
    const cPostal = (c.postalCode ?? "").replace(/\D/g, "");
    if (sameFullName && postal.length === 7 && cPostal === postal) reasons.push("氏名と郵便番号が一致");

    // 電話: 住所が同じ／未入力なら high。住所が明らかに違うなら check (別住所の同じ番号の可能性)
    if (phoneHit) {
      if (address.length >= 4 && cAddr.length >= 4 && !addressesRelated(address, c.address)) {
        check.push(view(c, [`${phoneReason} (住所は異なる — 別の住所の可能性。住所で確かめてください)`]));
        continue;
      }
      reasons.push(addrHit ? "電話番号と住所が一致" : phoneReason);
    }

    if (reasons.length) {
      high.push(view(c, reasons));
      continue;
    }

    // 住所のみ (氏名・電話では結びつかない)
    if (addrHit && address.length >= 6) {
      check.push(view(c, ["住所が一致 (お名前・電話も確かめてください)"]));
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
      if (sameName.length < LIMIT) sameName.push(view(c, ["氏名が一致 (住所も確かめてください)"]));
    }
  }
  return { high: high.slice(0, LIMIT), check: check.slice(0, LIMIT), sameName, sameNameTotal };
}

function view(c: Customer, reasons: string[]): DuplicateMatch {
  return { id: c.id, code: c.code, name: c.name, storeId: c.storeId, area: c.area, address: c.address, reasons };
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

/** プルダウン用: 氏名 (コード) · 住所 */
export function customerOptionLabel(c: Pick<Customer, "name" | "code" | "address" | "area">, maxAddr = 28): string {
  const addr = (c.address || c.area || "").trim();
  return `${c.name} (${c.code})${addr ? ` · ${addr.length > maxAddr ? `${addr.slice(0, maxAddr)}…` : addr}` : ""}`;
}
