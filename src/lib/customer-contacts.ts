import type { Customer, CustomerContact } from "@/lib/db/types";

/**
 * 顧客の電話番号 (主の電話 + 本人以外の連絡先)
 * ------------------------------------------------------------
 * 1 人のお客様に、本人・夫・姉・祖母・勤務先などの電話番号を続柄つきで複数登録できる (Customer.contacts)。
 * 電話番号での照合 (AI 電話受付・Web フォーム・LINE・重複の確認・顧客の検索・書類取込) は、すべてここの関数を使う
 */

export const CONTACT_RELATIONS = ["本人 (携帯)", "本人 (自宅)", "夫", "妻", "息子", "娘", "父", "母", "兄", "姉", "弟", "妹", "祖父", "祖母", "親族", "勤務先", "管理会社", "その他"] as const;

/** 数字だけ (全角も半角にする) */
export const phoneDigits = (v?: string) => (v ?? "").normalize("NFKC").replace(/[^0-9]/g, "");

/** 主の電話番号と連絡先の電話番号 (数字だけ・重複なし・9 桁未満は除く) */
export function customerPhoneDigits(c: Pick<Customer, "phone" | "contacts">): string[] {
  const out = new Set<string>();
  for (const p of [c.phone, ...(c.contacts ?? []).map((x) => x.phone)]) {
    const d = phoneDigits(p);
    if (d.length >= 9) out.add(d);
  }
  return [...out];
}

/** 電話番号 (数字だけ・9 桁以上) がこのお客様のどれかの番号と一致する */
export function customerHasPhone(c: Pick<Customer, "phone" | "contacts">, digits: string): boolean {
  if (digits.length < 9) return false;
  return customerPhoneDigits(c).includes(digits);
}

/** 電話番号の一部 (3 桁以上) を含む (一覧の検索用) */
export function customerPhoneIncludes(c: Pick<Customer, "phone" | "contacts">, part: string): boolean {
  if (part.length < 3) return false;
  return [c.phone, ...(c.contacts ?? []).map((x) => x.phone)].some((p) => phoneDigits(p).includes(part));
}

/** 一致した番号が誰のものか (例: 「夫 (山田 太郎)」)。主の番号なら undefined */
export function contactOfPhone(c: Pick<Customer, "phone" | "contacts">, digits: string): CustomerContact | undefined {
  if (phoneDigits(c.phone) === digits) return undefined;
  return (c.contacts ?? []).find((x) => phoneDigits(x.phone) === digits);
}

export function contactLabel(x: CustomerContact): string {
  return [x.relation, x.name ? `(${x.name})` : ""].filter(Boolean).join(" ");
}

/** 表示・検索・変更履歴用の 1 行 (例: 「夫 (山田 太郎) 090-1234-5678 平日は夕方以降」) */
export function contactLine(x: CustomerContact): string {
  return [contactLabel(x), x.phone, x.note].filter(Boolean).join(" ");
}

/** 検索・AI に渡す文字 (主の電話 + 連絡先) */
export function customerPhonesText(c: Pick<Customer, "phone" | "contacts">): string {
  return [c.phone, ...(c.contacts ?? []).map(contactLine)].filter(Boolean).join(" / ");
}

/**
 * 画面の入力 (hidden の JSON: [{relation, name, phone, note}]) を連絡先にする。
 * 電話番号のない行は捨て、最大 20 件。id は既存の行を引き継ぐ (なければ作る)
 */
export function parseContacts(raw: string, newId: () => string): CustomerContact[] {
  let rows: unknown;
  try {
    rows = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const out: CustomerContact[] = [];
  for (const r of rows.slice(0, 20)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const phone = text(o.phone, 40);
    if (phoneDigits(phone).length < 6) continue;
    const id = text(o.id, 40);
    out.push({
      id: /^cc_[a-z0-9_]+$/i.test(id) ? id : newId(),
      relation: text(o.relation, 30) || "その他",
      name: text(o.name, 60) || undefined,
      phone,
      note: text(o.note, 120) || undefined,
    });
  }
  return out;
}
