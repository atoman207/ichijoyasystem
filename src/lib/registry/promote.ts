import type { Database, KnowledgeEntry, KnowledgeVisibility } from "@/lib/db/types";
import { effAction, effCategory, getChunks, getDoc, type MaterialChunk, type MaterialDoc, type MaterialsSqlite } from "./materials-db";

/**
 * データ台帳: 資料の節を社内資料 (knowledge) に登録する
 * ------------------------------------------------------------
 * 社内資料は Supabase に入り、AI アシスタントの「使い方・社内資料」(search_guides)・横断検索・SQL (v_knowledge) が最優先で使う。
 * 1 つの節 (シート・会議) = 社内資料 1 件。長い節は 8,000 文字ごとに分ける。
 * 取込元は sourceRef = material:<資料の ID>#<節の番号>[.<分けた番号>]。同じ資料を読み直すと、同じ sourceRef の資料を更新し、なくなった節は消す。
 * 画面の操作 (src/lib/actions/registry.ts) とスクリプト (scripts/registry/promote-knowledge.mjs) が使う
 */

export const KNOWLEDGE_ENTRY_MAX = 8000;
const MAX_PARTS = 6;
export const MATERIAL_REF_PREFIX = "material:";

export interface MaterialKnowledgeDraft {
  sourceRef: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  visibility: KnowledgeVisibility;
  recordDate?: string;
}

const STORE_NAME: Record<string, string> = { koshi: "合志店", chuo: "中央店", nishi: "西店", tamana: "玉名店", hq: "本部" };

/** 資料の社内資料の下書き (登録しない扱いのときは空) */
export function knowledgeDrafts(doc: MaterialDoc, chunks: MaterialChunk[]): MaterialKnowledgeDraft[] {
  if (effAction(doc) !== "knowledge" || doc.duplicateOf) return [];
  const picked = chunks.filter((c) => c.knowledge);
  if (!picked.length) return [];
  // 節ごとにまとめ直す (分けた part をつなぐ)
  const groups: { first: MaterialChunk; text: string }[] = [];
  for (const c of picked) {
    const last = groups[groups.length - 1];
    if (last && c.part > 1 && last.first.section === c.section) last.text += `\n${c.body}`;
    else groups.push({ first: c, text: c.body });
  }
  const baseName = doc.name.replace(/\.[^.]+$/, "");
  const single = new Set(picked.map((c) => c.section)).size === 1 && !picked[0].section;
  const out: MaterialKnowledgeDraft[] = [];
  for (const g of groups) {
    const section = g.first.section.trim();
    const titleBase = single || !section ? baseName : `${baseName}「${section}」`;
    const source = `出典: クライアント資料「${doc.folder ? `${doc.folder}/` : ""}${doc.path}」${section ? ` の「${section}」` : ""}`;
    const pieces: string[] = [];
    let rest = g.text.trim();
    while (rest && pieces.length < MAX_PARTS) {
      if (rest.length <= KNOWLEDGE_ENTRY_MAX) {
        pieces.push(rest);
        break;
      }
      let cut = rest.lastIndexOf("\n", KNOWLEDGE_ENTRY_MAX);
      if (cut < KNOWLEDGE_ENTRY_MAX / 2) cut = KNOWLEDGE_ENTRY_MAX;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    const truncated = Boolean(rest) && pieces.length >= MAX_PARTS && rest.length > pieces[pieces.length - 1].length;
    pieces.forEach((body, i) => {
      if (body.length < 30) return;
      const n = pieces.length;
      out.push({
        sourceRef: `${MATERIAL_REF_PREFIX}${doc.id}#${g.first.seq}${n > 1 ? `.${i + 1}` : ""}`,
        title: `${titleBase}${n > 1 ? ` (${i + 1}/${n})` : ""}`.slice(0, 200),
        body: `${source}${n > 1 ? ` (${i + 1}/${n})` : ""}\n\n${body}${truncated && i === n - 1 ? "\n…(続きはデータ台帳の資料庫にあります)" : ""}`,
        category: doc.override?.category ?? g.first.category ?? effCategory(doc),
        tags: [...new Set(["クライアント資料", doc.folderLabel || doc.folder, doc.storeId ? STORE_NAME[doc.storeId] : ""].filter(Boolean))],
        visibility: doc.override?.visibility ?? g.first.visibility,
        recordDate: g.first.recordDate ?? doc.recordDate,
      });
    });
  }
  return out;
}

export interface PromoteCtx {
  userId: string;
  now: string;
  newId: () => string;
  /** 新しく登録する資料の 担当者・次に確かめる日・間隔 (knowledge-review.ts の initialReview)。登録済みの資料の値は変えない */
  review?: (d: MaterialKnowledgeDraft) => Pick<KnowledgeEntry, "ownerId" | "reviewDue" | "reviewIntervalDays">;
}

export interface PromoteResult {
  added: number;
  updated: number;
  removed: number;
  ids: string[];
}

/**
 * 1 つの資料の社内資料を、下書きのとおりにそろえる (同じ sourceRef は更新・増えたものは追加・なくなったものは削除)。
 * 画面で直接直した社内資料も、資料を読み直すと資料の内容に戻る (資料を正とする)。止めた (active = false) ものは止めたまま
 */
export function applyKnowledgeDrafts(
  db: Pick<Database, "knowledge">,
  docId: string,
  drafts: MaterialKnowledgeDraft[],
  ctx: PromoteCtx,
): PromoteResult {
  const prefix = `${MATERIAL_REF_PREFIX}${docId}#`;
  const existing = new Map(db.knowledge.filter((k) => k.sourceRef?.startsWith(prefix)).map((k) => [k.sourceRef!, k]));
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  const ids: string[] = [];
  for (const d of drafts) {
    if (seen.has(d.sourceRef)) continue;
    seen.add(d.sourceRef);
    const cur = existing.get(d.sourceRef);
    const next: Pick<KnowledgeEntry, "title" | "body" | "category" | "tags" | "visibility" | "recordDate"> = { title: d.title, body: d.body, category: d.category, tags: d.tags, visibility: d.visibility, recordDate: d.recordDate };
    if (cur) {
      ids.push(cur.id);
      const changed = cur.title !== next.title || cur.body !== next.body || cur.category !== next.category || cur.tags.join(",") !== next.tags.join(",") || (cur.visibility ?? "all") !== next.visibility || (cur.recordDate ?? "") !== (next.recordDate ?? "");
      if (changed) {
        Object.assign(cur, next, { updatedBy: ctx.userId, updatedAt: ctx.now });
        updated++;
      }
    } else {
      const id = ctx.newId();
      ids.push(id);
      db.knowledge.push({ id, ...next, source: "file", sourceRef: d.sourceRef, active: true, createdBy: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now, ...(ctx.review?.(d) ?? {}) });
      added++;
    }
  }
  const stale = [...existing.entries()].filter(([ref]) => !seen.has(ref)).map(([, k]) => k.id);
  if (stale.length) {
    const drop = new Set(stale);
    db.knowledge = db.knowledge.filter((k) => !drop.has(k.id));
  }
  return { added, updated, removed: stale.length, ids };
}

/** 社内資料がどの資料から来たか (material:<ID>#… → ID) */
export function materialIdOf(k: Pick<KnowledgeEntry, "sourceRef">): string | undefined {
  if (!k.sourceRef?.startsWith(MATERIAL_REF_PREFIX)) return undefined;
  return k.sourceRef.slice(MATERIAL_REF_PREFIX.length).split("#")[0] || undefined;
}

/**
 * 資料庫の全部 (または指定の資料) について、社内資料をそろえる。
 * 社内資料に登録しない扱いになった資料・資料庫からなくなった資料の社内資料は消す。
 * 資料庫の knowledge_ids は呼び出し側が保存のあとに setKnowledgeIds で書く (保存に失敗したときに食い違わないように)
 */
export function promoteFromMaterials(
  db: Pick<Database, "knowledge">,
  mdb: MaterialsSqlite,
  ctx: PromoteCtx,
  opts: { docIds?: string[] } = {},
): PromoteResult & { perDoc: Map<string, string[]>; docs: number } {
  const total: PromoteResult = { added: 0, updated: 0, removed: 0, ids: [] };
  const perDoc = new Map<string, string[]>();
  const want = opts.docIds ? new Set(opts.docIds) : undefined;
  const ids = new Set<string>(
    mdb
      .prepare("select id from docs where duplicate_of is null and (coalesce(o_action, action) = 'knowledge' or coalesce(knowledge_ids, '[]') != '[]')")
      .all()
      .map((r) => String(r.id)),
  );
  // 社内資料にあるのに資料庫で対象でない (扱いを変えた・なくなった) もの
  for (const k of db.knowledge) {
    const id = materialIdOf(k);
    if (id) ids.add(id);
  }
  let docs = 0;
  for (const id of ids) {
    if (want && !want.has(id)) continue;
    const doc = getDoc(mdb, id);
    const drafts = doc ? knowledgeDrafts(doc, getChunks(mdb, id)) : [];
    const r = applyKnowledgeDrafts(db, id, drafts, ctx);
    total.added += r.added;
    total.updated += r.updated;
    total.removed += r.removed;
    total.ids.push(...r.ids);
    if (doc) perDoc.set(id, r.ids);
    docs++;
  }
  return { ...total, perDoc, docs };
}
