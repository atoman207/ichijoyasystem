import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "@/lib/db/types";
import { TABLES } from "@/lib/db/schema";
import { mirrorStatus } from "@/lib/datastore/mirror";
import { storageStats } from "@/lib/storage";
import { chatbotDb, chatbotDbPath } from "@/lib/chatbot/store";
import { materialsPath, materialsStats, openMaterials, recentRuns, type MaterialsStats } from "./materials-db";

/**
 * データ台帳: システムの全データの一覧 (表ごとの件数・期間・最終更新) と、データフォルダーの中身
 * ------------------------------------------------------------
 * データの流れ (中央処理装置のように、すべてのデータがここを通る):
 *   入力 (画面・取込・受信・クライアント資料) → 解読 (読み取り・分類・個人情報の判定) → 記憶 (Supabase = 正本 → メモリ → VPS の写し・資料庫・ファイル)
 *   → 実行 (集計・検索・AI の道具) → 出力 (画面・AI の回答・CSV/PDF・通知)
 * データ台帳の画面 (/registry) と AI アシスタントの道具 data_registry (view = catalog) が使う。権限は呼び出し側 (canViewRegistry)
 */

export interface CatalogTable {
  table: string;
  collection: string;
  label: string;
  group: string;
  rows: number;
  /** 業務の日付の範囲 (受付日・施工日・発行日など。なければ登録日) */
  from?: string;
  to?: string;
  dateField?: string;
  /** 最後に登録・更新された日時 */
  updatedAt?: string;
}

const GROUPS: [string, RegExp][] = [
  ["営業・施工", /^(customers|inquiries|quotes|orders|schedule|surveys|surveyHistory|qualityIssues|reviews|commLogs|photoAlbums|scheduleHolds|jobSpecs|productionJobs|resourceBookings|workReportDays|promotions|products|casePosts)$/],
  ["経理", /^(invoices|payments|expenses|purchases|suppliers|purchaseOrders|cashEntries)$/],
  ["社内・事務", /^(users|stores|threads|messages|approvals|knowledge|attachments|documents|holidays|leaveRequests|leaveGrants|holidayWorks|officeImprovements|condolences|docDrafts|tidyChecks)$/],
  ["FAX・地図", /^(faxMessages|faxNumbers|map.*)$/],
  ["管理会計", /^(materials|materialCosts|boms|materialUsages|stockMoves|materialTransfers|mgmt.*|salesAdjustments|orderAttributions|expenseClasses|allocationRuns|periodCloses|purchaseLineAllocs|itemCategories|salesAreas)$/],
  ["システム", /^(auditLogs|deliveries|settings|sourceFiles)$/],
];
export const CATALOG_GROUPS = [...GROUPS.map(([g]) => g), "その他"];

const DATE_FIELDS = ["date", "salesDate", "completedOn", "contractDate", "receivedAt", "issueDate", "paidOn", "spentOn", "billedOn", "startsAt", "start", "at", "createdAt"];

const day = (v: unknown): string | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);

export function dataCatalog(db: Database): { tables: CatalogTable[]; totalRows: number } {
  const tables: CatalogTable[] = [];
  for (const t of TABLES) {
    const rows = (db as unknown as Record<string, unknown>)[t.collection];
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    const fields = new Set(t.columns.map(([c]) => c));
    const dateField = DATE_FIELDS.find((f) => fields.has(f));
    let from: string | undefined;
    let to: string | undefined;
    let updatedAt: string | undefined;
    for (const r of list) {
      const d = dateField ? day(r[dateField]) : undefined;
      if (d) {
        if (!from || d < from) from = d;
        if (!to || d > to) to = d;
      }
      const u = (r.updatedAt ?? r.createdAt ?? r.at) as string | undefined;
      if (typeof u === "string" && (!updatedAt || u > updatedAt)) updatedAt = u;
    }
    tables.push({ table: t.table, collection: t.collection, label: t.label, group: GROUPS.find(([, re]) => re.test(t.collection))?.[0] ?? "その他", rows: list.length, from, to, dateField, updatedAt });
  }
  return { tables, totalRows: tables.reduce((a, t) => a + t.rows, 0) };
}

export interface DataStore {
  key: "supabase" | "mirror" | "materials" | "source" | "sourceDb" | "chatbot" | "uploads" | "backups";
  name: string;
  role: string;
  location: string;
  status: "ok" | "warn" | "off";
  bytes?: number;
  detail: string;
}

function dirBytes(dir: string, limit = 5000): { files: number; bytes: number; latest?: string } {
  let files = 0;
  let bytes = 0;
  let latest: string | undefined;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (files >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        files++;
        bytes += st.size;
        const m = st.mtime.toISOString();
        if (!latest || m > latest) latest = m;
      }
    }
  };
  walk(dir);
  return { files, bytes, latest };
}

/** データフォルダー (VPS の /srv/ichijoya/data など) にあるものと、正本 (Supabase) */
export async function dataStores(db: Database, backend: string): Promise<{ stores: DataStore[]; materials?: MaterialsStats }> {
  const out: DataStore[] = [];
  const { totalRows } = dataCatalog(db);
  out.push({
    key: "supabase",
    name: backend === "supabase" ? "Supabase (正本)" : "サンプルデータ (JSON)",
    role: "すべての業務データの正本。アプリは起動時に読み込み、メモリに持って画面・AI に使う",
    location: backend === "supabase" ? "Supabase (PostgreSQL)" : "data/ (JSON)",
    status: "ok",
    detail: `${TABLES.length} 表・${totalRows.toLocaleString()} 行`,
  });
  try {
    const m = mirrorStatus();
    const rows = m.tables.reduce((a, t) => a + t.rows, 0);
    out.push({
      key: "mirror",
      name: "VPS のデータベース (全データの写し)",
      role: "AI アシスタントの横断検索・集計・SQL 用。正本の変更を受けて変わった行だけ書く",
      location: m.path,
      status: m.status === "ready" ? "ok" : m.status === "error" ? "warn" : "off",
      bytes: m.sizeBytes,
      detail: `${m.status === "ready" ? "同期済み" : m.status}${m.syncedAt ? ` (${m.syncedAt.slice(0, 16).replace("T", " ")} UTC)` : ""}・${rows.toLocaleString()} 行${m.error ? `・${m.error}` : ""}`,
    });
  } catch (err) {
    out.push({ key: "mirror", name: "VPS のデータベース (全データの写し)", role: "AI の検索・集計用", location: "-", status: "warn", detail: (err as Error).message });
  }
  let materials: MaterialsStats | undefined;
  const mfile = materialsPath();
  const mdb = mfile ? openMaterials(mfile) : null;
  if (mdb) {
    materials = materialsStats(mdb, mfile);
    out.push({
      key: "materials",
      name: "資料庫 (クライアント資料・追加した資料の中身)",
      role: "表計算・Word・PDF の文字を節に分けて全文検索。AI の search_materials が使う",
      location: mfile!,
      status: materials.docs ? "ok" : "warn",
      bytes: materials.fileBytes,
      detail: `${materials.docs.toLocaleString()} 件・節 ${materials.chunks.toLocaleString()}・${materials.chars.toLocaleString()} 文字・社内資料の節 ${materials.knowledgeSections}`,
    });
  } else {
    out.push({ key: "materials", name: "資料庫", role: "クライアント資料の中身", location: mfile ?? "(止めています)", status: "off", detail: "まだ作られていません (scripts/registry/scan-materials.mjs)" });
  }
  // クライアント資料のファイル (source/。読み取りのスクリプトが最後に読んだ場所。アプリ自身はファイルを読まない)
  const lastScan = mdb ? recentRuns(mdb, 50).find((r) => r.kind === "scan") : undefined;
  const srcDir = typeof lastScan?.summary.dirAbs === "string" ? lastScan.summary.dirAbs : undefined;
  if (srcDir || materials) {
    const exists = srcDir ? fs.existsSync(srcDir) : false;
    const files = Number(lastScan?.summary.files ?? 0);
    out.push({
      key: "source",
      name: "クライアント資料のフォルダー (source/)",
      role: "クライアントから受け取った資料の本体 (業務の分野ごと)。資料庫はここを読んで作る",
      location: srcDir ?? "source/ (リポジトリ直下)",
      status: exists ? "ok" : "warn",
      detail: exists ? `${files.toLocaleString()} ファイル (最後の読み取り)。決まりは source/README.md` : "最後の読み取りの場所が見つかりません (scripts/registry/scan-materials.mjs を実行してください)",
    });
  }
  // Supabase にだけ置く表 (source_items・source_texts。アプリは読み込まないので、最後に登録したときの件数)
  const lastSync = mdb ? recentRuns(mdb, 50).find((r) => r.kind === "supabase") : undefined;
  if (lastSync) {
    const n = (k: string) => Number(lastSync.summary[k] ?? 0).toLocaleString();
    out.push({
      key: "sourceDb",
      name: "Supabase: クライアント資料 (source_items・source_texts)",
      role: "source/ の全ファイル・全フォルダー (画像・動画・フォルダーは場所だけ) と文書の中身の正本。アプリはメモリに読み込まない",
      location: "Supabase (source_items・source_texts)",
      status: "ok",
      detail: `${n("items")} 行 (ファイル ${n("files")}・フォルダー ${n("folders")})・節 ${n("texts")}・${n("chars")} 文字 (${lastSync.at.slice(0, 16).replace("T", " ")} UTC に登録。scripts/registry/sync-supabase.mjs)`,
    });
  }
  try {
    const c = chatbotDb();
    const n = (sql: string) => {
      try {
        return Number(c.prepare(sql).get()?.n ?? 0);
      } catch {
        return 0;
      }
    };
    const file = chatbotDbPath();
    const size = [file, `${file}-wal`].reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
    out.push({
      key: "chatbot",
      name: "チャットボット (相談の履歴・蓄えた回答・AI の利用)",
      role: "「質問する」の履歴・回答の再利用・AI の費用の記録",
      location: file,
      status: "ok",
      bytes: size,
      detail: `蓄えた回答 ${n("select count(*) n from qa")}・相談の履歴 ${n("select count(*) n from chat_log")}・AI の呼び出し ${n("select count(*) n from ai_calls")}`,
    });
  } catch (err) {
    out.push({ key: "chatbot", name: "チャットボット", role: "相談の履歴", location: "-", status: "warn", detail: (err as Error).message });
  }
  try {
    const s = await storageStats();
    out.push({ key: "uploads", name: "ファイル (資料・写真・PDF の本体)", role: "添付ファイル・住宅地図・取込書類の本体。URL は権限を確かめてから返す", location: s.dir, status: s.writable ? "ok" : "warn", bytes: s.bytes, detail: `${s.files.toLocaleString()} ファイル${s.freeBytes ? `・空き ${(s.freeBytes / 1024 ** 3).toFixed(1)} GB` : ""}` });
  } catch (err) {
    out.push({ key: "uploads", name: "ファイル", role: "添付ファイルの本体", location: "-", status: "warn", detail: (err as Error).message });
  }
  const backupDir = process.env.BACKUP_DIR?.trim() || "/var/backups/ichijoya";
  try {
    const b = dirBytes(backupDir, 2000);
    out.push({ key: "backups", name: "バックアップ", role: "データベース・ファイル・チャットボットの毎日の控え (3:30)", location: backupDir, status: b.files ? "ok" : "warn", bytes: b.bytes, detail: `${b.files} ファイル${b.latest ? `・最新 ${b.latest.slice(0, 16).replace("T", " ")} UTC` : ""}` });
  } catch {
    out.push({ key: "backups", name: "バックアップ", role: "毎日の控え", location: backupDir, status: "off", detail: "このサーバーにはありません (読めません)" });
  }
  return { stores: out, materials };
}

/** AI に渡す文 */
export function catalogText(cat: ReturnType<typeof dataCatalog>, stores?: DataStore[], materials?: MaterialsStats): string {
  const lines = ["## システムのデータの一覧 (表ごとの件数・業務の日付の範囲・最終更新)"];
  for (const g of CATALOG_GROUPS) {
    const ts = cat.tables.filter((t) => t.group === g && t.rows > 0);
    if (!ts.length) continue;
    lines.push(`### ${g}`);
    for (const t of ts) lines.push(`- ${t.label} (${t.table}): ${t.rows.toLocaleString()} 件${t.from ? `・${t.from}〜${t.to}` : ""}${t.updatedAt ? `・最終更新 ${t.updatedAt.slice(0, 10)}` : ""}`);
  }
  const empty = cat.tables.filter((t) => t.rows === 0).map((t) => t.label.replace(/\s*\(.*$/, ""));
  if (empty.length) lines.push(`- まだ記録がない表: ${empty.join("・")}`);
  if (stores?.length) {
    lines.push("", "## データの置き場所");
    for (const s of stores) lines.push(`- ${s.name}: ${s.detail}`);
  }
  if (materials?.docs) {
    lines.push("", "## クライアント資料 (資料庫)");
    lines.push(`- ${materials.docs} 件 (文字のあるもの ${materials.byStatus.ok ?? 0}・社内資料に登録 ${materials.byAction.knowledge ?? 0}・資料庫 ${materials.byAction.materials ?? 0}・取込済みのデータ ${materials.byAction.structured ?? 0}・写真など ${materials.byAction.ledger ?? 0}・取り込まない ${materials.byAction.exclude ?? 0})`);
    lines.push(`- 分類: ${materials.byCategory.slice(0, 14).map((c) => `${c.category} ${c.docs}`).join("・")}`);
  }
  return lines.join("\n");
}
