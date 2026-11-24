import "server-only";
import { getDb, mutate, newId, syncDb } from "@/lib/db/store";
import type { User } from "@/lib/db/types";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { taskNotices } from "@/lib/notify/events";
import { sendAndRecord, type Outgoing } from "@/lib/notify/send";
import { storeRequestNotices } from "@/lib/notify/store-line";
import { REQUEST_PURPOSE, dueFollowups, dueLabel, jstDate } from "@/lib/inquiry-flow";

/**
 * 期限を過ぎた問い合わせの依頼の自動の再通知 (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー ②」)
 * ------------------------------------------------------------
 * - 1 回目 (期限を過ぎたとき): 依頼先 (担当者・店舗のメンバー) にメンションし、メール等・店舗の LINE グループでも知らせる
 * - 2 回目 (その 3 時間後): 依頼先に加えて、その店舗の店長と依頼した人にも。そのあとは問い合わせ一覧の「期限超過」で見る
 * - 日程未定の次回の連絡予定日: 当日の朝に担当者へ
 * 送るのは日本時間 8〜20 時 (src/lib/inquiry-flow.ts の dueFollowups)。
 * 動かすきっかけ: 画面を開いている社員のブラウザーが 1 分ごとに読む /api/notifications/summary (5 分に 1 回まで) と、
 * 定期実行の /api/cron/inquiry-followup (deploy/run-task.sh inquiry-followup)。どちらも同じ処理で、送ったら記録 (remindedAt・remindCount) するので二重に送らない
 */

const THROTTLE_MS = 5 * 60_000;
const g = globalThis as unknown as { __inquiryFollowup?: { last: number; running: boolean } };
const state = (g.__inquiryFollowup ??= { last: 0, running: false });

export interface FollowupResult {
  sent: number;
  threads: string[];
  holds: string[];
}

export async function runInquiryFollowups(now = new Date()): Promise<FollowupResult> {
  const db0 = await syncDb();
  if (!dueFollowups(db0, now).length) return { sent: 0, threads: [], holds: [] };
  const outgoing: Outgoing[] = [];
  const result: FollowupResult = { sent: 0, threads: [], holds: [] };
  await mutate((db) => {
    const list = dueFollowups(db, now);
    const at = now.toISOString();
    for (const f of list) {
      const inq = f.inquiry;
      if (f.kind === "request" && f.thread) {
        const t = db.threads.find((x) => x.id === f.thread!.id);
        if (!t) continue;
        const store = db.stores.find((s) => s.id === (t.storeId ?? inq.storeId));
        // 2 回目は店長と依頼した人にも
        const extra: User[] = f.round >= 2 ? db.users.filter((u) => u.active && (u.id === t.createdBy || (store?.managerUserId && u.id === store.managerUserId))) : [];
        const mentions = [...new Set([...(t.assigneeIds ?? []), ...extra.map((u) => u.id)])].filter((id) => id !== SYSTEM_USER);
        const due = t.dueAt ? dueLabel(t.dueAt, now) : "";
        const purpose = REQUEST_PURPOSE[t.purpose ?? "schedule"].label;
        const body = `【自動の再通知${f.round >= 2 ? " (2 回目・店長と依頼者にも)" : ""}】期限 (${due}) を過ぎました。「${purpose}」の対応をお願いします。${(t.purpose ?? "schedule") === "schedule" ? "日程が決まったら問い合わせの画面の「日程を登録」で、すぐに決まらないときは「日程未定」で残してください。" : "対応したら「報告」で結果を書いてください。"}`;
        db.messages.push({ id: newId("msg"), threadId: t.id, userId: SYSTEM_USER, body, at, mentions });
        t.remindedAt = at;
        t.remindCount = (t.remindCount ?? 0) + 1;
        t.updatedAt = at;
        result.threads.push(t.id);
        outgoing.push(...taskNotices(db, t, SYSTEM_USER, "remind", body, extra));
        outgoing.push(...storeRequestNotices(db, inq, { storeId: t.storeId ?? inq.storeId, what: "remind", purpose, due }));
      } else if (f.kind === "hold" && inq.scheduleHold) {
        const target = db.inquiries.find((x) => x.id === inq.id);
        if (!target?.scheduleHold) continue;
        target.scheduleHold.remindedOn = jstDate(now);
        target.updatedAt = at;
        const to = db.users.filter((u) => u.active && u.id === target.assignedUserId);
        if (to.length) {
          // 担当者への業務依頼の形で残す (メンション。終わったら報告)
          const thread = {
            id: newId("th"),
            title: `日程の連絡日: ${target.number} ${target.contactName} 様 ${target.summary}`.slice(0, 120),
            kind: "request" as const,
            storeId: target.storeId,
            createdBy: SYSTEM_USER,
            participants: to.map((u) => u.id),
            relatedType: "inquiry" as const,
            relatedId: target.id,
            relatedLabel: target.number,
            status: "open" as const,
            createdAt: at,
            updatedAt: at,
            assigneeIds: to.map((u) => u.id),
            purpose: "schedule" as const,
            dueAt: new Date(`${jstDate(now)}T23:59:00+09:00`).toISOString(),
            dueDate: jstDate(now),
            taskStatus: "requested" as const,
          };
          db.threads.push(thread);
          db.messages.push({ id: newId("msg"), threadId: thread.id, userId: SYSTEM_USER, body: `今日はお客様に日程の連絡をする日です (${target.scheduleHold.reason})。日程が決まったら問い合わせの画面の「日程を登録」で入れてください。`, at, mentions: to.map((u) => u.id) });
          outgoing.push(...taskNotices(db, thread, SYSTEM_USER, "request", "今日はお客様に日程の連絡をする日です。"));
        }
        result.holds.push(target.id);
      }
    }
  });
  result.sent = result.threads.length + result.holds.length;
  if (outgoing.length) await sendAndRecord(outgoing, SYSTEM_USER).catch((err) => console.warn("[inquiry-followup] notice failed:", (err as Error).message));
  return result;
}

/** 画面の 1 分ごとの読み込みから呼ぶ (5 分に 1 回まで・同時に 1 つ。失敗しても画面には影響させない) */
export function triggerInquiryFollowups(): void {
  const t = Date.now();
  if (state.running || t - state.last < THROTTLE_MS) return;
  state.last = t;
  state.running = true;
  runInquiryFollowups()
    .catch((err) => console.warn("[inquiry-followup] failed:", (err as Error).message))
    .finally(() => {
      state.running = false;
    });
}

/** テスト・確認用 (送らずに対象だけ) */
export function pendingFollowups(now = new Date()) {
  return dueFollowups(getDb(), now).map((f) => ({ kind: f.kind, inquiry: f.inquiry.number, thread: f.thread?.id, round: f.round }));
}
