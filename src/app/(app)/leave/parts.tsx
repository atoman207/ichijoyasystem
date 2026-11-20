import type { Database, LeaveRequest, LeaveSlot, User } from "@/lib/db/types";
import { LEAVE_SLOT, LEAVE_STATUS, LEAVE_TYPE, fmtDays, md, type HrSettings } from "@/lib/hr/leave";
import { Badge, StatusBadge } from "@/components/ui";

/** 有給・休日出勤の画面のタブが使う共通の情報 */
export interface Ctx {
  db: Database;
  user: User;
  sp: Record<string, string | undefined>;
  today: string;
  settings: HrSettings;
  /** 見られる社員 (本人・店長は自店舗・本部と管理者は全員) */
  employees: User[];
  /** 本番のデータベースに表がある (ない間は登録のボタンを出さない) */
  ready: boolean;
  /** 戻り先 (現在のタブ) */
  returnTo: string;
}

export function LeaveTypeBadge({ type }: { type: LeaveRequest["leaveType"] }) {
  const t = LEAVE_TYPE[type];
  return <Badge tone={t.tone} dot={false}>{t.label}</Badge>;
}

export function LeaveStatusBadge({ status }: { status: LeaveRequest["status"] }) {
  return <StatusBadge value={status} map={LEAVE_STATUS} />;
}

/** 7/3〜7/5 終日 / 7/3 午前 */
export function leaveWhen(r: Pick<LeaveRequest, "date" | "endDate" | "slot">): string {
  return `${md(r.date)}${r.endDate && r.endDate > r.date ? `〜${md(r.endDate)}` : ""} ${LEAVE_SLOT[r.slot]}`;
}

export function slotLabel(slot: LeaveSlot): string {
  return LEAVE_SLOT[slot];
}

/** 日数 (0 のときは -) */
export function Days({ value, tone }: { value: number; tone?: "warn" | "critical" | "good" }) {
  if (!value) return <span className="text-ink-3">-</span>;
  return <span className={tone === "critical" ? "font-medium text-critical-ink" : tone === "warn" ? "font-medium text-warn-ink" : tone === "good" ? "text-good-ink" : ""}>{fmtDays(value)}</span>;
}

/** 社員の選択肢 (店舗ごと) */
export function EmployeeOptions({ employees, db }: { employees: User[]; db: Database }) {
  const stores = db.stores.filter((s) => employees.some((u) => u.storeId === s.id));
  return (
    <>
      {stores.map((s) => (
        <optgroup key={s.id} label={s.name}>
          {employees.filter((u) => u.storeId === s.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </optgroup>
      ))}
    </>
  );
}

