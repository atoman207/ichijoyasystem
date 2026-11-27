import "server-only";
import { addAudit, diffChanges, newId, nowIso } from "@/lib/db/store";
import type { Database, Order, OrderPosting, OrderWorkStaff, User } from "@/lib/db/types";
import { WORK_ROLES, WORK_ROLE_LABEL, deliveryStaffOf, workStaffFromForm, workStaffOf } from "@/lib/work-staff";
import { addChangeNotice, caseTarget } from "@/lib/change-notices";
import { postingFromForm, postingLabel, postingNeeded, roleLabels, salesReadinessOf, undecidedRoles, workStaffNoneFromForm } from "@/lib/sales-ready";
import { fail, str } from "@/lib/actions/guards";

/*
 * 受注の作業の担当 (実績)・ポスティングの保存 (mutate の中で呼ぶ)。受注の画面 (src/lib/actions/orders.ts) と
 * 売上確定・請求書発行の画面 (src/lib/actions/sales.ts) で共通
 */

/**
 * 作業の担当 (実績) を受注に保存する (mutate の中)。施工完了・売上確定の後なら確かめた日時を残す (confirmed)。
 * 案件にひも付いたアンケート (はがき) の ②③ の担当もこの値にそろえる (移行したはがきは変えない)。変わった役割の数を返す
 */
export function applyWorkStaff(db: Database, user: User, o: Order, next: Omit<OrderWorkStaff, "confirmedAt" | "confirmedBy" | "updatedAt" | "updatedBy">, opts: { confirm: boolean; note?: string }): number {
  const now = nowIso();
  const before = workStaffOf(db, o);
  const names = (ids: string[]) => ids.map((id) => db.users.find((u) => u.id === id)?.name ?? "-").join("・") || "(なし)";
  const changedRoles = WORK_ROLES.filter((r) => [...before[r]].sort().join() !== [...next[r]].sort().join());
  const firstSave = !o.workStaff;
  o.workStaff = { ...next, confirmedAt: opts.confirm ? now : o.workStaff?.confirmedAt, confirmedBy: opts.confirm ? user.id : o.workStaff?.confirmedBy, updatedAt: now, updatedBy: user.id };
  o.updatedAt = now;
  if (changedRoles.length || firstSave) {
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "order",
      entityId: o.id,
      entityLabel: o.number,
      summary: `作業の担当を${opts.confirm ? "確定" : "変更"} (${WORK_ROLES.map((r) => `${WORK_ROLE_LABEL[r]}: ${names(next[r])}`).join(" / ")})${opts.note ? ` ${opts.note}` : ""}`,
      storeId: o.storeId,
      changes: WORK_ROLES.filter((r) => changedRoles.includes(r) || firstSave).map((r) => ({ field: `workStaff.${r}`, before: before[r], after: next[r] })),
    });
    if (changedRoles.length) {
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `作業の担当を${opts.confirm ? "確定" : "変更"}: ${changedRoles.map((r) => `${WORK_ROLE_LABEL[r]} ${names(before[r])} → ${names(next[r])}`).join(" / ")}` });
      addChangeNotice(db, user.id, caseTarget(db, o.id), "作業の担当の変更", changedRoles.map((r) => ({ label: `${WORK_ROLE_LABEL[r]}の担当`, before: names(before[r]), after: names(next[r]) })));
    }
  }
  // アンケートの ②③ の担当 (インセンティブの集計の起点。お客様のご要望 2026-11-25「④」)
  const delivery = deliveryStaffOf(next);
  for (const sv of db.surveys) {
    if (sv.orderId !== o.id || sv.source === "import") continue;
    const b = { salesUserId: sv.salesUserId, deliveryUserIds: [...(sv.deliveryUserIds ?? [])] };
    if (next.survey.length) sv.salesUserId = next.survey[0];
    if (delivery.length) {
      sv.deliveryUserIds = delivery;
      sv.craftsmanUserId = delivery[0];
    }
    const ch = diffChanges(b, { salesUserId: sv.salesUserId, deliveryUserIds: sv.deliveryUserIds ?? [] }, ["salesUserId", "deliveryUserIds"]);
    if (!ch.length) continue;
    sv.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "survey", entityId: sv.id, entityLabel: `はがき No.${sv.postcardNo ?? "-"}`, summary: `受注 ${o.number} の作業の担当に合わせてアンケートの担当を変更`, storeId: sv.storeId, changes: ch });
  }
  return changedRoles.length;
}

/** ポスティングの実績を保存する (mutate の中。変わったときだけ変更履歴) */
export function applyPosting(db: Database, user: User, o: Order, next: OrderPosting, note = "") {
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const before = postingLabel(o.posting, name);
  const after = postingLabel(next, name);
  const same = before === after && (o.posting?.date ?? "") === (next.date ?? "") && (o.posting?.area ?? "") === (next.area ?? "");
  o.posting = next;
  o.updatedAt = next.updatedAt;
  if (same) return;
  addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `ポスティングを登録: ${after}${next.area ? ` (${next.area})` : ""}${note ? ` ${note}` : ""}`, storeId: o.storeId, changes: [{ field: "posting", before, after }] });
}

/**
 * フォームの作業の担当 (workStaff.<役割>・workStaff.<役割>.none) とポスティング (posting.*) を受注に入れる (mutate の中)。
 * require = 売上登録 (施工完了・請求書の発行): 作業ごとに担当者か「なし」・ポスティングの枚数か「配れてない」がそろわなければ断る
 * (お客様のご要望 2026-11-27「■3」。src/lib/sales-ready.ts)。ポスティングは個人のお客様の案件だけ (法人の案件は送られても保存しない)
 */
export function applyStaffAndPosting(db: Database, user: User, o: Order, fd: FormData, back: string, opts: { require: boolean; confirm: boolean; note?: string }) {
  const active = new Set(db.users.filter((u) => u.active).map((u) => u.id));
  if (str(fd, "workStaffSent") === "1") {
    const base = workStaffFromForm(fd, active);
    const next = { ...base, none: workStaffNoneFromForm(fd).filter((r) => !base[r].length) };
    const gaps = undecidedRoles(next);
    if (opts.require && gaps.length) fail(back, `${roleLabels(gaps)}の担当者を選ぶか「なし」を選んでください (売上登録の前に作業の担当を確定します)。`);
    applyWorkStaff(db, user, o, next, { confirm: opts.confirm && !gaps.length, note: opts.note });
  }
  const needsPosting = postingNeeded(db, o);
  if (needsPosting) {
    const pr = postingFromForm(fd, active, user.id, nowIso());
    if (pr.error) fail(back, pr.error);
    if (pr.posting) applyPosting(db, user, o, pr.posting, opts.note);
  }
  if (opts.require) {
    const r = salesReadinessOf(db, o);
    if (!r.ok) fail(back, r.reason ?? "作業の担当とポスティングを登録してください。");
  }
}
