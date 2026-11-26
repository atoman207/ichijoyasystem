/**
 * 試験期間のデータの本番への引き継ぎ: 違いの取り出しと「まとまり」の計算 (画面 /data/carryover と scripts/ops/testweek-carryover.mjs で共通)
 * ------------------------------------------------------------
 * - 期間の始まりの本番の控え (ndjson.gz の行) とテスト用のデータベースを行ごとに比べ、期間中に増えた・変わった・消えた行を取り出す (diffRows)
 * - ID の参照でつながる行を「まとまり」(お客様 → 問い合わせ → 見積 → 承認・写真・やりとり・変更履歴) に分け、引き継ぐかを決める (groupPlan)
 *   引き継がない: 変更履歴だけ (ログイン・閲覧)・お客様名・件名に「練習」「テスト」・期間外・画面で「引き継がない」にしたもの・--exclude。
 *   画面で「引き継ぐ」にしたもの・--only は練習の印・期間に関係なく引き継ぐ
 * - 引き継ぐ行が参照する、期間中に増えた行 (新しい仕入先など) は一緒に引き継ぐ (依存)
 * このファイルは Node のスクリプトからも読み込むため、import を使わない (表の定義は引数で受け取る)
 */

export interface CarryTableDef {
  collection: string;
  table: string;
  label: string;
  columns: [string, string][];
}

type Row = { id: string } & Record<string, unknown>;

/** まとまりの間をつながない表 (マスタ・社員・設定)。参照されても まとまりは分けたまま (期間中に増えた行は依存として一緒に引き継ぐ) */
export const NO_LINK = new Set(["stores", "users", "settings", "products", "holidays", "suppliers", "materials", "materialCosts", "boms", "itemCategories", "salesAreas", "mgmtRules", "expenseClasses", "faxNumbers", "knowledge"]);
/** 行ごとには引き継がず、別の扱いにする表 */
export const SPECIAL = new Set(["users", "settings", "stores"]);
/** 社員の行で引き継ぐ項目 (本人のプロフィール・パスワード。アカウントの変更は期間中は止めている) */
export const USER_FIELDS = ["email", "passwordHash", "avatarKey", "avatarUpdatedAt", "avatarHidden", "avatarPhotos", "kana", "phone", "notifyEmail", "notifyByEmail", "chatworkAccountId"];
/** 画面の引き継ぎの判断を持つ設定 (テスト用のデータベースにだけ置く。本番には引き継がない) */
export const CARRYOVER_REVIEW_ID = "carryover_review";
/** 引き継がない設定 (サーバーの動きの記録・引き継ぎの判断。本番の側の値を残す) */
export const RUNTIME_SETTINGS = new Set(["knowledge_sync_state", "line_groups", "survey_workbook_state", "inbound_feed", CARRYOVER_REVIEW_ID]);
/** 練習の記録の印 (お客様名・件名・要約に書いてもらう) */
export const PRACTICE = /練習|テスト/;
/** まとまりの名前に使う記録の優先順 */
const ROOT_ORDER = ["customers", "inquiries", "quotes", "orders", "invoices", "payments", "schedule", "expenses", "purchases", "purchaseOrders", "leaveRequests", "qualityIssues", "documents", "commLogs", "threads", "approvals", "attachments"];
/** まとまりの記録の画面 (一覧から開く) */
export const RECORD_HREF: Record<string, string> = { customers: "/customers/", inquiries: "/inquiries/", quotes: "/quotes/", orders: "/orders/", invoices: "/invoices/", expenses: "/expenses/", purchases: "/purchases/", purchaseOrders: "/purchase-orders/", suppliers: "/suppliers/" };

export const KIND_JA = { add: "追加", mod: "変更", del: "削除" } as const;
export const SPECIAL_JA: Record<string, string> = { stores: "店舗", settings: "設定", users: "社員 (新規)" };
const TZ_OFFSET = "+09:00";

// ---------------------------------------------------------------- 値の比べ方

const isTimestamp = (spec: string) => spec.startsWith("timestamptz");

/** 列の型にそろえた値 (Supabase から読んだ値と JSON の値を同じ形で比べる。null・未設定は「なし」) */
export function normValue(spec: string, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (isTimestamp(spec) && typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  if (/^date\b/.test(spec) && typeof v === "string") return v.slice(0, 10);
  if (/^(numeric|bigint|integer)\b/.test(spec) && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (/^text\b(?!\[)/.test(spec) && (typeof v === "number" || typeof v === "boolean")) return String(v);
  if (/^jsonb\b/.test(spec)) return JSON.parse(JSON.stringify(v));
  return v;
}

export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stable(x))).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 行をデータベースの列だけにして正規化した文字列 (列にない項目は Supabase に入らないので比べない) */
export function canonRow(def: CarryTableDef, row: Record<string, unknown> | null | undefined): string | null {
  if (!row) return null;
  const o: Record<string, unknown> = {};
  for (const [f, spec] of def.columns) {
    const v = normValue(spec, row[f]);
    if (v !== undefined) o[f] = v;
  }
  return stable(o);
}

export function canonField(def: CarryTableDef, field: string, v: unknown): string {
  const spec = def.columns.find(([f]) => f === field)?.[1] ?? "text";
  const n = normValue(spec, v);
  return n === undefined ? "null" : stable(n);
}

/** 日本時間の日付 (2026-11-23) か日時 → ISO。end なら日付はその日の終わり */
export function parseWhen(s: string | null | undefined, end = false): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}${TZ_OFFSET}`).toISOString();
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}${TZ_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new Error(`日時を読めません: ${s}`);
  return d.toISOString();
}

export function jst(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}

export function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

// ---------------------------------------------------------------- 違い

export interface CarryNode {
  coll: string;
  id: string;
  kind: "add" | "mod" | "del";
  row: Row;
  base: Row | null;
}

export interface CarryDiff {
  nodes: CarryNode[];
  special: { users: CarryNode[]; settings: CarryNode[] };
}

/**
 * 住所などから自動で入れる項目 (空だった項目に入れただけなら「変わった」に数えない。本番に切り替えたあと本番でも同じように入れる)。
 * customers.postalCode = 住所からの郵便番号 (お客様のご要望 2026-11-24「① 郵便番号の自動設定」。/api/cron/data-fix?task=postal-codes)
 */
export const DERIVED_FIELDS: Record<string, string[]> = { customers: ["postalCode"] };

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** テストの行から、控えで空だった自動の項目を控えの値に戻したもの (自動で入れただけの違いを消す) */
function withoutDerived(coll: string, base: Row, test: Row): Row {
  const fields = DERIVED_FIELDS[coll];
  if (!fields) return test;
  let out: Row | undefined;
  for (const f of fields) if (isBlank(base[f]) && !isBlank(test[f])) (out ??= { ...test })[f] = base[f];
  return out ?? test;
}

/**
 * 期間の始まりの控えの行 ([コレクション, 行] を順に返すもの。ndjson.gz を 1 行ずつ読むとメモリを使わない) と
 * テスト用のデータベースを比べる。並びは表の定義の順 → テスト用のデータベースの行の順 → 消えた行
 */
export async function diffRows(tables: CarryTableDef[], baseLines: AsyncIterable<[string, Row]> | Iterable<[string, Row]>, test: Record<string, unknown>): Promise<CarryDiff> {
  const defs = new Map(tables.map((t) => [t.collection, t]));
  const testIdx = new Map<string, Map<string, Row>>();
  for (const t of tables) testIdx.set(t.collection, new Map(((test[t.collection] as Row[] | undefined) ?? []).map((r) => [r.id, r])));
  const seen = new Map<string, Map<string, Row>>(); // コレクション → 控えにあった行 (テストの ID → 控えの行。変わった行だけ)
  const same = new Map<string, Set<string>>();
  const dels = new Map<string, Row[]>();
  for await (const [coll, br] of baseLines as AsyncIterable<[string, Row]>) {
    const def = defs.get(coll);
    if (!def) continue;
    const tr = testIdx.get(coll)!.get(br.id);
    if (!tr) (dels.get(coll) ?? dels.set(coll, []).get(coll)!).push(br);
    else if (canonRow(def, br) !== canonRow(def, withoutDerived(coll, br, tr))) (seen.get(coll) ?? seen.set(coll, new Map()).get(coll)!).set(br.id, br);
    else (same.get(coll) ?? same.set(coll, new Set()).get(coll)!).add(br.id);
  }
  const nodes: CarryNode[] = [];
  const special = { users: [] as CarryNode[], settings: [] as CarryNode[] };
  const push = (n: CarryNode) => (SPECIAL.has(n.coll) ? (n.coll === "users" ? special.users : special.settings).push(n) : nodes.push(n));
  for (const t of tables) {
    const mods = seen.get(t.collection);
    const unchanged = same.get(t.collection);
    for (const r of ((test[t.collection] as Row[] | undefined) ?? [])) {
      const br = mods?.get(r.id);
      if (br) push({ coll: t.collection, id: r.id, kind: "mod", row: r, base: br });
      else if (!unchanged?.has(r.id)) push({ coll: t.collection, id: r.id, kind: "add", row: r, base: null });
    }
    for (const br of dels.get(t.collection) ?? []) push({ coll: t.collection, id: br.id, kind: "del", row: br, base: br });
  }
  return { nodes, special };
}

// ---------------------------------------------------------------- まとまり

export interface CarryGroup {
  id: string;
  label: string;
  rootColl: string;
  store: string;
  first: string | null;
  last: string | null;
  actors: string[];
  counts: Record<string, { add: number; mod: number; del: number }>;
  selected: boolean;
  reason: string;
  /** 画面の判断 (include = 引き継ぐ / exclude = 引き継がない) */
  decision?: "include" | "exclude";
  /** 練習の印がある */
  practice: boolean;
  pulled: string[];
  idxs: number[];
}

export interface CarryOptions {
  since?: string | null;
  until?: string | null;
  exclude?: string[];
  only?: string[];
  settings?: string[];
  noUsers?: boolean;
  keepPractice?: boolean;
  /** 画面での判断 (まとまりの ID) */
  review?: { include?: string[]; exclude?: string[] };
}

export interface CarryGroupPlan {
  groups: CarryGroup[];
  settings: { coll: string; id: string; kind: CarryNode["kind"]; selected: boolean; reason: string }[];
  rows: Record<string, { upsert: { id: string; row: Row; base: Row | null }[]; delete: { id: string; base: Row | null }[] }>;
  users: { id: string; name: string; fields: Record<string, { before: unknown; after: unknown }> }[];
  /** ファイル (写真・資料) のキーの候補 (引き継ぐ行の中の「a/b」の形の文字。ファイルがあるかはディスクで確かめる) */
  fileCandidates: string[];
  window: { since: string | null; until: string | null };
}

function rowLabel(defs: Map<string, CarryTableDef>, customers: Map<string, string>, node: CarryNode): string {
  const r = node.row as Record<string, unknown>;
  const def = defs.get(node.coll);
  const num = (r.number ?? r.code ?? "") as string;
  const name = String(r.name ?? r.contactName ?? r.title ?? r.subject ?? r.summary ?? r.fileName ?? r.entityLabel ?? "");
  const found = typeof r.customerId === "string" && node.coll !== "customers" ? customers.get(r.customerId) : undefined;
  const cust = found && found !== name ? found : null;
  const verb = node.kind === "add" ? "" : node.kind === "mod" ? " (変更)" : " (削除)";
  return `${def?.label ?? node.coll} ${num} ${name.slice(0, 40)}${cust ? ` / ${cust} 様` : ""}${verb}`.replace(/\s+/g, " ").trim();
}

/** 行の「操作の日時」(業務の日付 = 受付日・見積日などは使わない。システムが付けた日時だけ) */
function activityAt(node: CarryNode): string | null {
  const r = node.row as Record<string, unknown>;
  if (node.coll === "auditLogs") return (r.at as string) ?? null;
  if (node.kind === "add") return ((r.createdAt ?? r.uploadedAt ?? r.requestedAt ?? r.updatedAt) as string | undefined) ?? null;
  if (node.kind === "mod" && r.updatedAt && r.updatedAt !== node.base?.updatedAt) return r.updatedAt as string;
  return null;
}

export function groupPlan(tables: CarryTableDef[], diff: CarryDiff, test: Record<string, unknown>, opts: CarryOptions): CarryGroupPlan {
  const defs = new Map(tables.map((t) => [t.collection, t]));
  const { nodes, special } = diff;
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const customers = new Map(((test.customers as Row[] | undefined) ?? []).map((c) => [c.id, String(c.name ?? "")]));

  // 1. つながり (ID の参照) でまとまりに分ける
  const byId = new Map<string, number[]>();
  nodes.forEach((n, i) => (byId.get(n.id) ?? byId.set(n.id, []).get(n.id)!).push(i));
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const x = find(a), y = find(b);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const deps = nodes.map(() => new Set<number>());
  nodes.forEach((n, i) => {
    for (const s of strings(n.row)) {
      if (s === n.id || s.length < 4) continue;
      for (const j of byId.get(s) ?? []) {
        if (j === i) continue;
        if (nodes[j].kind === "add") deps[i].add(j);
        // 変更履歴は、その記録 (entityId) のまとまりに入れる (マスタの変更の履歴も)
        if ((!NO_LINK.has(nodes[j].coll) && !NO_LINK.has(n.coll)) || (n.coll === "auditLogs" && s === n.row.entityId)) union(i, j);
      }
    }
  });
  const groupsMap = new Map<number, number[]>();
  nodes.forEach((_, i) => (groupsMap.get(find(i)) ?? groupsMap.set(find(i), []).get(find(i))!).push(i));

  const users = new Map(((test.users as Row[] | undefined) ?? []).map((u) => [u.id, String(u.name ?? "")]));
  const exclude = opts.exclude ?? [], only = opts.only ?? [];
  const rvInclude = new Set(opts.review?.include ?? []), rvExclude = new Set(opts.review?.exclude ?? []);
  const matches = (idxs: number[], tokens: string[]) => tokens.some((tok) => idxs.some((i) => nodes[i].id === tok || nodes[i].row.number === tok || nodes[i].row.code === tok));
  const groups: CarryGroup[] = [];
  for (const idxs of groupsMap.values()) {
    const rank = (i: number) => {
      const r = ROOT_ORDER.indexOf(nodes[i].coll);
      return (r < 0 ? 99 : r) + (nodes[i].kind === "add" ? 0 : 100);
    };
    const root = [...idxs].sort((a, b) => rank(a) - rank(b) || a - b)[0];
    const id = nodes[root].id;
    const times = idxs.map((i) => activityAt(nodes[i])).filter((x): x is string => Boolean(x)).sort();
    const first = times[0] ?? null, last = times[times.length - 1] ?? null;
    const actors = new Set<string>();
    for (const i of idxs) for (const k of ["createdBy", "userId", "uploadedBy", "requestedBy", "updatedBy", "decidedBy"]) {
      const v = nodes[i].row[k];
      if (typeof v === "string" && users.has(v) && (nodes[i].kind !== "mod" || k === "updatedBy" || nodes[i].coll === "auditLogs")) actors.add(users.get(v)!);
    }
    const counts: CarryGroup["counts"] = {};
    for (const i of idxs) (counts[nodes[i].coll] ??= { add: 0, mod: 0, del: 0 })[nodes[i].kind]++;
    const store = String(idxs.map((i) => nodes[i].row.storeId).find(Boolean) ?? "");
    const practice = idxs.some((i) => nodes[i].kind === "add" && PRACTICE.test([nodes[i].row.name, nodes[i].row.contactName, nodes[i].row.title, nodes[i].row.summary].filter(Boolean).join(" ")));
    const decision = rvExclude.has(id) ? "exclude" : rvInclude.has(id) ? "include" : undefined;
    let selected = true, reason = "";
    if (idxs.every((i) => nodes[i].coll === "auditLogs")) { selected = false; reason = "変更履歴だけ (ログイン・閲覧など)"; }
    else if (decision === "exclude") { selected = false; reason = "画面で「引き継がない」にした"; }
    else if (only.length && !matches(idxs, only)) { selected = false; reason = "--only の指定にない"; }
    else if (exclude.length && matches(idxs, exclude)) { selected = false; reason = "--exclude で除外"; }
    else if (decision === "include" || matches(idxs, only)) reason = decision === "include" ? "画面で「引き継ぐ」にした" : "";
    else if (!opts.keepPractice && practice) { selected = false; reason = "名前・件名に「練習」「テスト」(練習の記録)"; }
    else if (!first && (since || until)) { selected = false; reason = "操作の日時が分からない"; }
    else if (since && first! < since) { selected = false; reason = `期間より前 (${jst(first)})`; }
    else if (until && first! > until) { selected = false; reason = `期間より後 (${jst(first)})`; }
    groups.push({ id, label: rowLabel(defs, customers, nodes[root]), rootColl: nodes[root].coll, store, first, last, actors: [...actors], counts, idxs, selected, reason, decision, practice, pulled: [] });
  }
  groups.sort((a, b) => String(a.first ?? "~").localeCompare(String(b.first ?? "~")) || a.label.localeCompare(b.label));

  // 2. 引き継ぐ行 + 依存 (引き継ぐ行が参照する、期間中に増えた行)
  const chosen = new Set(groups.filter((g) => g.selected).flatMap((g) => g.idxs));
  const groupOf = new Map(groups.flatMap((g) => g.idxs.map((i) => [i, g] as [number, CarryGroup])));
  const auditOf = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    if (n.coll !== "auditLogs" || typeof n.row.entityId !== "string") return;
    (auditOf.get(n.row.entityId) ?? auditOf.set(n.row.entityId, []).get(n.row.entityId)!).push(i);
  });
  const queue = [...chosen];
  while (queue.length) {
    const i = queue.pop()!;
    for (const j of deps[i]) {
      if (chosen.has(j)) continue;
      chosen.add(j);
      queue.push(j);
      groupOf.get(j)!.pulled.push(rowLabel(defs, customers, nodes[j]));
      // 一緒に引き継ぐ行の変更履歴も
      for (const k of auditOf.get(nodes[j].id) ?? []) chosen.add(k);
    }
  }

  // 3. 社員 (本人のプロフィール) と設定
  const userDef = defs.get("users")!;
  const userPatches: CarryGroupPlan["users"] = [];
  if (!opts.noUsers) {
    for (const s of special.users) {
      if (s.kind !== "mod") continue;
      const fields: Record<string, { before: unknown; after: unknown }> = {};
      for (const f of USER_FIELDS) if (canonField(userDef, f, s.row[f]) !== canonField(userDef, f, s.base![f])) fields[f] = { before: s.base![f] ?? null, after: s.row[f] ?? null };
      if (Object.keys(fields).length) userPatches.push({ id: s.row.id, name: String(s.row.name ?? ""), fields });
    }
  }
  const wantSettings = new Set(opts.settings ?? []);
  const settingRows: { coll: string; id: string; row: Row; base: Row | null }[] = [];
  const settingList: CarryGroupPlan["settings"] = [];
  // 期間中に増えた社員 (新規登録の申請) は、設定と同じく指定したものだけ (users:<ID>)
  for (const s of [...special.settings, ...special.users.filter((u) => u.kind === "add")]) {
    const want = (wantSettings.has(s.row.id) || wantSettings.has(`${s.coll}:${s.row.id}`)) && !RUNTIME_SETTINGS.has(s.row.id);
    settingList.push({ coll: s.coll, id: s.row.id, kind: s.kind, selected: want, reason: want ? "" : RUNTIME_SETTINGS.has(s.row.id) ? "サーバーの動きの記録・引き継ぎの判断 (引き継がない)" : "指定したものだけ (--settings・画面)" });
    if (want && s.kind !== "del") {
      settingRows.push({ coll: s.coll, id: s.row.id, row: s.row, base: s.base ?? null });
      // 引き継ぐ設定の変更履歴も
      for (const k of auditOf.get(s.row.id) ?? []) {
        if (chosen.has(k)) continue;
        chosen.add(k);
        groupOf.get(k)?.pulled.push(`${SPECIAL_JA[s.coll] ?? s.coll} ${s.row.id} の変更履歴`);
      }
    }
  }

  // 4. 書く行・元の行・ファイルの候補
  const rows: CarryGroupPlan["rows"] = {};
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const n = nodes[i];
    const r = (rows[n.coll] ??= { upsert: [], delete: [] });
    if (n.kind === "del") r.delete.push({ id: n.id, base: n.base });
    else r.upsert.push({ id: n.id, row: n.row, base: n.base });
  }
  for (const s of settingRows) (rows[s.coll] ??= { upsert: [], delete: [] }).upsert.push({ id: s.id, row: s.row, base: s.base });
  const fileCandidates = new Set<string>();
  const candRows = [...Object.values(rows).flatMap((r) => r.upsert.map((u) => u.row)), ...userPatches.map((p) => Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, v.after])))];
  for (const row of candRows) for (const s of strings(row)) if (/^[\w.-]+(\/[\w.-]+)+$/.test(s) && !s.includes("..")) fileCandidates.add(s);
  return { groups, settings: settingList, rows, users: userPatches, fileCandidates: [...fileCandidates], window: { since, until } };
}

/** 一覧の CSV (Excel で開く。BOM は呼び出し側で付ける) */
export function carryoverCsv(tables: CarryTableDef[], plan: Pick<CarryGroupPlan, "groups" | "users" | "settings">): string {
  const defs = new Map(tables.map((t) => [t.collection, t]));
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["引き継ぐ", "まとまりの ID", "内容", "店舗", "最初の操作 (日本時間)", "最後の操作", "操作した人", "行の内訳", "理由・注意"].map(q).join(",")];
  for (const g of plan.groups) {
    const detail = Object.entries(g.counts).map(([c, n]) => `${defs.get(c)?.label ?? c} ${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${KIND_JA[k as keyof typeof KIND_JA]}${v}`).join("・")}`).join(" / ");
    const note = [g.reason, g.pulled.length ? `ほかのまとまりが参照するため一緒に引き継ぐ: ${g.pulled.join("、")}` : ""].filter(Boolean).join(" / ");
    lines.push([g.selected ? "○" : g.pulled.length ? "△ (一部)" : "×", g.id, g.label, g.store, jst(g.first), jst(g.last), g.actors.join("・"), detail, note].map(q).join(","));
  }
  for (const u of plan.users) lines.push(["○", u.id, `社員 ${u.name} (${Object.keys(u.fields).map((f) => (f === "passwordHash" ? "パスワード" : f)).join("・")})`, "", "", "", "", "社員 変更", "本人のプロフィール"].map(q).join(","));
  for (const s of plan.settings) lines.push([s.selected ? "○" : "×", s.id, `${SPECIAL_JA[s.coll] ?? s.coll} ${s.id} (${KIND_JA[s.kind]})`, "", "", "", "", "", s.reason].map(q).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** 画面での判断 (テスト用のデータベースの settings の id = carryover_review) */
export interface CarryoverReview {
  include: string[];
  exclude: string[];
  /** 引き継ぐ設定の ID (例: operations) */
  settings: string[];
  since?: string;
  until?: string;
  /** 最終判断 (引き継ぐと決めた日時と人) */
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

export function readCarryoverReview(test: Record<string, unknown>): CarryoverReview {
  const row = ((test.settings as Row[] | undefined) ?? []).find((s) => s.id === CARRYOVER_REVIEW_ID);
  const v = (row?.value ?? {}) as Partial<CarryoverReview>;
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return { include: arr(v.include), exclude: arr(v.exclude), settings: arr(v.settings), since: v.since || undefined, until: v.until || undefined, decidedAt: v.decidedAt || undefined, decidedBy: v.decidedBy || undefined, note: v.note || undefined };
}
