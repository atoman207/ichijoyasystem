import "server-only";
import catalog from "@/lib/chatbot/ui-catalog.json";
import type { AnalysisResult } from "./analyze";

/**
 * AI アシスタントの回答の確かめ (回答の安全対策)
 * ------------------------------------------------------------
 * AI の回答を、道具 (検索・集計・資料) の結果と突き合わせて、次の誤りを見つける。誤りがあれば agent.ts が 1 回だけ
 * AI に確かめ直させ、それでも残るものは機械的に直す (リンクを外す・実行したような書き方を断りに置き換える・注記を付ける)
 *  - number: 金額・件数・割合が、道具の結果・質問のどこにもない (AI が推測・計算した数字)
 *  - no_evidence: データの質問なのに、データの道具を使わずに数字で答えた
 *  - action: 登録・変更・削除・承認・送信を「しました」と書いた (この AI は実行できない)
 *  - link: 道具の結果にない記録へのリンク・存在しない画面へのリンク
 *  - screen: 操作の案内で、資料・画面にない「画面・ボタンの名前」を書いた
 * 数字の取り出しと突き合わせ (extractNumbers・numberGrounded) は精度の評価 (src/lib/chatbot/eval.ts) でも使う
 */

export type IssueKind = "number" | "no_evidence" | "action" | "link" | "screen";
export interface AnswerIssue {
  kind: IssueKind;
  detail: string;
  /** high = 確かめ直させる / medium = 確かめ直させる (残っても注記だけ) / low = 機械的に直す */
  severity: "high" | "medium" | "low";
}

export interface AnswerChecks {
  issues: AnswerIssue[];
  /** 確かめ直しを AI にさせた */
  retried: boolean;
  /** 機械的に直したこと */
  fixed: string[];
}

/* ================================================================== */
/* 数字                                                                 */
/* ================================================================== */

export interface FoundNumber {
  raw: string;
  value: number;
  unit: "yen" | "count" | "percent" | "plain";
  /** 丸めの幅 (例: 1,287万 → 10,000。「約」付きは末尾の 0 の桁) */
  tolerance: number;
}

const UNIT_MULT: Record<string, number> = { 億: 1e8, 万: 1e4, 千: 1e3 };
const COUNT_UNITS = /^(件|人|名|社|個|枚|台|本|回|店|か所|箇所|ヶ所|行|畳|帖)/;
/** 数字の後ろがこれなら日付・時刻・順位・コードなので比べない */
const SKIP_AFTER = /^(年|月|日|時|分|秒|位|つ|か月|ヶ月|カ月|ケ月|週|歳|番|号|丁目|期|代|階|割|次|段|部|章|点満点|月度|年度|-|\/|:|：|\.\d|[A-Za-z])/;
/** 数字の前がこれならコード・番号・電話・日付の一部 */
const SKIP_BEFORE = /([A-Za-z\-/:：#＃〒第]|上位|下位|ベスト|トップ|直近|過去|最新の?|先頭の?)$/;

/**
 * 文から金額・件数・割合を取り出す。日付・時刻・順位・番号・電話番号・郵便番号は除く。
 * 単位のない数字は 1,000 以上 (カンマ区切り) だけ (小さい数字は見出しの番号などと区別できないため)
 */
export function extractNumbers(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  const re = /(約|およそ|ほぼ|概算で?|おおよそ)?\s*([¥￥])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(億|万|千)?\s*(円|%|％|ポイント|pt)?/g;
  const t = text.normalize("NFKC");
  for (let m: RegExpExecArray | null; (m = re.exec(t)); ) {
    const [whole, approx, yenMark, intPart, dec, mult, unitWord] = m;
    const start = m.index + (approx ? approx.length : 0);
    const before = t.slice(Math.max(0, start - 6), start).replace(/\s+$/, "");
    const after = t.slice(m.index + whole.length, m.index + whole.length + 6);
    if (SKIP_BEFORE.test(before)) continue;
    if (!unitWord && !mult && SKIP_AFTER.test(after)) continue;
    // 1,234 の後に続く数字 (電話番号 096-123-4567 は - で切れる)
    if (/^\d/.test(after)) continue;
    const base = Number(intPart.replace(/,/g, "") + (dec ? `.${dec}` : ""));
    if (!Number.isFinite(base)) continue;
    const value = base * (mult ? UNIT_MULT[mult] : 1);
    let unit: FoundNumber["unit"] = "plain";
    if (yenMark || unitWord === "円") unit = "yen";
    else if (unitWord === "%" || unitWord === "％" || unitWord === "ポイント" || unitWord === "pt") unit = "percent";
    else if (COUNT_UNITS.test(after.trimStart())) unit = "count";
    else if (mult && /^円/.test(after)) unit = "yen";
    // 単位のない小さな数字は比べない (箇条書きの番号・「3 つ」など)
    if (unit === "plain" && !mult && !/,/.test(intPart) && value < 1000) continue;
    if (unit === "count" && value < 1000 && !approx && !mult && /^\d$/.test(intPart) && /^(つ|人目)/.test(after.trimStart())) continue;
    const decimals = dec ? dec.length : 0;
    let tolerance = unit === "percent" ? 0.15 : 0.5;
    if (mult) tolerance = Math.max(tolerance, UNIT_MULT[mult] * Math.pow(10, -decimals));
    if (approx) {
      const tz = intPart.replace(/,/g, "").match(/0+$/)?.[0].length ?? 0;
      tolerance = Math.max(tolerance, (mult ? UNIT_MULT[mult] : 1) * Math.pow(10, tz) * (unit === "percent" ? 1 : 1), unit === "percent" ? 1 : 0.5);
    }
    out.push({ raw: whole.trim(), value, unit, tolerance });
  }
  return out;
}

/** 根拠の文・表にある数字 (すべて) */
function evidenceValues(text: string): number[] {
  const vals: number[] = [];
  const t = text.normalize("NFKC");
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(億|万|千)?/g;
  for (let m: RegExpExecArray | null; (m = re.exec(t)); ) {
    const base = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    if (!Number.isFinite(base)) continue;
    vals.push(base);
    if (m[3]) vals.push(base * UNIT_MULT[m[3]]);
    // - が前にある (差・減少) も同じ大きさとして使う
  }
  return vals;
}

export interface Evidence {
  /** 道具の結果・質問・会話をつないだ文 (名前の確かめに使う) */
  text: string;
  values: number[];
  hrefs: Set<string>;
}

/** 道具の結果 (AI に返した文)・表・質問・会話から、根拠になる数字とリンクを集める */
export function buildEvidence(parts: string[], tables: AnalysisResult[] = [], extraHrefs: (string | undefined)[] = []): Evidence {
  const text = parts.join("\n");
  const values = evidenceValues(text);
  for (const t of tables) {
    values.push(t.rows.length);
    for (const row of [...t.rows, t.total]) {
      for (const v of Object.values(row ?? {})) {
        if (typeof v === "number" && Number.isFinite(v)) {
          values.push(Math.abs(v));
          // 割合 (0.123) は 12.3% とも書かれる
          if (Math.abs(v) <= 10) values.push(Math.abs(v) * 100);
        }
      }
    }
  }
  const hrefs = new Set<string>();
  for (const m of text.matchAll(/\]\((\/[^)\s]*)\)/g)) hrefs.add(m[1]);
  for (const m of text.matchAll(/(?:画面|href|リンク)[:：=]\s*(\/[^\s)」,、]*)/g)) hrefs.add(m[1]);
  for (const h of extraHrefs) if (h) hrefs.add(h);
  return { text, values, hrefs };
}

/** 数字が根拠のどれかと (丸めの幅の中で) 一致する */
export function numberGrounded(n: FoundNumber, values: number[]): boolean {
  const v = Math.abs(n.value);
  for (const e of values) {
    if (Math.abs(e - v) <= n.tolerance) return true;
    // 割合: 根拠が 0.123 で回答が 12.3%
    if (n.unit === "percent" && Math.abs(e * 100 - v) <= n.tolerance) return true;
  }
  return false;
}

/* ================================================================== */
/* 実行の依頼・実行したような書き方                                          */
/* ================================================================== */

/** データを変える依頼 (登録・変更・削除・承認・送信…してほしい) */
export const WRITE_REQUEST =
  /(登録|追加|変更|削除|承認|却下|差し戻|送信|修正|更新|発行|取り消|取消|キャンセル|消込|入金処理|予約|振替|振り替え|統合)(を|も)?(して(おいて|ください|下さい|ほしい|欲しい|くれ|もらえ|頂け|いただけ)|しといて|しておいて|お願い|頼む|頼みます|しろ|せよ|しなさい)|(消して|送って|直して|書き換えて|変えて|入れて|消しといて|送っといて)(おいて|ください|下さい|ほしい|欲しい|くれ|もらえ)?([。.!！]|$)|(済み?|完了|承認済み?|入金済み?|削除済み?|キャンセル)に(して|しておいて|しといて|変えて)|(登録|追加|変更|削除|承認|却下|送信|修正|更新|発行|取り消|取消|キャンセル)して([。.!！]|$)/;

export function isWriteRequest(question: string): boolean {
  return WRITE_REQUEST.test(question.normalize("NFKC"));
}

const ACTION_VERB = "(登録|追加|変更|削除|承認|却下|差し戻|送信|修正|更新|発行|取り消|取消|キャンセル|消込|入金処理|予約|振り替え|振替|統合|作成|入力|設定)";
/** AI 自身が実行したように書いている */
const ACTION_DONE = new RegExp(`${ACTION_VERB}(し|いたし|させていただき)?(ておきました|ました|ておきます|完了しました|済みです|を完了|を行いました)(?!ら|か|後|あと|ところ)`);
const CANNOT = /できません|行えません|できない|行えない|実行できず|対応できません|権限がありません|画面で|手順/;

function claimsAction(answer: string): boolean {
  // 記録の説明 (「○○さんが 4 月 3 日に承認しました」) と区別するため、人の名前・日付が主語のものは除く
  for (const line of answer.split(/\n|。/)) {
    if (!ACTION_DONE.test(line)) continue;
    // 実行の確認のカードの説明 (「確認のカードを作成しました」「『実行する』を押すと登録されます」) は実行の主張ではない
    if (/カード|を押して|を押すと|押してください/.test(line)) continue;
    if (/(さん|様|氏|店長|社長|担当者|担当|お客様)(が|は)|\d+月\d+日|\d{4}-\d{2}-\d{2}|記録|履歴|によると|されています|されました/.test(line)) continue;
    return true;
  }
  return false;
}

export const ACTION_REFUSAL =
  "この AI アシスタントは、自分ではデータを変えません。予定の登録・変更・削除、問い合わせの登録・状態の変更、受注の進捗の記録、社内連絡・業務依頼、承認・差戻し・却下は、内容を確認のカードで確かめて「実行する」を押すと実行できます (例: 「来週火曜の 10 時に○○様の引取を入れて」)。それ以外の操作は該当する画面で行ってください。手順が分からないときは「○○の登録の仕方は？」のように聞いていただければ、画面とボタンの順にご案内します。";

/* ================================================================== */
/* リンク・画面の名前                                                       */
/* ================================================================== */

type CatalogEntry = { route: string; title?: string; cards?: string[]; fields?: string[]; buttons?: string[]; notes?: string[] };
const CATALOG = catalog as CatalogEntry[];
/**
 * ヘッダーのメニュー (src/app/(app)/layout.tsx の nav と同じ。画面の一覧 ui-catalog.json に入らない名前・画面があるため)。
 * メニューを変えたらここも直す (scripts/tests/chatbot/unit.test.mjs が layout.tsx と突き合わせる)
 */
export const NAV_ITEMS: { href: string; label: string; short?: string }[] = [
  { href: "/", label: "ダッシュボード", short: "ホーム" },
  { href: "/customers", label: "顧客" },
  { href: "/inquiries", label: "問い合わせ" },
  { href: "/quotes", label: "見積" },
  { href: "/orders", label: "受注・施工" },
  { href: "/cases", label: "案件の進捗 (問い合わせ〜入金・全処理完了)", short: "案件進捗" },
  { href: "/schedule", label: "予定表" },
  { href: "/invoices", label: "請求・入金" },
  { href: "/finance", label: "入出金の予定 (未入金・支払待ち)", short: "入出金予定" },
  { href: "/expenses", label: "経費精算" },
  { href: "/cashbook", label: "現金出納帳", short: "現金出納" },
  { href: "/purchases", label: "仕入・買掛 (支払依頼)", short: "仕入・買掛" },
  { href: "/purchase-orders", label: "発注書 (仕入先への発注・FAX 送信)", short: "発注書" },
  { href: "/suppliers", label: "仕入先・協力業者", short: "取引先" },
  { href: "/accounting", label: "会計データの出力 (仕訳・明細)", short: "会計データ" },
  { href: "/capture", label: "書類取込 (紙→データ)", short: "書類取込" },
  { href: "/approvals", label: "承認" },
  { href: "/messages", label: "社内連絡・業務依頼", short: "社内連絡" },
  { href: "/fax", label: "FAX 送受信 (受信の仕分け・発注書の送信の記録)", short: "FAX" },
  { href: "/contacts", label: "連絡履歴 (お客様・協力業者)", short: "連絡履歴" },
  { href: "/ai", label: "AIアシスタント (質問・検索・文書の作成)", short: "AI" },
  { href: "/knowledge", label: "社内資料 (ナレッジ・AI の回答の根拠)", short: "社内資料" },
  { href: "/materials", label: "資料・写真" },
  { href: "/kpi", label: "KPI (アンケート・クレーム・口コミ・インセンティブ)", short: "KPI" },
  { href: "/reports", label: "経営ダッシュボード (売上・受注・施工・請求・経費)", short: "経営" },
  { href: "/management", label: "管理会計 (店舗別損益・内部受注・材料原価・在庫・共通経費の案分)", short: "管理会計" },
  { href: "/data", label: "データ入出力 (CSV・スプレッドシート)", short: "入出力" },
  { href: "/maps", label: "地図・住宅地図 (場所・住宅地図の PDF・一括処理)", short: "地図" },
  { href: "/audit", label: "変更履歴" },
  { href: "/settings", label: "設定", short: "設定" },
  { href: "/help", label: "使い方 (操作説明)", short: "使い方" },
  { href: "/leave", label: "有給・休日出勤 (休暇の申請・承認・振休・年度の取得状況)", short: "有給・休暇" },
  { href: "/office", label: "事務 (事務改善シート・慶弔リスト)", short: "事務" },
  { href: "/heri", label: "縁在庫 (品番 × 場所の数量・入庫・振り分け・使用・棚卸)", short: "縁在庫" },
  { href: "/work-reports", label: "作業日報 (引取・納品の件数・枚数の月次集計)", short: "作業日報" },
  { href: "/promotions", label: "販促と媒体の分析 (チラシ・イベント・DM の反応)", short: "販促分析" },
];

/** (app) の外の画面・メニューの画面 (画面の一覧に入らないもの) */
const EXTRA_ROUTES = ["/", "/login", "/signup", "/help", "/review", "/profile", ...NAV_ITEMS.map((n) => n.href)];

const routePatterns = (() => {
  const list = [...new Set([...CATALOG.map((c) => c.route), ...EXTRA_ROUTES])];
  return list.map((r) => ({ route: r, dynamic: r.includes("["), re: new RegExp(`^${r.replace(/\[[^/]+\]/g, "[^/]+").replace(/\//g, "\\/")}$`) }));
})();

/** 画面のパスが存在する (静的な画面) / 記録の画面 (動的: /orders/xxx) / 存在しない */
export function routeKind(href: string): "static" | "dynamic" | "unknown" {
  const path = href.split(/[?#]/)[0].replace(/\/$/, "") || "/";
  const hits = routePatterns.filter((p) => p.re.test(path));
  if (!hits.length) return "unknown";
  return hits.some((h) => !h.dynamic) ? "static" : "dynamic";
}

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　・「」『』()（）]/g, "").toLowerCase();

const catalogLabels = (() => {
  const out: string[] = [];
  // メニューの名前は、括弧の前の名前 (「案件の進捗」) と短い名前も
  for (const n of NAV_ITEMS) out.push(norm(n.label), norm(n.label.replace(/\s*\(.*\)$/, "")), norm(n.short ?? ""));
  for (const c of CATALOG) {
    for (const s of [c.title ?? "", ...(c.cards ?? []), ...(c.fields ?? []), ...(c.buttons ?? []), ...(c.notes ?? [])]) {
      out.push(norm(s));
      for (const q of s.matchAll(/「([^」]+)」/g)) out.push(norm(q[1]));
    }
  }
  return out.join("\n");
})();

/** 「」で囲んだ画面・ボタンの名前 (矢印でつないだものは分ける) */
function quotedNames(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/「([^」]{1,40})」/g)) {
    for (const part of m[1].split(/\s*(?:→|->|＞|>|›)\s*/)) {
      const p = part.trim();
      if (p.length >= 2 && !/^\d+$/.test(p)) out.push(p);
    }
  }
  return [...new Set(out)];
}

/** 2 文字の組の重なり (質問の言い換えを見分ける) */
function bigramOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  if (!ga.size) return 0;
  const gb = grams(b);
  let hit = 0;
  for (const x of ga) if (gb.has(x)) hit++;
  return hit / ga.size;
}

/* ================================================================== */
/* 確かめる                                                              */
/* ================================================================== */

export interface CheckContext {
  question: string;
  usedData: boolean;
  /** データ (件数・金額・記録) を聞いている質問 */
  dataQuestion: boolean;
  writeRequest: boolean;
  /** 使い方の資料の全文 (画面・ボタンの名前を確かめる。省略 = 画面の一覧だけで確かめる) */
  docsText?: string;
}

export function checkAnswer(answer: string, ev: Evidence, ctx: CheckContext): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  const nums = extractNumbers(answer);
  const facts = nums.filter((n) => n.unit !== "plain" || n.value >= 1000);

  // データの質問なのに、データを調べずに数字で答えた (質問に書かれた数字 (「20 万円の工事なら」) をそのまま使うのは除く)
  const asked = extractNumbers(ctx.question).map((n) => n.value);
  if (ctx.dataQuestion && !ctx.usedData && facts.some((n) => (n.unit === "yen" || n.unit === "count") && !numberGrounded(n, asked))) {
    issues.push({ kind: "no_evidence", detail: "データの道具を使わずに数字を答えています", severity: "high" });
  }
  // 数字の根拠
  const missing = facts.filter((n) => !numberGrounded(n, ev.values));
  for (const n of missing.slice(0, 6)) {
    issues.push({ kind: "number", detail: n.raw, severity: n.unit === "percent" ? "medium" : "high" });
  }
  // 実行したような書き方
  if (claimsAction(answer) && (ctx.writeRequest || !CANNOT.test(answer))) {
    issues.push({ kind: "action", detail: "登録・変更などを実行したように書いています", severity: "high" });
  }
  // リンク
  for (const m of answer.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const href = m[2];
    if (ev.hrefs.has(href)) continue;
    if (!href.startsWith("/") || href.startsWith("//")) {
      issues.push({ kind: "link", detail: href, severity: "low" });
      continue;
    }
    const kind = routeKind(href);
    if (kind === "static") continue;
    issues.push({ kind: "link", detail: href, severity: kind === "unknown" ? "medium" : "low" });
  }
  // 操作の案内の画面・ボタンの名前 (データを答えたときは、品名などの「」と区別できないので確かめない)
  if (!ctx.usedData) {
    const hay = `${norm(ev.text)}\n${catalogLabels}\n${ctx.docsText ? norm(ctx.docsText) : ""}\n${norm(ctx.question)}`;
    for (const name of quotedNames(answer)) {
      const n = norm(name);
      if (n.length < 2 || hay.includes(n)) continue;
      // 「保存ボタン」「顧客の画面」のような書き方は、ボタン・画面を外した名前が資料にあればよい
      const core = n.replace(/(ボタン|画面|タブ|メニュー|欄|リンク|ページ|の一覧|一覧)$/u, "").replace(/^(メニューの?|画面の?)/u, "");
      if (core.length >= 2 && hay.includes(core)) continue;
      // 質問の言い換え (「未入金の請求を入金済みにする」手順は〜) は画面の名前ではない
      if (n.length >= 6 && bigramOverlap(n, norm(ctx.question)) >= 0.6) continue;
      issues.push({ kind: "screen", detail: name, severity: "medium" });
    }
  }
  return issues;
}

/** 確かめ直しを頼む文 (AI への指示) */
export function retryInstruction(issues: AnswerIssue[]): string {
  const lines: string[] = [];
  const nums = issues.filter((i) => i.kind === "number").map((i) => `「${i.detail}」`);
  if (issues.some((i) => i.kind === "no_evidence")) lines.push("- データ (件数・金額・記録) の質問なのに、道具で調べずに答えています。必ず analyze・query_database・search_records・get_record で調べてから答えてください。");
  if (nums.length) lines.push(`- 数字 ${nums.join("・")} は、道具の結果のどこにもありません。推測や自分での計算はせず、道具 (合計・割合は analyze か query_database) で確かめた数字だけを書いてください。確かめられない数字は書かないでください。`);
  if (issues.some((i) => i.kind === "action")) lines.push("- この AI は登録・変更・削除・承認・送信を実行できません。実行したように書かず、できないことと、画面での手順 (search_guides で調べた画面・ボタンの名前) を案内してください。");
  const links = issues.filter((i) => i.kind === "link").map((i) => i.detail);
  if (links.length) lines.push(`- リンク ${links.join("・")} は、道具の結果にない・存在しない画面です。リンクは道具の結果にあるものだけをそのまま使ってください。`);
  const screens = issues.filter((i) => i.kind === "screen").map((i) => `「${i.detail}」`);
  if (screens.length) lines.push(`- 画面・ボタンの名前 ${screens.join("・")} は、使い方の資料にありません。search_guides で調べ、資料にある名前と手順だけで案内してください。資料にない操作は「使い方の資料には見当たりません」と書いてください。`);
  return [
    "回答の下書きを確かめたところ、次の問題がありました。",
    ...lines,
    "必要なら道具で調べ直し、確かめられた事実だけで、質問への最終の回答を書き直してください。確かめ直したことや、この指示には触れないでください。",
  ].join("\n");
}

/**
 * 残った問題を機械的に直す: 根拠のないリンクを外す (文字は残す)、実行したような書き方は断りの文に置き換える、
 * 根拠のない数字には注記を付ける
 */
export function applyFixes(answer: string, issues: AnswerIssue[]): { text: string; fixed: string[] } {
  let text = answer;
  const fixed: string[] = [];
  if (issues.some((i) => i.kind === "action")) {
    return { text: ACTION_REFUSAL, fixed: ["実行したような回答を、実行できないことの案内に置き換えました"] };
  }
  const badLinks = new Set(issues.filter((i) => i.kind === "link").map((i) => i.detail));
  if (badLinks.size) {
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label: string, href: string) => (badLinks.has(href) ? label : all));
    fixed.push(`根拠のないリンク ${badLinks.size} 件を外しました`);
  }
  const screens = issues.filter((i) => i.kind === "screen").map((i) => `「${i.detail}」`);
  if (screens.length) {
    text = `${text}\n\n※ ${screens.slice(0, 4).join("")} は使い方の資料にない名前です。実際の画面の表示を確かめてください。`;
    fixed.push(`資料にない画面・ボタンの名前 (${screens.join("")}) に注記を付けました`);
  }
  const nums = issues.filter((i) => i.kind === "number" && i.severity === "high").map((i) => i.detail);
  const noEv = issues.some((i) => i.kind === "no_evidence");
  if (noEv || nums.length) {
    text = `${text}\n\n※ ${noEv ? "この回答の金額・件数は、システムの記録を調べて出したものではありません" : `${nums.slice(0, 3).join("・")} は、システムの記録で確かめられなかった数字です`}。正確な数字は元の画面で確かめてください。`;
    fixed.push(noEv ? "データで確かめられていない回答に注記を付けました" : `確かめられない数字 (${nums.join("・")}) に注記を付けました`);
  }
  return { text, fixed };
}
