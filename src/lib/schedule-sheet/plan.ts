/**
 * 予定表 (スプレッドシート) → 新システムの予定表への移行: 照合 (planSheetImport) と書き込み (applySheetImport)
 * (お客様のご要望 2026-11-23「■ 予定表の新システムへの移行について」)
 * ------------------------------------------------------------
 * - 取り込むのは「取り込む最初の日」(既定は明日) 以降の予定。読み込んだ月のファイルの範囲だけを扱う
 * - お客様の予定 (地区つきの名前など) は、既存の顧客 (姓 + 地区・住所。地区がなければ同じ店舗) にひも付け、
 *   見つからなければ新しい顧客を登録する。候補が複数のときは最も確からしい顧客を既定にして画面で選び直せる (重複を作らない)
 * - 案件: 顧客の進行中の受注 → 進行中の問い合わせ → なければ新しい問い合わせ (予定表から移行) を登録して予定とつなぐ
 * - 新システムに登録済みの同じ予定 (同じ日・同じ種類・同じお客様) は取り込まない (二重にしない)
 * - 以前の移行 (2026-11-11 のファイル) と前回の取込の予定は、同じ予定なら ID を使い回して書き換え、スプレッドシートから
 *   なくなった予定は消す (新システムで変更した予定は残す)。消した予定は変更履歴に残す (試験期間の引き継ぎも同じ扱い)
 * - 右上の人の予定 (光子 など)・事務の欄の人は、担当者の名前の対応 (設定) で社員の予定にする
 * 純粋な関数 (db を受け取る)。保存は actions/schedule-sheet.ts と /api/cron/schedule-sheet が mutate の中で呼ぶ
 */
import type { Customer, Database, Inquiry, ScheduleEvent, ScheduleKind, ServiceCategory, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addAudit, newId, nextCustomerCode, nextNumber, nowIso } from "@/lib/db/store";
import { stripKindWords } from "@/lib/work-summary";
import { addDays, toDateKey } from "@/lib/format";
import { foldName, staffMatcher, type StaffAliases } from "@/lib/survey-workbook/staff";
import { staffInitials } from "./initials";
import { fold, nk, splitName, withoutTime, type SheetEvent, type SheetMonth } from "./parse";

export const SHEET_SETTINGS_ID = "schedule_sheet";
/** 取り込んだ予定の印 (sourceRef の頭) */
export const SHEET_REF_PREFIX = "sheet:";
/** 以前の移行 (クライアント資料の予定表のファイル) の予定の取込元 */
const LEGACY_REF_RE = /予定表.*\.xlsx#\d{1,2}!\d+$/;

export interface SheetImportSettings {
  /** シートの名前 → 社員の ID / "-" (担当にしない) */
  aliases: StaffAliases;
  lastImport?: { at: string; by: string; label: string; from: string; to: string; summary: string };
  /** 取込で書いた予定の印 (予定の ID → 書いたときの内容の印)。取り込み直すときに、新システムで変えた予定を上書きしないため */
  written?: Record<string, string>;
}

export function sheetSettings(db: Pick<Database, "settings">): SheetImportSettings {
  const v = ((db.settings ?? []).find((s) => s.id === SHEET_SETTINGS_ID)?.value ?? {}) as Partial<SheetImportSettings>;
  const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, string>) : {});
  return { aliases: obj(v.aliases), lastImport: v.lastImport, written: obj(v.written) };
}

/** 予定の内容の印 (取込で書いたあとに新システムで変えたかを見分ける) */
export function eventFingerprint(e: Pick<ScheduleEvent, "title" | "kind" | "date" | "endDate" | "startTime" | "endTime" | "slot" | "storeId" | "assigneeIds" | "memo" | "location" | "customerId" | "inquiryId" | "quoteId" | "orderId">): string {
  const text = [e.title, e.kind, e.date, e.endDate, e.startTime, e.endTime, e.slot, e.storeId, [...e.assigneeIds].sort().join(","), e.memo, e.location, e.customerId, e.inquiryId, e.quoteId, e.orderId].map((v) => v ?? "").join("\u0001");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function writeSheetSettings(db: Database, next: SheetImportSettings, by: string): void {
  const now = nowIso();
  const value = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  const row = db.settings.find((s) => s.id === SHEET_SETTINGS_ID);
  if (row) Object.assign(row, { value, updatedBy: by, updatedAt: now });
  else db.settings.push({ id: SHEET_SETTINGS_ID, value, updatedBy: by, updatedAt: now });
}

/* ---------------- 計画の形 ---------------- */

export interface CustomerChoice {
  id: string;
  label: string;
  /** 進行中の案件 (受注・問い合わせ) */
  openCase?: string;
  last?: string;
  score: number;
}

/** お客様 (店舗 × 地区 × 名前) ごとの照合 */
export interface PlanGroup {
  gkey: string;
  storeId: StoreId;
  area?: string;
  name: string;
  candidates: CustomerChoice[];
  /** 既定の選択 (顧客の ID / "new" = 新しく登録 / "none" = ひも付けない) */
  auto: string;
  /** 画面で選んだもの (なければ auto) */
  choice: string;
  /** 候補が複数で決めきれない (画面で確かめる) */
  ambiguous: boolean;
  /** 選んだ顧客の進行中の案件 (なければ新しい問い合わせを登録) */
  caseRef?: { kind: "order" | "inquiry"; id: string; label: string };
  eventKeys: string[];
}

export type ItemStatus = "add" | "update" | "same" | "duplicate" | "kept";

export interface PlanItem {
  key: string;
  ev: SheetEvent;
  status: ItemStatus;
  /** 書き換える (同じ) 予定の ID */
  eventId?: string;
  /** 新システムに登録済みの同じ予定 */
  dupOf?: { id: string; title: string };
  gkey?: string;
  storeId: StoreId;
  title: string;
  memo?: string;
  assigneeIds: string[];
  unknownStaff: string[];
}

export interface SheetPlan {
  from: string;
  to: string;
  months: { label: string; first: string; last: string; days: number; events: number }[];
  items: PlanItem[];
  groups: PlanGroup[];
  /** スプレッドシートからなくなった、以前に取り込んだ予定 (消す) */
  remove: { id: string; title: string; date: string; storeId: StoreId }[];
  /** なくなったが新システムで変更されているので残す予定 */
  keep: { id: string; title: string; date: string; reason: string }[];
  /** 社員に当たらなかった名前 (担当者の名前の対応で決める) */
  unknownNames: { name: string; count: number; example: string }[];
  /** 右上の予定・事務の欄の人 → 社員 */
  persons: { name: string; userId?: string; userName?: string; count: number }[];
  counts: { add: number; update: number; same: number; duplicate: number; kept: number; remove: number; newCustomers: number; linkedCustomers: number; newCases: number; linkedCases: number; ambiguous: number; noCustomer: number };
}

const KJ: Partial<Record<ScheduleKind, string>> = { delivery: "納品", pickup: "引き取り", measure: "採寸", survey: "現地調査・見積", onsite_quote: "現場見積", visit: "顧客訪問", site: "現場管理" };
const CASE_KINDS = new Set<ScheduleKind>(["pickup", "delivery", "survey", "onsite_quote", "measure", "visit", "install", "site"]);
const OPEN_ORDER = new Set(["confirmed", "scheduled", "in_progress"]);
const OPEN_INQUIRY = new Set(["new", "in_progress", "quoted"]);
const family = (k: ScheduleKind) => (k === "pickup" ? "pickup" : k === "delivery" ? "delivery" : k === "install" ? "install" : CASE_KINDS.has(k) ? "visit" : k);

/** 地区の比べ方 (空白・市町村郡の字を除く) */
const foldArea = (s: string | undefined) => fold(s).replace(/大字/g, "").replace(/[市町村郡区]/g, "");
function areaMatches(area: string, c: Pick<Customer, "area" | "address">): boolean {
  const a = foldArea(area);
  if (!a) return false;
  const ca = foldArea(c.area);
  if (ca && (ca === a || ca.includes(a) || a.includes(ca))) return true;
  const addr = foldArea(c.address);
  return Boolean(addr && addr.includes(a));
}

/** 顧客の名前の姓 (空白の前。空白がなければ全体) */
const surnameOf = (name: string) => foldName(nk(name).split(" ")[0] ?? "");

function customerIndex(db: Database) {
  const bySurname = new Map<string, Customer[]>();
  for (const c of db.customers) {
    const keys = new Set([surnameOf(c.name), foldName(c.name)]);
    for (const k of keys) if (k) (bySurname.get(k) ?? bySurname.set(k, []).get(k)!).push(c);
  }
  const last = new Map<string, string>();
  const bump = (id: string | undefined, d: string | undefined) => {
    if (!id || !d) return;
    const v = d.slice(0, 10);
    if ((last.get(id) ?? "") < v) last.set(id, v);
  };
  for (const o of db.orders) bump(o.customerId, o.salesDate ?? o.contractDate);
  for (const q of db.inquiries) bump(q.customerId, q.receivedAt);
  for (const e of db.schedule) bump(e.customerId, e.date);
  const openCase = new Map<string, { kind: "order" | "inquiry"; id: string; label: string; at: string }>();
  for (const o of db.orders) {
    if (!o.customerId || o.source === "import" || !OPEN_ORDER.has(o.status)) continue;
    const cur = openCase.get(o.customerId);
    const at = o.updatedAt ?? o.createdAt ?? "";
    if (!cur || cur.kind !== "order" || cur.at < at) openCase.set(o.customerId, { kind: "order", id: o.id, label: `受注 ${o.number} ${o.title}`, at });
  }
  for (const q of db.inquiries) {
    if (!q.customerId || !OPEN_INQUIRY.has(q.status)) continue;
    const cur = openCase.get(q.customerId);
    if (cur?.kind === "order") continue;
    if (!cur || cur.at < q.receivedAt) openCase.set(q.customerId, { kind: "inquiry", id: q.id, label: `問い合わせ ${q.number} ${q.summary}`.slice(0, 60), at: q.receivedAt });
  }
  return { bySurname, last, openCase };
}

/** 予定の件名 (以前の移行と同じ書き方。例: (須屋) 大岩 引き取り) */
function titleOf(ev: SheetEvent): string {
  if (ev.customerLike && ev.name && (ev.side === "hagi" || ev.side === "shiki")) {
    const claim = ev.tags.some((t) => t.startsWith("クレーム")) ? " (クレーム対応)" : "";
    return `${ev.area ? `(${ev.area}) ` : ""}${ev.name} ${KJ[ev.kind] ?? SCHEDULE_KIND[ev.kind].label}${claim}`;
  }
  return (ev.startTime ? withoutTime(ev.raw) : ev.raw).slice(0, 80);
}

/** 予定のメモ: 1 行目は枚数 (予定表の仕事内容・畳製造予定が読む)・備考・製造の表・読めなかった担当欄 */
function memoOf(ev: SheetEvent, unknownStaff: string[]): string | undefined {
  const store = ev.side === "hagi" || ev.side === "shiki";
  const lines = [ev.countText, store ? ev.extra : undefined, ev.remark, ...(ev.production ?? []), unknownStaff.length && ev.staffText ? `担当欄: ${ev.staffText}` : undefined];
  if (ev.side === "person" || ev.side === "office") lines.push(ev.person ? `予定表の「${ev.person}」の欄` : undefined);
  const text = lines.filter(Boolean).join("\n");
  return text || undefined;
}

/** 「時間・担当」の欄で名前ではない言葉 */
const STAFF_STOP = /^(仮|済|済み|未定|未|現金|振込|確認|予定|TEL|電話|連絡|集金|持参|かえ|替え|人|名|可|不可|頃|以降|まで|から|午前|午後|AM|PM|納品|引取|引き取り|ハギ|シキ|当日|翌日|朝|夕方|昼|夜)$/i;

/**
 * 「時間・担当」の欄の名前 → 社員 (時刻・数字・記号を除いて区切る)。
 * 区切りのない書き方 (「田中中村」「緒菅」「立見」「マ上」) は前から、知っている名前 (2 文字以上) → 対応表 → 略称 (1 文字。initials.ts) の順に分ける。
 * 全部の文字が社員に当たったときだけ担当にする (当たらない文字があれば、その書き方は「社員に当たらない名前」)
 */
export function staffOf(text: string | undefined, match: ReturnType<typeof staffMatcher>, known: string[], initial: ReturnType<typeof staffInitials>, storeId?: StoreId): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  if (!text) return { ids, unknown };
  const cleaned = nk(text)
    .replace(/\d{1,2}(?::\d{2})?\s*(?:時半?)?\s*[〜～~\-ー－]\s*(?:\d{1,2}(?::\d{2})?\s*時?半?)?/g, " ")
    .replace(/\d{1,2}:\d{2}|\d{1,2}時半?|頃|以降|から|まで|AM|PM|午前|午後/gi, " ")
    .replace(/[0-9０-９:：()（）\[\]【】.。、,，・/／&＆+＋→]/g, " ");
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const tok of cleaned.split(/\s+/).filter(Boolean)) {
    if (STAFF_STOP.test(tok)) continue;
    // 「社」「社長」= 肩書きに社長のある社員 (foldName は「社長」を敬称として消すため先に見る)
    if (tok === "社" || tok === "社長") {
      const im = initial(tok, storeId);
      if (im.userId) add(im.userId);
      else unknown.push(tok);
      continue;
    }
    const m = match(tok);
    if (m.userId) {
      add(m.userId);
      continue;
    }
    if (m.via === "ignored") continue;
    // 区切りのない名前・略称 (前から: 知っている名前 → 1 文字の対応表 → 略称)
    let rest = foldName(tok);
    const found: string[] = [];
    while (rest) {
      const k = known.find((w) => rest.startsWith(w));
      const ku = k ? match(k).userId : undefined;
      if (k && ku) {
        if (!found.includes(ku)) found.push(ku);
        rest = rest.slice(k.length);
        continue;
      }
      const ch = [...rest][0];
      const cm = match(ch);
      const cu = cm.userId ?? initial(ch, storeId).userId;
      if (!cu) break;
      if (!found.includes(cu)) found.push(cu);
      rest = rest.slice(ch.length);
    }
    if (found.length && !rest) for (const u of found) add(u);
    else if (tok.length <= 8 && !/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(tok)) unknown.push(tok);
  }
  return { ids, unknown };
}

export interface PlanOptions {
  /** 取り込む最初の日 (この日以降の予定) */
  from: string;
  /** 画面で選んだ顧客 (gkey → 顧客の ID / "new" / "none") */
  picks?: Record<string, string>;
}

/**
 * 読み込んだ月のファイル → 取込の計画 (書き込まない)
 */
export function planSheetImport(db: Database, months: SheetMonth[], opts: PlanOptions): SheetPlan {
  const settings = sheetSettings(db);
  const users = db.users.filter((u) => !u.id.startsWith("u_review"));
  const match = staffMatcher(users, settings.aliases);
  const initial = staffInitials(users);
  const known = [
    ...new Set(
      [
        ...users.filter((u) => u.active).flatMap((u) => {
          const [s, ...g] = nk(u.name).split(" ");
          return [foldName(s ?? ""), foldName(g.join(""))];
        }),
        ...Object.keys(settings.aliases).map(foldName),
      ].filter((x) => x.length >= 2),
    ),
  ].sort((a, b) => b.length - a.length);
  const userById = new Map(db.users.map((u) => [u.id, u]));
  const idx = customerIndex(db);

  // 月の範囲 (読み込んだ月だけ)
  const monthRanges = months.map((m) => {
    const first = `${m.year}-${String(m.month).padStart(2, "0")}-01`;
    const last = addDays(`${m.month === 12 ? m.year + 1 : m.year}-${String((m.month % 12) + 1).padStart(2, "0")}-01`, -1);
    return { m, first, last };
  });
  const inMonths = (d: string) => monthRanges.some((r) => d >= r.first && d <= r.last && d >= opts.from);
  const to = monthRanges.reduce((x, r) => (r.last > x ? r.last : x), opts.from);

  const unknownCount = new Map<string, { count: number; example: string }>();
  const drafts = new Map<string, { area?: string; name: string; stores: StoreId[]; keys: string[] }>();
  const personUse = new Map<string, number>();
  const groups = new Map<string, PlanGroup>();
  const items: PlanItem[] = [];

  for (const { m } of monthRanges) {
    for (const ev of m.events) {
      if (ev.date < opts.from) continue;
      // 担当者
      let assigneeIds: string[] = [];
      let unknown: string[] = [];
      let storeId: StoreId | undefined = ev.storeId;
      if (ev.person) {
        personUse.set(ev.person, (personUse.get(ev.person) ?? 0) + 1);
        const pm = match(ev.person);
        if (pm.userId) {
          assigneeIds = [pm.userId];
          storeId = userById.get(pm.userId)?.storeId ?? storeId;
        } else if (pm.via !== "ignored") unknown.push(ev.person);
      }
      if (ev.side === "hagi" || ev.side === "shiki" || ev.side === "memo") {
        const st = staffOf(ev.staffText, match, known, initial, ev.storeId);
        assigneeIds = [...new Set([...assigneeIds, ...st.ids])];
        unknown.push(...st.unknown);
        if (ev.kind === "leave") {
          const who = staffOf(ev.raw.replace(/有休|有給|公休|振休|代休|休み|お休|欠勤|特休|慶弔|午前|午後|AM|PM/gi, " "), match, known, initial, ev.storeId);
          assigneeIds = [...new Set([...assigneeIds, ...who.ids])];
        } else if (ev.side === "memo") {
          // 「社長 3450 オイル交換」「上原 4134 車検」: 先頭の名前が社員ならその人の予定
          const head = nk(ev.raw).split(" ")[0] ?? "";
          const hm = head.length >= 2 ? match(head) : undefined;
          if (hm?.userId && !assigneeIds.includes(hm.userId)) assigneeIds.push(hm.userId);
        }
      }
      unknown = [...new Set(unknown)];
      for (const u of unknown) {
        const cur = unknownCount.get(u) ?? { count: 0, example: `${ev.date.slice(5).replace("-", "/")} ${ev.raw.slice(0, 30)}` };
        cur.count++;
        unknownCount.set(u, cur);
      }
      const sid: StoreId = storeId ?? "hq";
      const item: PlanItem = { key: ev.key, ev, status: "add", storeId: sid, title: titleOf(ev), assigneeIds, unknownStaff: unknown };
      item.memo = memoOf(ev, unknown);
      // お客様の照合の単位 (地区があれば地区 + 名前 (店舗をまたぐ)。地区がなければ店舗 + 名前)
      if (ev.customerLike && ev.name && ev.kind !== "leave") {
        const gkey = ev.area ? `${foldArea(ev.area)}|${foldName(ev.name)}` : `${sid}||${foldName(ev.name)}`;
        item.gkey = gkey;
        const d = drafts.get(gkey) ?? { area: ev.area, name: ev.name, stores: [], keys: [] };
        d.stores.push(sid);
        d.keys.push(ev.key);
        drafts.set(gkey, d);
      }
      items.push(item);
    }
  }
  // 地区のない名前 (右上の予定の「清原邸」など) は、同じ名前の地区つきのお客様が 1 組だけならそちらにまとめる
  for (const [gkey, d] of [...drafts]) {
    if (d.area) continue;
    const name = foldName(d.name);
    const same = [...drafts].filter(([, x]) => x.area && foldName(x.name) === name);
    if (same.length !== 1) continue;
    const [tk, target] = same[0];
    target.stores.push(...d.stores);
    target.keys.push(...d.keys);
    for (const it of items) if (it.gkey === gkey) it.gkey = tk;
    drafts.delete(gkey);
  }
  for (const [gkey, d] of drafts) {
    // 店舗の欄の予定の店舗 (右上の予定・事務の欄だけなら、その人の店舗)
    const storeId = d.stores.find((x) => x !== "hq") ?? d.stores[0] ?? "hq";
    const g = makeGroup(db, idx, gkey, storeId, d.area, d.name);
    g.eventKeys.push(...d.keys);
    groups.set(gkey, g);
  }

  // 画面で選んだ顧客
  for (const g of groups.values()) {
    const pick = opts.picks?.[g.gkey];
    if (pick && (pick === "new" || pick === "none" || g.candidates.some((c) => c.id === pick))) g.choice = pick;
    const oc = g.choice !== "new" && g.choice !== "none" ? idx.openCase.get(g.choice) : undefined;
    g.caseRef = oc ? { kind: oc.kind, id: oc.id, label: oc.label } : undefined;
  }

  // 新システムに登録済みの同じ予定 (取り込まない) と、以前の取込の予定 (使い回す)
  const byDate = new Map<string, ScheduleEvent[]>();
  for (const e of db.schedule) if (e.date >= opts.from && e.date <= to) (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e);
  const isSheetEvent = (e: ScheduleEvent) => e.source === "import" && Boolean(e.sourceRef && (e.sourceRef.startsWith(SHEET_REF_PREFIX) || LEGACY_REF_RE.test(e.sourceRef)));
  // 新システムで変えた予定か: 取込で書いた予定は書いたときの印と比べ、以前の移行の予定は変更の記録 (updatedBy) で見る
  const written = settings.written ?? {};
  const editedInSystem = (e: ScheduleEvent) => (e.sourceRef?.startsWith(SHEET_REF_PREFIX) ? Boolean(written[e.id] && written[e.id] !== eventFingerprint(e)) : Boolean(e.updatedBy));
  const used = new Set<string>();
  const byRef = new Map<string, ScheduleEvent>();
  for (const e of db.schedule) if (e.sourceRef?.startsWith(SHEET_REF_PREFIX)) byRef.set(e.sourceRef.slice(SHEET_REF_PREFIX.length), e);
  // 以前の移行の予定: 件名「(地区) 名前 …」の地区と名前で見分ける (後ろの言葉は書き方が違うことがある)
  const nameKey = (text: string) => {
    const sp = splitName(text);
    return sp.name ? `${foldArea(sp.area)}|${foldName(sp.name)}` : fold(text);
  };
  const legacyKey = (date: string, storeId: string, kind: ScheduleKind, title: string) => `${date}|${storeId}|${family(kind)}|${nameKey(stripKindWords(title, kind).replace(/\(クレーム対応\)/, ""))}`;
  const legacy = new Map<string, ScheduleEvent[]>();
  for (const list of byDate.values())
    for (const e of list) {
      if (!isSheetEvent(e) || e.sourceRef!.startsWith(SHEET_REF_PREFIX)) continue;
      const k = legacyKey(e.date, e.storeId, e.kind, e.title);
      (legacy.get(k) ?? legacy.set(k, []).get(k)!).push(e);
    }

  for (const it of items) {
    const ev = it.ev;
    // 前回の取込 (同じ印) → 以前の移行 (同じ日・店舗・種類・名前)
    let prev = byRef.get(ev.key);
    if (prev && used.has(prev.id)) prev = undefined;
    if (!prev) prev = (legacy.get(legacyKey(ev.date, it.storeId, ev.kind, it.title)) ?? []).find((e) => !used.has(e.id));
    if (prev) {
      used.add(prev.id);
      it.eventId = prev.id;
      if (editedInSystem(prev)) {
        it.status = "kept";
        continue;
      }
      it.status = "update";
      continue;
    }
    // 新システムに登録済みの同じ予定 (取込の予定は除く)
    const sameDay = (byDate.get(ev.date) ?? []).filter((e) => !isSheetEvent(e) && !used.has(e.id));
    const name = ev.name ? foldName(ev.name) : "";
    const dup = ev.customerLike && name
      ? sameDay.find((e) => family(e.kind) === family(ev.kind) && (fold(e.title).includes(name) || (e.customerId && db.customers.find((c) => c.id === e.customerId && surnameOf(c.name) === name))))
      : sameDay.find((e) => fold(e.title) === fold(ev.raw) || fold(e.title) === fold(it.title));
    if (dup) {
      it.status = "duplicate";
      it.dupOf = { id: dup.id, title: dup.title };
    }
  }

  // 書き換える予定が今と同じなら「変更なし」
  for (const it of items) {
    if (it.status !== "update" || !it.eventId) continue;
    const e = db.schedule.find((x) => x.id === it.eventId)!;
    const next = eventFields(it, undefined);
    const same = e.title === next.title && e.kind === next.kind && e.date === next.date && (e.startTime ?? "") === (next.startTime ?? "") && (e.endTime ?? "") === (next.endTime ?? "") && (e.slot ?? "") === (next.slot ?? "") && e.storeId === next.storeId && (e.memo ?? "") === (next.memo ?? "") && e.sourceRef === next.sourceRef;
    if (same) it.status = "same";
  }

  // スプレッドシートからなくなった以前の取込の予定
  const remove: SheetPlan["remove"] = [];
  const keep: SheetPlan["keep"] = [];
  for (const list of byDate.values())
    for (const e of list) {
      if (!isSheetEvent(e) || used.has(e.id) || !inMonths(e.date)) continue;
      if (editedInSystem(e)) keep.push({ id: e.id, title: e.title, date: e.date, reason: "新システムで変更された予定のため残します" });
      else remove.push({ id: e.id, title: e.title, date: e.date, storeId: e.storeId });
    }
  remove.sort((a, b) => a.date.localeCompare(b.date));

  const gl = [...groups.values()];
  const live = (g: PlanGroup) => g.eventKeys.some((k) => items.find((i) => i.key === k && (i.status === "add" || i.status === "update")));
  const counts: SheetPlan["counts"] = {
    add: items.filter((i) => i.status === "add").length,
    update: items.filter((i) => i.status === "update").length,
    same: items.filter((i) => i.status === "same").length,
    duplicate: items.filter((i) => i.status === "duplicate").length,
    kept: items.filter((i) => i.status === "kept").length,
    remove: remove.length,
    newCustomers: gl.filter((g) => g.choice === "new" && live(g)).length,
    linkedCustomers: gl.filter((g) => g.choice !== "new" && g.choice !== "none" && live(g)).length,
    newCases: gl.filter((g) => g.choice !== "none" && !g.caseRef && live(g)).length,
    linkedCases: gl.filter((g) => g.caseRef && live(g)).length,
    ambiguous: gl.filter((g) => g.ambiguous && live(g)).length,
    noCustomer: gl.filter((g) => g.choice === "none" && live(g)).length,
  };
  return {
    from: opts.from,
    to,
    months: monthRanges.map(({ m, first, last }) => ({ label: m.label, first: first < opts.from ? opts.from : first, last, days: m.days.length, events: m.events.filter((e) => e.date >= opts.from).length })),
    items,
    groups: gl,
    remove,
    keep,
    unknownNames: [...unknownCount].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    persons: [...personUse].map(([name, count]) => {
      const pm = match(name);
      return { name, count, userId: pm.userId, userName: pm.userId ? userById.get(pm.userId)?.name : undefined };
    }),
    counts,
  };
}

function makeGroup(db: Database, idx: ReturnType<typeof customerIndex>, gkey: string, storeId: StoreId, area: string | undefined, name: string): PlanGroup {
  const key = foldName(name);
  let list = idx.bySurname.get(key) ?? [];
  if (area) list = list.filter((c) => areaMatches(area, c));
  else if (storeId !== "hq") list = list.filter((c) => c.storeId === storeId);
  const today = new Date().toISOString().slice(0, 10);
  const scored = list
    .map((c) => {
      const oc = idx.openCase.get(c.id);
      const last = idx.last.get(c.id);
      const days = last ? Math.max(0, (Date.parse(today) - Date.parse(last)) / 864e5) : 9999;
      let score = 0;
      if (oc) score += 100;
      score += Math.max(0, 60 - days / 12);
      if (c.storeId === storeId) score += 15;
      if (area && foldArea(c.area) === foldArea(area)) score += 10;
      if (foldName(c.name) === key) score += 3;
      if (c.phone) score += 5;
      if (c.tradeStopped) score -= 50;
      const where = [c.area, nk(c.address).slice(0, 24)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" ");
      return { id: c.id, label: `${c.code} ${c.name}${where ? ` (${where})` : ""}`, openCase: oc?.label, last, score: Math.round(score) } satisfies CustomerChoice;
    })
    .sort((a, b) => b.score - a.score || (b.last ?? "").localeCompare(a.last ?? ""));
  const top = scored[0];
  const ambiguous = scored.length > 1 && top.score - scored[1].score < 40;
  const auto = top ? top.id : "new";
  return { gkey, storeId, area, name, candidates: scored.slice(0, 8), auto, choice: auto, ambiguous, eventKeys: [] };
}

/** 予定の項目 (案件のつながりは apply で入れる) */
function eventFields(it: PlanItem, links: { customerId?: string; inquiryId?: string; quoteId?: string; orderId?: string } | undefined) {
  const ev = it.ev;
  return {
    title: it.title,
    kind: ev.kind,
    date: ev.date,
    startTime: ev.startTime,
    endTime: ev.startTime ? ev.endTime : undefined,
    slot: ev.startTime ? undefined : ev.slot,
    storeId: it.storeId,
    location: ev.area || undefined,
    memo: it.memo,
    source: "import" as const,
    sourceRef: `${SHEET_REF_PREFIX}${ev.key}`,
    ...(links ?? {}),
  };
}

const CATEGORY_WORDS: [RegExp, ServiceCategory][] = [
  [/クロス|壁紙|フローリング|床|工事|リフォーム|塗装|大工|内装/, "cloth"],
  [/カーテン|ブラインド|ロールスクリーン/, "curtain"],
];

function categoryOf(evs: SheetEvent[]): ServiceCategory {
  const sum = (i: number) => evs.reduce((a, e) => a + (e.counts[i] ?? 0) + (e.counts[i + 1] ?? 0), 0);
  if (sum(0)) return "tatami";
  if (sum(2)) return "fusuma";
  if (sum(4)) return "shoji";
  if (sum(6)) return "amido";
  const text = evs.map((e) => `${e.raw} ${e.remark ?? ""} ${e.extra ?? ""}`).join(" ");
  return CATEGORY_WORDS.find(([re]) => re.test(text))?.[1] ?? "other";
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export interface SheetApplyResult {
  added: number;
  updated: number;
  removed: number;
  newCustomers: number;
  newCases: number;
  summary: string;
}

/**
 * 計画を書き込む (mutate の中で、同じ db で作り直した計画を渡す)。
 * 顧客・問い合わせの登録 → 予定の追加・書き換え → なくなった予定の削除 (変更履歴つき) → 取込の記録
 */
export function applySheetImport(db: Database, plan: SheetPlan, user: Pick<User, "id">, label: string): SheetApplyResult {
  const now = nowIso();
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const live = (g: PlanGroup) => g.eventKeys.some((k) => {
    const s = byKey.get(k)?.status;
    return s === "add" || s === "update";
  });
  const links = new Map<string, { customerId?: string; inquiryId?: string; quoteId?: string; orderId?: string }>();
  const written: Record<string, string> = { ...(sheetSettings(db).written ?? {}) };
  let newCustomers = 0;
  let newCases = 0;
  for (const g of plan.groups) {
    if (!live(g) || g.choice === "none") continue;
    let customer: Customer | undefined = g.choice === "new" ? undefined : db.customers.find((c) => c.id === g.choice);
    if (!customer) {
      customer = {
        id: newId("cust"),
        code: nextCustomerCode(db),
        name: g.name,
        kana: "",
        type: /株式会社|有限会社|\(株\)|\(有\)|工務|建設|建築|ハウス|不動産|設計|商店|事務所/.test(g.name) ? "corporate" : "individual",
        phone: "",
        postalCode: "",
        address: g.area ?? "",
        ...(g.area ? { area: g.area } : {}),
        storeId: g.storeId,
        preferredChannel: "phone",
        firstContactChannel: "unknown",
        tags: ["予定表から登録"],
        notes: "予定表 (スプレッドシート) から移行して登録しました。電話番号・住所は未登録です (予定表には地区とお名前だけ)。",
        createdAt: now,
        updatedAt: now,
      };
      db.customers.push(customer);
      newCustomers++;
      addAudit(db, { userId: user.id, action: "create", entity: "customer", entityId: customer.id, entityLabel: `${customer.code} ${customer.name}`, summary: `予定表 (スプレッドシート) の取込で顧客を登録 (${g.area ? `${g.area} ` : ""}${customer.name})`, storeId: customer.storeId });
    }
    const link: { customerId?: string; inquiryId?: string; quoteId?: string; orderId?: string } = { customerId: customer.id };
    const ref = g.choice === "new" ? undefined : g.caseRef;
    if (ref?.kind === "order") {
      const o = db.orders.find((x) => x.id === ref.id);
      if (o) {
        link.orderId = o.id;
        link.quoteId = o.quoteId;
        link.inquiryId = o.quoteId ? db.quotes.find((q) => q.id === o.quoteId)?.inquiryId : undefined;
      }
    } else if (ref?.kind === "inquiry") {
      const q = db.inquiries.find((x) => x.id === ref.id);
      if (q) {
        link.inquiryId = q.id;
        link.quoteId = q.quoteId;
      }
    }
    if (!link.inquiryId && !link.orderId) {
      // 新しい案件 (問い合わせ)。予定表には金額がないため、見積 → 受注は今までどおり問い合わせから
      const evs = g.eventKeys.map((k) => byKey.get(k)!).filter((i) => i && (i.status === "add" || i.status === "update")).map((i) => i.ev).sort((a, b) => a.date.localeCompare(b.date));
      const counts = [...new Set(evs.map((e) => e.countText).filter(Boolean))];
      const inq: Inquiry = {
        id: newId("inq"),
        number: nextNumber(db, "INQ", db.inquiries, toDateKey(new Date())),
        customerId: customer.id,
        contactName: customer.name,
        contactPhone: customer.phone || undefined,
        channel: "unknown",
        storeId: g.storeId,
        category: categoryOf(evs),
        summary: `${counts[0] ?? evs.map((e) => SCHEDULE_KIND[e.kind].label).filter((v, i, a) => a.indexOf(v) === i).join("・")} (予定表から移行)`.slice(0, 120),
        detail: ["予定表 (スプレッドシート) の予定から登録した案件です。", ...evs.map((e) => `${md(e.date)} ${SCHEDULE_KIND[e.kind].label}${e.startTime ? ` ${e.startTime}` : e.slot === "pm" ? " 午後" : " 午前"} ${e.countText}${e.remark ? ` (${e.remark})` : ""}`.trim())].join("\n").slice(0, 2000),
        status: "in_progress",
        receivedAt: now,
        createdBy: user.id,
        updatedAt: now,
        ...(g.area ? { area: g.area } : {}),
        source: "import",
        sourceRef: `${SHEET_REF_PREFIX}case:${g.gkey}`,
      };
      db.inquiries.push(inq);
      newCases++;
      link.inquiryId = inq.id;
      addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `予定表 (スプレッドシート) の取込で案件 (問い合わせ) を登録 (${customer.name} / ${inq.summary})`, storeId: g.storeId });
    }
    links.set(g.gkey, link);
  }

  let added = 0;
  let updated = 0;
  for (const it of plan.items) {
    if (it.status !== "add" && it.status !== "update") continue;
    const link = it.gkey ? links.get(it.gkey) : undefined;
    const fields = eventFields(it, link);
    if (it.status === "update" && it.eventId) {
      const e = db.schedule.find((x) => x.id === it.eventId);
      if (!e) continue;
      const keepAssignees = !it.assigneeIds.length && e.assigneeIds.length ? e.assigneeIds : it.assigneeIds;
      // ひも付けを選び直さなかったとき (照合なし) は今のひも付けを残す
      const prevLinks = { customerId: e.customerId, inquiryId: e.inquiryId, quoteId: e.quoteId, orderId: e.orderId };
      Object.assign(e, fields, link ? {} : prevLinks, { assigneeIds: keepAssignees, updatedBy: user.id, updatedAt: now });
      for (const k of ["startTime", "endTime", "slot", "location", "memo", "customerId", "inquiryId", "quoteId", "orderId"] as const) if (e[k] === undefined) delete e[k];
      written[e.id] = eventFingerprint(e);
      updated++;
      continue;
    }
    const ev: ScheduleEvent = { id: newId("ev"), ...fields, assigneeIds: it.assigneeIds, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now };
    for (const k of ["startTime", "endTime", "slot", "location", "memo", "customerId", "inquiryId", "quoteId", "orderId"] as const) if (ev[k] === undefined) delete ev[k];
    db.schedule.push(ev);
    written[ev.id] = eventFingerprint(ev);
    added++;
  }

  // スプレッドシートからなくなった、以前に取り込んだ予定
  const drop = new Set(plan.remove.map((r) => r.id));
  if (drop.size) {
    const gone = db.schedule.filter((e) => drop.has(e.id));
    db.schedule = db.schedule.filter((e) => !drop.has(e.id));
    db.resourceBookings = (db.resourceBookings ?? []).filter((b) => !b.eventId || !drop.has(b.eventId));
    for (const j of db.productionJobs ?? []) if (j.pickupEventId && drop.has(j.pickupEventId) && j.status === "planned") Object.assign(j, { status: "cancelled", updatedBy: user.id, updatedAt: now, note: [j.note, "予定表の取込で引き取りの予定がなくなったため取りやめ"].filter(Boolean).join(" / ") });
    db.jobSpecs = (db.jobSpecs ?? []).filter((s) => !(s.recordType === "event" && drop.has(s.recordId)));
    for (const e of gone) {
      addAudit(db, {
        userId: user.id,
        action: "delete",
        entity: "schedule",
        entityId: e.id,
        entityLabel: e.title,
        summary: `予定表 (スプレッドシート) の取込: スプレッドシートにない予定を削除 (${md(e.date)} ${SCHEDULE_KIND[e.kind]?.label ?? e.kind})`,
        storeId: e.storeId,
        changes: [
          { field: "date", before: e.date, after: null },
          { field: "kind", before: e.kind, after: null },
          { field: "assigneeIds", before: e.assigneeIds, after: null },
        ],
      });
    }
  }

  const summary = `予定 追加 ${added} 件・書き換え ${updated} 件・削除 ${drop.size} 件 / 登録済みのため取り込まない ${plan.counts.duplicate} 件 / 新しい顧客 ${newCustomers} 件・新しい案件 ${newCases} 件 (${md(plan.from)}〜${md(plan.to)})`;
  addAudit(db, { userId: user.id, action: "import", entity: "schedule", entityId: SHEET_SETTINGS_ID, entityLabel: "予定表 (スプレッドシート) の取込", summary: `${label}: ${summary}`, storeId: "hq" });
  const s = sheetSettings(db);
  s.lastImport = { at: now, by: user.id, label, from: plan.from, to: plan.to, summary };
  // 印は今ある取込の予定の分だけ残す
  const alive = new Set(db.schedule.filter((e) => e.sourceRef?.startsWith(SHEET_REF_PREFIX)).map((e) => e.id));
  s.written = Object.fromEntries(Object.entries(written).filter(([id]) => alive.has(id)));
  writeSheetSettings(db, s, user.id);
  return { added, updated, removed: drop.size, newCustomers, newCases, summary };
}
