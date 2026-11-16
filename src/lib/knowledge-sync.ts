import "server-only";
import type { Database } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { KNOWLEDGE_SOURCES_ID, knowledgeSources, parseKnowledgeRows, type KnowledgeDraft, type KnowledgeSheetSource } from "@/lib/knowledge";
import { fetchSheetCsv } from "@/lib/data-io";
import { parseCsv } from "@/lib/csv";

/**
 * 社内資料と Google スプレッドシートの同期 (画面のボタン・定期実行 /api/cron/knowledge-sync から使う)
 * 権限の確認は呼び出し側で行う
 */

export function saveSources(db: Database, sources: KnowledgeSheetSource[], userId: string) {
  const row = db.settings.find((s) => s.id === KNOWLEDGE_SOURCES_ID);
  const now = nowIso();
  if (row) Object.assign(row, { value: { sources }, updatedBy: userId, updatedAt: now });
  else db.settings.push({ id: KNOWLEDGE_SOURCES_ID, value: { sources }, updatedBy: userId, updatedAt: now });
}

const keyOf = (title: string) => title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/**
 * シートの内容で、その取込元の資料を置き換える (同じタイトルは更新、増えた行は追加、消えた行は削除)。
 * 画面で直接修正した資料もシートの内容で上書きされる (シートを正とする)
 */
export function applySheetRows(db: Database, src: KnowledgeSheetSource, drafts: KnowledgeDraft[], userId: string): { added: number; updated: number; removed: number } {
  const prefix = `sheet:${src.id}:`;
  const existing = new Map(db.knowledge.filter((k) => k.sourceRef?.startsWith(prefix)).map((k) => [k.sourceRef!.slice(prefix.length), k]));
  const seen = new Set<string>();
  const now = nowIso();
  let added = 0;
  let updated = 0;
  for (const d of drafts) {
    const key = keyOf(d.title).slice(0, 100);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cur = existing.get(key);
    const next = { title: d.title, body: d.body, category: d.category || src.category || "その他", tags: d.tags };
    if (cur) {
      if (cur.title !== next.title || cur.body !== next.body || cur.category !== next.category || cur.tags.join(",") !== next.tags.join(",") || !cur.active) {
        Object.assign(cur, next, { active: true, updatedBy: userId, updatedAt: now });
        updated++;
      }
    } else {
      db.knowledge.push({ id: newId("kn"), ...next, source: "sheet", sourceRef: `${prefix}${key}`, active: true, createdBy: userId, createdAt: now, updatedAt: now });
      added++;
    }
  }
  const stale = [...existing.entries()].filter(([k]) => !seen.has(k)).map(([, e]) => e.id);
  if (stale.length) db.knowledge = db.knowledge.filter((k) => !stale.includes(k.id));
  return { added, updated, removed: stale.length };
}

/** 1 つの取込元を同期する。結果の文を返す */
export async function syncSource(sourceId: string, userId: string): Promise<{ ok: boolean; message: string }> {
  const src = knowledgeSources(getDb()).find((s) => s.id === sourceId);
  if (!src) return { ok: false, message: "取込元が見つかりません。" };
  let drafts: KnowledgeDraft[] = [];
  let error: string | undefined;
  try {
    const { text } = await fetchSheetCsv(src.url);
    drafts = parseKnowledgeRows(parseCsv(text)).slice(0, 2000);
    if (!drafts.length) error = "シートに取り込める行がありません (1 行目に「タイトル」「内容」の見出しを入れてください)。";
  } catch (err) {
    error = (err as Error).message;
  }
  return mutate((db) => {
    const sources = knowledgeSources(db);
    const s = sources.find((x) => x.id === sourceId);
    if (!s) return { ok: false, message: "取込元が見つかりません。" };
    s.lastSyncedAt = nowIso();
    if (error) {
      s.lastError = error;
      s.lastResult = "失敗";
      saveSources(db, sources, userId);
      addAudit(db, { userId, action: "import", entity: "knowledge", entityId: s.id, entityLabel: s.label, summary: `社内資料の同期に失敗 (${s.label}: ${error.slice(0, 80)})` });
      return { ok: false, message: `「${s.label}」を同期できませんでした: ${error}` };
    }
    const r = applySheetRows(db, s, drafts, userId);
    s.lastError = undefined;
    s.lastCount = db.knowledge.filter((k) => k.sourceRef?.startsWith(`sheet:${s.id}:`)).length;
    s.lastResult = `追加 ${r.added}・更新 ${r.updated}・削除 ${r.removed}`;
    saveSources(db, sources, userId);
    addAudit(db, { userId, action: "import", entity: "knowledge", entityId: s.id, entityLabel: s.label, summary: `社内資料をスプレッドシートから同期 (${s.label}: ${s.lastResult})` });
    return { ok: true, message: `「${s.label}」を同期しました (${s.lastCount} 件。${s.lastResult})。` };
  });
}

