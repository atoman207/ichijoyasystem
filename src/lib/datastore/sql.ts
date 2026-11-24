import "server-only";
import { Worker } from "node:worker_threads";
import type { User } from "@/lib/db/types";
import { TABLES, snake } from "@/lib/db/schema";
import { AMOUNT_KEYS, AMOUNT_LABEL } from "@/lib/assistant/facts";
import type { AnalysisColumn, AnalysisResult, Cell } from "@/lib/assistant/analyze";
import { mirrorPath, mirrorReady } from "./mirror";
import { CODE_COLUMNS, VIEWS, dataModelText, labelRows, scopeStatements, viewStatements } from "./model";

/**
 * 「列 = 'コード'」「列 in ('…')」のコードが、その列の正しいコードか確かめる。誤り (推測したコード・日本語の名前) なら、
 * 使えるコードの一覧を返す (AI が直して呼び直す。0 件の答えを避ける)。
 * どの表の列か分かるときだけ確かめる (「別名.列」は FROM・JOIN の別名から、別名なしの列は参照する表がすべてコードの表のとき)。
 * 一覧にないコードでも、実際のデータにある値 (移行データの古いコードなど) は通す (runSql が確かめる: probes)
 */
export interface CodeProbe {
  /** その列を持つ表 (どれかにその値があれば正しい) */
  tables: string[];
  col: string;
  value: string;
  message: string;
}
const NOT_ALIAS = new Set(["where", "join", "left", "right", "inner", "outer", "cross", "natural", "on", "using", "group", "order", "limit", "having", "union", "except", "intersect", "window", "as"]);

export function checkCodes(sql: string): CodeProbe[] {
  const tables = new Map<string, string>(); // 別名・表名 → 表名
  const referenced = new Set<string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+([a-z_]\w*)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)) {
    const t = m[1].toLowerCase();
    referenced.add(t);
    tables.set(t, t);
    const alias = m[2]?.toLowerCase();
    if (alias && !NOT_ALIAS.has(alias)) tables.set(alias, t);
  }
  if (![...referenced].some((t) => CODE_COLUMNS[t])) return [];
  const allCodeTables = [...referenced].every((t) => CODE_COLUMNS[t]);
  const codes = new Map<string, Map<string, string>>();
  for (const [kind, code, label] of labelRows()) {
    if (!codes.has(kind)) codes.set(kind, new Map());
    codes.get(kind)!.set(code, label);
  }
  const problems: CodeProbe[] = [];
  const re = /(?:\b([a-z_]\w*)\.)?\b([a-z_]\w*)\s*(?:=|<>|!=|\bin\s*\(|\bnot\s+in\s*\()\s*((?:'(?:[^']|'')*'\s*,?\s*)+)/gi;
  for (const m of sql.matchAll(re)) {
    const col = m[2].toLowerCase();
    let owners: string[];
    if (m[1]) {
      const t = tables.get(m[1].toLowerCase());
      owners = t && CODE_COLUMNS[t]?.[col] ? [t] : [];
    } else owners = allCodeTables ? [...referenced].filter((t) => CODE_COLUMNS[t][col]) : [];
    if (!owners.length) continue;
    const kinds = [...new Set(owners.map((t) => CODE_COLUMNS[t][col]))];
    const values = [...m[3].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    for (const v of values) {
      if (kinds.some((k) => codes.get(k)?.has(v))) continue;
      const list = kinds.map((k) => [...(codes.get(k) ?? new Map<string, string>())].map(([c, l]) => `${c}=${l}`).join(", ")).join(" / ");
      problems.push({ tables: owners, col, value: v, message: `${col} = '${v}' はこの列のコードではありません。使えるコード: ${list}` });
    }
  }
  return problems;
}

const CODE_HINT = "(コードで条件を書き直してください。日本語の名前で絞るときは *_label の列を使います)";

/**
 * VPS のデータベース (mirror.ts) への読み取り専用の SQL (AI アシスタントの道具 query_database)
 * ------------------------------------------------------------
 * - SELECT (WITH から始まるものを含む) の 1 文だけ。読み取り専用で開き (readOnly・query_only)、書き換えはできない
 * - 別のスレッド (worker) で実行し、15 秒を超えたら止める (重い問い合わせでもサーバーの応答を止めない)
 * - 返す行は 500 行まで
 * - 問い合わせの前に、統合データモデル (model.ts) の一時ビューを作る。全店舗を見られない人は、その前に生の表を
 *   閲覧範囲で絞った一時ビューで覆う (同じ名前の一時ビューが優先されるため、SQL もビューも範囲の内側になる)。
 *   覆いを外す「main.表」の書き方は断る
 */

const TIMEOUT_MS = 15_000;
const MAX_ROWS = 500;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec("pragma busy_timeout = 5000;");
  // 閲覧範囲の覆いと統合ビュー (一時ビュー) を作ってから、読み取りだけにする
  for (const s of workerData.setup) db.exec(s);
  db.exec("pragma query_only = 1;");
  // 一覧にないコード: 実際のデータにもなければ、使えるコードを返して書き直してもらう
  const wrong = workerData.probes.filter((p) => !p.tables.some((t) => {
    try { return db.prepare("select 1 from " + t + " where " + p.col + " = ? limit 1").get(p.value) !== undefined; } catch { return false; }
  }));
  if (wrong.length) throw new Error(wrong.map((p) => p.message).join("\\n") + "\\n" + workerData.hint);
  const stmt = db.prepare(workerData.sql);
  const columns = typeof stmt.columns === "function" ? stmt.columns().map((c) => c.name) : null;
  const rows = [];
  let more = false;
  for (const r of stmt.iterate()) {
    if (rows.length >= workerData.limit) { more = true; break; }
    rows.push(r);
  }
  parentPort.postMessage({ ok: true, rows, columns, more });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
} finally {
  try { db && db.close(); } catch {}
}
`;

export interface SqlResult {
  ok: boolean;
  error?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  more: boolean;
  ms: number;
}

/** SELECT の 1 文か確かめる (コメントと最後の ; は外す)。問題があればその理由 */
export function checkSql(raw: string): { sql: string } | { error: string } {
  let sql = raw
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  if (!sql) return { error: "SQL が空です。" };
  if (sql.length > 8000) return { error: "SQL が長すぎます。" };
  // 文字列の中の ; は数えない
  const outside = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (outside.includes(";")) return { error: "SQL は 1 文だけにしてください。" };
  if (!/^(select|with)\b/i.test(sql)) return { error: "SELECT (または WITH) で始まる読み取りの SQL だけを実行できます。" };
  if (/\b(attach|detach|pragma|vacuum|insert|update|delete|drop|create|alter|reindex|load_extension|savepoint|release|begin|commit|rollback)\b/i.test(outside) || /\breplace\s+into\b/i.test(outside)) {
    return { error: "読み取り (SELECT) 以外の命令は使えません。" };
  }
  // 「main.表」は閲覧範囲の覆いを外すため使えない (どの書き方でも)
  if (/(?:\bmain|"main"|\[main\]|`main`)\s*\./i.test(outside)) return { error: "表の名前に main. は付けないでください (そのまま 表の名前 で書きます)。" };
  sql = sql.replace(/\s+/g, " ");
  const lint = bareAggregate(sql);
  if (lint) return { error: lint };
  return { sql };
}

/**
 * よくある集計の誤り: GROUP BY なしで、集計関数 (MAX・SUM など) と集計していない列を一緒に選ぶ。
 * SQLite はその列に 1 行分の値を入れて返すため、「お客様ごとの残高の一番」が「1 件の請求の最大」になる (エラーにならず誤る)。
 * 断って、GROUP BY で数え直させる (サブクエリ・ウィンドウ関数・WITH は対象外)
 */
export function bareAggregate(sql: string): string | undefined {
  const s = sql.replace(/'(?:[^']|'')*'/g, "''").toLowerCase();
  if (/\bgroup\s+by\b/.test(s) || /\bover\s*\(/.test(s) || /^\s*with\b/.test(s)) return undefined;
  const m = s.match(/^\s*select\s+(?:distinct\s+)?([\s\S]*?)\sfrom\s/);
  if (!m) return undefined;
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  items.push(cur.trim());
  if (items.some((i) => /\(\s*select\b/.test(i))) return undefined;
  if (!items.some((i) => /\b(max|min|sum|count|avg|total|group_concat)\s*\(/.test(i))) return undefined;
  const bare = items.filter((i) => !i.includes("(") && !/^(''|-?\d+(\.\d+)?|null|true|false)(\s|$)/.test(i));
  if (!bare.length) return undefined;
  const cols = bare.map((i) => i.split(/\s+/)[0]).join("・");
  return `集計関数 (MAX・SUM・COUNT など) と、集計していない列 (${cols}) を GROUP BY なしで一緒に選んでいます。SQLite ではその列は 1 行分の値になり、「お客様ごとの一番」が「1 件の最大」になって誤ります。お客様・店舗・担当者ごとに比べるときは GROUP BY (例: group by customer_id, customer_name) で SUM・COUNT を数え、order by ... desc limit 1 で並べてください。全体の 1 行だけなら、集計していない列を外してください。`;
}

export async function runSql(raw: string, user: Pick<User, "id" | "role" | "storeId">): Promise<SqlResult> {
  const t0 = Date.now();
  if (!mirrorReady()) return { ok: false, error: "VPS のデータベースを準備中です。少し待ってから、もう一度お試しください。", columns: [], rows: [], more: false, ms: 0 };
  const checked = checkSql(raw);
  if ("error" in checked) return { ok: false, error: checked.error, columns: [], rows: [], more: false, ms: 0 };
  const probes = checkCodes(checked.sql);
  return new Promise<SqlResult>((resolve) => {
    const setup = [...scopeStatements(user), ...viewStatements()];
    const worker = new Worker(WORKER, { eval: true, workerData: { file: mirrorPath(), sql: checked.sql, limit: MAX_ROWS, setup, probes, hint: CODE_HINT } });
    let done = false;
    const finish = (r: Omit<SqlResult, "ms">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...r, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `問い合わせが ${TIMEOUT_MS / 1000} 秒を超えたため止めました。条件を絞るか、集計の表 (sales_orders・sales_items) を使ってください。`, columns: [], rows: [], more: false }), TIMEOUT_MS);
    worker.once("message", (m: { ok: boolean; error?: string; rows?: Record<string, unknown>[]; columns?: string[] | null; more?: boolean }) => {
      const rows = m.rows ?? [];
      finish({ ok: m.ok, error: m.error, rows, columns: m.columns ?? Object.keys(rows[0] ?? {}), more: Boolean(m.more) });
    });
    worker.once("error", (err) => finish({ ok: false, error: err.message, columns: [], rows: [], more: false }));
  });
}

/* ================================================================== */
/* 表の説明 (AI に渡す)                                                  */
/* ================================================================== */

/** 主な表の列の意味 (AI が SQL を書くときの手がかり) */
const NOTES: Record<string, string> = {
  sales_orders:
    "受注 1 件 = 1 行 (キャンセルを除く)。売上の分析はまずこの表。sales_date = 売上計上日 (施工完了日。売上の集計の日付)、contract_date = 契約日、total = 金額 (税込)、" +
    `amt_* = 種別ごとの金額 (税込: ${AMOUNT_KEYS.map((k) => `amt_${k}=${AMOUNT_LABEL[k]}`).join("・")})、tatami_cost = 畳原価、purchase_cost = 案件にひも付いた仕入、` +
    "staff_names = 担当 (営業担当。見積の担当者、移行データは販売管理ソフトの担当者欄の 1 番目)、worker_names = 施工担当 (移行データは担当者欄の 2 番目も)、store_id = koshi(合志店)/chuo(中央店)/nishi(西店)/tamana(玉名店)/hq(本部・ショールーム)、area = 地区",
  sales_items: "明細 1 行 = 1 行。product = 品名 (分類つき。例: 畳 きずな)、category = 種別 (畳・襖・障子・網戸・カーテン・ブラインド・クロス・自社商品・小売・諸経費・雑工事・値引)、qty = 数量、unit_price・amount = 税込。sales_date で期間を絞る",
  order_staff: "受注と担当 (営業担当)。担当者別の集計はこの表を sales_orders と結合する (経営ダッシュボードの担当者別と同じ)",
  orders: "受注・施工の元の表。status = pending_approval/returned/confirmed/scheduled/in_progress/completed/invoiced/paid/cancelled。amounts = 種別の内訳 (JSON)、progress_notes = 経過 (JSON 配列。移行データは明細・担当者欄を含む)",
  customers: "顧客。code = 顧客コード、contacts = ほかの連絡先 (JSON 配列: relation・name・phone)、area = 地区、trade_stopped = 取引停止 (1)",
  schedule_events: "予定。date〜end_date、start_time・end_time、kind = 予定の種類 (pickup=引き取り/delivery=納品/install=施工/survey=見積り (現地調査)/onsite_quote=現場見積 (現見: 現場で見積もりをしてそのまま工事)/visit=顧客訪問/site=現場管理/measure=採寸/meeting=会議/leave=休暇 など)、assignee_ids = 担当者の ID (JSON 配列。users.id と結合するときは json_each)",
  inquiries: "問い合わせ。received_at = 受付日時、channel = 受付経路、status = new/in_progress/quoted/won/lost/closed",
  quotes: "見積。items = 明細 (JSON)、status = draft/pending_approval/approved/sent/accepted/rejected/expired、order_id = 受注",
  invoices: "請求。total・paid_amount (税込)、status = issued/partially_paid/overdue/paid/void、due_date = 支払期限",
  payments: "入金。invoice_id で請求と結合 (店舗は請求の store_id)",
  users: "社員。id・name・role (admin/hq_staff/store_manager/store_staff)・store_id。パスワードは入っていない",
  knowledge: "社内資料 (業務ルール・議事録・マニュアル)。visibility が空か all 以外のものは、質問した人が見られる範囲か確かめてから使う",
  audit_logs: "変更履歴 (誰がいつ何をしたか)。changes = 変更前と変更後 (JSON)",
};

/** 表の一覧 (道具の説明に入れる短いもの) */
export function tableList(): string {
  return [
    ...VIEWS.map((v) => `${v.name} (統合ビュー: ${v.label.replace(/\s*\(.*$/, "")})`),
    "sales_orders (分析用: 受注ごとの売上・種別の内訳・原価・担当者)",
    "sales_items (分析用: 明細。商品・数量・単価・金額)",
    "order_staff (分析用: 受注と担当者)",
    ...TABLES.map((t) => `${t.table} (${t.label.replace(/\s*\(.*$/, "")})`),
  ].join(", ");
}

/** データモデルと表の列 (describe_database の結果)。names を省くと統合データモデルの全体 */
export function describeTables(names: string[], user: Pick<User, "role">): string {
  const views = names.filter((n) => VIEWS.some((v) => v.name === n));
  const tables = names.filter((n) => !VIEWS.some((v) => v.name === n));
  if (!tables.length) return dataModelText(user, views);
  const wanted = tables;
  const derived: Record<string, string[]> = {
    sales_orders: ["order_id", "number", "sales_date", "contract_date", "status", "store_id", "store_name", "customer_id", "customer_code", "customer_name", "customer_type", "area", "title", "total", ...AMOUNT_KEYS.map((k) => `amt_${k}`), "tatami_cost", "purchase_cost", "staff_names", "worker_names", "item_source"],
    sales_items: ["order_id", "line_no", "sales_date", "store_id", "customer_id", "category", "product", "qty", "unit_price", "amount"],
    order_staff: ["order_id", "staff_name"],
  };
  const out: string[] = [];
  for (const name of wanted.slice(0, 12)) {
    const def = TABLES.find((t) => t.table === name || t.collection === name);
    const cols = derived[name] ?? def?.columns.filter(([f]) => !(def.collection === "users" && /password/i.test(f))).map(([f, spec]) => `${snake(f)} ${spec.split(" ")[0]}`);
    if (!cols) {
      out.push(`- ${name}: その名前の表はありません`);
      continue;
    }
    out.push(`## ${def?.table ?? name}${def ? ` (${def.label})` : ""}\n列: ${cols.join(", ")}${NOTES[def?.table ?? name] ? `\n説明: ${NOTES[def?.table ?? name]}` : ""}`);
  }
  out.push("※ 配列・入れ子の列は JSON の文字列 (json_extract・json_each で読む)。真偽は 0/1。日付は YYYY-MM-DD、日時は ISO 8601 (UTC)。金額は税込");
  return out.join("\n\n");
}

/* ================================================================== */
/* 結果を表にする                                                        */
/* ================================================================== */

const YEN = /(sales|total|amount|price|cost|gross|revenue|paid|売上|金額|単価|原価|粗利|入金|請求|円)/i;
const COUNT = /(count|件数|^n$|_n$|qty|数量|人数|回数)/i;

export function sqlTable(r: SqlResult, sql: string, title: string): AnalysisResult {
  const columns: AnalysisColumn[] = r.columns.map((c) => {
    const nums = r.rows.map((x) => x[c]).filter((v) => v !== null && v !== undefined);
    const numeric = nums.length > 0 && nums.every((v) => typeof v === "number" || typeof v === "bigint");
    return { key: c, label: c, kind: !numeric ? "text" : YEN.test(c) ? "yen" : COUNT.test(c) ? "count" : "number" };
  });
  const rows = r.rows.map((x) => Object.fromEntries(r.columns.map((c) => [c, typeof x[c] === "bigint" ? Number(x[c]) : ((x[c] ?? null) as Cell)])));
  const first = columns[0];
  const nums = columns.filter((c) => c.kind !== "text");
  const timeLike = first && rows.every((x) => typeof x[first.key] === "string" && /^\d{4}(-\d{2})?(-\d{2})?$|^\d{4}年/.test(String(x[first.key])));
  const chart =
    first && first.kind === "text" && nums.length && rows.length >= 2 && rows.length <= 60
      ? { kind: (timeLike ? "time" : "bars") as "time" | "bars", x: first.key, series: nums.slice(0, timeLike ? 6 : 1).map((c) => ({ key: c.key, label: c.label })), unit: (nums[0].kind === "yen" ? "yen" : nums[0].kind === "count" ? "count" : "plain") as "yen" | "count" | "plain" }
      : undefined;
  return {
    ok: true,
    title: title.slice(0, 60) || "データベースの集計",
    period: { from: "", to: "", label: "VPS のデータベース" },
    spec: { sql, title },
    columns,
    rows,
    total: {},
    omitted: 0,
    notes: [`VPS のデータベースに SQL で問い合わせた結果 (${rows.length} 行${r.more ? `。${MAX_ROWS} 行で打ち切り` : ""}、${r.ms}ms)`, `SQL: ${sql.slice(0, 600)}`],
    chart,
  };
}
