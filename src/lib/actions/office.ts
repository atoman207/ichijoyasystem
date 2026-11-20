"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CondolenceCategory, OfficeImprovement, Condolence, User } from "@/lib/db/types";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { canEditCondolences, canEditOfficeImprovements, canManageOfficeAccess } from "@/lib/auth/permissions";
import {
  CONDOLENCE_CATEGORY_LABEL,
  applyCondolenceImport,
  applyImprovementImport,
  matchStaff,
  officeCtx,
  OFFICE_ACCESS_ID,
  parseDay,
  parseYen,
  planCondolenceImport,
  planImprovementImport,
  readUploadTables,
  type ImportLine,
  type OfficeImportPlan,
} from "@/lib/office";
import { officeTablesMissing } from "@/lib/office-tables";
import { choice, fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 事務 (事務改善シート・慶弔リスト) の操作
 * 順序: requireActionUser → 権限 (permissions.ts) → 表の有無 → mutate → addAudit → revalidatePath → redirect(withMsg)
 * (店舗の記録ではないため店舗スコープの確認はない)
 */

const BASE = "/office";
const MAX_TEXT = 2000;
const MAX_FILE = 10 * 1024 * 1024;

type Kind = "kaizen" | "keicho";

async function start(fd: FormData, kind: Kind): Promise<{ user: User; back: string }> {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), `${BASE}?tab=${kind}`);
  const ctx = officeCtx(getDb());
  if (kind === "kaizen" && !canEditOfficeImprovements(user, ctx)) fail(back, "事務改善シートの登録・修正は、事務担当・本部スタッフ・管理者が行います。");
  if (kind === "keicho" && !canEditCondolences(user, ctx)) fail(`${BASE}?tab=kaizen`, "慶弔リストは事務担当・本部スタッフ・管理者だけが扱えます。");
  const missing = await officeTablesMissing();
  if (missing) fail(back, missing);
  return { user, back };
}

function done(back: string, msg: string): never {
  revalidatePath(BASE);
  redirect(withMsg(back, msg));
}

const text = (fd: FormData, key: string, max: number) => str(fd, key).replace(/\r\n?/g, "\n").slice(0, max);

/* ================================================================== */
/* 事務改善シート                                                          */
/* ================================================================== */

const IMPROVEMENT_FIELDS: (keyof OfficeImprovement)[] = ["year", "date", "staffName", "staffId", "item", "content", "cause", "measure"];

export async function saveImprovement(fd: FormData) {
  const { user, back } = await start(fd, "kaizen");
  const id = str(fd, "id");
  const dateRaw = str(fd, "date");
  const date = dateRaw ? parseDay(dateRaw) : undefined;
  if (dateRaw && !date) fail(back, "日付を正しく入力してください。");
  const year = date ? Number(date.slice(0, 4)) : Number(str(fd, "year"));
  if (!(year >= 1990 && year <= 2100)) fail(back, "日付か年を入力してください。");
  const content = text(fd, "content", MAX_TEXT);
  if (!content) fail(back, "内容を入力してください。");
  const staffName = str(fd, "staffName").slice(0, 40);
  const row = {
    year,
    date,
    staffName,
    staffId: matchStaff(getDb(), staffName),
    item: str(fd, "item").slice(0, 60),
    content,
    cause: text(fd, "cause", MAX_TEXT) || undefined,
    measure: text(fd, "measure", MAX_TEXT) || undefined,
  };
  let msg = "";
  await mutate((db) => {
    const now = nowIso();
    if (id) {
      const r = db.officeImprovements.find((x) => x.id === id);
      if (!r) fail(back, "事務改善の行が見つかりません。");
      const changes = diffChanges(r, { ...r, ...row }, IMPROVEMENT_FIELDS);
      if (!changes.length) {
        msg = "変更はありません。";
        return;
      }
      Object.assign(r, row, { updatedBy: user.id, updatedAt: now });
      addAudit(db, { userId: user.id, action: "update", entity: "office_improvement", entityId: r.id, entityLabel: `${r.date ?? r.year} ${r.item}`.trim(), summary: `事務改善シートを修正 (${r.item || "項目なし"})`, changes });
      msg = "事務改善の行を修正しました。";
    } else {
      const r: OfficeImprovement = { id: newId("oi"), ...row, source: "manual", createdBy: user.id, createdAt: now, updatedAt: now };
      db.officeImprovements.push(r);
      addAudit(db, { userId: user.id, action: "create", entity: "office_improvement", entityId: r.id, entityLabel: `${r.date ?? r.year} ${r.item}`.trim(), summary: `事務改善シートに登録 (${r.item || "項目なし"}: ${r.content.slice(0, 40)})` });
      msg = "事務改善の行を登録しました。";
    }
  });
  done(`${BASE}?tab=kaizen`, msg);
}

export async function deleteImprovement(fd: FormData) {
  const { user, back } = await start(fd, "kaizen");
  const id = str(fd, "id");
  await mutate((db) => {
    const r = db.officeImprovements.find((x) => x.id === id);
    if (!r) fail(back, "事務改善の行が見つかりません。");
    db.officeImprovements = db.officeImprovements.filter((x) => x.id !== id);
    addAudit(db, { userId: user.id, action: "delete", entity: "office_improvement", entityId: r.id, entityLabel: `${r.date ?? r.year} ${r.item}`.trim(), summary: `事務改善シートから削除 (${r.item || "項目なし"}: ${r.content.slice(0, 40)})` });
  });
  done(`${BASE}?tab=kaizen`, "事務改善の行を削除しました。");
}

/* ================================================================== */
/* 慶弔リスト                                                             */
/* ================================================================== */

const CONDOLENCE_FIELDS: (keyof Condolence)[] = ["date", "category", "kind", "name", "relation", "amount", "attendee", "note"];

export async function saveCondolence(fd: FormData) {
  const { user, back } = await start(fd, "keicho");
  const id = str(fd, "id");
  const date = parseDay(str(fd, "date"));
  if (!date) fail(back, "年月日を入力してください。");
  const name = str(fd, "name").slice(0, 80);
  const relation = str(fd, "relation").slice(0, 200);
  if (!name && !relation) fail(back, "名前か関係を入力してください。");
  const amountRaw = str(fd, "amount");
  const amount = amountRaw ? parseYen(amountRaw) : undefined;
  if (amountRaw && amount === undefined) fail(back, "金額は円の数で入力してください (例: 5000)。");
  const row = {
    date,
    category: choice(fd, "category", CONDOLENCE_CATEGORY_LABEL, "condolence") as CondolenceCategory,
    kind: str(fd, "kind").slice(0, 40),
    name,
    relation: relation || undefined,
    amount,
    attendee: str(fd, "attendee").slice(0, 80) || undefined,
    note: text(fd, "note", 500) || undefined,
  };
  let msg = "";
  await mutate((db) => {
    const now = nowIso();
    if (id) {
      const r = db.condolences.find((x) => x.id === id);
      if (!r) fail(back, "慶弔の行が見つかりません。");
      const changes = diffChanges(r, { ...r, ...row }, CONDOLENCE_FIELDS);
      if (!changes.length) {
        msg = "変更はありません。";
        return;
      }
      Object.assign(r, row, { updatedBy: user.id, updatedAt: now });
      addAudit(db, { userId: user.id, action: "update", entity: "condolence", entityId: r.id, entityLabel: `${r.date} ${r.kind}`.trim(), summary: `慶弔リストを修正 (${r.date} ${r.kind})`, changes });
      msg = "慶弔の行を修正しました。";
    } else {
      const r: Condolence = { id: newId("cd"), ...row, source: "manual", createdBy: user.id, createdAt: now, updatedAt: now };
      db.condolences.push(r);
      addAudit(db, { userId: user.id, action: "create", entity: "condolence", entityId: r.id, entityLabel: `${r.date} ${r.kind}`.trim(), summary: `慶弔リストに登録 (${r.date} ${CONDOLENCE_CATEGORY_LABEL[r.category]} ${r.kind})` });
      msg = "慶弔の行を登録しました。";
    }
  });
  done(`${BASE}?tab=keicho`, msg);
}

export async function deleteCondolence(fd: FormData) {
  const { user, back } = await start(fd, "keicho");
  const id = str(fd, "id");
  await mutate((db) => {
    const r = db.condolences.find((x) => x.id === id);
    if (!r) fail(back, "慶弔の行が見つかりません。");
    db.condolences = db.condolences.filter((x) => x.id !== id);
    addAudit(db, { userId: user.id, action: "delete", entity: "condolence", entityId: r.id, entityLabel: `${r.date} ${r.kind}`.trim(), summary: `慶弔リストから削除 (${r.date} ${CONDOLENCE_CATEGORY_LABEL[r.category]} ${r.kind})` });
  });
  done(`${BASE}?tab=keicho`, "慶弔の行を削除しました。");
}

/* ================================================================== */
/* 取込 (.xlsx・CSV)。「確認する」は登録せずに結果だけを返す                         */
/* ================================================================== */

function summary(plan: OfficeImportPlan<unknown>, committed: number | null): string {
  const head = committed === null ? `確認 (まだ登録していません): 新規 ${plan.counts.create} 件` : `${committed} 件を登録しました`;
  const issues = plan.rows.filter((r: ImportLine) => r.status === "error").slice(0, 4).map((r) => `${r.row} 行目: ${r.message}`);
  return `${head}・登録済みと同じ行 ${plan.counts.duplicate} 件・取り込めない行 ${plan.counts.error} 件${plan.sheet && plan.sheet !== "CSV" ? ` (シート「${plan.sheet}」)` : ""}。${issues.length ? ` ${issues.join(" / ")}` : ""}${committed === null && plan.counts.create ? " よければ「取り込む」を押してください。" : ""}`;
}

async function readFile(fd: FormData, back: string): Promise<{ tables: { name: string; table: string[][] }[]; label: string }> {
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) fail(back, ".xlsx か CSV のファイルを選んでください。");
  if (file.size > MAX_FILE) fail(back, "ファイルが大きすぎます (10 MB まで)。");
  try {
    return { tables: readUploadTables(Buffer.from(await file.arrayBuffer())), label: file.name.slice(0, 80) };
  } catch (e) {
    fail(back, `ファイルを読み取れませんでした: ${(e as Error).message}`);
  }
}

export async function importImprovements(fd: FormData) {
  const { user, back } = await start(fd, "kaizen");
  const { tables, label } = await readFile(fd, back);
  const preview = str(fd, "mode") !== "commit";
  const plan0 = planImprovementImport(getDb(), tables);
  if (plan0.problem) fail(back, plan0.problem);
  if (preview) done(back, summary(plan0, null));
  let n = 0;
  let plan = plan0;
  await mutate((db) => {
    // 書き込みの直前の内容で判定し直す (確認のあとに登録された行と重ならないように)
    plan = planImprovementImport(db, tables);
    n = applyImprovementImport(db, user, plan, label);
  });
  done(back, summary(plan, n));
}

export async function importCondolences(fd: FormData) {
  const { user, back } = await start(fd, "keicho");
  const { tables, label } = await readFile(fd, back);
  const preview = str(fd, "mode") !== "commit";
  const plan0 = planCondolenceImport(getDb(), tables);
  if (plan0.problem) fail(back, plan0.problem);
  if (preview) done(back, summary(plan0, null));
  let n = 0;
  let plan = plan0;
  await mutate((db) => {
    plan = planCondolenceImport(db, tables);
    n = applyCondolenceImport(db, user, plan, label);
  });
  done(back, summary(plan, n));
}

/** 慶弔リストを見られる人 (全社員 / 事務担当・本部・管理者だけ) の切り替え: 管理者 (設定の id = office_access) */
export async function setCondolenceViewers(formData: FormData) {
  const user = await requireActionUser();
  const back = `${BASE}?tab=keicho`;
  if (!canManageOfficeAccess(user)) fail(back, "慶弔リストを見られる人は管理者が変更できます。");
  const next = String(formData.get("condolenceViewers") ?? "") === "office" ? "office" : "all";
  await mutate((db) => {
    const before = officeCtx(db).condolenceViewers;
    const row = db.settings.find((s) => s.id === OFFICE_ACCESS_ID);
    const now = nowIso();
    if (row) {
      row.value = { ...row.value, condolenceViewers: next };
      row.updatedBy = user.id;
      row.updatedAt = now;
    } else db.settings.push({ id: OFFICE_ACCESS_ID, value: { condolenceViewers: next }, updatedBy: user.id, updatedAt: now });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: OFFICE_ACCESS_ID, entityLabel: "慶弔リストを見られる人", summary: `慶弔リストを見られる人を「${next === "all" ? "全社員" : "事務担当・本部・管理者"}」に変更`, storeId: "hq", changes: [{ field: "condolenceViewers", before, after: next }] });
  });
  revalidatePath(BASE);
  redirect(withMsg(back, next === "all" ? "慶弔リストを全社員が見られるようにしました (登録・修正は事務担当・本部・管理者)。" : "慶弔リストを事務担当・本部・管理者だけが見られるようにしました。"));
}
