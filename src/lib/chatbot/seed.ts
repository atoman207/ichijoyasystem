import "server-only";
import type { Database, Role } from "@/lib/db/types";
import { GUIDES } from "@/lib/help-guides";
import { PERMISSION_TABLE, type Cell } from "@/lib/auth/permission-table";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/constants";
import { approvalSettings, manYen } from "@/lib/approval-rules";
import { STORES } from "@/lib/db/master";
import { CELL_TEXT, SCREENS } from "./sources";
import type { NewQa, QaLink } from "./store";

/**
 * 最初から入れておく質問と回答 (AI を使わずに作る)
 * ------------------------------------------------------------
 * 使い方・権限・画面・ロール・店舗・社内資料から、よくある聞き方 (〜の方法・どこ・できますか など) の言い換えを作る。
 * データベースを作り直すたびに origin = seed の行は入れ替える (人が直した回答 manual は残る)
 */

const ROLES: { role: Role; col: "admin" | "hq" | "manager" | "staff" }[] = [
  { role: "admin", col: "admin" },
  { role: "hq_staff", col: "hq" },
  { role: "store_manager", col: "manager" },
  { role: "store_staff", col: "staff" },
];

const CELL_SENTENCE: Record<Cell, string> = {
  "○": "できます (全店舗)",
  自店: "所属店舗の分だけできます",
  本人: "自分が登録・申請したものだけできます",
  閲覧: "見ることだけできます (変更はできません)",
  "−": "できません",
};

const screenName = (href?: string) => {
  if (!href) return undefined;
  const base = href.split("?")[0];
  return SCREENS.find((s) => s.href === base)?.name;
};
const linkTo = (href?: string, label?: string): QaLink[] => (href ? [{ label: label ?? screenName(href) ?? "画面を開く", href }] : []);
const stripParen = (s: string) => s.replace(/\s*\([^)]*\)/g, "").replace(/\s*（[^）]*）/g, "").trim();

const HOW = ["{t}の方法", "{t}のやり方", "{t}はどうやるの", "{t}の手順", "{t}はどこでできますか", "{t}したい", "{t}について教えて", "{t}の仕方がわからない", "{t}の作り方", "{t}の作成方法", "{t}の登録方法", "{t}するには"];
/** 「パスワードの変更」→「パスワードを変えたい」など */
const CHANGE = ["{t}を変えたい", "{t}を変更したい", "{t}を変更する方法", "{t}の変え方", "{t}を変更するには"];
const SCREEN = ["{t}はどこ", "{t}の画面", "{t}で何ができる", "{t}とは", "{t}の使い方", "{t}を開きたい", "{t}はどこにありますか"];

const fill = (tpl: string[], t: string) => tpl.map((x) => x.replace("{t}", t));

export function buildSeed(db: Pick<Database, "settings" | "knowledge">): NewQa[] {
  const out: NewQa[] = [];
  const add = (questions: string[], answer: string, links: QaLink[], sourceKeys: string[], role = "") => {
    for (const question of questions) out.push({ question, answer, links, origin: "seed", sourceKeys, role });
  };

  // 使い方の各手順
  for (const g of GUIDES) {
    const who = g.roles.length === 4 ? "" : `\n(この操作は ${g.roles.map((r) => ROLE_LABEL[r]).join("・")} 向けです)`;
    g.steps.forEach(([title, body, href], i) => {
      const t = stripParen(title.replace(/^\d+\.\s*/, ""));
      const changed = t.match(/^(.+)の変更$/)?.[1];
      add([title, t, ...fill(HOW, t), ...(changed ? fill(CHANGE, changed) : [])], `${body}${who}`, linkTo(href), [`guide:${g.id}:${i}`]);
    });
    add([g.title, stripParen(g.title), `${stripParen(g.title)}の流れ`], g.steps.map(([t, b]) => `・${t}: ${b}`).join("\n"), linkTo("/help", "使い方"), [`guide:${g.id}`]);
  }

  // 画面
  for (const s of SCREENS) {
    const names = [...new Set([s.name, stripParen(s.name)])];
    add(names.flatMap((n) => fill(SCREEN, n)), `${s.body}\nメニューの「${stripParen(s.name)}」から開けます。`, linkTo(s.href, stripParen(s.name)), [`screen:${s.href}`]);
  }

  // 権限 (誰ができるか / そのロールはできるか / 自分はできるか)
  for (const row of PERMISSION_TABLE) {
    const a = stripParen(row.action);
    const all = ROLES.map(({ role, col }) => `・${ROLE_LABEL[role]}: ${CELL_TEXT[row[col]]}`).join("\n");
    const note = row.action !== a ? `\n補足: ${row.action.slice(a.length).trim().replace(/^\(|\)$/g, "")}` : "";
    const key = [`perm:${row.group}`];
    add([`${a}は誰ができますか`, `${a}の権限`, `${a}できる人`], `「${a}」の権限は次のとおりです。\n${all}${note}`, linkTo("/settings?tab=users", "権限一覧"), key);
    for (const { role, col } of ROLES) {
      add([`${ROLE_LABEL[role]}は${a}ができますか`, `${ROLE_LABEL[role]}も${a}できる`], `${ROLE_LABEL[role]}の場合、「${a}」は${CELL_SENTENCE[row[col]]}。\n\nほかのロール:\n${all}${note}`, linkTo("/settings?tab=users", "権限一覧"), key);
      add([`${a}はできますか`, `自分は${a}できる`, `私は${a}できますか`], `あなたのロール (${ROLE_LABEL[role]}) の場合、「${a}」は${CELL_SENTENCE[row[col]]}。${row[col] === "−" ? "\n必要なときは、できるロールの人 (下記) に依頼してください。" : ""}\n\n${all}${note}`, linkTo("/settings?tab=users", "権限一覧"), key, role);
    }
  }

  // ロール
  for (const { role, col } of ROLES) {
    const n = ROLE_LABEL[role];
    const can = PERMISSION_TABLE.filter((r) => r[col] !== "−").slice(0, 14).map((r) => `・${stripParen(r.action)}${r[col] === "○" ? "" : ` (${CELL_TEXT[r[col]]})`}`);
    const cannot = PERMISSION_TABLE.filter((r) => r[col] === "−").slice(0, 8).map((r) => `・${stripParen(r.action)}`);
    add([`${n}の権限`, `${n}は何ができる`, `${n}とは`, `${n}の役割`, `${n}ができること`], `${n}は、${ROLE_DESCRIPTION[role]}。\n\n主にできること:\n${can.join("\n")}${cannot.length ? `\n\nできないこと (例):\n${cannot.join("\n")}` : ""}\n\nすべての権限は 設定 → ユーザーと権限 の権限一覧で確認できます。`, linkTo("/settings?tab=users", "権限一覧"), [`role:${role}`]);
    add(["自分の権限", "私は何ができますか", "自分のロールは", "私の権限を教えて"], `あなたのロールは「${n}」です。${ROLE_DESCRIPTION[role]}。\n\n主にできること:\n${can.join("\n")}\n\nすべての権限は 設定 → ユーザーと権限 の権限一覧で確認できます。`, linkTo("/settings?tab=users", "権限一覧"), [`role:${role}`], role);
  }

  // 承認ルール
  const rules = approvalSettings(db);
  const approvalAnswer = `見積・受注 (契約)・契約内容の変更は ${manYen(rules.quoteAdminThreshold)} 以上が管理者、それ未満は所属店舗の店長が承認します。経費は ${manYen(rules.expenseAdminThreshold)} 以上が管理者、それ未満は店長です。店長のいない店舗と、店長本人の申請は管理者が承認します。仕入の支払依頼は管理者が承認します。`;
  add(["承認は誰がする", "誰が承認しますか", "承認者は誰", "いくらから管理者の承認", "管理者の承認が必要な金額", "見積の承認は誰", "経費の承認は誰", "承認の基準額", "承認ルール"], approvalAnswer, linkTo("/approvals", "承認"), ["rules:approval", "overview:approval"]);
  add(["差戻しと却下の違い", "差し戻すとどうなる", "却下するとどうなる"], "「差し戻す」は修正して再申請してもらうとき、「却下する」は申請そのものを取りやめるときに使います。どちらも理由の入力が必要で、申請した人にお知らせが届きます。", linkTo("/approvals", "承認"), ["overview:approval"]);

  // 店舗
  for (const s of STORES) {
    const names = [...new Set([s.name, s.shortName])];
    add(names.flatMap((n) => [`${n}の住所`, `${n}の電話番号`, `${n}の場所`, `${n}の連絡先`]), `${s.name}: 〒${s.postalCode} ${s.address} / TEL ${s.phone}`, linkTo("/settings?tab=stores", "店舗"), ["stores:all"]);
  }

  // 定番の質問
  add(["パスワードを忘れた", "ログインできない", "パスワードがわからない"], "パスワードを忘れたときは、管理者 (店舗スタッフは所属店舗の店長でも可) に再設定を頼んでください。右上の自分のアイコン → 社員管理 → 社員の画面 →「再設定する」で新しいパスワードを発行してもらえます。10 回続けて間違えた場合は、しばらく待ってから再度お試しください。", linkTo("/login", "ログイン"), ["guide:faq:0", "overview:accounts"]);
  add(["メールアドレスを変えたい", "ログインidを変えたい", "メールアドレスの変更"], "プロフィール →「ログイン ID (メールアドレス) の変更」に、新しいメールアドレスと現在のパスワードを入力して保存してください。次回のログインから新しい ID を使います。", linkTo("/profile", "プロフィール"), ["overview:accounts"]);
  add(["アバターを変えたい", "顔写真を登録したい", "プロフィール写真の変更", "アイコンを変えたい"], "プロフィール →「顔写真」で写真を選んで登録してください (512KB まで。大きい写真は自動で縮小されます)。「削除」を押すと、名前の頭文字の表示に戻ります。", linkTo("/profile", "プロフィール"), ["guide:basic:3"]);
  add(["新しいアカウントを作りたい", "アカウントの追加", "新入社員のアカウント", "新規登録の承認"], "管理者と店長は 右上の自分のアイコン → 社員管理 →「ユーザーを追加」で作れます (店長は自店舗の店舗スタッフのみ)。本人がログイン画面の「新規登録」から申請することもでき、その場合はお知らせに届いた申請を「承認する」と使えるようになります。", linkTo("/staff", "社員管理"), ["overview:accounts"]);
  add(["こんにちは", "はじめまして", "何ができるの", "チャットボットとは", "何を聞けばいい"], "こんにちは。一畳屋 統合業務システムの案内係です。\n画面の場所や操作の手順 (例:「見積の作り方」「経費の承認は誰？」)、権限、業務の流れのほか、「今日の予定」「未入金の請求」のようなデータの確認にもお答えします。気軽に聞いてくださいね。", [], ["overview:chatbot"]);

  // 社内資料 (タイトルが質問の形になっているものは、そのまま答えにする)
  for (const k of db.knowledge ?? []) {
    if (!k.active) continue;
    const t = k.title.trim();
    const body = k.body.trim();
    if (!t || !body) continue;
    const short = body.length > 700 ? `${body.slice(0, 700)}…\n(続きは社内資料の画面で確認してください)` : body;
    add([t, `${t}について`, `${t}を教えて`, `${t}とは`], short, linkTo(`/knowledge/${k.id}`, `社内資料: ${t.slice(0, 20)}`), [`knowledge:${k.id}`]);
  }
  return out;
}
