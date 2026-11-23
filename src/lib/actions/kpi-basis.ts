"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, mutate, nowIso } from "@/lib/db/store";
import { supabaseAdmin } from "@/lib/db/supabase";
import { canImportData, canManageSettings } from "@/lib/auth/permissions";
import type { AuditChange } from "@/lib/db/types";
import { parseCsv } from "@/lib/csv";
import { fetchSheetCsv, parseSheetLink } from "@/lib/data-io";
import { putObject, removeObjects } from "@/lib/storage";
import { MAX_REPEAT_DAYS, fiscalMonths, kpiBasis, monthKey, writeKpiBasis, type CasesSource, type KpiBasis } from "@/lib/kpi-basis";
import { MAX_BASIS_BYTES, applyBasisImport, basisHash, basisSheetsFromFiles, readBasisSheets, type BasisPreview } from "@/lib/kpi-basis-import";
import { basisPreviewKey, readBasisPreview, saveKpiSheet } from "@/lib/kpi-check";
import { tabsFromFiles } from "@/lib/survey-workbook/read";
import { detectTab } from "@/lib/survey-workbook/tabs";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * KPI → 分母・照合 (src/lib/kpi-basis.ts)
 * - 数え方の設定 (分母の基準・平均・担当者名の未記入・個人件数の決め方・リピートの日数・全案件数の数え方): 管理者 (canManageSettings)
 * - 店舗 × 月の個人件数・全案件数の手入力、年間チラシ計画・アンケートはがきの取込 (確認 → 取り込む)、照合の KPI のタブの読み込み: 本部スタッフ・管理者 (canImportData)
 */

const BACK = "/kpi/basis";
const PREVIEW_RE = /^[0-9a-f]{24}$/;
const previewKey = basisPreviewKey;

async function start(back = BACK) {
  const user = await requireActionUser();
  if (!canImportData(user)) fail("/kpi", "KPI の分母の登録・取込は本部スタッフ・管理者が行えます。");
  return { user, back };
}

/** 数え方の設定 (管理者) */
export async function saveKpiBasisRules(fd: FormData) {
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(BACK, "数え方の設定は管理者のみ変更できます。");
  const repeatRaw = str(fd, "repeatDays").normalize("NFKC").replace(/[日\s]/g, "");
  if (!/^\d{1,3}$/.test(repeatRaw) || Number(repeatRaw) > MAX_REPEAT_DAYS) fail(BACK, `リピートをまとめる日数は 0〜${MAX_REPEAT_DAYS} の整数で入力してください (0 = まとめない)。`);
  const cases = str(fd, "casesSource");
  const next = {
    denominator: str(fd, "denominator") === "system" ? ("system" as const) : ("sheet" as const),
    average: str(fd, "average") === "answered" ? ("answered" as const) : ("sheet" as const),
    requireStaffNames: fd.get("requireStaffNames") === "on",
    individualSource: str(fd, "individualSource") === "auto" ? ("auto" as const) : ("plan" as const),
    repeatDays: Number(repeatRaw),
    casesSource: (cases === "deliveries" || cases === "system" ? cases : "cases") as CasesSource,
  };
  await mutate((db) => {
    const cur = kpiBasis(db);
    const changes: AuditChange[] = (Object.keys(next) as (keyof typeof next)[]).filter((k) => cur[k] !== next[k]).map((k) => ({ field: k, before: cur[k], after: next[k] }));
    if (!changes.length) fail(BACK, "変更はありませんでした。");
    writeKpiBasis(db, { ...cur, ...next }, user.id, nowIso());
    addAudit(db, { userId: user.id, action: "update", entity: "kpi_basis", entityId: "kpi_basis", entityLabel: "KPI の分母・数え方", summary: `KPI の数え方を変更 (${changes.map((c) => c.field).join("・")})`, storeId: "hq", changes });
  });
  revalidatePath("/kpi", "layout");
  redirect(withMsg(BACK, "数え方の設定を保存しました。KPI・インセンティブの集計に反映されています。"));
}

/** 店舗 × 月の個人件数・全案件数 (手入力)。空欄 = 値を消す (自動の値・年間チラシ計画の取込の値に戻る) */
export async function saveKpiMonthValues(fd: FormData) {
  const { user } = await start();
  const fyRaw = str(fd, "fy");
  if (!/^20\d\d$/.test(fyRaw)) fail(BACK, "年度が正しくありません。");
  const fy = Number(fyRaw);
  const back = `${BACK}?fy=${fy}`;
  await mutate((db) => {
    const basis = kpiBasis(db);
    const startMonth = Math.round(Number((db.settings.find((s) => s.id === "kpi")?.value as { fiscalStartMonth?: number } | undefined)?.fiscalStartMonth) || 12);
    const months = fiscalMonths(fy, startMonth);
    const stores = db.stores.filter((s) => s.kind === "store").map((s) => s.id);
    const now = nowIso();
    const changes: AuditChange[] = [];
    const parse = (key: string): number | null | "bad" => {
      const raw = str(fd, key).normalize("NFKC").replace(/[,件\s]/g, "");
      if (!raw) return null;
      return /^\d{1,5}$/.test(raw) ? Number(raw) : "bad";
    };
    for (const sid of stores) {
      for (const m of months) {
        if (!fd.has(`ind_${sid}_${m}`) && !fd.has(`sites_${sid}_${m}`)) continue;
        const k = monthKey(sid, m);
        const cur = { ...(basis.months[k] ?? {}) };
        const ind = parse(`ind_${sid}_${m}`);
        const sites = parse(`sites_${sid}_${m}`);
        if (ind === "bad" || sites === "bad") fail(back, `${m} の値が数ではありません (0〜99999 の整数で入力してください)。`);
        const note = str(fd, `note_${sid}_${m}`).slice(0, 200);
        let changed = false;
        if ((ind ?? undefined) !== cur.individual) {
          changes.push({ field: `individual.${sid}.${m}`, before: cur.individual ?? null, after: ind });
          if (ind === null) {
            delete cur.individual;
            delete cur.individualSrc;
          } else {
            cur.individual = ind;
            cur.individualSrc = "manual";
          }
          changed = true;
        }
        if ((sites ?? undefined) !== cur.sites) {
          changes.push({ field: `sites.${sid}.${m}`, before: cur.sites ?? null, after: sites });
          if (sites === null) delete cur.sites;
          else cur.sites = sites;
          changed = true;
        }
        if (fd.has(`note_${sid}_${m}`) && (note || undefined) !== cur.note) {
          changes.push({ field: `note.${sid}.${m}`, before: cur.note ?? null, after: note || null });
          if (note) cur.note = note;
          else delete cur.note;
          changed = true;
        }
        if (!changed) continue;
        cur.updatedBy = user.id;
        cur.updatedAt = now;
        if (cur.individual === undefined && cur.sites === undefined && !cur.note) delete basis.months[k];
        else basis.months[k] = cur;
      }
    }
    if (!changes.length) fail(back, "変更はありませんでした。");
    writeKpiBasis(db, basis, user.id, now);
    addAudit(db, { userId: user.id, action: "update", entity: "kpi_basis", entityId: "kpi_basis", entityLabel: `KPI の分母 (${fy}年度)`, summary: `KPI の個人件数・全案件数を手入力 (${fy}年度・${changes.length} 項目)`, storeId: "hq", changes: changes.slice(0, 80) });
  });
  revalidatePath("/kpi", "layout");
  redirect(withMsg(back, "個人件数・全案件数を保存しました。"));
}

/** 取込の確認 (読み取って保存するだけ。まだ取り込まない) */
export async function previewKpiBasisImport(fd: FormData) {
  const { user } = await start();
  const sheets: { name: string; rows: string[][]; source: string }[] = [];
  const problems: string[] = [];
  const labels: string[] = [];
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const urls = str(fd, "urls").split(/\s+/).map((x) => x.trim()).filter(Boolean);
  if (!files.length && !urls.length) fail(BACK, "ファイルを選ぶか、Google スプレッドシートのタブの URL を入れてください。");
  if (files.reduce((a, f) => a + f.size, 0) > MAX_BASIS_BYTES) fail(BACK, "ファイルが大きすぎます (合計 4 MB まで)。年間チラシ計画は「個人件数売上」のタブだけを CSV でダウンロードするか、タブの URL を入れてください。");
  if (files.length) {
    const r = basisSheetsFromFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    sheets.push(...r.sheets);
    problems.push(...r.problems);
    labels.push(...files.map((f) => f.name.slice(0, 60)));
  }
  for (const u of urls.slice(0, 4)) {
    if (!parseSheetLink(u)) fail(BACK, `Google スプレッドシートの URL ではありません: ${u.slice(0, 60)}`);
    try {
      const r = await fetchSheetCsv(u);
      sheets.push({ name: "", rows: parseCsv(r.text), source: r.label });
      labels.push(r.label.slice(0, 60));
    } catch (e) {
      problems.push(`${u.slice(0, 60)}: ${(e as Error).message}`);
    }
  }
  const read = readBasisSheets(sheets);
  problems.push(...read.problems);
  if (!read.individual.length && !read.cardMonths.length) fail(BACK, problems.slice(0, 3).join(" / ") || "読み取れるシートがありません。");
  const preview: BasisPreview = { ...read, problems, label: labels.join("・").slice(0, 120), by: user.id, at: nowIso() };
  const hash = basisHash(preview);
  // 同じ内容をもう一度読んだときは前の確認を置き換える (ストレージは同じキーへの上書きを断る)
  await removeObjects([previewKey(hash)]).catch(() => undefined);
  await putObject(previewKey(hash), Buffer.from(JSON.stringify(preview)));
  let old: string | undefined;
  await mutate((db) => {
    const b = kpiBasis(db);
    if (b.preview && b.preview.hash !== hash) old = b.preview.hash;
    b.preview = { hash, at: preview.at, by: user.id, label: preview.label };
    if (urls.length) b.sourceUrls = urls.slice(0, 4);
    writeKpiBasis(db, b, user.id, nowIso());
  });
  if (old) await removeObjects([previewKey(old)]).catch(() => undefined);
  redirect(`${BACK}?preview=${hash}`);
}

/** 集計月の列 (survey_responses.count_month) がデータベースにあるか (npm run db:migrate の前は書き込めない) */
async function countMonthColumnReady(): Promise<boolean> {
  if (BACKEND !== "supabase") return true;
  const { error } = await supabaseAdmin().from("survey_responses").select("count_month").limit(1);
  return !error;
}

export async function applyKpiBasisImport(fd: FormData) {
  const { user } = await start();
  const hash = str(fd, "hash");
  const back = `${BACK}?preview=${hash}`;
  const p = await readBasisPreview(hash);
  if (!p) fail(BACK, "確認した内容が見つかりません。もう一度「読み取って確認する」を押してください。");
  if (p.cardMonths.length && !(await countMonthColumnReady())) fail(back, "データベースにはがきの集計月の列がまだありません。開発担当が npm run db:migrate を実行すると取り込めます (個人件数だけなら、年間チラシ計画のファイルだけで確認し直してください)。");
  let summary = "";
  await mutate((db) => {
    const now = nowIso();
    const { basis, result } = applyBasisImport(db, p, { userId: user.id, now });
    summary = result.summary;
    basis.preview = undefined;
    writeKpiBasis(db, basis, user.id, now);
    addAudit(db, { userId: user.id, action: "import", entity: "kpi_basis", entityId: "kpi_basis", entityLabel: "KPI の分母・はがきの集計月", summary: `KPI の分母・はがきの集計月を取込 (${p.label}): ${summary}`, storeId: "hq", changes: result.changedMonths.slice(0, 80) });
  });
  await removeObjects([previewKey(hash)]).catch(() => undefined);
  revalidatePath("/kpi", "layout");
  redirect(withMsg(BACK, `取り込みました: ${summary}`));
}

export async function discardKpiBasisPreview(fd: FormData) {
  const { user } = await start();
  const hash = str(fd, "hash");
  if (PREVIEW_RE.test(hash)) await removeObjects([previewKey(hash)]).catch(() => undefined);
  await mutate((db) => {
    const b: KpiBasis = kpiBasis(db);
    if (b.preview?.hash !== hash) return;
    b.preview = undefined;
    writeKpiBasis(db, b, user.id, nowIso());
  });
  redirect(withMsg(BACK, "確認の内容を破棄しました (何も取り込んでいません)。"));
}

/** 照合に使う KPI のタブを読み込む (お客様アンケート集計表の KPI のタブの CSV、または .xlsx)。データは変えない */
export async function loadKpiSheetForCheck(fd: FormData) {
  const { user } = await start("/kpi/basis/check");
  const back = "/kpi/basis/check";
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) fail(back, "KPI のタブの CSV か、お客様アンケート集計表の .xlsx を選んでください。");
  if (files.reduce((a, f) => a + f.size, 0) > MAX_BASIS_BYTES) fail(back, "ファイルが大きすぎます (合計 4 MB まで)。KPI のタブだけを CSV でダウンロードしてください。");
  const r = tabsFromFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  const tab = r.tabs.find((t) => detectTab(t.title, t.rows) === "kpi");
  if (!tab) fail(back, r.problems[0] ?? "KPI のタブが見つかりません (お客様アンケート集計表の「KPI」のタブ)。");
  await saveKpiSheet({ tab, label: files.map((f) => f.name).join("・").slice(0, 120), by: user.id, at: nowIso() });
  redirect(withMsg(back, "KPI のタブを読み込みました (データは変えていません)。"));
}
