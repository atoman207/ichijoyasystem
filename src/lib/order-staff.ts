import type { Database, Order, StoreId, User } from "@/lib/db/types";
import { deliveryStaffOf } from "@/lib/work-staff";

/**
 * 受注の担当 (営業担当) と施工担当
 * ------------------------------------------------------------
 * 経営ダッシュボード (management.ts) と AI アシスタントの売上の分析 (assistant/facts.ts) が同じ判定を使う。
 *
 * - システムで登録した受注: 担当 = 見積の担当者 (estimatorId) → 見積の作成者 → 受注の作成者。施工担当 = 受注の施工担当 (workerIds)
 * - 作業の担当 (Order.workStaff。施工完了・売上確定で確かめた実績。src/lib/work-staff.ts) があれば、担当 = 現地見積の人、施工担当 = 引取・納品・施工の人
 * - 販売管理ソフトから移行した受注 (経過メモに「担当者欄: 5 山田太郎、12 …、51 …」がある): 販売管理ソフトの見出しのない列で、
 *   1 番目 = 担当、2 番目 = 施工担当、3 番目 = 伝票の入力者 (事務)。入力者は担当にも施工担当にも数えない。
 *   取込のとき空の列は省かれるため、名前が 2 つなら 1 番目 = 担当・2 番目 = 入力者、1 つなら担当とみなす。
 *   受注の作成者 (createdBy) は取込で入力者・店長・管理者になっているので、移行した受注の担当には使わない。
 *   施工担当は取込で社員と照合できた人 (workerIds) に、照合できなかった 2 番目の名前を足す
 * - 人は「キー」で表す: アカウントのある社員は社員 ID、アカウントのない人 (退職者など) は "name:<空白なしの名前>"。
 *   担当者欄の名前は空白を除いた名前が一致する社員に結び付ける (有効なアカウントを優先。同じ名前が 2 人以上なら結び付けない)
 */

export const NAME_KEY_PREFIX = "name:";

/** 名前の比較用 (全角・半角をそろえて空白を除く) */
export function compactName(s: string): string {
  return s.normalize("NFKC").replace(/[\s　]+/g, "");
}

export interface LedgerStaff {
  /** 担当 (1 番目) */
  sales?: string;
  /** 施工担当 (2 番目。名前が 3 つ以上のときだけ分かる) */
  worker?: string;
  /** 伝票の入力者 (3 番目。名前が 2 つのときは 2 番目) */
  input?: string;
}

/** 経過メモの「担当者欄:」を読む (移行した受注のみ。なければ null)。名前は空白なし */
export function ledgerStaffOf(o: Pick<Order, "progressNotes">): LedgerStaff | null {
  for (const n of o.progressNotes ?? []) {
    const line = n.body.split("\n").find((l) => l.startsWith("担当者欄:"));
    if (!line) continue;
    const names = line
      .replace(/^担当者欄:\s*/, "")
      .split(/[、,]/)
      .map((s) => compactName(s.trim().replace(/^\d+\s*/, "")))
      .filter(Boolean);
    if (!names.length) continue;
    if (names.length === 1) return { sales: names[0] };
    if (names.length === 2) return { sales: names[0], input: names[1] };
    return { sales: names[0], worker: names[1], input: names[2] };
  }
  return null;
}

export interface OrderStaff {
  /** 担当 (営業担当) のキー。分からなければ空 */
  sales: string[];
  /** 施工担当のキー */
  workers: string[];
}

export interface StaffIndex {
  byOrder: Map<string, OrderStaff>;
  /** キー → 表示名 (社員は登録の名前、アカウントのない人は担当者欄の名前) */
  label(key: string): string;
  /** キー → 社員 (アカウントのない人は undefined) */
  userOf(key: string): User | undefined;
  /** アカウントのない人のキー → 店舗ごとの受注の件数 (担当・施工担当として) */
  unlinked: Map<string, Map<StoreId, number>>;
}

const g = globalThis as typeof globalThis & { __ichijoyaOrderStaff?: { sig: string; index: StaffIndex } };

function signature(db: Pick<Database, "orders" | "quotes" | "users">): string {
  let latest = "";
  for (const o of db.orders ?? []) if (o.updatedAt > latest) latest = o.updatedAt;
  let quoteLatest = "";
  for (const q of db.quotes ?? []) if (q.updatedAt > quoteLatest) quoteLatest = q.updatedAt;
  const users = (db.users ?? []).map((u) => `${u.id}:${u.name}:${u.active ? 1 : 0}`).join(",");
  return [db.orders?.length, latest, db.quotes?.length, quoteLatest, users].join("|");
}

function build(db: Pick<Database, "orders" | "quotes" | "users">): StaffIndex {
  const users = (db.users ?? []).filter((u) => u.id !== "system");
  const userById = new Map(users.map((u) => [u.id, u]));
  // 空白なしの名前 → 社員 (有効なアカウントを優先。同じ名前が 2 人以上なら結び付けない)
  const byName = new Map<string, User | null>();
  for (const active of [true, false]) {
    const seen = new Map<string, User | null>();
    for (const u of users.filter((x) => x.active === active)) {
      const k = compactName(u.name);
      if (k.length < 2) continue;
      seen.set(k, seen.has(k) ? null : u);
    }
    for (const [k, u] of seen) if (!byName.has(k)) byName.set(k, u);
  }
  const keyOfName = (name: string): string => byName.get(name)?.id ?? `${NAME_KEY_PREFIX}${name}`;
  const quoteById = new Map((db.quotes ?? []).map((q) => [q.id, q]));

  const byOrder = new Map<string, OrderStaff>();
  const unlinked = new Map<string, Map<StoreId, number>>();
  const countUnlinked = (key: string, storeId: StoreId) => {
    if (!key.startsWith(NAME_KEY_PREFIX)) return;
    const m = unlinked.get(key) ?? new Map<StoreId, number>();
    m.set(storeId, (m.get(storeId) ?? 0) + 1);
    unlinked.set(key, m);
  };
  for (const o of db.orders ?? []) {
    const ledger = ledgerStaffOf(o);
    let sales: string[];
    let workers = [...new Set(o.workerIds ?? [])];
    if (ledger) {
      sales = ledger.sales ? [keyOfName(ledger.sales)] : [];
      if (ledger.worker) {
        // 取込のあとで消えたアカウント (ID だけが残る) は、担当者欄の名前に置き換える
        workers = workers.filter((id) => userById.has(id));
        const w = keyOfName(ledger.worker);
        if (!workers.includes(w)) workers.push(w);
      }
    } else {
      const q = o.quoteId ? quoteById.get(o.quoteId) : undefined;
      const who = q?.estimatorId ?? q?.createdBy ?? o.createdBy;
      sales = who ? [who] : [];
    }
    // 施工完了・売上確定で確かめた作業の担当 (src/lib/work-staff.ts) があればそれを正しいデータとして使う: 担当 = 現地見積、施工担当 = 引取・納品・施工
    if (o.workStaff) {
      if (o.workStaff.survey.length) sales = [...o.workStaff.survey];
      const done = deliveryStaffOf(o.workStaff);
      if (done.length) workers = done;
    }
    for (const k of new Set([...sales, ...workers])) countUnlinked(k, o.storeId);
    byOrder.set(o.id, { sales, workers });
  }
  return {
    byOrder,
    unlinked,
    label: (key) => (key.startsWith(NAME_KEY_PREFIX) ? key.slice(NAME_KEY_PREFIX.length) : (userById.get(key)?.name ?? "(退職・不明)")),
    userOf: (key) => (key.startsWith(NAME_KEY_PREFIX) ? undefined : userById.get(key)),
  };
}

/** 全受注の担当・施工担当 (受注・見積・社員が変わったときだけ作り直す) */
export function orderStaffIndex(db: Pick<Database, "orders" | "quotes" | "users">): StaffIndex {
  const sig = signature(db);
  if (g.__ichijoyaOrderStaff?.sig === sig) return g.__ichijoyaOrderStaff.index;
  const index = build(db);
  g.__ichijoyaOrderStaff = { sig, index };
  return index;
}
