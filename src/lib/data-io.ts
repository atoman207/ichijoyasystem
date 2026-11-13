import "server-only";
import type { Channel, Customer, Database, Inquiry, InquiryStatus, ServiceCategory, StoreId, User } from "@/lib/db/types";
import { addAudit, newId, nextCustomerCode, nextNumber, nowIso } from "@/lib/db/store";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, ORDER_STATUS } from "@/lib/constants";
import { candidateLabel, findDuplicateCustomers, needsConfirmation, normName } from "@/lib/duplicates";
import { IMPORT_MAX_ROWS, IMPORT_SPEC, mapHeaders, type ImportTarget } from "@/lib/data-io-spec";
import { toDateKey } from "@/lib/format";

/* ================================================================== */
/* 書き出し (CSV の行)                                                    */
/* ================================================================== */

type Cell = string | number | null | undefined;

const storeLabel = (db: Database, id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
const userLabel = (db: Database, id?: string) => (id ? (db.users.find((u) => u.id === id)?.name ?? "") : "");
/** 日本時間の「YYYY-MM-DD HH:MM」 */
function jstDateTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}`;
}

export function exportCustomers(db: Database, storeId?: StoreId): Cell[][] {
  const head = [...IMPORT_SPEC.customers.columns.map((c) => c.header), "担当者", "登録日"];
  const rows: Cell[][] = [head];
  for (const c of db.customers) {
    if (storeId && c.storeId !== storeId) continue;
    rows.push([c.code, c.name, c.kana, c.type === "corporate" ? "法人" : "個人", c.phone, c.email ?? "", c.postalCode, c.address, c.area ?? "", storeLabel(db, c.storeId), CHANNEL_LABEL[c.preferredChannel], c.tags.join(" "), c.notes, userLabel(db, c.assignedUserId), c.createdAt.slice(0, 10)]);
  }
  return rows;
}

export function exportInquiries(db: Database, storeId?: StoreId): Cell[][] {
  const rows: Cell[][] = [["番号", ...IMPORT_SPEC.inquiries.columns.map((c) => c.header), "顧客名", "見積番号"]];
  const byId = new Map(db.customers.map((c) => [c.id, c]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  for (const i of [...db.inquiries].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    if (storeId && i.storeId !== storeId) continue;
    const c = i.customerId ? byId.get(i.customerId) : undefined;
    rows.push([i.number, jstDateTime(i.receivedAt), storeLabel(db, i.storeId), CHANNEL_LABEL[i.channel], CATEGORY_LABEL[i.category], i.contactName, i.contactPhone ?? "", c?.code ?? "", i.summary, i.detail, INQUIRY_STATUS[i.status].label, userLabel(db, i.assignedUserId), i.nextAction ?? "", i.nextActionDue ?? "", c?.name ?? "", i.quoteId ? (quotes.get(i.quoteId)?.number ?? "") : ""]);
  }
  return rows;
}

export function exportOrders(db: Database, storeId?: StoreId): Cell[][] {
  const rows: Cell[][] = [["受注番号", "契約日", "担当店舗", "顧客コード", "顧客名", "件名", "種別", "金額 (税込)", "状態", "施工開始", "施工終了", "施工担当", "完了日", "売上計上日", "現場住所", "見積番号"]];
  const byId = new Map(db.customers.map((c) => [c.id, c]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  for (const o of [...db.orders].sort((a, b) => a.contractDate.localeCompare(b.contractDate))) {
    if (storeId && o.storeId !== storeId) continue;
    const c = byId.get(o.customerId);
    rows.push([o.number, o.contractDate, storeLabel(db, o.storeId), c?.code ?? "", c?.name ?? "", o.title, CATEGORY_LABEL[o.category], o.total, ORDER_STATUS[o.status].label, o.scheduledStart ?? "", o.scheduledEnd ?? "", o.workerIds.map((w) => userLabel(db, w)).join(" "), o.completedAt?.slice(0, 10) ?? "", o.salesDate ?? "", o.siteAddress, o.quoteId ? (quotes.get(o.quoteId)?.number ?? "") : ""]);
  }
  return rows;
}

/** 取込用のひな形 (見出し + 記入例 1 行) */
export function templateRows(target: ImportTarget): Cell[][] {
  const cols = IMPORT_SPEC[target].columns;
  return [cols.map((c) => c.header), cols.map((c) => c.example)];
}

/* ================================================================== */
/* 取込                                                                 */
/* ================================================================== */

export type RowStatus = "create" | "update" | "unchanged" | "duplicate" | "error";

export interface ImportRowResult {
  /** 元のファイルの行番号 (見出しが 1 行目) */
  row: number;
  status: RowStatus;
  label: string;
  message: string;
  /** 登録・更新した記録 (取込後のみ) */
  href?: string;
}

export interface ImportOptions {
  /** 既存の顧客の更新: fill = 空欄の項目だけ補う / overwrite = 入力のある項目で上書き */
  mode: "fill" | "overwrite";
  /** 重複の可能性がある行も新規登録する (確認済みのとき) */
  allowDuplicates: boolean;
  /** 変更履歴・取込元に残す名前 (ファイル名またはスプレッドシート) */
  sourceLabel: string;
}

export interface ImportReport {
  target: ImportTarget;
  total: number;
  counts: Record<RowStatus, number>;
  rows: ImportRowResult[];
  /** 認識した見出し → 項目 */
  matched: { header: string; column: string }[];
  /** 取り込まない見出し */
  ignored: string[];
  /** 見つからない必須の見出し (あると取り込めない) */
  missing: string[];
  committed: boolean;
}

const STATUS_ALIAS: Record<string, InquiryStatus> = { 未対応: "new", 新規: "new", 対応中: "in_progress", 見積済: "quoted", 見積済み: "quoted", 見積提出済: "quoted", 成約: "won", 受注: "won", 施工: "won", 失注: "lost", キャンセル: "lost", 完了: "closed", 対応不要: "closed" };

const n = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "").toLowerCase();

/** ラベル (電話・来店・対面 など) またはキーから選択肢を決める */
function pick<K extends string>(map: Record<K, string>, raw: string, extra: Record<string, K> = {}): K | undefined {
  const v = n(raw);
  if (!v) return undefined;
  const entries = Object.entries(map) as [K, string][];
  for (const [k, label] of entries) if (n(k) === v || n(label) === v) return k;
  for (const [alias, k] of Object.entries(extra)) if (n(alias) === v) return k;
  for (const [k, label] of entries) if (label.split(/[・/]/).some((part) => n(part) === v)) return k;
  for (const [k, label] of entries) if (v.length >= 2 && n(label).includes(v)) return k;
  return undefined;
}

function pickStore(db: Database, raw: string): StoreId | undefined {
  const v = n(raw);
  if (!v) return undefined;
  for (const s of db.stores) if ([s.id, s.name, s.shortName, s.code].some((x) => x && n(x) === v)) return s.id;
  for (const s of db.stores) if (n(s.name).includes(v) || v.includes(n(s.shortName))) return s.id;
  return undefined;
}

function pickUser(db: Database, raw: string): User | undefined {
  const v = n(raw);
  if (!v) return undefined;
  return db.users.find((u) => u.active && (n(u.email) === v || n(u.name) === v)) ?? db.users.find((u) => n(u.email) === v || n(u.name) === v);
}

/** 日付・日時 (YYYY-MM-DD / YYYY/MM/DD / YYYY年M月D日 + 時刻、Excel のシリアル値) → ISO (日本時間として解釈) */
export function parseDateTime(raw: string): string | undefined {
  const v = raw.normalize("NFKC").trim();
  if (!v) return undefined;
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    // Excel のシリアル値 (1900 年日付システム)
    const ms = Math.round((Number(v) - 25569) * 86400000);
    const d = new Date(ms);
    return new Date(`${d.toISOString().slice(0, 19)}+09:00`).toISOString();
  }
  const m = v.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T]+(\d{1,2})[:時](\d{1,2})(?:[:分](\d{1,2}))?秒?)?$/);
  if (!m) return undefined;
  const [, y, mo, d, h = "9", mi = "0", s = "0"] = m;
  const pad = (x: string) => x.padStart(2, "0");
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+09:00`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime()) || t.getUTCFullYear() < 1990 || t.getUTCFullYear() > 2100) return undefined;
  // 2/30 などの存在しない日付は弾く
  if (new Date(`${y}-${pad(mo)}-${pad(d)}T00:00:00Z`).getUTCDate() !== Number(d)) return undefined;
  return t.toISOString();
}

/** 書き出し時に付けた先頭の ' (数式対策) を外す */
function clean(v: string | undefined): string {
  const s = (v ?? "").trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function emptyCounts(): Record<RowStatus, number> {
  return { create: 0, update: 0, unchanged: 0, duplicate: 0, error: 0 };
}

/**
 * 取込の確認 (commit=false) と実行 (commit=true、mutate の中で呼ぶ)。
 * 同じ関数で判定するので、確認画面の結果と実行の結果は一致する
 */
export function runImport(db: Database, user: User, target: ImportTarget, table: string[][], opts: ImportOptions, commit: boolean): ImportReport {
  const spec = IMPORT_SPEC[target];
  const [header = [], ...body] = table;
  const idx = mapHeaders(target, header);
  const matched = spec.columns.filter((c) => idx[c.key] >= 0).map((c) => ({ header: header[idx[c.key]], column: c.header }));
  const usedCols = new Set(Object.values(idx).filter((i) => i >= 0));
  const ignored = header.filter((h, i) => h.trim() && !usedCols.has(i));
  const missing = spec.columns.filter((c) => c.required === "always" && idx[c.key] < 0).map((c) => c.header);
  if (target === "customers" && idx.code < 0 && idx.name < 0) missing.push("氏名・会社名 (または顧客コード)");
  const report: ImportReport = { target, total: body.length, counts: emptyCounts(), rows: [], matched, ignored, missing, committed: commit };
  if (missing.length || body.length === 0) return report;
  if (body.length > IMPORT_MAX_ROWS) {
    report.missing.push(`行数が多すぎます (${body.length} 行)。1 回に ${IMPORT_MAX_ROWS} 行までにしてください`);
    return report;
  }
  const add = (r: ImportRowResult) => {
    report.rows.push(r);
    report.counts[r.status] += 1;
  };
  if (target === "customers") importCustomers(db, user, body, idx, opts, commit, add);
  else importInquiries(db, user, body, idx, opts, commit, add);
  if (commit && (report.counts.create || report.counts.update)) {
    addAudit(db, {
      userId: user.id,
      action: "import",
      entity: "data",
      entityId: target,
      entityLabel: `${spec.label}の取込`,
      summary: `${spec.label}を取込 (${opts.sourceLabel}): 新規 ${report.counts.create} 件・更新 ${report.counts.update} 件・取り込まない行 ${report.counts.duplicate + report.counts.error + report.counts.unchanged} 件`,
    });
  }
  return report;
}

const CUSTOMER_FIELDS = ["name", "kana", "phone", "email", "postalCode", "address", "area", "notes"] as const;
const CUSTOMER_FIELD_LABEL: Record<string, string> = { name: "氏名", kana: "フリガナ", type: "区分", phone: "電話", email: "メール", postalCode: "郵便番号", address: "住所", area: "地区", storeId: "担当店舗", preferredChannel: "希望連絡手段", tags: "タグ", notes: "備考" };

function importCustomers(db: Database, user: User, body: string[][], idx: Record<string, number>, opts: ImportOptions, commit: boolean, add: (r: ImportRowResult) => void) {
  // 同じファイルの中の重複も見つけるため、新規登録する行を順に加えて照合する
  const pending: Customer[] = [];
  const seenCodes = new Set<string>();
  body.forEach((cells, i) => {
    const row = i + 2;
    const get = (k: string) => (idx[k] >= 0 ? clean(cells[idx[k]]) : "");
    const code = get("code");
    const name = get("name");
    const label = [code, name].filter(Boolean).join(" ") || `${row} 行目`;
    const typeRaw = get("type");
    const type = typeRaw ? (/法人|会社|施設|corporate/i.test(typeRaw) ? "corporate" : /個人|individual/i.test(typeRaw) ? "individual" : undefined) : undefined;
    if (typeRaw && !type) return add({ row, status: "error", label, message: `区分「${typeRaw}」は 個人 / 法人 で入力してください。` });
    const channelRaw = get("preferredChannel");
    const channel = channelRaw ? pick(CHANNEL_LABEL, channelRaw, { 来店: "visit", 対面: "visit", ウェブ: "web", 手紙: "mail" }) : undefined;
    if (channelRaw && !channel) return add({ row, status: "error", label, message: `希望連絡手段「${channelRaw}」が分かりません (電話・LINE・メール・郵送 など)。` });
    const storeRaw = get("storeId");
    const storeId = storeRaw ? pickStore(db, storeRaw) : undefined;
    if (storeRaw && !storeId) return add({ row, status: "error", label, message: `担当店舗「${storeRaw}」が分かりません (合志店・中央店・西店・玉名店・本社)。` });
    const email = get("email");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return add({ row, status: "error", label, message: `メールアドレス「${email}」の形式が正しくありません。` });
    const tags = get("tags").split(/[,、\s]+/).map((t) => t.trim()).filter(Boolean);

    if (code) {
      if (seenCodes.has(code)) return add({ row, status: "error", label, message: `顧客コード ${code} がファイルの中で重複しています。` });
      seenCodes.add(code);
      const c = db.customers.find((x) => x.code === code);
      if (!c) return add({ row, status: "error", label, message: `顧客コード ${code} の顧客が見つかりません (新規に登録する行は顧客コードを空欄にしてください)。` });
      const next: Partial<Customer> = {};
      for (const f of CUSTOMER_FIELDS) {
        const v = get(f);
        const cur = (c[f] ?? "") as string;
        if (!v || v === cur) continue;
        if (opts.mode === "fill" && cur) continue;
        (next as Record<string, string>)[f] = v;
      }
      if (type && type !== c.type && opts.mode === "overwrite") next.type = type;
      if (channel && channel !== c.preferredChannel && opts.mode === "overwrite") next.preferredChannel = channel;
      if (storeId && storeId !== c.storeId && opts.mode === "overwrite") next.storeId = storeId;
      const newTags = tags.filter((t) => !c.tags.includes(t));
      if (newTags.length) next.tags = [...c.tags, ...newTags];
      const fields = Object.keys(next);
      if (!fields.length) return add({ row, status: "unchanged", label: `${c.code} ${c.name}`, message: "変更する項目はありません。", href: `/customers/${c.id}` });
      const names = fields.map((f) => CUSTOMER_FIELD_LABEL[f] ?? f).join("・");
      if (commit) {
        const changes = fields.map((f) => ({ field: f, before: (c as unknown as Record<string, unknown>)[f], after: (next as Record<string, unknown>)[f] }));
        Object.assign(c, next, { updatedAt: nowIso() });
        addAudit(db, { userId: user.id, action: "update", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `取込で顧客情報を更新 (${names}) · ${opts.sourceLabel} ${row} 行目`, storeId: c.storeId, changes });
      }
      return add({ row, status: "update", label: `${c.code} ${c.name}`, message: `${names}を${opts.mode === "fill" ? "補完" : "更新"}します。`, href: `/customers/${c.id}` });
    }

    if (!name) return add({ row, status: "error", label, message: "氏名・会社名が空欄です。" });
    if (!storeId) return add({ row, status: "error", label, message: "担当店舗が空欄です (新規登録には必要です)。" });
    const input = { name, kana: get("kana"), phone: get("phone"), email, postalCode: get("postalCode"), address: get("address") };
    const dup = findDuplicateCustomers({ customers: [...db.customers, ...pending] }, input);
    if (needsConfirmation(dup) && !opts.allowDuplicates) {
      return add({ row, status: "duplicate", label: name, message: `既存の顧客と重複の可能性: ${candidateLabel(dup)} (${[...dup.high, ...dup.check][0].reasons.join("・")})` });
    }
    const now = nowIso();
    const c: Customer = {
      id: newId("cust"),
      code: commit ? nextCustomerCode(db) : "(登録時に採番)",
      name,
      kana: input.kana,
      type: type ?? "individual",
      phone: input.phone,
      email: email || undefined,
      postalCode: input.postalCode,
      address: input.address,
      area: get("area") || undefined,
      storeId,
      assignedUserId: undefined,
      preferredChannel: channel ?? "phone",
      firstContactChannel: "unknown",
      tags,
      notes: get("notes"),
      createdAt: now,
      updatedAt: now,
    };
    if (commit) {
      db.customers.push(c);
      addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `取込で顧客を登録 · ${opts.sourceLabel} ${row} 行目${needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : ""}`, storeId });
    } else pending.push(c);
    add({ row, status: "create", label: name, message: needsConfirmation(dup) ? `新規に登録します (重複の可能性 ${candidateLabel(dup)} は確認済みとして登録)。` : "新規に登録します。", href: commit ? `/customers/${c.id}` : undefined });
  });
}

function importInquiries(db: Database, user: User, body: string[][], idx: Record<string, number>, opts: ImportOptions, commit: boolean, add: (r: ImportRowResult) => void) {
  const key = (at: string, name: string, summary: string) => `${at.slice(0, 16)}|${normName(name)}|${n(summary)}`;
  const seen = new Set(db.inquiries.map((i) => key(i.receivedAt, i.contactName, i.summary)));
  body.forEach((cells, i) => {
    const row = i + 2;
    const get = (k: string) => (idx[k] >= 0 ? clean(cells[idx[k]]) : "");
    const contactName = get("contactName");
    const summary = get("summary");
    const label = [contactName, summary].filter(Boolean).join(" / ") || `${row} 行目`;
    const atRaw = get("receivedAt");
    const receivedAt = parseDateTime(atRaw);
    if (!receivedAt) return add({ row, status: "error", label, message: atRaw ? `受付日時「${atRaw}」を日付として読めません (例: 2026-11-12 10:30)。` : "受付日時が空欄です。" });
    if (!contactName) return add({ row, status: "error", label, message: "お名前が空欄です。" });
    if (!summary) return add({ row, status: "error", label, message: "概要が空欄です。" });
    const storeRaw = get("storeId");
    const storeId = pickStore(db, storeRaw);
    if (!storeId) return add({ row, status: "error", label, message: storeRaw ? `担当店舗「${storeRaw}」が分かりません。` : "担当店舗が空欄です。" });
    const chRaw = get("channel");
    const channel: Channel | undefined = chRaw ? pick(CHANNEL_LABEL, chRaw, { 来店: "visit", 対面: "visit", 訪問: "visit", ウェブ: "web", ホームページ: "web", 手紙: "mail", ハガキ: "mail", はがき: "mail", fax: "mail" }) : "phone";
    if (!channel) return add({ row, status: "error", label, message: `経路「${chRaw}」が分かりません (電話・来店・対面・郵送・メール・LINE・Web など)。` });
    const catRaw = get("category");
    const category: ServiceCategory | undefined = catRaw ? pick(CATEGORY_LABEL, catRaw, { ふすま: "fusuma", しょうじ: "shoji", たたみ: "tatami", カーテン: "curtain", ブラインド: "curtain", クロス: "cloth", 壁紙: "cloth" }) : "other";
    if (!category) return add({ row, status: "error", label, message: `種別「${catRaw}」が分かりません (畳・襖・障子・網戸・カーテン・クロス・その他)。` });
    const stRaw = get("status");
    const status: InquiryStatus | undefined = stRaw ? pick(Object.fromEntries(Object.entries(INQUIRY_STATUS).map(([k, v]) => [k, v.label])) as Record<InquiryStatus, string>, stRaw, STATUS_ALIAS) : "new";
    if (!status) return add({ row, status: "error", label, message: `状態「${stRaw}」が分かりません (新規・対応中・見積提出済・受注・失注・完了)。` });
    const dueRaw = get("nextActionDue");
    const due = dueRaw ? parseDateTime(dueRaw) : undefined;
    if (dueRaw && !due) return add({ row, status: "error", label, message: `期限「${dueRaw}」を日付として読めません。` });
    const k = key(receivedAt, contactName, summary);
    if (seen.has(k)) return add({ row, status: "unchanged", label, message: "同じ受付日時・お名前・概要の問い合わせが登録済みのため、取り込みません。" });
    seen.add(k);
    const notes: string[] = [];
    const codeRaw = get("customerCode");
    const customer = codeRaw ? db.customers.find((c) => c.code === codeRaw) : undefined;
    if (codeRaw && !customer) notes.push(`顧客コード ${codeRaw} が見つからないため、顧客には紐づけません`);
    const asRaw = get("assignee");
    const assignee = asRaw ? pickUser(db, asRaw) : undefined;
    if (asRaw && !assignee) notes.push(`担当者「${asRaw}」が見つからないため、担当者は空欄にします`);
    const dateKey = toDateKey(new Date(receivedAt));
    const inq: Inquiry = {
      id: newId("inq"),
      number: commit ? nextNumber(db, "INQ", db.inquiries, dateKey) : "(登録時に採番)",
      customerId: customer?.id,
      contactName,
      contactPhone: get("contactPhone") || customer?.phone || undefined,
      channel,
      storeId,
      category,
      summary,
      detail: get("detail"),
      status,
      assignedUserId: assignee?.id,
      receivedAt,
      nextAction: get("nextAction") || undefined,
      nextActionDue: due ? toDateKey(new Date(due)) : undefined,
      createdBy: user.id,
      updatedAt: nowIso(),
      source: "import",
      sourceRef: `${opts.sourceLabel}#${row}`,
    };
    if (commit) {
      db.inquiries.push(inq);
      addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `取込で問い合わせを登録 (${contactName} / ${summary}) · ${opts.sourceLabel} ${row} 行目`, storeId });
      if (customer) {
        db.commLogs.push({ id: newId("cl"), customerId: customer.id, channel, direction: "inbound", subject: summary, body: inq.detail || summary, at: receivedAt, userId: user.id, relatedType: "inquiry", relatedId: inq.id });
      }
    }
    add({ row, status: "create", label, message: ["新規に登録します", ...notes].join("。") + "。", href: commit ? `/inquiries/${inq.id}` : undefined });
  });
}

/* ================================================================== */
/* Google スプレッドシート                                                */
/* ================================================================== */

/**
 * 共有リンク (https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<シート>) から CSV の URL を作る。
 * Google のアドレス以外は受け付けない (サーバーから任意の URL へ接続させないため)
 */
export function sheetCsvUrl(link: string): { url: string; label: string } | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!m) return null;
  const gid = (u.hash.match(/gid=(\d+)/) ?? u.search.match(/gid=(\d+)/))?.[1] ?? "0";
  return { url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`, label: `Google スプレッドシート (${m[1].slice(0, 8)}… シート ${gid})` };
}

/** スプレッドシートを CSV として取得する (リンクを知っている全員が閲覧できる共有設定が必要) */
export async function fetchSheetCsv(link: string): Promise<{ text: string; label: string }> {
  const target = sheetCsvUrl(link);
  if (!target) throw new Error("Google スプレッドシートの URL ではありません (https://docs.google.com/spreadsheets/d/… の形式)。");
  const res = await fetch(target.url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { Accept: "text/csv" } });
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 404) throw new Error("スプレッドシートが見つかりません。URL を確認してください。");
  if (!res.ok || type.includes("text/html")) {
    throw new Error("スプレッドシートを読み取れませんでした。共有設定を「リンクを知っている全員 (閲覧者)」にするか、CSV でダウンロードして取り込んでください。");
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error("シートが大きすぎます (4 MB まで)。シートを分けるか、行を絞ってください。");
  return { text: new TextDecoder("utf-8").decode(buf), label: target.label };
}
