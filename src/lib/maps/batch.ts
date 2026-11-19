import "server-only";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Database, MapDocument, MapLocation, User } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { putObject, removeObjects, storageDir } from "@/lib/storage";
import { decodeCsv, parseCsv, toCsv } from "@/lib/csv";
import { normalizeAddress, sameAddressText, sameHouse } from "./address";
import { inspectPdf } from "./pdf";
import { mapIndex, placeOf, touchMapIndex, type ResolvedPlace } from "./resolve";
import { DEFAULT_COPYRIGHT } from "./documents";
import { ensureLocation, linkDocument } from "./store";

/**
 * 地図の一括処理 (本部スタッフ・管理者)
 * ------------------------------------------------------------
 * 1. 住所の正規化 (normalize): 顧客の住所 (と進行中の受注の施工場所) から場所を作る。元の住所の文字は変えない。
 *    番地まである住所だけを場所にし、同じ番地の記録は 1 つの場所を共有する。番地のない住所は「要確認」として報告する
 * 2. 住宅地図の PDF の一括取込 (pdf_import): サーバーのフォルダー (MAP_IMPORT_DIR/<フォルダー>) の PDF を、
 *    manifest.csv (ファイル名と顧客 ID・顧客コード・受注 ID・受注番号・住所) またはファイル名 (C-01234.pdf / O-2026-0012.pdf) で記録に結び付ける。
 *    ゼンリンからの自動ダウンロードはしない (許諾を確認した PDF を人が置く)
 * - どちらも「試し (dryRun)」で書き込まずに結果の報告だけを作れる
 * - 少しずつ (1 回 STEP 件) 処理し、進み具合 (cursor) をデータの書き込みと同じ mutate で保存する。
 *   途中で止まっても続きから再開でき、同じ記録・ファイルを二重に処理しない (場所はキー、PDF は取込元とファイルの中身で判定)
 * - 結果は件数 (設定の map_batch) と、記録・ファイルごとの報告 (CSV。/api/maps/batch/report)
 */

export const MAP_BATCH_SETTING = "map_batch";
const STEP_NORMALIZE = 2000;
const STEP_PDF = 25;

export type BatchKind = "normalize" | "pdf_import";

export interface MapBatchJob {
  id: string;
  kind: BatchKind;
  dryRun: boolean;
  status: "running" | "done" | "cancelled";
  cursor: number;
  total: number;
  counts: Record<string, number>;
  /** 一括取込のフォルダー名 */
  folder?: string;
  /** 正規化: 進行中の受注の施工場所も含める / 一括取込: 共用してよい PDF として登録する・提供元 */
  includeOrders?: boolean;
  shareable?: boolean;
  provider?: MapDocument["provider"];
  copyrightNotice?: string;
  licenseRef?: string;
  startedBy: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  lastError?: string;
}

interface BatchState {
  current?: MapBatchJob;
  history: MapBatchJob[];
}

export function readBatchState(db: Database): BatchState {
  const v = db.settings.find((s) => s.id === MAP_BATCH_SETTING)?.value as Partial<BatchState> | undefined;
  return { current: v?.current, history: Array.isArray(v?.history) ? v!.history : [] };
}

function writeBatchState(db: Database, state: BatchState, userId: string) {
  const row = db.settings.find((s) => s.id === MAP_BATCH_SETTING);
  const value = { current: state.current, history: state.history.slice(0, 20) } as unknown as Record<string, unknown>;
  if (row) Object.assign(row, { value, updatedBy: userId, updatedAt: nowIso() });
  else db.settings.push({ id: MAP_BATCH_SETTING, value, updatedBy: userId, updatedAt: nowIso() });
}

/** 作業用のフォルダー (報告・ファイルの一覧)。添付ファイルの保存先の中の maps/batch/<ジョブ ID> */
function jobDir(jobId: string): string {
  return path.join(/*turbopackIgnore: true*/ storageDir(), "maps", "batch", jobId.replace(/[^A-Za-z0-9_-]/g, ""));
}

/** 一括取込の PDF を置くフォルダー (MAP_IMPORT_DIR。なければ保存先の隣の map-import) */
export function importRoot(): string {
  const env = process.env.MAP_IMPORT_DIR?.trim();
  return env ? path.resolve(env) : path.join(/*turbopackIgnore: true*/ path.dirname(storageDir()), "map-import");
}

export async function listImportFolders(): Promise<{ name: string; pdfs: number; manifest: boolean }[]> {
  const root = importRoot();
  const entries = await fsp.readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const out: { name: string; pdfs: number; manifest: boolean }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^[\w.-]{1,80}$/.test(e.name)) continue;
    const files = await fsp.readdir(path.join(/*turbopackIgnore: true*/ root, e.name)).catch(() => [] as string[]);
    out.push({ name: e.name, pdfs: files.filter((f) => /\.pdf$/i.test(f)).length, manifest: files.includes("manifest.csv") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- 1. 住所の正規化 ---------------- */

interface NormRecord {
  type: "customer" | "order";
  id: string;
  label: string;
  storeId: MapLocation["storeId"];
  address: string;
}

const ACTIVE_ORDER = ["pending_approval", "returned", "confirmed", "scheduled", "in_progress"];

function normalizeRecords(db: Database, includeOrders: boolean): NormRecord[] {
  const out: NormRecord[] = db.customers.map((c) => ({ type: "customer" as const, id: c.id, label: `${c.code} ${c.name}`, storeId: c.storeId, address: c.address }));
  if (includeOrders) {
    const cust = new Map(db.customers.map((c) => [c.id, c]));
    for (const o of db.orders) {
      if (!ACTIVE_ORDER.includes(o.status) || !o.siteAddress) continue;
      const c = cust.get(o.customerId);
      if (c && (sameAddressText(c.address, o.siteAddress) || sameHouse(c.address, o.siteAddress))) continue;
      out.push({ type: "order", id: o.id, label: o.number, storeId: o.storeId, address: o.siteAddress });
    }
  }
  return out.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type === "customer" ? -1 : 1));
}

export type NormStatus = "empty" | "ambiguous" | "linked" | "new" | "shared_new";

/** 正規化の計画 (何も書かない)。記録ごとの状態と、同じ番地の記録の数 */
export function planNormalize(db: Database, includeOrders: boolean) {
  const idx = mapIndex(db);
  const records = normalizeRecords(db, includeOrders);
  const keyCount = new Map<string, number>();
  const rows = records.map((r) => {
    const n = normalizeAddress(r.address);
    if (n.precision === "house") keyCount.set(n.key, (keyCount.get(n.key) ?? 0) + 1);
    return { r, n };
  });
  const seen = new Set<string>();
  const counts: Record<string, number> = { records: records.length, empty: 0, ambiguous: 0, linked: 0, new: 0, shared_new: 0, sameAddressGroups: 0, duplicateLocations: idx.duplicateKeys.size };
  const out = rows.map(({ r, n }) => {
    let status: NormStatus;
    if (n.precision === "none") status = "empty";
    else if (n.precision === "area") status = "ambiguous";
    else if (idx.byKey.has(n.key)) status = "linked";
    else if (seen.has(n.key)) status = "shared_new";
    else status = "new";
    if (n.precision === "house") seen.add(n.key);
    counts[status] += 1;
    return { ...r, norm: n, status, sameKey: n.precision === "house" ? (keyCount.get(n.key) ?? 1) : 0, locationId: n.precision === "house" ? idx.byKey.get(n.key)?.id : undefined };
  });
  counts.sameAddressGroups = [...keyCount.values()].filter((v) => v > 1).length;
  counts.newLocations = counts.new;
  return { rows: out, counts };
}

const STATUS_LABEL: Record<NormStatus, string> = {
  empty: "住所なし",
  ambiguous: "番地なし・要確認 (場所を作らない)",
  linked: "登録済みの場所に一致",
  new: "新しい場所",
  shared_new: "同じ番地の別の記録と同じ場所",
};

export function normalizeReportCsv(db: Database, includeOrders: boolean): string {
  const { rows } = planNormalize(db, includeOrders);
  const idx = mapIndex(db);
  const dup = new Set(idx.duplicateKeys.keys());
  return toCsv([
    ["種類", "ID", "記録", "店舗", "元の住所 (変更していません)", "正規化した住所", "照合キー", "精度", "注意", "状態", "同じ番地の記録の数", "場所 ID", "重複した場所"],
    ...rows.map((x) => [x.type === "customer" ? "顧客" : "受注", x.id, x.label, x.storeId, x.address, x.norm.display, x.norm.key, x.norm.precision, x.norm.notes.join("・"), STATUS_LABEL[x.status], x.sameKey || "", x.locationId ?? "", dup.has(x.norm.key) ? "あり" : ""]),
  ]);
}

/* ---------------- 2. PDF の一括取込 ---------------- */

interface ManifestRow {
  file: string;
  customerId?: string;
  customerCode?: string;
  orderId?: string;
  orderNumber?: string;
  address?: string;
  title?: string;
  edition?: string;
  copyright?: string;
  licenseRef?: string;
  shareable?: boolean;
}

const MANIFEST_HEADERS: Record<string, keyof ManifestRow> = {
  file: "file", ファイル: "file", ファイル名: "file",
  customer_id: "customerId", 顧客id: "customerId",
  customer_code: "customerCode", 顧客コード: "customerCode",
  order_id: "orderId", 受注id: "orderId",
  order_number: "orderNumber", 受注番号: "orderNumber", 案件番号: "orderNumber",
  address: "address", 住所: "address", address_key: "address",
  title: "title", 表示名: "title",
  edition: "edition", 版: "edition",
  copyright: "copyright", 著作権表示: "copyright",
  license_ref: "licenseRef", 許諾: "licenseRef",
  shareable: "shareable", 共用: "shareable",
};

export function readManifest(text: string): { rows: Map<string, ManifestRow>; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  const rows = new Map<string, ManifestRow>();
  if (!table.length) return { rows, errors };
  const head = table[0].map((h) => MANIFEST_HEADERS[h.trim().toLowerCase().replace(/\s+/g, "_")] ?? MANIFEST_HEADERS[h.trim()]);
  if (!head.includes("file")) return { rows, errors: ["manifest.csv の 1 行目に file (ファイル名) の列がありません"] };
  for (let i = 1; i < table.length; i++) {
    const r: Partial<ManifestRow> & Record<string, unknown> = {};
    table[i].forEach((v, j) => {
      const k = head[j];
      if (!k || !v?.trim()) return;
      if (k === "shareable") r.shareable = /^(1|yes|true|可|○)$/i.test(v.trim());
      else r[k] = v.trim();
    });
    if (!r.file) continue;
    const name = path.basename(String(r.file));
    if (rows.has(name)) errors.push(`manifest.csv の ${i + 1} 行目: 「${name}」が重複しています (最初の行を使います)`);
    else rows.set(name, { ...(r as ManifestRow), file: name });
  }
  return { rows, errors };
}

type ImportTarget = { place: ResolvedPlace; via: string } | { error: string };

/** PDF の登録先を決める (manifest の指定 → ファイル名の顧客コード・受注番号) */
function importTarget(db: Database, file: string, m: ManifestRow | undefined): ImportTarget {
  const order = m?.orderId ? db.orders.find((o) => o.id === m.orderId) : m?.orderNumber ? db.orders.find((o) => o.number === m.orderNumber) : undefined;
  if ((m?.orderId || m?.orderNumber) && !order) return { error: `受注 ${m?.orderId ?? m?.orderNumber} が見つかりません` };
  if (order) return { place: placeOf(db, "order", order.id)!, via: `manifest: 受注 ${order.number}` };
  const customer = m?.customerId ? db.customers.find((c) => c.id === m.customerId) : m?.customerCode ? db.customers.find((c) => c.code === m.customerCode) : undefined;
  if ((m?.customerId || m?.customerCode) && !customer) return { error: `顧客 ${m?.customerId ?? m?.customerCode} が見つかりません` };
  if (customer) return { place: placeOf(db, "customer", customer.id)!, via: `manifest: 顧客 ${customer.code}` };
  if (m?.address) {
    const n = normalizeAddress(m.address);
    if (n.precision !== "house") return { error: `住所「${m.address}」は番地がないため場所を決められません (顧客・受注を指定してください)` };
    const hits = db.customers.filter((c) => sameHouse(c.address, m.address));
    const fake: ResolvedPlace = { role: "customer", heading: "住所", origin: "一括取込の住所", addressText: m.address, norm: n, location: mapIndex(db).byKey.get(n.key), record: { type: "customer", id: hits[0]?.id ?? "", storeId: hits[0]?.storeId ?? "hq", label: `住所 ${n.display}`, href: "" }, documents: [], target: {}, basis: "address", warnings: [], suggestions: [] };
    return { place: fake, via: `manifest: 住所 (${hits.length} 件の顧客と一致)` };
  }
  const base = path.basename(file, path.extname(file)).normalize("NFKC");
  const code = /^(C-\d{4,6})(?![\d])/i.exec(base)?.[1]?.toUpperCase();
  if (code) {
    const c = db.customers.find((x) => x.code === code);
    return c ? { place: placeOf(db, "customer", c.id)!, via: `ファイル名: 顧客 ${code}` } : { error: `ファイル名の顧客コード ${code} が見つかりません` };
  }
  const num = /^([A-Z]{1,4}-\d{4}-\d{3,6})(?![\d])/i.exec(base)?.[1]?.toUpperCase();
  if (num) {
    const o = db.orders.find((x) => x.number === num);
    return o ? { place: placeOf(db, "order", o.id)!, via: `ファイル名: 受注 ${num}` } : { error: `ファイル名の受注番号 ${num} が見つかりません` };
  }
  return { error: "登録先が分かりません (manifest.csv に記録を書くか、ファイル名を C-01234.pdf / O-2026-0012.pdf の形にしてください)" };
}

export type ImportStatus = "created" | "linked_existing" | "duplicate_skipped" | "already_imported" | "unmatched" | "error" | "would_create" | "would_link";

const IMPORT_LABEL: Record<ImportStatus, string> = {
  created: "登録",
  linked_existing: "同じ PDF が登録済み → その PDF を結び付け (共用)",
  duplicate_skipped: "重複 (同じ PDF がこの場所に登録済み・共用しない PDF) → 登録しない",
  already_imported: "取込済み (再開のため飛ばした)",
  unmatched: "登録先なし",
  error: "エラー",
  would_create: "試し: 登録できます",
  would_link: "試し: 同じ PDF を結び付けます",
};

interface ImportResult {
  file: string;
  status: ImportStatus;
  detail: string;
  documentId?: string;
  locationId?: string;
}

async function appendResults(jobId: string, rows: ImportResult[]) {
  if (!rows.length) return;
  await fsp.mkdir(/*turbopackIgnore: true*/ jobDir(jobId), { recursive: true, mode: 0o750 });
  await fsp.appendFile(path.join(/*turbopackIgnore: true*/ jobDir(jobId), "results.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

async function readResults(jobId: string): Promise<Map<string, ImportResult>> {
  const text = await fsp.readFile(path.join(/*turbopackIgnore: true*/ jobDir(jobId), "results.ndjson"), "utf8").catch(() => "");
  const out = new Map<string, ImportResult>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ImportResult;
      out.set(r.file, r);
    } catch {
      /* 途中で切れた行は使わない */
    }
  }
  return out;
}

async function folderFiles(folder: string): Promise<string[]> {
  if (!/^[\w.-]{1,80}$/.test(folder)) throw new Error("フォルダー名が正しくありません。");
  const dir = path.join(/*turbopackIgnore: true*/ importRoot(), folder);
  const names = await fsp.readdir(/*turbopackIgnore: true*/ dir).catch(() => null);
  if (!names) throw new Error(`フォルダー ${dir} が見つかりません。`);
  return names.filter((f) => /\.pdf$/i.test(f) && !f.startsWith(".")).sort();
}

/* ---------------- ジョブの開始・1 回分の処理・取り消し ---------------- */

export async function startBatch(user: User, opts: { kind: BatchKind; dryRun: boolean; folder?: string; includeOrders?: boolean; shareable?: boolean; provider?: MapDocument["provider"]; copyrightNotice?: string; licenseRef?: string; licenseConfirmed?: boolean }): Promise<MapBatchJob> {
  const db = getDb();
  const state = readBatchState(db);
  if (state.current?.status === "running") throw new Error("ほかの一括処理が途中です。続けるか取り消してから始めてください。");
  const id = newId("mbj");
  let total = 0;
  if (opts.kind === "normalize") total = normalizeRecords(db, Boolean(opts.includeOrders)).length;
  else {
    if (!opts.dryRun && !opts.licenseConfirmed) throw new Error("取り込む PDF の利用許諾 (社内サーバーへの保存・社内の複数人での閲覧) を確認してください。");
    const files = await folderFiles(opts.folder ?? "");
    if (!files.length) throw new Error("フォルダーに PDF がありません。");
    total = files.length;
    await fsp.mkdir(/*turbopackIgnore: true*/ jobDir(id), { recursive: true, mode: 0o750 });
    await fsp.writeFile(path.join(/*turbopackIgnore: true*/ jobDir(id), "files.json"), JSON.stringify(files), "utf8");
  }
  const now = nowIso();
  const job: MapBatchJob = {
    id,
    kind: opts.kind,
    dryRun: opts.dryRun,
    status: "running",
    cursor: 0,
    total,
    counts: {},
    folder: opts.kind === "pdf_import" ? opts.folder : undefined,
    includeOrders: opts.kind === "normalize" ? Boolean(opts.includeOrders) : undefined,
    shareable: opts.kind === "pdf_import" ? Boolean(opts.shareable) : undefined,
    provider: opts.kind === "pdf_import" ? (opts.provider ?? "zenrin") : undefined,
    copyrightNotice: opts.kind === "pdf_import" ? (opts.copyrightNotice?.trim() || DEFAULT_COPYRIGHT[opts.provider ?? "zenrin"]) : undefined,
    licenseRef: opts.licenseRef?.trim() || undefined,
    startedBy: user.id,
    startedAt: now,
    updatedAt: now,
  };
  if (opts.kind === "normalize" && opts.dryRun) {
    // 試しは計画を作るだけ (すぐ終わる)
    const plan = planNormalize(db, job.includeOrders!);
    Object.assign(job, { status: "done", cursor: total, counts: plan.counts, finishedAt: now });
  }
  await mutate((d) => {
    const st = readBatchState(d);
    if (st.current?.status === "running") throw new Error("ほかの一括処理が途中です。");
    st.history = [job, ...st.history.filter((h) => h.id !== job.id)];
    st.current = job;
    writeBatchState(d, st, user.id);
    addAudit(d, { userId: user.id, action: "import", entity: "map_batch", entityId: job.id, entityLabel: job.kind === "normalize" ? "住所の正規化" : `住宅地図の一括取込 (${job.folder})`, summary: `${job.dryRun ? "試し (書き込みなし) を" : ""}開始 (${total} 件)`, storeId: undefined });
  });
  return job;
}

function bump(counts: Record<string, number>, key: string, n = 1) {
  counts[key] = (counts[key] ?? 0) + n;
}

/** 1 回分を処理する (画面が終わるまで繰り返し呼ぶ)。処理後のジョブを返す */
export async function stepBatch(user: User, jobId: string): Promise<MapBatchJob> {
  const st0 = readBatchState(getDb());
  const job0 = st0.current;
  if (!job0 || job0.id !== jobId) throw new Error("一括処理が見つかりません (別の処理が始まった可能性があります)。");
  if (job0.status !== "running") return job0;
  return job0.kind === "normalize" ? stepNormalize(user, job0) : stepPdf(user, job0);
}

async function stepNormalize(user: User, job0: MapBatchJob): Promise<MapBatchJob> {
  return mutate((db) => {
    const st = readBatchState(db);
    const job = st.current!;
    if (job.id !== job0.id || job.status !== "running") return job;
    const records = normalizeRecords(db, Boolean(job.includeOrders));
    // 件数が変わっていても、ID の順に並べた続きから処理する (処理済みの場所はキーで見つかるので二重に作らない)
    const slice = records.slice(job.cursor, job.cursor + STEP_NORMALIZE);
    for (const r of slice) {
      const n = normalizeAddress(r.address);
      if (n.precision === "none") {
        bump(job.counts, "empty");
        continue;
      }
      if (n.precision === "area") {
        bump(job.counts, "ambiguous");
        continue;
      }
      const place = placeOf(db, r.type, r.id);
      if (!place) continue;
      const res = ensureLocation(db, user, place, { source: "batch" });
      bump(job.counts, res.created ? "new" : "linked");
    }
    job.cursor = Math.min(records.length, job.cursor + slice.length);
    job.total = records.length;
    job.updatedAt = nowIso();
    if (job.cursor >= records.length) {
      job.status = "done";
      job.finishedAt = job.updatedAt;
      job.counts.duplicateLocations = mapIndex(db).duplicateKeys.size;
      addAudit(db, { userId: user.id, action: "import", entity: "map_batch", entityId: job.id, entityLabel: "住所の正規化", summary: `完了 (場所の新規 ${job.counts.new ?? 0} / 登録済みに一致 ${job.counts.linked ?? 0} / 番地なし ${job.counts.ambiguous ?? 0} / 住所なし ${job.counts.empty ?? 0})` });
    }
    st.history = [job, ...st.history.filter((h) => h.id !== job.id)];
    writeBatchState(db, st, user.id);
    touchMapIndex();
    return { ...job, counts: { ...job.counts } };
  });
}

interface Prepared {
  file: string;
  bytes?: Buffer;
  sha?: string;
  pages?: number;
  target?: ResolvedPlace;
  via?: string;
  manifest?: ManifestRow;
  result?: ImportResult;
  docId?: string;
  key?: string;
}

async function stepPdf(user: User, job0: MapBatchJob): Promise<MapBatchJob> {
  const files = JSON.parse(await fsp.readFile(path.join(/*turbopackIgnore: true*/ jobDir(job0.id), "files.json"), "utf8")) as string[];
  const dir = path.join(/*turbopackIgnore: true*/ importRoot(), job0.folder ?? "");
  const manifestText = await fsp.readFile(path.join(/*turbopackIgnore: true*/ dir, "manifest.csv")).then((b) => decodeCsv(b).text).catch(() => "");
  const manifest = readManifest(manifestText).rows;
  const slice = files.slice(job0.cursor, job0.cursor + STEP_PDF);
  const db = getDb();
  const done = new Set(db.mapDocuments.filter((d) => d.sourceRef?.startsWith(`${job0.folder}/`)).map((d) => d.sourceRef));
  const prepared: Prepared[] = [];
  // 試しのときに、このジョブで先に見た PDF (同じ中身の重複を数える)
  const earlier = job0.dryRun ? new Set(Array.from((await readResults(job0.id)).values()).filter((r) => r.status === "would_create" && r.documentId).map((r) => r.documentId!)) : new Set<string>();

  for (const file of slice) {
    const p: Prepared = { file, manifest: manifest.get(file) };
    prepared.push(p);
    if (done.has(`${job0.folder}/${file}`)) {
      p.result = { file, status: "already_imported", detail: "この取込元のファイルは登録済みです" };
      continue;
    }
    const t = importTarget(db, file, p.manifest);
    if ("error" in t) {
      p.result = { file, status: "unmatched", detail: t.error };
      continue;
    }
    if (!t.place.addressText) {
      p.result = { file, status: "unmatched", detail: `${t.place.record.label} に住所がありません` };
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(path.join(/*turbopackIgnore: true*/ dir, path.basename(file)));
    } catch (err) {
      p.result = { file, status: "error", detail: `読み込めません: ${(err as Error).message}` };
      continue;
    }
    const check = await inspectPdf(bytes);
    if (!check.ok) {
      p.result = { file, status: "error", detail: check.error ?? "PDF ではありません" };
      continue;
    }
    p.bytes = bytes;
    p.sha = check.sha256;
    p.pages = check.pages;
    p.target = t.place;
    p.via = t.via;
  }

  // 同じ中身の PDF (登録済み・このジョブの中) を数える
  const bySha = new Map(db.mapDocuments.filter((d) => d.status === "active").map((d) => [d.sha256, d]));
  const shaInStep = new Map<string, Prepared>();
  for (const p of prepared) {
    if (p.result || !p.sha) continue;
    const dup = bySha.get(p.sha);
    const twin = shaInStep.get(p.sha);
    if (job0.dryRun) {
      p.result = dup || twin || earlier.has(p.sha) ? { file: p.file, status: "would_link", detail: `${p.via} / 同じ PDF が${dup ? "登録済み" : "このフォルダーの別のファイルにあり"}` } : { file: p.file, status: "would_create", detail: `${p.via} / ${p.pages} ページ`, documentId: p.sha };
      if (!dup && !twin) shaInStep.set(p.sha, p);
      continue;
    }
    if (!dup && !twin) {
      p.docId = newId("mdoc");
      p.key = `maps/${nowIso().slice(0, 7)}/${p.docId}.pdf`;
      shaInStep.set(p.sha, p);
    }
  }

  // ファイルを保存してから台帳に入れる (失敗したら保存したファイルを消す)
  const stored: string[] = [];
  let job: MapBatchJob;
  try {
    for (const p of prepared) {
      if (p.key && p.bytes) {
        await putObject(p.key, p.bytes);
        stored.push(p.key);
      }
    }
    job = await mutate((d) => {
      const st = readBatchState(d);
      const j = st.current!;
      if (j.id !== job0.id || j.status !== "running" || j.cursor !== job0.cursor) throw new Error("一括処理の状態が変わりました。画面を更新してください。");
      const now = nowIso();
      for (const p of prepared) {
        if (p.result) continue;
        // この時点のデータで登録先を決め直す
        const t = importTarget(d, p.file, p.manifest);
        if ("error" in t) {
          p.result = { file: p.file, status: "unmatched", detail: t.error };
          continue;
        }
        const loc = ensureLocation(d, user, t.place, { source: "batch" }).location;
        const idx = mapIndex(d);
        const existing = d.mapDocuments.find((x) => x.sha256 === p.sha && x.status === "active");
        if (existing) {
          const here = (idx.locationsByDoc.get(existing.id) ?? []).includes(loc.id);
          if (here || !existing.shareable) {
            p.result = { file: p.file, status: "duplicate_skipped", detail: `${p.via} / 同じ PDF「${existing.title}」が${here ? "この場所に登録済み" : "共用しない設定で登録済み"}`, documentId: existing.id, locationId: loc.id };
            continue;
          }
          linkDocument(d, user, existing.id, loc.id);
          p.result = { file: p.file, status: "linked_existing", detail: `${p.via} / 同じ PDF「${existing.title}」を共用`, documentId: existing.id, locationId: loc.id };
          continue;
        }
        if (!p.docId || !p.key) {
          p.result = { file: p.file, status: "error", detail: "保存の準備ができていません (もう一度実行してください)" };
          continue;
        }
        const m = p.manifest;
        const doc: MapDocument = {
          id: p.docId,
          kind: j.provider === "other" ? "other" : "residential",
          provider: j.provider ?? "zenrin",
          title: (m?.title || p.file.replace(/\.pdf$/i, "")).slice(0, 120),
          fileName: p.file.slice(0, 200),
          contentType: "application/pdf",
          size: p.bytes!.length,
          sha256: p.sha!,
          pageCount: p.pages,
          storageKey: p.key,
          status: "active",
          source: "bulk_import",
          sourceRef: `${j.folder}/${p.file}`,
          edition: m?.edition?.slice(0, 60),
          copyrightNotice: (m?.copyright || j.copyrightNotice || DEFAULT_COPYRIGHT[j.provider ?? "zenrin"]).slice(0, 200),
          licenseRef: (m?.licenseRef || j.licenseRef)?.slice(0, 100),
          licenseConfirmedBy: j.startedBy,
          licenseConfirmedAt: j.startedAt,
          shareable: (m?.shareable ?? j.shareable) || undefined,
          storeId: t.place.record.storeId,
          uploadedBy: user.id,
          uploadedAt: now,
          updatedAt: now,
        };
        d.mapDocuments.push(doc);
        touchMapIndex();
        linkDocument(d, user, doc.id, loc.id);
        p.result = { file: p.file, status: "created", detail: `${p.via} / ${p.pages} ページ`, documentId: doc.id, locationId: loc.id };
      }
      for (const p of prepared) bump(j.counts, p.result!.status);
      j.cursor = Math.min(j.total, j.cursor + prepared.length);
      j.updatedAt = now;
      if (j.cursor >= j.total) {
        j.status = "done";
        j.finishedAt = now;
        addAudit(d, { userId: user.id, action: "import", entity: "map_batch", entityId: j.id, entityLabel: `住宅地図の一括取込 (${j.folder})`, summary: `完了 (登録 ${j.counts.created ?? 0} / 共用 ${j.counts.linked_existing ?? 0} / 重複 ${j.counts.duplicate_skipped ?? 0} / 登録先なし ${j.counts.unmatched ?? 0} / エラー ${j.counts.error ?? 0})` });
      }
      st.history = [j, ...st.history.filter((h) => h.id !== j.id)];
      writeBatchState(d, st, user.id);
      return { ...j, counts: { ...j.counts } };
    });
  } catch (err) {
    // 台帳に入らなかったファイルを消す (再開したときに同じファイルをもう一度保存する)
    const used = new Set(getDb().mapDocuments.map((d) => d.storageKey));
    await removeObjects(stored.filter((k) => !used.has(k))).catch(() => undefined);
    throw err;
  }
  // 保存したのに使わなかったファイル (同じ時刻に別の人が同じ PDF を登録したなど) を消す
  const used = new Set(getDb().mapDocuments.map((d) => d.storageKey));
  await removeObjects(stored.filter((k) => !used.has(k))).catch(() => undefined);
  await appendResults(job.id, prepared.map((p) => p.result!));
  return job;
}

export async function cancelBatch(user: User, jobId: string): Promise<void> {
  await mutate((db) => {
    const st = readBatchState(db);
    if (!st.current || st.current.id !== jobId || st.current.status !== "running") return;
    st.current.status = "cancelled";
    st.current.updatedAt = nowIso();
    st.current.finishedAt = st.current.updatedAt;
    st.history = [st.current, ...st.history.filter((h) => h.id !== jobId)];
    writeBatchState(db, st, user.id);
    addAudit(db, { userId: user.id, action: "import", entity: "map_batch", entityId: jobId, entityLabel: "地図の一括処理", summary: `取り消し (${st.current.cursor} / ${st.current.total} 件まで処理済み。処理済みの分は残ります)` });
  });
}

/** 一括取込の報告 (ファイルごと)。結果の記録がないファイルは、台帳の取込元から判定する */
export async function importReportCsv(db: Database, job: MapBatchJob): Promise<string> {
  const files = JSON.parse(await fsp.readFile(path.join(/*turbopackIgnore: true*/ jobDir(job.id), "files.json"), "utf8").catch(() => "[]")) as string[];
  const results = await readResults(job.id);
  const bySource = new Map(db.mapDocuments.filter((d) => d.sourceRef?.startsWith(`${job.folder}/`)).map((d) => [d.sourceRef!, d]));
  const locs = new Map(db.mapLocations.map((l) => [l.id, l]));
  return toCsv([
    ["ファイル", "結果", "内容", "住宅地図 ID", "場所 ID", "場所の住所"],
    ...files.map((f) => {
      const r = results.get(f);
      const d = bySource.get(`${job.folder}/${f}`);
      const status = r?.status ?? (d ? "created" : undefined);
      const locId = r?.locationId;
      return [f, status ? IMPORT_LABEL[status] : "未処理", r?.detail ?? (d ? "登録済み (報告の記録なし)" : ""), r?.documentId && r.status !== "would_create" ? r.documentId : (d?.id ?? ""), locId ?? "", locId ? (locs.get(locId)?.address ?? "") : ""];
    }),
  ]);
}

export const BATCH_COUNT_LABEL: Record<string, string> = {
  records: "対象の記録",
  new: "新しい場所",
  newLocations: "新しい場所 (予定)",
  shared_new: "同じ番地の記録 (場所を共有)",
  linked: "登録済みの場所に一致",
  ambiguous: "番地なし・要確認",
  empty: "住所なし",
  sameAddressGroups: "同じ番地の記録が複数ある住所",
  duplicateLocations: "重複した場所 (同じ番地の場所が 2 つ以上)",
  ...IMPORT_LABEL,
};
