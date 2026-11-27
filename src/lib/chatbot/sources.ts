import "server-only";
import type { Database, Role } from "@/lib/db/types";
import { GUIDES } from "@/lib/help-guides";
import { PERMISSION_TABLE, type Cell } from "@/lib/auth/permission-table";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, EXPENSE_STATUS, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, PURCHASE_STATUS, QUOTE_STATUS, ROLE_DESCRIPTION, ROLE_LABEL, TASK_STATUS } from "@/lib/constants";
import { STAGE_LABEL, SPEC_LABEL, SCHEDULE_LABEL, BILLING_LABEL, PAYMENT_STATE_LABEL } from "@/lib/case-status";
import { approvalSettings, manYen } from "@/lib/approval-rules";
import { storePhoneLabel } from "@/lib/store-contact";
import type { NewDoc } from "./store";
import UI_CATALOG from "./ui-catalog.json";

interface UiEntry {
  route: string;
  title: string;
  cards: string[];
  fields: string[];
  buttons: string[];
  notes: string[];
}

/**
 * チャットボットの回答の根拠 (システムの説明)
 * ------------------------------------------------------------
 * 画面の説明・権限・ロール・状態の名前・承認ルール・店舗・社内資料 (ナレッジ) を、検索しやすい短い資料に分けて作る。
 * コードの定義 (使い方・権限一覧・状態の名前) から作るので、機能を変えて定義を直せば、チャットボットの説明も変わる。
 * 社員の名前・お客様の情報は入れない (データの質問は assistant.ts の rulesAnswer が各自の閲覧範囲で答える)
 */

export interface Screen {
  href: string;
  name: string;
  body: string;
}

/** 画面の一覧 (ヘッダーのタブ。名前は src/app/(app)/layout.tsx の nav と同じ) */
export const SCREENS: Screen[] = [
  { href: "/", name: "ダッシュボード (ホーム)", body: "ログイン直後の画面。今日の予定・承認待ち・担当中の問い合わせと受注・期日超過の請求・売上の推移などをまとめて表示します。" },
  { href: "/customers", name: "顧客", body: "お客様の一覧と詳細。問い合わせ・見積・受注・請求・連絡履歴・資料をお客様ごとにたどれます。重要情報 (氏名・電話・住所など) の変更は設定により承認が必要です。新規登録は初期設定では事務担当・本部・管理者が行います。" },
  { href: "/inquiries", name: "問い合わせ", body: "電話・来店・LINE・Web・AI 受付の問い合わせの一覧。「問合せ登録」で記録し、顧客の登録・ひも付け、見積の作成、担当者への引き継ぎを行います。" },
  { href: "/quotes", name: "見積", body: "見積の作成・承認の申請・PDF の出力。基準額以上は管理者、それ未満は店長が承認します。承認後は見積の画面の「お客様へ送信」でメール (PDF を添付) または LINE (PDF を開くリンク) で送れ、「受注登録 (契約承認を申請)」で受注に進みます。手書き見積は書類取込から作れます。" },
  { href: "/orders", name: "受注・施工", body: "受注の一覧と詳細。施工の予定・進捗 (写真)・施工完了の登録・請求書の発行を行います。売上は施工完了日で計上します。契約内容の変更は承認が必要です。" },
  { href: "/cases", name: "案件の進捗", body: "問い合わせから入金・事務処理の完了までを 1 行で一覧します。進捗・見積と仕様・工事日程・請求・入金・事務処理の状態で絞り込めます。" },
  { href: "/schedule", name: "予定表", body: "全店舗・全社員の予定 (訪問・引取・施工・納品・社内の予定) を月・週・日・一覧で表示します。担当者が重なると赤く表示します。画面左上の「予定表」ボタンからいつでも開けます。" },
  { href: "/invoices", name: "請求・入金", body: "請求書の発行・PDF・送付、入金の登録、未入金と期日超過の確認。請求書は受注の画面の「請求書を発行」で作り、請求書の画面の「請求書をお客様へ送信」でメール (PDF を添付) または LINE (PDF を開くリンク・14 日間有効) で送れます。郵送・手渡しで送ったときや督促は「送付の記録」に残します。現金の入金は現金出納帳に自動で記帳されます。" },
  { href: "/finance", name: "入出金の予定", body: "未入金 (お客様からの入金予定) と支払待ち (仕入先への支払) を日付順に確認します。" },
  { href: "/expenses", name: "経費精算", body: "経費の登録 (レシートの取込も可)、承認の申請、精算。基準額以上は管理者、それ未満は店長が承認します。現金の精算は現金出納帳に記帳されます。" },
  { href: "/cashbook", name: "現金出納帳", body: "店舗ごとの現金の入出金と残高。現金の入金・経費の精算・仕入の現金払いは自動で記帳され、その他の入出金は手で記録します。" },
  { href: "/purchases", name: "仕入・買掛", body: "仕入先の請求書の登録、支払依頼 (管理者の承認)、支払完了の登録。店長は自店舗の仕入請求書を見られます。" },
  { href: "/suppliers", name: "仕入先・協力業者", body: "仕入先・協力業者の台帳。連絡先・取引の履歴・LINE グループのひも付けを管理します。" },
  { href: "/accounting", name: "会計データの出力", body: "仕訳と明細を CSV (汎用・弥生会計の形式) で出力します。本部スタッフ・管理者が使います。" },
  { href: "/management", name: "管理会計 (店舗別独立採算)", body: "店舗別損益 (外部売上・内部受注の配分・管理売上・材料費・外注費・粗利益・人件費・経費・共通経費の案分額・損益)、品目別 (畳・襖・リフォーム・カーテン類・自社商品・その他・諸経費) の材料原価率、内部受注 (通常工事 20%・税込・切り捨て)、本部の特殊配分、材料原価 (材料構成・畳表の仮原価・畳縁・畳床の仕様・半畳・副資材 1 枚 100 円)、材料・単価一覧 (仕入値上げ時は適用開始日つきで単価を変更。過去の受注の原価は変わらない。新原本の単価表の取込可)、在庫・材料移動、仕入請求書の明細の振り分け (店舗・案件・品目・費用区分・要確認)、共通経費の粗利比の案分、月次確定と照合、設定 (配分率・営業エリア (地域一覧の取込)・品目・店舗)。店長は自店舗、本部スタッフ・管理者は全店舗。設定・案分の確定・月次確定は管理者。" },
  { href: "/capture", name: "書類取込", body: "手書き見積・レシート・請求書・アンケートはがき・図面を撮影またはアップロードし、AI が読み取った結果を確認・修正して、見積・経費・仕入・アンケートとして登録します。" },
  { href: "/approvals", name: "承認", body: "承認依頼の一覧。承認する・差し戻す (修正して再申請)・却下する (取りやめ) を選びます。差戻しと却下は理由が必要です。「自分の承認待ち」「自分の申請」のタブがあります。" },
  { href: "/messages", name: "社内連絡・業務依頼", body: "社内のスレッド (案件・全社・店舗) とメンション、業務依頼 (依頼 → 確認 → 報告 → 完了)。お知らせのベルにも表示されます。" },
  { href: "/contacts", name: "連絡履歴", body: "お客様・協力業者との電話・メール・LINE・Chatwork・来店のやりとりの記録。案件にひも付け、メール・LINE・Chatwork で送ることもできます。" },
  { href: "/ai", name: "AI アシスタント", body: "顧客・案件のデータや社内資料について質問できるチャットと、お客様向けの文面・日報の下書きを作る「文書の作成」。管理者は「チャットボットの管理」タブで回答の修正と学習を行います。" },
  { href: "/knowledge", name: "社内資料 (ナレッジ)", body: "価格の目安・作業手順・社内ルール・よくある質問など、AI とチャットボットが回答に使う資料を登録します。Google スプレッドシートと同期できます。" },
  { href: "/materials", name: "資料・写真", body: "案件・顧客・問い合わせにひも付いた資料と写真の一覧。閲覧の権限は登録先の記録に従います。" },
  { href: "/kpi", name: "KPI", body: "お客様アンケート・クレーム・口コミ・インセンティブの集計。全社・営業担当・担当職人・店舗の単位で評価します。" },
  { href: "/reports", name: "経営ダッシュボード", body: "期間・店舗・担当者を選んで売上・受注・施工・請求・入金・経費・仕入を集計し、CSV で書き出します。店長は自店舗のみ。店舗スタッフは使えません。" },
  { href: "/data", name: "データ入出力", body: "顧客・問い合わせの CSV と Google スプレッドシートの取込、各データの CSV の書き出し。本部スタッフ・管理者が使います。" },
  { href: "/audit", name: "変更履歴", body: "誰がいつ何を登録・変更・承認したかを、変更前と変更後の値つきで確認します。見られる範囲はロールで決まります。" },
  { href: "/settings", name: "設定", body: "ユーザーと権限・店舗・商品マスタ・帳票・運用・KPI・承認ルール・外部連携と AI・データ管理・本番運用の準備。変更は管理者のみ (店長は自店舗のスタッフのアカウント管理ができます)。" },
  { href: "/profile", name: "プロフィール", body: "右上の名前から開きます。自分の担当・予定・申請の確認、通知の受け取り方、顔写真、ログイン ID (メールアドレス) とパスワードの変更。" },
  { href: "/help", name: "使い方", body: "ロールごとの主な操作の流れを、画面の名前とボタンの名前で説明しています。" },
];

const ROLE_COL: { role: Role; col: "admin" | "hq" | "manager" | "staff" }[] = [
  { role: "admin", col: "admin" },
  { role: "hq_staff", col: "hq" },
  { role: "store_manager", col: "manager" },
  { role: "store_staff", col: "staff" },
];

export const CELL_TEXT: Record<Cell, string> = {
  "○": "できる (全店舗)",
  自店: "所属店舗の分だけできる",
  本人: "自分が登録・申請したものだけできる",
  閲覧: "見るだけ (変更はできない)",
  "−": "できない",
};

const OVERVIEW: NewDoc[] = [
  {
    key: "overview:system",
    title: "一畳屋 統合業務システムとは",
    href: "/",
    kind: "overview",
    body: "一畳屋 (畳・襖・障子・網戸などの内装の会社) の社内の業務システムです。問い合わせ → 見積 → 受注・施工 → 売上 → 請求 → 入金 を 1 つのデータベースで管理し、どの画面からも前後の記録をたどれます。拠点は合志店・中央店・西店・玉名店と本部・ショールーム (坪井) です。金額・契約・支払いに関わる変更は承認を通します。すべての登録・変更・承認は変更履歴に残ります。パソコンとスマートフォンのブラウザで使えます。",
  },
  {
    key: "overview:flow",
    title: "業務の流れ (問い合わせから入金まで)",
    href: "/cases",
    kind: "overview",
    body: "1. 問い合わせを登録 (電話・来店は手で、AI 電話・AI 相談・LINE・Web は自動) 2. 顧客として登録またはひも付け 3. 見積を作成して承認を申請 (基準額以上は管理者、未満は店長) 4. 見積の画面で受注登録 (契約の承認) 5. 引取・施工・納品の予定を登録 6. 施工完了を登録 (この日に売上を計上) 7. 請求書を発行して送付 8. 入金を登録。全体の状況は「案件の進捗」で確認します。",
  },
  {
    key: "overview:accounts",
    title: "アカウント (ログイン ID・パスワード・顔写真・新規登録)",
    href: "/profile",
    kind: "overview",
    body: "ログイン ID はメールアドレスの形です。自分のログイン ID・パスワード・顔写真は プロフィール で変更します (ログイン ID の変更は現在のパスワードが必要)。顔写真は削除できず、「表示しない」で隠し「表示する」でいつでも戻せます。前の写真も「以前の写真」から戻せます (ほかの社員の顔写真は管理者がアカウントの画面で)。パスワードは 8 文字以上。10 回続けて間違えると一時的にログインできません。忘れたときは管理者 (店舗スタッフは店長でも可) に再設定してもらいます。新しいアカウントは、管理者・店長が 設定 → ユーザーと権限 で追加するか、本人がログイン画面の「新規登録」から申請して管理者の承認を受けます。承認されるまではログインできません (承認のときに管理者がロール・所属を決めます)。社員のロール (店長・店舗スタッフ・本部スタッフ・管理者) と所属の変更は、管理者が 社員管理 の一覧の行で行います。退職者は無効にします。",
  },
  {
    key: "overview:chatbot",
    title: "チャットボット (画面左下) について",
    href: "/ai",
    kind: "overview",
    body: "画面左下の吹き出しのボタンで開きます。システムの使い方・画面の場所・権限・業務の流れに答えます。よくある質問はデータベースに蓄えた回答からすぐに答え、初めての質問だけ AI (OpenAI) が登録された資料をもとに答えて、その回答を次から再利用します。売上・未入金・予定などのデータの質問には、自分が見られる範囲のデータで答えます。チャットボットはデータを変更しません。回答の 👍 / 👎 は回答の改善に使います。違う回答は管理者が「AI アシスタント → チャットボットの管理」で直せます。",
  },
  {
    key: "overview:scope",
    title: "見られるデータの範囲 (店舗ごと)",
    href: "/settings?tab=users",
    kind: "overview",
    body: "管理者と本部スタッフは全店舗のデータを見られます。店長と店舗スタッフは所属店舗のデータだけを見られます (予定表だけは全店舗・全社員の予定を共有)。経費は店舗スタッフは自分の分のみ。経営ダッシュボードは店長は自店舗のみ、店舗スタッフは使えません。",
  },
  {
    key: "overview:approval",
    title: "承認の仕組み",
    href: "/approvals",
    kind: "overview",
    body: "見積・受注 (契約)・契約内容の変更・経費・仕入の支払依頼・顧客の重要情報の変更は承認を通します。承認者は金額で決まり、基準額以上は管理者、それ未満は所属店舗の店長 (店長のいない店舗は管理者) です。承認を省略してすぐ反映するもの (設定は不要): 管理者 (社長) の申請すべて。店長の顧客情報の登録・変更と、見積・受注 (見積の確定・金額変更・契約・契約内容・引取納品日・施工店舗) の申請 (お客様の決定 2026-11-24。ただし施工完了・請求済・入金済の受注の変更 (施工完了日・売上計上日を含む) と、経費・仕入の支払は管理者の承認のまま)。工事金額の変更で差額が設定の金額 (既定 1 万円) 以下の変更 (誰の申請でも)。予定 (引取・納品の日程を含む) の変更・削除 (既定は承認なし。設定 → 承認ルールの「予定の変更・削除に承認を必要とする」をオンにしたときだけ承認)。問い合わせの削除と顧客の削除 (二重登録・誤登録) は、店長・本部・管理者は承認なし、店舗スタッフは所属店舗の店長の承認のあとに削除。省略したときも承認の履歴に「管理者の申請のため承認を省略」「店長の申請のため承認を省略」と残ります。承認者は「承認する」「差し戻す」(修正して再申請)「却下する」(取りやめ) を選びます。承認依頼はお知らせのベルと、設定によりメール・Chatwork でも届きます。",
  },
  {
    key: "overview:notify",
    title: "お知らせ・通知 (メール・LINE・Chatwork)",
    href: "/profile",
    kind: "overview",
    body: "画面右上のベルに、承認待ち・メンション・業務依頼・期日超過の請求・新規登録の申請などが表示されます。メールや Chatwork でも受け取るかは プロフィール →「通知の受け取り方」で選びます。お客様・協力業者へのメール・LINE・Chatwork の送信は連絡履歴に残ります。LINE のグループは現場 (受注) や協力業者にひも付けると、写真が案件の資料に保存されます。",
  },
  {
    key: "overview:mobile",
    title: "スマートフォン・画面の操作",
    href: "/",
    kind: "overview",
    body: "同じ URL (https://ichijoya-system.jp) をスマートフォンのブラウザで開いて使えます。メニューは画面上部のタブです。左上の「予定表」ボタンはいつでも予定表を開きます。下にスクロールすると右下に「↑」(ページの先頭へ) のボタンが出ます。左下はチャットボットです。右上の「新規」から問い合わせ・顧客・見積・予定・経費・業務依頼をすぐに登録できます。",
  },
];

/** 画面の名前 (詳細・登録・編集の画面は、一覧の画面の名前から作る) */
function uiScreenName(u: UiEntry): string {
  if (u.title && !u.title.includes("…")) return u.title;
  const base = `/${u.route.split("/")[1] ?? ""}`;
  const list = SCREENS.find((s) => s.href === base)?.name.replace(/ \(.*\)$/, "") ?? base;
  if (u.route.endsWith("/edit")) return `${list}の編集画面`;
  if (u.route.endsWith("/new")) return `${list}の新規登録画面`;
  if (u.route.includes("[")) return `${list}の詳細画面 (${u.route})`;
  return list;
}

/** 資料を作る (DB の設定・社内資料を含む) */
export function buildDocs(db: Pick<Database, "settings" | "knowledge" | "stores">): NewDoc[] {
  const docs: NewDoc[] = [...OVERVIEW];

  for (const g of GUIDES) {
    const who = g.roles.length === 4 ? "全員" : g.roles.map((r) => ROLE_LABEL[r]).join("・");
    docs.push({ key: `guide:${g.id}`, title: `使い方: ${g.title}`, kind: "guide", href: "/help", body: g.steps.map(([t, b]) => `【${t}】${b}`).join("\n") + `\n(対象: ${who})` });
    g.steps.forEach(([t, b, href], i) => {
      docs.push({ key: `guide:${g.id}:${i}`, title: `${t} (${g.title})`, kind: "guide", href: href ?? "/help", body: `${b}\n(対象: ${who})` });
    });
  }

  const groups = new Map<string, typeof PERMISSION_TABLE>();
  for (const row of PERMISSION_TABLE) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  for (const [group, rows] of groups) {
    docs.push({
      key: `perm:${group}`,
      title: `権限: ${group}`,
      kind: "permission",
      href: "/settings?tab=users",
      body: rows.map((r) => `${r.action} → ${ROLE_COL.map(({ role, col }) => `${ROLE_LABEL[role]}: ${CELL_TEXT[r[col]]}`).join(" / ")}`).join("\n"),
    });
  }

  for (const { role, col } of ROLE_COL) {
    const can = PERMISSION_TABLE.filter((r) => r[col] !== "−").map((r) => `・${r.action} (${CELL_TEXT[r[col]]})`);
    const cannot = PERMISSION_TABLE.filter((r) => r[col] === "−").map((r) => `・${r.action}`);
    docs.push({ key: `role:${role}`, title: `ロール: ${ROLE_LABEL[role]} の権限`, kind: "role", href: "/settings?tab=users", body: `${ROLE_LABEL[role]}: ${ROLE_DESCRIPTION[role]}\nできること:\n${can.join("\n")}\nできないこと:\n${cannot.join("\n")}` });
  }

  for (const s of SCREENS) docs.push({ key: `screen:${s.href}`, title: `画面: ${s.name}`, kind: "screen", href: s.href, body: `${s.body} (メニューの「${s.name.replace(/ \(.*\)$/, "")}」、URL ${s.href})` });

  for (const u of UI_CATALOG as UiEntry[]) {
    const name = uiScreenName(u);
    const lines = [
      u.cards.length ? `表示されるカード:\n${u.cards.map((c) => `・${c}`).join("\n")}` : "",
      u.fields.length ? `入力欄: ${u.fields.join("、")}` : "",
      u.buttons.length ? `ボタン: ${u.buttons.map((b) => `「${b}」`).join("")}` : "",
      u.notes.length ? `注意書き:\n${u.notes.map((n) => `・${n}`).join("\n")}` : "",
    ].filter(Boolean);
    docs.push({ key: `ui:${u.route}`, title: `画面の詳細: ${name}`, kind: "ui", href: u.route.includes("[") ? u.route.split("/[")[0] || "/" : u.route, body: lines.join("\n").slice(0, 3500) });
  }

  const lab = (m: Record<string, { label: string } | string>) => Object.values(m).map((v) => (typeof v === "string" ? v : v.label)).filter((v) => v !== "-").join("・");
  docs.push({
    key: "status:all",
    title: "状態 (ステータス) の名前",
    kind: "status",
    href: "/cases",
    body: [
      `問い合わせ: ${lab(INQUIRY_STATUS)}`,
      `見積: ${lab(QUOTE_STATUS)}`,
      `受注・施工: ${lab(ORDER_STATUS)}`,
      `請求書: ${lab(INVOICE_STATUS)}`,
      `経費: ${lab(EXPENSE_STATUS)}`,
      `仕入: ${lab(PURCHASE_STATUS)}`,
      `承認: ${lab(APPROVAL_STATUS)} (種類: ${Object.values(APPROVAL_TYPE_LABEL).join("・")})`,
      `業務依頼: ${lab(TASK_STATUS)}`,
      `案件の進捗: ${lab(STAGE_LABEL)} / 見積と仕様: ${lab(SPEC_LABEL)} / 工事日程: ${lab(SCHEDULE_LABEL)} / 請求: ${lab(BILLING_LABEL)} / 入金: ${lab(PAYMENT_STATE_LABEL)}`,
    ].join("\n"),
  });

  const rules = approvalSettings(db);
  docs.push({
    key: "rules:approval",
    title: "承認ルール (基準額)",
    kind: "rules",
    href: "/settings?tab=rules",
    body: `見積・受注 (契約)・契約内容の変更: ${manYen(rules.quoteAdminThreshold)} 以上は管理者、それ未満は店長が承認。経費: ${manYen(rules.expenseAdminThreshold)} 以上は管理者、それ未満は店長が承認。顧客の重要情報 (氏名・フリガナ・電話・メール・郵便番号・住所) の変更: ${rules.customerChange ? "承認が必要 (店長・管理者が変更したときは承認なしで反映し、履歴に残す)" : "承認は不要 (履歴に残す)"}。仕入の支払依頼は管理者が承認。基準額は管理者が 設定 → 承認ルール で変更できます。`,
  });

  docs.push({
    key: "stores:all",
    title: "店舗 (所在地・電話)",
    kind: "store",
    href: "/settings?tab=stores",
    body: db.stores.map((s) => `${s.name}: 〒${s.postalCode} ${s.address} / ${storePhoneLabel(s, db.stores.find((x) => x.kind === "hq"))}`).join("\n"),
  });

  for (const k of db.knowledge ?? []) {
    // 閲覧を絞った資料はチャットボットの共通の資料に入れない (AI アシスタントが閲覧権限を確かめて直接読む)
    if (!k.active || (k.visibility && k.visibility !== "all")) continue;
    docs.push({ key: `knowledge:${k.id}`, title: `社内資料: ${k.title}`, kind: "knowledge", href: `/knowledge/${k.id}`, body: `${k.category ? `分類: ${k.category}\n` : ""}${k.body.slice(0, 4000)}` });
  }
  return docs;
}
