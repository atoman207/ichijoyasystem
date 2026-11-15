import "server-only";
import type { Database, Order, StoreId, SurveyResponse, User } from "@/lib/db/types";
import { newId, nowIso } from "@/lib/db/store";
import { normPostcardNo, tagComment } from "@/lib/survey";

/**
 * アンケートはがきを案件・担当者に紐づける
 * - 案件: はがきの No. と売上台帳 (受注) の「ハガキ」欄を照合する。英字の有無 (T698 / 698) の違いも見る
 * - 担当者: はがきの手書きの名前 (名字だけのことが多い) と社員の名前を照合する
 */

/** はがき No. の頭の英字から店舗を推定 (H = 中央、N = 西、T = 玉名。数字だけは合志または西) */
export function storeFromPostcard(no: string | undefined): StoreId | undefined {
  const n = normPostcardNo(no);
  if (/^H/.test(n)) return "chuo";
  if (/^N/.test(n)) return "nishi";
  if (/^T/.test(n)) return "tamana";
  return undefined;
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86400000;
const caseDate = (o: Order) => (o.salesDate ?? o.completedAt ?? o.contractDate).slice(0, 10);

/**
 * はがき No. から案件を探す。No. は年度や店舗をまたいで重複するため、店舗 (分かれば) と回答日に近い案件 (回答日より前・1 年以内) に絞る。
 * 候補が 1 件に決まらないときは見つからない扱い (担当者が受注番号を入力する)
 */
export function findOrderByPostcard(db: Pick<Database, "orders">, no: string | undefined, hint: { storeId?: StoreId; date?: string } = {}): Order | undefined {
  const n = normPostcardNo(no);
  if (!n) return undefined;
  const date = hint.date ?? new Date().toISOString().slice(0, 10);
  const storeId = hint.storeId ?? storeFromPostcard(n);
  const pick = (list: Order[]): Order | undefined => {
    let c = list.filter((o) => o.status !== "cancelled");
    if (storeId && c.some((o) => o.storeId === storeId)) c = c.filter((o) => o.storeId === storeId);
    c = c.filter((o) => caseDate(o) <= date && daysBetween(caseDate(o), date) <= 400);
    if (c.length <= 1) return c[0];
    c.sort((a, b) => caseDate(b).localeCompare(caseDate(a)));
    return daysBetween(caseDate(c[0]), caseDate(c[1])) > 60 ? c[0] : undefined;
  };
  const exact = pick(db.orders.filter((o) => o.postcardNo && normPostcardNo(o.postcardNo) === n));
  if (exact) return exact;
  const digits = n.replace(/^[A-Z]+/, "");
  if (!digits) return undefined;
  return pick(db.orders.filter((o) => o.postcardNo && normPostcardNo(o.postcardNo).replace(/^[A-Z]+/, "") === digits));
}

/** 登録済みの同じはがき (No. が同じ・同じ店舗・回答日が 300 日以内) */
export function findSurveyByPostcard(db: Pick<Database, "surveys">, no: string | undefined, opts: { exceptId?: string; storeId?: StoreId; date?: string } = {}): SurveyResponse | undefined {
  const n = normPostcardNo(no);
  if (!n) return undefined;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  return db.surveys.find(
    (s) =>
      s.id !== opts.exceptId &&
      s.postcardNo &&
      normPostcardNo(s.postcardNo) === n &&
      (!opts.storeId || s.storeId === opts.storeId) &&
      daysBetween((s.answeredOn ?? s.receivedAt).slice(0, 10), date) <= 300,
  );
}

const clean = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "").replace(/(様|さん|君|くん)$/, "");

/** 手書きの名前 (「、」区切りで複数可) から社員の ID を探す。同じ名字が複数いるときは担当店舗の社員を優先し、決められなければ空 */
export function matchStaff(users: User[], names: string | undefined, storeId?: StoreId): string[] {
  const out: string[] = [];
  for (const raw of (names ?? "").split(/[、,，・/／\n]+/)) {
    const name = clean(raw);
    if (name.length < 1) continue;
    const active = users.filter((u) => u.active);
    const full = active.filter((u) => clean(u.name) === name);
    const bySurname = active.filter((u) => clean(u.name.split(/[\s　]/)[0] ?? "") === name || (name.length >= 2 && clean(u.name).startsWith(name)));
    const cands = full.length ? full : bySurname;
    const pick = cands.length === 1 ? cands[0] : cands.filter((u) => u.storeId === storeId).length === 1 ? cands.find((u) => u.storeId === storeId) : undefined;
    if (pick && !out.includes(pick.id)) out.push(pick.id);
  }
  return out;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const score = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** 「価格、評判、その他 (○○)」の形 (一覧・旧集計表と同じ書き方) */
function joinAnswers(items: string[], other?: string): string | undefined {
  const base = items.filter((x) => x !== "その他");
  if (other) base.push(`その他 (${other})`);
  else if (items.includes("その他")) base.push("その他");
  return base.length ? base.join("、") : undefined;
}

export function surveyFromExtracted(
  db: Pick<Database, "surveys">,
  opts: { extracted: Record<string, unknown>; order?: Order; storeId: StoreId; clerkUserId?: string; salesUserId?: string; deliveryUserIds: string[]; documentId?: string; userId: string; source?: SurveyResponse["source"] },
): { survey: SurveyResponse } | { error: string } {
  const ex = opts.extracted;
  const postcardNo = normPostcardNo(text(ex.postcardNo)) || undefined;
  const dup = findSurveyByPostcard(db, postcardNo, { storeId: opts.storeId, date: text(ex.answeredOn) });
  if (dup) return { error: `はがき No.${postcardNo} (同じ店舗・1 年以内) のアンケートはすでに登録されています。二重に集計しないよう、登録しませんでした (登録済みのアンケートを開いて修正してください)。` };
  const priorityList = list(ex.priorityList);
  const mediaList = list(ex.mediaList);
  const delivery = [...new Set(opts.deliveryUserIds)];
  const comment = text(ex.comment);
  const auto = tagComment(comment);
  const tags = list(ex.commentTags);
  const now = nowIso();
  return {
    survey: {
      id: newId("sv"),
      receivedAt: now,
      postcardNo,
      storeId: opts.storeId,
      orderId: opts.order?.id,
      customerId: opts.order?.customerId,
      phoneScore: score(ex.phoneScore),
      salesName: text(ex.salesName),
      salesUserId: opts.salesUserId,
      salesScore: score(ex.salesScore),
      craftsmanName: text(ex.craftsmanName),
      craftsmanUserId: delivery[0],
      craftsmanScore: score(ex.craftsmanScore),
      finishScore: score(ex.finishScore),
      priorities: joinAnswers(priorityList, text(ex.priorityOther)),
      media: joinAnswers(mediaList, text(ex.mediaOther)),
      wouldUseAgain: ex.wouldUseAgain === "はい" || ex.wouldUseAgain === "いいえ" ? ex.wouldUseAgain : undefined,
      answeredOn: text(ex.answeredOn),
      clerkUserId: opts.clerkUserId,
      deliveryUserIds: delivery,
      priorityList,
      mediaList,
      comment,
      commentTags: comment ? (tags.length ? tags : auto.tags) : [],
      commentTone: comment ? ((["praise", "request", "complaint", "neutral"] as const).find((t) => t === ex.commentTone) ?? auto.tone) : undefined,
      documentId: opts.documentId,
      source: opts.source ?? "capture",
      createdBy: opts.userId,
      createdAt: now,
      updatedAt: now,
    },
  };
}
