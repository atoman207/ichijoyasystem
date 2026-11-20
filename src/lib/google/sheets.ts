import "server-only";
import { createSign } from "node:crypto";
import fs from "node:fs";

/**
 * Google スプレッドシートの読み取り (サービスアカウント)
 * ------------------------------------------------------------
 * - 鍵: GOOGLE_SERVICE_ACCOUNT_JSON (鍵の JSON そのまま、または base64) か GOOGLE_SERVICE_ACCOUNT_FILE (鍵のファイルのパス)
 * - 鍵で JWT (RS256。iss = サービスアカウントのメール・scope = spreadsheets.readonly・aud = トークンの窓口・有効 1 時間) を作り、
 *   アクセストークンに替える (期限まで使い回す)。Sheets API v4 でシートの名前 (gid → シート名) を調べ、
 *   値 (表示どおりの文字 FORMATTED_VALUE) を読んで CSV にする
 * - 読めるのは、シートの「共有」でサービスアカウントのメールアドレスを閲覧者に追加したシートだけ。
 *   403・404 のときは、そのことを日本語で伝える (呼び出し側 data-io.ts は、リンクの共有のシートなら公開の書き出しで読み直す)
 * - 接続先は Google 固定。GOOGLE_OAUTH_TOKEN_URL・GOOGLE_SHEETS_API_BASE は検証用の差し替え (通常は設定しない)
 * - 外部への接続はこのファイルだけで行う (境界)
 */

const TOKEN_AUD = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const MAX_BYTES = 4 * 1024 * 1024;

const env = (k: string) => process.env[k]?.trim() || "";
const tokenUrl = () => env("GOOGLE_OAUTH_TOKEN_URL") || TOKEN_AUD;
const apiBase = () => (env("GOOGLE_SHEETS_API_BASE") || "https://sheets.googleapis.com").replace(/\/+$/, "");

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  projectId?: string;
}

interface Loaded {
  key: string;
  account?: ServiceAccount;
  error?: string;
  source?: "GOOGLE_SERVICE_ACCOUNT_JSON" | "GOOGLE_SERVICE_ACCOUNT_FILE";
}

let loaded: Loaded | undefined;

function parseKey(text: string): ServiceAccount {
  let raw = text.trim();
  // base64 で入れた鍵 (改行や引用符の扱いに困らないように)
  if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8").trim();
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error("鍵を JSON として読めません (Google Cloud でダウンロードした鍵の JSON を、そのまま か base64 で入れてください)。");
  }
  const clientEmail = typeof j.client_email === "string" ? j.client_email.trim() : "";
  const privateKey = typeof j.private_key === "string" ? j.private_key.replace(/\\n/g, "\n") : "";
  if (j.type && j.type !== "service_account") throw new Error(`鍵の種類が service_account ではありません (${String(j.type)})。`);
  if (!clientEmail || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) throw new Error("鍵に client_email と private_key がありません (サービスアカウントの鍵の JSON を使ってください)。");
  return { clientEmail, privateKey, projectId: typeof j.project_id === "string" ? j.project_id : undefined };
}

/** 設定された鍵 (環境変数が変わったら読み直す)。鍵がなければ account なし */
export function serviceAccount(): Loaded {
  const json = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  const file = env("GOOGLE_SERVICE_ACCOUNT_FILE");
  const key = json ? `json:${json.length}:${json.slice(-16)}` : file ? `file:${file}` : "";
  if (loaded && loaded.key === key) return loaded;
  token = undefined;
  if (!key) return (loaded = { key });
  const source = json ? "GOOGLE_SERVICE_ACCOUNT_JSON" : "GOOGLE_SERVICE_ACCOUNT_FILE";
  try {
    const text = json || fs.readFileSync(file, "utf8");
    loaded = { key, account: parseKey(text), source };
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? `鍵のファイルが見つかりません (${file})。` : (e as Error).message;
    loaded = { key, error: msg, source };
  }
  return loaded;
}

/** 設定画面に出す状態 (鍵の中身は出さない) */
export function googleSheetsStatus(): { configured: boolean; email?: string; source?: string; error?: string } {
  const s = serviceAccount();
  return { configured: Boolean(s.account), email: s.account?.clientEmail, source: s.source, error: s.error };
}

/* ================================================================== */
/* アクセストークン                                                         */
/* ================================================================== */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** サービスアカウントの JWT (RS256) */
export function signJwt(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud: TOKEN_AUD, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(sa.privateKey).toString("base64url")}`;
}

let token: { value: string; exp: number; email: string } | undefined;

/** アクセストークン (期限の 1 分前まで使い回す) */
async function accessToken(sa: ServiceAccount, force = false): Promise<string> {
  if (!force && token && token.email === sa.clientEmail && token.exp - 60_000 > Date.now()) return token.value;
  let assertion: string;
  try {
    assertion = signJwt(sa);
  } catch (e) {
    throw new Error(`サービスアカウントの鍵で署名できませんでした (${(e as Error).message})。鍵の private_key を確かめてください。`);
  }
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`Google のサービスアカウントの認証に失敗しました (${j.error ?? res.status}${j.error_description ? `: ${j.error_description}` : ""})。鍵が無効になっていないか、サーバーの時刻が正しいかを確かめてください。`);
  }
  token = { value: j.access_token, exp: Date.now() + Math.max(60, Math.min(3600, Number(j.expires_in) || 3600)) * 1000, email: sa.clientEmail };
  return token.value;
}

/* ================================================================== */
/* シートの読み取り                                                        */
/* ================================================================== */

/** シートを読めなかったとき (共有されていない・見つからない)。data-io.ts はこのとき公開の書き出しを試す */
export class SheetAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SheetAccessError";
  }
}

const shareHelp = (email: string) => `スプレッドシートの「共有」で、サービスアカウント ${email} を「閲覧者」として追加してください (設定 → 外部連携・AI にも表示しています)。`;

async function api(sa: ServiceAccount, path: string): Promise<Response> {
  const get = async (force: boolean) => fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${await accessToken(sa, force)}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  let res = await get(false);
  // トークンが失効していたら 1 回だけ取り直す
  if (res.status === 401) res = await get(true);
  if (res.status === 403) throw new SheetAccessError(`サービスアカウントにこのスプレッドシートを読む権限がありません。${shareHelp(sa.clientEmail)}`, 403);
  if (res.status === 404) throw new SheetAccessError(`スプレッドシートが見つからないか、サービスアカウントに共有されていません。URL を確かめ、${shareHelp(sa.clientEmail)}`, 404);
  if (res.status === 429 || res.status >= 500) throw new Error(`Google の応答が混み合っています (${res.status})。時間をおいてもう一度お試しください。`);
  if (!res.ok) throw new Error(`スプレッドシートを読み取れませんでした (Google の応答 ${res.status})。`);
  return res;
}

/** 表 (行 × 列) → CSV (RFC 4180。, " 改行を含む項目は "" で囲む)。行の長さは最も長い行にそろえる */
export function valuesToCsv(values: unknown[][]): string {
  const width = values.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return values.map((r) => Array.from({ length: width }, (_, i) => cell(Array.isArray(r) ? r[i] : "")).join(",")).join("\r\n") + (values.length ? "\r\n" : "");
}

/**
 * サービスアカウントでシートを CSV として読む。gid がなければ最初のシート。
 * 読めないとき (共有されていない・見つからない) は SheetAccessError
 */
export async function readSheetCsv(spreadsheetId: string, gid?: string): Promise<{ text: string; title: string; label: string }> {
  const s = serviceAccount();
  if (!s.account) throw new Error(s.error ? `サービスアカウントの鍵を読めません: ${s.error}` : "サービスアカウントが設定されていません。");
  const sa = s.account;
  const id = encodeURIComponent(spreadsheetId);
  const meta = (await (await api(sa, `/v4/spreadsheets/${id}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`)).json()) as { sheets?: { properties?: { sheetId?: number; title?: string } }[] };
  const sheets = (meta.sheets ?? []).map((x) => x.properties ?? {}).filter((p) => typeof p.title === "string");
  if (!sheets.length) throw new Error("スプレッドシートにシートがありません。");
  const sheet = gid !== undefined ? sheets.find((p) => String(p.sheetId) === gid) : sheets[0];
  if (!sheet) throw new Error(`シート (gid=${gid}) が見つかりません。共有リンクを開き直して、シートのタブを選んだ状態の URL を使ってください。`);
  const range = `'${sheet.title!.replace(/'/g, "''")}'`;
  const res = await api(sa, `/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
  const body = await res.text();
  if (body.length > MAX_BYTES * 2) throw new Error("シートが大きすぎます (4 MB まで)。シートを分けるか、行を絞ってください。");
  const values = ((JSON.parse(body) as { values?: unknown[][] }).values ?? []).filter((r) => Array.isArray(r));
  const text = valuesToCsv(values);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("シートが大きすぎます (4 MB まで)。シートを分けるか、行を絞ってください。");
  return { text, title: sheet.title!, label: `Google スプレッドシート (${spreadsheetId.slice(0, 8)}… シート「${sheet.title}」・サービスアカウント)` };
}

/** テスト用: 読み込んだ鍵・トークンを忘れる */
export function resetGoogleSheetsCache(): void {
  loaded = undefined;
  token = undefined;
}
