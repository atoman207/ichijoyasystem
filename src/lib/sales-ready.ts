import type { Order, OrderPosting, OrderWorkStaff } from "@/lib/db/types";
import { WORK_ROLES, WORK_ROLE_LABEL, type WorkRole } from "@/lib/work-staff";

/**
 * 売上登録 (施工完了・請求書の発行) の前に決めること (お客様のご要望 2026-11-27「■3 売上登録時の担当者・ポスティング枚数の登録」)
 * ------------------------------------------------------------
 * - 作業の担当 (現地見積・引取・納品・施工): 作業ごとに担当者 (複数可) か「なし」を決めて確定する (インセンティブの集計の元)
 * - ポスティング: 誰が何枚配ったか (複数人はそれぞれの枚数)、配っていなければ「配れてない」
 * どちらかが未入力なら、施工完了・請求書の発行 (受注の画面・予定表の小さな画面・帳票をまとめて印刷) を断る。
 * 登録した担当者・枚数は作業日報 (src/lib/ops-reports/work-report.ts) に出す。
 * 画面・サーバー・テストから読むため、サーバー専用の import をしない
 */

/** 作業ごとに担当者か「なし」を決めて確定したか。以前の確定 (「なし」の項目がない保存) は確定とみなす */
export function staffDecided(ws: OrderWorkStaff | undefined): boolean {
  if (!ws?.confirmedAt) return false;
  if (!ws.none) return true;
  return WORK_ROLES.every((r) => ws[r].length > 0 || ws.none!.includes(r));
}

/** 担当が決まっていない作業 */
export function undecidedRoles(ws: Pick<OrderWorkStaff, WorkRole | "none">): WorkRole[] {
  return WORK_ROLES.filter((r) => !ws[r].length && !(ws.none ?? []).includes(r));
}

export function postingDecided(p: OrderPosting | undefined): boolean {
  if (!p) return false;
  return p.status === "none" || p.entries.some((e) => e.count > 0);
}

export interface SalesReadiness {
  ok: boolean;
  staff: boolean;
  posting: boolean;
  /** 断るときの文 */
  reason?: string;
}

export function salesReadiness(o: Pick<Order, "workStaff" | "posting">): SalesReadiness {
  const staff = staffDecided(o.workStaff);
  const posting = postingDecided(o.posting);
  const missing = [!staff ? "作業の担当 (現地見積・引取・納品・施工。いなければ「なし」)" : "", !posting ? "ポスティングの枚数 (配っていなければ「配れてない」)" : ""].filter(Boolean);
  return { ok: staff && posting, staff, posting, reason: missing.length ? `${missing.join("と")}を登録してください (受注の画面の「作業の担当・ポスティング」)。売上登録・請求書の発行の前に必要です` : undefined };
}

/** 作業日報・画面の表示 (「田中 50枚・鈴木 30枚」/「配れてない」) */
export function postingLabel(p: OrderPosting | undefined, name: (id: string) => string): string {
  if (!p) return "未登録";
  if (p.status === "none") return "配れてない";
  const total = p.entries.reduce((a, e) => a + e.count, 0);
  return `${p.entries.map((e) => `${name(e.userId)} ${e.count.toLocaleString("ja-JP")}枚`).join("・")} (計 ${total.toLocaleString("ja-JP")}枚)`;
}

/**
 * フォームの値 → ポスティング。postingSent = 1 のときだけ読む (なければ undefined = 変えない)。
 * posting.status = done | none、posting.user・posting.count (同じ並び。複数人)、posting.date、posting.area
 */
export function postingFromForm(fd: FormData, activeIds: Set<string>, by: string, now: string): { posting?: OrderPosting; error?: string } {
  if (fd.get("postingSent") !== "1") return {};
  const status = String(fd.get("posting.status") ?? "");
  const date = String(fd.get("posting.date") ?? "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "ポスティングの日付を正しく入力してください。" };
  const area = String(fd.get("posting.area") ?? "").trim().slice(0, 80) || undefined;
  if (status === "none") return { posting: { status: "none", entries: [], date: date || undefined, area, updatedAt: now, updatedBy: by } };
  if (status !== "done") return { error: "ポスティングの枚数を入力するか「配れてない」を選んでください。" };
  const users = fd.getAll("posting.user").map(String);
  const counts = fd.getAll("posting.count").map(String);
  const sums = new Map<string, number>();
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const raw = (counts[i] ?? "").replace(/[,，枚\s]/g, "");
    if (!u && !raw) continue;
    if (!u || !activeIds.has(u)) return { error: "ポスティングで配った人を選んでください。" };
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n <= 0 || n > 100_000) return { error: "ポスティングの枚数を 1 以上の整数で入力してください。" };
    sums.set(u, (sums.get(u) ?? 0) + n);
  }
  if (!sums.size) return { error: "ポスティングで配った人と枚数を入力するか「配れてない」を選んでください。" };
  return { posting: { status: "done", entries: [...sums].map(([userId, count]) => ({ userId, count })), date: date || undefined, area, updatedAt: now, updatedBy: by } };
}

/** 作業の担当の「なし」(workStaff.<役割>.none = 1) */
export function workStaffNoneFromForm(fd: FormData): WorkRole[] {
  return WORK_ROLES.filter((r) => fd.get(`workStaff.${r}.none`) === "1");
}

export const roleLabels = (roles: WorkRole[]) => roles.map((r) => WORK_ROLE_LABEL[r]).join("・");
