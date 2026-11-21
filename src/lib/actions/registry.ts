"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { KnowledgeVisibility, User } from "@/lib/db/types";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import { canManageRegistry } from "@/lib/auth/permissions";
import { putObject, removeObjects } from "@/lib/storage";
import { ACTION_LABEL, REGISTRY_CATEGORIES, type RegistryAction } from "@/lib/registry/classify";
import { addRun, deleteDoc, effAction, effCategory, effVisibility, getDoc, openMaterials, setKnowledgeIds, setOverride, type MaterialsSqlite } from "@/lib/registry/materials-db";
import { promoteFromMaterials } from "@/lib/registry/promote";
import { initialReview, reviewSettings } from "@/lib/knowledge-review";
import { ingestUpload, UPLOAD_EXTS } from "@/lib/registry/ingest";
import { KNOWLEDGE_VISIBILITY_LABEL } from "@/lib/knowledge";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * データ台帳の操作 (資料の扱いの変更・社内資料への登録・資料の追加と削除)
 * 順序: requireActionUser → 権限 (canManageRegistry) → 資料庫 (VPS の SQLite) → mutate (社内資料) → addAudit → 資料庫の knowledge_ids → revalidatePath → redirect(withMsg)
 * 資料の中身は資料庫 (Supabase の外)、社内資料に登録した節だけが Supabase の knowledge に入る
 */

const BASE = "/registry";
const VIS: KnowledgeVisibility[] = ["all", "manager", "hq", "admin"];
const ACTIONS: RegistryAction[] = ["knowledge", "materials", "structured", "ledger", "exclude"];
/** 1 回の送信の上限 (Server Action の 4.5 MB の内側) */
const MAX_UPLOAD = 4 * 1024 * 1024;

async function start(fd: FormData, fallback = `${BASE}?tab=materials`): Promise<{ user: User; back: string; mdb: MaterialsSqlite }> {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), fallback);
  if (!canManageRegistry(user)) fail(back, "データ台帳の資料の扱いを変えられるのは、本部スタッフ・管理者です。");
  const mdb = openMaterials();
  if (!mdb) fail(back, "資料庫を開けません (ICHIJOYA_MATERIALS_DB_PATH を確かめてください)。");
  return { user, back, mdb };
}

function done(back: string, msg: string): never {
  revalidatePath(BASE);
  revalidatePath("/knowledge");
  redirect(withMsg(back, msg));
}

/** 社内資料を資料庫に合わせる (指定の資料、または全部) */
async function syncKnowledge(user: User, mdb: MaterialsSqlite, docIds: string[] | undefined, label: string) {
  const r = await mutate((db) => {
    const rs = reviewSettings(db);
    const x = promoteFromMaterials(db, mdb, { userId: user.id, now: nowIso(), newId: () => newId("kn"), review: (d) => initialReview(rs, d.category) }, { docIds });
    if (x.added || x.updated || x.removed) {
      addAudit(db, { userId: user.id, action: "import", entity: "knowledge", entityId: docIds?.length === 1 ? docIds[0] : "registry", entityLabel: label, summary: `データ台帳から社内資料をそろえる (${label}: 追加 ${x.added}・更新 ${x.updated}・削除 ${x.removed})` });
    }
    return x;
  });
  for (const [id, ids] of r.perDoc) setKnowledgeIds(mdb, id, ids);
  return r;
}

/** 資料の扱い・見られる人・分類・メモを変える (空欄 = 自動の判定に戻す) */
export async function updateMaterial(fd: FormData) {
  const id = str(fd, "id");
  const { user, back, mdb } = await start(fd, `${BASE}/materials/${encodeURIComponent(id)}`);
  const doc = getDoc(mdb, id);
  if (!doc) fail(`${BASE}?tab=materials`, "資料が見つかりません。");
  const pick = <T extends string>(key: string, list: readonly T[]): T | null | undefined => {
    if (!fd.has(key)) return undefined;
    const v = str(fd, key);
    if (!v) return null;
    if (!list.includes(v as T)) fail(back, "選んだ値が正しくありません。");
    return v as T;
  };
  const action = pick("action", ACTIONS);
  const visibility = pick("visibility", VIS);
  const category = pick("category", REGISTRY_CATEGORIES);
  const note = fd.has("note") ? str(fd, "note").slice(0, 500) || null : undefined;
  if (action === "knowledge" && doc.status !== "ok") fail(back, "文字のない資料は社内資料に登録できません。");
  const before = { action: effAction(doc), visibility: effVisibility(doc), category: effCategory(doc), note: doc.override?.note ?? "" };
  setOverride(mdb, id, { action, visibility, category, note }, user.id);
  const after = getDoc(mdb, id)!;
  const r = await syncKnowledge(user, mdb, [id], after.name);
  await mutate((db) => {
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "registry",
      entityId: id,
      entityLabel: after.name,
      summary: `データ台帳の資料の扱いを変更 (${ACTION_LABEL[effAction(after)]} / 見られる人 ${KNOWLEDGE_VISIBILITY_LABEL[effVisibility(after)]})`,
      changes: [
        { field: "action", before: ACTION_LABEL[before.action], after: ACTION_LABEL[effAction(after)] },
        { field: "visibility", before: KNOWLEDGE_VISIBILITY_LABEL[before.visibility], after: KNOWLEDGE_VISIBILITY_LABEL[effVisibility(after)] },
        { field: "category", before: before.category, after: effCategory(after) },
        { field: "note", before: before.note, after: after.override?.note ?? "" },
      ].filter((c) => c.before !== c.after),
    });
  });
  const pending = effAction(after) !== "exclude" && after.status === "skipped" ? " 中身は次の読み取り (scripts/registry/scan-materials.mjs) で取り込みます。" : "";
  done(back, `「${after.name}」の扱いを変えました (社内資料: 追加 ${r.added}・更新 ${r.updated}・削除 ${r.removed})。${pending}`);
}

/** 資料庫の「社内資料に登録」の節と、社内資料をそろえる (全部) */
export async function syncAllMaterialKnowledge(fd: FormData) {
  const { user, back, mdb } = await start(fd);
  const r = await syncKnowledge(user, mdb, undefined, "データ台帳 (全部)");
  addRun(mdb, { kind: "promote", by: user.id, summary: { target: "app", added: r.added, updated: r.updated, removed: r.removed } });
  done(back, `社内資料をそろえました (資料 ${r.docs} 件: 追加 ${r.added}・更新 ${r.updated}・削除 ${r.removed})。`);
}

/** 資料を追加する (複数可)。読み取って資料庫に入れ、選んだときは社内資料にも登録する */
export async function uploadMaterials(fd: FormData) {
  const { user, back, mdb } = await start(fd, `${BASE}?tab=intake`);
  const files = fd.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);
  if (!files.length) fail(back, "ファイルを選んでください。");
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > MAX_UPLOAD) fail(back, "1 回に送れるのは合計 4 MB までです。分けて追加してください。");
  const visibility = (VIS.includes(str(fd, "visibility") as KnowledgeVisibility) ? str(fd, "visibility") : "hq") as KnowledgeVisibility;
  const category = (REGISTRY_CATEGORIES as readonly string[]).includes(str(fd, "category")) ? str(fd, "category") : undefined;
  const promote = str(fd, "promote") === "1";
  const note = str(fd, "note").slice(0, 300) || undefined;
  const results: { id: string; name: string; status: string; error?: string }[] = [];
  for (const f of files.slice(0, 20)) {
    const name = f.name.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 160) || "資料";
    const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase();
    if (!UPLOAD_EXTS.includes(ext)) {
      results.push({ id: "", name, status: "error", error: `この形式は追加できません (${UPLOAD_EXTS.join("・")})` });
      continue;
    }
    const buf = Buffer.from(await f.arrayBuffer());
    const key = `registry/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/${name}`;
    await putObject(key, buf);
    const r = await ingestUpload(mdb, { name, buf, visibility, category, promote, note, storageKey: key });
    results.push({ id: r.id, name, status: r.status, error: r.error });
  }
  const ok = results.filter((r) => r.id);
  let promoted = "";
  if (promote && ok.length) {
    const r = await syncKnowledge(user, mdb, ok.map((x) => x.id), "追加した資料");
    promoted = ` 社内資料: 追加 ${r.added}・更新 ${r.updated}。`;
  }
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "import", entity: "registry", entityId: ok[0]?.id ?? "upload", entityLabel: ok.map((x) => x.name).join("・").slice(0, 120) || "資料", summary: `データ台帳に資料を追加 (${ok.length} 件・見られる人 ${KNOWLEDGE_VISIBILITY_LABEL[visibility]}${promote ? "・社内資料にも登録" : ""})` });
  });
  addRun(mdb, { kind: "upload", by: user.id, summary: { files: results.length, ok: ok.length, promote } });
  const errs = results.filter((r) => r.error);
  done(back, `${ok.length} 件を追加しました。${promoted}${errs.length ? ` 読めなかったもの: ${errs.map((e) => `${e.name} (${e.error})`).join("、")}` : ""}`);
}

/** 画面から追加した資料を消す (クライアント資料は消さずに「取り込まない」にする) */
export async function deleteMaterial(fd: FormData) {
  const id = str(fd, "id");
  const { user, mdb } = await start(fd);
  const doc = getDoc(mdb, id);
  if (!doc) fail(`${BASE}?tab=materials`, "資料が見つかりません。");
  if (doc.origin !== "upload") fail(`${BASE}/materials/${encodeURIComponent(id)}`, "クライアント資料は消せません。扱いを「取り込まない」にしてください。");
  deleteDoc(mdb, id);
  const r = await syncKnowledge(user, mdb, [id], doc.name);
  if (doc.storageKey) await removeObjects([doc.storageKey]).catch(() => undefined);
  await mutate((db) => {
    addAudit(db, { userId: user.id, action: "delete", entity: "registry", entityId: id, entityLabel: doc.name, summary: `データ台帳から資料を削除 (社内資料 ${r.removed} 件も削除)` });
  });
  done(`${BASE}?tab=materials`, `「${doc.name}」を消しました。`);
}
