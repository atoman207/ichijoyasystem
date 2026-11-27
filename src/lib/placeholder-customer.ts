import type { Customer, Database, User } from "@/lib/db/types";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { addAudit, diffChanges, nowIso } from "@/lib/db/store";
import { PLACEHOLDER_TAG, canLinkToCustomer, caseRelinkBlocker, customerReferenced, isPlaceholderCustomer, moveCaseToCustomer } from "@/lib/customer-link";
import { caseChainOf } from "@/lib/case-store";
import { domesticPhone } from "@/lib/ai-intake";
import { postalForSave } from "@/lib/postal/lookup";
import { buildCaseMap } from "@/lib/case-group";
import { addressParts, nameMatch } from "@/lib/customer-match";
import { phoneDigits } from "@/lib/customer-contacts";
import { townMatches } from "@/lib/placeholder-match";

/**
 * 予定表 (スプレッドシート) から取り込んだ案件の仮のお客様 (タグ「予定表から登録」。名字と地区だけ) を、見積の登録のときに決める
 * (お客様のご要望 2026-11-26「■ スプレッドシートから移行した予定の顧客・見積・受注登録」)。
 * 予定表の予定を開いて手書きの見積書を撮影 → AI が読んだお客様の情報で、
 * - link: 既存のお客様に紐付ける (住所の一致を先に出した候補・電話番号・お名前の検索から選ぶ)。案件 (問い合わせ・見積・受注・予定) ごと付け替え、
 *   仮のお客様は記録が残らなければ消す (src/lib/customer-link.ts の moveCaseToCustomer)
 * - promote: 新しいお客様として登録する = 仮のお客様を、読み取ったお名前・ふりがな・電話・住所で正式なお客様にする (新しい顧客を足さないので二重にならない)
 * どちらも予定は新しく作らない (今の予定に顧客・見積・受注がつながる)。mutate の中で呼ぶ
 */

export type PlaceholderAction = "link" | "promote";

export interface PlaceholderInput {
  placeholderId: string;
  action: string;
  /** link のときの紐付け先 (promote は仮のお客様の ID) */
  customerId: string;
  /** 案件 (見積を作る問い合わせ・案件の ID) */
  caseRecordId?: string;
  name?: string;
  kana?: string;
  phone?: string;
  address?: string;
}

const clean = (v: string | undefined, max: number) => (v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);

/** 仮のお客様の決め方を反映する。戻り値は見積のお客様 (customerId) と知らせの文。決められないときは error */
export function resolvePlaceholderCustomer(db: Database, user: User, f: PlaceholderInput): { customerId: string; note?: string; error?: string } {
  const ph = db.customers.find((c) => c.id === f.placeholderId);
  if (!ph || !isPlaceholderCustomer(ph)) return { customerId: f.customerId };
  const now = nowIso();
  if (f.action === "promote") {
    if (!canEditCaseStore(user, ph.storeId)) return { customerId: ph.id, error: "このお客様を登録する権限がありません (担当店舗の社員・店長が登録できます)。" };
    const name = clean(f.name, 60) || ph.name;
    if (!name) return { customerId: ph.id, error: "お名前を入れてください。" };
    const before: Pick<Customer, "name" | "kana" | "phone" | "address" | "postalCode" | "tags"> = { name: ph.name, kana: ph.kana, phone: ph.phone, address: ph.address, postalCode: ph.postalCode, tags: [...(ph.tags ?? [])] };
    ph.name = name;
    const kana = clean(f.kana, 60);
    if (kana) ph.kana = kana;
    const phone = clean(f.phone, 30);
    if (phone) ph.phone = domesticPhone(phone) ?? phone;
    const address = clean(f.address, 200);
    if (address && address !== ph.address) {
      ph.postalCode = postalForSave(address, "", { address: ph.address, postalCode: ph.postalCode }) || ph.postalCode;
      ph.address = address;
    }
    ph.tags = (ph.tags ?? []).filter((t) => t !== PLACEHOLDER_TAG);
    ph.updatedAt = now;
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "customer",
      entityId: ph.id,
      entityLabel: `${ph.code} ${ph.name}`,
      summary: "予定表から登録した仮のお客様を、手書きの見積書から読み取ったお名前・電話・住所で正式に登録",
      storeId: ph.storeId,
      changes: diffChanges(before, ph, ["name", "kana", "phone", "address", "postalCode", "tags"]),
    });
    return { customerId: ph.id, note: `${ph.name} 様を新しいお客様として登録しました (予定表から登録した仮のお客様を正式な登録にしました)。` };
  }
  if (f.action !== "link") return { customerId: f.customerId };
  const to = db.customers.find((c) => c.id === f.customerId);
  if (!to) return { customerId: f.customerId, error: "紐付けるお客様が見つかりません。" };
  if (to.id === ph.id) return { customerId: ph.id };
  if (!canLinkToCustomer(db, user, to)) return { customerId: to.id, error: "このお客様には紐付けられません (閲覧の範囲の外のお客様です)。" };
  const chain = f.caseRecordId ? caseChainOf(db, f.caseRecordId) : undefined;
  if (chain) {
    const blocker = caseRelinkBlocker(db, chain);
    if (blocker) return { customerId: to.id, error: blocker };
    moveCaseToCustomer(db, chain, to, user.id);
  }
  // 案件につながっていない仮のお客様の予定 (取込の予定のうちお客様だけにひも付いたもの) も同じお客様にする
  for (const e of db.schedule) {
    if (e.customerId !== ph.id || e.orderId || e.quoteId || e.inquiryId) continue;
    e.customerId = to.id;
    e.updatedAt = now;
  }
  const still = db.customers.find((c) => c.id === ph.id);
  if (still && !customerReferenced(db, ph.id)) {
    db.customers = db.customers.filter((c) => c.id !== ph.id);
    addAudit(db, { userId: user.id, action: "delete", entity: "customer", entityId: ph.id, entityLabel: `${ph.code} ${ph.name}`, summary: `予定表の取込で仮に作った顧客を削除 (見積の登録のときに ${to.code} ${to.name} に紐付けたため。ほかの記録はありません)`, storeId: ph.storeId });
  }
  return { customerId: to.id, note: `予定表の案件を ${to.name} 様に紐付けました。` };
}

const squash = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "");

/**
 * 問合せ登録で仮のお客様に紐付けたとき、メモの内容で正式なお客様にする (お客様のご連絡 2026-11-27)。
 * 入っていない項目だけを足す (読み違いで登録を書き換えない): お名前は仮の名字で始まる氏名のときだけ (古澤 → 古澤 万亀生)、
 * ふりがなはお名前が合うときだけ、電話番号は空のとき、住所は番地のある住所で仮の住所が町名だけのとき。
 * 電話番号か番地までの住所がそろえば「予定表から登録」のタグを外す。変えたら知らせの文を返す (mutate の中で呼ぶ)
 */
export function fillPlaceholderFromFields(db: Database, user: User, ph: Customer, f: { name?: string; kana?: string; phone?: string; address?: string }): string | undefined {
  if (!isPlaceholderCustomer(ph) || !canEditCaseStore(user, ph.storeId)) return undefined;
  const before: Pick<Customer, "name" | "kana" | "phone" | "address" | "postalCode" | "tags"> = { name: ph.name, kana: ph.kana, phone: ph.phone, address: ph.address, postalCode: ph.postalCode, tags: [...(ph.tags ?? [])] };
  const name = clean(f.name, 60);
  if (name && squash(ph.name) && squash(name) !== squash(ph.name) && squash(name).startsWith(squash(ph.name))) ph.name = name;
  const kana = clean(f.kana, 60);
  if (kana && !ph.kana && nameMatch({ name: f.name, kana: f.kana }, ph)) ph.kana = kana;
  const phone = clean(f.phone, 30);
  if (phone && !ph.phone && phoneDigits(phone).length >= 9) ph.phone = domesticPhone(phone) ?? phone;
  const address = clean(f.address, 200);
  if (address && addressParts(address).num && !addressParts(ph.address).num && (!ph.address || townMatches(ph, { addresses: [address] }))) {
    ph.postalCode = postalForSave(address, "", { address: ph.address, postalCode: ph.postalCode }) || ph.postalCode;
    ph.address = address;
  }
  if (ph.phone || addressParts(ph.address).num) ph.tags = (ph.tags ?? []).filter((t) => t !== PLACEHOLDER_TAG);
  const changes = diffChanges(before, ph, ["name", "kana", "phone", "address", "postalCode", "tags"]);
  if (!changes.length) return undefined;
  ph.updatedAt = nowIso();
  addAudit(db, { userId: user.id, action: "update", entity: "customer", entityId: ph.id, entityLabel: `${ph.code} ${ph.name}`, summary: "予定表から登録した仮のお客様に、問合せ登録のメモのお名前・電話・住所を足しました", storeId: ph.storeId, changes });
  return isPlaceholderCustomer(ph)
    ? `予定表から登録した仮のお客様に、メモの内容を足しました (電話番号・番地までの住所がそろうと正式な登録になります)。`
    : `予定表から登録した仮のお客様を、メモの電話番号・住所で正式なお客様にしました。`;
}

/**
 * 仮のお客様 (予定表から登録) の案件を、選んだお客様 to の案件にする (お客様のご連絡 2026-11-27「既存案件への紐付けができませんでした」)。
 * 問合せ登録・問い合わせの登録・問い合わせを案件にまとめるときに、選んだお客様と案件のお客様が違い、案件のお客様が仮のお客様のときに呼ぶ。
 * 案件のすべての記録 (問い合わせ・見積・受注) と予定・資料・やりとりを to に付け替え (src/lib/customer-link.ts の moveCaseToCustomer)、
 * 案件につながっていない仮のお客様の予定も to にし、仮のお客様に記録が残らなければ消す。
 * 案件のお客様が to か仮のお客様だけでなければ付け替えない (error)。何もしなかったときは adopted = false。mutate の中で呼ぶ
 */
export function adoptPlaceholderCase(db: Database, user: User, caseRecordId: string, to: Customer): { adopted: boolean; note?: string; error?: string } {
  const map = buildCaseMap(db);
  const caseId = map.caseOf(caseRecordId);
  const m = caseId ? map.members(caseId) : undefined;
  if (!caseId || !m) return { adopted: false, error: "選んだ案件が見つかりません。" };
  const records = [...m.inquiries, ...m.quotes, ...m.orders];
  const owners = new Set(records.map((r) => r.customerId).filter((x): x is string => Boolean(x) && x !== to.id));
  if (!owners.size) return { adopted: false };
  const placeholders = [...owners].map((id) => db.customers.find((c) => c.id === id));
  if (placeholders.some((c) => !c || !isPlaceholderCustomer(c))) return { adopted: false, error: "この案件はほかのお客様の案件のため、追加できません。お客様を確かめてください。" };
  if (!canLinkToCustomer(db, user, to)) return { adopted: false, error: "このお客様には紐付けられません (閲覧の範囲の外のお客様です)。" };
  const chains = [...m.orders.map((o) => o.id), ...m.quotes.map((q) => q.id), ...m.inquiries.map((i) => i.id)].map((id) => caseChainOf(db, id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  for (const c of chains) {
    const blocker = caseRelinkBlocker(db, c);
    if (blocker) return { adopted: false, error: blocker };
  }
  for (const c of chains) moveCaseToCustomer(db, c, to, user.id);
  const now = nowIso();
  // 案件につながっていない仮のお客様の予定 (取込の予定のうちお客様だけにひも付いたもの) も同じお客様にする
  for (const e of db.schedule) {
    if (!e.customerId || !owners.has(e.customerId) || e.orderId || e.quoteId || e.inquiryId) continue;
    e.customerId = to.id;
    e.updatedAt = now;
  }
  const removed: string[] = [];
  for (const ph of placeholders) {
    if (!ph || !db.customers.some((c) => c.id === ph.id)) {
      if (ph) removed.push(`${ph.code} ${ph.name}`);
      continue;
    }
    if (customerReferenced(db, ph.id)) continue;
    db.customers = db.customers.filter((c) => c.id !== ph.id);
    removed.push(`${ph.code} ${ph.name}`);
    addAudit(db, { userId: user.id, action: "delete", entity: "customer", entityId: ph.id, entityLabel: `${ph.code} ${ph.name}`, summary: `予定表の取込で仮に作った顧客を削除 (案件を ${to.code} ${to.name} に付け替えたため。ほかの記録はありません)`, storeId: ph.storeId });
  }
  const head = records.find((r) => r.id === caseId);
  const number = head?.number ?? "";
  to.updatedAt = now;
  return { adopted: true, note: `予定表から移行した案件${number ? ` ${number}` : ""}を ${to.name} 様の案件にしました${removed.length ? ` (仮の登録 ${removed.join("・")} は削除しました)` : ""}。` };
}
