import type { Customer, Database, User } from "@/lib/db/types";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { addAudit, diffChanges, nowIso } from "@/lib/db/store";
import { PLACEHOLDER_TAG, canLinkToCustomer, caseRelinkBlocker, customerReferenced, isPlaceholderCustomer, moveCaseToCustomer } from "@/lib/customer-link";
import { caseChainOf } from "@/lib/case-store";
import { domesticPhone } from "@/lib/ai-intake";
import { postalForSave } from "@/lib/postal/lookup";

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
