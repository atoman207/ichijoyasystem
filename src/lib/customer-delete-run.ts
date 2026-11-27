import { addAudit, newId } from "@/lib/db/store";
import type { Customer, Database } from "@/lib/db/types";
import { applyCustomerDelete, customerSnapshot, type CustomerDeleteResult } from "@/lib/customer-delete";

/**
 * 顧客の削除 (統合) を反映して変更履歴を残す (mutate の中で呼ぶ。確かめは customerDeleteBlocker で先に)。
 * 削除の画面 (actions/customers.ts の deleteCustomer) と店舗スタッフの申請の承認 (approval-decide.ts) で共通
 */
export function runCustomerDelete(
  db: Database,
  from: Customer,
  to: Customer | undefined,
  opts: { actorId: string; at: string; reason: string; requestedBy?: string; approvalId?: string },
): CustomerDeleteResult {
  const r = applyCustomerDelete(db, from, to, { at: opts.at, newId, decidedBy: opts.actorId });
  const who = opts.requestedBy && opts.requestedBy !== opts.actorId ? ` · 申請 ${db.users.find((u) => u.id === opts.requestedBy)?.name ?? "-"} さん` : "";
  const moved = r.moved.map((m) => `${m.label} ${m.count} 件`).join("・");
  const label = `${from.code} ${from.name}`;
  addAudit(db, {
    userId: opts.actorId,
    action: "delete",
    entity: "customer",
    entityId: from.id,
    entityLabel: label,
    summary: to
      ? `顧客を削除 (二重登録の統合: 記録${moved ? ` ${moved}` : ""} を ${to.code} ${to.name} 様に移して削除 · 理由: ${opts.reason}${who})`
      : `顧客を削除 (記録なし · 理由: ${opts.reason}${who})`,
    storeId: from.storeId,
    changes: [
      ...(to ? [{ field: "mergeInto", before: null, after: to.id }] : []),
      { field: "deletedRecord", before: customerSnapshot(from), after: null },
    ],
  });
  if (to) {
    const added = [
      r.phones.length ? `ほかの電話番号に ${r.phones.join("・")}` : "",
      r.tags.length ? `タグに ${r.tags.join("・")}` : "",
      r.notes ? "メモに統合したお客様のメモ" : "",
    ].filter(Boolean);
    addAudit(db, {
      userId: opts.actorId,
      action: "update",
      entity: "customer",
      entityId: to.id,
      entityLabel: `${to.code} ${to.name}`,
      summary: `二重に登録した顧客 ${label} 様を統合 (記録${moved ? ` ${moved}` : " なし"} をこのお客様に移しました${added.length ? ` · ${added.join("、")}を追加` : ""} · 理由: ${opts.reason}${who})`,
      storeId: to.storeId,
      changes: [{ field: "mergedFrom", before: null, after: label }],
    });
  }
  return r;
}
