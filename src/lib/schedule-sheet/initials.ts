import type { User } from "@/lib/db/types";
import { foldName } from "@/lib/survey-workbook/staff";
import { nk } from "@/lib/survey-workbook/tabs";

/**
 * 予定表の「時間・担当」の欄の略称 → 社員 (お客様のご指示 2026-11-24「略称は 12 名の従業員の名前の頭文字を表すため、そのまま認識する」)
 * ------------------------------------------------------------
 * 予定表では担当者を 1 文字で書く (「緒」「菅」「立」「上」= 名字の 1 文字目、「光」「慎」= 名前の 1 文字目、
 * 「見」「森」= 名字の 1 文字目が同じ 2 人を 2 文字目で分ける、「マ」= 読みの頭文字、「社」= 社長)。
 * 2 人以上は続けて書く (「緒菅」「立見」「マ上」)。社員の名前はコードに書かず、有効な社員のアカウント (氏名・読み・肩書き) から作る。
 * 決め方 (上から順に、当たる社員がいる段で決める):
 *  1. 名字の 1 文字目  2. 名前の 1 文字目  3. 名字の 2 文字目以降  4. 名前の 2 文字目以降
 *  カタカナは読み (アカウントの kana) の 名字の頭 → 名前の頭。「社」「社長」は肩書きに「社長」のある社員
 *  同じ段に 2 人以上いるときは、予定の店舗の社員が 1 人ならその人。それでも決まらなければ決めない (間違えて担当にしない)
 * 表の対応表 (設定 schedule_sheet の aliases) に書いた略称は対応表が優先 (plan.ts の staffMatcher)
 */

type Staff = Pick<User, "id" | "name" | "storeId" | "active" | "title"> & { kana?: string };

export interface InitialMatch {
  userId?: string;
  /** 同じ段に 2 人以上いて店舗でも決まらなかった */
  ambiguous?: boolean;
}

const KATAKANA = /^[\p{Script=Katakana}ー]$/u;
const toKatakana = (s: string) => nk(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

export function staffInitials(users: Staff[]): (ch: string, storeId?: string) => InitialMatch {
  const staff = users
    .filter((u) => u.active && !u.id.startsWith("u_review"))
    .map((u) => {
      const [surname = "", ...given] = nk(u.name).split(/\s+/);
      const [kanaSur = "", ...kanaGiven] = toKatakana(u.kana ?? "").split(/\s+/);
      return { u, sur: foldName(surname), giv: foldName(given.join("")), kSur: kanaSur, kGiv: kanaGiven.join("") };
    });
  const tiersFor = (c: string): ((s: (typeof staff)[number]) => boolean)[] =>
    KATAKANA.test(c)
      ? [(s) => s.kSur.startsWith(c), (s) => s.kGiv.startsWith(c)]
      : [(s) => s.sur.startsWith(c), (s) => s.giv.startsWith(c), (s) => s.sur.slice(1).includes(c), (s) => s.giv.slice(1).includes(c)];
  const cache = new Map<string, InitialMatch>();
  return (raw: string, storeId?: string) => {
    const t = nk(raw).replace(/\s+/g, "");
    const key = `${t}|${storeId ?? ""}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let m: InitialMatch = {};
    if (t === "社" || t === "社長") {
      const p = staff.filter((s) => /社長/.test(s.u.title ?? "") && !/副社長/.test(s.u.title ?? ""));
      m = p.length === 1 ? { userId: p[0].u.id } : p.length ? { ambiguous: true } : {};
    } else if ([...t].length === 1) {
      const c = KATAKANA.test(t) ? t : foldName(t);
      for (const test of c ? tiersFor(c) : []) {
        const p = staff.filter(test);
        if (!p.length) continue;
        if (p.length === 1) m = { userId: p[0].u.id };
        else {
          const here = storeId ? p.filter((s) => s.u.storeId === storeId) : [];
          m = here.length === 1 ? { userId: here[0].u.id } : { ambiguous: true };
        }
        break;
      }
    }
    cache.set(key, m);
    return m;
  };
}

/**
 * 予定表に出す担当者の略称 (1 文字。お客様のご要望 2026-11-24「⑥」: 予定表でも誰がその現場へ行くか分かるように)
 * 予定表のスプレッドシートの書き方 (上の staffInitials) で、その 1 文字からその人に決まる文字を選ぶ:
 *   名字の 1 文字目 → 名前の 1 文字目 → 名字の 2 文字目以降 → 名前の 2 文字目以降 (社長は「社」)。どれも決まらなければ名字の 1 文字目
 */
export function initialsByUser(users: Staff[]): Map<string, string> {
  const find = staffInitials(users);
  const out = new Map<string, string>();
  for (const u of users) {
    const [surname = "", ...given] = nk(u.name).split(/\s+/);
    const g = given.join("");
    const sur = [...surname];
    const giv = [...g];
    let pick = "";
    if (/社長/.test(u.title ?? "") && !/副社長/.test(u.title ?? "") && find("社").userId === u.id) pick = "社";
    for (const c of pick ? [] : [sur[0], giv[0], ...sur.slice(1), ...giv.slice(1)]) {
      if (c && find(c).userId === u.id) {
        pick = c;
        break;
      }
    }
    out.set(u.id, pick || sur[0] || [...u.name][0] || "?");
  }
  return out;
}
