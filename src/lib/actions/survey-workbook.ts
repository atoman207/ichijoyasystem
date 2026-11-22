"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, nowIso } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { parseSheetLink } from "@/lib/data-io";
import { toDateKey } from "@/lib/format";
import { MAX_WORKBOOK_BYTES, tabsFromFiles, tabsFromGoogle } from "@/lib/survey-workbook/read";
import { WORKBOOK_NAME, WORKBOOK_SETTINGS_ID, applyWorkbook, tabsHash, workbookSettings, writeWorkbookSettings } from "@/lib/survey-workbook/plan";
import { readPreview, removePreview, savePreview, workbookTablesMissing } from "@/lib/survey-workbook/preview";
import { formatAliasLines, parseAliasLines } from "@/lib/survey-workbook/staff";
import type { WorkbookTab } from "@/lib/survey-workbook/tabs";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * KPI → スプレッドシートの取込 (お客様アンケート集計表)
 * 「確認する」= 読み取って計画を見せる (書き込まない) →「この内容で取り込む」= 同じ内容を書き込む。本部スタッフ・管理者 (canImportData)
 */

const BACK = "/kpi/import";

async function start() {
  const user = await requireActionUser();
  if (!canImportData(user)) fail("/kpi", "スプレッドシートの取込は本部スタッフ・管理者が行えます。");
  return user;
}

export async function previewSurveyWorkbook(fd: FormData) {
  const user = await start();
  let tabs: WorkbookTab[] = [];
  let problems: string[] = [];
  let label = "";
  if (str(fd, "source") === "google") {
    const s = workbookSettings(getDb());
    try {
      const r = await tabsFromGoogle(s.sheetUrl, s.tabUrls);
      ({ tabs, problems, label } = r);
    } catch (e) {
      fail(BACK, `スプレッドシートを読めませんでした: ${(e as Error).message}`);
    }
  } else {
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) fail(BACK, "CSV か .xlsx のファイルを選んでください (タブごとの CSV は複数まとめて選べます)。");
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > MAX_WORKBOOK_BYTES) fail(BACK, "ファイルが大きすぎます (合計 10 MB まで)。");
    const r = tabsFromFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    tabs = r.tabs;
    problems = r.problems;
    label = files.length === 1 ? files[0].name.slice(0, 80) : `${files.length} ファイル (${files[0].name.slice(0, 40)} ほか)`;
  }
  if (!tabs.length) fail(BACK, problems.join(" / ") || "読み取れるタブがありません。");
  const hash = tabsHash(tabs);
  await savePreview(hash, { tabs, label, problems, by: user.id, at: nowIso() });
  let old: string | undefined;
  await mutate((db) => {
    const s = workbookSettings(db);
    if (s.preview && s.preview.hash !== hash) old = s.preview.hash;
    s.preview = { hash, at: nowIso(), by: user.id, label };
    writeWorkbookSettings(db, s, user.id);
  });
  if (old) await removePreview(old);
  redirect(`${BACK}?preview=${hash}`);
}

export async function applySurveyWorkbook(fd: FormData) {
  const user = await start();
  const hash = str(fd, "hash");
  const back = `${BACK}?preview=${hash}`;
  if (await workbookTablesMissing()) fail(back, "データベースに取込の表 (アンケートの過去の集計・クレーム・手直しの新しい列) がまだありません。開発担当が npm run db:migrate を実行すると取り込めます。");
  const p = await readPreview(hash);
  if (!p) fail(BACK, "確認した内容が見つかりません。もう一度「確認する」を押してください。");
  const y = str(fd, "startYear");
  const startYear = /^20\d\d$/.test(y) ? Number(y) : undefined;
  let summary = "";
  await mutate((db) => {
    const r = applyWorkbook(db, p.tabs, { today: toDateKey(new Date()), startYear, userId: user.id, label: p.label });
    summary = r.summary;
    if (startYear) {
      const s = workbookSettings(db);
      s.startYear = startYear;
      writeWorkbookSettings(db, s, user.id);
    }
  });
  await removePreview(hash);
  revalidatePath("/kpi");
  revalidatePath("/kpi/quality");
  revalidatePath("/kpi/reviews");
  revalidatePath("/kpi/surveys");
  redirect(withMsg(BACK, `取り込みました: ${summary}`));
}

export async function discardSurveyWorkbookPreview(fd: FormData) {
  const user = await start();
  const hash = str(fd, "hash");
  await removePreview(hash);
  await mutate((db) => {
    const s = workbookSettings(db);
    if (s.preview?.hash === hash) {
      s.preview = undefined;
      writeWorkbookSettings(db, s, user.id);
    }
  });
  redirect(withMsg(BACK, "確認の内容を破棄しました (何も取り込んでいません)。"));
}

/** つなぎ方の設定 (スプレッドシートの URL・タブごとの共有リンク・定期の同期・口コミの最初の年・担当者の名前の対応) */
export async function saveSurveyWorkbookSettings(fd: FormData) {
  const user = await start();
  const back = safeBack(str(fd, "returnTo"));
  const sheetUrl = str(fd, "sheetUrl");
  if (sheetUrl && !parseSheetLink(sheetUrl)) fail(back, "スプレッドシートの URL は https://docs.google.com/spreadsheets/d/… の形で入れてください。");
  const tabUrls = str(fd, "tabUrls").split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const bad = tabUrls.find((u) => !parseSheetLink(u));
  if (bad) fail(back, `タブの共有リンクではありません: ${bad.slice(0, 60)}`);
  const y = str(fd, "startYear");
  if (y && !/^20\d\d$/.test(y)) fail(back, "口コミの最初の行の年は 4 桁の西暦で入れてください (空欄 = 自動)。");
  const db0 = getDb();
  const { aliases, errors } = parseAliasLines(str(fd, "aliases"), db0.users);
  if (errors.length) fail(back, errors.slice(0, 3).join(" / "));
  await mutate((db) => {
    const s = workbookSettings(db);
    const before = { sheetUrl: s.sheetUrl ?? "", tabUrls: s.tabUrls.length, autoSync: s.autoSync, startYear: s.startYear ?? "", aliases: formatAliasLines(s.staffAliases, db.users) };
    s.sheetUrl = sheetUrl || undefined;
    s.tabUrls = tabUrls;
    s.autoSync = fd.get("autoSync") === "on";
    s.startYear = y ? Number(y) : undefined;
    s.staffAliases = aliases;
    const after = { sheetUrl: s.sheetUrl ?? "", tabUrls: s.tabUrls.length, autoSync: s.autoSync, startYear: s.startYear ?? "", aliases: formatAliasLines(s.staffAliases, db.users) };
    const changes = (Object.keys(after) as (keyof typeof after)[]).filter((k) => String(before[k]) !== String(after[k])).map((k) => ({ field: k, before: String(before[k]), after: String(after[k]) }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    writeWorkbookSettings(db, s, user.id);
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: WORKBOOK_SETTINGS_ID, entityLabel: `${WORKBOOK_NAME} の取込`, summary: `${WORKBOOK_NAME} の取込の設定を変更 (${changes.map((c) => c.field).join("・")})`, storeId: "hq", changes });
  });
  revalidatePath(BACK);
  redirect(withMsg(back, "設定を保存しました。"));
}

function safeBack(v: string): string {
  return v.startsWith(BACK) ? v : BACK;
}
