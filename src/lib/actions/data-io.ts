"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getDb, mutate } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { fetchSheetCsv, runImport, type ImportOptions, type ImportReport } from "@/lib/data-io";
import { IMPORT_SPEC, type ImportTarget } from "@/lib/data-io-spec";
import { parseCsv } from "@/lib/csv";
import { requireActionUser } from "./guards";

/**
 * データの取込 (CSV ファイル・Google スプレッドシート)。管理者・本部スタッフのみ
 * 画面で読み込んだ表 (行 × 項目) を受け取り、確認 (previewImport) → 実行 (commitImport) の 2 段階で行う
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function guard() {
  const user = await requireActionUser();
  if (!canImportData(user)) throw new Error("データの取込は管理者・本部スタッフが行います。");
  return user;
}

function check(target: string, table: unknown): table is string[][] {
  return target in IMPORT_SPEC && Array.isArray(table) && table.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"));
}

function options(o: Partial<ImportOptions>): ImportOptions {
  return { mode: o.mode === "overwrite" ? "overwrite" : "fill", allowDuplicates: o.allowDuplicates === true, sourceLabel: String(o.sourceLabel ?? "CSV").slice(0, 120) };
}

export async function previewImport(target: ImportTarget, table: string[][], opts: Partial<ImportOptions>): Promise<Result<ImportReport>> {
  try {
    const user = await guard();
    if (!check(target, table)) return { ok: false, error: "取込の内容が正しくありません。" };
    return { ok: true, data: runImport(getDb(), user, target, table, options(opts), false) };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function commitImport(target: ImportTarget, table: string[][], opts: Partial<ImportOptions>): Promise<Result<ImportReport>> {
  let user;
  try {
    user = await guard();
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
  if (!check(target, table)) return { ok: false, error: "取込の内容が正しくありません。" };
  try {
    const report = await mutate((db) => runImport(db, user, target, table, options(opts), true));
    revalidatePath(target === "customers" ? "/customers" : "/inquiries");
    revalidatePath("/data");
    return { ok: true, data: report };
  } catch (err) {
    unstable_rethrow(err);
    console.error("[import] failed:", err);
    return { ok: false, error: (err as Error).message.startsWith("データベース") ? (err as Error).message : "取込に失敗しました。時間をおいて再度お試しください。" };
  }
}

/** Google スプレッドシート (リンクで共有されたシート) を読み込む */
export async function loadSheet(link: string): Promise<Result<{ table: string[][]; label: string }>> {
  try {
    await guard();
    const { text, label } = await fetchSheetCsv(String(link ?? ""));
    return { ok: true, data: { table: parseCsv(text), label } };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: (err as Error).message };
  }
}
