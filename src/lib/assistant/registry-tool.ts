import "server-only";
import type { AuditAction, Database, StoreId, User } from "@/lib/db/types";
import type { ToolDef } from "@/lib/ai/provider";
import { canSeeAllStores, canViewMaterial, canViewRegistry, knowledgeVisibilities } from "@/lib/auth/permissions";
import { getChunk, getChunks, getDoc, materialsStats, openMaterials, searchMaterials, searchTerms, effVisibility, type MaterialChunk, type MaterialDoc } from "@/lib/registry/materials-db";
import { REGISTRY_CATEGORIES } from "@/lib/registry/classify";
import { activityReport, activityText } from "@/lib/registry/activity";
import { catalogText, dataCatalog, dataStores } from "@/lib/registry/catalog";
import { BACKEND, getDb } from "@/lib/db/store";

/**
 * AI アシスタントの道具: データ台帳 (クライアント資料の資料庫・全データの一覧・社内の活動)
 * ------------------------------------------------------------
 * - search_materials: クライアント資料 (マニュアル・議事録・研修・販促の計画と実績・事務の手続き・補助金・取引先の書類…) の全文検索
 * - read_material: 資料の節を全文で読む
 * - data_registry: catalog = システムの全データの一覧 (本部以上) / materials = 資料庫の中身の内訳 / activity = 社内の活動 (変更履歴の集計)
 * 見られる範囲: 資料は「見られる人」+ 店舗の資料は所属店舗だけ (canViewMaterial)。活動は変更履歴の閲覧範囲 (canViewAuditEntry)。
 * 店舗のロールに、ほかの店舗・全社の数字を出さない (お客様の決定 2026-11-20)
 */

export interface RegistryToolResult {
  text: string;
  summary: string;
  sources: { label: string; href: string; kind: string }[];
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max).trim() : undefined);
const STORE_IDS = new Set(["koshi", "chuo", "nishi", "tamana", "hq"]);
const resolveStore = (db: Database, v: unknown): StoreId | undefined => {
  const s = str(v, 40);
  if (!s) return undefined;
  if (STORE_IDS.has(s) || getDb().stores.some((x) => x.id === s)) return s as StoreId;
  return db.stores.find((x) => x.name === s || x.name.replace(/店$/, "") === s.replace(/店$/, "") || (x.shortName && x.shortName === s))?.id;
};

const docHref = (id: string) => `/registry/materials/${encodeURIComponent(id)}`;

/** 節が見られるか (資料の扱い・人が変えた見られる人・店舗) */
function chunkVisible(user: User, doc: MaterialDoc, c: Pick<MaterialChunk, "visibility">): boolean {
  if ((doc.override?.action ?? doc.action) === "exclude") return false;
  return canViewMaterial(user, { visibility: doc.override?.visibility ?? c.visibility, storeId: doc.storeId });
}

const searchMaterialsTool: ToolDef = {
  name: "search_materials",
  description:
    "クライアント (一畳屋) から受け取った資料の中身を全文検索する: 社内総合マニュアル・顧客対応マニュアル・議事録・研修・教育カリキュラムと作業手順・点検とテレアポのルール・イベント・チラシの計画と折込/ポスティングの配布・SNS・情報媒体・事務の手続き (納税・締め・書類の保管期限)・車両・縁のラインナップ・補助金の申請・取引先の請求書と契約・行政の様式など。社内のルール・手順・過去の計画・決定事項・取引先・様式の質問で使う。言葉は空白で区切る (例: \"表替え 価格\" / \"イベント 準備物\" / \"elTAX 納税\")。結果は資料名・節・抜粋・ID。全文は read_material。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "探す言葉 (空白区切り)" },
      category: { type: "string", enum: [...REGISTRY_CATEGORIES], description: "分類で絞る (任意)" },
      limit: { type: "integer", description: "件数 (既定 6、最大 12)" },
    },
    required: ["query"],
  },
};

const readMaterialTool: ToolDef = {
  name: "read_material",
  description: "search_materials で見つけた資料の節 (chunk_id) か資料 (doc_id) の全文を読む。資料のときは節の一覧と最初の節を返す。",
  parameters: {
    type: "object",
    properties: {
      chunk_id: { type: "string", description: "節の ID (search_materials の結果の chunk_id)" },
      doc_id: { type: "string", description: "資料の ID (節の一覧を見るとき)" },
    },
    required: [],
  },
};

const dataRegistryTool: ToolDef = {
  name: "data_registry",
  description:
    "データ台帳を見る。view: catalog = システムの全データの一覧 (表ごとの件数・業務の日付の範囲・最終更新・データの置き場所。「どんなデータがある？」「いつからのデータ？」。本部以上) / materials = クライアント資料の内訳 (フォルダ・分類・取込の状況) / activity = 社内の活動 (変更履歴の集計: 誰が・いつ・何を登録・変更・削除・承認・取込したか、日別・人別・対象別、最近の操作。「今週社内で何があった？」「昨日の操作」「○○さんの今月の操作」「削除された記録」)。",
  parameters: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["catalog", "materials", "activity"] },
      from: { type: "string", description: "activity: 期間の始まり YYYY-MM-DD (省略 = 7 日前)" },
      to: { type: "string", description: "activity: 期間の終わり YYYY-MM-DD (省略 = 今日)" },
      user: { type: "string", description: "activity: 社員の名前で絞る (任意)" },
      store: { type: "string", description: "activity: 店舗で絞る (任意)" },
      entity: { type: "string", description: "activity: 対象の種類で絞る (customer・inquiry・quote・order・invoice・payment・schedule・expense・purchase・approval・knowledge・user・settings など。任意)" },
      action: { type: "string", enum: ["create", "update", "delete", "approve", "reject", "submit", "send", "status", "login", "export", "import"], description: "activity: 操作の種類で絞る (任意)" },
      q: { type: "string", description: "activity: 要約・対象の名前の言葉 (任意)" },
    },
    required: ["view"],
  },
};

function runSearch(db: Database, user: User, a: Record<string, unknown>): RegistryToolResult {
  const mdb = openMaterials();
  const q = str(a.query, 300) ?? "";
  if (!mdb) return { text: "資料庫がまだありません (クライアント資料の読み取りが済んでいません)。", summary: `${q} → 資料庫なし`, sources: [] };
  const category = str(a.category, 40);
  const limit = Math.max(1, Math.min(12, Number(a.limit) || 6));
  const hits = searchMaterials(mdb, q, {
    visibilities: knowledgeVisibilities(user),
    limit: limit * 2,
    category: category && (REGISTRY_CATEGORIES as readonly string[]).includes(category) ? category : undefined,
    storeId: canSeeAllStores(user) ? undefined : user.storeId,
  }).filter((h) => chunkVisible(user, h.doc, h.chunk));
  const top = hits.slice(0, limit);
  if (!top.length) return { text: `資料庫に「${q}」に当てはまる資料はありませんでした (見られる範囲の資料だけを探しています)。言葉を短く・言い換えてもう一度探すか、search_guides (社内資料・使い方) も見てください。`, summary: `${q} → 0 件`, sources: [] };
  const text = [
    `資料庫の検索「${q}」: ${top.length} 件 (クライアント資料。見られる範囲だけ)`,
    ...top.map((h) => {
      const d = h.doc;
      const where = `${d.folderLabel || d.folder}/${d.path}`;
      return `### ${h.chunk.head} [開く](${docHref(d.id)})\n- chunk_id: ${h.chunk.id} / 資料: ${where} / 分類: ${h.chunk.category || d.category}${h.chunk.recordDate ? ` / 日付: ${h.chunk.recordDate}` : ""}${d.knowledgeIds.length ? " / 社内資料にも登録済み" : ""}\n- 抜粋: ${h.snippet}`;
    }),
    "",
    "必要なら read_material (chunk_id) で全文を読んでから答える。回答には資料名と [開く] のリンクを添える。",
  ].join("\n");
  return {
    text,
    summary: `${q} → ${top.length} 件`,
    sources: [...new Map(top.map((h) => [h.doc.id, { label: h.doc.name, href: docHref(h.doc.id), kind: "資料庫" }])).values()].slice(0, 4),
  };
}

function runRead(user: User, a: Record<string, unknown>): RegistryToolResult {
  const mdb = openMaterials();
  if (!mdb) return { text: "資料庫がまだありません。", summary: "資料庫なし", sources: [] };
  const chunkId = str(a.chunk_id, 120);
  const docId = str(a.doc_id, 120) ?? chunkId?.split(":")[0];
  const doc = docId ? getDoc(mdb, docId) : undefined;
  if (!doc) return { text: "その資料は見つかりません。search_materials の結果の chunk_id か doc_id を使ってください。", summary: "見つからない", sources: [] };
  const chunks = getChunks(mdb, doc.id).filter((c) => chunkVisible(user, doc, c));
  if (!chunks.length) return { text: "この資料は見られる範囲の外か、中身がありません。", summary: `${doc.name} → 範囲外`, sources: [] };
  const chunk = chunkId ? (getChunk(mdb, chunkId) ?? chunks[0]) : chunks[0];
  if (!chunkVisible(user, doc, chunk)) return { text: "この節は見られる範囲の外です。", summary: `${doc.name} → 範囲外`, sources: [] };
  const list = chunks.slice(0, 60).map((c) => `${c.id}: ${c.section || "(本文)"}${c.parts > 1 ? ` (${c.part}/${c.parts})` : ""}`);
  return {
    text: [
      `## 資料: ${doc.name} [開く](${docHref(doc.id)})`,
      `場所: ${doc.folderLabel || doc.folder}/${doc.path} / 分類: ${doc.override?.category ?? doc.category} / 見られる人: ${effVisibility(doc)}${doc.recordDate ? ` / 日付: ${doc.recordDate}` : ""}${doc.note ? ` / ${doc.note}` : ""}`,
      "",
      `### 節: ${chunk.head}`,
      chunk.body,
      "",
      chunks.length > 1 ? `### この資料の節 (chunk_id: 名前)\n${list.join("\n")}${chunks.length > 60 ? `\n… ほか ${chunks.length - 60} 節` : ""}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    summary: `${doc.name}${chunk.section ? ` ${chunk.section}` : ""}`,
    sources: [{ label: doc.name, href: docHref(doc.id), kind: "資料庫" }],
  };
}

async function runRegistry(db: Database, user: User, a: Record<string, unknown>, now: Date): Promise<RegistryToolResult> {
  const view = str(a.view, 20);
  if (view === "activity") {
    const name = str(a.user, 40)?.replace(/\s|　|さん|様/g, "");
    const target = name ? db.users.find((u) => u.name.replace(/\s|　/g, "").includes(name)) : undefined;
    if (name && !target) return { text: `「${a.user}」という社員が見つかりません。`, summary: "社員なし", sources: [] };
    const storeId = resolveStore(db, a.store);
    if (storeId && !canSeeAllStores(user) && storeId !== user.storeId) {
      return { text: "ほかの店舗の活動は、閲覧の権限の範囲外のため見られません (自店舗と本人の操作だけ)。", summary: "範囲外の店舗", sources: [] };
    }
    const r = activityReport(db, user, { from: str(a.from, 10), to: str(a.to, 10), userId: target?.id, storeId, entity: str(a.entity, 40), action: str(a.action, 20) as AuditAction | undefined, q: str(a.q, 80), limit: 40 }, now);
    return { text: activityText(r, { recent: 20 }), summary: `活動 ${r.from}〜${r.to}${target ? ` ${target.name}` : ""} → ${r.total} 件`, sources: [{ label: "変更履歴", href: "/audit", kind: "活動" }] };
  }
  if (view === "catalog") {
    if (!canViewRegistry(user)) return { text: "全データの一覧は本部・管理者が見られます (店舗のロールは見られません)。自店舗のデータの件数は analyze か query_database で数えてください。", summary: "権限なし", sources: [] };
    const cat = dataCatalog(db);
    const { stores, materials } = await dataStores(db, BACKEND);
    return { text: catalogText(cat, stores, materials), summary: `全データ ${cat.tables.length} 表・${cat.totalRows.toLocaleString()} 行`, sources: [{ label: "データ台帳", href: "/registry", kind: "データ台帳" }] };
  }
  if (view === "materials") {
    const mdb = openMaterials();
    if (!mdb) return { text: "資料庫がまだありません。", summary: "資料庫なし", sources: [] };
    const s = materialsStats(mdb);
    if (!canViewRegistry(user)) {
      // 店舗のロール: 見られる資料の件数だけ (全体の内訳は出さない)
      const vis = knowledgeVisibilities(user);
      const n = Number(mdb.prepare(`select count(*) n from docs where coalesce(o_action, action) in ('knowledge','materials') and coalesce(o_visibility, visibility) in (${vis.map(() => "?").join(",")}) and (store_id is null or store_id = ?)`).get(...vis, user.storeId)?.n ?? 0);
      return { text: `あなたが見られるクライアント資料は ${n} 件です (資料庫)。中身は search_materials で探せます。`, summary: `見られる資料 ${n} 件`, sources: [] };
    }
    const text = [
      "## クライアント資料 (資料庫)",
      `- ${s.docs} 件・節 ${s.chunks}・${s.chars.toLocaleString()} 文字 (同じ内容のファイル ${s.duplicates} 件は 1 件にまとめて保存)`,
      `- 扱い: 社内資料に登録 ${s.byAction.knowledge ?? 0}・資料庫 ${s.byAction.materials ?? 0}・システムのデータに取込済み ${s.byAction.structured ?? 0}・写真など ${s.byAction.ledger ?? 0}・取り込まない (個人情報) ${s.byAction.exclude ?? 0}`,
      `- 状態: 文字あり ${s.byStatus.ok ?? 0}・文字なし ${s.byStatus.empty ?? 0}・読めない ${s.byStatus.error ?? 0}・取り込まない ${s.byStatus.skipped ?? 0}`,
      `- フォルダ: ${s.byFolder.map((f) => `${f.label || f.folder} ${f.docs}`).join("・")}`,
      `- 分類: ${s.byCategory.map((c) => `${c.category} ${c.docs}`).join("・")}`,
      s.lastScan ? `- 最後の読み取り: ${s.lastScan.at.slice(0, 16).replace("T", " ")} UTC` : "",
      "詳しくは [データ台帳](/registry?tab=materials)",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, summary: `資料庫 ${s.docs} 件`, sources: [{ label: "データ台帳", href: "/registry?tab=materials", kind: "データ台帳" }] };
  }
  return { text: "view は catalog・materials・activity のどれかです。", summary: "view の誤り", sources: [] };
}

export const registryTools: { def: ToolDef; label: string; run: (db: Database, user: User, a: Record<string, unknown>, now: Date) => Promise<RegistryToolResult> | RegistryToolResult }[] = [
  { def: searchMaterialsTool, label: "資料庫の検索", run: (db, user, a) => runSearch(db, user, a) },
  { def: readMaterialTool, label: "資料を読む", run: (_db, user, a) => runRead(user, a) },
  { def: dataRegistryTool, label: "データ台帳", run: runRegistry },
];

/**
 * 「使い方・社内資料」(search_guides) に添える資料庫の候補 (AI が search_materials を選ばなくても、クライアント資料が目に入るように)。
 * 社内資料に登録済みの節は社内資料のほうに出るので除く
 */
export function materialsForGuides(user: User, query: string, limit = 3): { text: string; sources: RegistryToolResult["sources"] } | null {
  const mdb = openMaterials();
  if (!mdb || !query.trim()) return null;
  const terms = searchTerms(query).length || 1;
  // はっきり当てはまるもの (質問の言葉の 6 割以上) だけ。使い方の質問に関係の薄い資料を混ぜない
  const hits = searchMaterials(mdb, query, { visibilities: knowledgeVisibilities(user), limit: limit * 3, storeId: canSeeAllStores(user) ? undefined : user.storeId })
    .filter((h) => chunkVisible(user, h.doc, h.chunk) && !(h.chunk.knowledge && h.doc.knowledgeIds.length) && h.matched.length / terms >= 0.6)
    .slice(0, limit);
  if (!hits.length) return null;
  return {
    text: [
      "## クライアント資料 (資料庫。全文は read_material の chunk_id で読む)",
      ...hits.map((h) => `### ${h.chunk.head} [開く](${docHref(h.doc.id)})\n- chunk_id: ${h.chunk.id}${h.chunk.recordDate ? ` / 日付: ${h.chunk.recordDate}` : ""}\n- 抜粋: ${h.snippet}`),
    ].join("\n"),
    sources: [...new Map(hits.map((h) => [h.doc.id, { label: h.doc.name, href: docHref(h.doc.id), kind: "資料庫" }])).values()],
  };
}
