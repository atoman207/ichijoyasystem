"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { canEditKnowledge, canManageKnowledgeSources, canViewKnowledge } from "@/lib/auth/permissions";
import type { Database, KnowledgeEntry, KnowledgeVisibility, User } from "@/lib/db/types";
import { KNOWLEDGE_CATEGORY_HINTS, KNOWLEDGE_VISIBILITY_LABEL, knowledgeSources, parseKnowledgeRows, parseKnowledgeText, splitTags, type KnowledgeDraft, type KnowledgeSheetSource } from "@/lib/knowledge";
import { KNOWLEDGE_REVIEW_ID, REVIEW_INTERVAL_CHOICES, addDays, confirmedPatch, entryInterval, initialReview, ownerCandidates, reviewSettings, todayKey, type KnowledgeReviewSettings } from "@/lib/knowledge-review";
import { saveSources, syncSource } from "@/lib/knowledge-sync";
import { sheetCsvUrl } from "@/lib/data-io";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { AiError, aiEnabled, generateJson } from "@/lib/ai/provider";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

const BACK = "/knowledge";
const MAX_FILE = 4 * 1024 * 1024;
const VIS = ["all", "manager", "hq", "admin"] as const;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const sourcePath = (id: string) => `${BACK}/sources/${id}`;

async function assertTable(back: string) {
  if (BACKEND === "supabase" && missingTables().includes("knowledge") && (await recheckMissingTables()).includes("knowledge")) {
    fail(back, "データベースに社内資料の表がまだありません (管理者がデータベースの更新を実行してください)。");
  }
}

/** 見られる人 (必ず決める)。自分が見られない範囲にはしない (登録した本人が見られなくなるため) */
function visibilityOf(formData: FormData, user: User, back: string, fallback?: KnowledgeVisibility): KnowledgeVisibility {
  const raw = str(formData, "visibility");
  const v = VIS.find((x) => x === raw) ?? fallback;
  if (!v) fail(back, "「見られる人」を選んでください。");
  if (!canViewKnowledge(user, { visibility: v })) fail(back, "自分が見られない範囲は選べません。");
  return v;
}

/** 担当者 (有効・社内資料を編集できる・その資料を見られる社員) */
function ownerOf(db: Database, formData: FormData, visibility: KnowledgeVisibility, back: string, fallback?: string): string {
  const id = str(formData, "ownerId") || fallback || "";
  if (!id) fail(back, "担当者を選んでください (内容に責任を持ち、定期的に確かめる人)。");
  if (!ownerCandidates(db, { visibility }).some((u) => u.id === id)) fail(back, "担当者には、社内資料を編集でき、この資料を見られる有効な社員を選んでください (店長・本部スタッフ・管理者)。");
  return id;
}

/** 確かめる間隔 (空 = 分類の既定) */
function intervalOf(formData: FormData): number | undefined {
  const n = Number(str(formData, "reviewIntervalDays"));
  return (REVIEW_INTERVAL_CHOICES as readonly number[]).includes(n) ? n : undefined;
}

function contentOf(formData: FormData): KnowledgeDraft & { recordDate?: string } {
  const date = str(formData, "recordDate");
  return {
    title: str(formData, "title").slice(0, 200),
    body: str(formData, "body").slice(0, 20000),
    category: str(formData, "category").slice(0, 40),
    tags: splitTags(str(formData, "tags")),
    recordDate: isDate(date) ? date : undefined,
  };
}

const activeOf = (formData: FormData) => formData.getAll("active").map(String).includes("on") || !formData.has("activeShown");

export async function createKnowledge(formData: FormData) {
  const user = await requireActionUser();
  if (!canEditKnowledge(user)) fail(BACK, "社内資料の登録は店長・本部スタッフ・管理者が行います。");
  await assertTable(BACK);
  const d = contentOf(formData);
  if (!d.title || !d.body) fail(BACK, "タイトルと内容を入力してください。");
  if (!d.category) fail(BACK, "分類を選んでください。");
  const db0 = getDb();
  const visibility = visibilityOf(formData, user, BACK);
  const ownerId = ownerOf(db0, formData, visibility, BACK, user.id);
  const interval = intervalOf(formData);
  const s = reviewSettings(db0);
  const dueIn = str(formData, "reviewDue");
  const id = newId("kn");
  await mutate((db) => {
    const now = nowIso();
    const review = { ...initialReview(s, d.category, { ownerId, intervalDays: interval }), ...(isDate(dueIn) ? { reviewDue: dueIn } : {}) };
    db.knowledge.push({ id, title: d.title, body: d.body, category: d.category!, tags: d.tags, source: "manual", active: activeOf(formData), createdBy: user.id, createdAt: now, updatedAt: now, visibility, recordDate: d.recordDate, ...review, reviewedAt: now, reviewedBy: user.id });
    addAudit(db, { userId: user.id, action: "create", entity: "knowledge", entityId: id, entityLabel: d.title, summary: `社内資料を登録 (${d.title} / 担当 ${db.users.find((u) => u.id === ownerId)?.name ?? "-"} / 次の確認 ${review.reviewDue})` });
  });
  revalidatePath(BACK);
  redirect(withMsg(`${BACK}/${id}`, "社内資料を登録しました。AI アシスタントの回答に使われます。"));
}

const TRACKED: (keyof KnowledgeEntry)[] = ["title", "body", "category", "tags", "active", "visibility", "recordDate", "ownerId", "reviewIntervalDays", "reviewDue", "reviewedAt", "reviewedBy"];

/**
 * 社内資料の修正。スプレッドシートから取り込んだ資料は内容 (タイトル・内容・分類・タグ・日付) を変えない (シートが正。次の同期で戻るため)。
 * 管理の項目 (担当者・見られる人・確かめる間隔・次に確かめる日・AI に使う) はどの資料も変えられる
 */
export async function updateKnowledge(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `${BACK}/${id}`;
  if (!canEditKnowledge(user)) fail(back, "社内資料の修正は店長・本部スタッフ・管理者が行います。");
  const d = contentOf(formData);
  const db0 = getDb();
  const cur0 = db0.knowledge.find((x) => x.id === id);
  if (!cur0) fail(BACK, "社内資料が見つかりません。");
  const sheet = cur0.source === "sheet";
  if (!sheet && (!d.title || !d.body)) fail(back, "タイトルと内容を入力してください。");
  if (!sheet && !d.category) fail(back, "分類を選んでください。");
  const visibility = visibilityOf(formData, user, back, cur0.visibility);
  const ownerId = ownerOf(db0, formData, visibility, back, cur0.ownerId);
  const interval = intervalOf(formData);
  const due = str(formData, "reviewDue");
  if (!isDate(due)) fail(back, "次に確かめる日を入力してください。");
  const confirm = str(formData, "confirm") === "on";
  const s = reviewSettings(db0);
  await mutate((db) => {
    const e = db.knowledge.find((x) => x.id === id);
    if (!e) fail(BACK, "社内資料が見つかりません。");
    if (!canViewKnowledge(user, e)) fail(BACK, "この社内資料を変更する権限がありません。");
    const before = { ...e, tags: [...e.tags] };
    if (!sheet) Object.assign(e, { title: d.title, body: d.body, category: d.category, tags: d.tags, ...(formData.has("recordDate") ? { recordDate: d.recordDate } : {}) });
    Object.assign(e, { active: activeOf(formData), visibility, ownerId, reviewIntervalDays: interval, reviewDue: due });
    if (confirm) Object.assign(e, confirmedPatch(s, e, user.id));
    const changes = diffChanges(before, e, TRACKED);
    if (!changes.length) fail(back, "変更はありませんでした。");
    Object.assign(e, { updatedBy: user.id, updatedAt: nowIso() });
    addAudit(db, { userId: user.id, action: "update", entity: "knowledge", entityId: id, entityLabel: e.title, summary: `社内資料を修正 (${e.title}${confirm ? "・内容を確認" : ""})`, changes });
  });
  revalidatePath(BACK);
  redirect(withMsg(back, confirm ? "保存しました (内容を確認した記録も残しました)。" : "保存しました。"));
}

/** 「確認した」: 内容が今も正しいことを確かめた (次に確かめる日 = 今日 + 間隔) */
export async function confirmKnowledge(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}/${id}`);
  if (!canEditKnowledge(user)) fail(back, "社内資料の確認は店長・本部スタッフ・管理者が行います。");
  let next = "";
  await mutate((db) => {
    const e = db.knowledge.find((x) => x.id === id);
    if (!e) fail(BACK, "社内資料が見つかりません。");
    if (!canViewKnowledge(user, e)) fail(BACK, "この社内資料を確認する権限がありません。");
    const before = { ...e };
    Object.assign(e, confirmedPatch(reviewSettings(db), e, user.id));
    next = e.reviewDue!;
    addAudit(db, { userId: user.id, action: "update", entity: "knowledge", entityId: id, entityLabel: e.title, summary: `社内資料の内容を確認 (${e.title}・次の確認 ${next})`, changes: diffChanges(before, e, ["reviewedAt", "reviewedBy", "reviewDue"]) });
  });
  revalidatePath(BACK);
  redirect(withMsg(back, `内容を確認した記録を残しました。次に確かめる日は ${next} です。`));
}

export async function deleteKnowledge(id: string) {
  const user = await requireActionUser();
  if (!canEditKnowledge(user)) fail(`${BACK}/${id}`, "社内資料の削除は店長・本部スタッフ・管理者が行います。");
  await mutate((db) => {
    const i = db.knowledge.findIndex((x) => x.id === id);
    if (i < 0) fail(BACK, "社内資料が見つかりません。");
    if (!canViewKnowledge(user, db.knowledge[i])) fail(BACK, "この社内資料を削除する権限がありません。");
    if (db.knowledge[i].source === "sheet") fail(`${BACK}/${id}`, "スプレッドシートから取り込んだ資料は、シートの行を消してください (ここで消しても次の同期で戻ります)。AI に使わないだけなら「AI の回答に使う」を外してください。");
    const [e] = db.knowledge.splice(i, 1);
    addAudit(db, { userId: user.id, action: "delete", entity: "knowledge", entityId: id, entityLabel: e.title, summary: `社内資料を削除 (${e.title})` });
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, "社内資料を削除しました。"));
}

/* ================================================================== */
/* まとめて変更 (一覧で選んだ資料)                                          */
/* ================================================================== */

const BULK_OPS = ["confirm", "owner", "visibility", "category", "interval", "due", "activate", "deactivate"] as const;
type BulkOp = (typeof BULK_OPS)[number];

export async function bulkUpdateKnowledge(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canEditKnowledge(user)) fail(back, "社内資料の変更は店長・本部スタッフ・管理者が行います。");
  const ids = [...new Set(formData.getAll("ids").map(String))].slice(0, 500);
  if (!ids.length) fail(back, "変更する資料を選んでください (左のチェック)。");
  const op = BULK_OPS.find((x) => x === str(formData, "op"));
  if (!op) fail(back, "変更する内容を選んでください。");
  const value = str(formData, `value_${op}`);
  const db0 = getDb();
  if (op === "owner" && !ownerCandidates(db0).some((u) => u.id === value)) fail(back, "担当者を選んでください。");
  if (op === "visibility" && !VIS.some((v) => v === value && canViewKnowledge(user, { visibility: v }))) fail(back, "見られる人を選んでください。");
  if (op === "category" && !value) fail(back, "分類を入力してください。");
  if (op === "due" && !isDate(value)) fail(back, "次に確かめる日を入力してください。");
  const interval = op === "interval" ? (value === "" ? undefined : Number(value)) : undefined;
  if (op === "interval" && value !== "" && !(REVIEW_INTERVAL_CHOICES as readonly number[]).includes(interval!)) fail(back, "確かめる間隔を選んでください。");
  const r = await mutate((db) => {
    const s = reviewSettings(db);
    let changed = 0;
    const skipped: string[] = [];
    for (const id of ids) {
      const e = db.knowledge.find((x) => x.id === id);
      if (!e || !canViewKnowledge(user, e)) continue;
      const before = { ...e, tags: [...e.tags] };
      const why = applyBulk(op, value, interval, e, s, db, user);
      if (why) {
        skipped.push(`${e.title} (${why})`);
        continue;
      }
      const changes = diffChanges(before, e, TRACKED);
      if (!changes.length) continue;
      e.updatedBy = user.id;
      e.updatedAt = nowIso();
      addAudit(db, { userId: user.id, action: "update", entity: "knowledge", entityId: e.id, entityLabel: e.title, summary: `社内資料をまとめて変更 (${BULK_LABEL[op]}: ${e.title})`, changes });
      changed++;
    }
    return { changed, skipped };
  });
  revalidatePath(BACK);
  const note = r.skipped.length ? ` 変えられなかった資料 ${r.skipped.length} 件: ${r.skipped.slice(0, 3).join("、")}${r.skipped.length > 3 ? " ほか" : ""}` : "";
  redirect(withMsg(back, `${r.changed} 件の資料を変更しました (${BULK_LABEL[op]})。${note}`));
}

const BULK_LABEL: Record<BulkOp, string> = { confirm: "内容を確認した", owner: "担当者", visibility: "見られる人", category: "分類", interval: "確かめる間隔", due: "次に確かめる日", activate: "AI に使う", deactivate: "AI に使わない" };

/** 1 件に当てはめる。変えられないときは理由を返す */
function applyBulk(op: BulkOp, value: string, interval: number | undefined, e: KnowledgeEntry, s: KnowledgeReviewSettings, db: Database, user: User): string | undefined {
  switch (op) {
    case "confirm":
      Object.assign(e, confirmedPatch(s, e, user.id));
      return;
    case "owner":
      if (!ownerCandidates(db, e).some((u) => u.id === value)) return "担当者がこの資料を見られません";
      e.ownerId = value;
      return;
    case "visibility": {
      const v = value as KnowledgeVisibility;
      const owner = e.ownerId ? db.users.find((u) => u.id === e.ownerId) : undefined;
      if (owner && !canViewKnowledge(owner, { visibility: v })) return "今の担当者が見られない範囲です。先に担当者を変えてください";
      e.visibility = v;
      return;
    }
    case "category":
      if (e.source === "sheet") return "スプレッドシートの資料はシートで変えてください";
      e.category = value.slice(0, 40);
      return;
    case "interval": {
      e.reviewIntervalDays = interval;
      // 次に確かめる日を、最後に確かめた日 (なければ登録日) + 新しい間隔にする
      const base = (e.reviewedAt ?? e.createdAt).slice(0, 10);
      e.reviewDue = addDays(isDate(base) ? base : todayKey(), entryInterval(s, e));
      return;
    }
    case "due":
      e.reviewDue = value;
      return;
    case "activate":
      e.active = true;
      return;
    case "deactivate":
      e.active = false;
      return;
  }
}

/* ================================================================== */
/* 確認のルール (分類ごとの間隔・既定の担当者)                               */
/* ================================================================== */

export async function saveKnowledgeReviewRules(formData: FormData) {
  const user = await requireActionUser();
  if (!canManageKnowledgeSources(user)) fail(BACK, "確認のルールは本部スタッフ・管理者が設定します。");
  const db0 = getDb();
  const before = reviewSettings(db0);
  const defaultOwnerId = str(formData, "defaultOwnerId");
  if (defaultOwnerId && !ownerCandidates(db0).some((u) => u.id === defaultOwnerId)) fail(BACK, "既定の担当者には、社内資料を編集できる有効な社員を選んでください。");
  const days = (k: string, d: number) => {
    const n = Number(str(formData, k));
    return Number.isFinite(n) && n >= 7 && n <= 1095 ? Math.round(n) : d;
  };
  const categories = [...new Set([...KNOWLEDGE_CATEGORY_HINTS, ...db0.knowledge.map((k) => k.category).filter(Boolean)])];
  const intervals: Record<string, number> = {};
  categories.forEach((c, i) => {
    if (str(formData, `ivname_${i}`) === c) intervals[c] = days(`iv_${i}`, before.intervals[c] ?? before.defaultDays);
  });
  const next: KnowledgeReviewSettings = { defaultDays: days("defaultDays", before.defaultDays), soonDays: Math.min(60, Math.max(1, days("soonDays", before.soonDays))), intervals: { ...before.intervals, ...intervals }, defaultOwnerId: defaultOwnerId || undefined };
  await mutate((db) => {
    const row = db.settings.find((s) => s.id === KNOWLEDGE_REVIEW_ID);
    const value = { ...next };
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: nowIso() });
    else db.settings.push({ id: KNOWLEDGE_REVIEW_ID, value, updatedBy: user.id, updatedAt: nowIso() });
    const changes = diffChanges({ ...before, reviewIntervals: before.intervals }, { ...next, reviewIntervals: next.intervals }, ["defaultDays", "soonDays", "defaultOwnerId", "reviewIntervals"]);
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: KNOWLEDGE_REVIEW_ID, entityLabel: "社内資料の確認のルール", summary: "社内資料の確認のルールを変更", changes });
  });
  revalidatePath(BACK);
  redirect(withMsg(`${BACK}?panel=rules`, "確認のルールを保存しました。次に「確認した」を押したときから新しい間隔を使います。"));
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
  const category = str(formData, "category").slice(0, 40);
  if (!category) fail(BACK, "分類を入力してください (ファイルに分類の列があればそちらを使います)。");
  const db0 = getDb();
  const visibility = visibilityOf(formData, user, BACK);
  const ownerId = ownerOf(db0, formData, visibility, BACK, user.id);
  const interval = intervalOf(formData);
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
    const s = reviewSettings(db);
    for (const d of drafts) {
      const cat = d.category || category;
      db.knowledge.push({ id: newId("kn"), title: d.title, body: d.body, category: cat, tags: d.tags, source: "file", sourceRef: name, active: true, createdBy: user.id, createdAt: now, updatedAt: now, visibility, ...initialReview(s, cat, { ownerId, intervalDays: interval }) });
    }
    addAudit(db, { userId: user.id, action: "import", entity: "knowledge", entityId: "file", entityLabel: name, summary: `社内資料をファイルから取込 (${name}・${drafts.length} 件・見られる人 ${KNOWLEDGE_VISIBILITY_LABEL[visibility]})` });
  });
  revalidatePath(BACK);
  redirect(withMsg(BACK, `「${name}」から ${drafts.length} 件を取り込みました。担当者・次に確かめる日も付けました。`));
}

/* ================================================================== */
/* Google スプレッドシート (一方向の同期: シート → システム)                 */
/* ================================================================== */

/** 取込元の設定 (名前・分類・新しい資料の 担当者・見られる人・間隔) */
function sourceFields(db: Database, formData: FormData, user: User, back: string): Pick<KnowledgeSheetSource, "label" | "category" | "ownerId" | "visibility" | "reviewIntervalDays"> {
  const visibility = visibilityOf(formData, user, back, "all");
  return {
    label: str(formData, "label").slice(0, 60),
    category: str(formData, "category").slice(0, 40) || "その他",
    ownerId: ownerOf(db, formData, visibility, back, user.id),
    visibility,
    reviewIntervalDays: intervalOf(formData),
  };
}

export async function addKnowledgeSource(formData: FormData) {
  const user = await requireActionUser();
  if (!canManageKnowledgeSources(user)) fail(BACK, "スプレッドシートの登録は本部スタッフ・管理者が行います。");
  await assertTable(BACK);
  const url = str(formData, "url");
  if (!sheetCsvUrl(url)) fail(BACK, "Google スプレッドシートの URL (https://docs.google.com/spreadsheets/d/…) を入力してください。");
  const f = sourceFields(getDb(), formData, user, BACK);
  const id = newId("ks");
  await mutate((db) => {
    const sources = knowledgeSources(db);
    if (sources.some((s) => s.url === url)) fail(BACK, "このシートはすでに登録されています。");
    sources.push({ id, url, ...f, label: f.label || `スプレッドシート ${sources.length + 1}` });
    saveSources(db, sources, user.id);
    addAudit(db, { userId: user.id, action: "create", entity: "knowledge", entityId: id, entityLabel: f.label || url, summary: `社内資料の取込元 (スプレッドシート) を登録 (${f.label || url})` });
  });
  revalidatePath(BACK);
  redirect(withMsg(`${sourcePath(id)}?preview=1`, "取込元を登録しました。シートの行の確認結果を見て、問題なければ「この内容で同期する」を押してください。"));
}

export async function updateKnowledgeSource(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = sourcePath(id);
  if (!canManageKnowledgeSources(user)) fail(back, "取込元の変更は本部スタッフ・管理者が行います。");
  const url = str(formData, "url");
  if (!sheetCsvUrl(url)) fail(back, "Google スプレッドシートの URL (https://docs.google.com/spreadsheets/d/…) を入力してください。");
  const f = sourceFields(getDb(), formData, user, back);
  await mutate((db) => {
    const sources = knowledgeSources(db);
    const s = sources.find((x) => x.id === id);
    if (!s) fail(BACK, "取込元が見つかりません。");
    if (sources.some((x) => x.id !== id && x.url === url)) fail(back, "このシートは別の取込元として登録されています。");
    const before = { ...s };
    Object.assign(s, { ...f, label: f.label || s.label, url });
    const changes = diffChanges(before, s, ["label", "url", "category", "ownerId", "visibility", "reviewIntervalDays"]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    saveSources(db, sources, user.id);
    addAudit(db, { userId: user.id, action: "update", entity: "knowledge", entityId: id, entityLabel: s.label, summary: `社内資料の取込元を変更 (${s.label})`, changes });
  });
  revalidatePath(BACK);
  redirect(withMsg(back, "取込元の設定を保存しました。担当者・見られる人・間隔は、次の同期で新しく増える資料に付けます。"));
}

/** 同期 (確認の画面の「この内容で同期する」・取込元の「今すぐ同期」) */
export async function syncKnowledgeSource(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = sourcePath(id);
  if (!canManageKnowledgeSources(user)) fail(back, "同期は本部スタッフ・管理者が行います。");
  const r = await syncSource(id, user.id, { trigger: "manual", expectHash: str(formData, "hash") || undefined, allowMassDelete: str(formData, "allowMassDelete") === "on" });
  revalidatePath(BACK);
  revalidatePath(back);
  redirect(r.ok ? withMsg(back, r.message) : `${back}${r.blocked ? "?preview=1&" : "?"}err=${encodeURIComponent(r.message)}`);
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
