import type { Customer, Database, Order, ScheduleEvent, ScheduleKind } from "@/lib/db/types";
import { lineKind } from "@/lib/line-kind";
import { normalizeAddress } from "@/lib/maps/address";

/**
 * リフォーム現場の近隣挨拶文 (お客様のご要望 2026-11-27「■3」。お客様の Excel「挨拶文」の文面と項目)
 * ------------------------------------------------------------
 * 案件 (受注) から 顧客名・担当者名・工事日程 を自動で入れた下書きを作る。画面 (/print/greeting/<受注>) で直してから印刷する (保存はしない)。
 * - 顧客名: お客様の名字 (法人・施設はお名前)。施工場所に部屋番号があれば前に付ける (「307号 中川」→ 本文は「307号 中川 様邸にて」)
 * - 担当者名: 見積担当 → 作業の担当 (見積・施工) → 受注の作成者 の名字
 * - 工事日程: この案件の今日からの予定 (施工・リフォーム・現場管理・引取・納品・現見)。日付の一覧と、1 行 1 予定の内容
 *   (「12/20 クロス張替え (終日)」「12/22 午後 畳・建具納品」)。予定の作業内容 (ScheduleEvent.work) があればその文
 * 画面・サーバー・テストで使うため、サーバー専用の import をしない
 */

export interface GreetingDraft {
  title: string;
  /** 工事予定日 (例: 12月20日（火）・12月22日（木）/ 12月20日（火）〜12月22日（木）) */
  dates: string;
  /** 予定時間 */
  time: string;
  /** 顧客名 (「様邸」の前) */
  customer: string;
  /** 工事の種類 (「内装工事」) */
  work: string;
  /** 工事日程の内容 (1 行 1 件) */
  lines: string;
  /** お願いの文 */
  body: string;
  /** 担当者名 (吹き出しの「一畳屋の ○○ です」) */
  staff: string;
  /** 吹き出しの文 ({担当} を担当者名に置き換える) */
  bubble: string;
  company: { name: string; postalCode: string; address: string; tel: string; services: string };
}

export const GREETING_BODY = "皆様には工事車両・配送・騒音など大変ご迷惑をお掛けしますが、通行や安全等に配慮して行いますのでご協力の程お願い申しあげます。お気づきの点などございましたら、何なりとお声かけください。";
export const GREETING_BUBBLE = "担当させていただく一畳屋の {担当} です。ご迷惑をお掛けいたしますが、何卒よろしくお願いいたします。";
export const GREETING_SERVICES = "たたみ・ふすま・障子・アミ戸\nクロス・カーテン・ブラインドなど";
export const GREETING_TIME = "8:00〜17:00";

/** 挨拶文に載せる予定の種類 (工事・作業の日) */
const WORK_KINDS: ScheduleKind[] = ["install", "reform", "site", "pickup", "delivery", "onsite_quote"];
const WD = ["日", "月", "火", "水", "木", "金", "土"];

const ymd = (d: string) => d.split("-").map(Number) as [number, number, number];
const weekday = (d: string) => {
  const [y, m, day] = ymd(d);
  return WD[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
};
/** 12月20日（火） */
export const jpDate = (d: string) => `${ymd(d)[1]}月${ymd(d)[2]}日（${weekday(d)}）`;
const md = (d: string) => `${ymd(d)[1]}/${ymd(d)[2]}`;
const nextDay = (d: string) => {
  const [y, m, day] = ymd(d);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
};

/** 日付の一覧の書き方: 続いた 3 日以上は「〜」、ほかは「・」 */
export function datesText(dates: string[]): string {
  const ds = [...new Set(dates)].sort();
  if (!ds.length) return "";
  const groups: string[][] = [];
  for (const d of ds) {
    const g = groups.at(-1);
    if (g && nextDay(g.at(-1)!) === d) g.push(d);
    else groups.push([d]);
  }
  return groups.map((g) => (g.length >= 3 ? `${jpDate(g[0])}〜${jpDate(g.at(-1)!)}` : g.map(jpDate).join("・"))).join("・");
}

/** 名字 (空白の前。空白がなければお名前のまま) */
const surname = (name: string | undefined) => (name ?? "").trim().split(/[\s　]+/)[0] ?? "";

/** 見積の明細の品目 (畳・建具・カーテン …) */
function itemWords(q: { items: { name: string; spec?: string }[] } | undefined): string {
  const out: string[] = [];
  for (const it of q?.items ?? []) {
    const k = lineKind(it.name, it.spec)?.kind;
    const w = k === "tatami" ? "畳" : k === "fusuma" || k === "shoji" || k === "amido" || k === "butsuma" ? "建具" : k === "curtain" ? "カーテン" : undefined;
    if (w && !out.includes(w)) out.push(w);
  }
  return out.join("・");
}

/** 工事の種類の初期値 */
function workOf(o: Pick<Order, "category">): string {
  switch (o.category) {
    case "tatami":
      return "畳の工事";
    case "fusuma":
    case "shoji":
    case "amido":
      return "建具の工事";
    case "curtain":
      return "カーテンの取付工事";
    default:
      return "内装工事";
  }
}

/** 予定 1 件 → 「12/20 クロス張替え（終日）」 */
function eventLine(e: ScheduleEvent, o: Order, items: string, reformWork: string): string {
  const when = e.endDate && e.endDate > e.date ? `${md(e.date)}〜${md(e.endDate)}` : md(e.date);
  const time = e.startTime ? ` ${e.startTime.replace(/^0/, "")}〜${e.endTime ? e.endTime.replace(/^0/, "") : ""}` : e.slot === "am" ? "午前" : e.slot === "pm" ? "午後" : "";
  const own = (e.work ?? "").trim();
  const content =
    own ||
    (e.kind === "delivery"
      ? `${items}納品`
      : e.kind === "pickup"
        ? `${items}引き取り`
        : e.kind === "site"
          ? "現場の確認"
          : e.kind === "onsite_quote"
            ? "お見積り・作業"
            : o.workDetails?.split(/\r?\n/)[0]?.trim() || reformWork || "工事");
  const allDay = !e.startTime && !e.slot && (e.kind === "install" || e.kind === "reform");
  return `${when}${time}　${content}${allDay ? "（終日）" : ""}`;
}

type GreetingDb = Pick<Database, "orders" | "quotes" | "customers" | "users" | "schedule">;

/** 受注から近隣挨拶文の下書きを作る */
export function greetingDraft(db: GreetingDb, o: Order, today: string, company: GreetingDraft["company"]): GreetingDraft {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const c: Customer | undefined = db.customers.find((x) => x.id === o.customerId);
  // この案件の予定 (受注・見積・問い合わせ)。今日からの予定、なければ全部
  const all = db.schedule
    .filter((e) => WORK_KINDS.includes(e.kind) && (e.orderId === o.id || (q && e.quoteId === q.id) || (q?.inquiryId && e.inquiryId === q.inquiryId)))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const coming = all.filter((e) => (e.endDate ?? e.date) >= today);
  const events = coming.length ? coming : all;
  const items = itemWords(q);
  const reformWork = (q?.items ?? [])
    .filter((it) => lineKind(it.name, it.spec)?.kind === "reform")
    .map((it) => it.name.trim())
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .slice(0, 3)
    .join("・");
  const dates: string[] = [];
  for (const e of events) {
    for (let d = e.date; d <= (e.endDate ?? e.date) && dates.length < 60; d = nextDay(d)) dates.push(d);
  }
  if (!dates.length && o.scheduledStart) for (let d = o.scheduledStart; d <= (o.scheduledEnd ?? o.scheduledStart) && dates.length < 60; d = nextDay(d)) dates.push(d);
  // 顧客名: 個人は名字 (施工場所の部屋番号を前に)、法人・施設はお名前
  const rawRoom = normalizeAddress(o.siteAddress || c?.address || "").room;
  const room = rawRoom ? (/^\d+$/.test(rawRoom) ? `${rawRoom}号` : rawRoom) : "";
  const name = c?.type === "corporate" ? (c?.name ?? "") : surname(c?.name);
  const staffId = q?.estimatorId ?? o.workStaff?.survey[0] ?? o.workStaff?.install[0] ?? o.createdBy;
  return {
    title: "工事開始のご挨拶",
    dates: datesText(dates),
    time: GREETING_TIME,
    customer: [room, name].filter(Boolean).join(" "),
    work: workOf(o),
    lines: events.slice(0, 8).map((e) => eventLine(e, o, items, reformWork)).join("\n"),
    body: GREETING_BODY,
    staff: surname(db.users.find((u) => u.id === staffId)?.name),
    bubble: GREETING_BUBBLE,
    company,
  };
}
