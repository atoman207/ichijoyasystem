import "server-only";
import type { Database, User } from "@/lib/db/types";
import { ROLE_LABEL } from "@/lib/constants";
import { toDateKey } from "@/lib/format";
import { canSeeAllCustomerRecords, canSeeAllStoreFigures, canSeeAllStores, canViewChatLog, canViewKnowledge } from "@/lib/auth/permissions";
import { runToolLoop, type ToolCall, type ToolDef } from "@/lib/ai/provider";
import { knowledgeExcerpt, searchKnowledge } from "@/lib/knowledge";
import { isStale, staleNote, todayKey } from "@/lib/knowledge-review";
import { listChatLogs, searchDocs } from "@/lib/chatbot/store";
import { analysisCatalog, analysisText, runAnalysis, type AnalysisResult, type AnalysisSpec } from "./analyze";
import { getRecord, lastSearchSource, listSchedule, searchAll, storeScopeNote, RECORD_TYPE_LABEL } from "./search";
import { scheduleSuggestTool, scheduleTools } from "./schedule-tool";
import { materialsForGuides, registryTools } from "./registry-tool";
import { ACTION_LABEL, proposalText, proposeAction, type ProposedAction } from "./actions";
import { assistantReadUser, outOfScopeRefusal } from "./scope";
import { checkCalcInputs, evaluate, formatCalc } from "./calc";
import { forecast, type ForecastSubject } from "./forecast";
import { parseStoreSplitQuestion, simulateStoreSplit } from "./store-split";
import { permissionHints } from "@/lib/chatbot/permission-hints";
import { describeTables, runSql, sqlTable, tableList } from "@/lib/datastore/sql";
import { METRICS, VIEWS, dataModelText } from "@/lib/datastore/model";
import { businessOverview } from "./overview";
import { managementAccounting } from "./mgmt-tool";
import { canViewMgmt } from "@/lib/mgmt/access";
import { mirrorReady } from "@/lib/datastore/mirror";
import { allDocs } from "@/lib/chatbot/store";
import { ACTION_REFUSAL, applyFixes, buildEvidence, checkAnswer, isWriteRequest, retryInstruction, type AnswerChecks } from "./guard";

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
 * 回答は guard.ts で道具の結果と突き合わせる (根拠のない数字・存在しないリンクや画面・実行したような書き方)。
 * 問題があれば 1 回だけ AI に確かめ直させ、残ったものは機械的に直す (結果は AgentReply.checks に残す)
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

/** 回答を作っている途中の知らせ (画面の「考えています」の表示に使う。/api/assistant/ask が順に送る) */
export type AgentProgress =
  | { type: "phase"; phase: "prepare" | "thinking" | "checking" | "done"; label: string }
  | { type: "tool"; id: string; name: string; label: string; status: "start" | "done"; summary?: string }
  /** 回答の文字 (書かれた順。画面にすぐ出す下書き。最後の回答は確かめのあとで送り直す) */
  | { type: "text"; delta: string }
  /** 書きかけの下書きを消す (道具を呼んだ・確かめ直す) */
  | { type: "reset" };

/** 道具の名前 → 画面に出す「いま何をしているか」 */
export const TOOL_PROGRESS_LABEL: Record<string, string> = {
  search_records: "記録を検索",
  get_record: "記録の詳細を確認",
  list_schedule: "予定を確認",
  analyze: "集計",
  query_database: "データベースで集計",
  describe_database: "データの構成を確認",
  business_overview: "会社の全体像を把握",
  search_guides: "使い方・社内資料を検索",
  search_history: "過去の相談を検索",
  management_accounting: "管理会計を集計",
  calculate: "計算",
  forecast: "過去の実績から予測を計算",
  store_split: "店舗ごとの売上の配分を計算",
  propose_action: "実行の確認を用意",
  search_materials: "クライアント資料を検索",
  read_material: "資料を読む",
  data_registry: "データ台帳を確認",
};

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
  /** 回答の確かめの結果 (guard.ts) */
  checks?: AnswerChecks;
  /** 実行の確認のカード (押すと実行。actions.ts) */
  actions?: ProposedAction[];
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
/** 声で聞かれた質問 (読み上げる): 最初の 1〜2 文で結論を話し言葉で。表・一覧は画面に任せる */
const VOICE_NOTE = "## 声での質問\nこの質問は声で聞かれ、回答の最初の部分が読み上げられる。回答の最初の 1〜2 文 (全部で 80 文字くらいまで) で、結論を話し言葉で言い切る (例: 「来週の合志店の予定は 12 件です。いちばん多いのは水曜日の 4 件です。」)。そのあとに詳しい内容・一覧・リンクを続けてよい (画面に表示される)。記号・表・英語の略語で始めない。";
const SCHEDULE_TOOL_LABEL: Record<string, string> = { suggest_schedule: "予定の候補日", plan_schedule: "予定のまとめての配置", day_route: "1 日の巡回順", schedule_holds: "仮押さえ", schedule_setup: "提案の準備の状況" };
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
          kind: { type: "string", description: "予定の種類 (例: 引き取り・納品・施工・見積り (現地調査)・現場見積 (現見)・顧客訪問・現場管理・会議)" },
          keyword: { type: "string", description: "件名・メモ・場所に含む言葉" },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "analyze",
      description: `売上・粗利・数量・単価・件数などを、期間・店舗・種別・商品・顧客・担当者・地区などを自由に組み合わせて集計する。数字は必ずこの道具で出す (自分で計算しない)。結果の表とグラフは画面に自動で表示される。\n指標と軸:\n${analysisCatalog()}\n- 比較: compare=previous_year (前年同期) / previous_period (直前の同じ長さ)。only=decreased/increased で減った・増えた行だけ。\n- 2 つの軸 (例: month と store) は表を縦横にする (pivot)。\n- 商品の絞り込み products は品名の一部 (例: "きずな", "18メッシュ")。表記ゆれがあるので、まず group_by=["product"] で品名の一覧を見てから絞るとよい。\n- 商品・数量・平均単価は明細のある受注だけ。商品ごとの原価・粗利 (cost・gross・gross_margin) は、案件の原価を明細の金額で按分した目安 (回答ではそう断る)。`,
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["sales", "inquiries", "quotes", "expenses", "purchases", "payments", "schedule"] },
          metrics: { type: "array", items: { type: "string" }, description: "指標 (最大 4。先頭が並べ替え・グラフの基準)" },
          group_by: { type: "array", items: { type: "string" }, description: "集計の軸 (最大 3。省略 = 合計だけ)" },
          from: { type: "string", description: "期間の始まり YYYY-MM-DD (質問に期間がない件数・一覧・順位は 2000-01-01)" },
          to: { type: "string", description: "期間の終わり YYYY-MM-DD (質問に期間がない件数・一覧・順位は 2099-12-31。今日にすると、今日より後の日付の記録が落ちる)" },
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
    ...(canViewMgmt(user)
      ? [
          {
            name: "store_split",
            description:
              "店舗間で仕事を依頼したとき (内部受注)、それぞれの店舗にいくらの売上が計上されるかを、管理会計と同じ設定 (配分率・税込/税抜の基準・端数) で計算する。仮の金額でよい。「合志店から中央店に 20 万円の通常工事を依頼したら、それぞれいくら？」「中央店が施工した合志店の仕事の売上の配分は？」はこれを使い、自分で計算しない。",
            parameters: {
              type: "object",
              properties: {
                from_store: { type: "string", description: "依頼した店舗 (受注店舗・営業エリアの店舗。名前か id)" },
                to_store: { type: "string", description: "施工した店舗 (名前か id)" },
                amount: { type: "number", description: "金額 (円)" },
                work_kind: { type: "string", enum: ["normal", "reform"], description: "通常工事 (既定) / リフォーム工事" },
                tax_included: { type: "boolean", description: "金額が税込か (省略 = 税込。「税抜」と言われたら false)" },
              },
              required: ["from_store", "to_store", "amount"],
            },
          } satisfies ToolDef,
          {
            name: "management_accounting",
            description:
              "管理会計 (店舗別独立採算) の集計を読む (読み取り専用・管理会計の画面と同じ計算)。view: store_pnl = 店舗別損益 (外部売上・内部受注などの調整・管理売上・材料費・外注費・粗利益・材料原価率・人件費・経費・共通経費の案分額・損益と前年同期比) / items = 品目別 (畳・襖・リフォーム・カーテン類・自社商品・その他・諸経費 の売上・材料費・粗利益・材料原価率、店舗 × 品目) / internal_orders = 内部受注・本部の特殊配分の金額 / allocation = 共通経費の案分の結果 (month) / pending = 未確認の仕入明細・要確認の原価・未確定の案分 / trend = 12 か月の推移 / settings = 配分率などの設定と未確定の項目。「店舗別の粗利益」「合志店の畳の材料原価率」「内部受注の金額」「前年より粗利益が減った店舗」「未確認の仕入請求書」「共通経費の案分結果」はこれを使う。",
            parameters: {
              type: "object",
              properties: {
                view: { type: "string", enum: ["store_pnl", "items", "internal_orders", "allocation", "pending", "trend", "settings"] },
                from: { type: "string", description: "期間の始まり YYYY-MM-DD (省略 = 今年の 1 月 1 日)" },
                to: { type: "string", description: "期間の終わり YYYY-MM-DD (省略 = 今日)" },
                store: { type: "string", description: "1 店舗だけ (id または名前)" },
                month: { type: "string", description: "allocation の月 YYYY-MM" },
              },
              required: ["view"],
            },
          } satisfies ToolDef,
        ]
      : []),
    {
      name: "business_overview",
      description:
        "会社 (または 1 店舗) の全体像を 1 回で得る: 売上・受注・問い合わせ→見積→受注・施工完了・請求・入金・未入金・経費・仕入・簡易粗利、月別・店舗別・種別・受付経路・担当者別、お客様アンケート・クレーム・口コミ、いま対応が要るもの (承認待ち・未対応の問い合わせ・期日超過・今後 7 日の予定)。数字は経営ダッシュボード・KPI の画面と同じ。「今の状況は？」「今年はどう？」「課題は？」「店舗を比べて」のような広い質問・総合的な分析の最初に使う。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "期間の始まり YYYY-MM-DD (省略 = 今年の 1 月 1 日)" },
          to: { type: "string", description: "期間の終わり YYYY-MM-DD (省略 = 今日)" },
          store: { type: "string", description: "1 店舗だけ見るとき (id または名前)" },
        },
        required: [],
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
  list.push(
    {
      name: "calculate",
      description:
        "電卓。道具の結果の数字どうしの差・合計・比・割合・増減率・平均を正確に計算する (自分で暗算しない)。式の数字は、それまでの道具の結果にある数字だけを使う (推測した数字は断られる)。使える書き方: + - * / ( )・round(x, 桁)・floor・ceil・abs・min・max・sum(…)・avg(…)・pct(a, b) = a÷b×100 (割合 %)・growth(新, 旧) = (新−旧)÷旧×100 (増減率 %)。例: pct(5280550, 15326190) / growth(1790250, 1271050) / 15326190 - 12000000",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "計算する式" },
          label: { type: "string", description: "何の計算か (例: 合志店の売上の割合)" },
        },
        required: ["expression", "label"],
      },
    },
    {
      name: "forecast",
      description:
        "過去の実績から、これからの月 (今月を含む) の売上・件数・金額を決まった方法で予測する: 前年同月の実績 × 直近 12 か月の伸び、直近 3 か月の平均、今月の今日までのペース、受注残 (施工予定の受注。売上だけ)。予測 (中心) と幅・前年同月・受注残の表を返し、画面に表とグラフが出る。表の行は今月から始まり「(今月)」「(来月)」「(再来月)」と書いてあるので、質問の月の行を選んで答える (「来月」は (来月) の行。今月の行と取り違えない)。「来月の売上の見込み」「今年の着地」「年末までにどれくらい」「来月の問い合わせは何件くらい」はこれを使い、自分で数字を作らない。",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["sales", "inquiries", "quotes", "expenses", "purchases", "payments"], description: "何を予測するか (既定 sales)" },
          metric: { type: "string", description: "指標 (analyze の指標の名前。省略 = 売上は sales、ほかは件数か金額)" },
          months: { type: "integer", description: "今月から何か月分 (1〜12、既定 3。今年の着地は 12 月までの月数)" },
          stores: { type: "array", items: { type: "string" }, description: "店舗で絞る (id または名前)" },
          categories: { type: "array", items: { type: "string" }, description: "種別で絞る" },
        },
        required: [],
      },
    },
  );
  for (const t of scheduleTools) list.push(t.def);
  // データ台帳 (クライアント資料の資料庫・全データの一覧・社内の活動): registry-tool.ts
  for (const t of registryTools) list.push(t.def);
  list.push({
    name: "propose_action",
    description: `データを変える依頼 (予定の登録・変更・削除、問い合わせの登録・状態の変更、受注の進捗の記録、社内連絡・業務依頼を送る、承認・差戻し・却下) のときに、実行の確認のカードを画面に出す。AI は実行しない: 利用者がカードの内容を確かめて「実行する」を押すと、画面のボタンと同じ処理 (権限・入力の確かめ・変更履歴・通知も同じ) で実行される。社員・お客様は名前、案件は番号 (受注・見積・問い合わせ)、予定は ID (list_schedule の結果) で指定してよい。分からない項目は聞き返すか、調べてから呼ぶ。できる操作: ${Object.entries(ACTION_LABEL).map(([k, v]) => `${k} (${v})`).join(", ")}`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.keys(ACTION_LABEL), description: "操作の種類" },
        event_id: { type: "string", description: "予定の変更・削除: 予定の ID" },
        event_kind: { type: "string", description: "予定の登録: 種類 (survey 見積り (現地調査)・onsite_quote 現場見積 (現見)・pickup 引取・delivery 納品・install 施工・visit 顧客訪問・site 現場管理・meeting 打合せ・leave 休暇・other その他 など。日本語の名前でもよい)" },
        title: { type: "string", description: "予定・社内連絡の件名 (予定は案件を指定すれば省略可)" },
        date: { type: "string", description: "予定の日付 YYYY-MM-DD" },
        end_date: { type: "string", description: "複数日の予定の終了日 YYYY-MM-DD" },
        start_time: { type: "string", description: "開始時刻 HH:MM" },
        end_time: { type: "string", description: "終了時刻 HH:MM" },
        slot: { type: "string", enum: ["am", "pm"], description: "時刻を決めないときの午前・午後" },
        all_day: { type: "boolean", description: "終日" },
        assignees: { type: "array", items: { type: "string" }, description: "予定の担当者 (社員の名前)。省略すると頼んだ本人" },
        store: { type: "string", description: "店舗 (省略すると案件・お客様・本人の店舗)" },
        case: { type: "string", description: "予定に紐づける案件の番号 (受注・見積・問い合わせ)" },
        customer: { type: "string", description: "お客様 (顧客コードか名前)" },
        location: { type: "string", description: "予定の場所 (省略すると案件・お客様の住所)" },
        memo: { type: "string", description: "予定のメモ" },
        summary: { type: "string", description: "問い合わせの内容 (要約)" },
        detail: { type: "string", description: "問い合わせの詳細" },
        contact_name: { type: "string", description: "新しいお客様の名前 (問い合わせ)" },
        contact_phone: { type: "string", description: "新しいお客様の電話 (問い合わせ)" },
        channel: { type: "string", description: "問い合わせの受付経路 (電話・来店・Web・LINE など)" },
        category: { type: "string", description: "問い合わせの種別 (畳・襖・障子・網戸・カーテン・クロス など)" },
        media: { type: "string", description: "問い合わせの登録では必須: お客様が当社を知ったきっかけ (情報媒体。チラシ・紹介・リピート・ホームページ・看板・DM・イベント など。聞けなかったときは「不明」。分からなければ利用者に聞き返す)" },
        assignee: { type: "string", description: "問い合わせの担当者 (社員の名前)" },
        next_action: { type: "string", description: "問い合わせの次の対応" },
        next_action_due: { type: "string", description: "次の対応の期限 YYYY-MM-DD" },
        inquiry: { type: "string", description: "状態を変える問い合わせの番号" },
        status: { type: "string", description: "問い合わせの新しい状態 (未対応・対応中・見積済・受注・失注 など)" },
        order: { type: "string", description: "進捗を記録する受注の番号" },
        progress_kind: { type: "string", description: "進捗の種類 (メモ・現場調査・製作・手配・施工・完了・変更)" },
        body: { type: "string", description: "受注の進捗の内容 / 社内連絡の本文" },
        message_kind: { type: "string", enum: ["notice", "request", "report", "question"], description: "社内連絡の種類 (notice 連絡・request 業務依頼・report 報告・question 確認・質問)" },
        to: { type: "array", items: { type: "string" }, description: "社内連絡の宛先・業務依頼の依頼先 (社員の名前)" },
        due_date: { type: "string", description: "業務依頼の期限 YYYY-MM-DD" },
        related: { type: "string", description: "社内連絡に紐づける案件の番号" },
        approval: { type: "string", description: "判断する承認の依頼 (ID か件名)" },
        decision: { type: "string", enum: ["approved", "returned", "rejected"], description: "承認・差戻し・却下" },
        comment: { type: "string", description: "承認の判断のコメント (差戻し・却下は必須)" },
      },
      required: ["action"],
    },
  });
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
    "あなたは株式会社一畳屋 (熊本の畳・襖・障子・網戸・カーテン・クロスの専門店。合志店・中央店・西店・玉名店と本部・ショールーム) の社内 AI アシスタントです。",
    "社員 (社長を含む) からの業務の質問に、システムに登録されている情報を根拠に答えます。",
    "",
    `## 今日\n${today} (${wd})`,
    `## 質問している人\n${user.name} (${ROLE_LABEL[user.role]}・${db.stores.find((s) => s.id === user.storeId)?.name ?? user.storeId})。閲覧範囲: ${storeScopeNote(db, user)}`,
    ...(canSeeAllStoreFigures(user) ? [] : [`## 閲覧の権限 (必ず守る)\nこの人が見られる売上・粗利・入金・経費・仕入・受注などの数字は ${db.stores.find((s) => s.id === user.storeId)?.name ?? "自店舗"} の分だけ。ほかの店舗・本部・全社の数字を聞かれたら、調べずに「その情報は閲覧の権限の範囲外のため、お答えできません」と答える。道具の結果は自店舗の分だけなので、それを全社・ほかの店舗の数字として書かない (予定表は全社共有なので答えてよい)。`]),
    `## 店舗\n${db.stores.map((s) => `${s.id}=${s.name}`).join(" / ")}`,
    `## 社員 (いま有効なアカウント)\n${staff.join("、")}\n(移行した過去の売上の担当者には、退職した社員の名前もあります)`,
    "",
    "## 答え方のルール",
    "0. 最初の 1 文で、質問にそのまま答える (金額・件数・名前・日付・はい/いいえ・店舗ごとの金額)。そのあとの補足は短い箇条書きで 2〜4 行まで、全体で 6 行以内を目安にする (総合的な分析の質問だけは長くてよい)。画面の場所・操作の手順は、操作を聞かれたとき・データや計算で答えられないときだけ、最後に 1 行で書く。答えの代わりに画面を案内しない。",
    "0b. 社員が読んですぐ分かる言葉で書く。道具・表・ビュー・列・コード・SQL の名前 (store_split・v_invoices・pending など) や、システムの内部の言い方は書かない。",
    "1. 数字・日付・名前・件数などの事実は、必ず道具で調べた結果だけを使う。推測で補わない。金額は道具の結果の書き方 (201,509,716円) のまま書き、億・万の書き方に直さない (直すときに桁を間違えるため)。計算 (合計・比較・割合・平均) は analyze で行い、自分で計算しない。道具の結果の数字どうしの差・比・割合・増減率・平均は calculate で計算する (暗算しない)。",
    "1b. これからの見込み・予測 (来月の売上・今年の着地・来月の問い合わせの件数など) は forecast で計算する。予測は「予測 (中心)」と幅をそのまま書き、予測であること・計算の方法 (前年同月 × 伸び・直近の平均・今月のペース・受注残) と前提を一言添える。forecast で出せない予測は「システムの記録からは計算できません」と書き、数字を作らない。",
    "2. 調べても見つからないとき・データがないときは、そのことをはっきり書く (例:「システムには○○の記録がありません」)。判断できないときもそう書く。",
    "2b. 質問の条件 (来年発売・新しい・特定の時期・特定の人や店舗など) に合う記録がないときは、近い記録を条件に合うものとして答えない。「条件に合う記録はありません」と先に書き、参考に近い記録を出すときは、条件に合わないこと (例: 現在の商品マスタの商品で、来年発売の情報ではない) をはっきり書く。",
    "3. 根拠になった記録は、道具の結果にある [番号や名前](/画面のパス) のリンクをそのまま本文に付ける。道具の結果にないリンク・URL は自分で作らない (集計の表とグラフは画面に自動で出るので、表へのリンクや「詳細を見る」は書かない)。資料から答えたときは「(社内資料: タイトル)」のように示す。",
    "4. analyze の結果の表とグラフは画面に自動で表示される。本文では表を書き写さず、要点 (合計・上位・増減・目立つ点) を 3〜6 行でまとめる。前提は、その集計の「注記」に書かれているものだけを一言添える (注記にない前提を書かない)。どの期間で集計したかを必ず書く。",
    "5. 「今年」= 1 月 1 日〜今日、「昨年」= 前年の 1/1〜12/31、「今月」「先月」は暦の月、「過去 3 年間」= 今年を含む 3 暦年 (年ごとに比較) のように解釈し、解釈した期間を書く。期間の指定がないときは、件数・人数・一覧・順位 (一番多い〜など) は登録されている全期間で数え、売上の推移・比較の分析だけは直近 12 か月にする。どちらの場合も、数えた期間を書く。",
    "5a. 期間の指定がない件数・一覧は、日付の条件を付けずに全件で数える (analyze の to を今日にすると、今日より後の日付の記録が落ちる。query_database で日付の条件なしに数えるのが確実)。",
    "5c. 「お客様ごと・店舗ごと・担当者ごとで一番多い〜」は、まずその単位で合計 (group by) してから比べる。1 件の請求・受注の最大と取り違えない。前の質問の続き (「その中で〜」) でも同じ。",
    "5b. 「比較して」は、質問にある軸 (店舗・商品・担当者など) どうしの比較のこと。前年・前の期間との比較 (compare) は、質問に「前年」「昨年」「前期」「去年と」などの言葉があるときだけ使う。",
    "6. 直接集計できないとき (データがない・軸がない・権限がない) は、その理由を書き、search_guides で調べて、経営ダッシュボード・CSV 出力などの画面で目的の集計にたどり着く手順を案内する。",
    "7. 操作方法の質問は、質問に付いた「参考資料」か search_guides の結果に書かれている画面・ボタン・手順だけで答える (一般的なシステムの知識で補わない)。「メニュー → 画面 → ボタン」の順に番号付きの手順で、画面・ボタンの名前は資料の表記のまま「」で書く。最初に出てくる画面の名前には、資料にある画面のリンクを付ける (例: [見積](/quotes))。資料に書かれていない操作は「使い方の資料には見当たりません」と書き、店長・管理者への確認を勧める。権限がない操作は、誰に頼めばよいかを書く。",
    `8. この AI は自分では何も変えない。データを変える依頼のうち、${Object.values(ACTION_LABEL).join("・")} は propose_action で実行の確認のカードを出す (利用者が「実行する」を押すと実行される。回答に「実行しました」「登録しました」と書かない)。それ以外の操作 (見積・請求・入金・経費・顧客の変更など) は行えないので、画面での操作手順を案内する。`,
    "9. 会話の続き (「店舗別にして」「前年と比べて」「その中で一番は？」) は、前の回答の [分析条件] を引き継いで analyze を呼び直す。[分析条件] は内部の情報なので、回答には書かない。",
    "10. 日本語のです・ます調で、簡潔に。見出しは使わず、必要なら短い箇条書き (・) と **太字** を使う。Markdown の表は書かない (表は画面に出る)。",
    "11. 過去に同じような相談がありそうなら search_history で確かめてもよい。ただし古い回答の数字はそのまま使わず、必要なら調べ直す。",
    "",
    ...(canViewMgmt(user)
      ? [
          "## 管理会計 (店舗別独立採算) の質問",
          "- 店舗別の損益・粗利益・材料費・外注費・材料原価率・内部受注・共通経費の案分・未確認の仕入明細・前年より粗利益が減った店舗 は management_accounting で調べる (経営ダッシュボードの「簡易粗利」とは定義が違う。管理会計は 粗利益 = 管理売上 − 材料費 − 外注費、金額は税抜)。",
          "- 粗利益・損益は management_accounting の数字を使う。business_overview の「簡易粗利」(税込・売上 − 畳原価 − 仕入 − 経費) や analyze の「粗利」(売上 − 記録された原価) とは定義が違うので混ぜない。売上の数字を粗利益として書かない。",
          "- 回答には 対象期間・金額の税 (税抜/税込)・集計の条件・確定か暫定か を書く。暫定の理由 (未確定の設定・要確認の明細・未確定の案分) も一言添える。金額は道具の結果をそのまま使い、計算し直さない。",
          "- 管理会計のデータを変える操作はしない (登録・確定は /management の画面で人が行う)。",
          "",
        ]
      : []),
    "## 総合的に分析する質問 (「状況は？」「なぜ減った？」「課題と改善策は？」「店舗を比べて」「振り返って」など)",
    "1. まず business_overview で全体像をつかむ (期間・店舗は質問に合わせる)。",
    "2. 目立つ点 (増減・偏り・ばらつき) を 2〜4 つ選び、analyze・query_database で軸を変えて掘り下げる (店舗・月・種別・商品・担当者・受付経路・顧客・前年同期との比較など)。売上だけでなく、問い合わせ→見積→受注の流れ・未入金・経費と仕入・アンケートとクレーム・予定の混み具合も、関係があれば見る。",
    "3. 大事な数字は、別の道具・別の集計でもう一度確かめる (例: analyze の合計と query_database の合計が合うか)。合わないときは、定義の違い (売上計上日と契約日・税込など) を確かめて正しい方を使う。",
    "4. 答えは「結論 → 根拠の数字 → 考えられる理由 (推測は「推測ですが」と明記) → 次の打ち手 → データの限界 (原価の範囲・明細のある受注だけ など)」の順に、見出しを使わず短くまとめる。",
    "5. データにないこと (競合・天候・社員の事情など) は断定しない。必要なら「システムには記録がありません」と書く。",
    "",
    "## 道具の使い方のこつ",
    "- 顧客の質問 (「○○様の施工履歴」「前回の担当者」) は search_records (types: customer) → get_record (type: customer)。",
    "- 「似たような工事」は search_records で工事内容・品名の言葉を探す (types: order, quote)。",
    "- 会議・決定事項・ルールは search_records (types: knowledge, schedule, thread) と search_guides の両方を見る。",
    "- クライアントの資料 (社内総合マニュアル・顧客対応マニュアル・議事録・研修・作業手順・点検とテレアポ・イベント・チラシの計画と配布・SNS・情報媒体・事務の手続き・書類の保管期限・車両・縁・補助金・取引先の請求書と契約・行政の様式) は search_materials で探し、必要なら read_material で全文を読む。社内資料 (search_guides) に無いときも資料庫を探す。答えには資料名とリンクを添える。",
    "- 社内の活動 (誰が・いつ・何を登録・変更・削除・承認・取込したか、最近の変更、操作の多い人・日) は data_registry (view: activity)。どんなデータがあるか・いつからのデータか・データの置き場所は data_registry (view: catalog)、クライアント資料の内訳は data_registry (view: materials)。",
    "- 仕入先・発注履歴は search_records (types: supplier) → get_record (type: supplier)。",
    "- 売上の分析は analyze (subject: sales)。商品名は表記ゆれがあるので、まず品名の一覧を見てから絞る。",
    scheduleSuggestTool ? "- 予定の候補日は suggest_schedule (候補ごとの「入力」のリンクをそのまま回答に入れる。利用者が候補を選んだ・「1 番で入れて」と頼まれたら、その候補の日時・担当者で propose_action (create_schedule_event) の登録のカードを出す)。日程のない案件をまとめて配置・既存の予定の入れ替えは plan_schedule、1 日の回る順番は day_route、仮押さえの状況は schedule_holds、提案に足りない情報は schedule_setup。予定の登録・変更はせず、リンクの画面で利用者が行うと案内する。" : "",
    canUseSql(user)
      ? [
          "",
          "## 統合データモデル (VPS のデータベース。query_database で SQL を書いて読む)",
          `統合ビュー: ${VIEWS.map((v) => `${v.name} = ${v.label}`).join(" / ")}`,
          `指標の定義: ${METRICS.map((m) => m.name).join("・")} (詳しくは describe_database)`,
          canSeeAllStores(user)
            ? ""
            : canSeeAllStoreFigures(user) && canSeeAllCustomerRecords(user)
              ? "顧客・案件・売上・KPI などは全店舗のデータが入っている (閲覧の範囲の設定)。経費・仕入・有給・社内連絡などは、この人の権限の範囲だけ。"
              : canSeeAllStoreFigures(user)
                ? "売上などの数字の表 (sales_orders・sales_items など) は全店舗、顧客・案件の表はこの人の閲覧範囲 (自店舗など) だけ。ほかの店舗の行の お客様の名前・ID は空。"
                : "この人の閲覧範囲 (自店舗) のデータだけが入っている。",
          "## 正確に答える手順",
          "- 件数・一覧・合計・「前回の〜」「〜のお客様は何人」のようなデータの質問は、推測せず query_database (統合ビュー) か analyze で数えてから答える。顧客・案件の詳しい中身は get_record。",
          "- 質問の条件 (状態・期間・店舗・人・種類など) は 1 つも落とさない。analyze の引数で表せない条件があるときは query_database で SQL に書く。",
          "- SQL を書く前に、使うビューの列と指標の定義を確かめる。この指示の最後に「データモデルの要点」があればそれを使う (describe_database を呼ばない)。ないとき・要点にない表・列・コードを使うときだけ describe_database (1 回の会話で 1 度でよい)。",
          "- 結果が 0 件・思ったより少ないときは、名前の表記 (like '%…%')・期間・状態の条件を見直して、もう 1 回だけ調べ直す。それでも無ければ「記録がありません」と答える。",
          "- 数字は結果の表の値をそのまま書く (丸めるときは「約」を付ける)。どの定義・期間で数えたかを一言添える。",
          "- SQL の誤りが返ってきたら、誤りの内容を読んで直して呼び直す。",
          "- 状態・種類・受付経路などのコードは推測しない。分からなければ describe_database のコードの一覧で確かめる (例: 承認の承認待ちは pending、経費の承認待ちは pending_approval)。",
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
/** 質問に期間の言葉があるか (ない件数・一覧・順位は全期間で数える: 答え方のルール 5・5a) */
const PERIOD_WORDS = /今日|本日|昨日|明日|今週|先週|来週|今月|先月|来月|今年|昨年|去年|来年|今期|前期|年度|上期|下期|直近|最近|過去|以降|以前|期間|\d+\s*(年|月|日)|\d{4}[-/]|年間|か月|ヶ月|カ月|週間|四半期/;

function makeExecutor(db: Database, user: User, now: Date, out: { tables: AnalysisResult[]; sources: AgentSource[]; tools: AgentReply["tools"]; usedData: boolean; usedKnowledge: boolean; docKeys: string[]; actions?: ProposedAction[] }, opts: { periodless?: boolean; evidence?: () => number[]; actor?: User } = {}) {
  // actor = ログインした本人 (実行の確認・相談の履歴は本人の権限。user は読み取りの範囲: scope.ts)
  const actor = opts.actor ?? user;
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
        // 期間の言葉がない質問で、AI が終わりを今日にしたときは、今日より後の日付の記録も数える (全期間。ルール 5a を確実に守る)
        if (opts.periodless && spec.to && spec.to >= toDateKey(now) && spec.to < "2099-12-31") spec.to = "2099-12-31";
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
        // 確認期限を過ぎた資料は根拠の名前に印を付け、本文の前に「古い可能性」の注記を入れる (knowledge-review.ts)
        const today = todayKey();
        for (const h of know.slice(0, 3)) addSource({ label: `${h.entry.title}${isStale(h.entry, today) ? " (確認期限切れ)" : ""}`, href: `/knowledge/${h.entry.id}`, kind: "社内資料" });
        if (know.length) out.usedKnowledge = true;
        // クライアント資料 (資料庫) の候補も添える
        const mats = materialsForGuides(user, q);
        if (mats) {
          out.usedKnowledge = true;
          for (const src of mats.sources.slice(0, 2)) addSource(src);
        }
        const perms = permissionHints(q, user.role);
        if (!docs.length && !know.length && !mats) return `使い方の資料・社内資料・クライアント資料に当てはまるものはありませんでした。言葉を変えて search_materials でも探してください。資料に書かれていないことを一般的な知識で補って答えない。${perms.length ? `\n## このロール (${ROLE_LABEL[user.role]}) の権限 (関係しそうなもの)\n${perms.join("\n")}` : ""}`;
        return [
          ...(perms.length ? [`## このロール (${ROLE_LABEL[user.role]}) の権限 (関係しそうなもの。操作を案内する前に確かめる)\n${perms.join("\n")}`] : []),
          ...docs.map((d) => `### ${d.title}${d.href ? ` (画面: ${d.href})` : ""}\n${d.body.slice(0, 1500)}`),
          ...know.map((h) => `### 社内資料: ${h.entry.title} (分類 ${h.entry.category || "その他"}${h.entry.recordDate ? ` / 日付 ${h.entry.recordDate}` : ""}${h.entry.reviewedAt ? ` / 最終確認 ${h.entry.reviewedAt.slice(0, 10)}` : ""}) [開く](/knowledge/${h.entry.id})\n${staleNote(h.entry, today) ? `${staleNote(h.entry, today)}\n` : ""}${knowledgeExcerpt(h.entry.body, q, 2500)}`),
          ...(mats ? [mats.text] : []),
        ].join("\n\n");
      }
      case "search_history": {
        const q = str(a.query, 200) ?? "";
        const scope = canSeeAllStores(actor) ? "all" : actor.role === "store_manager" ? "store" : "self";
        const r = listChatLogs({ scope, userId: actor.id, storeId: actor.storeId, q, limit: 6 });
        const rows = r.rows.filter((x) => canViewChatLog(actor, x));
        // 過去の相談は人ごとの情報なので、回答を蓄えない
        out.usedData = true;
        out.tools.push({ name: "過去の相談", summary: `${q} → ${rows.length} 件` });
        if (!rows.length) return "過去の相談に当てはまるものはありませんでした。";
        for (const x of rows.slice(0, 2)) addSource({ label: `過去の相談: ${x.question.slice(0, 30)}`, href: `/ai?tab=history&id=${x.id}`, kind: "過去の相談" });
        return rows.map((x) => `- ${x.at.slice(0, 10)} ${x.userName}: Q「${x.question}」\n  A: ${x.answer.replace(/\n/g, " ").slice(0, 400)} [履歴](/ai?tab=history&id=${x.id})`).join("\n");
      }
      case "store_split": {
        const r = simulateStoreSplit(db, user, { fromStore: str(a.from_store, 40) ?? "", toStore: str(a.to_store, 40) ?? "", amount: typeof a.amount === "number" ? a.amount : Number(String(a.amount ?? "").replace(/[,円]/g, "")), workKind: str(a.work_kind) === "reform" ? "reform" : "normal", taxIncluded: typeof a.tax_included === "boolean" ? a.tax_included : undefined }, now);
        if (!r.ok) {
          out.tools.push({ name: "店舗間の売上の配分", summary: r.error.slice(0, 80) });
          return `計算できません: ${r.error}`;
        }
        out.usedData = true;
        if (out.tables.length < 4) out.tables.push(r.table);
        out.tools.push({ name: "店舗間の売上の配分", summary: r.summary });
        addSource({ label: "管理会計の設定 (内部受注の配分率・基準・端数)", href: "/management?tab=settings", kind: "集計" });
        return r.text;
      }
      case "management_accounting": {
        out.usedData = true;
        const text = managementAccounting(db, user, { view: str(a.view, 20), from: str(a.from, 10), to: str(a.to, 10), store: str(a.store, 20), month: str(a.month, 7) }, toDateKey(now));
        out.tools.push({ name: "管理会計", summary: `${str(a.view) ?? "store_pnl"} ${str(a.store) ?? ""} ${str(a.from) ?? ""}〜${str(a.to) ?? ""}`.trim() });
        addSource({ label: "管理会計 (店舗別損益・品目別・案分)", href: `/management?tab=${str(a.view) === "items" ? "items" : str(a.view) === "allocation" ? "alloc" : str(a.view) === "pending" ? "purchases" : str(a.view) === "internal_orders" ? "sales" : "pnl"}`, kind: "集計" });
        return text;
      }
      case "calculate": {
        const expr = str(a.expression, 1000) ?? "";
        const label = str(a.label, 60) ?? "計算";
        // 式の数字は、それまでの道具の結果・質問にあるものだけ (推測した数字を電卓に通して根拠があるように見せない)
        const missing = checkCalcInputs(expr, opts.evidence?.() ?? []);
        if (missing.length) {
          out.tools.push({ name: "計算", summary: `断りました: ${missing.join("・")} は道具の結果にない数字` });
          return `計算できません: 式の数字 ${missing.join("・")} は、これまでの道具の結果にありません。先に analyze・query_database などで調べてから、その結果の数字で計算してください。`;
        }
        const r = evaluate(expr);
        if (!r.ok) {
          out.tools.push({ name: "計算", summary: `式の誤り: ${r.error}` });
          return `計算できません: ${r.error}
式: ${expr}`;
        }
        out.tools.push({ name: "計算", summary: `${label}: ${expr} = ${formatCalc(r.value)}` });
        return `【計算: ${label}】
${expr} = ${formatCalc(r.value)}
(四捨五入して書くときは「約」を付ける。割合・増減率は % を付ける)`;
      }
      case "forecast": {
        out.usedData = true;
        const r = forecast(db, user, { subject: str(a.subject, 20) as ForecastSubject | undefined, metric: str(a.metric, 40), months: typeof a.months === "number" ? a.months : undefined, stores: strs(a.stores), categories: strs(a.categories) }, now);
        if (!r.ok) {
          out.tools.push({ name: "予測", summary: `できませんでした: ${r.error}` });
          return `予測できませんでした: ${r.error}${r.hint ? `\nヒント: ${r.hint}` : ""}`;
        }
        if (out.tables.length < 4) out.tables.push(r);
        out.tools.push({ name: "予測", summary: r.title });
        addSource({ label: r.title, kind: "集計" });
        return analysisText(r, 24);
      }
      case "business_overview": {
        out.usedData = true;
        const text = businessOverview(db, user, { from: str(a.from, 10), to: str(a.to, 10), store: str(a.store, 20) }, now);
        out.tools.push({ name: "全体像", summary: `${str(a.store) ?? "全体"} ${str(a.from) ?? "今年"}〜${str(a.to) ?? "今日"}` });
        addSource({ label: "全体像 (経営ダッシュボード・KPI と同じ集計)", href: "/reports", kind: "集計" });
        return text;
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
    }
    // 実行の確認のカード (actions.ts。AI は実行しない。利用者が画面で「実行する」を押す)
    if (call.name === "propose_action") {
      out.usedData = true;
      const { action: kind, ...rest } = a as Record<string, unknown>;
      const r = proposeAction(db, actor, typeof kind === "string" ? kind : "", rest, now);
      if (r.ok) {
        out.actions ??= [];
        if (out.actions.length < 5) out.actions.push(r.action);
      }
      out.tools.push({ name: "実行の確認", summary: r.ok ? `${r.action.title} (確認のカード)` : `作れず: ${r.error.slice(0, 80)}` });
      return proposalText(r);
    }
    // データ台帳の道具 (registry-tool.ts: 資料庫の検索・資料を読む・全データの一覧・社内の活動)。人ごとの閲覧範囲で変わるので回答を蓄えない
    const rt = registryTools.find((t) => t.def.name === call.name);
    if (rt) {
      out.usedData = true;
      if (call.name !== "data_registry") out.usedKnowledge = true;
      const r = await rt.run(db, user, a, now);
      out.tools.push({ name: rt.label, summary: r.summary });
      for (const src of r.sources) addSource(src);
      return r.text;
    }
    // 予定の計画の道具 (schedule-tool.ts: 候補日・まとめて配置・巡回順・仮押さえ・準備の状況)
    const st = scheduleTools.find((t) => t.def.name === call.name);
    if (st) {
      out.usedData = true;
      const r = st.run(db, user, a, now);
      const label = SCHEDULE_TOOL_LABEL[call.name] ?? "予定の計画";
      out.tools.push({ name: label, summary: r.summary });
      if (r.href) addSource({ label, href: r.href, kind: "予定表" });
      return r.text;
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

/**
 * 総合的な分析の質問 (全体像を先に渡し、道具の回数と考える深さを増やす)。
 * 1 人のお客様についての質問 (「○○様の工事の状況」) は、会社の全体像が要らないので除く
 */
// 「どうすれば」は操作の質問 (「請求書を発行するにはどうすれば」) にも使うので、業績の言葉と組になったときだけ。
// 「予測」「見通し」は forecast の道具で直接計算できるので、全体像の先読みをしない (速く答える)
const ANALYTICAL = /なぜ|原因|分析|傾向|課題|改善|対策|比較|比べ|総合|振り返|レポート|強み|弱み|どうだった|(売上|業績|利益|粗利|成約|集客|問い合わせ|受注|客単価|リピート|評価|クレーム|口コミ|未入金|回収|経営)[^。？?]{0,20}(どうすれば|どうしたら)|(どうすれば|どうしたら)[^。？?]{0,12}(伸び|増え|上が|改善|減ら|良く|よく)|(会社|全社|店舗|経営|業績|全体|今年|今月|今期|先月|去年|昨年)[^。？?]{0,15}(状況|どう|まとめ|評価)/;
/**
 * 数字・名前を 1 つ聞く質問 (「昨年と比べて何%増減した？」「一番多い店舗はどこ？」) は、比べる言葉があっても総合的な分析にしない
 * (全体像を先に用意せず、道具 1〜2 回で短く答える。理由・課題・改善などを聞いたときだけ総合的な分析)
 */
const SPECIFIC_ASK = /何\s*[%％]|何パーセント|何割|いくら|何円|何件|何人|何台|何枚|何倍|何日|何か月|どこ(で|が|か|です)|どの店|誰|どなた|どれ|どちら|一番|最も|もっとも/;
const DEEP_ONLY = /なぜ|原因|理由|分析|傾向|課題|改善|対策|総合|振り返|レポート|強み|弱み|どうすれば|どうしたら|状況|まとめ/;
const isAnalytical = (q: string) => ANALYTICAL.test(q) && !/(?<!お客)様/.test(q) && !(SPECIFIC_ASK.test(q) && !DEEP_ONLY.test(q));

/** 管理会計で答える質問 (管理会計を見られる人だけ) */
const MGMT_QUESTION = /粗利|損益|利益|原価率|材料費|外注費|内部受注|案分|按分|共通経費|独立採算|管理会計|管理売上|仕入請求書|仕入明細/;

/** 使い方の資料の全文 (画面・ボタンの名前の確かめに使う。資料が変わったら作り直す) */
const docsCache: { n: number; text: string } = { n: -1, text: "" };
function guideDocsText(): string {
  try {
    const docs = allDocs().filter((d) => d.kind !== "knowledge");
    if (docs.length !== docsCache.n) {
      docsCache.n = docs.length;
      docsCache.text = docs.map((d) => `${d.title}\n${d.body}`).join("\n");
    }
  } catch {
    /* 資料のデータベースが使えないときは画面の一覧だけで確かめる */
  }
  return docsCache.text;
}

export async function runAgent(db: Database, user: User, history: AgentTurn[], question: string, opts: { now?: Date; prefetchGuides?: boolean; dataQuestion?: boolean; voice?: boolean; onProgress?: (e: AgentProgress) => void } = {}): Promise<AgentReply> {
  const progress = (e: AgentProgress) => {
    try {
      opts.onProgress?.(e);
    } catch {
      /* 画面への知らせの失敗で回答を止めない */
    }
  };
  const now = opts.now ?? new Date();
  // 店舗のロールが、ほかの店舗・本部・全社の数字を聞いた: AI を呼ばずに断る (scope.ts)
  const refusal = outOfScopeRefusal(db, user, question, now);
  if (refusal) return { answer: refusal, tables: [], sources: [], tools: [], usedData: true, usedKnowledge: false, docKeys: [], unknown: false, provider: "rule:scope", ms: 0, actions: [] };
  const deep = isAnalytical(question);
  const t0 = Date.now();
  const out = { tables: [] as AnalysisResult[], sources: [] as AgentSource[], tools: [] as AgentReply["tools"], usedData: false, usedKnowledge: false, docKeys: [] as string[], actions: [] as ProposedAction[] };
  // 道具の結果は回答の確かめ (guard.ts) の根拠にする
  const toolOutputs: string[] = [];
  const lastAsked = [...history].reverse().find((h) => h.role === "user")?.content ?? "";
  const historyText = history.map((h) => h.content).join("\n");
  // AI アシスタントの閲覧範囲 (設定で全店舗にしているときは、読み取りだけ全店舗。scope.ts)
  const readUser = assistantReadUser(db, user, now);
  const executeTool = makeExecutor(db, readUser, now, out, {
    actor: user,
    periodless: !PERIOD_WORDS.test(question) && !PERIOD_WORDS.test(lastAsked),
    evidence: () => buildEvidence([...toolOutputs, question, historyText], out.tables).values,
  });
  const execute = async (call: ToolCall) => {
    const label = TOOL_PROGRESS_LABEL[call.name] ?? SCHEDULE_TOOL_LABEL[call.name] ?? "調べています";
    progress({ type: "tool", id: call.id, name: call.name, label, status: "start" });
    const before = out.tools.length;
    const r = await executeTool(call);
    toolOutputs.push(r);
    progress({ type: "tool", id: call.id, name: call.name, label, status: "done", summary: out.tools.length > before ? out.tools[out.tools.length - 1].summary.slice(0, 120) : undefined });
    return r;
  };
  const messages = toMessages(history, question);
  // 登録・変更・削除・承認・送信の依頼: できる操作は確認のカード (propose_action) を出す。それ以外は手順の案内 (実行したように書かせない)
  const writeRequest = isWriteRequest(question);
  if (writeRequest) {
    messages[messages.length - 1] = { role: "user", content: `${question}\n\n---\n(システムの注意: これはデータを変える依頼です。${Object.values(ACTION_LABEL).join("・")} なら、必要な記録 (予定の ID・案件の番号・社員の名前など) を調べてから propose_action で実行の確認のカードを出し、「内容を確かめて『実行する』を押してください」と伝えてください。AI は実行しないので「実行しました」とは書かない。足りない情報 (日付・担当者など) があれば聞き返す。それ以外の操作は実行できないことを伝え、search_guides で調べた画面・ボタンの名前で手順を案内してください)` };
  }
  // 集計の回答の続き (「それを店舗別にして」「月別では？」): 前の回答の数字から推測させず、前の条件を引き継いで調べ直させる
  // (道具を呼ばずに店舗別の金額を作る回答があった。確かめ (guard.ts) で直すと往復が 1 回増えるので、先に伝える)
  const prevTurn = history.at(-1);
  if (!writeRequest && opts.dataQuestion && prevTurn?.role === "assistant" && prevTurn.specs?.length) {
    messages[messages.length - 1] = { role: "user", content: `${question}\n\n---\n(システムの注意: 前の集計の続きです。前の回答の [分析条件] を引き継ぎ、質問に合わせて変えて analyze (または query_database) を呼び直してから答えてください。前の回答にない数字を推測で書かない)` };
  }
  // 操作の質問は、使い方の資料を先に探して質問に添える (AI が資料を見ずに一般的な手順を答えないように)
  let prefetched: AgentSource[] = [];
  // 「A 店から B 店に X 円の工事を依頼したら、それぞれいくら？」は、先に計算しておく (AI の往復を 1 回減らし、計算させない)
  const split = parseStoreSplitQuestion(db, question);
  if (split || opts.prefetchGuides || deep || (canViewMgmt(readUser) && MGMT_QUESTION.test(question))) progress({ type: "phase", phase: "prepare", label: "関係する資料・データを用意しています" });
  if (opts.prefetchGuides && !split) {
    const before = out.sources.length;
    const guides = await execute({ id: "prefetch", name: "search_guides", args: { query: question } });
    prefetched = out.sources.slice(before);
    out.tools.pop();
    messages[messages.length - 1] = { role: "user", content: `${question}\n\n---\n参考資料 (システムが自動で探した使い方・社内資料。操作の案内はここに書かれた画面・ボタンの名前と手順だけを使う。足りなければ search_guides で探し直す)\n${guides.slice(0, 12000)}` };
  }
  // 総合的な分析は、全体像を先に用意する (1 回分の往復を省き、必ず全体から考える)
  // 管理会計の質問 (店舗別の粗利益・損益・原価率・内部受注・案分): 管理会計の店舗別損益を先に渡す (経営ダッシュボードの簡易粗利と混ぜない)
  const mgmtQ = canViewMgmt(readUser) && MGMT_QUESTION.test(question);
  if (split) {
    const r = await execute({ id: "split", name: "store_split", args: { from_store: split.fromStore, to_store: split.toStore, amount: split.amount, work_kind: split.workKind, tax_included: split.taxIncluded } });
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { role: "user", content: `${last.content}

---
店舗ごとの売上の配分の計算 (store_split の結果。管理会計と同じ設定で計算済み。この数字で、最初の 1 文で各店舗の金額を答える。質問の店舗・金額・税込/税抜・工事の種類と違うときだけ store_split を呼び直す。計算できないと書かれていたら、その理由をそのまま短く伝える)
${r}` };
  } else if (mgmtQ) {
    const pnl = await execute({ id: "mgmt", name: "management_accounting", args: { view: /品目|畳|襖|リフォーム|カーテン|自社商品|原価率/.test(question) ? "items" : "store_pnl" } });
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { role: "user", content: `${last.content}\n\n---\n管理会計の集計 (management_accounting の結果。今年の 1 月 1 日〜今日。期間・店舗・見方が違う質問なら management_accounting を呼び直す。粗利益・損益はこの数字を使い、business_overview の「簡易粗利」や売上を粗利益として書かない)\n${pnl}` };
  } else if (deep) {
    const overview = await execute({ id: "overview", name: "business_overview", args: {} });
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { role: "user", content: `${last.content}\n\n---\n会社の全体像 (business_overview の結果。今年の 1 月 1 日〜今日。期間が違う質問なら business_overview を呼び直す)\n${overview}` };
  }
  // データの質問は、データモデルの要点 (ビューの列・指標の定義) を先に添える: SQL の前の describe_database の往復 (1 回分の待ち時間と
  // 大きな結果のトークン) を省く。コードの一覧・ここにない表は、必要なときだけ AI が describe_database で見る
  // (操作の質問として使い方の資料を先に添えたときは添えない: 操作の質問にはデータモデルが要らず、トークンが増えるだけ)
  // 質問の文ではなく AI への指示 (system) の最後に置く: 同じ人の続けてのデータの質問で、指示ごと AI のキャッシュから読まれる (費用が 4 分の 1)
  const modelBrief =
    opts.dataQuestion && !opts.prefetchGuides && !split && !writeRequest && canUseSql(readUser) && mirrorReady()
      ? `\n\n## データモデルの要点 (システムが先に用意。query_database の SQL はこのビュー・列・定義で書く。describe_database は、ここにない表・列・コードを使うときだけ)\n${dataModelText(readUser, [], { brief: true })}`
      : "";
  const loop = (msgs: { role: "user" | "assistant"; content: string }[]) =>
    runToolLoop({
      system: `${systemPrompt(db, readUser, now)}${modelBrief}${opts.voice ? `\n\n${VOICE_NOTE}` : ""}`,
      messages: msgs,
      tools: tools(readUser),
      execute,
      maxRounds: deep ? 12 : 8,
      effort: deep ? "medium" : "low",
      maxTokens: 3000,
      deadlineMs: Number(process.env.ASSISTANT_DEADLINE_MS) || (deep ? 170_000 : 120_000),
      onText: opts.onProgress ? (e) => progress(e.type === "delta" ? { type: "text", delta: e.text } : { type: "reset" }) : undefined,
    });
  progress({ type: "phase", phase: "thinking", label: "質問を読み解いています" });
  let res = await loop(messages);
  // 総合的な分析で掘り下げが足りないとき (全体像だけで答えた) は、もう一度だけ確かめさせて書き直す
  const drill = () => res.calls.filter((c) => ["analyze", "query_database", "get_record", "search_records", "list_schedule", "management_accounting", "forecast", "calculate"].includes(c.name)).length + (mgmtQ ? 2 : 0);
  if (deep && drill() < 2 && Date.now() - t0 < 60_000) {
    const first = res;
    progress({ type: "reset" });
    res = await loop([
      ...messages,
      { role: "assistant", content: first.text },
      { role: "user", content: "この下書きの大事な点 (結論とその理由) を、analyze か query_database で 2 つ以上の観点 (店舗・月・種別・商品・担当者・受付経路・顧客・前年同期との比較など) から掘り下げて確かめ、数字を確かめた最終の回答に書き直してください。下書きにあった全体の要点 (業績・未入金・問い合わせ・お客様の評価・いま対応が要るもの のうち関係するもの) は数字ごと残し、比べる質問では比べた全部の店舗・項目の数字を並べてください。下書きと違う結果になったら、確かめた数字のほうを使ってください。書き直したことや確かめた手順には触れず、質問への最終の回答だけを書いてください。" },
    ]);
    res = { ...res, calls: [...first.calls, ...res.calls], rounds: first.rounds + res.rounds };
  }
  // 回答を道具の結果と突き合わせる (根拠のない数字・リンク・画面の名前・実行したような書き方)。問題があれば 1 回だけ確かめ直させる
  const verify = (answer: string) =>
    checkAnswer(answer, buildEvidence([...toolOutputs, question, historyText], out.tables, out.sources.map((x) => x.href)), {
      question,
      usedData: out.usedData,
      dataQuestion: opts.dataQuestion ?? false,
      writeRequest,
      docsText: guideDocsText(),
    });
  let issues = verify(res.text);
  const checks: AnswerChecks = { issues: [], retried: false, fixed: [] };
  if (issues.some((i) => i.severity !== "low") && Date.now() - t0 < 100_000) {
    const first = res;
    checks.retried = true;
    progress({ type: "reset" });
    progress({ type: "phase", phase: "checking", label: "数字と根拠を確かめ直しています" });
    try {
      const again = await loop([...messages, { role: "assistant", content: first.text }, { role: "user", content: retryInstruction(issues) }]);
      const after = verify(again.text);
      // 直したほうが問題が少なければ使う
      const weight = (xs: typeof issues) => xs.reduce((a, i) => a + (i.severity === "high" ? 3 : i.severity === "medium" ? 2 : 1), 0);
      if (again.text.trim() && weight(after) <= weight(issues)) {
        res = { ...again, calls: [...first.calls, ...again.calls], rounds: first.rounds + again.rounds };
        issues = after;
      }
    } catch (err) {
      console.warn("[assistant] re-check failed:", (err as Error).message);
    }
  }
  checks.issues = issues;
  const fixedAnswer = applyFixes(res.text, issues);
  checks.fixed = fixedAnswer.fixed;
  res = { ...res, text: fixedAnswer.text };
  // データを変える依頼には、最初の 1 文で「この AI ではできない」と答える (手順の案内だけで終わらせない)
  if (writeRequest && !out.actions.length && res.text !== ACTION_REFUSAL && !/(でき|行え|おこなえ)(ません|ない)/.test(res.text.split(/\n|。/)[0] ?? "")) {
    res = { ...res, text: `この依頼は、AI アシスタントからは実行できません。${/(でき|行え)(ません|ない)/.test(res.text) ? "" : "操作は担当の画面で行ってください。"}\n\n${res.text}` };
    checks.fixed.push("データを変える依頼に、実行できないことを最初に書きました");
  }
  // 先に探した使い方の資料は、データを調べて答えたときは根拠から外す (関係のない資料が並ばないように)
  if (out.usedData && prefetched.length) out.sources = out.sources.filter((x) => !prefetched.includes(x));
  let text = res.text
    .replace(/^\s*\[分析条件[:：].*$/gm, "")
    // 本文の途中に出た内部の印 (「…集計しています[分析条件]」)
    .replace(/\[分析条件[^\]\n]*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const unknown = text.startsWith("[不明]");
  text = text.replace(/^\[不明\]\s*/, "").trim() || "回答を用意できませんでした。聞き方を変えて、もう一度お試しください。";
  return { answer: text, ...out, unknown, provider: `${res.provider}:${res.model}`, ms: Date.now() - t0, checks };
}
