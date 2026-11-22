import type { StoreId, User } from "@/lib/db/types";
import { nk } from "./tabs";

/**
 * シートに書かれた担当者の名前 → 社員のアカウント
 * ------------------------------------------------------------
 * シートは姓だけ (例: 「大谷」)・名だけ・「〇〇店長」のように書かれる。照合の順番:
 * 1. 対応表 (設定。KPI → スプレッドシートの取込 →「担当者の名前の対応」。シートの名前 → 社員 / アカウントなし / 数えない)
 * 2. 氏名 (空白を除く) が同じ 3. 姓が同じ社員が 1 人だけ 4. 名が同じ社員が 1 人だけ
 * 旧字体 (髙・﨑・澤 など) と肩書き (店長・社長・さん) はそろえてから比べる。当たらない名前は「name:<名前>」(アカウントなし) として残す
 */

export interface StaffMatch {
  /** 社員の ID、またはアカウントのない人の「name:<名前>」。数えない名前は "" */
  key: string;
  userId?: string;
  /** シートの名前 (そろえたもの。照合・対応表の見出しに使う) */
  name: string;
  /** シートに書かれたままの名前 (画面の表示用) */
  raw: string;
  storeId: StoreId;
  via: "alias" | "full" | "surname" | "given" | "none" | "ignored";
}

const VARIANTS: [RegExp, string][] = [
  [/髙/g, "高"],
  [/﨑/g, "崎"],
  [/嵜/g, "崎"],
  [/澤/g, "沢"],
  [/濵/g, "浜"],
  [/濱/g, "浜"],
  [/[邊邉]/g, "辺"],
  [/[齋齊]/g, "斎"],
  [/德/g, "徳"],
  [/槇/g, "槙"],
  [/冨/g, "富"],
];

/** 名前をそろえる (空白・肩書き・旧字体) */
export function foldName(raw: string): string {
  let s = nk(raw).replace(/\s+/g, "");
  s = s.replace(/(店長|副店長|社長|専務|常務|部長|課長|主任|さん|様|さま|君|くん|ちゃん)$/u, "");
  for (const [re, to] of VARIANTS) s = s.replace(re, to);
  return s;
}

/** 対応表の値: 社員 ID / "name:<名前>" (アカウントなし) / "-" (数えない) */
export type StaffAliases = Record<string, string>;

export function staffMatcher(users: Pick<User, "id" | "name" | "storeId" | "active">[], aliases: StaffAliases = {}): (raw: string) => StaffMatch {
  const folded = new Map<string, string>();
  for (const [k, v] of Object.entries(aliases)) folded.set(foldName(k), v);
  const parts = users.map((u) => {
    const [surname, ...rest] = nk(u.name).split(/\s+/);
    return { u, full: foldName(u.name), surname: foldName(surname ?? ""), given: foldName(rest.join("")) };
  });
  const unique = (list: typeof parts) => (list.length === 1 ? list[0].u : list.filter((p) => p.u.active).length === 1 ? list.find((p) => p.u.active)!.u : undefined);
  const cache = new Map<string, StaffMatch>();
  return (raw: string) => {
    const name = foldName(raw);
    const hit = cache.get(name);
    if (hit) return hit;
    const shown = nk(raw);
    let m: StaffMatch;
    const alias = folded.get(name);
    if (alias !== undefined) {
      const u = users.find((x) => x.id === alias);
      if (alias === "-") m = { key: "", name, raw: shown, storeId: "hq", via: "ignored" };
      else if (u) m = { key: u.id, userId: u.id, name, raw: shown, storeId: u.storeId, via: "alias" };
      else m = { key: alias.startsWith("name:") ? alias : `name:${name}`, name, raw: shown, storeId: "hq", via: "alias" };
    } else if (!name) {
      m = { key: "", name, raw: shown, storeId: "hq", via: "ignored" };
    } else {
      const full = unique(parts.filter((p) => p.full === name));
      const sur = full ? undefined : unique(parts.filter((p) => p.surname === name));
      const giv = full || sur ? undefined : unique(parts.filter((p) => p.given && p.given === name));
      const u = full ?? sur ?? giv;
      m = u ? { key: u.id, userId: u.id, name, raw: shown, storeId: u.storeId, via: full ? "full" : sur ? "surname" : "given" } : { key: `name:${shown.replace(/\s+/g, "")}`, name, raw: shown, storeId: "hq", via: "none" };
    }
    cache.set(name, m);
    return m;
  };
}

/** 対応表の入力 (1 行 = 「シートの名前 = 社員の名前 / アカウントなし / 数えない」) を読む */
export function parseAliasLines(text: string, users: Pick<User, "id" | "name">[]): { aliases: StaffAliases; errors: string[] } {
  const aliases: StaffAliases = {};
  const errors: string[] = [];
  const byName = new Map(users.map((u) => [foldName(u.name), u.id]));
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const t = nk(line);
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(.+?)\s*[=＝→]\s*(.+)$/);
    if (!m) {
      errors.push(`${i + 1} 行目: 「シートの名前 = 社員の名前」の形で書いてください`);
      continue;
    }
    const from = m[1].trim();
    const to = m[2].trim();
    if (/^(数えない|除く|-)$/.test(to)) aliases[from] = "-";
    else if (/^(アカウントなし|なし)$/.test(to)) aliases[from] = `name:${foldName(from)}`;
    else {
      const id = users.find((u) => u.id === to)?.id ?? byName.get(foldName(to));
      if (id) aliases[from] = id;
      else errors.push(`${i + 1} 行目: 社員「${to}」が見つかりません (アカウントの氏名で書くか、「アカウントなし」「数えない」)`);
    }
  }
  return { aliases, errors };
}

/** 対応表 → 入力欄の文字 */
export function formatAliasLines(aliases: StaffAliases, users: Pick<User, "id" | "name">[]): string {
  return Object.entries(aliases)
    .map(([k, v]) => `${k} = ${v === "-" ? "数えない" : v.startsWith("name:") ? "アカウントなし" : (users.find((u) => u.id === v)?.name ?? v)}`)
    .join("\n");
}
