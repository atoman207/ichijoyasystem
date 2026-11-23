import type { Database, Material, Message, StockMove, StoreId, Thread, User } from "@/lib/db/types";
import type { HeriOp } from "@/lib/auth/permissions";
import { isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { addAudit, nextNumber, newId, nowIso } from "@/lib/db/store";
import { averageCost, locStore, postMove, reverseMove, stockBalances } from "@/lib/mgmt/stock";
import { costAt } from "@/lib/mgmt/costing";
import { closedReason } from "@/lib/mgmt/close";
import { round4 } from "@/lib/mgmt/decimal";
import { normKey } from "@/lib/office";
import { readXlsx } from "@/lib/xlsx";
import { decodeCsv, parseCsv } from "@/lib/csv";

/**
 * 縁在庫 (畳縁の品番 × 場所の数量)
 * ------------------------------------------------------------
 * - 管理会計の材料マスタ (materials の kind = heri) と在庫の移動 (stock_moves) をそのまま使う。新しい表は作らない
 *   (材料マスタに 規定量 reorderLevel・発注先 supplierId・シリーズ series・通常ヘリ lineup を足しただけ)
 * - 場所: 共通在庫 = store:hq (本部)、各店 = store:<店舗 ID>。操作と在庫の移動の対応:
 *   入庫 = 受入 (supplier → 場所) / 振り分け = 移動 (場所 → 場所) / 使用 = 使用 (場所 → 案件 order:<受注 ID>、案件の指定がなければ used) /
 *   棚卸 = 数えた数量と今の数量の差を 棚卸の調整 (adjust → 場所 か 場所 → adjust)
 * - この画面では原価・単価・金額を入力も表示もしない (社外秘)。移動の単価は管理会計と同じ順に自動で入れる
 *   (移動元の在庫の平均 → その日の原価単価 → 0)。縁在庫表の取込は数量だけ (単価 0。管理会計の損益に入れない)
 * - 規定量は共通在庫の数量と比べる (F-12: 共通在庫が規定量を下回ると通知)。操作で下回ったときだけ、
 *   社内連絡 (本部スタッフと、操作した店舗の店長へのメンション) で知らせる (heriAlertNotice)
 * - 月次確定した月の日付には登録しない (管理会計の close.ts)
 */

export const COMMON_LOC = "store:hq";
/** 案件を指定しない使用の行き先 */
export const USED_LOC = "used";

export const HERI_OP_LABEL: Record<HeriOp, string> = { receive: "入庫", transfer: "振り分け", use: "使用", count: "棚卸" };
export const HERI_ALERT_TITLE = "縁の共通在庫が規定量を下回りました";

const storeLoc = (id: string) => `store:${id}`;

/** 品番の並び (数字は数の順) */
const collator = new Intl.Collator("ja", { numeric: true });

/** 縁の材料 (シリーズ → 品番の順) */
export function heriMaterials(db: Pick<Database, "materials">, opts: { includeInactive?: boolean } = {}): Material[] {
  return (db.materials ?? [])
    .filter((m) => m.kind === "heri" && (opts.includeInactive || m.active))
    .sort((a, b) => collator.compare(a.series ?? "", b.series ?? "") || collator.compare(a.supplierCode ?? a.name, b.supplierCode ?? b.name));
}

/** シリーズと品番の表示 (「その他」「通常ヘリ」のシリーズと、品番がシリーズ名と同じものは品番だけ) */
export function heriName(series: string | undefined, no: string): string {
  const s = (series ?? "").trim();
  return s && s !== "その他" && s !== "通常ヘリ" && s !== no ? `${s} ${no}` : no;
}

/** 表示する品番 (シリーズ + 品番。品番がなければ名前) */
export function heriLabel(m: Pick<Material, "name" | "series" | "supplierCode">): string {
  return m.supplierCode ? heriName(m.series, m.supplierCode) : m.name;
}

/** 材料のコード (シリーズと品番から決める。取込のときに同じ品番を見つけるのに使う) */
export function heriCode(series: string, no: string): string {
  const k = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toUpperCase();
  return `HERI-${k(series) || "その他"}-${k(no)}`.slice(0, 40);
}

/** 場所の一覧 (共通在庫 → 各店。閉鎖した店舗は除く) */
export function heriLocations(db: Pick<Database, "stores">): { loc: string; label: string; storeId: string }[] {
  const stores = (db.stores ?? []).filter((s) => !s.closedOn);
  const hq = stores.find((s) => s.id === "hq");
  return [
    { loc: COMMON_LOC, label: `共通在庫 (${hq?.shortName ?? "本部"})`, storeId: "hq" },
    ...stores.filter((s) => s.id !== "hq").map((s) => ({ loc: storeLoc(s.id), label: s.name, storeId: s.id })),
  ];
}

export function heriLocLabel(db: Pick<Database, "stores" | "orders">, loc: string | undefined): string {
  if (!loc) return "-";
  if (loc === COMMON_LOC) return heriLocations(db)[0].label;
  if (loc === USED_LOC) return "使用 (案件の指定なし)";
  if (loc === "supplier") return "仕入先";
  if (loc === "adjust") return "棚卸の差";
  if (loc.startsWith("order:")) return `案件 ${(db.orders ?? []).find((o) => o.id === loc.slice(6))?.number ?? loc.slice(6)}`;
  const id = locStore(loc);
  return (db.stores ?? []).find((s) => s.id === id)?.name ?? loc;
}

export interface HeriRow {
  material: Material;
  /** 店舗 ID → 数量 */
  byStore: Record<string, number>;
  /** 共通在庫の数量 */
  common: number;
  total: number;
  /** 在庫の記録がある (確定した移動が 1 件以上) */
  hasRecord: boolean;
  /** 共通在庫が規定量を下回っている */
  below: boolean;
}

/** 品番ごとの在庫 (確定した移動から数える。申請中の移動は数えない) */
export function heriRows(db: Pick<Database, "materials" | "stockMoves">, opts: { includeInactive?: boolean; asOf?: string } = {}): HeriRow[] {
  const mats = heriMaterials(db, opts);
  const ids = new Set(mats.map((m) => m.id));
  const bal = new Map<string, Record<string, number>>();
  for (const b of stockBalances(db, opts.asOf)) {
    if (!ids.has(b.materialId)) continue;
    const r = bal.get(b.materialId) ?? bal.set(b.materialId, {}).get(b.materialId)!;
    r[b.storeId] = round4((r[b.storeId] ?? 0) + b.qty);
  }
  const touched = new Set((db.stockMoves ?? []).filter((m) => m.status !== "draft" && ids.has(m.materialId)).map((m) => m.materialId));
  return mats.map((m) => {
    const byStore = bal.get(m.id) ?? {};
    const common = byStore.hq ?? 0;
    const total = round4(Object.values(byStore).reduce((a, b) => a + b, 0));
    return { material: m, byStore, common, total, hasRecord: touched.has(m.id), below: m.reorderLevel !== undefined && m.reorderLevel !== null && common < m.reorderLevel };
  });
}

/** 共通在庫が規定量を下回っている品番 */
export function heriBelow(db: Pick<Database, "materials" | "stockMoves">): HeriRow[] {
  return heriRows(db).filter((r) => r.below);
}

/** ある場所の数量 (確定した移動。date の日まで) */
export function heriQty(db: Pick<Database, "stockMoves">, materialId: string, loc: string, asOf?: string): number {
  const id = locStore(loc);
  return stockBalances(db, asOf).find((b) => b.materialId === materialId && b.storeId === id)?.qty ?? 0;
}

/** 移動の単価 (画面には出さない): 移動元の在庫の平均 → その日の原価単価 → 0 */
function silentUnitCost(db: Database, materialId: string, loc: string | undefined, date: string): number {
  const store = locStore(loc);
  return (store ? averageCost(db, store, materialId, date) : undefined) ?? costAt(db, materialId, date)?.unitCost ?? 0;
}

export interface HeriOpInput {
  op: HeriOp;
  materialId: string;
  /** 入庫・振り分け・使用は動かす数量、棚卸は数えた数量 */
  qty: number;
  date: string;
  from?: string;
  to?: string;
  orderId?: string;
  note?: string;
}

export interface HeriAlert {
  materialId: string;
  label: string;
  before: number;
  after: number;
  level: number;
  unit: string;
}

export interface HeriOpResult {
  move?: StockMove;
  message: string;
  alert?: HeriAlert;
}

const validLoc = (db: Pick<Database, "stores">, loc: string | undefined) => Boolean(loc?.startsWith("store:") && db.stores.some((s) => s.id === loc.slice(6) && !s.closedOn));

/**
 * 縁の数量を登録する (mutate の中で呼ぶ)。誤りは理由の文字列を返す (何も書き込まない)。
 * 権限 (canRecordHeriMove) は呼び出し側で確かめる
 */
export function recordHeriOp(db: Database, user: Pick<User, "id">, input: HeriOpInput, now = nowIso()): HeriOpResult | string {
  const m = db.materials.find((x) => x.id === input.materialId && x.kind === "heri");
  if (!m) return "縁の品番を選んでください。";
  if (!m.active && input.op !== "count") return `${heriLabel(m)} は使わない品番になっています (品番の設定で「使う」に戻してください)。`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return "日付を入力してください。";
  if (!Number.isFinite(input.qty) || (input.op === "count" ? input.qty < 0 : input.qty <= 0)) return input.op === "count" ? "数えた数量を 0 以上の数で入力してください。" : "数量は 0 より大きい数で入力してください。";
  if (round4(input.qty) !== input.qty) return "数量は小数 4 桁までで入力してください。";
  const closed = closedReason(db, input.date, "縁の登録");
  if (closed) return closed;
  const unit = m.unit || "帖";
  const label = heriLabel(m);
  let kind: StockMove["kind"];
  let fromLoc: string | undefined;
  let toLoc: string | undefined;
  let qty = input.qty;
  let detail = "";
  let where = "";
  switch (input.op) {
    case "receive":
      kind = "receive";
      fromLoc = "supplier";
      toLoc = input.to || COMMON_LOC;
      if (!validLoc(db, toLoc)) return "入庫する場所を選んでください。";
      where = heriLocLabel(db, toLoc);
      break;
    case "transfer":
      kind = "transfer";
      fromLoc = input.from || COMMON_LOC;
      toLoc = input.to;
      if (!validLoc(db, fromLoc) || !validLoc(db, toLoc)) return "振り分けの元と先の場所を選んでください。";
      if (fromLoc === toLoc) return "振り分けの元と先が同じ場所です。";
      where = `${heriLocLabel(db, fromLoc)} → ${heriLocLabel(db, toLoc)}`;
      break;
    case "use":
      kind = "use";
      fromLoc = input.from || COMMON_LOC;
      if (!validLoc(db, fromLoc)) return "使用した在庫の場所を選んでください。";
      if (input.orderId && !db.orders.some((o) => o.id === input.orderId)) return "案件 (受注) が見つかりません。";
      toLoc = input.orderId ? `order:${input.orderId}` : USED_LOC;
      where = `${heriLocLabel(db, fromLoc)} から${input.orderId ? `・${heriLocLabel(db, toLoc)}` : ""}`;
      break;
    case "count": {
      const loc = input.to || COMMON_LOC;
      if (!validLoc(db, loc)) return "棚卸の場所を選んでください。";
      const current = heriQty(db, m.id, loc, input.date);
      const diff = round4(input.qty - current);
      if (diff === 0) return { message: `${label} (${heriLocLabel(db, loc)}) は ${current} ${unit} のままです (変更なし)。` };
      kind = "adjust";
      [fromLoc, toLoc] = diff > 0 ? ["adjust", loc] : [loc, "adjust"];
      qty = Math.abs(diff);
      detail = `数えた数量 ${input.qty} ${unit} (前 ${current} ${unit})`;
      where = heriLocLabel(db, loc);
      break;
    }
    default:
      return "操作の種類を選んでください。";
  }
  // 出す側の在庫が足りるか (マイナスの在庫にしない)
  if (kind !== "receive" && kind !== "adjust") {
    // その日の数量と今の数量の少ない方 (後の日付の使用と合わせてマイナスにならないように)
    const have = Math.min(heriQty(db, m.id, fromLoc!, input.date), heriQty(db, m.id, fromLoc!));
    if (qty > have) return `${heriLocLabel(db, fromLoc)} の ${label} は ${have} ${unit} です。それより多い数量は登録できません (先に入庫・振り分け・棚卸で数量を合わせてください)。`;
  }
  const commonBefore = heriQty(db, m.id, COMMON_LOC);
  const unitCost = input.op === "receive" ? (costAt(db, m.id, input.date)?.unitCost ?? 0) : silentUnitCost(db, m.id, kind === "adjust" && fromLoc === "adjust" ? toLoc : fromLoc, input.date);
  const note = [`縁在庫の${HERI_OP_LABEL[input.op]}`, detail, input.note?.trim()].filter(Boolean).join(": ").slice(0, 200);
  const move = postMove(db, { id: newId("sm"), number: nextNumber(db, "SM", db.stockMoves, input.date), date: input.date, kind, materialId: m.id, qty, unitCost, fromLoc, toLoc, orderId: input.orderId, note, status: "confirmed", createdBy: user.id, createdAt: now });
  const commonAfter = heriQty(db, m.id, COMMON_LOC);
  const level = m.reorderLevel;
  const alert = level !== undefined && level !== null && commonBefore >= level && commonAfter < level ? { materialId: m.id, label, before: commonBefore, after: commonAfter, level, unit } : undefined;
  const message = input.op === "count" ? `${label} の棚卸を登録しました (${where}: ${detail})。` : `${label} の${HERI_OP_LABEL[input.op]} ${qty} ${unit} を登録しました (${where})。`;
  addAudit(db, { userId: user.id, action: "create", entity: "stock_move", entityId: move.id, entityLabel: move.number, summary: `縁在庫の${HERI_OP_LABEL[input.op]}: ${label} ${input.op === "count" ? detail : `${qty} ${unit}`} ${heriLocLabel(db, fromLoc)} → ${heriLocLabel(db, toLoc)}`, storeId: move.storeId });
  return { move, message, alert };
}

/** 縁の移動を取り消す (逆向きの行を足す)。誤りは理由 */
export function reverseHeriMove(db: Database, user: Pick<User, "id">, moveId: string, reason: string, today: string): { move: StockMove; alert?: HeriAlert } | string {
  const m = db.stockMoves.find((x) => x.id === moveId);
  const mat = m ? db.materials.find((x) => x.id === m.materialId) : undefined;
  if (!m || mat?.kind !== "heri") return "縁の登録が見つかりません。";
  if (!reason.trim()) return "取消しの理由を入力してください。";
  // 戻すと出す側 (元の移動先) がマイナスになる取消しは断る
  const back = m.toLoc?.startsWith("store:") ? heriQty(db, m.materialId, m.toLoc) : Infinity;
  if (m.status === "confirmed" && !m.reversalOf && m.qty > back) return `${heriLocLabel(db, m.toLoc)} の在庫 (${back}) より多いため取り消せません。先に棚卸で数量を合わせてください。`;
  const before = heriQty(db, m.materialId, COMMON_LOC);
  const r = reverseMove(db, m, { id: newId("sm"), number: nextNumber(db, "SM", db.stockMoves, today), userId: user.id, now: nowIso(), today, reason: reason.trim().slice(0, 150) });
  if (typeof r === "string") return r;
  const after = heriQty(db, m.materialId, COMMON_LOC);
  const level = mat.reorderLevel;
  addAudit(db, { userId: user.id, action: "update", entity: "stock_move", entityId: m.id, entityLabel: m.number, summary: `縁在庫の登録を取消し (${heriLabel(mat)}): ${reason.trim().slice(0, 100)}`, storeId: m.storeId, changes: [{ field: "status", before: "confirmed", after: "reversed" }] });
  return { move: r, alert: level !== undefined && level !== null && before >= level && after < level ? { materialId: mat.id, label: heriLabel(mat), before, after, level, unit: mat.unit || "帖" } : undefined };
}

/* ================================================================== */
/* 規定量を下回ったときの社内連絡                                            */
/* ================================================================== */

/**
 * 通知の宛先: 本部スタッフと、操作にかかわる店舗 (操作した人の所属・振り分けの元と先) の店長。
 * だれもいなければ管理者。操作した本人・確認用アカウントは除き、操作した人と同じ種類 (社員 / デモ用) だけ
 */
export function heriAlertRecipients(db: Pick<Database, "users">, actor: Pick<User, "id" | "email" | "storeId" | "role">, stores: string[]): User[] {
  const demo = isDemoAccount(actor);
  const pool = db.users.filter((u) => u.active && u.id !== actor.id && !isReviewAccount(u) && isDemoAccount(u) === demo);
  const involved = new Set([...stores, ...(actor.role === "store_manager" || actor.role === "store_staff" ? [actor.storeId] : [])].filter((s) => s && s !== "hq"));
  const to = pool.filter((u) => u.role === "hq_staff" || (u.role === "store_manager" && involved.has(u.storeId)));
  return to.length ? to : pool.filter((u) => u.role === "admin");
}

/**
 * 規定量を下回ったことを社内連絡に書く (mutate の中で呼ぶ)。開いている同じ件名のスレッドがあれば返信として足す。
 * 返り値のスレッドとメッセージで、保存の後に mentionNotices → sendAndRecord (メール・Chatwork は各自の設定のとき) を呼ぶ
 */
export function heriAlertNotice(db: Database, actor: User, alerts: HeriAlert[], stores: string[], now = nowIso()): { thread: Thread; message: Message } | undefined {
  if (!alerts.length) return undefined;
  const to = heriAlertRecipients(db, actor, stores);
  const lines = alerts.map((a) => `・${a.label}: 共通在庫 ${a.after} ${a.unit} (規定量 ${a.level} ${a.unit}・操作の前 ${a.before} ${a.unit})`);
  const body = `${actor.name} さんの登録で、縁の共通在庫が規定量を下回りました。発注を確認してください。\n${lines.join("\n")}\n縁在庫の画面: /heri?low=1`;
  let th = db.threads.find((x) => x.status === "open" && x.title === HERI_ALERT_TITLE && x.storeId === "hq");
  const mentions = to.map((u) => u.id);
  if (!th) {
    th = { id: newId("th"), title: HERI_ALERT_TITLE, kind: "notice", storeId: "hq" as StoreId, createdBy: actor.id, participants: [...new Set([actor.id, ...mentions])], status: "open", createdAt: now, updatedAt: now };
    db.threads.push(th);
    addAudit(db, { userId: actor.id, action: "create", entity: "thread", entityId: th.id, entityLabel: th.title, summary: `縁の共通在庫が規定量を下回ったことを通知 (${alerts.map((a) => a.label).join("・")} / 宛先: ${to.map((u) => u.name).join("・") || "なし"})`, storeId: "hq" });
  } else {
    th.participants = [...new Set([...th.participants, actor.id, ...mentions])];
    th.updatedAt = now;
    addAudit(db, { userId: actor.id, action: "update", entity: "thread", entityId: th.id, entityLabel: th.title, summary: `縁の共通在庫が規定量を下回ったことを通知 (${alerts.map((a) => a.label).join("・")})`, storeId: "hq" });
  }
  const message: Message = { id: newId("msg"), threadId: th.id, userId: actor.id, body, at: now, mentions };
  db.messages.push(message);
  return { thread: th, message };
}

/* ================================================================== */
/* 縁在庫表 (.xlsx・CSV) の取込                                            */
/* ================================================================== */

export interface HeriSheetItem {
  series: string;
  no: string;
  /** 数量 (帖)。ラインナップのシートは数量なし */
  qty?: number;
  memo?: string;
  lineup?: boolean;
  /** シート名とセル (確認用) */
  ref: string;
}

/** セルの文字 (全角半角・空白をそろえ、Excel の整数の 410.0 は 410 にする) */
const tx = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().replace(/^(-?\d+)\.0+$/, "$1");
const isQty = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

/** ラインナップの名前 (例: 織部No.8・アラベスクV No.510・浮 13・綿 金黒・マス菊) → シリーズと品番 */
export function splitLineupName(name: string): { series: string; no: string } {
  const v = tx(name);
  let m = v.match(/^(.*?)\s*No\.?\s*(\S+)$/i);
  if (m && m[1]) return { series: m[1].trim(), no: m[2] };
  m = v.match(/^(.*?\D)\s*(\d+)$/);
  if (m) return { series: m[1].trim(), no: m[2] };
  m = v.match(/^(\S+)\s+(.+)$/);
  if (m) return { series: m[1], no: m[2] };
  return { series: "通常ヘリ", no: v };
}

/**
 * 縁在庫表 (.xlsx) を読む。シートごとに「シリーズ名 | 在庫が少ない物は…」の行の下に「品番 | 帖」の見出しと品番ごとの数量がある。
 * 右側の列の書き込み (引当・注意) はメモ。ラインナップのシート (名前に「ラインナップ」、または「品番」の見出しがなく価格 ¥ の列があるシート。
 * 通常ヘリ ラインナップ.xlsx) は品番の名前だけ (数量なし。価格は読まない)
 */
export function parseHeriWorkbook(buf: Buffer): HeriSheetItem[] {
  const items: HeriSheetItem[] = [];
  for (const sheet of readXlsx(buf)) {
    const name = sheet.name.trim();
    const rows = [...sheet.rows].sort((a, b) => a[0] - b[0]);
    const hasHeader = rows.some(([, c]) => tx(c.get("A")) === "品番");
    const hasPrice = rows.some(([, c]) => [...c.values()].some((v) => /^[¥￥\\]\s*[\d,]+$/.test(tx(v))));
    if (/ラインナップ/.test(name) || (!hasHeader && hasPrice)) {
      for (const [r, cols] of rows) {
        for (const [col, raw] of cols) {
          const v = tx(raw);
          if (!v || /^[¥￥\\]/.test(v) || isQty(v.replace(/,/g, "")) || /ラインナップ|在庫が少ない/.test(v)) continue;
          const { series, no } = splitLineupName(v);
          items.push({ series, no, lineup: true, ref: `${name}!${col}${r}` });
        }
      }
      continue;
    }
    let series = "";
    let qtyCol = "B";
    let noCol = "A";
    rows.forEach(([r, cols], i) => {
      const a = tx(cols.get("A"));
      const next = rows[i + 1]?.[1];
      // シリーズの見出し: B 列に「在庫が少ない…」、または次の行が「品番」
      if (a && a !== "品番" && (/在庫が少ない/.test(tx(cols.get("B"))) || tx(next?.get("A")) === "品番")) {
        series = a;
        return;
      }
      if (a === "品番") {
        for (const [col, v] of cols) {
          if (/帖|数量|在庫/.test(tx(v))) qtyCol = col;
          if (tx(v) === "品番") noCol = col;
        }
        return;
      }
      const no = tx(cols.get(noCol));
      const q = tx(cols.get(qtyCol)).replace(/,/g, "");
      if (!series || !no || !isQty(q)) return;
      const memo = [...cols].filter(([col]) => col !== noCol && col !== qtyCol).map(([, v]) => tx(v)).filter(Boolean).join(" / ");
      items.push({ series, no, qty: Number(q), memo: memo || undefined, ref: `${name}!${noCol}${r}` });
    });
  }
  return items;
}

/** CSV (縁在庫の書き出しと同じ見出し: シリーズ・品番・共通在庫 (または 数量)・メモ) を読む */
export function parseHeriCsv(text: string): HeriSheetItem[] | string {
  const table = parseCsv(text);
  const head = (table[0] ?? []).map((h) => normKey(h));
  const col = (...names: string[]) => head.findIndex((h) => names.map(normKey).includes(h));
  const iNo = col("品番", "品名", "名前");
  const iSeries = col("シリーズ", "柄", "種類");
  const iQty = col("共通在庫", "数量", "帖", "在庫");
  const iMemo = col("メモ", "備考");
  const iLineup = col("通常ヘリ", "ラインナップ");
  if (iNo < 0) return "CSV の 1 行目に「品番」の見出しが必要です (シリーズ・品番・共通在庫 (数量)・メモ)。";
  const out: HeriSheetItem[] = [];
  table.slice(1).forEach((cells, i) => {
    const no = tx(cells[iNo]);
    if (!no) return;
    const q = iQty >= 0 ? tx(cells[iQty]).replace(/,/g, "") : "";
    out.push({ series: iSeries >= 0 ? tx(cells[iSeries]) || "その他" : "その他", no, qty: q && isQty(q) ? Number(q) : undefined, memo: iMemo >= 0 ? tx(cells[iMemo]) || undefined : undefined, lineup: iLineup >= 0 ? /^(はい|○|1|true|yes)$/i.test(tx(cells[iLineup])) || undefined : undefined, ref: `CSV ${i + 2} 行目` });
  });
  return out;
}

/** アップロードされたファイル (.xlsx か CSV) から品番の行を読む */
export function readHeriUpload(buf: Buffer): HeriSheetItem[] | string {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return parseHeriWorkbook(buf);
  return parseHeriCsv(decodeCsv(new Uint8Array(buf)).text);
}

export interface HeriImportLine {
  ref: string;
  label: string;
  status: "new" | "count" | "same" | "lineup" | "error";
  message: string;
}

export interface HeriImportPlan {
  lines: HeriImportLine[];
  /** 新しく登録する品番の数・数量を合わせる品番の数 */
  newMaterials: number;
  counts: number;
  items: (HeriSheetItem & { code: string; materialId?: string; current: number; diff: number })[];
}

/** 取込の確認 (登録しない)。loc の数量を表の数量に合わせる (表にない品番の数量は変えない) */
export function planHeriImport(db: Pick<Database, "materials" | "stockMoves">, items: HeriSheetItem[], loc = COMMON_LOC, date?: string): HeriImportPlan {
  const plan: HeriImportPlan = { lines: [], newMaterials: 0, counts: 0, items: [] };
  const seen = new Map<string, number>();
  const bal = stockBalances(db, date);
  const id = locStore(loc);
  for (const it of items) {
    const code = heriCode(it.series, it.no);
    const label = heriName(it.series, it.no);
    const existing = db.materials.find((m) => m.code === code);
    if (existing && existing.kind !== "heri") {
      plan.lines.push({ ref: it.ref, label, status: "error", message: `コード ${code} は縁以外の材料で使われています。` });
      continue;
    }
    if (seen.has(code)) {
      const prev = plan.items[seen.get(code)!];
      // ラインナップと在庫表の両方にある品番は 1 つにまとめる (数量は在庫表)
      if (it.qty !== undefined && prev.qty === undefined) Object.assign(prev, { qty: it.qty, memo: it.memo ?? prev.memo, ref: it.ref });
      if (it.lineup) prev.lineup = true;
      if (it.qty === undefined || prev.qty === it.qty) continue;
      plan.lines.push({ ref: it.ref, label, status: "error", message: `同じ品番が表に 2 回あります (${prev.ref})。前の行の数量を使います。` });
      continue;
    }
    const current = existing ? (bal.find((b) => b.materialId === existing.id && b.storeId === id)?.qty ?? 0) : 0;
    const diff = it.qty === undefined ? 0 : round4(it.qty - current);
    seen.set(code, plan.items.length);
    plan.items.push({ ...it, code, materialId: existing?.id, current, diff });
  }
  for (const it of plan.items) {
    const label = heriName(it.series, it.no);
    const isNew = !it.materialId;
    if (isNew) plan.newMaterials++;
    if (it.qty === undefined) plan.lines.push({ ref: it.ref, label, status: isNew ? "new" : "lineup", message: isNew ? "品番を登録します (数量なし)。" : "登録済みの品番です (数量なし)。" });
    else if (it.diff === 0) plan.lines.push({ ref: it.ref, label, status: isNew ? "new" : "same", message: isNew ? `品番を登録します (数量 ${it.qty})。` : `数量は ${it.qty} のまま (変更なし)。` });
    else {
      plan.counts++;
      plan.lines.push({ ref: it.ref, label, status: isNew ? "new" : "count", message: `${isNew ? "品番を登録し、" : ""}数量を ${it.current} → ${it.qty} にします。` });
    }
  }
  return plan;
}

/**
 * 取込の実行 (mutate の中で呼ぶ)。新しい品番を材料マスタに登録し、数量の差を棚卸の調整 (単価 0) で入れる。
 * 取込は数量合わせのため単価 0 (管理会計の損益に入れない)。メモ (引当など) は品番のメモに写す
 */
export function applyHeriImport(db: Database, user: Pick<User, "id">, plan: HeriImportPlan, opts: { loc: string; date: string; sourceLabel: string }): { materials: number; moves: number } {
  const now = nowIso();
  let materials = 0;
  let moves = 0;
  for (const it of plan.items) {
    let m = it.materialId ? db.materials.find((x) => x.id === it.materialId) : db.materials.find((x) => x.code === it.code);
    if (!m) {
      m = { id: newId("mat"), code: it.code, name: `縁 ${heriName(it.series, it.no)}`.slice(0, 80), kind: "heri", unit: "帖", itemCategory: "tatami", supplierCode: it.no.slice(0, 40), series: it.series.slice(0, 40) || undefined, lineup: it.lineup || undefined, active: true, note: it.memo?.slice(0, 300), createdAt: now, updatedAt: now };
      db.materials.push(m);
      materials++;
    } else {
      if (it.lineup && !m.lineup) m.lineup = true;
      if (it.memo && it.memo !== m.note) m.note = it.memo.slice(0, 300);
      if (it.lineup || it.memo) m.updatedAt = now;
    }
    if (it.qty === undefined) continue;
    const current = heriQty(db, m.id, opts.loc, opts.date);
    const diff = round4(it.qty - current);
    if (diff === 0) continue;
    postMove(db, { id: newId("sm"), number: nextNumber(db, "SM", db.stockMoves, opts.date), date: opts.date, kind: "adjust", materialId: m.id, qty: Math.abs(diff), unitCost: 0, fromLoc: diff > 0 ? "adjust" : opts.loc, toLoc: diff > 0 ? opts.loc : "adjust", note: `縁在庫表の取込 (数量のみ): ${opts.sourceLabel} ${it.ref}`.slice(0, 200), status: "confirmed", createdBy: user.id, createdAt: now });
    moves++;
  }
  addAudit(db, { userId: user.id, action: "import", entity: "material", entityId: "heri_import", entityLabel: "縁在庫表", summary: `縁在庫表を取込 (${opts.sourceLabel}): 品番の登録 ${materials} 件・数量の調整 ${moves} 件 (${opts.date}・${opts.loc})` });
  return { materials, moves };
}

/* ================================================================== */
/* 書き出し                                                              */
/* ================================================================== */

/** 縁在庫の CSV (原価・単価は入れない)。シリーズ・品番・数量 (共通在庫) の列は取込にそのまま使える */
export function heriCsvRows(db: Pick<Database, "materials" | "stockMoves" | "stores" | "suppliers">): (string | number)[][] {
  const locs = heriLocations(db).filter((l) => l.storeId !== "hq");
  const head = ["シリーズ", "品番", "名前", "単位", "規定量", "共通在庫", ...locs.map((l) => l.label), "合計", "状態", "発注先", "通常ヘリ", "メモ"];
  return [
    head,
    ...heriRows(db, { includeInactive: true }).map((r) => [
      r.material.series ?? "",
      r.material.supplierCode ?? "",
      r.material.name,
      r.material.unit,
      r.material.reorderLevel ?? "",
      r.common,
      ...locs.map((l) => r.byStore[l.storeId] ?? 0),
      r.total,
      !r.material.active ? "使わない" : r.below ? "規定量未満" : r.hasRecord ? "" : "記録なし",
      (db.suppliers ?? []).find((s) => s.id === r.material.supplierId)?.name ?? "",
      r.material.lineup ? "はい" : "",
      r.material.note ?? "",
    ]),
  ];
}

export { storeLoc as heriStoreLoc };
