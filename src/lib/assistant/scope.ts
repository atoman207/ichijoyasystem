import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canSeeAllStores, withAllStoresReadScope } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";

/**
 * AI アシスタントの閲覧範囲 (設定の id = assistant_scope)
 * - permission (既定): ログインした人の権限どおり (店舗のロールは自店舗)
 * - all_stores: AI アシスタントの読み取り (検索・集計・SQL・会社の全体像) だけ、全員が全店舗のデータを見られる。
 *   テスト期間などのため。終了日を決めると、その日を過ぎたら自動で権限どおりに戻る
 * 画面・登録・変更・承認・AI からの実行 (確認のカード)・ほかの人の相談の履歴・社内資料の公開範囲・管理会計 (社外秘) は変えない
 */

export const ASSISTANT_SCOPE_ID = "assistant_scope";

export interface AssistantScope {
  mode: "permission" | "all_stores";
  /** 全店舗にする最終日 (YYYY-MM-DD。空 = 戻すまで) */
  until?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export function assistantScope(db: Pick<Database, "settings">): AssistantScope {
  const row = (db.settings ?? []).find((s) => s.id === ASSISTANT_SCOPE_ID);
  const v = (row?.value ?? {}) as Partial<AssistantScope>;
  return { mode: v.mode === "all_stores" ? "all_stores" : "permission", until: typeof v.until === "string" && v.until ? v.until : undefined, updatedBy: row?.updatedBy, updatedAt: row?.updatedAt };
}

/** いま全店舗を見られる設定か (終了日を過ぎていれば権限どおり) */
export function assistantAllStores(db: Pick<Database, "settings">, now = new Date()): boolean {
  const s = assistantScope(db);
  return s.mode === "all_stores" && (!s.until || s.until >= toDateKey(now));
}

/** AI アシスタントの読み取りに使う利用者 (全店舗の設定なら、全店舗を見られる写し) */
export function assistantReadUser(db: Pick<Database, "settings">, user: User, now = new Date()): User {
  return assistantAllStores(db, now) ? withAllStoresReadScope(user) : user;
}

/* ================================================================== */
/* 権限の範囲外の質問 (店舗のロールが、ほかの店舗・本部・全社の数字を聞いた)                */
/* ================================================================== */

/** 店舗ごとに閲覧範囲を分けている数字 (売上・粗利・入金・経費・仕入・成績など)。予定表は全社共有なので含めない */
const SCOPED_FIGURES = /売上|売り上げ|粗利|利益|損益|業績|実績|入金|売掛|未入金|未回収|経費|仕入|原価|客単価|成約率|受注率|受注件数|受注額|受注金額|成約件数|見積金額|見積額|見積件数|問い合わせ件数|問合せ件数|件数と金額/;
/** 使い方の質問 (数字そのものではなく、出し方・画面の場所を聞いている) */
const HOW_TO = /方法|やり方|仕方|手順|どうやって|どうすれば|どこで|どこから|どの画面|画面で|操作|見方|出し方|調べ方/;
/** 自店舗の外を指す言葉 */
const OTHER_SCOPE = /全社|全店|会社全体|会社の|全体の|他店|他の店|ほかの店|他の店舗|ほかの店舗|各店|店舗別|店舗ごと|店舗間|全店舗|店ごと|店別|どの店|一番.{0,6}店|店舗.{0,4}(比較|比べ|ランキング|順位)|本部|本社/;

/**
 * 店舗のロールの人 (自店舗のデータだけを見られる) が、ほかの店舗・本部・全社の数字を聞いたら、調べずに断る文を返す (お客様の決定 2026-11-20)。
 * 全店舗を見られる人 (管理者・本部スタッフ・閲覧範囲 = 全店舗の設定) は null。数字の言葉がない質問 (予定・使い方・電話番号など) も null
 */
export function outOfScopeRefusal(db: Pick<Database, "settings" | "stores">, user: User, question: string, now = new Date()): string | null {
  const reader = assistantReadUser(db, user, now);
  if (canSeeAllStores(reader)) return null;
  const q = question.normalize("NFKC");
  if (!SCOPED_FIGURES.test(q) || HOW_TO.test(q)) return null;
  // 「A 店から B 店に X 円の工事を依頼したら、それぞれいくら？」(配分の決まりの計算。実際の数字ではない) は別の処理 (store_split) が権限を見て答える
  if (/(依頼|振っ|振る|回し|回す|内部受注|応援).{0,24}(場合|したら|すると|なら)/.test(q) && /\d/.test(q)) return null;
  const own = db.stores.find((s) => s.id === user.storeId);
  const others = db.stores.filter((s) => s.id !== user.storeId && (q.includes(s.name) || (s.shortName && new RegExp(`${s.shortName}(店|の|で|は|と|、|・)`).test(q)) || (s.kind === "hq" && /本部|本社/.test(q))));
  const generic = OTHER_SCOPE.exec(q)?.[0];
  if (!others.length && !generic) return null;
  const target = others.length ? others.map((s) => s.name).join("・") : generic === "本部" || generic === "本社" ? "本部" : "ほかの店舗・全社";
  const ownName = own?.name ?? "自店舗";
  return `申し訳ありません。${target}の売上などの数字は、${user.name} さんの閲覧の権限の範囲外のため、お答えできません (見られるのは ${ownName}のデータだけです)。${ownName}の数字であればお答えします (例:「${ownName}の今月の売上は？」)。`;
}
