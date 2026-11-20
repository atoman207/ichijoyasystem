"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, nowIso } from "@/lib/db/store";
import type { StoreId, WorkReportDay } from "@/lib/db/types";
import { canEditWorkReport, canManageOpsReportSettings } from "@/lib/auth/permissions";
import { dateRange, monthEnd } from "@/lib/calendar";
import { DEFAULT_FACTORS, WORK_REPORT_SETTINGS_ID, cleanDayInput, isMonthKey, readWorkReportSettings, workReportDayId, type DayInput } from "@/lib/ops-reports/work-report";
import { opsTablesMissing } from "@/lib/ops-reports/tables";
import { assertStore, fail, requireActionUser, str, withMsg } from "./guards";

const pagePath = (storeId: string, month: string, tab?: string) => `/work-reports?store=${encodeURIComponent(storeId)}&month=${encodeURIComponent(month)}${tab ? `&tab=${tab}` : ""}`;

/**
 * 作業日報の手入力 (1 か月分をまとめて保存): 来店数・チラシの配布 (配布人・枚数・地域)・メモ。
 * 画面に出した日 (v_<日付> がある日) だけを読み、空にした日は行を消す。変わった日ごとに変更履歴を残す
 */
export async function saveWorkReportMonth(formData: FormData) {
  const user = await requireActionUser();
  const storeId = str(formData, "storeId") as StoreId;
  const month = str(formData, "month");
  const back = pagePath(storeId, month, "input");
  if (!isMonthKey(month)) fail("/work-reports", "月の指定が正しくありません。");
  if (!getDb().stores.some((s) => s.id === storeId)) fail("/work-reports", "店舗の指定が正しくありません。");
  assertStore(user, storeId, back);
  if (!canEditWorkReport(user, storeId)) fail(back, "この店舗の作業日報を入力する権限がありません。");
  const missing = await opsTablesMissing(["work_report_days"]);
  if (missing) fail(back, missing);

  const users = getDb().users.map((u) => ({ id: u.id, name: u.name, active: u.active }));
  const inputs: DayInput[] = [];
  for (const date of dateRange(`${month}-01`, monthEnd(`${month}-01`))) {
    if (!formData.has(`v_${date}`)) continue;
    const lines = Math.min(30, Math.max(0, Number(str(formData, `fn_${date}`)) || 0));
    const flyers = Array.from({ length: lines }, (_, i) => ({ distributor: str(formData, `f_${date}_${i}_by`), copies: str(formData, `f_${date}_${i}_copies`), area: str(formData, `f_${date}_${i}_area`) }));
    const r = cleanDayInput(month, { date, visitors: str(formData, `v_${date}`), note: str(formData, `n_${date}`), flyers }, users);
    if (!r) continue;
    if ("error" in r) fail(back, r.error);
    inputs.push(r);
  }
  const storeName = getDb().stores.find((s) => s.id === storeId)?.name ?? storeId;

  const changed = await mutate((db) => {
    const now = nowIso();
    let n = 0;
    for (const inp of inputs) {
      const id = workReportDayId(storeId, inp.date);
      const cur = db.workReportDays.find((w) => w.id === id);
      const empty = inp.visitors === undefined && inp.flyers.length === 0 && !inp.note;
      const label = `${storeName} ${inp.date.replaceAll("-", "/")} の作業日報`;
      if (!cur) {
        if (empty) continue;
        const row: WorkReportDay = { id, storeId, date: inp.date, flyers: inp.flyers, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now };
        if (inp.visitors !== undefined) row.visitors = inp.visitors;
        if (inp.note) row.note = inp.note;
        db.workReportDays.push(row);
        addAudit(db, { userId: user.id, action: "create", entity: "work_report", entityId: id, entityLabel: label, summary: `作業日報の手入力を登録 (${label})`, storeId, changes: diffChanges({ visitors: undefined, flyers: [], note: undefined } as Pick<WorkReportDay, "visitors" | "flyers" | "note">, row, ["visitors", "flyers", "note"]) });
        n++;
        continue;
      }
      const before: Pick<WorkReportDay, "visitors" | "flyers" | "note"> = { visitors: cur.visitors, flyers: cur.flyers, note: cur.note };
      if (empty) {
        db.workReportDays = db.workReportDays.filter((w) => w.id !== id);
        addAudit(db, { userId: user.id, action: "delete", entity: "work_report", entityId: id, entityLabel: label, summary: `作業日報の手入力を削除 (${label})`, storeId, changes: diffChanges(before, { visitors: undefined, flyers: [], note: undefined }, ["visitors", "flyers", "note"]) });
        n++;
        continue;
      }
      const after: Pick<WorkReportDay, "visitors" | "flyers" | "note"> = { visitors: inp.visitors, flyers: inp.flyers, note: inp.note };
      const changes = diffChanges(before, after, ["visitors", "flyers", "note"]);
      if (!changes.length) continue;
      cur.flyers = inp.flyers;
      if (inp.visitors !== undefined) cur.visitors = inp.visitors;
      else delete cur.visitors;
      if (inp.note) cur.note = inp.note;
      else delete cur.note;
      cur.updatedBy = user.id;
      cur.updatedAt = now;
      addAudit(db, { userId: user.id, action: "update", entity: "work_report", entityId: id, entityLabel: label, summary: `作業日報の手入力を更新 (${label}: ${changes.map((c) => ({ visitors: "来店数", flyers: "チラシの配布", note: "メモ" })[c.field] ?? c.field).join("・")})`, storeId, changes });
      n++;
    }
    return n;
  });
  revalidatePath("/work-reports");
  revalidatePath("/promotions");
  redirect(withMsg(back, changed ? `${changed} 日分の手入力を保存しました。販促と媒体の分析にも反映されます。` : "変更はありませんでした。"));
}

/** 作業日報の係数 (襖類の係数後: 襖・障子・網戸) の変更 (本部スタッフ・管理者) */
export async function saveWorkReportSettings(formData: FormData) {
  const user = await requireActionUser();
  const storeId = str(formData, "storeId");
  const month = str(formData, "month");
  const back = pagePath(storeId || user.storeId, isMonthKey(month) ? month : "", "settings");
  if (!canManageOpsReportSettings(user)) fail(back, "係数を変更できるのは本部スタッフ・管理者です。");
  const reset = str(formData, "reset") === "1";
  const read = (key: keyof typeof DEFAULT_FACTORS): number => {
    const v = str(formData, key).normalize("NFKC");
    const n = Number(v);
    if (!v || !Number.isFinite(n) || n < 0 || n > 10) fail(back, "係数は 0〜10 の数で入力してください (例: 0.5)。");
    return Math.round(n * 100) / 100;
  };
  const factors = reset ? { ...DEFAULT_FACTORS } : { fusuma: read("fusuma"), shoji: read("shoji"), amido: read("amido") };
  await mutate((db) => {
    const before = readWorkReportSettings(db).factors;
    const changes = diffChanges(before as unknown as Record<string, unknown>, factors as unknown as Record<string, unknown>, ["fusuma", "shoji", "amido"]).map((c) => ({ ...c, field: `係数 (${{ fusuma: "襖", shoji: "障子", amido: "網戸" }[c.field as "fusuma" | "shoji" | "amido"]})` }));
    const now = nowIso();
    const cur = db.settings.find((s) => s.id === WORK_REPORT_SETTINGS_ID);
    if (cur) {
      cur.value = { ...cur.value, factors };
      cur.updatedBy = user.id;
      cur.updatedAt = now;
    } else db.settings.push({ id: WORK_REPORT_SETTINGS_ID, value: { factors }, updatedBy: user.id, updatedAt: now });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: WORK_REPORT_SETTINGS_ID, entityLabel: "作業日報の係数", summary: reset ? "作業日報の係数を既定値 (障子 0.5・網戸 0.4) に戻しました" : `作業日報の係数を変更 (襖 ${factors.fusuma}・障子 ${factors.shoji}・網戸 ${factors.amido})`, changes });
  });
  revalidatePath("/work-reports");
  redirect(withMsg(back, "係数を保存しました。"));
}
