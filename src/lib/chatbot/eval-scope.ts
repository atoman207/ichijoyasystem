import type { Database, User } from "@/lib/db/types";
import { canAccessStore, canViewDocDraft, canViewExpense, canViewKnowledge, canViewPurchase } from "@/lib/auth/permissions";

/**
 * 精度の評価: 回答の根拠のリンクが、聞いた人の閲覧範囲の中か (どの質問でも確かめる)
 * ------------------------------------------------------------
 * 回答・要約・文書の根拠 (sources の href と本文の [..](/..) のリンク) が指す記録を 1 件ずつ permissions.ts で確かめる。
 * 見られない記録が 1 件でもあれば権限違反 (ほかの店舗の顧客・公開範囲の外の社内資料など)
 */

const ROUTES: [RegExp, (db: Database, user: User, id: string) => boolean | undefined][] = [
  [/^\/customers\/([^/?#]+)/, (db, u, id) => ok(db.customers.find((x) => x.id === id), (c) => canAccessStore(u, c.storeId))],
  [/^\/orders\/([^/?#]+)/, (db, u, id) => ok(db.orders.find((x) => x.id === id), (o) => canAccessStore(u, o.storeId))],
  [/^\/quotes\/([^/?#]+)/, (db, u, id) => ok(db.quotes.find((x) => x.id === id), (q) => canAccessStore(u, q.storeId))],
  [/^\/inquiries\/([^/?#]+)/, (db, u, id) => ok(db.inquiries.find((x) => x.id === id), (i) => canAccessStore(u, i.storeId))],
  [/^\/invoices\/([^/?#]+)/, (db, u, id) => ok(db.invoices.find((x) => x.id === id), (i) => canAccessStore(u, i.storeId))],
  [/^\/expenses\/([^/?#]+)/, (db, u, id) => ok(db.expenses.find((x) => x.id === id), (e) => canViewExpense(u, e))],
  [/^\/purchases\/([^/?#]+)/, (db, u, id) => ok(db.purchases.find((x) => x.id === id), (p) => canViewPurchase(u, p))],
  [/^\/knowledge\/(?!sources\/)([^/?#]+)/, (db, u, id) => ok(db.knowledge.find((x) => x.id === id), (k) => canViewKnowledge(u, k))],
  [/^\/ai\/drafts\/([^/?#]+)/, (db, u, id) => ok((db.docDrafts ?? []).find((x) => x.id === id), (d) => canViewDocDraft(u, d))],
];

/** 記録が見つからないときは判定しない (undefined) */
function ok<T>(rec: T | undefined, test: (r: T) => boolean): boolean | undefined {
  return rec === undefined ? undefined : test(rec);
}

/** 根拠のリンクのうち、聞いた人が見られない記録を指すもの */
export function scopeViolations(db: Database, user: User, hrefs: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of new Set(hrefs.filter(Boolean) as string[])) {
    const href = raw.replace(/^https?:\/\/[^/]+/, "");
    for (const [re, check] of ROUTES) {
      const m = href.match(re);
      if (!m) continue;
      if (check(db, user, decodeURIComponent(m[1])) === false) out.push(href);
      break;
    }
  }
  return out;
}

/** 回答の本文のリンク ([文字](/path)) */
export const answerLinks = (answer: string) => [...answer.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]);

/** href が条件 r に当たる (同じ、または r の後ろが / ? # で続く。r が / で終わるときは前方一致) */
export function hrefMatches(h: string, r: string): boolean {
  if (h === r) return true;
  if (!h.startsWith(r)) return false;
  return r.endsWith("/") || /[/?#]/.test(h[r.length] ?? "");
}

/** 必要な根拠のうち、根拠のどれにも当たらなかったもの */
export function missingSources(required: string[], hrefs: (string | undefined)[]): string[] {
  const hs = hrefs.filter(Boolean) as string[];
  return required.filter((r) => !hs.some((h) => hrefMatches(h, r)));
}

/** 出してはいけない根拠のうち、根拠にあったもの */
export function forbiddenSources(forbid: string[], hrefs: (string | undefined)[]): string[] {
  const hs = hrefs.filter(Boolean) as string[];
  return forbid.filter((r) => hs.some((h) => hrefMatches(h, r)));
}
