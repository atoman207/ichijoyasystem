"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, nowIso } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { canManageOpsReportSettings } from "@/lib/auth/permissions";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { storeOfLabel } from "@/lib/survey-workbook/tabs";
import { PROMO_GBP_SETTINGS_ID, PROMO_KPI_SETTINGS_ID, parseGbpSheet, parseRules, readGbp, type GbpMetric, type GbpValues } from "@/lib/ops-reports/promo-products";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 販促と媒体の分析 → 商品の KPI の設定と、Google ビジネスプロフィールの数 (本部スタッフ・管理者)。
 * 集計は src/lib/ops-reports/promo-products.ts
 */

const BACK = "/promotions?tab=products";

const words = (text: string) => text.normalize("NFKC").split(/[,、\n]+/).map((x) => x.trim()).filter(Boolean);

/** 種類のキーワード・付属の言葉・リフォームの下限・年度の開始月 */
export async function savePromoKpiSettings(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageOpsReportSettings(user)) fail(back, "商品の KPI の設定は本部スタッフ・管理者が行えます。");
  const omote = parseRules(str(formData, "omote"));
  if ("error" in omote) fail(back, `畳表の種類: ${omote.error}`);
  const fusuma = parseRules(str(formData, "fusuma"));
  if ("error" in fusuma) fail(back, `襖紙の種類: ${fusuma.error}`);
  const fy = Number(str(formData, "fyStartMonth"));
  if (!Number.isInteger(fy) || fy < 1 || fy > 12) fail(back, "年度の開始月は 1〜12 で入力してください。");
  const min = Number(str(formData, "reformMin").normalize("NFKC").replace(/[,円\s]/g, ""));
  if (!Number.isFinite(min) || min < 0) fail(back, "リフォームの金額の下限を正しく入力してください。");
  const accessory = words(str(formData, "accessory"));
  const heriNashi = words(str(formData, "heriNashi"));
  const mite = words(str(formData, "mite"));
  const domestic = words(str(formData, "domestic"));
  if (!mite.length) fail(back, "防虫加工の言葉を 1 つ以上入力してください。");
  await mutate((db) => {
    const value = { fyStartMonth: fy, omote, fusuma, accessory, heriNashi, mite, reformMin: Math.round(min), domestic };
    const row = db.settings.find((s) => s.id === PROMO_KPI_SETTINGS_ID);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: nowIso() });
    else db.settings.push({ id: PROMO_KPI_SETTINGS_ID, value, updatedBy: user.id, updatedAt: nowIso() });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: PROMO_KPI_SETTINGS_ID, entityLabel: "商品の KPI", summary: `商品の KPI の設定を更新 (畳表 ${(omote as unknown[]).length} 種類・襖紙 ${(fusuma as unknown[]).length} 種類)` });
  });
  revalidatePath("/promotions");
  redirect(withMsg(back, "商品の KPI の設定を保存しました。"));
}

/** 既定に戻す */
export async function resetPromoKpiSettings(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageOpsReportSettings(user)) fail(back, "商品の KPI の設定は本部スタッフ・管理者が行えます。");
  await mutate((db) => {
    const i = db.settings.findIndex((s) => s.id === PROMO_KPI_SETTINGS_ID);
    if (i >= 0) db.settings.splice(i, 1);
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: PROMO_KPI_SETTINGS_ID, entityLabel: "商品の KPI", summary: "商品の KPI の設定を既定に戻した" });
  });
  revalidatePath("/promotions");
  redirect(withMsg(back, "商品の KPI の設定を既定に戻しました。"));
}

function writeGbp(db: Parameters<Parameters<typeof mutate>[0]>[0], months: Record<string, GbpValues>, by: string) {
  const row = db.settings.find((s) => s.id === PROMO_GBP_SETTINGS_ID);
  const value = { months };
  if (row) Object.assign(row, { value, updatedBy: by, updatedAt: nowIso() });
  else db.settings.push({ id: PROMO_GBP_SETTINGS_ID, value, updatedBy: by, updatedAt: nowIso() });
}

/** スプレッドシート「販促」の「グーグルアクセス」のタブ (CSV) を取り込む (ファイルにある店舗・月の値だけを書き換える) */
export async function importGbpSheet(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageOpsReportSettings(user)) fail(back, "Google ビジネスプロフィールの取込は本部スタッフ・管理者が行えます。");
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "グーグルアクセスのタブの CSV を選んでください。");
  if ((file as File).size > 2 * 1024 * 1024) fail(back, "ファイルが大きすぎます (2 MB まで)。");
  const { text } = decodeCsv(new Uint8Array(await (file as File).arrayBuffer()));
  let parsed: ReturnType<typeof parseGbpSheet> | undefined;
  await mutate((db) => {
    const storeOf = (label: string): StoreId | undefined => {
      if (/^(SR|ショールーム)/i.test(label)) return db.stores.find((s) => s.kind === "hq")?.id;
      const s = storeOfLabel(label);
      return s && s !== "office" ? s : undefined;
    };
    parsed = parseGbpSheet(parseCsv(text), storeOf);
    if (!parsed.values.length) fail(back, parsed.problems.join(" / "));
    const months = readGbp(db);
    for (const v of parsed.values) {
      const k = `${v.storeId}|${v.month}`;
      months[k] = { ...(months[k] ?? {}), [v.metric]: v.value };
    }
    writeGbp(db, months, user.id);
    const ym = [...new Set(parsed.values.map((v) => v.month))].sort();
    addAudit(db, { userId: user.id, action: "import", entity: "settings", entityId: PROMO_GBP_SETTINGS_ID, entityLabel: "Google ビジネスプロフィール", summary: `Google ビジネスプロフィールの数を取込 (${parsed.values.length} 件・${ym[0]}〜${ym[ym.length - 1]})` });
  });
  revalidatePath("/promotions");
  redirect(withMsg(back, `Google ビジネスプロフィールの数を ${parsed!.values.length} 件取り込みました。${parsed!.problems.length ? ` 注意: ${parsed!.problems.slice(0, 3).join(" / ")}` : ""}`));
}

/** 1 か月分の手入力 (店舗ごとの 通話・ウェブサイト・プロフィール閲覧。空欄は消す) */
export async function saveGbpMonth(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canManageOpsReportSettings(user)) fail(back, "Google ビジネスプロフィールの入力は本部スタッフ・管理者が行えます。");
  const month = str(formData, "month");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(back, "月を選んでください。");
  await mutate((db) => {
    const months = readGbp(db);
    let n = 0;
    for (const st of db.stores) {
      const k = `${st.id}|${month}`;
      const e: GbpValues = {};
      for (const m of ["calls", "web", "views"] as GbpMetric[]) {
        const raw = str(formData, `${m}_${st.id}`).normalize("NFKC").replace(/[,\s]/g, "");
        if (!raw) continue;
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 0) fail(back, `${st.name} の値「${raw}」は 0 以上の整数で入力してください。`);
        e[m] = v;
      }
      if (Object.keys(e).length) {
        months[k] = e;
        n++;
      } else delete months[k];
    }
    writeGbp(db, months, user.id);
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: PROMO_GBP_SETTINGS_ID, entityLabel: "Google ビジネスプロフィール", summary: `Google ビジネスプロフィールの ${month} を保存 (${n} 店舗)` });
  });
  revalidatePath("/promotions");
  redirect(withMsg(back, `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月の Google ビジネスプロフィールの数を保存しました。`));
}
