import { BACKEND, getDb, mutate, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { putObject, readObject, removeObjects } from "@/lib/storage";
import { toDateKey } from "@/lib/format";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { applyWorkbook, workbookSettings, writeWorkbookSettings } from "./plan";
import { tabsFromGoogle } from "./read";
import type { WorkbookTab } from "./tabs";

/**
 * 取込の「確認」の内容 (読み取ったタブ) をサーバーのディスクに一時保存する (storage.ts の imports/。3000 番と 3001 番で共有)。
 * 「この内容で取り込む」は同じ印 (hash) の内容だけを取り込む。取り込んだら消す
 */

export interface WorkbookPreview {
  tabs: WorkbookTab[];
  label: string;
  problems: string[];
  by: string;
  at: string;
}

const key = (hash: string) => `imports/survey-workbook/${hash}.json`;
export const PREVIEW_HASH_RE = /^[0-9a-f]{24}$/;

export async function savePreview(hash: string, p: WorkbookPreview): Promise<void> {
  await putObject(key(hash), Buffer.from(JSON.stringify(p)));
}

export async function readPreview(hash: string): Promise<WorkbookPreview | null> {
  if (!PREVIEW_HASH_RE.test(hash)) return null;
  const buf = await readObject(key(hash)).catch(() => null);
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString("utf8")) as WorkbookPreview;
    return Array.isArray(v.tabs) ? v : null;
  } catch {
    return null;
  }
}

export async function removePreview(hash: string): Promise<void> {
  if (PREVIEW_HASH_RE.test(hash)) await removeObjects([key(hash)]).catch(() => undefined);
}

/** 取込に使う表 (クレーム・手直しの新しい列とアンケートの過去の集計の表) がまだないか (npm run db:migrate の前) */
export async function workbookTablesMissing(): Promise<boolean> {
  if (BACKEND !== "supabase" || !missingTables().includes("survey_history")) return false;
  return (await recheckMissingTables()).includes("survey_history");
}

/**
 * 定期の同期 (/api/cron/survey-workbook。毎日)。設定で「定期の同期」をオンにしたときだけ、
 * Google スプレッドシートを読んで取り込む (一方向。シートから消えた行は消さない)。結果は設定の lastSync に残す
 */
export async function runWorkbookSync(userId = SYSTEM_USER): Promise<{ ok: boolean; skipped?: boolean; message: string }> {
  const s = workbookSettings(getDb());
  if (!s.autoSync) return { ok: true, skipped: true, message: "定期の同期はオフです" };
  const record = async (ok: boolean, message: string) => {
    await mutate((db) => {
      const st = workbookSettings(db);
      st.lastSync = { at: nowIso(), ok, message: message.slice(0, 500) };
      writeWorkbookSettings(db, st, userId);
    });
    return { ok, message };
  };
  if (!s.sheetUrl && !s.tabUrls.length) return record(false, "スプレッドシートの URL が設定されていません");
  if (await workbookTablesMissing()) return record(false, "データベースに取込の表がまだありません (npm run db:migrate)");
  try {
    const { tabs, problems, label } = await tabsFromGoogle(s.sheetUrl, s.tabUrls);
    if (!tabs.length) return record(false, problems.join(" / ") || "読み取れるタブがありません");
    let summary = "";
    await mutate((db) => {
      const r = applyWorkbook(db, tabs, { today: toDateKey(new Date()), userId, label: `${label} (定期の同期)` });
      summary = r.summary;
      const st = workbookSettings(db);
      st.lastSync = { at: nowIso(), ok: true, message: `${summary}${problems.length ? ` / 注意: ${problems.join(" / ")}` : ""}`.slice(0, 500) };
      writeWorkbookSettings(db, st, userId);
    });
    return { ok: true, message: summary };
  } catch (e) {
    return record(false, (e as Error).message);
  }
}
