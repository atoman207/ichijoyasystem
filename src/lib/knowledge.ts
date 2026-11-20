import type { Database, KnowledgeEntry } from "@/lib/db/types";

/**
 * 社内資料 (ナレッジ)
 * ------------------------------------------------------------
 * AI アシスタントが回答の根拠に使う資料。画面で登録するほか、Google スプレッドシート (指定したシート) と
 * ファイル (テキスト・CSV・PDF) から取り込む。
 * 検索は日本語向けの簡易な方式: 文字の 2 文字ずつの組 (bigram) と英数字の単語で、質問と資料の重なりを数える。
 * タイトル・タグに当たったものを重く、どの資料にもある言葉は軽く数える (IDF)
 */

export const KNOWLEDGE_SOURCES_ID = "knowledge_sources";

/** 同期する Google スプレッドシート (設定に保存) */
export interface KnowledgeSheetSource {
  id: string;
  label: string;
  url: string;
  /** シートに「分類」の列がないときの分類 */
  category: string;
  lastSyncedAt?: string;
  lastResult?: string;
  lastCount?: number;
  lastError?: string;
}

export function knowledgeSources(db: Pick<Database, "settings">): KnowledgeSheetSource[] {
  const v = db.settings.find((s) => s.id === KNOWLEDGE_SOURCES_ID)?.value as { sources?: KnowledgeSheetSource[] } | undefined;
  return Array.isArray(v?.sources) ? v!.sources.filter((s) => s && s.id && s.url) : [];
}

export const KNOWLEDGE_CATEGORY_HINTS = ["商品・価格", "施工・作業手順", "お客様対応", "社内ルール", "議事録・決定事項", "マニュアル", "過去の対応事例", "よくある質問", "協力業者・仕入先", "その他"];
/** 相談の回答から登録する資料の分類 */
export const KNOWLEDGE_FAQ_CATEGORY = "よくある質問";
/** 分類が議事録のとき、本文の欄に出すひな形 */
export const MINUTES_TEMPLATE = "会議名: \n日時: \n参加者: \n\n■ 議題\n・\n\n■ 決定事項\n・\n\n■ 宿題 (担当・期限)\n・\n";
export const KNOWLEDGE_VISIBILITY_LABEL = { all: "全員", manager: "店長・本部・管理者", hq: "本部・管理者", admin: "管理者のみ" } as const;

/* ================================================================== */
/* 検索                                                                 */
/* ================================================================== */

const JA = /[぀-ヿ㐀-鿿豈-﫿々〆ー]+/g;
const WORD = /[a-z0-9]+(?:[-.][a-z0-9]+)*/g;
const STOP = new Set(["して", "した", "する", "です", "ます", "ください", "について", "とは", "どう", "なに", "何で", "教え", "えて", "てく", "くだ", "ださ", "さい", "ですか", "ますか", "ての", "いて", "った", "って", "ない", "ある", "いる", "れる", "られ", "こと", "もの", "ため", "よう", "など"]);

/** 文字列を検索用の語 (2 文字の組・英数字の単語) にする */
export function tokens(text: string): string[] {
  const t = text.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  for (const run of t.match(JA) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  for (const w of t.match(WORD) ?? []) if (w.length >= 2 || /\d/.test(w)) out.push(w);
  return out.filter((x) => !STOP.has(x));
}

interface Indexed {
  entry: KnowledgeEntry;
  title: Set<string>;
  tags: Set<string>;
  body: Map<string, number>;
}

let cache: { key: string; docs: Indexed[]; df: Map<string, number> } | undefined;

function index(entries: KnowledgeEntry[]) {
  const key = entries.map((e) => `${e.id}@${e.updatedAt}`).join("|");
  if (cache?.key === key) return cache;
  const df = new Map<string, number>();
  const docs = entries.map((entry) => {
    const title = new Set(tokens(entry.title));
    const tags = new Set(tokens([entry.category, ...entry.tags].join(" ")));
    const body = new Map<string, number>();
    for (const t of tokens(entry.body)) body.set(t, (body.get(t) ?? 0) + 1);
    for (const t of new Set([...title, ...tags, ...body.keys()])) df.set(t, (df.get(t) ?? 0) + 1);
    return { entry, title, tags, body };
  });
  cache = { key, docs, df };
  return cache;
}

/** 質問にはっきり当てはまる資料 (タイトル・タグで当たり、質問の語の半分以上を含む)。ルールの回答より先に使う */
export const isStrongHit = (h: { score: number; coverage: number } | undefined) => Boolean(h && h.score >= 10 && h.coverage >= 0.5);

export interface KnowledgeHit {
  entry: KnowledgeEntry;
  score: number;
  /** 質問の語のうち、資料に含まれていた割合 */
  coverage: number;
  snippet: string;
}

/** 本文から、質問の語が多く含まれるあたりを抜き出す */
function snippetOf(body: string, q: Set<string>, size = 160): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= size) return flat;
  const norm = flat.normalize("NFKC").toLowerCase();
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i < norm.length - 1; i += 8) {
    const win = norm.slice(i, i + size);
    let n = 0;
    for (const t of q) if (win.includes(t)) n++;
    if (n > best) {
      best = n;
      bestAt = i;
    }
  }
  const start = Math.max(0, bestAt - 20);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + size)}${start + size < flat.length ? "…" : ""}`;
}

/**
 * AI に渡す本文: 短ければ全文、長ければ冒頭 (出典・見出し) と、質問の言葉が多く含まれるあたり。
 * 長い資料 (マニュアルのシート・議事録) の後ろの方に答えがあるときに、先頭だけを渡して見落とさないように
 */
export function knowledgeExcerpt(body: string, query: string, size = 2500): string {
  if (body.length <= size) return body;
  const head = body.slice(0, Math.min(300, Math.floor(size / 6)));
  const q = new Set(tokens(query));
  if (!q.size) return `${body.slice(0, size)}…`;
  const norm = body.normalize("NFKC").toLowerCase();
  const win = size - head.length - 10;
  let best = 0;
  let bestAt = head.length;
  for (let i = head.length; i < norm.length; i += 100) {
    const part = norm.slice(i, i + win);
    let n = 0;
    for (const t of q) if (part.includes(t)) n++;
    if (n > best) {
      best = n;
      bestAt = i;
    }
  }
  // 行の頭にそろえる
  const lineStart = body.lastIndexOf("\n", bestAt);
  const start = lineStart > head.length && bestAt - lineStart < 200 ? lineStart + 1 : bestAt;
  if (start <= head.length) return `${body.slice(0, size)}…`;
  return `${head}\n…\n${body.slice(start, start + win)}${start + win < body.length ? "…" : ""}`;
}

export function searchKnowledge(entries: KnowledgeEntry[], query: string, opts: { limit?: number; minCoverage?: number } = {}): KnowledgeHit[] {
  const active = entries.filter((e) => e.active);
  if (!active.length || !query.trim()) return [];
  const q = new Set(tokens(query));
  if (!q.size) return [];
  const { docs, df } = index(active);
  const n = docs.length;
  // ひらがなだけの組 (「てい」「いま」など送り仮名・助詞) は軽く数える。「さくら」「ふすま」のような言葉もあるため除きはしない
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0))) * (/^[぀-ゟ]+$/.test(t) ? 0.35 : 1);
  // 割合は「どれかの資料に出てくる語」で数える (「える」「は何」のような、どの資料にもない語で薄めない)
  const qWeight = [...q].filter((t) => df.has(t)).reduce((a, t) => a + idf(t), 0) || 1;
  const hits: KnowledgeHit[] = [];
  const flatQuery = query.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const t of q) {
      const inTitle = d.title.has(t);
      const inTags = d.tags.has(t);
      const inBody = d.body.get(t) ?? 0;
      if (!inTitle && !inTags && !inBody) continue;
      matched += idf(t);
      score += idf(t) * ((inTitle ? 3 : 0) + (inTags ? 2 : 0) + Math.min(3, Math.log2(1 + inBody)));
    }
    if (!score) continue;
    // タイトルそのものが質問に含まれている (例: 「支払方法」について) ときは強く当てる
    const title = d.entry.title.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    if (title.length >= 2 && flatQuery.includes(title)) score += 10;
    hits.push({ entry: d.entry, score, coverage: matched / qWeight, snippet: snippetOf(d.entry.body, q) });
  }
  const min = opts.minCoverage ?? 0.25;
  // 本文に 1 語だけ当たったもの (スコア 3 未満) は除く。タイトル・タグに当たったものは残す
  return hits
    .filter((h) => (h.coverage >= min && h.score >= 3) || h.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);
}

/* ================================================================== */
/* 取込 (スプレッドシート・CSV・テキスト)                                  */
/* ================================================================== */

export interface KnowledgeDraft {
  title: string;
  body: string;
  category?: string;
  tags: string[];
}

const HEAD = {
  title: /^(タイトル|題名|見出し|項目|質問|問い?|q|title|question|subject|件名|名称|商品名)$/i,
  body: /^(内容|本文|回答|答え?|説明|詳細|a|answer|body|content|text|description)$/i,
  category: /^(分類|カテゴリー?|区分|種別|category|type)$/i,
  tags: /^(タグ|キーワード|tags?|keywords?)$/i,
};

export const splitTags = (v: string) => [...new Set(v.split(/[,、，;；\s]+/).map((t) => t.trim()).filter(Boolean))].slice(0, 20);

/**
 * 表 (1 行目が見出し) を資料の一覧にする。見出しが分からないときは 1 列目をタイトル、2 列目を内容として読む。
 * 内容の列が複数あるとき (例: 商品名・価格・説明) は「見出し: 値」をつないで本文にする
 */
export function parseKnowledgeRows(rows: string[][]): KnowledgeDraft[] {
  const clean = rows.map((r) => r.map((c) => (c ?? "").trim())).filter((r) => r.some(Boolean));
  if (!clean.length) return [];
  const head = clean[0];
  let ti = head.findIndex((h) => HEAD.title.test(h));
  let bi = head.findIndex((h) => HEAD.body.test(h));
  const ci = head.findIndex((h) => HEAD.category.test(h));
  const gi = head.findIndex((h) => HEAD.tags.test(h));
  const hasHeader = ti >= 0 || bi >= 0;
  if (!hasHeader) {
    ti = 0;
    bi = 1;
  }
  if (ti < 0) ti = head.findIndex((_, i) => i !== bi && i !== ci && i !== gi);
  const extra = head.map((_, i) => i).filter((i) => i !== ti && i !== bi && i !== ci && i !== gi);
  const out: KnowledgeDraft[] = [];
  for (const r of hasHeader ? clean.slice(1) : clean) {
    const title = (r[ti] ?? "").slice(0, 200);
    const parts = [bi >= 0 ? r[bi] : "", ...(hasHeader ? extra.filter((i) => r[i]).map((i) => `${head[i] || `列${i + 1}`}: ${r[i]}`) : extra.filter((i) => r[i]).map((i) => r[i]))].filter(Boolean);
    const body = parts.join("\n").slice(0, 20000);
    if (!title && !body) continue;
    out.push({ title: title || body.slice(0, 40), body: body || title, category: ci >= 0 ? r[ci] || undefined : undefined, tags: gi >= 0 ? splitTags(r[gi] ?? "") : [] });
  }
  return out;
}

/** テキスト・Markdown: 見出し (# / ■ / 【】) ごとに分ける。見出しがなければ 1 件 */
export function parseKnowledgeText(fileName: string, text: string): KnowledgeDraft[] {
  const base = fileName.replace(/\.[^.]+$/, "").slice(0, 100) || "資料";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: KnowledgeDraft[] = [];
  let cur: KnowledgeDraft | undefined;
  const heading = /^\s*(#{1,3}\s+|■\s*|◆\s*|【)(.+?)(】)?\s*$/;
  for (const line of lines) {
    const m = line.match(heading);
    if (m && m[2].trim().length <= 80) {
      if (cur && (cur.body.trim() || cur.title)) sections.push(cur);
      cur = { title: m[2].replace(/】$/, "").trim(), body: "", tags: [] };
      continue;
    }
    if (!cur) cur = { title: base, body: "", tags: [] };
    cur.body += `${line}\n`;
  }
  if (cur) sections.push(cur);
  return sections
    .map((s) => ({ ...s, body: s.body.trim().slice(0, 20000) }))
    .filter((s) => s.body || s.title !== base)
    .map((s) => (sections.length > 1 && s.title !== base ? { ...s, title: `${s.title}`.slice(0, 200), tags: [base] } : s));
}
