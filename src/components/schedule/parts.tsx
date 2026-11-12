import clsx from "clsx";
import type { ComponentType } from "react";
import { CalendarDays, CalendarOff, Hammer, Handshake, Landmark, MapPin, Megaphone, PackageOpen, PartyPopper, Ruler, TriangleAlert, Truck, Users } from "lucide-react";
import type { ScheduleKind } from "@/lib/db/types";
import { SCHEDULE_GROUP_LABEL, SCHEDULE_KIND, SCHEDULE_KINDS, type ScheduleGroup } from "@/lib/constants";

/**
 * 予定表の共通部品 (サーバー・クライアントの両方から使う)
 * 種別は「色 + アイコン + ラベル」で表し、色だけに意味を持たせない。
 * 文字色は本文色 (ink) を基本とし、種別色は帯・アイコン・バッジに使う。
 */

type IconComponent = ComponentType<{ className?: string }>;

export interface KindStyle {
  icon: IconComponent;
  /** 帯 (チップ左端・タイムラインのバー) */
  bar: string;
  border: string;
  /** 淡い背景 */
  soft: string;
  /** 淡い背景に載せる文字色 (バッジ用) */
  ink: string;
}

export const KIND_STYLE: Record<ScheduleKind, KindStyle> = {
  survey: { icon: MapPin, bar: "bg-[#2a78d6]", border: "border-l-[#2a78d6]", soft: "bg-[#eaf2fd]", ink: "text-[#1c5cab]" },
  measure: { icon: Ruler, bar: "bg-[#5b4fd6]", border: "border-l-[#5b4fd6]", soft: "bg-[#efedfc]", ink: "text-[#4338b0]" },
  pickup: { icon: PackageOpen, bar: "bg-[#c98500]", border: "border-l-[#c98500]", soft: "bg-[#fff5dc]", ink: "text-[#8a5a00]" },
  delivery: { icon: Truck, bar: "bg-[#0d9488]", border: "border-l-[#0d9488]", soft: "bg-[#e2f5f2]", ink: "text-[#0b6b62]" },
  install: { icon: Hammer, bar: "bg-[#1f7a4d]", border: "border-l-[#1f7a4d]", soft: "bg-[#e6f3eb]", ink: "text-[#145a37]" },
  visit: { icon: Handshake, bar: "bg-[#d9602f]", border: "border-l-[#d9602f]", soft: "bg-[#fdeee6]", ink: "text-[#9a3f16]" },
  meeting: { icon: Users, bar: "bg-[#4f6b8a]", border: "border-l-[#4f6b8a]", soft: "bg-[#edf1f6]", ink: "text-[#36506d]" },
  gathering: { icon: Landmark, bar: "bg-[#8a6a4f]", border: "border-l-[#8a6a4f]", soft: "bg-[#f4efea]", ink: "text-[#6b4f37]" },
  company: { icon: PartyPopper, bar: "bg-[#c2477f]", border: "border-l-[#c2477f]", soft: "bg-[#fbebf3]", ink: "text-[#97305f]" },
  event: { icon: Megaphone, bar: "bg-[#9b3dc9]", border: "border-l-[#9b3dc9]", soft: "bg-[#f5ecfb]", ink: "text-[#7a2aa3]" },
  leave: { icon: CalendarOff, bar: "bg-[#8a918d]", border: "border-l-[#8a918d]", soft: "bg-[#eef0ee]", ink: "text-[#545c57]" },
  other: { icon: CalendarDays, bar: "bg-[#a3aaa6]", border: "border-l-[#a3aaa6]", soft: "bg-[#f3f5f3]", ink: "text-[#545c57]" },
};

export function kindStyle(kind: ScheduleKind): KindStyle {
  return KIND_STYLE[kind] ?? KIND_STYLE.other;
}

export function kindLabel(kind: ScheduleKind): string {
  return SCHEDULE_KIND[kind]?.label ?? kind;
}

export const KINDS_BY_GROUP: Record<ScheduleGroup, ScheduleKind[]> = {
  case: SCHEDULE_KINDS.filter((k) => SCHEDULE_KIND[k].group === "case"),
  internal: SCHEDULE_KINDS.filter((k) => SCHEDULE_KIND[k].group === "internal"),
};

export function KindIcon({ kind, className }: { kind: ScheduleKind; className?: string }) {
  const Icon = kindStyle(kind).icon;
  return (
    <span aria-hidden className="inline-flex shrink-0">
      <Icon className={clsx("shrink-0", className)} />
    </span>
  );
}

export function KindBadge({ kind, className }: { kind: ScheduleKind; className?: string }) {
  const s = kindStyle(kind);
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", s.soft, s.ink, className)}>
      <KindIcon kind={kind} className="h-3.5 w-3.5" />
      {kindLabel(kind)}
    </span>
  );
}

/** 重複 (ダブルブッキング) の目印。アイコン + 文字で表す */
export function ConflictBadge({ count, className }: { count?: number; className?: string }) {
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-0.5 rounded-full bg-critical-soft px-1.5 py-px text-[10px] leading-4 font-semibold whitespace-nowrap text-critical-ink", className)}>
      <TriangleAlert className="h-3 w-3" aria-hidden />
      重複{count && count > 1 ? ` ${count}` : ""}
    </span>
  );
}

/** 種別の凡例 (案件の予定 / 社内・その他の予定) */
export function KindLegend({ className }: { className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-2 text-xs text-ink-2 @3xl:flex-row @3xl:flex-wrap @3xl:items-center @3xl:gap-x-6", className)}>
      {(Object.keys(KINDS_BY_GROUP) as ScheduleGroup[]).map((g) => (
        <div key={g} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-semibold text-ink-3">{SCHEDULE_GROUP_LABEL[g]}</span>
          {KINDS_BY_GROUP[g].map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={clsx("inline-flex h-4 w-4 items-center justify-center rounded", kindStyle(k).soft, kindStyle(k).ink)}>
                <KindIcon kind={k} className="h-3 w-3" />
              </span>
              {kindLabel(k)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 「中村 花子」→「中村」 (カレンダーのセル用の短い表記) */
export function shortName(name: string): string {
  return name.split(/[\s　]/)[0] || name;
}
