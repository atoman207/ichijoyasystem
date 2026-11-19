import Link from "next/link";
import type { ReactNode } from "react";
import type { Database, User } from "@/lib/db/types";
import { yen } from "@/lib/format";
import { Badge, Button, Field, Input, Select } from "@/components/ui";

/** 管理会計の画面の共通部品 */

export interface Ctx {
  db: Database;
  user: User;
  sp: Record<string, string | undefined>;
  tab: string;
  canEdit: boolean;
  canAdmin: boolean;
  /** 見られる店舗 (全店舗なら undefined) */
  storeIds?: string[];
  from: string;
  to: string;
  month: string;
  today: string;
}

export const qs = (ctx: Ctx, extra: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  const base: Record<string, string | undefined> = { tab: ctx.tab, from: ctx.from, to: ctx.to, month: ctx.month, ...extra };
  for (const [k, v] of Object.entries(base)) if (v) p.set(k, v);
  return `/management?${p.toString()}`;
};

export const back = (ctx: Ctx, extra: Record<string, string | undefined> = {}) => <input type="hidden" name="back" value={qs(ctx, extra)} />;

export function Money({ v, strong, muted }: { v: number | null | undefined; strong?: boolean; muted?: boolean }) {
  if (v === null || v === undefined) return <span className="text-ink-3">-</span>;
  return <span className={strong ? "font-semibold" : muted ? "text-ink-3" : v < 0 ? "text-critical" : ""}>{yen(v)}</span>;
}

export function Pct({ v }: { v: number | null }) {
  return v === null ? <span className="text-ink-3" title="分母が 0 のため計算できません">計算不能</span> : <span>{v.toFixed(1)}%</span>;
}

export function Provisional({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return <Badge tone="good">確定の数字</Badge>;
  return (
    <span title={reasons.join("\n")}>
      <Badge tone="warn">暫定を含む ({reasons.length})</Badge>
    </span>
  );
}

export function PeriodForm({ ctx, monthOnly, children }: { ctx: Ctx; monthOnly?: boolean; children?: ReactNode }) {
  const y = Number(ctx.today.slice(0, 4));
  const m = Number(ctx.today.slice(5, 7));
  const fyStart = m >= 7 ? y : y - 1;
  const last = new Date(y, m - 1, 0);
  const lastMonth = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
  const quick: [string, string, string][] = [
    ["今月", `${ctx.today.slice(0, 7)}-01`, ctx.today],
    ["先月", `${lastMonth}-01`, `${lastMonth}-${String(last.getDate()).padStart(2, "0")}`],
    ["今年度 (7 月〜)", `${fyStart}-07-01`, ctx.today],
    ["前年度", `${fyStart - 1}-07-01`, `${fyStart}-06-30`],
  ];
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value={ctx.tab} />
        {monthOnly ? (
          <Field label="月">
            <Input type="month" name="month" defaultValue={ctx.month} />
          </Field>
        ) : (
          <>
            <Field label="期間 (から)">
              <Input type="date" name="from" defaultValue={ctx.from} />
            </Field>
            <Field label="期間 (まで)">
              <Input type="date" name="to" defaultValue={ctx.to} />
            </Field>
          </>
        )}
        {children}
        <Button type="submit" variant="secondary">
          表示
        </Button>
      </form>
      {!monthOnly && (
        <div className="flex flex-wrap gap-1 text-xs">
          {quick.map(([label, f, t]) => (
            <Link key={label} className="rounded-full border border-line px-2.5 py-1 hover:bg-panel-2" href={qs(ctx, { from: f, to: t })}>
              {label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function StoreSelect({ db, name, defaultValue, storeIds, all, required }: { db: Database; name: string; defaultValue?: string; storeIds?: string[]; all?: string; required?: boolean }) {
  return (
    <Select name={name} defaultValue={defaultValue ?? ""} required={required}>
      {all !== undefined && <option value="">{all}</option>}
      {db.stores
        .filter((s) => !storeIds || storeIds.includes(s.id))
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.closedOn ? ` (閉鎖 ${s.closedOn})` : ""}
          </option>
        ))}
    </Select>
  );
}

export const storeNameOf = (db: Database, id: string | undefined) => db.stores.find((s) => s.id === id)?.name ?? id ?? "-";
export const userNameOf = (db: Database, id: string | undefined) => db.users.find((u) => u.id === id)?.name ?? id ?? "-";
