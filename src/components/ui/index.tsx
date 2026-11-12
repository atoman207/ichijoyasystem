import Link from "@/components/ui/Link";
import clsx from "clsx";
import type { ReactNode } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, Info, Lightbulb, TriangleAlert } from "lucide-react";
import type { Tone } from "@/lib/constants";
import type { Channel, Store } from "@/lib/db/types";
import { CHANNEL_LABEL } from "@/lib/constants";

/* ------------------------------------------------------------------ */
/* Tone maps (色はアイコン・ラベルと併用する)                              */
/* ------------------------------------------------------------------ */

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-ink-2",
  info: "bg-info-soft text-info-ink",
  good: "bg-good-soft text-good-ink",
  warn: "bg-warn-soft text-warn-ink",
  serious: "bg-serious-soft text-serious-ink",
  critical: "bg-critical-soft text-critical-ink",
  accent: "bg-accent-soft text-accent-ink",
};
const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-3",
  info: "bg-info",
  good: "bg-good",
  warn: "bg-warn",
  serious: "bg-serious",
  critical: "bg-critical",
  accent: "bg-accent",
};
const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink",
  info: "text-info-ink",
  good: "text-good-ink",
  warn: "text-warn-ink",
  serious: "text-serious-ink",
  critical: "text-critical-ink",
  accent: "text-accent-ink",
};

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "soft";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25 active:translate-y-px [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_8px_18px_-10px_rgba(74,90,232,0.95)] hover:bg-accent-hover",
  secondary: "border border-line bg-panel text-ink shadow-xs hover:border-line-strong hover:bg-subtle",
  ghost: "text-ink-2 hover:bg-subtle hover:text-ink",
  danger: "border border-critical/30 bg-panel text-critical-ink shadow-xs hover:bg-critical-soft",
  soft: "bg-accent-soft text-accent-ink hover:bg-accent/15",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string) {
  return clsx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], extra);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  download,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  /** ファイルのダウンロード (API)。先読み (prefetch) されないよう通常のリンクにする */
  download?: boolean;
}) {
  if (download) {
    return (
      <a href={href} download className={buttonClass(variant, size, className)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Badge / IconTile                                                    */
/* ------------------------------------------------------------------ */

export function Badge({
  tone = "neutral",
  children,
  dot = true,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot && <span className={clsx("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export function StatusBadge<T extends string>({
  value,
  map,
}: {
  value: T;
  map: Record<T, { label: string; tone: Tone }>;
}) {
  const m = map[value] ?? { label: value, tone: "neutral" as Tone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

/** 角丸の色付きタイルにアイコンを収める (統計カード・ページ見出し・空状態) */
export function IconTile({
  tone = "accent",
  size = "md",
  className,
  children,
}: {
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-xl",
        size === "sm" && "h-8 w-8 [&>svg]:h-4 [&>svg]:w-4",
        size === "md" && "h-10 w-10 [&>svg]:h-[18px] [&>svg]:w-[18px]",
        size === "lg" && "h-12 w-12 rounded-2xl [&>svg]:h-6 [&>svg]:w-6",
        TONE_CLASS[tone],
        className,
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}

/** 統計カード用のグラデーションのアイコンタイル (白いアイコン + 同系色の影) */
const TONE_GRADIENT: Record<Tone, string> = {
  accent: "from-[#8b96f7] to-[#4a5ae8] shadow-[0_10px_20px_-10px_rgba(74,90,232,0.85)]",
  info: "from-[#6cb6ff] to-[#2f7be0] shadow-[0_10px_20px_-10px_rgba(47,123,224,0.85)]",
  good: "from-[#5ad6a0] to-[#12a150] shadow-[0_10px_20px_-10px_rgba(18,161,80,0.8)]",
  warn: "from-[#ffd36b] to-[#f0a20b] shadow-[0_10px_20px_-10px_rgba(240,162,11,0.85)]",
  serious: "from-[#ffa77c] to-[#e0652f] shadow-[0_10px_20px_-10px_rgba(224,101,47,0.85)]",
  critical: "from-[#ff8f8f] to-[#e04848] shadow-[0_10px_20px_-10px_rgba(224,72,72,0.85)]",
  neutral: "from-[#b3b9c9] to-[#737b90] shadow-[0_10px_20px_-10px_rgba(115,123,144,0.8)]",
};

export function GradientTile({ tone = "accent", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "relative inline-flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-linear-to-br text-white [&>svg]:relative [&>svg]:h-[22px] [&>svg]:w-[22px]",
        TONE_GRADIENT[tone],
        className,
      )}
      aria-hidden
    >
      <span className="absolute inset-x-0 top-0 h-1/2 bg-linear-to-b from-white/30 to-transparent" />
      {children}
    </span>
  );
}

/** 増減の表示 (▲ 増加 = 緑 / ▼ 減少 = 赤 + 割合) */
export function Delta({ value, label, className }: { value: number; label?: string; className?: string }) {
  const up = value >= 0;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-semibold whitespace-nowrap tnum",
        up ? "bg-good-soft text-good-ink" : "bg-critical-soft text-critical-ink",
        className,
      )}
    >
      {up ? "▲" : "▼"} {Math.round(Math.abs(value) * 100)}%{label && <span className="ml-0.5 font-normal">{label}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Card / Page header / Stat                                           */
/* ------------------------------------------------------------------ */

export function Card({ className, children, padded = true }: { className?: string; children: ReactNode; padded?: boolean }) {
  return <div className={clsx("rounded-2xl border border-line/70 bg-panel shadow-card", padded && "p-5", className)}>{children}</div>;
}

export function CardHeader({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 items-start gap-2">
        {icon && (
          <span className="mt-px shrink-0 text-accent [&>svg]:h-[18px] [&>svg]:w-[18px]" aria-hidden>
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
  badge,
  icon,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  badge?: ReactNode;
  icon?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link href={back.href} className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-ink-3 transition hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <span
              className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line/70 bg-panel text-accent shadow-card [&>svg]:h-5 [&>svg]:w-5"
              aria-hidden
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            {eyebrow && <div className="mb-1 text-[11px] font-semibold tracking-wide text-accent-ink">{eyebrow}</div>}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] leading-tight font-bold tracking-tight text-ink">{title}</h1>
              {badge}
            </div>
            {description && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
  href,
  icon,
  accent = "accent",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  href?: string;
  icon?: ReactNode;
  accent?: Tone;
}) {
  const body = (
    <div className="flex min-w-0 items-center gap-3.5">
      {icon && (
        <GradientTile tone={tone === "critical" ? "critical" : accent} className="transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none">
          {icon}
        </GradientTile>
      )}
      <div className="min-w-0 flex-1">
        <div className={clsx("text-[22px] leading-tight font-bold tracking-tight break-words tnum", tone ? TONE_TEXT[tone] : "text-ink")}>{value}</div>
        <div className="mt-1 text-xs leading-snug font-medium text-ink-3">{label}</div>
        {sub && <div className="mt-1.5 text-[11px] leading-snug text-ink-2">{sub}</div>}
      </div>
    </div>
  );
  const cls = "group block rounded-2xl border border-line/70 bg-panel p-4 shadow-card";
  return href ? (
    <Link href={href} className={clsx(cls, "transition-[box-shadow,transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line hover:shadow-lift")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export function Table({ children, className, minWidth = "min-w-[720px]" }: { children: ReactNode; className?: string; minWidth?: string }) {
  return (
    <div className={clsx("overflow-x-auto rounded-2xl border border-line/70 bg-panel shadow-card", className)}>
      <table className={clsx("w-full text-sm", minWidth)}>{children}</table>
    </div>
  );
}

export function Th({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th
      className={clsx(
        "bg-subtle px-3 py-2.5 text-[11px] font-semibold tracking-wide text-ink-3 whitespace-nowrap first:pl-4 last:pr-4",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left", colSpan }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center"; colSpan?: number }) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        "border-t border-line px-3 py-2.5 align-middle first:pl-4 last:pr-4",
        align === "right" && "text-right tnum",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={clsx("transition-colors hover:bg-accent-soft/40", className)}>{children}</tr>;
}

export function EmptyRow({ colSpan, children = "該当するデータがありません" }: { colSpan: number; children?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-ink-3">
        {children}
      </td>
    </tr>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-panel/70 px-6 py-12 text-center">
      {icon && (
        <div className="mb-3 flex justify-center">
          <IconTile tone="neutral" size="lg">
            {icon}
          </IconTile>
        </div>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 text-xs text-ink-3">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

export function Field({ label, hint, required, children, className }: { label: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="label">
        {label}
        {required && <span className="ml-1 text-critical">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx("field", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx("field", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx("field min-h-[88px]", props.className)} />;
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/** 項目名と値の一覧。置かれた場所 (カード・列) の幅に合わせて段数が変わる */
export function Dl({ items, columns = 2 }: { items: [ReactNode, ReactNode][]; columns?: 1 | 2 | 3 }) {
  return (
    <div className="@container">
      <dl
        className={clsx(
          "grid gap-x-6 gap-y-3 text-sm",
          columns === 1 && "grid-cols-1",
          columns === 2 && "grid-cols-1 @sm:grid-cols-2",
          columns === 3 && "grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3",
        )}
      >
        {items.map(([k, v], i) => (
          <div key={i} className="min-w-0">
            <dt className="text-xs text-ink-3">{k}</dt>
            <dd className="mt-0.5 break-words text-ink">{v ?? "-"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const AVATAR_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6", "#1f7a4d", "#d03b3b"];

export function avatarColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function Avatar({ name, id, size = 28, ring = false }: { name: string; id?: string; size?: number; ring?: boolean }) {
  const bg = avatarColor(id ?? name);
  const initial = name.trim().charAt(0);
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.1)]", ring && "ring-2 ring-panel")}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        backgroundImage: "linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0) 60%)",
        fontSize: Math.round(size * 0.44),
      }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

export function StoreTag({ store, short = false }: { store?: Store; short?: boolean }) {
  if (!store) return <span className="text-ink-3">-</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      <span className="h-2 w-2 rounded-full ring-2 ring-white" style={{ background: store.color }} aria-hidden />
      {short ? store.shortName : store.name}
    </span>
  );
}

export function ChannelTag({ channel }: { channel: Channel }) {
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-subtle px-1.5 py-0.5 text-[11px] text-ink-2 whitespace-nowrap">
      {CHANNEL_LABEL[channel] ?? channel}
    </span>
  );
}

export function LinkTabs({ items, current }: { items: { href: string; label: string; count?: number }[]; current: string }) {
  return (
    <div className="mb-4 overflow-x-auto">
      <div className="inline-flex min-w-max gap-1 rounded-full border border-line/70 bg-panel p-1 shadow-card">
        {items.map((it) => {
          const active = it.href === current;
          return (
            <Link
              key={it.href}
              href={it.href}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition",
                active ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-2 hover:bg-subtle hover:text-ink",
              )}
              aria-current={active ? "page" : undefined}
            >
              {it.label}
              {it.count !== undefined && (
                <span className={clsx("rounded-full px-1.5 text-[11px] tnum", active ? "bg-accent text-white" : "bg-neutral-soft text-ink-2")}>{it.count}</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function Flash({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  return (
    <div
      role="status"
      className={clsx(
        "mb-4 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-card animate-fade",
        err ? "border-critical/30 bg-critical-soft text-critical-ink" : "border-accent/30 bg-accent-soft text-accent-ink",
      )}
    >
      {err ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{err ?? msg}</span>
    </div>
  );
}

export function Section({ title, description, children, action, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={clsx("mb-6", className)}>
      <div className="mb-2.5 flex items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-3">{children}</p>;
}

/** 読み取り専用の説明ボックス (操作ガイド) */
export function Note({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" }) {
  const Icon = tone === "warn" ? TriangleAlert : tone === "accent" ? Lightbulb : Info;
  return (
    <div
      className={clsx(
        "flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs leading-relaxed",
        tone === "neutral" && "border-line bg-panel text-ink-2 shadow-card",
        tone === "accent" && "border-accent/20 bg-accent-soft text-accent-ink",
        tone === "warn" && "border-warn/30 bg-warn-soft text-warn-ink",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-80" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export interface Paged<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
  from: number;
  to: number;
}

/** 一覧を 1 ページ size 件に区切る (page は 1 始まり。範囲外は端に丸める) */
export function paginate<T>(rows: T[], pageParam: string | undefined, size = 100): Paged<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, Math.floor(Number(pageParam)) || 1), pages);
  const start = (page - 1) * size;
  const items = rows.slice(start, start + size);
  return { items, page, pages, total: rows.length, from: rows.length ? start + 1 : 0, to: start + items.length };
}

/** 検索条件を保ったまま page だけ変えた URL */
export function pageHref(path: string, sp: Record<string, string | undefined>, page: number): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && k !== "page" && k !== "msg" && k !== "err") q.set(k, v);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function Pager({ paged, path, sp }: { paged: Paged<unknown>; path: string; sp: Record<string, string | undefined> }) {
  if (paged.total === 0) return null;
  const link = "inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink transition hover:bg-subtle";
  return (
    <nav aria-label="ページ" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
      <span className="tnum">
        {paged.total.toLocaleString("ja-JP")} 件中 {paged.from.toLocaleString("ja-JP")}〜{paged.to.toLocaleString("ja-JP")} 件を表示
      </span>
      {paged.pages > 1 && (
        <span className="flex items-center gap-1.5">
          {paged.page > 1 ? <Link href={pageHref(path, sp, 1)} className={link}>最初</Link> : null}
          {paged.page > 1 ? <Link href={pageHref(path, sp, paged.page - 1)} className={link} rel="prev">前へ</Link> : null}
          <span className="px-1 tnum">
            {paged.page} / {paged.pages}
          </span>
          {paged.page < paged.pages ? <Link href={pageHref(path, sp, paged.page + 1)} className={link} rel="next">次へ</Link> : null}
          {paged.page < paged.pages ? <Link href={pageHref(path, sp, paged.pages)} className={link}>最後</Link> : null}
        </span>
      )}
    </nav>
  );
}
