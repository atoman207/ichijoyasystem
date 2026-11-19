import "server-only";
import type { Database, User } from "@/lib/db/types";
import { ROLE_LABEL } from "@/lib/constants";
import { toDateKey } from "@/lib/format";
import { canSeeAllStores, canViewChatLog, canViewKnowledge } from "@/lib/auth/permissions";
import { runToolLoop, type ToolCall, type ToolDef } from "@/lib/ai/provider";
import { searchKnowledge } from "@/lib/knowledge";
import { listChatLogs, searchDocs } from "@/lib/chatbot/store";
import { analysisCatalog, analysisText, runAnalysis, type AnalysisResult, type AnalysisSpec } from "./analyze";
import { getRecord, lastSearchSource, listSchedule, searchAll, storeScopeNote, RECORD_TYPE_LABEL } from "./search";
import { scheduleSuggestTool } from "./schedule-tool";
import { permissionHints } from "@/lib/chatbot/permission-hints";
import { describeTables, runSql, sqlTable, tableList } from "@/lib/datastore/sql";
import { METRICS, VIEWS } from "@/lib/datastore/model";
import { mirrorReady } from "@/lib/datastore/mirror";

/**
 * 社内 AI アシスタント (画面左下の「質問する」と AI アシスタントの画面)
 * ------------------------------------------------------------
 * AI に「道具」を渡し、質問に合わせて AI が道具を選んで呼ぶ (OpenAI の function calling / Claude の tool use)。
 *  - search_records: システム内の横断検索 (顧客・案件・見積・請求・予定・経費・仕入・議事録・連絡履歴…)
 *  - get_record: 記録の詳細 (顧客なら施工履歴・前回の担当者・連絡履歴まで)
 *  - list_schedule: 期間・店舗・担当者の予定
 *  - analyze: 売上・粗利・数量・単価などの自由な集計 (表とグラフは画面に自動で出す。数字は必ずここで計算する)
 *  - search_guides: 使い方・画面・権限・社内資料 (操作の手順や、集計を画面で行う方法の案内)
 *  - search_history: 過去の相談 (同じ質問の繰り返しを減らす)
 *  - suggest_schedule: 予定の候補日の提案 (src/lib/schedule-suggest.ts がある場合)
 * 閲覧範囲は道具の中で確かめる (質問した社員の権限の範囲だけを返す)。回答の根拠 (記録・集計・資料) は画面に一覧で出す
 */

export interface AgentTurn {
  role: "user" | "assistant";
  content: string;
  /** その回答で使った集計の条件 (続けて「店舗別にして」などと聞かれたときに使う) */
  specs?: AnalysisSpec[];
}

export interface AgentSource {
  label: string;
  href?: string;
  kind: string;
}

export interface AgentReply {
  answer: string;
  tables: AnalysisResult[];
  sources: AgentSource[];
  tools: { name: string; summary: string }[];
  /** データ (記録・集計) の道具を使った */
  usedData: boolean;
  /** 社内資料 (ナレッジ) を使った (回答を蓄えない: 資料が変わると古くなるため) */
  usedKnowledge: boolean;
  /** 使い方の資料の key (チャットボットの資料。回答を蓄えるときの根拠) */
  docKeys: string[];
  unknown: boolean;
  provider: string;
  ms: number;
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
const strs = (v: unknown, max = 10) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 60)).slice(0, max) : undefined);

const TYPES = Object.keys(RECORD_TYPE_LABEL);

/**
 * VPS のデータベース (統合データモデル) への SQL を使える。全員 (店舗のロールは、表とビューが自店舗の範囲で覆われる:
 * src/lib/datastore/model.ts の scopeStatements)
 */
const canUseSql = (user: User) => user.active !== false && process.env.ICHIJOYA_DATA_DB !== "off";

function tools(user: User): ToolDef[] {
  const list: ToolDef[] = [
    {
      name: "search_records",
      description: `システム内のあらゆる記録を言葉で横断検索する。顧客名・電話番号・番号 (O-2026-0012 など)・地名・品名・工事内容・会議名・業務ルールの言葉など。種類: ${Object.entries(RECORD_TYPE_LABEL).map(([k, v]) => `${k}=${v}`).join(", ")}。言葉は空白で区切って渡す (例: "田中 網戸")。結果は ID・見出し・抜粋・画面のリンク。詳しく見るときは get_record。`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "探す言葉 (空白区切り。敬称は不要)。期間と種類だけで一覧したいときは空でもよい" },
          types: { type: "array", items: { type: "string", enum: TYPES }, description: "種類を絞る (省略 = すべて)" },
          from: { type: "string", description: "記録の日付の始まり YYYY-MM-DD (任意)" },
          to: { type: "string", description: "記録の日付の終わり YYYY-MM-DD (任意)" },
          store: { type: "string", description: "店舗 (id または名前。任意)" },
          limit: { type: "integer", description: "件数 (既定 15、最大 40)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_record",
      description: "記録の詳細を見る。顧客なら連絡先・累計売上・受注と施工の履歴 (明細・担当者・施工担当)・前回の担当者・見積・問い合わせ・請求・予定・連絡履歴。受注なら明細・経過・予定・請求・発注書・仕入・クレーム。仕入先なら発注と仕入の履歴。社内資料なら本文。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: TYPES, description: "記録の種類 (分かれば)" },
          ref: { type: "string", description: "ID (検索結果の id) または番号 (O-2026-0012・Q-…・INQ-…・INV-…・顧客コード・PO-…)" },
        },
        required: ["ref"],
      },
    },
    {
      name: "list_schedule",
      description: "予定表 (全社共有) の予定を期間で一覧する。店舗・担当者・種類・言葉で絞れる。「来週の合志店の予定」「明日の○○さんの予定」など。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD" },
          to: { type: "string", description: "YYYY-MM-DD" },
          store: { type: "string", description: "店舗 (id または名前)" },
          staff: { type: "string", description: "担当者の名前 (一部でよい)" },
          kind: { type: "string", description: "予定の種類 (例: 引き取り・納品・施工・現地調査・会議)" },
          keyword: { type: "string", description: "件名・メモ・場所に含む言葉" },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "analyze",
      description: `売上・粗利・数量・単価・件数などを、期間・店舗・種別・商品・顧客・担当者・地区などを自由に組み合わせて集計する。数字は必ずこの道具で出す (自分で計算しない)。結果の表とグラフは画面に自動で表示される。\n指標と軸:\n${analysisCatalog()}\n- 比較: compare=previous_year (前年同期) / previous_period (直前の同じ長さ)。only=decreased/increased で減った・増えた行だけ。\n- 2 つの軸 (例: month と store) は表を縦横にする (pivot)。\n- 商品の絞り込み products は品名の一部 (例: "きずな", "18メッシュ")。表記ゆれがあるので、まず group_by=["product"] で品名の一覧を見てから絞るとよい。\n- 商品・数量・平均単価は明細のある受注だけ。原価・粗利は商品ごとには出せない。`,
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["sales", "inquiries", "quotes", "expenses", "purchases", "payments", "schedule"] },
          metrics: { type: "array", items: { type: "string" }, description: "指標 (最大 4。先頭が並べ替え・グラフの基準)" },
          group_by: { type: "array", items: { type: "string" }, description: "集計の軸 (最大 3。省略 = 合計だけ)" },
          from: { type: "string", description: "期間の始まり YYYY-MM-DD" },
          to: { type: "string", description: "期間の終わり YYYY-MM-DD" },
          date_basis: { type: "string", enum: ["sales", "contract"], description: "売上の日付: sales=売上計上日 (既定) / contract=契約日 (受注金額)" },
          stores: { type: "array", items: { type: "string" }, description: "店舗で絞る (id または名前)" },
          categories: { type: "array", items: { type: "string" }, description: "種別で絞る (畳・襖・障子・網戸・カーテン・クロス・諸経費…)" },
          products: { type: "array", items: { type: "string" }, description: "商品・品名の一部で絞る (OR)" },
          customers: { type: "array", items: { type: "string" }, description: "顧客名・コードの一部で絞る (仕入では仕入先名)" },
          staff: { type: "array", items: { type: "string" }, description: "担当者・施工担当の名前で絞る" },
          areas: { type: "array", items: { type: "string" }, description: "地区・住所の一部で絞る" },
          statuses: { type: "array", items: { type: "string" }, description: "状態のコードで絞る (例: 問い合わせの未対応・対応中 = new・in_progress / 見積の失注 = rejected / 経費の承認待ち = pending_approval / 受注の施工完了 = completed)。コードの一覧は describe_database" },
          compare: { type: "string", enum: ["none", "previous_year", "previous_period"] },
          only: { type: "string", enum: ["decreased", "increased"] },
          sort_by: { type: "string", description: "並べ替える指標 (例: sales・sales_diff)。label = 軸の順" },
          order: { type: "string", enum: ["asc", "desc"] },
          limit: { type: "integer", description: "行数 (既定 50、最大 200)" },
          pivot: { type: "boolean", description: "軸が 2 つのとき縦横の表にする (既定: 1 つ目が時間の軸なら true)" },
          title: { type: "string", description: "表の見出し (任意)" },
        },
        required: ["subject", "from", "to"],
      },
    },
    {
      name: "search_guides",
      description: "システムの使い方・画面の場所・操作の手順・権限・承認ルール・社内資料 (業務ルール・議事録・マニュアル・商品知識・価格・施工方法) を探す。操作方法の質問や、分析を画面で行う方法 (経営ダッシュボード・CSV 出力など) を案内するときに使う。",
      parameters: { type: "object", properties: { query: { type: "string", description: "探す内容 (例: 見積の修正 方法 / 店舗別 商品別 売上 集計)" } }, required: ["query"] },
    },
    {
      name: "search_history",
      description: "過去の相談 (この AI アシスタントへの質問と回答) を探す。同じ質問が前にあったか、以前どう答えたかを確かめる。",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  ];
  if (scheduleSuggestTool) list.push(scheduleSuggestTool.def);
  if (canUseSql(user)) {
    list.push(
      {
        name: "describe_database",
        description: "一畳屋の統合データモデル (VPS のデータベース) を見る。省略すると、統合ビュー (v_*) の一覧と列・表どうしのつながり・指標の定義 (売上・粗利・受注…)・言葉と表の対応を返す。表の名前を渡すと、その表の全部の列を返す。query_database の前に使う。",
        parameters: { type: "object", properties: { tables: { type: "array", items: { type: "string" }, description: "列を見たい表・ビューの名前 (省略 = データモデルの全体)" } }, required: [] },
      },
      {
        name: "query_database",
        description: `VPS のデータベース (システムの全データと統合ビュー。SQLite) に読み取りの SQL (SELECT の 1 文) で問い合わせ、結果の表を得る。件数・一覧・条件の組み合わせ・記録の突き合わせ・自由な集計に使う。結果の表は画面に表示される。まず統合ビュー (名前と日本語の状態つき) を使う: ${VIEWS.map((v) => v.name).join(", ")}。ほかの表: ${tableList()}。列が分からなければ describe_database。日付は 'YYYY-MM-DD' の文字列で比べる。表の名前に main. を付けない。結果は 500 行まで。`,
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SQLite の SELECT 文 (1 文。WITH 可)" },
            title: { type: "string", description: "結果の表の見出し (例: 2026年 店舗別・担当者別の売上)" },
          },
          required: ["sql", "title"],
        },
      },
    );
  }
  return list;
}

function systemPrompt(db: Database, user: User, now: Date): string {
  const today = toDateKey(now);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  const staff = db.users.filter((u) => u.active).map((u) => `${u.name} (${ROLE_LABEL[u.role]}・${db.stores.find((s) => s.id === u.storeId)?.shortName ?? u.storeId}${u.title ? `・${u.title}` : ""})`);
  return [
    "あなたは株式会社一畳屋 (熊本の畳・襖・障子・網戸・カーテン・クロスの専門店。合志店・中央店・西店・玉名店と本社・坪井ショールーム) の社内 AI アシスタントです。",
    "社員 (社長を含む) からの業務の質問に、システムに登録されている情報を根拠に答えます。",
    "",
    `## 今日\n${today} (${wd})`,
    `## 質問している人\n${user.name} (${ROLE_LABEL[user.role]}・${db.stores.find((s) => s.id === user.storeId)?.name ?? user.storeId})。閲覧範囲: ${storeScopeNote(db, user)}`,
    `## 店舗\n${db.stores.map((s) => `${s.id}=${s.name}`).join(" / ")}`,
    `## 社員 (いま有効なアカウント)\n${staff.join("、")}\n(移行した過去の売上の担当者には、退職した社員の名前もあります)`,
    "",
    "## 答え方のルール",
    "1. 数字・日付・名前・件数などの事実は、必ず道具で調べた結果だけを使う。推測で補わない。計算 (合計・比較・割合・平均) は analyze で行い、自分で計算しない。",
    "2. 調べても見つからないとき・データがないときは、そのことをはっきり書く (例:「システムには○○の記録がありません」)。判断できないときもそう書く。",
    "3. 根拠になった記録は、道具の結果にある [番号や名前](/画面のパス) のリンクをそのまま本文に付ける。資料から答えたときは「(社内資料: タイトル)」のように示す。",
    "4. analyze の結果の表とグラフは画面に自動で表示される。本文では表を書き写さず、要点 (合計・上位・増減・目立つ点) を 3〜6 行でまとめる。前提は、その集計の「注記」に書かれているものだけを一言添える (注記にない前提を書かない)。どの期間で集計したかを必ず書く。",
    "5. 「今年」= 1 月 1 日〜今日、「昨年」= 前年の 1/1〜12/31、「今月」「先月」は暦の月、「過去 3 年間」= 今年を含む 3 暦年 (年ごとに比較) のように解釈し、解釈した期間を書く。期間の指定がないときは、件数・人数・一覧・順位 (一番多い〜など) は登録されている全期間で数え、売上の推移・比較の分析だけは直近 12 か月にする。どちらの場合も、数えた期間を書く。",
    "5b. 「比較して」は、質問にある軸 (店舗・商品・担当者など) どうしの比較のこと。前年・前の期間との比較 (compare) は、質問に「前年」「昨年」「前期」「去年と」などの言葉があるときだけ使う。",
    "6. 直接集計できないとき (データがない・軸がない・権限がない) は、その理由を書き、search_guides で調べて、経営ダッシュボード・CSV 出力などの画面で目的の集計にたどり着く手順を案内する。",
    "7. 操作方法の質問は、質問に付いた「参考資料」か search_guides の結果に書かれている画面・ボタン・手順だけで答える (一般的なシステムの知識で補わない)。「メニュー → 画面 → ボタン」の順に番号付きの手順で、画面・ボタンの名前は資料の表記のまま「」で書く。資料に書かれていない操作は「使い方の資料には見当たりません」と書き、店長・管理者への確認を勧める。権限がない操作は、誰に頼めばよいかを書く。",
    "8. この AI は登録・変更・削除・承認・送信を行えない。依頼されたら、画面での操作手順を案内する。",
    "9. 会話の続き (「店舗別にして」「前年と比べて」「その中で一番は？」) は、前の回答の [分析条件] を引き継いで analyze を呼び直す。[分析条件] は内部の情報なので、回答には書かない。",
    "10. 日本語のです・ます調で、簡潔に。見出しは使わず、必要なら短い箇条書き (・) と **太字** を使う。Markdown の表は書かない (表は画面に出る)。",
    "11. 過去に同じような相談がありそうなら search_history で確かめてもよい。ただし古い回答の数字はそのまま使わず、必要なら調べ直す。",
    "",
    "## 道具の使い方のこつ",
    "- 顧客の質問 (「○○様の施工履歴」「前回の担当者」) は search_records (types: customer) → get_record (type: customer)。",
    "- 「似たような工事」は search_records で工事内容・品名の言葉を探す (types: order, quote)。",
    "- 会議・決定事項・ルールは search_records (types: knowledge, schedule, thread) と search_guides の両方を見る。",
    "- 仕入先・発注履歴は search_records (types: supplier) → get_record (type: supplier)。",
    "- 売上の分析は analyze (subject: sales)。商品名は表記ゆれがあるので、まず品名の一覧を見てから絞る。",
    scheduleSuggestTool ? "- 新しい案件・訪問の予定の候補日は suggest_schedule。" : "",
    canUseSql(user)
      ? [
          "",
          "## 統合データモデル (VPS のデータベース。query_database で SQL を書いて読む)",
          `統合ビュー: ${VIEWS.map((v) => `${v.name} = ${v.label}`).join(" / ")}`,
          `指標の定義: ${METRICS.map((m) => m.name).join("・")} (詳しくは describe_database)`,
          canSeeAllStores(user) ? "" : "この人の閲覧範囲 (自店舗) のデータだけが入っている。",
          "## 正確に答える手順",
          "- 件数・一覧・合計・「前回の〜」「〜のお客様は何人」のようなデータの質問は、推測せず query_database (統合ビュー) か analyze で数えてから答える。顧客・案件の詳しい中身は get_record。",
          "- 質問の条件 (状態・期間・店舗・人・種類など) は 1 つも落とさない。analyze の引数で表せない条件があるときは query_database で SQL に書く。",
          "- SQL を書く前に describe_database で、使うビューの列と指標の定義を確かめる (1 回の会話で 1 度でよい)。",
          "- 結果が 0 件・思ったより少ないときは、名前の表記 (like '%…%')・期間・状態の条件を見直して、もう 1 回だけ調べ直す。それでも無ければ「記録がありません」と答える。",
          "- 数字は結果の表の値をそのまま書く (丸めるときは「約」を付ける)。どの定義・期間で数えたかを一言添える。",
          "- SQL の誤りが返ってきたら、誤りの内容を読んで直して呼び直す。",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function specSummary(s: AnalysisSpec): string {
  return [s.subject, (s.metrics ?? []).join("+"), s.group_by?.length ? `by ${s.group_by.join("×")}` : "", `${s.from}〜${s.to}`, s.stores?.length ? `店舗 ${s.stores.join("・")}` : "", s.products?.length ? `商品 ${s.products.join("・")}` : "", s.compare && s.compare !== "none" ? s.compare : ""].filter(Boolean).join(" ");
}

/** 道具を実行し、AI に返す文字と、画面に出す表・根拠を集める */
function makeExecutor(db: Database, user: User, now: Date, out: { tables: AnalysisResult[]; sources: AgentSource[]; tools: AgentReply["tools"]; usedData: boolean; usedKnowledge: boolean; docKeys: string[] }) {
  const addSource = (s: AgentSource) => {
    if (out.sources.some((x) => x.href === s.href && x.label === s.label)) return;
    if (out.sources.length < 20) out.sources.push(s);
  };
  return async (call: ToolCall): Promise<string> => {
    const a = call.args;
    switch (call.name) {
      case "search_records": {
        out.usedData = true;
        const r = searchAll(db, user, { query: str(a.query) ?? "", types: strs(a.types, 20), from: str(a.from), to: str(a.to), store: str(a.store), limit: typeof a.limit === "number" ? a.limit : undefined });
        out.tools.push({ name: lastSearchSource === "database" ? "横断検索 (VPS のデータベース)" : "横断検索", summary: `${str(a.query) || "(言葉なし)"}${strs(a.types)?.length ? ` [${strs(a.types)!.map((t) => RECORD_TYPE_LABEL[t as keyof typeof RECORD_TYPE_LABEL] ?? t).join("・")}]` : ""} → ${r.total} 件` });
        for (const h of r.hits.slice(0, 4)) addSource({ label: h.label, href: h.href, kind: h.typeLabel });
        if (!r.total) return "見つかりませんでした (閲覧できる範囲の記録に当てはまるものはありません)。言葉を変える・減らす、種類を変えて探し直すこともできます。";
        return `${r.total} 件${r.partial ? " (すべての言葉を含む記録はなく、一部の言葉で探した結果)" : ""}。種類別: ${Object.entries(r.counts).map(([k, v]) => `${RECORD_TYPE_LABEL[k as keyof typeof RECORD_TYPE_LABEL]} ${v}`).join("、")}\n${r.hits.map((h) => `- [${h.typeLabel}] id=${h.id} ${h.href ? `[${h.label}](${h.href})` : h.label} ${h.date ? `(${h.date})` : ""}: ${h.snippet}`).join("\n")}`;
      }
      case "get_record": {
        out.usedData = true;
        const r = getRecord(db, user, str(a.type), str(a.ref) ?? "");
        out.tools.push({ name: "記録の詳細", summary: r.label ?? str(a.ref) ?? "" });
        if (r.ok && r.label) addSource({ label: r.label, href: r.href, kind: r.type ? RECORD_TYPE_LABEL[r.type] : "記録" });
        // 顧客の詳細を見たときは、直近の受注も根拠に並べる (施工履歴の質問の答えを元の画面で確かめられるように)
        if (r.ok && r.type === "customer" && r.id) {
          const recent = db.orders.filter((o) => o.customerId === r.id && o.status !== "cancelled").sort((x, y) => (y.salesDate ?? y.contractDate).localeCompare(x.salesDate ?? x.contractDate)).slice(0, 3);
          for (const o of recent) addSource({ label: `受注 ${o.number} ${o.title}`.slice(0, 40), href: `/orders/${o.id}`, kind: RECORD_TYPE_LABEL.order });
        }
        return r.text;
      }
      case "list_schedule": {
        out.usedData = true;
        const from = str(a.from) ?? toDateKey(now);
        const to = str(a.to) ?? from;
        const r = listSchedule(db, { from, to, store: str(a.store), staff: str(a.staff), kind: str(a.kind), keyword: str(a.keyword) });
        out.tools.push({ name: "予定の一覧", summary: `${from}〜${to}${str(a.store) ? ` ${str(a.store)}` : ""}${str(a.staff) ? ` ${str(a.staff)}` : ""} → ${r.count} 件` });
        addSource({ label: `予定表 ${from}〜${to}`, href: `/schedule?date=${from}`, kind: "予定表" });
        return r.text;
      }
      case "analyze": {
        out.usedData = true;
        const spec: AnalysisSpec = {
          subject: str(a.subject) as AnalysisSpec["subject"],
          metrics: strs(a.metrics, 4),
          group_by: strs(a.group_by, 3),
          from: str(a.from, 10),
          to: str(a.to, 10),
          date_basis: str(a.date_basis) as AnalysisSpec["date_basis"],
          stores: strs(a.stores),
          categories: strs(a.categories),
          products: strs(a.products),
          customers: strs(a.customers),
          staff: strs(a.staff),
          areas: strs(a.areas),
          statuses: strs(a.statuses),
          compare: str(a.compare) as AnalysisSpec["compare"],
          only: str(a.only) as AnalysisSpec["only"],
          sort_by: str(a.sort_by, 40),
          order: str(a.order) as AnalysisSpec["order"],
          limit: typeof a.limit === "number" ? a.limit : undefined,
          pivot: typeof a.pivot === "boolean" ? a.pivot : undefined,
          title: str(a.title, 60),
        };
        const r = runAnalysis(db, user, spec, now);
        if (!r.ok) {
          out.tools.push({ name: "集計", summary: `できませんでした: ${r.error}` });
          return `集計できませんでした: ${r.error}${r.hint ? `\nヒント: ${r.hint}` : ""}`;
        }
        // 同じ条件の表は 1 つにする (AI が同じ集計を呼び直したとき)
        const key = JSON.stringify(r.spec);
        const i = out.tables.findIndex((t) => JSON.stringify(t.spec) === key);
        if (i >= 0) out.tables[i] = r;
        else if (out.tables.length < 4) out.tables.push(r);
        out.tools.push({ name: "集計", summary: specSummary(r.spec) });
        addSource({ label: r.title, kind: "集計" });
        return analysisText(r, 60);
      }
      case "search_guides": {
        const q = str(a.query, 300) ?? "";
        const docs = searchDocs(q, 6).filter((d) => d.kind !== "knowledge");
        const know = searchKnowledge(db.knowledge.filter((k) => canViewKnowledge(user, k)), q, { limit: 4, minCoverage: 0.2 });
        out.tools.push({ name: "使い方・社内資料", summary: q });
        for (const d of docs.slice(0, 3)) {
          out.docKeys.push(d.key);
          if (d.href) addSource({ label: d.title.replace(/^(使い方|画面の詳細|画面|権限|ロール): /, ""), href: d.href, kind: "使い方" });
        }
        for (const h of know.slice(0, 3)) addSource({ label: h.entry.title, href: `/knowledge/${h.entry.id}`, kind: "社内資料" });
        if (know.length) out.usedKnowledge = true;
        const perms = permissionHints(q, user.role);
        if (!docs.length && !know.length) return `使い方の資料・社内資料に当てはまるものはありませんでした。${perms.length ? `\n## このロール (${ROLE_LABEL[user.role]}) の権限 (関係しそうなもの)\n${perms.join("\n")}` : ""}`;
        return [
          ...(perms.length ? [`## このロール (${ROLE_LABEL[user.role]}) の権限 (関係しそうなもの。操作を案内する前に確かめる)\n${perms.join("\n")}`] : []),
          ...docs.map((d) => `### ${d.title}${d.href ? ` (画面: ${d.href})` : ""}\n${d.body.slice(0, 1500)}`),
          ...know.map((h) => `### 社内資料: ${h.entry.title} (分類 ${h.entry.category || "その他"}${h.entry.recordDate ? ` / 日付 ${h.entry.recordDate}` : ""}) [開く](/knowledge/${h.entry.id})\n${h.entry.body.slice(0, 2000)}`),
        ].join("\n\n");
      }
      case "search_history": {
        const q = str(a.query, 200) ?? "";
        const scope = canSeeAllStores(user) ? "all" : user.role === "store_manager" ? "store" : "self";
        const r = listChatLogs({ scope, userId: user.id, storeId: user.storeId, q, limit: 6 });
        const rows = r.rows.filter((x) => canViewChatLog(user, x));
        // 過去の相談は人ごとの情報なので、回答を蓄えない
        out.usedData = true;
        out.tools.push({ name: "過去の相談", summary: `${q} → ${rows.length} 件` });
        if (!rows.length) return "過去の相談に当てはまるものはありませんでした。";
        for (const x of rows.slice(0, 2)) addSource({ label: `過去の相談: ${x.question.slice(0, 30)}`, href: `/ai?tab=history&id=${x.id}`, kind: "過去の相談" });
        return rows.map((x) => `- ${x.at.slice(0, 10)} ${x.userName}: Q「${x.question}」\n  A: ${x.answer.replace(/\n/g, " ").slice(0, 400)} [履歴](/ai?tab=history&id=${x.id})`).join("\n");
      }
      case "describe_database": {
        if (!canUseSql(user)) return "この道具は使えません。";
        out.tools.push({ name: "データモデル", summary: (strs(a.tables, 12) ?? []).join("・") || "全体" });
        return describeTables(strs(a.tables, 12) ?? [], user);
      }
      case "query_database": {
        if (!canUseSql(user)) return "この道具は使えません。";
        if (!mirrorReady()) return "VPS のデータベースを準備中です。analyze・search_records を使ってください。";
        out.usedData = true;
        const sql = str(a.sql, 8000) ?? "";
        const title = str(a.title, 60) ?? "データベースの集計";
        const r = await runSql(sql, user);
        if (!r.ok) {
          out.tools.push({ name: "データベース (SQL)", summary: `誤り: ${(r.error ?? "").slice(0, 80)}` });
          return `SQL を実行できませんでした: ${r.error}\nSQL: ${sql}`;
        }
        const t = sqlTable(r, sql, title);
        if (out.tables.length < 4) out.tables.push(t);
        out.tools.push({ name: "データベース (SQL)", summary: `${title} → ${r.rows.length} 行 (${r.ms}ms)` });
        addSource({ label: `${title} (VPS のデータベース)`, kind: "データベース" });
        return `${analysisText(t, 60)}`;
      }
      case "suggest_schedule": {
        if (!scheduleSuggestTool) return "予定の候補日の提案は、まだ使えません。";
        out.usedData = true;
        const r = scheduleSuggestTool.run(db, user, a, now);
        out.tools.push({ name: "予定の候補日", summary: r.summary });
        if (r.href) addSource({ label: "予定の候補日", href: r.href, kind: "予定表" });
        return r.text;
      }
    }
    return `不明な道具です: ${call.name}`;
  };
}

/** 会話の流れ (前の回答で使った集計の条件を添える) */
function toMessages(history: AgentTurn[], question: string): { role: "user" | "assistant"; content: string }[] {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const h of history.slice(-8)) {
    if (!h.content.trim()) continue;
    if (!turns.length && h.role !== "user") continue;
    const content = h.role === "assistant" && h.specs?.length ? `${h.content.slice(0, 2500)}\n\n[分析条件: ${h.specs.map((s) => JSON.stringify(s)).join(" / ")}]` : h.content.slice(0, 2500);
    const last = turns[turns.length - 1];
    if (last && last.role === h.role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role: h.role, content });
  }
  if (turns.length && turns[turns.length - 1].role === "user") turns.pop();
  return [...turns, { role: "user", content: question }];
}

export async function runAgent(db: Database, user: User, history: AgentTurn[], question: string, opts: { now?: Date; prefetchGuides?: boolean } = {}): Promise<AgentReply> {
  const now = opts.now ?? new Date();
  const t0 = Date.now();
  const out = { tables: [] as AnalysisResult[], sources: [] as AgentSource[], tools: [] as AgentReply["tools"], usedData: false, usedKnowledge: false, docKeys: [] as string[] };
  const execute = makeExecutor(db, user, now, out);
  const messages = toMessages(history, question);
  // 操作の質問は、使い方の資料を先に探して質問に添える (AI が資料を見ずに一般的な手順を答えないように)
  let prefetched: AgentSource[] = [];
  if (opts.prefetchGuides) {
    const before = out.sources.length;
    const guides = await execute({ id: "prefetch", name: "search_guides", args: { query: question } });
    prefetched = out.sources.slice(before);
    out.tools.pop();
    messages[messages.length - 1] = { role: "user", content: `${question}\n\n---\n参考資料 (システムが自動で探した使い方・社内資料。操作の案内はここに書かれた画面・ボタンの名前と手順だけを使う。足りなければ search_guides で探し直す)\n${guides.slice(0, 12000)}` };
  }
  const res = await runToolLoop({
    system: systemPrompt(db, user, now),
    messages,
    tools: tools(user),
    execute,
    maxRounds: 7,
    maxTokens: 3000,
    deadlineMs: Number(process.env.ASSISTANT_DEADLINE_MS) || 120_000,
  });
  // 先に探した使い方の資料は、データを調べて答えたときは根拠から外す (関係のない資料が並ばないように)
  if (out.usedData && prefetched.length) out.sources = out.sources.filter((x) => !prefetched.includes(x));
  let text = res.text
    .replace(/^\s*\[分析条件[:：].*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const unknown = text.startsWith("[不明]");
  text = text.replace(/^\[不明\]\s*/, "").trim() || "回答を用意できませんでした。聞き方を変えて、もう一度お試しください。";
  return { answer: text, ...out, unknown, provider: `${res.provider}:${res.model}`, ms: Date.now() - t0 };
}
