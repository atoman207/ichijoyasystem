import "server-only";
import type { User } from "@/lib/db/types";
import { getDb, mutate, syncDb } from "@/lib/db/store";
import { MAX_ATTACHMENT_BYTES, discardStored, resolveParent, storeFile } from "@/lib/attachments";
import { findLineGroup, touchLineGroups } from "@/lib/line-groups";
import { lineConfig, lineDataBase, lineWebhookUrl } from "./config";
import { LINE_MEDIA_APP, LINE_MEDIA_SAVED, LINE_MEDIA_SAVING, SYSTEM_USER, type LineMediaJob } from "./inbound";

/**
 * LINE Messaging API の呼び出し (受信のあとの処理・接続の確認・Webhook URL の設定)
 * 送信 (プッシュメッセージ) は channels.ts の sendLine
 */

const TIMEOUT_MS = 15_000;
const SYSTEM = { id: SYSTEM_USER } as User;

async function lineFetch(path: string, init?: RequestInit & { data?: boolean }): Promise<Response | null> {
  const cfg = lineConfig();
  if (!cfg) return null;
  const base = init?.data ? lineDataBase() : cfg.base;
  return fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${cfg.token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** 写真・ファイルの本体 (LINE のサーバーに一定期間だけ残る) */
export async function downloadLineContent(messageId: string): Promise<{ bytes: Buffer; contentType: string } | { error: string }> {
  try {
    const res = await lineFetch(`/v2/bot/message/${encodeURIComponent(messageId)}/content`, { data: true });
    if (!res) return { error: "LINE_CHANNEL_ACCESS_TOKEN が未設定です" };
    if (res.status === 202) return { error: "LINE 側で準備中です" };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_ATTACHMENT_BYTES) return { error: `${(len / 1048576).toFixed(1)} MB (4 MB まで)` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) return { error: `${(bytes.length / 1048576).toFixed(1)} MB (4 MB まで)` };
    return { bytes, contentType: res.headers.get("content-type") ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "取得できませんでした" };
  }
}

/**
 * 受信した写真・資料を LINE から取得し、登録先 (受注・顧客・問い合わせ) の添付ファイルに保存する。
 * 保存できたら、やりとり履歴の本文の「保存しています」を「保存しました」に書き換える。失敗は「LINE のアプリで確認」にする
 */
export async function saveLineMedia(jobs: LineMediaJob[]): Promise<{ saved: number; failed: number }> {
  let saved = 0;
  let failed = 0;
  for (const job of jobs) {
    const got = await downloadLineContent(job.messageId);
    let ok = false;
    if (!("error" in got)) {
      await syncDb();
      const parent = resolveParent(getDb(), job.parentType, job.parentId);
      if (parent) {
        try {
          const att = await storeFile({ user: SYSTEM, parent, file: { name: job.fileName, type: got.contentType, bytes: got.bytes }, caption: job.caption });
          try {
            await mutate((db) => {
              db.attachments.push(att);
              markLog(db, job, LINE_MEDIA_SAVED);
            });
            ok = true;
          } catch (err) {
            await discardStored(att);
            throw err;
          }
        } catch (err) {
          console.warn("[line] media save failed:", job.messageId, (err as Error).message);
        }
      }
    } else {
      console.warn("[line] media download failed:", job.messageId, got.error);
    }
    if (ok) saved++;
    else {
      failed++;
      await mutate((db) => markLog(db, job, LINE_MEDIA_APP)).catch(() => undefined);
    }
  }
  return { saved, failed };
}

function markLog(db: Parameters<Parameters<typeof mutate>[0]>[0], job: LineMediaJob, mark: string) {
  if (job.logId) {
    const log = db.commLogs.find((c) => c.id === job.logId);
    if (log) log.body = log.body.replace(LINE_MEDIA_SAVING, mark);
    return;
  }
  // 問い合わせに追記した写真・資料
  if (job.parentType === "inquiry") {
    const inq = db.inquiries.find((i) => i.id === job.parentId);
    if (inq && inq.detail.includes(LINE_MEDIA_SAVING)) inq.detail = inq.detail.replace(LINE_MEDIA_SAVING, mark);
  }
}

/** グループ名を LINE から取得して一覧に入れる */
export async function fetchLineGroupNames(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      const res = await lineFetch(`/v2/bot/group/${encodeURIComponent(id)}/summary`);
      if (!res?.ok) continue;
      const j = (await res.json()) as { groupName?: string };
      if (!j.groupName) continue;
      await mutate((db) => {
        const g = findLineGroup(db, id);
        if (g && g.name !== j.groupName) {
          g.name = String(j.groupName).slice(0, 100);
          touchLineGroups(db, SYSTEM_USER);
        }
      });
    } catch (err) {
      console.warn("[line] group summary failed:", id, (err as Error).message);
    }
  }
}

/** 応答のあとの処理 (写真・資料の保存とグループ名の取得)。失敗しても受信の登録は残る */
export async function afterLineWebhook(media: LineMediaJob[], groups: string[]): Promise<void> {
  if (media.length) await saveLineMedia(media).catch((err) => console.warn("[line] media:", (err as Error).message));
  if (groups.length) await fetchLineGroupNames(groups).catch((err) => console.warn("[line] groups:", (err as Error).message));
}

/* ---------------- 接続の確認・Webhook URL の設定 ---------------- */

export interface LineCheck {
  ok: boolean;
  lines: string[];
}

async function readJson<T>(res: Response | null): Promise<T | null> {
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

/** 公式アカウント・Webhook URL・今月の送信数を確かめる */
export async function checkLine(): Promise<LineCheck> {
  if (!lineConfig()) return { ok: false, lines: ["LINE_CHANNEL_ACCESS_TOKEN が未設定です。"] };
  const lines: string[] = [];
  let ok = true;
  try {
    const infoRes = await lineFetch("/v2/bot/info");
    const info = await readJson<{ displayName?: string; basicId?: string }>(infoRes);
    if (!info) return { ok: false, lines: [`公式アカウントに接続できません (HTTP ${infoRes?.status ?? "-"})。チャネルアクセストークンを確認してください。`] };
    lines.push(`公式アカウント: ${info.displayName ?? "-"} (${info.basicId ?? "-"})`);
    const wh = await readJson<{ endpoint?: string; active?: boolean }>(await lineFetch("/v2/bot/channel/webhook/endpoint"));
    const expected = lineWebhookUrl();
    if (!wh?.endpoint) {
      ok = false;
      lines.push(`Webhook URL: 未設定 (このシステムの受信先: ${expected})`);
    } else {
      const same = wh.endpoint === expected;
      if (!same || !wh.active) ok = false;
      lines.push(`Webhook URL: ${wh.endpoint}${same ? " (このシステム)" : ` ← このシステムの受信先 ${expected} と違います`} · ${wh.active ? "利用中" : "「Webhook の利用」がオフです"}`);
    }
    const quota = await readJson<{ type?: string; value?: number }>(await lineFetch("/v2/bot/message/quota"));
    const used = await readJson<{ totalUsage?: number }>(await lineFetch("/v2/bot/message/quota/consumption"));
    if (quota) lines.push(`今月の送信: ${used?.totalUsage ?? "-"} 通${quota.type === "limited" ? ` / 上限 ${quota.value} 通` : " (上限なし)"}`);
  } catch (err) {
    return { ok: false, lines: [...lines, `確認できませんでした: ${(err as Error).message}`] };
  }
  return { ok, lines };
}

/** LINE の Webhook URL をこのシステムの受信先にして、LINE から疎通を試す */
export async function setLineWebhook(): Promise<LineCheck> {
  if (!lineConfig()) return { ok: false, lines: ["LINE_CHANNEL_ACCESS_TOKEN が未設定です。"] };
  const url = lineWebhookUrl();
  if (!url.startsWith("https://") || /localhost|127\.0\.0\.1/.test(url)) return { ok: false, lines: [`受信先 ${url} は https の公開 URL ではありません。APP_BASE_URL=https://<ドメイン> を設定して再起動してください。`] };
  try {
    const put = await lineFetch("/v2/bot/channel/webhook/endpoint", { method: "PUT", body: JSON.stringify({ endpoint: url }) });
    if (!put?.ok) return { ok: false, lines: [`Webhook URL を設定できませんでした (HTTP ${put?.status ?? "-"}): ${(await put?.text().catch(() => "")) ?? ""}`.slice(0, 300)] };
    const test = await readJson<{ success?: boolean; statusCode?: number; reason?: string; detail?: string }>(await lineFetch("/v2/bot/channel/webhook/test", { method: "POST", body: JSON.stringify({ endpoint: url }) }));
    const lines = [`Webhook URL を ${url} に設定しました。`];
    if (test?.success) lines.push("LINE からの疎通の確認: 成功");
    else lines.push(`LINE からの疎通の確認: 失敗 (${test?.statusCode ?? "-"} ${test?.reason ?? ""} ${test?.detail ?? ""})`.trim());
    lines.push("LINE Developers の「Webhook の利用」と、LINE Official Account Manager の 応答設定 → Webhook をオンにしてください (API では切り替えられません)。");
    return { ok: Boolean(test?.success), lines };
  } catch (err) {
    return { ok: false, lines: [`設定できませんでした: ${(err as Error).message}`] };
  }
}
