import type { Database, KnowledgeEntry, User } from "@/lib/db/types";
import { canEditKnowledge, canViewKnowledge } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";

/**
 * 社内資料 (ナレッジ) の内容の管理
 * ------------------------------------------------------------
 * - どの資料にも 担当者 (ownerId)・次に確かめる日 (reviewDue)・見られる人 (visibility)・分類 (category) を付ける
 * - 担当者は「確認した」を押して内容が今も正しいことを確かめる → 次に確かめる日 = 今日 + 間隔 (資料ごと、なければ分類ごとの既定)
 * - 次に確かめる日を過ぎた資料は「確認期限切れ」: 一覧・ヘッダーの通知・担当者へのメール/Chatwork (毎日の確認で 7 日に 1 回まで)。
 *   AI アシスタントは期限切れの資料を使うとき「古い可能性がある」と添える (staleNote)
 * - 間隔・既定の担当者は設定 (settings の id = knowledge_review)。画面は 社内資料 →「確認のルール」(本部・管理者)
 * AI・外部サービスを使わない計算だけ (テストからも読む)
 */

export const KNOWLEDGE_REVIEW_ID = "knowledge_review";

export interface KnowledgeReviewSettings {
  /** 分類に間隔がないときの間隔 (日) */
  defaultDays: number;
  /** 分類ごとの間隔 (日) */
  intervals: Record<string, number>;
  /** 期限が近いとみなす日数 */
  soonDays: number;
  /** 担当者が決まっていない資料 (取込・同期で増えたもの) の担当者 */
  defaultOwnerId?: string;
}

/** 分類ごとの既定の間隔: 価格は変わりやすいので短く、議事録・過去の事例は記録なので長く */
export const DEFAULT_REVIEW_INTERVALS: Record<string, number> = {
  "商品・価格": 90,
  "施工・作業手順": 180,
  お客様対応: 180,
  社内ルール: 180,
  "議事録・決定事項": 365,
  マニュアル: 180,
  過去の対応事例: 365,
  よくある質問: 180,
  "協力業者・仕入先": 180,
  その他: 180,
};
export const REVIEW_INTERVAL_CHOICES = [30, 60, 90, 180, 365, 730] as const;
export const intervalLabel = (d: number) => (d % 365 === 0 ? `${d / 365} 年ごと` : d % 30 === 0 ? `${d / 30} か月ごと` : `${d} 日ごと`);

const clampDays = (n: unknown, d: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 7 && v <= 1095 ? v : d;
};

export function reviewSettings(db: Pick<Database, "settings">): KnowledgeReviewSettings {
  const v = (db.settings.find((s) => s.id === KNOWLEDGE_REVIEW_ID)?.value ?? {}) as Partial<KnowledgeReviewSettings>;
  const intervals: Record<string, number> = { ...DEFAULT_REVIEW_INTERVALS };
  if (v.intervals && typeof v.intervals === "object") for (const [k, n] of Object.entries(v.intervals)) intervals[k] = clampDays(n, intervals[k] ?? 180);
  return {
    defaultDays: clampDays(v.defaultDays, 180),
    intervals,
    soonDays: Math.min(60, Math.max(1, Math.round(Number(v.soonDays) || 14))),
    defaultOwnerId: typeof v.defaultOwnerId === "string" && v.defaultOwnerId ? v.defaultOwnerId : undefined,
  };
}

export const intervalFor = (s: KnowledgeReviewSettings, category?: string) => s.intervals[(category ?? "").trim()] ?? s.defaultDays;
/** 資料の間隔 (資料に指定がなければ分類の既定) */
export const entryInterval = (s: KnowledgeReviewSettings, k: Pick<KnowledgeEntry, "reviewIntervalDays" | "category">) => k.reviewIntervalDays ?? intervalFor(s, k.category);

export const todayKey = (now = new Date()) => toDateKey(now);
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return toDateKey(new Date(y, m - 1, d + days));
}

/* ================================================================== */
/* 確かめること                                                          */
/* ================================================================== */

export type KnowledgeIssue = "overdue" | "due_soon" | "no_review" | "no_owner" | "owner_invalid" | "no_category" | "no_visibility";

export const KNOWLEDGE_ISSUE: Record<KnowledgeIssue, { label: string; tone: "critical" | "warn" | "info"; hint: string }> = {
  overdue: { label: "確認期限切れ", tone: "critical", hint: "次に確かめる日を過ぎています。担当者が内容を確かめて「確認した」を押してください" },
  due_soon: { label: "確認期限が近い", tone: "warn", hint: "次に確かめる日が近づいています" },
  no_review: { label: "確認日なし", tone: "warn", hint: "次に確かめる日が決まっていません" },
  no_owner: { label: "担当者なし", tone: "warn", hint: "内容に責任を持つ担当者を決めてください" },
  owner_invalid: { label: "担当者を見直す", tone: "warn", hint: "担当者が退職・無効、社内資料を編集できない、またはこの資料を見られない人です" },
  no_category: { label: "分類なし", tone: "info", hint: "分類が空か「その他」です。内容に合う分類を選んでください" },
  no_visibility: { label: "公開範囲が未設定", tone: "info", hint: "「見られる人」が決まっていません (いまは全員が見られます)。範囲を選んで保存してください" },
};
/** 一覧の絞り込みの順 */
export const ISSUE_ORDER: KnowledgeIssue[] = ["overdue", "due_soon", "no_owner", "owner_invalid", "no_review", "no_category", "no_visibility"];

export interface ReviewCtx {
  today: string;
  soonDays: number;
  users: Pick<User, "id" | "role" | "active" | "storeId">[];
}

export function reviewCtx(db: Pick<Database, "settings" | "users">, now = new Date()): ReviewCtx {
  return { today: todayKey(now), soonDays: reviewSettings(db).soonDays, users: db.users };
}

export function knowledgeIssues(k: KnowledgeEntry, ctx: ReviewCtx): KnowledgeIssue[] {
  const out: KnowledgeIssue[] = [];
  if (!k.reviewDue) out.push("no_review");
  else if (k.reviewDue < ctx.today) out.push("overdue");
  else if (k.reviewDue <= addDays(ctx.today, ctx.soonDays)) out.push("due_soon");
  if (!k.ownerId) out.push("no_owner");
  else {
    const owner = ctx.users.find((u) => u.id === k.ownerId);
    if (!owner || !owner.active || !canEditKnowledge(owner as User) || !canViewKnowledge(owner as User, k)) out.push("owner_invalid");
  }
  if (!k.category?.trim() || k.category.trim() === "その他") out.push("no_category");
  if (!k.visibility) out.push("no_visibility");
  return out;
}

/** 管理が整っている (期限が近いだけのものは整っているとする) */
export const isReady = (issues: KnowledgeIssue[]) => issues.every((i) => i === "due_soon");
export const isStale = (k: Pick<KnowledgeEntry, "reviewDue">, today: string) => Boolean(k.reviewDue && k.reviewDue < today);

/** AI に渡す注記 (期限切れの資料だけ) */
export function staleNote(k: Pick<KnowledgeEntry, "reviewDue">, today: string): string | undefined {
  return isStale(k, today) ? `※ この資料は確認期限 (${k.reviewDue}) を過ぎています。内容が古い可能性があることを回答に添え、担当者への確認を勧めてください。` : undefined;
}

export interface KnowledgeQuality {
  total: number;
  /** AI に使う (active) 資料の数 */
  active: number;
  ready: number;
  counts: Record<KnowledgeIssue, number>;
}

/** 資料の一覧の管理の状況 (AI に使わない資料は期限の数に入れない) */
export function knowledgeQuality(entries: KnowledgeEntry[], ctx: ReviewCtx): KnowledgeQuality {
  const counts = Object.fromEntries(ISSUE_ORDER.map((k) => [k, 0])) as Record<KnowledgeIssue, number>;
  let ready = 0;
  for (const k of entries) {
    const issues = knowledgeIssues(k, ctx).filter((i) => k.active || (i !== "overdue" && i !== "due_soon"));
    for (const i of issues) counts[i]++;
    if (isReady(issues)) ready++;
  }
  return { total: entries.length, active: entries.filter((k) => k.active).length, ready, counts };
}

/** 担当者が自分で、期限切れ・期限が近い資料 (ヘッダーの通知・担当者への通知) */
export function myReviewItems(entries: KnowledgeEntry[], userId: string, ctx: ReviewCtx): { overdue: KnowledgeEntry[]; soon: KnowledgeEntry[] } {
  const mine = entries.filter((k) => k.active && k.ownerId === userId && k.reviewDue);
  const soonEnd = addDays(ctx.today, ctx.soonDays);
  return { overdue: mine.filter((k) => k.reviewDue! < ctx.today), soon: mine.filter((k) => k.reviewDue! >= ctx.today && k.reviewDue! <= soonEnd) };
}

/** 担当者にできる人 (有効・社内資料を編集できる・その資料を見られる) */
export function ownerCandidates(db: Pick<Database, "users">, k?: Pick<KnowledgeEntry, "visibility">): User[] {
  return db.users.filter((u) => u.active && canEditKnowledge(u) && (!k || canViewKnowledge(u, k)));
}

/** 「確認した」: 最後に確かめた日時と人、次に確かめる日 (今日 + 間隔) */
export function confirmedPatch(s: KnowledgeReviewSettings, k: Pick<KnowledgeEntry, "reviewIntervalDays" | "category">, userId: string, now = new Date()): Pick<KnowledgeEntry, "reviewedAt" | "reviewedBy" | "reviewDue"> {
  return { reviewedAt: now.toISOString(), reviewedBy: userId, reviewDue: addDays(todayKey(now), entryInterval(s, k)) };
}

/** 新しく増えた資料の管理の初期値 (担当者は指定 → 既定の担当者、次に確かめる日は今日 + 間隔) */
export function initialReview(s: KnowledgeReviewSettings, category: string | undefined, opts: { ownerId?: string; intervalDays?: number; now?: Date } = {}): Pick<KnowledgeEntry, "ownerId" | "reviewIntervalDays" | "reviewDue"> {
  const days = opts.intervalDays ?? intervalFor(s, category);
  return { ownerId: opts.ownerId || s.defaultOwnerId, reviewIntervalDays: opts.intervalDays, reviewDue: addDays(todayKey(opts.now), days) };
}
