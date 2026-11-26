import type { Database, User } from "@/lib/db/types";
import { canViewAttendanceOf } from "@/lib/auth/permissions";
import { attendanceEmployees, attendanceMonthOf, shiftMonth, type AttendanceSettings, type DayCalc } from "@/lib/hr/timecard";
import { Badge } from "@/components/ui";

export interface Ctx {
  db: Database;
  user: User;
  sp: Record<string, string | undefined>;
  today: string;
  settings: AttendanceSettings;
  clerks: string[];
  ready: boolean;
}

/** 見られる社員 (本人が先頭) */
export function visibleEmployees(ctx: Pick<Ctx, "db" | "user">): User[] {
  const list = attendanceEmployees(ctx.db).filter((u) => canViewAttendanceOf(ctx.user, u));
  if (!list.some((u) => u.id === ctx.user.id)) list.unshift(ctx.user);
  return [list.find((u) => u.id === ctx.user.id)!, ...list.filter((u) => u.id !== ctx.user.id)];
}

/** 選べる勤怠の月 (今の月から 13 か月前まで + 次の月) */
export function monthChoices(ctx: Pick<Ctx, "db" | "today">): string[] {
  const cur = attendanceMonthOf(ctx.db, ctx.today);
  return Array.from({ length: 14 }, (_, i) => shiftMonth(cur, 1 - i));
}

export const ymLabel = (ym: string) => `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月分`;
export const mdw = (d: string) => {
  const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(`${d}T00:00:00Z`).getUTCDay()];
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} (${wd})`;
};

export function DayTypeBadge({ d }: { d: DayCalc }) {
  if (d.dayType === "legal_off") return <Badge tone="critical" dot={false}>法定休日</Badge>;
  if (d.dayType === "scheduled_off") return <Badge tone="warn" dot={false}>所定休日</Badge>;
  return null;
}
