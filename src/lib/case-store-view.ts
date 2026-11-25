import type { Database, User } from "@/lib/db/types";
import type { QuickStoreChange } from "@/components/schedule/quick-types";
import { approverRole, canEditCaseStore, skipsApproval } from "@/lib/auth/permissions";
import { pendingStoreChange, storeChangeBlocker, type CaseChain } from "@/lib/case-store";
import { touchesConfirmedSales } from "@/lib/approval-decide";

/**
 * 案件の施工店舗 (= 売上を計上する店舗) を変えられるか・承認が要るか・承認者 (予定表の小さな画面と、見積・受注の画面で共通)。
 * 変更は actions/schedule.ts の changeEventStore (予定から) / changeCaseStore (見積・受注の画面から) が同じ申請 (store_change) にする
 */
export function caseStoreChangeInfo(db: Database, user: User, chain: CaseChain, canEdit: boolean, caseLabel: string): QuickStoreChange {
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const pending = pendingStoreChange(db, chain);
  const to = pending?.changes?.find((c) => c.field === "storeId")?.after;
  // 承認が要るか: 店長・管理者は省略 (確定した売上の受注は管理者の承認)
  const confirmed = touchesConfirmedSales(db, { type: "store_change", targetId: chain.head.id });
  const needsApproval = !skipsApproval(user, "store_change") || (user.role !== "admin" && confirmed);
  const role = confirmed ? "admin" : approverRole(db.users, chain.head.storeId, false, user.id);
  // 店舗によらない理由 (請求書・キャンセル・月次確定) を先に出す (ほかの店舗のどれかで確かめる)
  const other = db.stores.find((s) => s.id !== chain.head.storeId);
  const reason = other ? storeChangeBlocker(db, chain, other.id) : undefined;
  return {
    mode: "case",
    caseLabel,
    current: chain.head.storeId,
    currentName: storeName(chain.head.storeId),
    options: db.stores.filter((s) => s.id !== chain.head.storeId).map((s) => ({ id: s.id, name: s.name })),
    canChange: canEdit && canEditCaseStore(user, chain.head.storeId) && !reason && !pending,
    blocked: reason,
    pending: pending ? `${storeName(String(to ?? ""))}への変更を申請中 (${pending.createdAt.slice(5, 10).replace("-", "/")}・${db.users.find((u) => u.id === pending.requestedBy)?.name ?? "-"})` : undefined,
    needsApproval,
    approver: role === "admin" ? "管理者" : `${storeName(chain.head.storeId)}の店長`,
  };
}
