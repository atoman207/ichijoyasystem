"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, diffChanges, mutate, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { canEditKnowledge, canManageKnowledgeSources } from "@/lib/auth/permissions";
import { knowledgeSources, parseKnowledgeRows, parseKnowledgeText, splitTags, type KnowledgeDraft } from "@/lib/knowledge";
import { saveSources, syncSource } from "@/lib/knowledge-sync";
import { sheetCsvUrl } from "@/lib/data-io";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { AiError, aiEnabled, generateJson } from "@/lib/ai/provider";
import { fail, requireActionUser, str, withMsg } from "./guards";

const BACK = "/knowledge";
const MAX_FILE = 4 * 1024 * 1024;

async function assertTable(back: string) {
  if (BACKEND === "supabase" && missingTables().includes("knowledge") && (await recheckMissingTables()).includes("knowledge")) {
    fail(back, "データベースに社内資料の表がまだありません (管理者がデータベースの更新を実行してください)。");
  }
}

function fromForm(formData: FormData): KnowledgeDraft & { active: boolean } {
  return {
    title: str(formData, "title").slice(0, 200),
    body: str(formData, "body").slice(0, 20000),
    category: str(formData, "category").slice(0, 40),
    tags: splitTags(str(formData, "tags")),
    active: formData.getAll("active").map(String).includes("on") || !formData.has("activeShown"),
  };
}

export async function createKnowledge(formData: FormData) {
  const user = await requireActionUser();
  if (!canEditKnowledge(user)) fail(BACK, "社内資料の登録は店長・本部スタッフ・管理者が行います。");
  await assertTable(BACK);
  const d = fromForm(formData);
  if (!d.title || !d.body) fail(BACK, "タイトルと内容を入力してください。");
  const id = newId("kn");
  await mutate((db) => {
    const now = nowIso();
    db.knowledge.push({ id, title: d.title, body: d.body, category: d.category || "その他", tags: d.tags, source: "manual", active: d.active, createdBy: user.id, createdAt: now, updatedAt: now });
    addAudit(db, { userId: user.id, action: "create", entity: "knowledge", entityId: id, entityLabel: d.title, summary: `社内資料を登録 (${d.title})` });
  });
  revalidatePath(BACK);
  redirect(withMsg(`${BACK}/${id}`, "社内資料を登録しました。AI アシスタントの回答に使われます。"));
}

export async function updateKnowledge(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `${BACK}/${id}`;
  if (!canEditKnowledge(user)) fail(back, "社内資料の修正は店長・本部スタッフ・管理者が行います。");
  const d = fromForm(formData);
  if (!d.title || !d.body) fail(back, "タイトルと内容を入力してください。");
  await mutate((db) => {
    const e = db.knowledge.find((x) => x.id === id);
    if (!e) fail(BACK, "社内資料が見つかりません。");
    const before = { ...e };
    Object.assign(e, { title: d.title, body: d.body, category: d.category || "その他", tags: d.tags, active: d.active, updatedBy: user.id, updatedAt: nowIso() });
    const changes = diffChanges(before, e, ["title", "body", "category", "tags", "active"]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    addAudit(db, { userId: user.id, action: "update", entity: "knowledge", entityId: id, entityLabel: e.title, summary: `社内資料を修正 (${e.title})`, changes });
  });
  revalidatePath(BACK);
  redirect(withMsg(back, "保存しました。"));
}

export async function deleteKnowledge(id: string) {
  const user = await requireActionUser();
  if (!canEditKnowledge(user)) fail(`${BACK}/${id}`, "社内資料の削除は店長・本部スタッフ・管理者が行います。");
  await mutate((db) => {
    const i = db.knowledge.findIndex((x) => x.id === id);
    if (i < 0) fail(BACK, "社内資料が見つかりません。");
    const [e] = db.knowledge.splice(i, 1);
    addAudit(db, { userId: user.id, action: "delete", entity: "knowledge", entityId: id, entityLabel: e.title, summary: `社内資料を削除 (${e.title})` });
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, "社内資料を削除しました。"));
}

/* ================================================================== */
/* ファイルからの取込 (テキスト・Markdown・CSV・PDF・写真)                 */
/* ================================================================== */

/** PDF・写真は AI で文字にする (要約せず、見出しごとに書き出す) */
async function readWithAi(fileName: string, mime: string, bytes: Uint8Array): Promise<KnowledgeDraft[]> {
  const base64 = Buffer.from(bytes).toString("base64");
  const r = await generateJson<{ sections: { title: string; body: string }[] }>({
    system: "あなたは社内資料を文字に起こす担当です。資料の内容を、要約せずに見出しごとに書き出してください。表は「項目: 値」の行にしてください。読めない部分は書かないでください。",
    parts: [mime === "application/pdf" ? { type: "pdf", base64, fileName } : { type: "image", mediaType: mime, base64 }, { type: "text", text: "この資料を見出しごとの文章にしてください。" }],
    schema: {
      type: "object",
      properties: { sections: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false } } },
      required: ["sections"],
      additionalProperties: false,
    },
    schemaName: "ichijoya_knowledge",
    maxTokens: 8000,
  });
  const base = fileName.replace(/\.[^.]+$/, "");
  return (r.data.sections ?? []).filter((s) => s.body?.trim()).map((s) => ({ title: (s.title?.trim() || base).slice(0, 200), body: s.body.trim().slice(0, 20000), tags: [base] }));
}

export async function importKnowledgeFile(formData: FormData) {
  const user = await requireActionUser();
  if (!canEditKnowledge(user)) fail(BACK, "社内資料の取込は店長・本部スタッフ・管理者が行います。");
  await assertTable(BACK);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) fail(BACK, "取り込むファイルを選んでください。");
  if (file.size > MAX_FILE) fail(BACK, "ファイルは 4 MB までです。");
  const name = file.name.slice(0, 150);
  const category = str(formData, "category").slice(0, 40) || "その他";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  let drafts: KnowledgeDraft[] = [];
  if (["csv", "tsv"].includes(ext)) {
    const { text } = decodeCsv(bytes);
    drafts = parseKnowledgeRows(ext === "tsv" ? text.split(/\r?\n/).map((l) => l.split("\t")) : parseCsv(text));
  } else if (["txt", "md", "markdown"].includes(ext)) {
    drafts = parseKnowledgeText(name, decodeCsv(bytes).text);
  } else if (ext === "pdf" || ["jpg", "jpeg", "png", "webp"].includes(ext)) {
    if (!aiEnabled()) fail(BACK, "PDF・写真の読み取りには AI の設定が必要です。テキスト (.txt) か CSV にして取り込んでください。");
    const mime = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    try {
      drafts = await readWithAi(name, mime, bytes);
    } catch (err) {
      fail(BACK, `資料を読み取れませんでした: ${err instanceof AiError ? err.message : (err as Error).message}${err instanceof AiError && err.code === "truncated" ? " 長い資料はページを分けるか、テキストにして取り込んでください。" : ""}`);
    }
  } else {
    fail(BACK, "テキスト (.txt・.md)・CSV・PDF・写真 (JPEG・PNG) を取り込めます。Word・Excel は CSV か PDF に保存してから取り込んでください。");
  }
  drafts = drafts.filter((d) => d.title && d.body).slice(0, 500);
  if (!drafts.length) fail(BACK, "取り込める内容がありませんでした (1 行目に「タイトル」「内容」の見出しがある表、または文章のファイルにしてください)。");
  await mutate((db) => {
    const now = nowIso();
    for (const d of drafts) {
      db.knowledge.push({ id: newId("kn"), title: d.title, body: d.body, category: d.category || category, tags: d.tags, source: "file", sourceRef: name, active: true, createdBy: user.id, createdAt: now, updatedAt: now });
    }
    addAudit(db, { userId: user.id, action: "import", entity: "knowledge", entityId: "file", entityLabel: name, summary: `社内資料をファイルから取込 (${name}・${drafts.length} 件)` });
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, `「${name}」から ${drafts.length} 件を取り込みました。`));
}

/* ================================================================== */
/* Google スプレッドシート (指定したシートとの同期)                         */
/* ================================================================== */

export async function addKnowledgeSource(formData: FormData) {
  const user = await requireActionUser();
  if (!canManageKnowledgeSources(user)) fail(BACK, "スプレッドシートの登録は本部スタッフ・管理者が行います。");
  await assertTable(BACK);
  const url = str(formData, "url");
  const label = str(formData, "label").slice(0, 60);
  const category = str(formData, "category").slice(0, 40) || "その他";
  if (!sheetCsvUrl(url)) fail(BACK, "Google スプレッドシートの URL (https://docs.google.com/spreadsheets/d/…) を入力してください。");
  const id = newId("ks");
  await mutate((db) => {
    const sources = knowledgeSources(db);
    if (sources.some((s) => s.url === url)) fail(BACK, "このシートはすでに登録されています。");
    sources.push({ id, label: label || `スプレッドシート ${sources.length + 1}`, url, category });
    saveSources(db, sources, user.id);
    addAudit(db, { userId: user.id, action: "create", entity: "knowledge", entityId: id, entityLabel: label || url, summary: `社内資料の取込元 (スプレッドシート) を登録 (${label || url})` });
  });
  const r = await syncSource(id, user.id);
  revalidatePath(BACK);
  redirect(r.ok ? withMsg(BACK, `取込元を登録しました。${r.message}`) : `${BACK}?err=${encodeURIComponent(`取込元を登録しましたが、${r.message}`)}`);
}

export async function syncKnowledgeSource(id: string) {
  const user = await requireActionUser();
  if (!canManageKnowledgeSources(user)) fail(BACK, "同期は本部スタッフ・管理者が行います。");
  const r = await syncSource(id, user.id);
  revalidatePath(BACK);
  redirect(r.ok ? withMsg(BACK, r.message) : `${BACK}?err=${encodeURIComponent(r.message)}`);
}

export async function removeKnowledgeSource(id: string) {
  const user = await requireActionUser();
  if (!canManageKnowledgeSources(user)) fail(BACK, "取込元の削除は本部スタッフ・管理者が行います。");
  let label = "";
  let removed = 0;
  await mutate((db) => {
    const sources = knowledgeSources(db);
    const s = sources.find((x) => x.id === id);
    if (!s) fail(BACK, "取込元が見つかりません。");
    label = s.label;
    const before = db.knowledge.length;
    db.knowledge = db.knowledge.filter((k) => !k.sourceRef?.startsWith(`sheet:${id}:`));
    removed = before - db.knowledge.length;
    saveSources(db, sources.filter((x) => x.id !== id), user.id);
    addAudit(db, { userId: user.id, action: "delete", entity: "knowledge", entityId: id, entityLabel: s.label, summary: `社内資料の取込元を削除 (${s.label}・資料 ${removed} 件も削除)` });
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, `取込元「${label}」と、そこから取り込んだ資料 ${removed} 件を削除しました。`));
}

